/**
 * get-submission-by-token.js
 * ──────────────────────────
 * Validates a one-time edit token and returns the full submission data
 * so the client can pre-fill their form for editing.
 *
 * Usage: GET /.netlify/functions/get-submission-by-token?token=<uuid>
 *
 * Returns 200 + { submission: { id, fields... } }  on success
 * Returns 404 if token is unknown or expired
 */

const { createClient } = require('@supabase/supabase-js');
const { isRateLimited } = require('./_ratelimit');
const { toDbKey, FORM_FIELDS_LEGACY, FORM_FIELDS_DB } = require('./_field_map');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
if (ALLOWED_ORIGIN === '*') {
  console.warn('[security] ALLOWED_ORIGIN is not set — CORS is open to all origins. Set ALLOWED_ORIGIN in Netlify environment variables.');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};


function getClientIp(event) {
  const xff = event.headers['x-forwarded-for'];
  if (xff) {
    const parts = xff.split(',');
    return parts[parts.length - 1].trim();
  }
  return event.headers['client-ip'] || 'unknown';
}
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  // ── Rate limit (cross-instance via Supabase) ────────────────────────────────
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const clientIp = getClientIp(event);
  if (await isRateLimited(supabaseUrl, supabaseKey, clientIp, 'get-submission-by-token', 30, 60 * 1000)) {
    return {
      statusCode: 429,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Too many requests. Please slow down.' })
    };
  }

  const token = String(event.queryStringParameters?.token || '').trim();

  // Strict UUID format check — same regex used by submit.js and admin-update.js
  if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid token format.' })
    };
  }

  if (!supabaseUrl || !supabaseKey) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Server configuration error.' })
    };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });

    // Fetch submission matching this token
    const { data, error } = await supabase
      .from('submissions')
      .select('id, edit_token, edit_token_expires_at, ' + FORM_FIELDS_DB.map(f => `"${f}"`).join(', '))
      .eq('edit_token', token)
      .limit(1)
      .single();

    if (error || !data) {
      return {
        statusCode: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Edit link not found or already used.' })
      };
    }

    // Check expiry
    if (data.edit_token_expires_at && new Date(data.edit_token_expires_at) < new Date()) {
      return {
        statusCode: 410,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'This edit link has expired.' })
      };
    }

    // Build a clean submission object with only form fields
    const submission = { id: data.id };
    for (const field of FORM_FIELDS_LEGACY) {
      const dbField = toDbKey(field);
      if (data[dbField] !== undefined) submission[field] = data[dbField];
    }

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ submission })
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: message })
    };
  }
};
