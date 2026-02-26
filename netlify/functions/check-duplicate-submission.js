const { createClient } = require('@supabase/supabase-js');

// ── CORS ─────────────────────────────────────────────────────────────────────
// Read from env so the value is locked to your production domain.
// Set ALLOWED_ORIGIN=https://your-site.netlify.app in Netlify env variables.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// ── In-process rate limiter ───────────────────────────────────────────────────
// Works across warm Lambda invocations. Provides meaningful protection against
// casual enumeration. For global rate limiting across all instances, replace
// with Upstash Redis or a Supabase rate_limits table.
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS    = 60 * 1000; // 1-minute window
const RATE_LIMIT_MAX_REQUESTS = 20;         // max duplicate checks per minute per IP

function isRateLimited(ip) {
  const now   = Date.now();
  let   entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;

  // Periodically prune stale entries to prevent unbounded memory growth
  if (rateLimitStore.size > 2000) {
    for (const [key, val] of rateLimitStore) {
      if (now > val.resetAt) rateLimitStore.delete(key);
    }
  }

  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

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
  return (
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown'
  );
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

  // ── Rate limit ──────────────────────────────────────────────────────────────
  const clientIp = getClientIp(event);
  if (isRateLimited(clientIp)) {
    return {
      statusCode: 429,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Too many requests. Please slow down.' })
    };
  }

  const body      = parseRequestBody(event.body);
  const email     = normalizeComparable(body.email);
  const brandName = normalizeComparable(body.brandName);

  if (!email || !brandName) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ duplicate: false })
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

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
      .select('id, email, "brand-name"')
      .ilike('email', email)
      .ilike('brand-name', brandName)
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
        match
          ? { duplicate: true, submissionId: String(match.id || '') }
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
