const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'logos';
const MAX_BYTES = 2 * 1024 * 1024;
// SVG is excluded — SVG files can contain scripts and pose a stored XSS risk.
const ALLOWED_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp']
]);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// ── In-process rate limiter ───────────────────────────────────────────────────
// 10 logo uploads per 10 minutes per IP.
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS    = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;

function getClientIp(event) {
  return (
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown'
  );
}

function isRateLimited(ip) {
  const now   = Date.now();
  let   entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  if (rateLimitStore.size > 2000) {
    for (const [key, val] of rateLimitStore) {
      if (now > val.resetAt) rateLimitStore.delete(key);
    }
  }
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

function sanitizeFilename(value) {
  return String(value || 'logo')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')   // dots removed — prevents double-extension names like evil.php.jpg
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'logo';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  const clientIp = getClientIp(event);
  if (isRateLimited(clientIp)) {
    return {
      statusCode: 429,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Too many uploads. Please slow down.' })
    };
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
      if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)                    return 'image/jpeg';
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
      if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp';
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

    const extension = ALLOWED_MIME.get(mimeType);
    const ref = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${originalName}.${extension}`;

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
