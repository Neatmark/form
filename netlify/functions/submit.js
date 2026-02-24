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

const ALLOWED_FIELDS = [
  'client-name',
  'brand-name',
  'email',
  'delivery-date',
  'q1-business-description',
  'q2-problem-transformation',
  'q3-ideal-customer',
  'q4-competitors',
  'q5-brand-personality',
  'q6-playful-serious',
  'q6-minimalist-expressive',
  'q6-approachable-authoritative',
  'q6-classic-contemporary',
  'q7-core-values',
  'q8-positioning',
  'q9-success-vision',
  'q10-brands-admired',
  'q11-brands-disliked',
  'q12-color',
  'q13-colors-to-avoid',
  'q14-typography',
  'q15-aesthetic',
  'q15-aesthetic-description',
  'q16-brand-space',
  'q17-existing-assets',
  'q18-deliverables',
  'q19-first-feeling',
  'q20-anything-else',
  'brand-logo-ref'
];

const RANGE_FIELDS = new Set([
  'q6-playful-serious',
  'q6-minimalist-expressive',
  'q6-approachable-authoritative',
  'q6-classic-contemporary'
]);

const ARRAY_FIELDS = new Set([
  'q12-color',
  'q14-typography',
  'q15-aesthetic',
  'q18-deliverables'
]);

function normalizeFieldValue(field, value) {
  if (ARRAY_FIELDS.has(field)) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (Array.isArray(value)) {
      const cleaned = value.filter(Boolean).map((item) => String(item));
      return cleaned.length > 0 ? cleaned : null;
    }

    return [String(value)];
  }

  if (RANGE_FIELDS.has(field)) {
    const raw = Array.isArray(value) ? value[0] : value;
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    return Number.isNaN(parsed) ? raw : parsed;
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
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: ''
    };
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

  // Build history entry for new submissions
  const historyEntry = { label: 'original', date: record.created_at, editedBy: 'client' };

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });

    if (submissionAction === 'override' && overrideSubmissionId) {
      // Fetch existing row to preserve and append history
      const { data: existingRow, error: fetchError } = await supabase
        .from('submissions')
        .select('history, created_at')
        .eq('id', overrideSubmissionId)
        .single();

      if (fetchError || !existingRow) {
        console.error('Override target not found, inserting as new', fetchError);
        // Fall through to insert as new
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
      // Normal insert (new submission or "send-as-new")
      record.history = [historyEntry];
      const { error } = await supabase
        .from('submissions')
        .insert([record]);

      if (error) {
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: error.message }) };
      }
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

      let pdfBuffer;
      let docxBuffer;
      let markdown;
      try {
        markdown = buildMarkdown(record);
        docxBuffer = await buildDocxBuffer(record);
        pdfBuffer = await buildPdfBuffer(record);
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
        deliveryDate: record['delivery-date']
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
