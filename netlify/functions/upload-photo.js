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
const sharp = require('sharp');

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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function sanitizeFilename(value) {
  return String(value || 'photo')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')      // strip extension — we'll add our own
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'photo';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body.' })
    };
  }

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

  // ── Determine original extension ──────────────────────────────────
  const extMap = {
    'image/png':  'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif':  'gif'
  };
  const originalExt = extMap[mimeType] || 'jpg';

  // ── Unique path prefix ────────────────────────────────────────────
  const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${originalName}`;

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
