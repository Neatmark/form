const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'logos';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function contentTypeFromExtension(ref) {
  if (ref.endsWith('.png')) return 'image/png';
  if (ref.endsWith('.jpg') || ref.endsWith('.jpeg')) return 'image/jpeg';
  if (ref.endsWith('.svg')) return 'image/svg+xml';
  if (ref.endsWith('.webp')) return 'image/webp';
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

  try {
    const ref = String(event.queryStringParameters?.ref || '').trim();
    if (!ref || !/^[a-zA-Z0-9._-]+$/.test(ref)) {
      return {
        statusCode: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid logo reference.' })
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(ref);

    if (error || !data) {
      console.error('Supabase storage download error', error);
      return {
        statusCode: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Logo not found.' })
      };
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': contentTypeFromExtension(ref),
        'Cache-Control': 'public, max-age=3600'
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true
    };
  } catch (error) {
    console.error('get-logo error', error);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to load logo.' })
    };
  }
};
