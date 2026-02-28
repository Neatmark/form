const { createClient } = require('@supabase/supabase-js');
const { randomUUID }   = require('crypto');
const crypto           = require('crypto');
const { isRateLimited } = require('./_ratelimit');
const { toDbRecord } = require('./_field_map');

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
if (ALLOWED_ORIGIN === '*') {
  console.warn('[security] ALLOWED_ORIGIN is not set — CORS is open to all origins. Set ALLOWED_ORIGIN in Netlify environment variables.');
}
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function getClientIp(event) {
  // On Netlify, the real client IP is appended at the END of X-Forwarded-For
  // by the Netlify edge node. Taking the first value is spoofable — an attacker
  // can prepend a fake IP. Taking the last value gives us the one Netlify set.
  const xff = event.headers['x-forwarded-for'];
  if (xff) {
    const parts = xff.split(',');
    return parts[parts.length - 1].trim();
  }
  return event.headers['client-ip'] || 'unknown';
}

// ── HMAC send-token ───────────────────────────────────────────────────────────
// Authorises the browser to call send-emails after a confirmed DB write.
// The HMAC now covers: timestamp + SHA-256(record) + editLink
// This prevents the browser from swapping out the record payload before calling
// send-emails — the signature will not verify if any of the three components change.
// Set INTERNAL_SECRET in Netlify environment variables (any long random string).
function makeSendToken(timestamp, publicRecord, editLink = '') {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) {
    console.warn('[submit] INTERNAL_SECRET not set — send-emails HMAC protection inactive. Set this env var.');
    return null;
  }
  // JSON.stringify key order is stable here because publicRecord is built from
  // an explicit ALLOWED_FIELDS loop in a deterministic order.
  const recordHash = crypto.createHash('sha256')
    .update(JSON.stringify(publicRecord))
    .digest('hex');
  return crypto
    .createHmac('sha256', secret)
    .update(`${String(timestamp)}:${recordHash}:${editLink}`)
    .digest('hex');
}

// ── Field allowlist & array fields ───────────────────────────────────────────
const ALLOWED_FIELDS = [
  'client-name', 'brand-name', 'email', 'client-website', 'delivery-date',
  'q1-business-description', 'q2-problem-transformation', 'q3-ideal-customer',
  'q3b-customer-desire', 'q4-competitors', 'q5-brand-personality', 'q6-positioning',
  'q-launch-context', 'q7-decision-maker', 'q7-decision-maker-other', 'q8-brands-admired',
  'q9-color', 'q10-colors-to-avoid', 'q11-aesthetic', 'q11-aesthetic-description',
  'q12-existing-assets', 'q13-deliverables', 'q14-budget',
  'q15-inspiration-refs', 'q16-anything-else', 'brand-logo-ref'
];

const ARRAY_FIELDS = new Set(['q9-color', 'q11-aesthetic', 'q13-deliverables', 'q15-inspiration-refs']);

// ── Enum allowlists (mirrors form HTML values) ────────────────────────────────
const ENUM_ALLOWLISTS = {
  'delivery-date':     new Set(['ASAP', '2\u20134 weeks', '1\u20132 months', '3+ months']),
  'q7-decision-maker': new Set(['Me / myself', 'My boss / the boss', 'Other']),
  'q14-budget':        new Set([
    'Low / lowest possible cost',
    'Mid-range / balanced price\u2013quality',
    'High / premium',
    'Premium / full brand investment'
  ])
};

const ARRAY_ENUM_ALLOWLISTS = {
  'q9-color': new Set([
    'Warm neutrals', 'Cool neutrals', 'Deep & moody', 'Bold & saturated',
    'Pastels', 'Monochrome', 'Metallic', 'Nature-inspired', 'No preference'
  ]),
  'q11-aesthetic': new Set([
    'Luxury & refined', 'Organic & artisan', 'Minimal & functional', 'Bold & graphic',
    'Playful & illustrative', 'Editorial & intellectual', 'Tech-forward', 'Nostalgic & heritage'
  ]),
  'q13-deliverables': new Set([
    'Primary logo', 'Logo variations', 'Color & typography', 'Brand guidelines',
    'Stationery', 'Social media', 'Website design', 'Packaging'
  ])
};

const EMAIL_RE     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_PATH_RE = /^[a-zA-Z0-9._/()-]+$/;

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
  'q16-anything-else':        3000,
  // Fields previously missing length limits
  'q7-decision-maker-other':   300,
  'brand-logo-ref':            200
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

  // ── Rate limit (cross-instance via Supabase) ────────────────────────────────
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const clientIp = getClientIp(event);
  if (await isRateLimited(supabaseUrl, supabaseKey, clientIp, 'submit', 5, 10 * 60 * 1000)) {
    return {
      statusCode: 429,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'Too many submissions. Please wait a few minutes before trying again.' })
    };
  }
  const siteUrl      = process.env.SITE_URL || 'https://form.neatmark.studio';

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
    ZW:'Zimbabwe',PS:'Palestine'
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
  const turnstileSecret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
  const isTurnstileTestingSecret = turnstileSecret === '1x0000000000000000000000000000000AA';
  const requestHost = String(event.headers['host'] || event.headers['x-forwarded-host'] || '');
  const requestOrigin = String(event.headers['origin'] || event.headers['referer'] || '');
  const isLocalRequest = /localhost|127\.0\.0\.1/i.test(requestHost) || /localhost|127\.0\.0\.1/i.test(requestOrigin);
  const isNetlifyDevRuntime = String(process.env.NETLIFY_DEV || '').trim().toLowerCase() === 'true';
  const isLocalEnv =
    isLocalRequest ||
    isNetlifyDevRuntime ||
    /localhost|127\.0\.0\.1/i.test(String(ALLOWED_ORIGIN)) ||
    /localhost|127\.0\.0\.1/i.test(String(siteUrl));
  const localTurnstileBypass = String(process.env.TURNSTILE_LOCAL_BYPASS || '').trim().toLowerCase() === 'true';
  if (turnstileSecret) {
    const rawTurnstileToken = payload['cf-turnstile-response'];
    const turnstileToken = Array.isArray(rawTurnstileToken)
      ? rawTurnstileToken.map(item => String(item || '').trim()).find(Boolean) || ''
      : String(rawTurnstileToken || '').trim();
    delete payload['cf-turnstile-response'];

    if (!turnstileToken) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: 'Security check token missing. Please reload and try again.' })
      };
    }

    if (isLocalEnv && (isTurnstileTestingSecret || localTurnstileBypass || isNetlifyDevRuntime)) {
      console.info('[Turnstile] Local dev bypass active; skipping remote verification.');
    } else {
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
          const errorCodes = Array.isArray(verifyData['error-codes'])
            ? verifyData['error-codes'].join(', ')
            : 'unknown';
          console.warn(`[Turnstile] Verification failed: ${errorCodes}`);
          return {
            statusCode: 403,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              success: false,
              error: 'Security check failed. Please reload and try again.',
              details: errorCodes !== 'unknown' ? `Code: ${errorCodes}.` : undefined
            })
          };
        }
      } catch (err) {
        console.error('[Turnstile] Verification request failed:', err.message);
        // Fail closed — if we cannot reach Cloudflare, reject the submission.
        // This prevents Turnstile from being silently bypassed via a network error.
        return {
          statusCode: 503,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'Security check could not be completed. Please try again in a moment.' })
        };
      }
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

  // ── Email format validation ─────────────────────────────────────────────────
  const emailVal = String(payload['email'] || '').trim();
  if (emailVal && !EMAIL_RE.test(emailVal)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'Invalid email address format.' })
    };
  }

  // ── Website URL validation ──────────────────────────────────────────────────
  const websiteVal = String(payload['client-website'] || '').trim();
  if (websiteVal) {
    try {
      const u = new URL(websiteVal);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'Website must use http or https.' })
        };
      }
    } catch {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: 'Invalid website URL format.' })
      };
    }
  }

  // ── Enum field validation (single-value radio fields) ───────────────────────
  for (const [field, allowed] of Object.entries(ENUM_ALLOWLISTS)) {
    const val = payload[field];
    if (val !== undefined && val !== null && val !== '' && !allowed.has(String(val))) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: `Invalid value for field "${field}".` })
      };
    }
  }

  // ── Array enum field validation + item count cap ────────────────────────────
  for (const [field, allowed] of Object.entries(ARRAY_ENUM_ALLOWLISTS)) {
    const val = payload[field];
    const arr = Array.isArray(val) ? val : (val ? [val] : []);
    if (arr.length > 20) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: `Too many values for field "${field}" (max 20).` })
      };
    }
    for (const item of arr) {
      if (!allowed.has(String(item))) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: `Invalid value "${item}" for field "${field}".` })
        };
      }
    }
  }

  // ── q15-inspiration-refs: cap count and validate storage paths ──────────────
  const q15Raw = payload['q15-inspiration-refs'];
  const q15Arr = Array.isArray(q15Raw) ? q15Raw : (q15Raw ? [q15Raw] : []);
  if (q15Arr.length > 10) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'Too many inspiration images (max 10).' })
    };
  }
  for (const refEntry of q15Arr) {
    try {
      const parsed = typeof refEntry === 'string' ? JSON.parse(refEntry) : refEntry;
      for (const pathKey of ['smallRef', 'originalRef']) {
        const p = String(parsed?.[pathKey] || '');
        if (p && (!SAFE_PATH_RE.test(p) || p.includes('..'))) {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'Invalid inspiration image path.' })
          };
        }
      }
    } catch {
      // Legacy plain-string ref
      const refStr = String(refEntry);
      if (refStr && (!SAFE_PATH_RE.test(refStr) || refStr.includes('..'))) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'Invalid inspiration image path.' })
        };
      }
    }
  }

  // ── Strip ALL internal control fields from payload ──────────────────────────
  // Override submissions are NOT allowed — submissions can only be updated via
  // a valid edit token (PATH A below). Any __submissionAction field is ignored.
  const editToken = String(payload.__editToken || '').trim();
  const lang      = ['en', 'fr', 'ar'].includes(String(payload.__lang || '').trim())
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

  if (clientCountry) record['client-country'] = clientCountry;
  const dbRecord = toDbRecord(record);

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    // ════════════════════════════════════════════════════════════════════════════
    // PATH A: Token-based client edit
    // The ONLY way to update an existing submission. The token is generated on
    // first submit, emailed to the client, single-use, and expires after 30 days.
    // ════════════════════════════════════════════════════════════════════════════
    if (editToken) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(editToken)) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'Invalid edit token format.' })
        };
      }

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

      const baseHistory = Array.isArray(tokenRow.history) && tokenRow.history.length > 0
        ? tokenRow.history
        : [{ label: 'original', date: String(tokenRow.created_at || record.created_at), editedBy: 'client' }];
      const nextHistory = [...baseHistory, { label: 'edited', date: record.created_at, editedBy: 'client' }];

      // Update the row and CLEAR the token (single use)
      const { error: updateErr } = await supabase
        .from('submissions')
        .update({ ...dbRecord, history: nextHistory, edit_token: null, edit_token_expires_at: null })
        .eq('id', tokenRow.id);

      if (updateErr) {
        console.error('[submit] Token-edit DB update error:', updateErr.message);
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'Could not save your changes. Please try again.' })
        };
      }

      const { edit_token: _t, edit_token_expires_at: _e, history: _h, ...publicRecord } = record;
      const sendTimestamp = Date.now();
      const sendToken     = makeSendToken(sendTimestamp, publicRecord, '');
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, isEdit: true, lang, record: publicRecord, sendToken, sendTimestamp })
      };
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PATH B: New submission
    // ════════════════════════════════════════════════════════════════════════════
    record.history = [{ label: 'original', date: record.created_at, editedBy: 'client' }];

    const newEditToken   = randomUUID();
    const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    record.edit_token            = newEditToken;
    record.edit_token_expires_at = tokenExpiresAt;

    const dbInsertRecord = toDbRecord(record);

    const { error: insertError } = await supabase.from('submissions').insert([dbInsertRecord]);
    if (insertError) {
      console.error('[submit] DB insert error:', insertError.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'Submission could not be saved. Please try again.' }) };
    }

    const editLink = `${siteUrl}/?token=${encodeURIComponent(newEditToken)}&lang=${lang}`;

    const { edit_token: _t, edit_token_expires_at: _e, history: _h, ...publicRecord } = record;
    const sendTimestamp = Date.now();
    const sendToken     = makeSendToken(sendTimestamp, publicRecord, editLink);
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true, isEdit: false, editLink, lang, record: publicRecord, sendToken, sendTimestamp })
    };

  } catch (err) {
    console.error('[submit] Unexpected error:', err instanceof Error ? err.message : String(err));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'An unexpected error occurred. Please try again.' })
    };
  }
};
