const { createClient } = require('@supabase/supabase-js');
const { randomUUID }   = require('crypto');
// Email / document generation is handled by the separate send-emails function.
// Nothing from _shared is needed here anymore.

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// ── In-process rate limiter ───────────────────────────────────────────────────
// Covers warm instances. For global rate limiting consider Upstash Redis.
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS    = 10 * 60 * 1000; // 10-minute window
const RATE_LIMIT_MAX_REQUESTS = 5;               // 5 submissions per 10 min per IP

function isRateLimited(ip) {
  const now   = Date.now();
  let   entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;

  if (rateLimitStore.size > 2000) {
    for (const [key, val] of rateLimitStore) {
      if (now > val.resetAt) rateLimitStore.delete(key);
    }
  }

  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

function getClientIp(event) {
  return (
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown'
  );
}

// ── Field allowlist & array fields ───────────────────────────────────────────
const ALLOWED_FIELDS = [
  'client-name', 'brand-name', 'email', 'client-website', 'delivery-date',
  'agreed-delivery-date', 'status', 'project-status',
  'q1-business-description', 'q2-problem-transformation', 'q3-ideal-customer',
  'q3b-customer-desire', 'q4-competitors', 'q5-brand-personality', 'q6-positioning',
  'q-launch-context', 'q7-decision-maker', 'q7-decision-maker-other', 'q8-brands-admired',
  'q9-color', 'q10-colors-to-avoid', 'q11-aesthetic', 'q11-aesthetic-description',
  'q12-existing-assets', 'q13-deliverables', 'q14-budget',
  'q15-inspiration-refs', 'q16-anything-else', 'brand-logo-ref'
];

const ARRAY_FIELDS = new Set(['q9-color', 'q11-aesthetic', 'q13-deliverables', 'q15-inspiration-refs']);

// ── Field length limits (mirrors client-side maxlength) ───────────────────────
const FIELD_MAXLENGTH = {
  'client-name':               120,
  'brand-name':                120,
  'email':                     254,
  'client-website':            300,
  'q1-business-description':  2000,
  'q2-problem-transformation':2000,
  'q3-ideal-customer':        2000,
  'q3b-customer-desire':      2000,
  'q4-competitors':           2000,
  'q5-brand-personality':     2000,
  'q6-positioning':            300,
  'q-launch-context':         2000,
  'q8-brands-admired':        2000,
  'q10-colors-to-avoid':       300,
  'q11-aesthetic-description':1000,
  'q12-existing-assets':       300,
  'q16-anything-else':        3000
};

function normalizeFieldValue(field, value) {
  if (ARRAY_FIELDS.has(field)) {
    if (value === undefined || value === null || value === '') return null;
    if (Array.isArray(value)) {
      const cleaned = value.filter(Boolean).map(item => String(item));
      return cleaned.length > 0 ? cleaned : null;
    }
    return [String(value)];
  }
  return value;
}

function parseBody(event) {
  try {
    const parsed = JSON.parse(event.body || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'Method Not Allowed' })
    };
  }

  // ── Rate limit ──────────────────────────────────────────────────────────────
  const clientIp = getClientIp(event);
  if (isRateLimited(clientIp)) {
    return {
      statusCode: 429,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'Too many submissions. Please wait a few minutes before trying again.' })
    };
  }

  // ── Env vars ────────────────────────────────────────────────────────────────
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const siteUrl      = process.env.SITE_URL          || 'https://form.neatmark.studio';

  // Netlify injects x-country (ISO 3166-1 alpha-2) automatically at the CDN edge.
  // No API call needed — it's just a request header.
  const countryCode = (
    event.headers['x-country'] ||
    event.headers['x-nf-country'] ||
    event.headers['cf-ipcountry'] ||
    ''
  ).toUpperCase().trim().slice(0, 2);

  const COUNTRY_NAMES = {
    AF:'Afghanistan',DZ:'Algeria',AO:'Angola',AR:'Argentina',AU:'Australia',AT:'Austria',
    AZ:'Azerbaijan',BD:'Bangladesh',BY:'Belarus',BE:'Belgium',BO:'Bolivia',BR:'Brazil',
    BG:'Bulgaria',KH:'Cambodia',CM:'Cameroon',CA:'Canada',CL:'Chile',CN:'China',
    CO:'Colombia',CD:'DR Congo',HR:'Croatia',CZ:'Czech Republic',DK:'Denmark',
    DO:'Dominican Republic',EC:'Ecuador',EG:'Egypt',ET:'Ethiopia',FI:'Finland',
    FR:'France',GH:'Ghana',DE:'Germany',GR:'Greece',GT:'Guatemala',HN:'Honduras',
    HK:'Hong Kong',HU:'Hungary',IN:'India',ID:'Indonesia',IQ:'Iraq',IE:'Ireland',
    IL:'Israel',IT:'Italy',CI:"Cote d'Ivoire",JP:'Japan',JO:'Jordan',KZ:'Kazakhstan',
    KE:'Kenya',KW:'Kuwait',LB:'Lebanon',LY:'Libya',MY:'Malaysia',MX:'Mexico',
    MA:'Morocco',MZ:'Mozambique',NP:'Nepal',NL:'Netherlands',NZ:'New Zealand',
    NG:'Nigeria',NO:'Norway',OM:'Oman',PK:'Pakistan',PE:'Peru',PH:'Philippines',
    PL:'Poland',PT:'Portugal',QA:'Qatar',RO:'Romania',RU:'Russia',SA:'Saudi Arabia',
    SN:'Senegal',RS:'Serbia',SG:'Singapore',ZA:'South Africa',KR:'South Korea',
    ES:'Spain',LK:'Sri Lanka',SD:'Sudan',SE:'Sweden',CH:'Switzerland',SY:'Syria',
    TW:'Taiwan',TZ:'Tanzania',TH:'Thailand',TN:'Tunisia',TR:'Turkey',UG:'Uganda',
    UA:'Ukraine',AE:'United Arab Emirates',GB:'United Kingdom',US:'United States',
    UY:'Uruguay',UZ:'Uzbekistan',VE:'Venezuela',VN:'Vietnam',YE:'Yemen',ZM:'Zambia',
    ZW:'Zimbabwe',PS:'Palestine',LY:'Libya'
  };

  const clientCountry = countryCode
    ? (COUNTRY_NAMES[countryCode] ? `${COUNTRY_NAMES[countryCode]} (${countryCode})` : countryCode)
    : '';

  if (!supabaseUrl || !supabaseKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'Missing Supabase credentials.' })
    };
  }

  const payload = parseBody(event);

  // ── Honeypot ────────────────────────────────────────────────────────────────
  if (payload.website && String(payload.website).trim().length > 0) {
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
  }
  delete payload.website;

  // ── Cloudflare Turnstile ────────────────────────────────────────────────────
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  if (turnstileSecret) {
    const turnstileToken = String(payload['cf-turnstile-response'] || '').trim();
    delete payload['cf-turnstile-response'];

    if (!turnstileToken) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: 'Security check token missing. Please reload and try again.' })
      };
    }

    try {
      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret:   turnstileSecret,
          response: turnstileToken,
          remoteip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || ''
        }).toString()
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        return {
          statusCode: 403,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'Security check failed. Please reload and try again.' })
        };
      }
    } catch (err) {
      // If Cloudflare is unreachable, allow through — don't block real users
      console.error('[Turnstile] Verification request failed:', err.message);
    }
  } else {
    delete payload['cf-turnstile-response'];
  }

  // ── Field length validation ─────────────────────────────────────────────────
  for (const [field, max] of Object.entries(FIELD_MAXLENGTH)) {
    const val = payload[field];
    if (val && typeof val === 'string' && val.length > max) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: `Field "${field}" exceeds maximum length of ${max} characters.` })
      };
    }
  }

  // ── Extract control flags ───────────────────────────────────────────────────
  const editToken            = String(payload.__editToken || '').trim();
  const submissionAction     = String(payload.__submissionAction || '').trim().toLowerCase();
  const overrideSubmissionId = String(payload.__overrideSubmissionId || '').trim();
  const editedBy             = String(payload.__editedBy || payload.editedBy || 'client').trim().toLowerCase();
  const lang                 = ['en', 'fr', 'ar'].includes(String(payload.__lang || '').trim())
                                 ? String(payload.__lang).trim()
                                 : 'en';

  delete payload.__editToken;
  delete payload.__submissionAction;
  delete payload.__overrideSubmissionId;
  delete payload.__requestOrigin;
  delete payload.__editedBy;
  delete payload.editedBy;
  delete payload.__lang;

  // ── Build clean record ──────────────────────────────────────────────────────
  const record = { created_at: new Date().toISOString() };
  ALLOWED_FIELDS.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      record[field] = normalizeFieldValue(field, payload[field]);
    }
  });

  // Store detected country (from Netlify geo header) — not a user-submitted field
  if (clientCountry) record['client-country'] = clientCountry;

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    // ════════════════════════════════════════════════════════════════════════════
    // PATH A: Token-based client edit
    // ════════════════════════════════════════════════════════════════════════════
    if (editToken) {
      // Validate UUID format
      if (!/^[0-9a-f-]{32,36}$/i.test(editToken)) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'Invalid edit token format.' })
        };
      }

      // Look up token in Supabase
      const { data: tokenRow, error: tokenErr } = await supabase
        .from('submissions')
        .select('id, edit_token, edit_token_expires_at, history, created_at')
        .eq('edit_token', editToken)
        .limit(1)
        .single();

      if (tokenErr || !tokenRow) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'Edit link not found or already used.' })
        };
      }

      if (tokenRow.edit_token_expires_at && new Date(tokenRow.edit_token_expires_at) < new Date()) {
        return {
          statusCode: 410,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'This edit link has expired. Please contact us for a new one.' })
        };
      }

      // Build updated history
      const baseHistory = Array.isArray(tokenRow.history) && tokenRow.history.length > 0
        ? tokenRow.history
        : [{ label: 'original', date: String(tokenRow.created_at || record.created_at), editedBy: 'client' }];
      const nextHistory = [...baseHistory, { label: 'edited', date: record.created_at, editedBy: 'client' }];

      // Update the row and CLEAR the token (single use)
      const { error: updateErr } = await supabase
        .from('submissions')
        .update({ ...record, history: nextHistory, edit_token: null, edit_token_expires_at: null })
        .eq('id', tokenRow.id);

      if (updateErr) {
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: updateErr.message })
        };
      }

      // Return immediately — edit confirmation email is sent by the client
      // via a fire-and-forget call to /.netlify/functions/send-emails.
      // Strip internal DB fields before sending record to client.
      const { edit_token: _t, edit_token_expires_at: _e, history: _h, ...publicRecord } = record;
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, isEdit: true, lang, record: publicRecord })
      };
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PATH B: Admin override (from dashboard)
    // ════════════════════════════════════════════════════════════════════════════
    if (submissionAction === 'override' && overrideSubmissionId) {
      const { data: existingRow, error: fetchError } = await supabase
        .from('submissions')
        .select('history, created_at')
        .eq('id', overrideSubmissionId)
        .single();

      if (fetchError || !existingRow) {
        console.error('Override target not found, inserting as new', fetchError);
        record.history = [{ label: 'original', date: record.created_at, editedBy: 'client' }];
        const { error } = await supabase.from('submissions').insert([record]);
        if (error) {
          return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: error.message }) };
        }
      } else {
        const baseHistory = Array.isArray(existingRow.history) && existingRow.history.length > 0
          ? existingRow.history
          : [{ label: 'original', date: String(existingRow.created_at || record.created_at), editedBy: 'client' }];
        const nextHistory = [...baseHistory, { label: 'edited', date: record.created_at, editedBy }];

        const { error } = await supabase
          .from('submissions')
          .update({ ...record, history: nextHistory })
          .eq('id', overrideSubmissionId);

        if (error) {
          return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: error.message }) };
        }
      }

      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PATH C: New submission
    // ════════════════════════════════════════════════════════════════════════════
    record.history = [{ label: 'original', date: record.created_at, editedBy: 'client' }];

    // Generate secure edit token (30-day expiry)
    const newEditToken   = randomUUID();
    const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    record.edit_token            = newEditToken;
    record.edit_token_expires_at = tokenExpiresAt;

    const { error: insertError } = await supabase.from('submissions').insert([record]);
    if (insertError) {
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: insertError.message }) };
    }

    // Build edit link to include in the client email (sent by send-emails function)
    const editLink = `${siteUrl}/?token=${encodeURIComponent(newEditToken)}&lang=${lang}`;

    // Return success immediately — PDF generation and email sending are handled
    // by a fire-and-forget call to /.netlify/functions/send-emails from the client.
    // Strip internal DB fields before exposing the record.
    const { edit_token: _t, edit_token_expires_at: _e, history: _h, ...publicRecord } = record;
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true, isEdit: false, editLink, lang, record: publicRecord })
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: message })
    };
  }
};
