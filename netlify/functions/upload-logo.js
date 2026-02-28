const { createClient } = require('@supabase/supabase-js');
const { isRateLimited } = require('./_ratelimit');

const BUCKET = 'logos';
const MAX_BYTES = 2 * 1024 * 1024;
// SVG is excluded — SVG files can contain scripts and pose a stored XSS risk.
const ALLOWED_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp']
]);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
if (ALLOWED_ORIGIN === '*') {
  console.warn('[security] ALLOWED_ORIGIN is not set — CORS is open to all origins. Set ALLOWED_ORIGIN in Netlify environment variables.');
}
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// ── Admin auth (mirrors get-submissions.js / admin-update.js) ─────────────────
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
      console.error('[upload-logo] ADMIN_EMAILS is not configured — denying access.');
    }
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  return { ok: true };
}

function getClientIp(event) {
  const xff = event.headers['x-forwarded-for'];
  if (xff) {
    const parts = xff.split(',');
    return parts[parts.length - 1].trim();
  }
  return event.headers['client-ip'] || 'unknown';
}

function sanitizeFilename(value) {
  return String(value || 'logo')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')   // dots removed — prevents double-extension names like evil.php.jpg
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'logo';
}

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  // ── Admin auth ──────────────────────────────────────────────────────────────
  // Logo uploads come exclusively from the dashboard — they require admin access.
  const auth = requireAdmin(context);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error })
    };
  }

  // ── Rate limit (cross-instance via Supabase) ────────────────────────────────
  // 10 logo uploads per 10 minutes per IP — shared across all Lambda instances.
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const clientIp = getClientIp(event);
  if (await isRateLimited(supabaseUrl, supabaseKey, clientIp, 'upload-logo', 10, 10 * 60 * 1000)) {
    return {
      statusCode: 429,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Too many uploads. Please slow down.' })
    };
  }

  if (!supabaseUrl || !supabaseKey) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing Supabase credentials.' })
    };
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const mimeType = String(payload.mimeType || '').trim().toLowerCase();
    const contentBase64 = String(payload.contentBase64 || '');
    const originalName = sanitizeFilename(payload.filename || 'logo');

    if (!ALLOWED_MIME.has(mimeType)) {
      return {
        statusCode: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unsupported logo format. Allowed: PNG, JPG, WEBP.' })
      };
    }

    if (!contentBase64) {
      return {
        statusCode: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Logo content is missing.' })
      };
    }

    const buffer = Buffer.from(contentBase64, 'base64');
    if (!buffer.length) {
      return {
        statusCode: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid logo payload.' })
      };
    }

    if (buffer.length > MAX_BYTES) {
      return {
        statusCode: 413,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Logo exceeds 2MB limit.' })
      };
    }

    // ── Magic byte validation ─────────────────────────────────────────
    // Reject files whose actual content doesn't match the declared MIME type.
    function detectMimeFromBuffer(buf) {
      if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)
        return 'image/jpeg';
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
        return 'image/png';
      // WebP: RIFF container (bytes 0-3) + "WEBP" signature (bytes 8-11).
      // Checking only RIFF would falsely match WAV audio files.
      if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
          buf.length > 11 &&
          buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
        return 'image/webp';
      return null;
    }
    const detectedMime = detectMimeFromBuffer(buffer);
    if (!detectedMime || detectedMime !== mimeType) {
      return {
        statusCode: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'File content does not match declared type.' })
      };
    }

    const crypto = require('crypto');
    const extension = ALLOWED_MIME.get(mimeType);
    const ref = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}_${originalName}.${extension}`;

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });

    // Use Uint8Array for max compatibility with supabase-js storage
    const fileBody = new Uint8Array(buffer);

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(ref, fileBody, {
        contentType: mimeType,
        upsert: false
      });

    if (uploadError) {
      console.error('Supabase storage upload error', uploadError);
      return {
        statusCode: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Storage upload failed: ${uploadError.message || JSON.stringify(uploadError)}` })
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, logoRef: ref })
    };
  } catch (error) {
    console.error('upload-logo error', error);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Failed to upload logo: ${error.message || 'Unknown error'}` })
    };
  }
};
