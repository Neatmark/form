const { PDFDocument, StandardFonts } = require('pdf-lib');
const {
  Document, Packer, Paragraph, TextRun,
  HeadingLevel, AlignmentType, BorderStyle
} = require('docx');

/* ─── Constants ─── */

const MAX_FIELD_VALUE_LENGTH = 6000;

const FIELD_LABELS = {
  'client-name': 'Client Name',
  'brand-name': 'Brand / Business',
  email: 'Client Email',
  'delivery-date': 'Delivery Date',
  'q1-business-description': 'Q1 - Business Description',
  'q2-problem-transformation': 'Q2 - Problem + Transformation',
  'q3-ideal-customer': 'Q3 - Ideal Customer',
  'q4-competitors': 'Q4 - Competitors + Market Gap',
  'q5-brand-personality': 'Q5 - Brand Personality',
  'q6-playful-serious': 'Q6 - Playful <-> Serious',
  'q6-minimalist-expressive': 'Q6 - Minimalist <-> Expressive',
  'q6-approachable-authoritative': 'Q6 - Approachable <-> Authoritative',
  'q6-classic-contemporary': 'Q6 - Classic <-> Contemporary',
  'q7-core-values': 'Q7 - Core Values',
  'q8-positioning': 'Q8 - Positioning Statement',
  'q9-success-vision': 'Q9 - 3-Year Success Vision',
  'q10-brands-admired': 'Q10 - Admired Brands',
  'q11-brands-disliked': 'Q11 - Disliked Brands',
  'q12-color': 'Q12 - Color Directions',
  'q13-colors-to-avoid': 'Q13 - Colors To Avoid',
  'q14-typography': 'Q14 - Typography Directions',
  'q15-aesthetic': 'Q15 - Aesthetic Direction',
  'q15-aesthetic-description': 'Q15 - Additional Aesthetic Notes',
  'q16-brand-space': 'Q16 - Brand As Physical Space',
  'q17-existing-assets': 'Q17 - Existing Assets To Keep',
  'q18-deliverables': 'Q18 - Needed Deliverables',
  'q19-first-feeling': 'Q19 - First Feeling',
  'q20-anything-else': 'Q20 - Anything Else'
};

/* ─── Helpers ─── */

function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value
      .filter(Boolean)
      .map(item => String(item).trim().slice(0, MAX_FIELD_VALUE_LENGTH))
      .join(', ')
      .slice(0, MAX_FIELD_VALUE_LENGTH);
  }

  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim().slice(0, MAX_FIELD_VALUE_LENGTH);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prettifyKey(key) {
  return key
    .replace(/^q(\d+)-/, 'Q$1 - ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sortedEntries(payload) {
  return Object.entries(payload).sort(([a], [b]) => {
    const aMatch = a.match(/^q(\d+)-/);
    const bMatch = b.match(/^q(\d+)-/);
    if (aMatch && bMatch) return Number(aMatch[1]) - Number(bMatch[1]);
    if (aMatch) return 1;
    if (bMatch) return -1;
    return a.localeCompare(b);
  });
}

function extractQuestionNumber(key) {
  const match = key.match(/^q(\d+)-/);
  return match ? Number(match[1]) : null;
}

function getSectionLabel(questionNumber) {
  if (!questionNumber) return null;
  if (questionNumber >= 1 && questionNumber <= 9) return 'Section 01 - Brand Foundation';
  if (questionNumber >= 10 && questionNumber <= 20) return 'Section 02 - Visual Direction';
  return null;
}

function sanitizeFilenamePart(value, fallback) {
  const clean = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

/* ─── Document Builders ─── */

function buildMarkdown(payload) {
  const now = new Date();
  const submittedAt = now.toISOString();
  const clientName = normalizeValue(payload['client-name']) || 'Unknown Client';
  const brandName = normalizeValue(payload['brand-name']) || 'Unknown Brand';

  const lines = [
    '# Client Intake Submission',
    '',
    `- **Submitted at:** ${submittedAt}`,
    `- **Client Name:** ${clientName}`,
    `- **Brand Name:** ${brandName}`,
    '',
    '---',
    ''
  ];

  for (const [key, rawValue] of sortedEntries(payload)) {
    const value = normalizeValue(rawValue) || '_No response_';
    const label = FIELD_LABELS[key] || prettifyKey(key);
    lines.push(`## ${label}`);
    lines.push('');
    lines.push(value);
    lines.push('');
  }

  return lines.join('\n');
}

async function buildDocxBuffer(payload) {
  const now = new Date();
  const submittedAt = now.toISOString();
  const submittedAtDisplay = now.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const clientName = normalizeValue(payload['client-name']) || 'Unknown Client';
  const brandName = normalizeValue(payload['brand-name']) || 'Unknown Brand';
  const clientEmail = normalizeValue(payload.email) || 'Not provided';
  const deliveryDate = normalizeValue(payload['delivery-date']) || 'Not provided';

  const children = [
    new Paragraph({
      text: 'CLIENT INTAKE REPORT',
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 140 }
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Prepared by Neatmark', italics: true, color: '666666' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 260 }
    }),
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D0D0D0' } },
      spacing: { after: 260 }
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Submission Details', bold: true, allCaps: true, color: '444444' })],
      spacing: { after: 120 }
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Submitted: ', bold: true }),
        new TextRun({ text: `${submittedAtDisplay} (${submittedAt})` })
      ],
      spacing: { after: 80 }
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Client Name: ', bold: true }), new TextRun({ text: clientName })],
      spacing: { after: 80 }
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Brand / Business: ', bold: true }), new TextRun({ text: brandName })],
      spacing: { after: 80 }
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Client Email: ', bold: true }), new TextRun({ text: clientEmail })],
      spacing: { after: 80 }
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Requested Delivery: ', bold: true }), new TextRun({ text: deliveryDate })],
      spacing: { after: 220 }
    })
  ];

  let currentSection = null;
  for (const [key, rawValue] of sortedEntries(payload)) {
    if (['client-name', 'brand-name', 'email', 'delivery-date'].includes(key)) continue;

    const value = normalizeValue(rawValue) || 'No response';
    const label = FIELD_LABELS[key] || prettifyKey(key);
    const questionNumber = extractQuestionNumber(key);
    const sectionLabel = getSectionLabel(questionNumber);

    if (sectionLabel && sectionLabel !== currentSection) {
      currentSection = sectionLabel;
      children.push(new Paragraph({
        text: sectionLabel,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 260, after: 130 }
      }));
    }

    children.push(new Paragraph({
      children: [new TextRun({ text: label, bold: true, color: '1F1F1F' })],
      spacing: { before: 160, after: 70 }
    }));
    children.push(new Paragraph({
      children: [new TextRun({ text: value })],
      spacing: { after: 110 }
    }));
    children.push(new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'ECECEC' } },
      spacing: { after: 80 }
    }));
  }

  const document = new Document({
    styles: {
      default: {
        heading1: {
          run: { bold: true, size: 28, color: '2B2B2B', font: 'Calibri' },
          paragraph: { spacing: { before: 320, after: 120 } }
        },
        title: {
          run: { bold: true, size: 40, color: '1D1D1D', font: 'Calibri' }
        }
      },
      paragraphStyles: [{
        id: 'Normal',
        name: 'Normal',
        run: { size: 22, font: 'Calibri', color: '222222' },
        paragraph: { spacing: { line: 300 } }
      }]
    },
    sections: [{
      properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
      children
    }]
  });

  return Packer.toBuffer(document);
}

async function buildPdfBuffer(payload) {
  const pdfDoc = await PDFDocument.create();
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let page = pdfDoc.addPage([612, 792]);
  let { width, height } = page.getSize();
  const margin = 50;
  const maxWidth = width - (margin * 2);
  let yPosition = height - margin;
  const defaultLineHeight = 15;
  const footerBuffer = 20;

  const sanitizePdfText = (text, font) => {
    const source = String(text ?? '');
    const replacements = {
      '\u2194': '<->',
      '\u2190': '<-',
      '\u2192': '->',
      '\u2022': '-',
      '\u00A0': ' '
    };
    let safe = '';
    for (const char of source) {
      const normalized = replacements[char] ?? char;
      try {
        font.encodeText(normalized);
        safe += normalized;
      } catch {
        safe += '?';
      }
    }
    return safe;
  };

  const ensureSpace = (requiredHeight = defaultLineHeight) => {
    if (yPosition - requiredHeight < margin + footerBuffer) {
      page = pdfDoc.addPage([612, 792]);
      ({ width, height } = page.getSize());
      yPosition = height - margin;
    }
  };

  const wrapText = (text, font, size) => {
    const source = sanitizePdfText(text, font);
    const words = source.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [''];
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  const drawLine = (text, { size = 11, font = regularFont } = {}) => {
    const safeText = sanitizePdfText(text, font);
    ensureSpace(size + 6);
    page.drawText(safeText, { x: margin, y: yPosition, size, font });
    yPosition -= Math.max(defaultLineHeight, size + 4);
  };

  const drawWrapped = (text, { size = 11, font = regularFont } = {}) => {
    for (const line of wrapText(text, font, size)) {
      drawLine(line, { size, font });
    }
  };

  const addSpacer = (heightValue = 10) => {
    ensureSpace(heightValue);
    yPosition -= heightValue;
  };

  const now = new Date();
  const submittedAt = now.toISOString();
  const submittedDate = submittedAt.split('T')[0];

  drawLine('CLIENT INTAKE REPORT', { size: 18, font: boldFont });
  drawLine(submittedDate, { size: 10 });
  addSpacer(8);

  drawLine('SUBMISSION METADATA', { size: 12, font: boldFont });
  drawWrapped(`Brand: ${normalizeValue(payload['brand-name']) || 'N/A'}`, { size: 10 });
  drawWrapped(`Client: ${normalizeValue(payload['client-name']) || 'N/A'}`, { size: 10 });
  drawWrapped(`Email: ${normalizeValue(payload.email) || 'N/A'}`, { size: 10 });
  drawWrapped(`Delivery Date: ${normalizeValue(payload['delivery-date']) || 'N/A'}`, { size: 10 });
  drawWrapped(`Submitted: ${submittedAt}`, { size: 10 });
  addSpacer(12);

  const metadataFields = new Set(['client-name', 'brand-name', 'email', 'delivery-date']);
  let currentSection = null;

  for (const [key, rawValue] of sortedEntries(payload)) {
    if (metadataFields.has(key)) continue;

    const value = normalizeValue(rawValue) || 'No response';
    const label = FIELD_LABELS[key] || prettifyKey(key);
    const questionNumber = extractQuestionNumber(key);
    const sectionLabel = getSectionLabel(questionNumber);

    if (sectionLabel && sectionLabel !== currentSection) {
      currentSection = sectionLabel;
      addSpacer(4);
      drawLine(sectionLabel.toUpperCase(), { size: 12, font: boldFont });
      addSpacer(4);
    }

    drawWrapped(label, { size: 10, font: boldFont });
    drawWrapped(value, { size: 10, font: regularFont });
    addSpacer(8);
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/* ─── Email ─── */

async function sendResendEmail({ apiKey, to, from, subject, html, text, attachments = [] }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, html, text, attachments })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend API error (${response.status}): ${errorText}`);
  }
}

function buildAdminEmail({ brandName, clientName, email, deliveryDate }) {
  const safeBrand = escapeHtml(brandName || 'Unknown Brand');
  const safeClient = escapeHtml(clientName || 'Unknown Client');
  const safeEmail = escapeHtml(email || 'Not provided');
  const safeDelivery = escapeHtml(deliveryDate || 'Not provided');

  return {
    subject: `New Intake: ${String(brandName || 'Unknown Brand')} (${String(clientName || 'Unknown Client')})`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #222;">
        <h2 style="color: #006d77; margin-bottom: 12px;">New Client Intake</h2>
        <p><strong>Client:</strong> ${safeClient}</p>
        <p><strong>Brand:</strong> ${safeBrand}</p>
        <p><strong>Email:</strong> ${safeEmail}</p>
        <p><strong>Delivery Date:</strong> ${safeDelivery}</p>
        <p style="margin-top: 16px; color: #666;">View full details in the dashboard.</p>
      </div>
    `,
    text: `New Client Intake\nClient: ${String(clientName || 'Unknown Client')}\nBrand: ${String(brandName || 'Unknown Brand')}\nEmail: ${String(email || 'Not provided')}\nDelivery Date: ${String(deliveryDate || 'Not provided')}`
  };
}

function buildClientEmail({ brandName, clientName }) {
  const safeBrand = escapeHtml(brandName || 'your brand');
  const safeClient = escapeHtml(clientName || 'Valued Client');

  return {
    subject: 'Thank You for Your Brand Intake Submission',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
        <h2 style="color: #006d77; margin-bottom: 20px;">Thank You, ${safeClient}!</h2>
        <p style="line-height: 1.6; margin-bottom: 15px;">
          We've successfully received your brand intake submission for <strong>${safeBrand}</strong>.
        </p>
        <p style="line-height: 1.6; margin-bottom: 15px;">
          Your responses have been carefully recorded, and we're excited to begin working on your project.
          Attached to this email, you'll find a PDF copy of your submission for your records.
        </p>
        <p style="line-height: 1.6; margin-bottom: 15px;">
          Our team will review your information and reach out to you shortly to discuss the next steps.
        </p>
        <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #006d77;">
          <p style="line-height: 1.6; margin: 0; color: #666;">
            Best regards,<br>
            <strong>The Neatmark Team</strong>
          </p>
        </div>
      </div>
    `,
    text: `Thank You, ${String(clientName || 'Valued Client')}!\n\nWe've successfully received your brand intake submission for ${String(brandName || 'your brand')}.\n\nYour responses have been carefully recorded, and we're excited to begin working on your project. Attached to this email, you'll find a PDF copy of your submission for your records.\n\nOur team will review your information and reach out to you shortly to discuss the next steps.\n\nBest regards,\nThe Neatmark Team`
  };
}

module.exports = {
  FIELD_LABELS,
  MAX_FIELD_VALUE_LENGTH,
  normalizeValue,
  escapeHtml,
  prettifyKey,
  sortedEntries,
  extractQuestionNumber,
  getSectionLabel,
  sanitizeFilenamePart,
  buildMarkdown,
  buildDocxBuffer,
  buildPdfBuffer,
  sendResendEmail,
  buildAdminEmail,
  buildClientEmail
};
