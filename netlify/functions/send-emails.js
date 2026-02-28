/**
 * send-emails.js
 * ──────────────
 * Generates PDF / DOCX / Markdown and sends admin + client emails.
 * Called fire-and-forget from the browser after submit.js confirms a successful
 * Supabase write. Protected by HMAC token (set INTERNAL_SECRET in Netlify env
 * variables) and an in-process rate limiter.
 *
 * Accepts POST { record, isEdit, editLink?, lang, sendToken, sendTimestamp }
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const {
  sanitizeFilenamePart,
  buildMarkdown,
  buildDocxBuffer,
  buildPdfBuffer,
  sendResendEmail,
  buildAdminEmail,
  buildClientEmail,
  buildEditConfirmationEmail
} = require('./_shared');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// ── In-process rate limiter ───────────────────────────────────────────────────
// Limits abuse of this endpoint on warm Lambda instances.
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS    = 10 * 60 * 1000; // 10-minute window
const RATE_LIMIT_MAX_REQUESTS = 10;              // 10 calls per 10 min per IP

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

// ── HMAC verification ─────────────────────────────────────────────────────────
// submit.js signs { timestamp } with INTERNAL_SECRET and returns the signature.
// We verify it here to confirm this call originated from a real submit.js response.
// Token is valid for 5 minutes to prevent replay attacks.
function verifySendToken(sendToken, sendTimestamp) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) {
    console.error('[send-emails] INTERNAL_SECRET is not set — rejecting request. Set this env var in Netlify environment variables.');
    return false;
  }

  if (!sendToken || !sendTimestamp) return false;

  const ts  = Number(sendTimestamp);
  const age = Date.now() - ts;

  // Reject tokens older than 5 minutes or from the future
  if (age > 5 * 60 * 1000 || age < 0) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(String(ts))
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(sendToken,  'hex'),
      Buffer.from(expected,   'hex')
    );
  } catch {
    return false;
  }
}

// Fields that must not appear in generated documents
const DOCUMENT_SKIP_FIELDS = new Set([
  'created_at', 'history', 'status', 'project-status', 'agreed-delivery-date',
  'edit_token', 'edit_token_expires_at'
]);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  // ── Rate limit ──────────────────────────────────────────────────────────────
  const clientIp = getClientIp(event);
  if (isRateLimited(clientIp)) {
    return {
      statusCode: 429,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Too many requests. Please slow down.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON.' }) };
  }

  const { record, isEdit, editLink, lang = 'en', sendToken, sendTimestamp } = body;

  // ── HMAC verification ───────────────────────────────────────────────────────
  if (!verifySendToken(sendToken, sendTimestamp)) {
    return {
      statusCode: 403,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid or expired send token.' })
    };
  }

  if (!record || typeof record !== 'object') {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing record.' }) };
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail    = process.env.RESEND_FROM_EMAIL || 'noreply@neatmark.studio';
  const adminEmail   = process.env.RECIPIENT_EMAIL;   // Required — no hardcoded fallback
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

  if (!resendApiKey) {
    console.error('[send-emails] RESEND_API_KEY is missing — no emails sent.');
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, warning: 'No API key.' }) };
  }

  if (!adminEmail) {
    console.error('[send-emails] RECIPIENT_EMAIL is not set — admin email will not be sent. Set this env var in Netlify.');
  }

  // ── PATH A: Edit confirmation (lightweight — no documents) ──────────────────
  if (isEdit) {
    const clientEmailAddr = String(record.email || '').trim();
    if (clientEmailAddr.includes('@')) {
      try {
        const confirmMsg = buildEditConfirmationEmail({
          brandName:  record['brand-name'],
          clientName: record['client-name']
        }, lang);
        await sendResendEmail({
          apiKey: resendApiKey, to: clientEmailAddr, from: fromEmail,
          subject: confirmMsg.subject, html: confirmMsg.html, text: confirmMsg.text
        });
      } catch (err) {
        console.error('[send-emails] Edit confirmation email failed:', err.message);
      }
    }
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
  }

  // ── PATH B: New submission — generate documents + send emails ───────────────
  const supabase = (supabaseUrl && supabaseKey)
    ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
    : null;

  const now        = new Date();
  const dateStr    = now.toISOString().split('T')[0];
  const timeStr    = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  const brandPart  = sanitizeFilenamePart(record['brand-name'],  'brand');
  const clientPart = sanitizeFilenamePart(record['client-name'], 'client');
  const baseFilename = `${brandPart}_${clientPart}_${dateStr}_${timeStr}`;

  const docPayload = Object.fromEntries(
    Object.entries(record).filter(([key]) => !DOCUMENT_SKIP_FIELDS.has(key))
  );

  // Fetch inspiration images from Supabase storage
  const imageBuffers = {};
  if (supabase) {
    const rawRefs    = record['q15-inspiration-refs'];
    const parsedRefs = Array.isArray(rawRefs) ? rawRefs : [];
    for (const refEntry of parsedRefs) {
      try {
        let smallRef = null;
        try {
          const parsed = typeof refEntry === 'string' ? JSON.parse(refEntry) : refEntry;
          smallRef = parsed?.smallRef ?? null;
        } catch (_) {
          smallRef = refEntry;
        }
        if (!smallRef) continue;

        const { data: imgData, error: imgErr } = await supabase.storage
          .from('small-photos')
          .download(smallRef);
        if (imgErr || !imgData) {
          console.warn('[send-emails] Could not fetch small photo:', smallRef, imgErr?.message);
          continue;
        }
        imageBuffers[refEntry] = Buffer.from(await imgData.arrayBuffer());
      } catch (imgFetchErr) {
        console.warn('[send-emails] Image fetch error:', imgFetchErr.message);
      }
    }
  }

  // Generate documents
  let markdown, docxBuffer, pdfBuffer;
  try {
    markdown   = buildMarkdown(docPayload, lang);
    docxBuffer = await buildDocxBuffer(docPayload, imageBuffers, lang);
    pdfBuffer  = await buildPdfBuffer(docPayload, imageBuffers, lang);
  } catch (err) {
    console.error('[send-emails] Document generation failed:', err.message);
  }

  // ── Send admin + client emails in parallel ──────────────────────────────────
  const emailTasks = [];

  if (adminEmail) {
    const adminMsg    = buildAdminEmail({
      brandName:    record['brand-name'],
      clientName:   record['client-name'],
      email:        record.email,
      deliveryDate: record['delivery-date'],
      country:      record['client-country']
    });
    const attachments = [];
    if (markdown)   attachments.push({ filename: `${baseFilename}.md`,   content: Buffer.from(markdown, 'utf8').toString('base64') });
    if (docxBuffer) attachments.push({ filename: `${baseFilename}.docx`, content: docxBuffer.toString('base64') });
    if (pdfBuffer)  attachments.push({ filename: `${baseFilename}.pdf`,  content: pdfBuffer.toString('base64') });

    emailTasks.push(
      sendResendEmail({
        apiKey: resendApiKey, to: adminEmail, from: fromEmail,
        subject: adminMsg.subject, html: adminMsg.html, text: adminMsg.text,
        attachments
      }).catch(err => console.error('[send-emails] Admin email failed:', err.message))
    );
  }

  const clientEmailAddr = String(record.email || '').trim();
  if (clientEmailAddr.includes('@')) {
    const clientMsg = buildClientEmail({
      brandName:  record['brand-name'],
      clientName: record['client-name'],
      editLink:   editLink || ''
    }, lang);

    emailTasks.push(
      sendResendEmail({
        apiKey: resendApiKey, to: clientEmailAddr, from: fromEmail,
        subject: clientMsg.subject, html: clientMsg.html, text: clientMsg.text,
        attachments: pdfBuffer
          ? [{ filename: `${baseFilename}.pdf`, content: pdfBuffer.toString('base64') }]
          : []
      }).catch(err => console.error('[send-emails] Client email failed:', err.message))
    );
  }

  // Run both email sends at the same time — no need to wait for one before the other
  await Promise.all(emailTasks);

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
};
