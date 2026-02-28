/**
 * upload-photo.js
 * ───────────────
 * Handles inspiration image uploads for Q15.
 * Produces two versions:
 *   small    → max 1200 px longest side, 80 % quality JPEG  → bucket: small-photos
 *   original → untouched                                     → bucket: original-photos
 *
 * Returns: { success: true, smallRef: "...", originalRef: "..." }
 *
 * The client stores both refs as a JSON string inside the q15-inspiration-refs text[] column:
 *   '{"small":"small/…","original":"originals/…"}'
 */

const { createClient } = require('@supabase/supabase-js');
const { isRateLimited } = require('./_ratelimit');
const sharp = require('sharp');
const crypto = require('crypto');

const BUCKET_ORIGINAL = 'original-photos';
const BUCKET_SMALL    = 'small-photos';

const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024; // 10 MB
const SMALL_MAX_PX       = 1200;
const SMALL_QUALITY      = 80;

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
if (ALLOWED_ORIGIN === '*') {
  console.warn('[security] ALLOWED_ORIGIN is not set — CORS is open to all origins. Set ALLOWED_ORIGIN in Netlify environment variables.');
}
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// ── Upload session token verification ────────────────────────────────────────
// The browser must first call /.netlify/functions/get-upload-token to obtain a
// short-lived HMAC token.  Without this guard, upload-photo is an open,
// unauthenticated storage endpoint that any attacker could abuse.
const UPLOAD_TOKEN_VALID_MS = 2 * 60 * 60 * 1000; // must match get-upload-token.js

function verifyUploadToken(token, timestamp) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) {
    console.error('[upload-photo] INTERNAL_SECRET not set — rejecting upload. Set this env var in Netlify.');
    return false;
  }
  if (!token || !timestamp) return false;

  const ts  = Number(timestamp);
  const age = Date.now() - ts;
  if (age > UPLOAD_TOKEN_VALID_MS || age < 0) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`upload:${ts}`)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}


function sanitizeFilename(value) {
  return String(value || 'photo')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')      // strip extension — we'll add our own
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'photo';
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
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  // ── Rate limit (cross-instance via Supabase) ────────────────────────────────
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const clientIp = getClientIp(event);
  if (await isRateLimited(supabaseUrl, supabaseKey, clientIp, 'upload-photo', 20, 10 * 60 * 1000)) {
    return {
      statusCode: 429,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Too many uploads. Please slow down.' })
    };
  }

  // ── Upload session token ──────────────────────────────────────────────────
  // The browser obtains this token from /.netlify/functions/get-upload-token
  // before the first upload.  Reject any request that lacks a valid token.
  let rawBody;
  try {
    rawBody = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body.' })
    };
  }

  const uploadToken     = String(rawBody.uploadToken     || '').trim();
  const uploadTimestamp = String(rawBody.uploadTimestamp || '').trim();

  if (!verifyUploadToken(uploadToken, uploadTimestamp)) {
    return {
      statusCode: 403,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid or expired upload token. Please reload and try again.' })
    };
  }

  if (!supabaseUrl || !supabaseKey) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing Supabase credentials.' })
    };
  }

  const payload = rawBody;

  const mimeType        = String(payload.mimeType       || '').trim().toLowerCase();
  const contentBase64   = String(payload.contentBase64  || '');
  const originalName    = sanitizeFilename(payload.filename || 'photo');

  if (!ALLOWED_MIME.has(mimeType)) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unsupported image format. Allowed: PNG, JPG, WEBP, GIF.' })
    };
  }

  if (!contentBase64) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Image content is missing.' })
    };
  }

  const originalBuffer = Buffer.from(contentBase64, 'base64');
  if (!originalBuffer.length) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid image payload.' })
    };
  }
  if (originalBuffer.length > MAX_ORIGINAL_BYTES) {
    return {
      statusCode: 413,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Image exceeds 10 MB limit.' })
    };
  }

  // ── Magic byte validation ─────────────────────────────────────────
  // Verify the actual file signature matches the declared MIME type.
  // Prevents clients from disguising non-image files as images.
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
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
      return 'image/gif';
    return null;
  }
  const detectedMime = detectMimeFromBuffer(originalBuffer);
  if (!detectedMime || detectedMime !== mimeType) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'File content does not match declared type.' })
    };
  }

  // ── Determine original extension ──────────────────────────────────
  const extMap = {
    'image/png':  'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif':  'gif'
  };
  const originalExt = extMap[mimeType] || 'jpg';

  // ── Unique path prefix ────────────────────────────────────────────
  // crypto.randomBytes produces an unguessable suffix — Math.random() is not
  // cryptographically secure and could allow storage path enumeration.
  const uid = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}_${originalName}`;

  const originalRef = `originals/${uid}.${originalExt}`;
  const smallRef    = `small/${uid}.jpg`;  // always JPEG for small version

  // ── Resize to small version using sharp ──────────────────────────
  let smallBuffer;
  try {
    smallBuffer = await sharp(originalBuffer)
      .rotate()                               // auto-correct EXIF orientation
      .resize({
        width:  SMALL_MAX_PX,
        height: SMALL_MAX_PX,
        fit:    'inside',                     // maintain aspect ratio, never upscale
        withoutEnlargement: true
      })
      .jpeg({ quality: SMALL_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.error('Sharp resize error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Image resize failed: ${err.message}` })
    };
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
  });

  // ── Upload original ───────────────────────────────────────────────
  const { error: origError } = await supabase.storage
    .from(BUCKET_ORIGINAL)
    .upload(originalRef, new Uint8Array(originalBuffer), {
      contentType: mimeType,
      upsert: false
    });

  if (origError) {
    console.error('Original upload error:', origError);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Original upload failed: ${origError.message}` })
    };
  }

  // ── Upload small version ─────────────────────────────────────────
  const { error: smallError } = await supabase.storage
    .from(BUCKET_SMALL)
    .upload(smallRef, new Uint8Array(smallBuffer), {
      contentType: 'image/jpeg',
      upsert: false
    });

  if (smallError) {
    // Rollback original upload so we don't leave orphaned files
    await supabase.storage.from(BUCKET_ORIGINAL).remove([originalRef]).catch(() => {});
    console.error('Small upload error:', smallError);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Small-version upload failed: ${smallError.message}` })
    };
  }

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success:     true,
      smallRef,
      originalRef
    })
  };
};
