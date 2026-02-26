const { createClient } = require('@supabase/supabase-js');
const { randomUUID }   = require('crypto');
const {
  normalizeValue,
  sanitizeFilenamePart,
  buildMarkdown,
  buildDocxBuffer,
  buildPdfBuffer,
  sendResendEmail,
  buildAdminEmail,
  buildClientEmail,
  buildEditConfirmationEmail
} = require('./_shared');

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// ── In-process rate limiter ───────────────────────────────────────────────────
// Covers warm instances. For global rate limiting consider Upstash Redis.
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS    = 10 * 60 * 1000; // 10-minute window
const RATE_LIMIT_MAX_REQUESTS = 5;               // 5 submissions per 10 min per IP

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

function getClientIp(event) {
  return (
    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers['client-ip'] ||
    'unknown'
  );
}

// ── Field allowlist & array fields ───────────────────────────────────────────
const ALLOWED_FIELDS = [
  'client-name', 'brand-name', 'email', 'delivery-date',
  'agreed-delivery-date', 'status', 'project-status',
  'q1-business-description', 'q2-problem-transformation', 'q3-ideal-customer',
  'q4-competitors', 'q5-brand-personality', 'q6-positioning',
  'q7-decision-maker', 'q7-decision-maker-other', 'q8-brands-admired',
  'q9-color', 'q10-colors-to-avoid', 'q11-aesthetic', 'q11-aesthetic-description',
  'q12-existing-assets', 'q13-deliverables', 'q14-budget',
  'q15-inspiration-refs', 'q16-anything-else', 'brand-logo-ref'
];

const ARRAY_FIELDS = new Set(['q9-color', 'q11-aesthetic', 'q13-deliverables', 'q15-inspiration-refs']);

const DOCUMENT_SKIP_FIELDS = new Set([
  'created_at', 'history', 'status', 'project-status', 'agreed-delivery-date'
]);

// ── Field length limits (mirrors client-side maxlength) ───────────────────────
const FIELD_MAXLENGTH = {
  'client-name':               120,
  'brand-name':                120,
  'email':                     254,
  'q1-business-description':  2000,
  'q2-problem-transformation':2000,
  'q3-ideal-customer':        2000,
  'q4-competitors':           2000,
  'q5-brand-personality':     2000,
  'q6-positioning':            300,
  'q8-brands-admired':        2000,
  'q10-colors-to-avoid':       300,
  'q11-aesthetic-description':1000,
  'q12-existing-assets':       300,
  'q16-anything-else':        3000
};

function normalizeFieldValue(field, value) {
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

function parseBody(event) {
  try {
    const parsed = JSON.parse(event.body || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'Method Not Allowed' })
    };
  }

  // ── Rate limit ──────────────────────────────────────────────────────────────
  const clientIp = getClientIp(event);
  if (isRateLimited(clientIp)) {
    return {
      statusCode: 429,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'Too many submissions. Please wait a few minutes before trying again.' })
    };
  }

  // ── Env vars ────────────────────────────────────────────────────────────────
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail    = process.env.RESEND_FROM_EMAIL || 'noreply@neatmark.studio';
  const adminEmail   = process.env.RECIPIENT_EMAIL   || 'khaledxbz@outlook.com';
  const siteUrl      = process.env.SITE_URL          || 'https://form.neatmark.studio';

  if (!supabaseUrl || !supabaseKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'Missing Supabase credentials.' })
    };
  }

  const payload = parseBody(event);

  // ── Honeypot ────────────────────────────────────────────────────────────────
  if (payload.website && String(payload.website).trim().length > 0) {
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
  }
  delete payload.website;

  // ── Cloudflare Turnstile ────────────────────────────────────────────────────
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  if (turnstileSecret) {
    const turnstileToken = String(payload['cf-turnstile-response'] || '').trim();
    delete payload['cf-turnstile-response'];

    if (!turnstileToken) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: 'Security check token missing. Please reload and try again.' })
      };
    }

    try {
      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret:   turnstileSecret,
          response: turnstileToken,
          remoteip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || ''
        }).toString()
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        return {
          statusCode: 403,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'Security check failed. Please reload and try again.' })
        };
      }
    } catch (err) {
      // If Cloudflare is unreachable, allow through — don't block real users
      console.error('[Turnstile] Verification request failed:', err.message);
    }
  } else {
    delete payload['cf-turnstile-response'];
  }

  // ── Field length validation ─────────────────────────────────────────────────
  for (const [field, max] of Object.entries(FIELD_MAXLENGTH)) {
    const val = payload[field];
    if (val && typeof val === 'string' && val.length > max) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: `Field "${field}" exceeds maximum length of ${max} characters.` })
      };
    }
  }

  // ── Extract control flags ───────────────────────────────────────────────────
  const editToken            = String(payload.__editToken || '').trim();
  const submissionAction     = String(payload.__submissionAction || '').trim().toLowerCase();
  const overrideSubmissionId = String(payload.__overrideSubmissionId || '').trim();
  const editedBy             = String(payload.__editedBy || payload.editedBy || 'client').trim().toLowerCase();

  delete payload.__editToken;
  delete payload.__submissionAction;
  delete payload.__overrideSubmissionId;
  delete payload.__requestOrigin;
  delete payload.__editedBy;
  delete payload.editedBy;

  // ── Build clean record ──────────────────────────────────────────────────────
  const record = { created_at: new Date().toISOString() };
  ALLOWED_FIELDS.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      record[field] = normalizeFieldValue(field, payload[field]);
    }
  });

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    // ════════════════════════════════════════════════════════════════════════════
    // PATH A: Token-based client edit
    // ════════════════════════════════════════════════════════════════════════════
    if (editToken) {
      // Validate UUID format
      if (!/^[0-9a-f-]{32,36}$/i.test(editToken)) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'Invalid edit token format.' })
        };
      }

      // Look up token in Supabase
      const { data: tokenRow, error: tokenErr } = await supabase
        .from('submissions')
        .select('id, edit_token, edit_token_expires_at, history, created_at')
        .eq('edit_token', editToken)
        .limit(1)
        .single();

      if (tokenErr || !tokenRow) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'Edit link not found or already used.' })
        };
      }

      if (tokenRow.edit_token_expires_at && new Date(tokenRow.edit_token_expires_at) < new Date()) {
        return {
          statusCode: 410,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: 'This edit link has expired. Please contact us for a new one.' })
        };
      }

      // Build updated history
      const baseHistory = Array.isArray(tokenRow.history) && tokenRow.history.length > 0
        ? tokenRow.history
        : [{ label: 'original', date: String(tokenRow.created_at || record.created_at), editedBy: 'client' }];
      const nextHistory = [...baseHistory, { label: 'edited', date: record.created_at, editedBy: 'client' }];

      // Update the row and CLEAR the token (single use)
      const { error: updateErr } = await supabase
        .from('submissions')
        .update({ ...record, history: nextHistory, edit_token: null, edit_token_expires_at: null })
        .eq('id', tokenRow.id);

      if (updateErr) {
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: false, error: updateErr.message })
        };
      }

      // Send edit confirmation email to client
      if (resendApiKey) {
        const clientEmailAddr = String(record.email || '').trim();
        if (clientEmailAddr.includes('@')) {
          try {
            const confirmMsg = buildEditConfirmationEmail({
              brandName:  record['brand-name'],
              clientName: record['client-name']
            });
            await sendResendEmail({
              apiKey:   resendApiKey,
              to:       clientEmailAddr,
              from:     fromEmail,
              subject:  confirmMsg.subject,
              html:     confirmMsg.html,
              text:     confirmMsg.text
            });
          } catch (err) {
            console.error('Edit confirmation email failed:', err.message);
          }
        }
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true })
      };
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PATH B: Admin override (from dashboard)
    // ════════════════════════════════════════════════════════════════════════════
    if (submissionAction === 'override' && overrideSubmissionId) {
      const { data: existingRow, error: fetchError } = await supabase
        .from('submissions')
        .select('history, created_at')
        .eq('id', overrideSubmissionId)
        .single();

      if (fetchError || !existingRow) {
        console.error('Override target not found, inserting as new', fetchError);
        record.history = [{ label: 'original', date: record.created_at, editedBy: 'client' }];
        const { error } = await supabase.from('submissions').insert([record]);
        if (error) {
          return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: error.message }) };
        }
      } else {
        const baseHistory = Array.isArray(existingRow.history) && existingRow.history.length > 0
          ? existingRow.history
          : [{ label: 'original', date: String(existingRow.created_at || record.created_at), editedBy: 'client' }];
        const nextHistory = [...baseHistory, { label: 'edited', date: record.created_at, editedBy }];

        const { error } = await supabase
          .from('submissions')
          .update({ ...record, history: nextHistory })
          .eq('id', overrideSubmissionId);

        if (error) {
          return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: error.message }) };
        }
      }

      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PATH C: New submission
    // ════════════════════════════════════════════════════════════════════════════
    record.history = [{ label: 'original', date: record.created_at, editedBy: 'client' }];

    // Generate secure edit token (30-day expiry)
    const newEditToken   = randomUUID();
    const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    record.edit_token            = newEditToken;
    record.edit_token_expires_at = tokenExpiresAt;

    const { error: insertError } = await supabase.from('submissions').insert([record]);
    if (insertError) {
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: insertError.message }) };
    }

    // Build edit link for the client email
    const editLink = `${siteUrl}/?token=${encodeURIComponent(newEditToken)}`;

    // ── Generate documents & send emails ────────────────────────────────────
    if (resendApiKey) {
      const now      = new Date();
      const dateStr  = now.toISOString().split('T')[0];
      const timeStr  = now.toTimeString().split(' ')[0].replace(/:/g, '-');
      const brandPart  = sanitizeFilenamePart(record['brand-name'],   'brand');
      const clientPart = sanitizeFilenamePart(record['client-name'],  'client');
      const baseFilename = `${brandPart}_${clientPart}_${dateStr}_${timeStr}`;

      // Exclude internal fields from documents
      const docPayload = Object.fromEntries(
        Object.entries(record).filter(([key]) => !DOCUMENT_SKIP_FIELDS.has(key))
      );

      // Fetch inspiration images for PDF/DOCX only (NOT for email)
      const imageBuffers = {};
      const rawRefs = record['q15-inspiration-refs'];
      const parsedRefs = Array.isArray(rawRefs) ? rawRefs : [];
      for (const refEntry of parsedRefs) {
        try {
          let smallRef = null;
          try {
            const parsedRef = typeof refEntry === 'string' ? JSON.parse(refEntry) : refEntry;
            smallRef = parsedRef?.smallRef ?? null;
          } catch (_) {
            smallRef = refEntry;
          }
          if (!smallRef) continue;

          const { data: imgData, error: imgErr } = await supabase.storage
            .from('small-photos')
            .download(smallRef);
          if (imgErr || !imgData) {
            console.warn('Could not fetch small photo:', smallRef, imgErr?.message);
            continue;
          }
          imageBuffers[refEntry] = Buffer.from(await imgData.arrayBuffer());
        } catch (imgFetchErr) {
          console.warn('Inspiration image fetch error:', imgFetchErr.message);
        }
      }

      let pdfBuffer, docxBuffer, markdown;
      try {
        markdown   = buildMarkdown(docPayload);
        docxBuffer = await buildDocxBuffer(docPayload, imageBuffers);
        pdfBuffer  = await buildPdfBuffer(docPayload, imageBuffers);
      } catch (err) {
        console.error('Document generation failed', err);
      }

      // Admin notification — no inline images, just attachments
      const adminMsg = buildAdminEmail({
        brandName:    record['brand-name'],
        clientName:   record['client-name'],
        email:        record.email,
        deliveryDate: record['delivery-date']
      });

      if (adminEmail) {
        const attachments = [];
        if (markdown)   attachments.push({ filename: `${baseFilename}.md`,   content: Buffer.from(markdown, 'utf8').toString('base64') });
        if (docxBuffer) attachments.push({ filename: `${baseFilename}.docx`, content: docxBuffer.toString('base64') });
        if (pdfBuffer)  attachments.push({ filename: `${baseFilename}.pdf`,  content: pdfBuffer.toString('base64') });

        try {
          await sendResendEmail({
            apiKey: resendApiKey, to: adminEmail, from: fromEmail,
            subject: adminMsg.subject, html: adminMsg.html, text: adminMsg.text,
            attachments
          });
        } catch (err) {
          console.error('Admin email failed:', err.message);
        }
      }

      // Client confirmation — includes edit link + PDF copy
      const clientEmailAddr = String(record.email || '').trim();
      if (clientEmailAddr.includes('@')) {
        const clientMsg = buildClientEmail({
          brandName:  record['brand-name'],
          clientName: record['client-name'],
          editLink
        });
        try {
          await sendResendEmail({
            apiKey: resendApiKey, to: clientEmailAddr, from: fromEmail,
            subject: clientMsg.subject, html: clientMsg.html, text: clientMsg.text,
            attachments: pdfBuffer
              ? [{ filename: `${baseFilename}.pdf`, content: pdfBuffer.toString('base64') }]
              : []
          });
        } catch (err) {
          console.error('Client email failed:', err.message);
        }
      }
    } else {
      console.error('RESEND_API_KEY is missing; emails were not sent.');
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true })
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: message })
    };
  }
};
