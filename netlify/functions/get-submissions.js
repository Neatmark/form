const { createClient } = require('@supabase/supabase-js');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const user = context?.clientContext?.user;
  if (!user) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  const adminEmails = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
  const userEmail = String(user.email || '').toLowerCase();
  const userRoles = Array.isArray(user?.app_metadata?.roles)
    ? user.app_metadata.roles.map(role => String(role).toLowerCase())
    : [];
  const isAdminRole = userRoles.includes('admin');
  const isAllowedEmail = adminEmails.includes(userEmail);

  // Fail closed: if ADMIN_EMAILS is not configured, deny everyone except users
  // with an explicit 'admin' role. Never allow any-authenticated-user fallback.
  if (!isAdminRole && !isAllowedEmail) {
    if (adminEmails.length === 0) {
      console.error('[get-submissions] ADMIN_EMAILS is not configured — denying access. Set this env var in Netlify.');
    }
    return {
      statusCode: 403,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Forbidden' })
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Missing Supabase credentials.' })
    };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase
      .from('submissions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase get-submissions error', error);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: error.message })
      };
    }

    const submissions = Array.isArray(data)
      ? data.map((row) => {
          const { id, created_at, history, ...rest } = row || {};
          return {
            id: String(id || ''),
            created_at,
            history: Array.isArray(history) ? history : [],
            data: rest
          };
        })
      : [];

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify({ submissions })
    };
  } catch (error) {
    console.error('Error fetching submissions:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
