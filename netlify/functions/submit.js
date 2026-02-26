const { createClient } = require('@supabase/supabase-js');
const {
  normalizeValue,
  sanitizeFilenamePart,
  buildMarkdown,
  buildDocxBuffer,
  buildPdfBuffer,
  sendResendEmail,
  buildAdminEmail,
  buildClientEmail
} = require('./_shared');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// Fields accepted from the form and stored in Supabase
const ALLOWED_FIELDS = [
  'client-name',
  'brand-name',
  'email',
  'delivery-date',
  'agreed-delivery-date',
  'status',
  'project-status',
  'q1-business-description',
  'q2-problem-transformation',
  'q3-ideal-customer',
  'q4-competitors',
  'q5-brand-personality',
  'q6-positioning',
  'q7-decision-maker',
  'q7-decision-maker-other',
  'q8-brands-admired',
  'q9-color',
  'q10-colors-to-avoid',
  'q11-aesthetic',
  'q11-aesthetic-description',
  'q12-existing-assets',
  'q13-deliverables',
  'q14-budget',
  'q15-inspiration-refs',
  'q16-anything-else',
  'brand-logo-ref'
];

// Fields that accept multiple values (checkboxes / multi-select)
const ARRAY_FIELDS = new Set([
  'q9-color',
  'q11-aesthetic',
  'q13-deliverables',
  'q15-inspiration-refs'
]);

// Fields that should NOT appear in generated documents (Supabase internals)
const DOCUMENT_SKIP_FIELDS = new Set([
  'created_at',
  'history',
  'status',
  'project-status',
  'agreed-delivery-date'
]);

function normalizeFieldValue(field, value) {
  if (ARRAY_FIELDS.has(field)) {
    if (value === undefined || value === null || value === '') return null;
    if (Array.isArray(value)) {
      const cleaned = value.filter(Boolean).map((item) => String(item));
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

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: 'Missing Supabase credentials.' })
    };
  }

  const payload = parseBody(event);

  const submissionAction = String(payload.__submissionAction || '').trim().toLowerCase();
  const overrideSubmissionId = String(payload.__overrideSubmissionId || '').trim();
  const editedBy = String(payload.__editedBy || payload.editedBy || 'client').trim().toLowerCase();
  delete payload.__submissionAction;
  delete payload.__overrideSubmissionId;
  delete payload.__requestOrigin;
  delete payload.__editedBy;
  delete payload.editedBy;

  const record = { created_at: new Date().toISOString() };

  ALLOWED_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      record[field] = normalizeFieldValue(field, payload[field]);
    }
  });

  const historyEntry = { label: 'original', date: record.created_at, editedBy: 'client' };

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });

    if (submissionAction === 'override' && overrideSubmissionId) {
      const { data: existingRow, error: fetchError } = await supabase
        .from('submissions')
        .select('history, created_at')
        .eq('id', overrideSubmissionId)
        .single();

      if (fetchError || !existingRow) {
        console.error('Override target not found, inserting as new', fetchError);
        record.history = [historyEntry];
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
    } else {
      record.history = [historyEntry];
      const { error } = await supabase.from('submissions').insert([record]);

      if (error) {
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: error.message }) };
      }
    }

    // Only send emails for brand-new submissions
    if (submissionAction === 'override') {
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@neatmark.studio';
    const destinationEmail = process.env.RECIPIENT_EMAIL || 'khaledxbz@outlook.com';

    if (resendApiKey) {
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
      const brandPart = sanitizeFilenamePart(record['brand-name'], 'brand');
      const clientPart = sanitizeFilenamePart(record['client-name'], 'client');
      const baseFilename = `${brandPart}_${clientPart}_${dateStr}_${timeStr}`;

      // Build a clean document payload — exclude Supabase internal fields
      const docPayload = Object.fromEntries(
        Object.entries(record).filter(([key]) => !DOCUMENT_SKIP_FIELDS.has(key))
      );

      // ── Fetch small inspiration images once — used for emails AND documents ──
      const inspirationImages = [];  // [{smallBase64, mimeType}] for email HTML
      const imageBuffers = {};        // {refJsonString: Buffer} for PDF/DOCX embedding

      const rawRefs = record['q15-inspiration-refs'];
      const parsedRefs = Array.isArray(rawRefs) ? rawRefs : [];
      for (const refEntry of parsedRefs) {
        try {
          let smallRef = null;
          try {
            const parsedRef = typeof refEntry === 'string' ? JSON.parse(refEntry) : refEntry;
            smallRef = parsedRef && parsedRef.smallRef ? parsedRef.smallRef : null;
          } catch (_) {
            smallRef = refEntry;  // legacy plain string
          }
          if (!smallRef) continue;

          const { data: imgData, error: imgErr } = await supabase.storage
            .from('small-photos')
            .download(smallRef);
          if (imgErr || !imgData) {
            console.warn('Could not fetch small photo:', smallRef, imgErr?.message);
            continue;
          }
          const buf = Buffer.from(await imgData.arrayBuffer());
          // For email embedding
          inspirationImages.push({ smallBase64: buf.toString('base64'), mimeType: 'image/jpeg' });
          // For document embedding — keyed by the original ref entry string
          imageBuffers[refEntry] = buf;
        } catch (imgFetchErr) {
          console.warn('Inspiration image fetch error:', imgFetchErr.message);
        }
      }

      let pdfBuffer;
      let docxBuffer;
      let markdown;
      try {
        markdown = buildMarkdown(docPayload);
        docxBuffer = await buildDocxBuffer(docPayload, imageBuffers);
        pdfBuffer  = await buildPdfBuffer(docPayload, imageBuffers);
      } catch (err) {
        console.error('Document generation failed', err);
        markdown = null;
        docxBuffer = null;
        pdfBuffer = null;
      }

      const adminEmail = buildAdminEmail({
        brandName: record['brand-name'],
        clientName: record['client-name'],
        email: record.email,
        deliveryDate: record['delivery-date'],
        inspirationImages
      });

      if (destinationEmail) {
        const adminAttachments = [];
        if (markdown) {
          adminAttachments.push({ filename: `${baseFilename}.md`, content: Buffer.from(markdown, 'utf8').toString('base64') });
        }
        if (docxBuffer) {
          adminAttachments.push({ filename: `${baseFilename}.docx`, content: docxBuffer.toString('base64') });
        }
        if (pdfBuffer) {
          adminAttachments.push({ filename: `${baseFilename}.pdf`, content: pdfBuffer.toString('base64') });
        }
        try {
          await sendResendEmail({
            apiKey: resendApiKey,
            to: destinationEmail,
            from: fromEmail,
            subject: adminEmail.subject,
            html: adminEmail.html,
            text: adminEmail.text,
            attachments: adminAttachments
          });
        } catch (err) {
          console.error('Resend admin email failed', err);
        }
      }

      const clientEmail = String(record.email || '').trim();
      if (clientEmail.includes('@')) {
        const clientMessage = buildClientEmail({
          brandName: record['brand-name'],
          clientName: record['client-name']
        });
        try {
          await sendResendEmail({
            apiKey: resendApiKey,
            to: clientEmail,
            from: fromEmail,
            subject: clientMessage.subject,
            html: clientMessage.html,
            text: clientMessage.text,
            attachments: pdfBuffer
              ? [{ filename: `${baseFilename}.pdf`, content: pdfBuffer.toString('base64') }]
              : []
          });
        } catch (err) {
          console.error('Resend client email failed', err);
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
