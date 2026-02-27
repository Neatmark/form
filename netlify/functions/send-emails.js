/**
 * send-emails.js
 * ──────────────
 * Generates PDF / DOCX / Markdown documents and sends admin + client emails.
 * Called fire-and-forget from the client immediately after submit.js confirms
 * a successful Supabase write — so the user never waits for this heavy work.
 *
 * Accepts POST  { record, isEdit, editLink?, lang }
 *   record   – the normalised form record returned by submit.js (no DB-internal fields)
 *   isEdit   – true → send edit-confirmation email only (no docs)
 *              false → generate full PDF/DOCX/MD and send admin + client emails
 *   editLink – new-submission only: the 30-day edit URL for the client email
 *   lang     – 'en' | 'fr' | 'ar'
 *
 * Always returns 200 quickly so Netlify doesn't time-out the caller.
 * The actual work happens inside this Lambda's own execution window.
 */

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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON.' }) };
  }

  const { record, isEdit, editLink, lang = 'en' } = body;

  if (!record || typeof record !== 'object') {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing record.' }) };
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail    = process.env.RESEND_FROM_EMAIL || 'noreply@neatmark.studio';
  const adminEmail   = process.env.RECIPIENT_EMAIL   || 'khaledxbz@outlook.com';
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

  if (!resendApiKey) {
    console.error('[send-emails] RESEND_API_KEY is missing — no emails sent.');
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, warning: 'No API key.' }) };
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

  // Strip internal fields before passing to document builders
  const docPayload = Object.fromEntries(
    Object.entries(record).filter(([key]) => !DOCUMENT_SKIP_FIELDS.has(key))
  );

  // Fetch inspiration images from Supabase storage (needed for PDF / DOCX embedding)
  const imageBuffers = {};
  if (supabase) {
    const rawRefs   = record['q15-inspiration-refs'];
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
    // Continue — try to send at least the emails without attachments
  }

  // Admin notification with all attachments
  if (adminEmail) {
    try {
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

      await sendResendEmail({
        apiKey: resendApiKey, to: adminEmail, from: fromEmail,
        subject: adminMsg.subject, html: adminMsg.html, text: adminMsg.text,
        attachments
      });
    } catch (err) {
      console.error('[send-emails] Admin email failed:', err.message);
    }
  }

  // Client confirmation with edit link + PDF copy
  const clientEmailAddr = String(record.email || '').trim();
  if (clientEmailAddr.includes('@')) {
    try {
      const clientMsg = buildClientEmail({
        brandName:  record['brand-name'],
        clientName: record['client-name'],
        editLink:   editLink || ''
      }, lang);
      await sendResendEmail({
        apiKey: resendApiKey, to: clientEmailAddr, from: fromEmail,
        subject: clientMsg.subject, html: clientMsg.html, text: clientMsg.text,
        attachments: pdfBuffer
          ? [{ filename: `${baseFilename}.pdf`, content: pdfBuffer.toString('base64') }]
          : []
      });
    } catch (err) {
      console.error('[send-emails] Client email failed:', err.message);
    }
  }

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
};
