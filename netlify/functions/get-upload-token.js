/**
 * get-upload-token.js
 * ───────────────────
 * Issues a short-lived HMAC-signed session token that authorises the browser
 * to call upload-photo.js.  Without this, upload-photo is a fully open
 * unauthenticated endpoint anyone on the internet can abuse for storage
 * exhaustion.
 *
 * The token covers: "upload:<timestamp>" signed with INTERNAL_SECRET.
 * It is valid for 2 hours — enough for any realistic form-fill session.
 * It does NOT need to be single-use; it's scoped only to uploads and the
 * short window limits replay abuse.
 *
 * Usage: GET /.netlify/functions/get-upload-token
 * Returns: { token: "<hex>", timestamp: <ms>, expiresIn: <ms> }
 */

const crypto = require('crypto');
const { isRateLimited } = require('./_ratelimit');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
if (ALLOWED_ORIGIN === '*') {
  console.warn('[security] ALLOWED_ORIGIN is not set — CORS is open to all origins. Set ALLOWED_ORIGIN in Netlify environment variables.');
}
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const TOKEN_VALID_MS = 2 * 60 * 60 * 1000; // 2 hours



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
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  // ── Rate limit (cross-instance via Supabase) ────────────────────────────────
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const clientIp = getClientIp(event);
  if (await isRateLimited(supabaseUrl, supabaseKey, clientIp, 'get-upload-token', 20, 60 * 1000)) {
    return {
      statusCode: 429,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Too many requests. Please slow down.' })
    };
  }

  const secret = process.env.INTERNAL_SECRET;
  if (!secret) {
    console.error('[get-upload-token] INTERNAL_SECRET is not set — cannot issue upload tokens. Set this env var in Netlify.');
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Server configuration error.' })
    };
  }

  const timestamp = Date.now();
  const token = crypto
    .createHmac('sha256', secret)
    .update(`upload:${timestamp}`)
    .digest('hex');

  return {
    statusCode: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store'   // never cache — each token has its own timestamp
    },
    body: JSON.stringify({ token, timestamp, expiresIn: TOKEN_VALID_MS })
  };
};
