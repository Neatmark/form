const { createClient } = require('@supabase/supabase-js');
const {
  MAX_FIELD_VALUE_LENGTH,
  normalizeValue,
  sanitizeFilenamePart,
  buildMarkdown,
  buildDocxBuffer,
  buildPdfBuffer,
  sendResendEmail,
  buildAdminEmail,
  buildClientEmail
} = require('./_shared');

const MAX_BODY_BYTES = 250000;
const MAX_FIELDS = 120;
const MAX_FIELD_KEY_LENGTH = 120;

const SUPABASE_FIELDS = new Set([
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
]);

function normalizeEditedBy(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'admin' || normalized === 'client') {
    return normalized;
  }
  return 'unknown';
}

function createHistoryEntry(label, date, editedBy) {
  const safeLabel = String(label || '').trim().toLowerCase() === 'edited' ? 'edited' : 'original';
  const editedByNormalized = normalizeEditedBy(editedBy);

  return {
    label: safeLabel,
    date,
    editedBy: editedByNormalized
  };
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const label = String(entry.label || '').trim().toLowerCase() === 'edited' ? 'edited' : 'original';
  const rawDate = String(entry.date || '').trim();
  const editedBy = normalizeEditedBy(entry.editedBy);
  const parsedDate = rawDate ? new Date(rawDate) : null;
  const date = parsedDate && !Number.isNaN(parsedDate.getTime())
    ? parsedDate.toISOString()
    : null;

  if (!date) {
    return null;
  }

  return { label, date, editedBy };
}

function ensureHistoryArray(existingHistory, fallbackDate) {
  const normalized = Array.isArray(existingHistory)
    ? existingHistory.map(normalizeHistoryEntry).filter(Boolean)
    : [];

  if (normalized.length > 0) {
    return normalized;
  }

  return [createHistoryEntry('original', fallbackDate, 'client')];
}

const ARRAY_COLUMNS = new Set([
  'q12-color',
  'q14-typography',
  'q15-aesthetic',
  'q18-deliverables'
]);

function buildSupabasePayload(payload) {
  return Object.entries(payload || {}).reduce((accumulator, [key, value]) => {
    if (!SUPABASE_FIELDS.has(key)) {
      return accumulator;
    }
    if (ARRAY_COLUMNS.has(key)) {
      if (Array.isArray(value)) {
        const cleaned = value.filter(Boolean).map(item => String(item));
        accumulator[key] = cleaned.length > 0 ? cleaned : null;
      } else if (value && typeof value === 'string') {
        accumulator[key] = [value];
      } else {
        accumulator[key] = null;
      }
    } else {
      accumulator[key] = (value === '' || value === undefined || value === null) ? null : value;
    }
    return accumulator;
  }, {});
}

function mapSupabaseRow(row) {
  const { id, created_at, history, ...rest } = row || {};
  return {
    id: String(id || ''),
    created_at,
    history: Array.isArray(history) ? history : [],
    data: rest
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validatePayload(payload) {
  if (!isPlainObject(payload)) {
    return 'Invalid submission payload.';
  }

  const entries = Object.entries(payload);
  if (entries.length === 0) {
    return 'Submission payload is empty.';
  }

  if (entries.length > MAX_FIELDS) {
    return 'Submission payload has too many fields.';
  }

  for (const [key, value] of entries) {
    if (key.length > MAX_FIELD_KEY_LENGTH) {
      return 'Submission payload contains an invalid field key.';
    }

    if (Array.isArray(value)) {
      if (value.length > 100) {
        return 'Submission payload contains too many values in one field.';
      }

      for (const item of value) {
        if (String(item ?? '').length > MAX_FIELD_VALUE_LENGTH) {
          return 'Submission payload contains a value that is too large.';
        }
      }

      continue;
    }

    if (String(value ?? '').length > MAX_FIELD_VALUE_LENGTH) {
      return 'Submission payload contains a value that is too large.';
    }
  }

  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: 'Method Not Allowed'
    };
  }

  try {
    if ((event.body || '').length > MAX_BODY_BYTES) {
      return {
        statusCode: 413,
        body: JSON.stringify({ error: 'Submission payload is too large.' })
      };
    }

    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid JSON payload.' })
      };
    }

    const validationError = validatePayload(payload);
    if (validationError) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: validationError })
      };
    }

    const submissionAction = String(payload.__submissionAction || '').trim().toLowerCase();
    const overrideSubmissionId = String(payload.__overrideSubmissionId || '').trim();
    const editedBySource = payload.__editedBy || payload.editedBy || '';
    const editedBy = String(editedBySource).trim().toLowerCase();
    delete payload.__submissionAction;
    delete payload.__overrideSubmissionId;
    delete payload.__requestOrigin;
    delete payload.__editedBy;
    delete payload.editedBy;

    if (submissionAction === 'override' && !['admin', 'client'].includes(editedBy)) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Invalid editedBy value for history entry.' })
      };
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@neatmark.studio';
    const destinationEmail = process.env.RECIPIENT_EMAIL || 'khaledxbz@outlook.com';
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

    if (!resendApiKey) {
      return {
        statusCode: 500,
        body: 'Missing RESEND_API_KEY environment variable.'
      };
    }

    if (!supabaseUrl || !supabaseKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Missing Supabase credentials.' })
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');

    const brandPart = sanitizeFilenamePart(payload['brand-name'], 'Brand');
    const clientPart = sanitizeFilenamePart(payload['client-name'], 'Client');

    const baseFilename = `${brandPart}_${clientPart}_${dateStr}_${timeStr}`;

    let markdown;
    let docxBuffer;
    let pdfBuffer;

    try {
      markdown = buildMarkdown(payload);
      docxBuffer = await buildDocxBuffer(payload);
      pdfBuffer = await buildPdfBuffer(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown document generation error';
      throw new Error(`Document generation failed: ${message}`);
    }

    try {
      const adminEmail = buildAdminEmail({
        brandName: normalizeValue(payload['brand-name']),
        clientName: normalizeValue(payload['client-name']),
        email: normalizeValue(payload.email),
        deliveryDate: normalizeValue(payload['delivery-date'])
      });

      const adminAttachments = [
        { filename: `${baseFilename}.md`, content: Buffer.from(markdown, 'utf8').toString('base64') },
        { filename: `${baseFilename}.docx`, content: docxBuffer.toString('base64') },
        { filename: `${baseFilename}.pdf`, content: pdfBuffer.toString('base64') }
      ];

      await sendResendEmail({
        apiKey: resendApiKey,
        to: destinationEmail,
        from: fromEmail,
        subject: adminEmail.subject,
        html: adminEmail.html,
        text: adminEmail.text,
        attachments: adminAttachments
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown admin email error';
      throw new Error(`Admin email failed: ${message}`);
    }

    const clientEmail = normalizeValue(payload.email);
    if (clientEmail && clientEmail.includes('@')) {
      try {
        const clientMessage = buildClientEmail({
          brandName: normalizeValue(payload['brand-name']),
          clientName: normalizeValue(payload['client-name'])
        });

        await sendResendEmail({
          apiKey: resendApiKey,
          to: clientEmail,
          from: fromEmail,
          subject: clientMessage.subject,
          html: clientMessage.html,
          text: clientMessage.text,
          attachments: [{ filename: `${baseFilename}.pdf`, content: pdfBuffer.toString('base64') }]
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown confirmation email error';
        throw new Error(`Confirmation email failed: ${message}`);
      }
    }

    let savedSubmission;
    const supabasePayload = buildSupabasePayload(payload);
    const editedAt = new Date().toISOString();

    if (submissionAction === 'override') {
      if (!overrideSubmissionId) {
        return {
          statusCode: 400,
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ error: 'Override target is missing.' })
        };
      }

      const { data: existingRow, error: fetchError } = await supabase
        .from('submissions')
        .select('history, created_at')
        .eq('id', overrideSubmissionId)
        .single();

      if (fetchError) {
        throw new Error(`Supabase lookup failed: ${fetchError.message}`);
      }

      if (!existingRow) {
        return {
          statusCode: 404,
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ error: 'Previous submission not found for override.' })
        };
      }

      const baseDate = String(existingRow.created_at || editedAt);
      const history = ensureHistoryArray(existingRow.history, baseDate);
      const nextHistory = [...history, createHistoryEntry('edited', editedAt, editedBy)];

      const { data, error } = await supabase
        .from('submissions')
        .update({ ...supabasePayload, history: nextHistory, created_at: editedAt })
        .eq('id', overrideSubmissionId)
        .select('*')
        .single();

      if (error) {
        throw new Error(`Supabase update failed: ${error.message}`);
      }

      savedSubmission = mapSupabaseRow(data);
    } else {
      const history = [createHistoryEntry('original', editedAt, 'client')];
      const { data, error } = await supabase
        .from('submissions')
        .insert({ ...supabasePayload, history })
        .select('*')
        .single();

      if (error) {
        throw new Error(`Supabase insert failed: ${error.message}`);
      }

      savedSubmission = mapSupabaseRow(data);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ success: true, submission: savedSubmission })
    };
  } catch (error) {
    console.error('process-form error', error);
    const details = error instanceof Error ? error.message : 'Unknown error';

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Failed to process submission.', details })
    };
  }
};
