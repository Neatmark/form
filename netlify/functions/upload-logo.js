const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'logos';
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/svg+xml', 'svg'],
  ['image/webp', 'webp']
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function sanitizeFilename(value) {
  return String(value || 'logo')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
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
        body: JSON.stringify({ error: 'Unsupported logo format. Allowed: PNG, JPG, SVG, WEBP.' })
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
