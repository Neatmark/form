/**
 * get-photo.js
 * ────────────
 * Proxies images from private Supabase Storage buckets.
 * Works for both small-photos (dashboard previews) and original-photos (full-res).
 *
 * Usage:
 *   GET /.netlify/functions/get-photo?bucket=small-photos&ref=small/123_abc_photo.jpg
 *   GET /.netlify/functions/get-photo?bucket=original-photos&ref=originals/123_abc_photo.png
 *
 * Security:
 *   - Uses the service key server-side; the caller never touches the bucket directly.
 *   - Validates the `bucket` param to an allowlist — no arbitrary bucket access.
 *   - Validates the `ref` param: only safe path characters allowed.
 *   - Cache-Control: private (not CDN-cached) for private assets.
 */

const { createClient } = require('@supabase/supabase-js');

const ALLOWED_BUCKETS = new Set(['small-photos', 'original-photos', 'logos']);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function contentTypeFromPath(ref) {
  const lower = String(ref).toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png'))  return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif'))  return 'image/gif';
  if (lower.endsWith('.svg'))  return 'image/svg+xml';
  return 'application/octet-stream';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing Supabase credentials.' })
    };
  }

  const params = event.queryStringParameters || {};
  const bucket = String(params.bucket || '').trim();
  const ref    = String(params.ref    || '').trim();

  // Validate bucket
  if (!ALLOWED_BUCKETS.has(bucket)) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid or disallowed bucket.' })
    };
  }

  // Validate ref — allow alphanumeric, hyphens, underscores, dots, forward slashes only
  if (!ref || !/^[a-zA-Z0-9._/()-]+$/.test(ref)) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid photo reference.' })
    };
  }

  // Prevent path traversal
  if (ref.includes('..')) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid photo path.' })
    };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.storage
      .from(bucket)
      .download(ref);

    if (error || !data) {
      console.error('Supabase storage download error', error);
      return {
        statusCode: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Photo not found.' })
      };
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type':  contentTypeFromPath(ref),
        'Cache-Control': 'private, max-age=3600'
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true
    };
  } catch (error) {
    console.error('get-photo error', error);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to load photo.' })
    };
  }
};
