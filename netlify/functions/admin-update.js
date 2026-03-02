/**
 * admin-update.js
 * ───────────────
 * Authenticated admin endpoint for updating an existing submission.
 * Replaces the old broken pattern of sending __overrideSubmissionId to submit.js,
 * which was silently deleted and created duplicate submissions instead of updating.
 *
 * Requires: Netlify Identity JWT (same admin check as get-submissions.js).
 * Accepts:  POST { submissionId, fields, historyEntry }
 * Returns:  { success: true, submission: { id, ...fields } }
 */

const { createClient } = require('@supabase/supabase-js');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
if (ALLOWED_ORIGIN === '*') {
  console.warn('[security] ALLOWED_ORIGIN is not set — CORS is open to all origins. Set ALLOWED_ORIGIN in Netlify environment variables.');
}
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  const userEmail  = String(user.email || '').toLowerCase();
  const userRoles  = Array.isArray(user?.app_metadata?.roles)
    ? user.app_metadata.roles.map(r => String(r).toLowerCase())
    : [];

  if (!userRoles.includes('admin') && !adminEmails.includes(userEmail)) {
    if (adminEmails.length === 0) {
      console.error('[admin-update] ADMIN_EMAILS is not configured — denying access.');
    }
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  return { ok: true, user };
}

// ── Fields an admin is allowed to update ─────────────────────────────────────
// Includes all client form fields + admin-only fields (status, project-status, etc.)
const ADMIN_UPDATABLE_FIELDS = new Set([
  // Admin-only metadata
  'status', 'project_status', 'agreed_delivery_date',
  // Client form fields
  'client_name', 'brand_name', 'email', 'client_website', 'delivery_date',
  'business_description', 'problem_transformation', 'ideal_customer',
  'customer_desire', 'competitors', 'brand_personality', 'positioning',
  'launch_context', 'decision_maker', 'decision_maker_other', 'brands_admired',
  'color_direction', 'color_choice', 'colors_to_avoid', 'aesthetic', 'aesthetic_description',
  'existing_assets', 'deliverables', 'budget',
  'inspiration_refs', 'anything_else', 'brand_logo_ref'
]);

const ARRAY_FIELDS = new Set(['color_direction', 'aesthetic', 'deliverables', 'inspiration_refs']);

// ── Field length limits ───────────────────────────────────────────────────────
const FIELD_MAXLENGTH = {
  'client_name':               120,
  'brand_name':                120,
  'email':                     254,
  'client_website':            300,
  'business_description':     2000,
  'problem_transformation':   2000,
  'ideal_customer':           2000,
  'customer_desire':          2000,
  'competitors':              2000,
  'brand_personality':        2000,
  'positioning':               300,
  'launch_context':           2000,
  'brands_admired':           2000,
  'color_choice':              300,
  'colors_to_avoid':           300,
  'aesthetic_description':    1000,
  'existing_assets':           300,
  'anything_else':            3000,
  // Fields previously missing length limits
  'decision_maker_other':      300,
  'brand_logo_ref':            200
};

// ── Enum allowlists (mirrors form HTML values) ────────────────────────────────
const ENUM_ALLOWLISTS = {
  'delivery_date':     new Set(['ASAP', '2–4 weeks', '1–2 months', '3+ months']),
  'decision_maker': new Set(['Me / myself', 'My boss / the boss', 'Other']),
  'budget':        new Set([
    'Low / lowest possible cost',
    'Mid-range / balanced price–quality',
    'High / premium',
    'Premium / full brand investment'
  ]),
  'status':            new Set(['pending', 'approved', 'rejected']),
  'project_status':    new Set(['not-started', 'in-progress', 'done', 'abandoned', ''])
};

const ARRAY_ENUM_ALLOWLISTS = {
  'color_direction': new Set([
    'Warm neutrals', 'Cool neutrals', 'Deep & moody', 'Bold & saturated',
    'Pastels', 'Monochrome', 'Metallic', 'Nature-inspired', 'No preference'
  ]),
  'aesthetic': new Set([
    'Luxury & refined', 'Organic & artisan', 'Minimal & functional', 'Bold & graphic',
    'Playful & illustrative', 'Editorial & intellectual', 'Tech-forward', 'Nostalgic & heritage'
  ]),
  'deliverables': new Set([
    'Primary logo', 'Logo variations', 'Color & typography', 'Brand guidelines',
    'Stationery', 'Social media', 'Website design', 'Packaging'
  ])
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_PATH_RE = /^[a-zA-Z0-9._/()-]+$/;

function normalizeField(field, value) {
  if (ARRAY_FIELDS.has(field)) {
    if (value === undefined || value === null || value === '') return null;
    if (Array.isArray(value)) {
      const cleaned = value.filter(Boolean).map(item => String(item));
      return cleaned.length > 0 ? cleaned : null;
    }
    return [String(value)];
  }
  return value;
}

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // ── Admin auth ──────────────────────────────────────────────────────────────
  const auth = requireAdmin(context);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: auth.error })
    };
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON.' }) };
  }

  const { submissionId, fields, historyEntry } = body;

  // ── Validate submissionId ───────────────────────────────────────────────────
  if (!submissionId || !UUID_RE.test(String(submissionId))) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Missing or invalid submissionId.' })
    };
  }

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Missing or invalid fields object.' })
    };
  }

  // ── Build clean update record ───────────────────────────────────────────────
  const update = {};

  for (const [key, value] of Object.entries(fields)) {
    // Only allow explicitly-permitted fields
    if (!ADMIN_UPDATABLE_FIELDS.has(key)) continue;

    const normalized = normalizeField(key, value);

    // Length validation for text fields
    const maxLen = FIELD_MAXLENGTH[key];
    if (maxLen && typeof normalized === 'string' && normalized.length > maxLen) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Field "${key}" exceeds maximum length of ${maxLen} characters.` })
      };
    }

    // Enum validation (single-value fields)
    if (ENUM_ALLOWLISTS[key]) {
      if (normalized !== null && normalized !== '' && !ENUM_ALLOWLISTS[key].has(String(normalized))) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: `Invalid value for field "${key}".` })
        };
      }
    }

    // Array enum validation + item count cap
    if (ARRAY_ENUM_ALLOWLISTS[key]) {
      const arr = Array.isArray(normalized) ? normalized : [];
      if (arr.length > 20) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: `Too many values for field "${key}" (max 20).` })
        };
      }
      for (const item of arr) {
        if (!ARRAY_ENUM_ALLOWLISTS[key].has(String(item))) {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: `Invalid value "${item}" for field "${key}".` })
          };
        }
      }
    }

    // Email format validation
    if (key === 'email' && normalized) {
      if (!EMAIL_RE.test(String(normalized))) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Invalid email address format.' })
        };
      }
    }

    // Website URL validation
    if (key === 'client_website' && normalized) {
      try {
        const u = new URL(String(normalized));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'Website must use http or https.' })
          };
        }
      } catch {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Invalid website URL format.' })
        };
      }
    }

    // inspiration_refs path safety
    if (key === 'inspiration_refs') {
      const refs = Array.isArray(normalized) ? normalized : [];
      if (refs.length > 10) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Too many inspiration images (max 10).' })
        };
      }
      for (const refEntry of refs) {
        try {
          const parsed = typeof refEntry === 'string' ? JSON.parse(refEntry) : refEntry;
          for (const pathKey of ['smallRef', 'originalRef']) {
            const p = parsed?.[pathKey];
            if (p && (!SAFE_PATH_RE.test(String(p)) || String(p).includes('..'))) {
              return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid inspiration image path.' }) };
            }
          }
        } catch {
          const refStr = String(refEntry);
          if (refStr && (!SAFE_PATH_RE.test(refStr) || refStr.includes('..'))) {
            return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid inspiration image path.' }) };
          }
        }
      }
    }

    update[key] = normalized;
  }

  if (Object.keys(update).length === 0) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'No valid fields provided to update.' })
    };
  }

  const updatedAt = new Date().toISOString();

  // ── Validate and append history entry ──────────────────────────────────────
  const newEntry = {
    label:    'edited',
    date:     updatedAt,
    editedBy: 'admin',
    adminEmail: auth.user?.email || 'unknown'  // record which admin made the change
  };
  // Accept an optional note from the client but sanitize it
  if (historyEntry?.note && typeof historyEntry.note === 'string') {
    newEntry.note = String(historyEntry.note).slice(0, 200);
  }

  // ── Supabase ────────────────────────────────────────────────────────────────
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
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    // Fetch current history so we can append without overwriting
    const { data: current, error: fetchErr } = await supabase
      .from('submissions')
      .select('id, history')
      .eq('id', submissionId)
      .limit(1)
      .single();

    if (fetchErr || !current) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Submission not found.' })
      };
    }

    const baseHistory = Array.isArray(current.history) ? current.history : [];
    update.history = [...baseHistory, newEntry];

    const { error: updateErr } = await supabase
      .from('submissions')
      .update(update)
      .eq('id', submissionId);

    if (updateErr) {
      console.error('[admin-update] Supabase update error:', updateErr);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: updateErr.message })
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, submissionId })
    };

  } catch (err) {
    console.error('[admin-update] Error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' })
    };
  }
};
