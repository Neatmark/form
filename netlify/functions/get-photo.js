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

const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ALLOWED_BUCKETS = new Set(['small-photos', 'original-photos', 'logos']);

// Buckets that contain admin-only assets.
// original-photos and logos are never accessed by the public form.
// small-photos IS accessed by the public form for Q15 upload previews, so it stays open.
const ADMIN_ONLY_BUCKETS = new Set(['original-photos', 'logos']);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
if (ALLOWED_ORIGIN === '*') {
  console.warn('[security] ALLOWED_ORIGIN is not set — CORS is open to all origins. Set ALLOWED_ORIGIN in Netlify environment variables.');
}
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// ── Admin auth (mirrors get-submissions.js) ───────────────────────────────────
function requireAdmin(context) {
  const user = context?.clientContext?.user;
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' };

  const adminEmails = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  const userEmail = String(user.email || '').toLowerCase();
  const userRoles = Array.isArray(user?.app_metadata?.roles)
    ? user.app_metadata.roles.map(r => String(r).toLowerCase())
    : [];

  if (!userRoles.includes('admin') && !adminEmails.includes(userEmail)) {
    if (adminEmails.length === 0) {
      console.error('[get-photo] ADMIN_EMAILS is not configured — denying access to restricted bucket.');
    }
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  return { ok: true };
}

function contentTypeFromPath(ref) {
  const lower = String(ref).toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png'))  return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif'))  return 'image/gif';
  if (lower.endsWith('.svg'))  return 'image/svg+xml';
  return 'application/octet-stream';
}

exports.handler = async (event, context) => {
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

  // ── Auth guard for admin-only buckets ───────────────────────────────────────
  // small-photos is used by the public form for upload previews — keep it open.
  // logos and original-photos are dashboard-only and require admin login.
  if (ADMIN_ONLY_BUCKETS.has(bucket)) {
    const auth = requireAdmin(context);
    if (!auth.ok) {
      return {
        statusCode: auth.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: auth.error })
      };
    }
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
        'Content-Type':        contentTypeFromPath(ref),
        'Content-Disposition': `inline; filename="${path.basename(ref).replace(/["\r\n]/g, '_')}"`,            
        'Cache-Control':       'private, max-age=3600'
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
