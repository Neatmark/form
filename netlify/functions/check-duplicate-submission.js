const { createClient } = require('@supabase/supabase-js');
const { isRateLimited } = require('./_ratelimit');

// ── CORS ─────────────────────────────────────────────────────────────────────
// Read from env so the value is locked to your production domain.
// Set ALLOWED_ORIGIN=https://your-site.netlify.app in Netlify env variables.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
if (ALLOWED_ORIGIN === '*') {
  console.warn('[security] ALLOWED_ORIGIN is not set — CORS is open to all origins. Set ALLOWED_ORIGIN in Netlify environment variables.');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};


function normalizeComparable(value) {
  return String(value ?? '').trim().toLowerCase();
}

function parseRequestBody(body) {
  try {
    const parsed = JSON.parse(body || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

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

  if (event.httpMethod !== 'POST') {
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
  if (await isRateLimited(supabaseUrl, supabaseKey, clientIp, 'check-duplicate', 8, 60 * 1000)) {
    return {
      statusCode: 429,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Too many requests. Please slow down.' })
    };
  }

  const body      = parseRequestBody(event.body);
  const email     = normalizeComparable(body.email);
  const brandName = normalizeComparable(body.brandName);

  // Note: We intentionally do NOT verify a Turnstile token here.
  // The Turnstile token is single-use and is consumed by the main /submit call.
  // If we verified it here (pre-submission duplicate check), the token would be
  // spent and the actual form submission would fail with "Security check failed".
  // Protection against enumeration is provided by the in-process rate limiter above
  // (20 requests/minute per IP). A full Turnstile solve protects /submit itself.

  if (!email || !brandName) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ duplicate: false })
    };
  }

  if (!supabaseUrl || !supabaseKey) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ duplicate: false })
    };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase
      .from('submissions')
      .select('id, email, brand_name')
      .ilike('email', email)
      .ilike('brand_name', brandName)
      .limit(1);

    if (error) {
      console.error('check-duplicate Supabase error', error);
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ duplicate: false })
      };
    }

    const match = Array.isArray(data) && data.length > 0 ? data[0] : null;

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        // Return only duplicate status — never expose the submission UUID to
        // unauthenticated callers (avoids enumeration via known email + brand name).
        match
          ? { duplicate: true }
          : { duplicate: false }
      )
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: message })
    };
  }
};
