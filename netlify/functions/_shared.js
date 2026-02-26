const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const {
  Document, Packer, Paragraph, TextRun,
  HeadingLevel, AlignmentType, BorderStyle, ImageRun
} = require('docx');

/* ─────────────────────────────────────────────────────────────────────────────
   Constants
───────────────────────────────────────────────────────────────────────────── */

const MAX_FIELD_VALUE_LENGTH = 6000;

const FIELD_LABELS = {
  'client-name':               'Client Name',
  'brand-name':                'Brand / Business',
  email:                       'Client Email',
  'delivery-date':             'Delivery Date',
  'q1-business-description':  'Q1 — Business Description',
  'q2-problem-transformation':'Q2 — Problem + Transformation',
  'q3-ideal-customer':        'Q3 — Ideal Customer',
  'q4-competitors':           'Q4 — Competitors',
  'q5-brand-personality':     'Q5 — Brand Personality',
  'q6-positioning':           'Q6 — Positioning Statement',
  'q7-decision-maker':        'Q7 — Decision Maker',
  'q7-decision-maker-other':  'Q7 — Decision Maker (Other)',
  'q8-brands-admired':        'Q8 — Admired Brands',
  'q9-color':                 'Q9 — Color Directions',
  'q10-colors-to-avoid':      'Q10 — Colors To Avoid',
  'q11-aesthetic':            'Q11 — Aesthetic Direction',
  'q11-aesthetic-description':'Q11 — Additional Aesthetic Notes',
  'q12-existing-assets':      'Q12 — Existing Assets To Keep',
  'q13-deliverables':         'Q13 — Needed Deliverables',
  'q14-budget':               'Q14 — Budget Approach',
  'q15-inspiration-refs':     'Q15 — Inspiration References',
  'q16-anything-else':        'Q16 — Anything Else'
};

/* ─────────────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────────────── */

function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean)
      .map(item => String(item).trim().slice(0, MAX_FIELD_VALUE_LENGTH))
      .join(', ')
      .slice(0, MAX_FIELD_VALUE_LENGTH);
  }
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, MAX_FIELD_VALUE_LENGTH);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

function prettifyKey(key) {
  return key
    .replace(/^q(\d+)-/, 'Q$1 — ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
}

function sortedEntries(payload) {
  return Object.entries(payload).sort(([a], [b]) => {
    const aM = a.match(/^q(\d+)-/);
    const bM = b.match(/^q(\d+)-/);
    if (aM && bM) return Number(aM[1]) - Number(bM[1]);
    if (aM) return 1;
    if (bM) return -1;
    return a.localeCompare(b);
  });
}

function extractQuestionNumber(key) {
  const m = key.match(/^q(\d+)-/);
  return m ? Number(m[1]) : null;
}

function getSectionLabel(questionNumber) {
  if (!questionNumber) return null;
  if (questionNumber >= 1 && questionNumber <= 7)  return 'Section 01 — Brand Foundation';
  if (questionNumber >= 8 && questionNumber <= 16) return 'Section 02 — Visual Direction';
  return null;
}

function sanitizeFilenamePart(value, fallback) {
  const clean = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

const SYSTEM_FIELDS = new Set([
  'created_at', 'history', 'status', 'project-status', 'agreed-delivery-date',
  'edit_token', 'edit_token_expires_at'
]);

function parsePhotoRef(entry) {
  if (!entry) return null;
  try {
    const obj = typeof entry === 'string' ? JSON.parse(entry) : entry;
    if (obj && typeof obj === 'object' && obj.smallRef) return obj;
  } catch (_) { /* fall through */ }
  return { smallRef: entry, originalRef: entry };
}

function getPhotoFilename(entry) {
  const parsed = parsePhotoRef(entry);
  if (!parsed) return String(entry || '');
  const ref      = parsed.originalRef || parsed.smallRef || '';
  const basename = ref.split('/').pop() || ref;
  return basename.replace(/^\d+_[a-z0-9]+_/, '');
}

function formatHumanDate(date) {
  return date.toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   Markdown
───────────────────────────────────────────────────────────────────────────── */

function buildMarkdown(payload) {
  const now         = new Date();
  const clientName  = normalizeValue(payload['client-name']) || 'Unknown Client';
  const brandName   = normalizeValue(payload['brand-name'])  || 'Unknown Brand';

  const lines = [
    '# Client Intake Submission', '',
    `- **Submitted:** ${formatHumanDate(now)}`,
    `- **Client Name:** ${clientName}`,
    `- **Brand Name:** ${brandName}`,
    '', '---', ''
  ];

  for (const [key, rawValue] of sortedEntries(payload)) {
    if (SYSTEM_FIELDS.has(key)) continue;
    const label = FIELD_LABELS[key] || prettifyKey(key);
    lines.push(`## ${label}`, '');

    if (key === 'q15-inspiration-refs') {
      const refs = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
      if (refs.length > 0) {
        refs.forEach((ref, i) => lines.push(`- Inspiration ${i + 1}: ${getPhotoFilename(ref)}`));
      } else {
        lines.push('_No images uploaded_');
      }
    } else {
      lines.push(normalizeValue(rawValue) || '_No response_');
    }
    lines.push('');
  }

  return lines.join('\n');
}

/* ─────────────────────────────────────────────────────────────────────────────
   DOCX
───────────────────────────────────────────────────────────────────────────── */

async function buildDocxBuffer(payload, imageBuffers = {}) {
  const now          = new Date();
  const clientName   = normalizeValue(payload['client-name']) || 'Unknown Client';
  const brandName    = normalizeValue(payload['brand-name'])  || 'Unknown Brand';
  const clientEmail  = normalizeValue(payload.email)          || 'Not provided';
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
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '006D77' } },
      spacing: { after: 260 }
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Submission Details', bold: true, allCaps: true, color: '006D77' })],
      spacing: { after: 120 }
    }),
    ...[
      ['Submitted:', formatHumanDate(now)],
      ['Client Name:', clientName],
      ['Brand / Business:', brandName],
      ['Client Email:', clientEmail],
      ['Requested Delivery:', deliveryDate]
    ].map(([label, value]) => new Paragraph({
      children: [new TextRun({ text: label + ' ', bold: true }), new TextRun({ text: value })],
      spacing: { after: 80 }
    }))
  ];

  let currentSection = null;
  for (const [key, rawValue] of sortedEntries(payload)) {
    if (['client-name', 'brand-name', 'email', 'delivery-date'].includes(key)) continue;
    if (SYSTEM_FIELDS.has(key)) continue;

    const label          = FIELD_LABELS[key] || prettifyKey(key);
    const questionNumber = extractQuestionNumber(key);
    const sectionLabel   = getSectionLabel(questionNumber);

    if (sectionLabel && sectionLabel !== currentSection) {
      currentSection = sectionLabel;
      children.push(new Paragraph({
        text: sectionLabel, heading: HeadingLevel.HEADING_1,
        spacing: { before: 260, after: 130 }
      }));
    }

    children.push(new Paragraph({
      children: [new TextRun({ text: label, bold: true, color: '1F1F1F' })],
      spacing: { before: 160, after: 70 }
    }));

    if (key === 'q15-inspiration-refs') {
      const refs = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
      if (refs.length > 0) {
        const imgChildren = [];
        for (const ref of refs) {
          const buf = imageBuffers[ref];
          if (buf) {
            imgChildren.push(new ImageRun({ data: buf, transformation: { width: 140, height: 140 }, type: 'jpg' }));
            imgChildren.push(new TextRun({ text: '  ' }));
          } else {
            imgChildren.push(new TextRun({ text: `[${getPhotoFilename(ref)}]  ` }));
          }
        }
        children.push(new Paragraph({ children: imgChildren, spacing: { after: 110 } }));
      } else {
        children.push(new Paragraph({
          children: [new TextRun({ text: 'No images uploaded', italics: true, color: '888888' })],
          spacing: { after: 110 }
        }));
      }
    } else {
      const value = normalizeValue(rawValue) || 'No response';
      children.push(new Paragraph({ children: [new TextRun({ text: value })], spacing: { after: 110 } }));
    }

    children.push(new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'ECECEC' } },
      spacing: { after: 80 }
    }));
  }

  const document = new Document({
    styles: {
      default: {
        heading1: { run: { bold: true, size: 28, color: '006D77', font: 'Calibri' }, paragraph: { spacing: { before: 320, after: 120 } } },
        title:    { run: { bold: true, size: 40, color: '1D1D1D', font: 'Calibri' } }
      },
      paragraphStyles: [{
        id: 'Normal', name: 'Normal',
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

/* ─────────────────────────────────────────────────────────────────────────────
   PDF  —  Professional branded layout
───────────────────────────────────────────────────────────────────────────── */

// Brand palette (RGB 0–1)
const BRAND_TEAL   = rgb(0/255, 109/255, 119/255);  // #006d77
const BRAND_DARK   = rgb(0/255,  55/255,  60/255);  // #00373c
const ACCENT_LIGHT = rgb(230/255, 252/255, 248/255); // #e6fcf8
const GRAY_TEXT    = rgb(80/255,  80/255,  80/255);
const GRAY_LIGHT   = rgb(220/255, 220/255, 220/255);
const WHITE        = rgb(1, 1, 1);

async function buildPdfBuffer(payload, imageBuffers = {}) {
  const pdfDoc      = await PDFDocument.create();
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W  = 595;  // A4 width  in points
  const PAGE_H  = 842;  // A4 height in points
  const MARGIN  = 48;
  const COL_W   = PAGE_W - MARGIN * 2;

  // ── Sanitise text for pdf-lib (Latin-1 only) ──────────────────────────────
  const REPLACEMENTS = { '\u2194': '<->', '\u2190': '<-', '\u2192': '->', '\u2022': '-', '\u00A0': ' ' };
  function sanitize(text) {
    let safe = '';
    for (const ch of String(text ?? '')) {
      const rep = REPLACEMENTS[ch] ?? ch;
      try { regularFont.encodeText(rep); safe += rep; } catch { safe += '?'; }
    }
    return safe;
  }

  // ── Word-wrap ─────────────────────────────────────────────────────────────
  function wrapText(text, font, size, maxW) {
    const src   = sanitize(text);
    const words = src.split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxW || !line) { line = candidate; }
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines;
  }

  // ── Page & cursor state ───────────────────────────────────────────────────
  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y    = PAGE_H - MARGIN;
  let pageNum = 1;

  // ── Page header / footer helpers ─────────────────────────────────────────
  const HEADER_H      = 56;
  const FOOTER_H      = 32;
  const CONTENT_TOP   = PAGE_H - HEADER_H;
  const CONTENT_BOT   = FOOTER_H;

  function drawPageDecor(p, num, totalHint) {
    // Teal header band
    p.drawRectangle({ x: 0, y: PAGE_H - HEADER_H, width: PAGE_W, height: HEADER_H, color: BRAND_TEAL });
    p.drawText(sanitize('CLIENT INTAKE REPORT'), {
      x: MARGIN, y: PAGE_H - HEADER_H + 20,
      size: 14, font: boldFont, color: WHITE
    });
    p.drawText('Neatmark Studio', {
      x: PAGE_W - MARGIN - boldFont.widthOfTextAtSize('Neatmark Studio', 10),
      y: PAGE_H - HEADER_H + 22,
      size: 10, font: boldFont, color: rgb(0.8, 1, 0.97)
    });

    // Subtle footer
    p.drawLine({
      start: { x: MARGIN, y: FOOTER_H + 12 },
      end:   { x: PAGE_W - MARGIN, y: FOOTER_H + 12 },
      thickness: 0.5, color: GRAY_LIGHT
    });
    p.drawText(`Page ${num}`, {
      x: PAGE_W / 2 - 12,
      y: FOOTER_H - 4,
      size: 8, font: regularFont, color: GRAY_TEXT
    });
  }

  drawPageDecor(page, pageNum);
  y = CONTENT_TOP - 24;

  // ── Ensure vertical space, add new page if needed ─────────────────────────
  function ensureSpace(needed) {
    if (y - needed < CONTENT_BOT + 4) {
      pageNum++;
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      drawPageDecor(page, pageNum);
      y = CONTENT_TOP - 24;
    }
  }

  // ── Drawing primitives ────────────────────────────────────────────────────
  function drawText(text, { size = 10, font = regularFont, color = GRAY_TEXT, indent = 0 } = {}) {
    ensureSpace(size + 5);
    page.drawText(sanitize(text), { x: MARGIN + indent, y, size, font, color });
    y -= size + 5;
  }

  function drawWrapped(text, { size = 10, font = regularFont, color = GRAY_TEXT, indent = 0, lineGap = 4 } = {}) {
    const lines = wrapText(text, font, size, COL_W - indent);
    for (const line of lines) {
      ensureSpace(size + lineGap);
      page.drawText(sanitize(line), { x: MARGIN + indent, y, size, font, color });
      y -= size + lineGap;
    }
  }

  function spacer(h = 8) {
    ensureSpace(h);
    y -= h;
  }

  // ── Cover / metadata block ────────────────────────────────────────────────
  const now          = new Date();
  const clientName   = normalizeValue(payload['client-name']) || 'Unknown Client';
  const brandName    = normalizeValue(payload['brand-name'])  || 'Unknown Brand';
  const clientEmail  = normalizeValue(payload.email)          || 'Not provided';
  const deliveryDate = normalizeValue(payload['delivery-date']) || 'Not provided';
  const submittedAt  = formatHumanDate(now);

  // Light teal metadata card
  const CARD_H = 108;
  ensureSpace(CARD_H + 16);
  page.drawRectangle({ x: MARGIN, y: y - CARD_H, width: COL_W, height: CARD_H, color: ACCENT_LIGHT });
  page.drawRectangle({ x: MARGIN, y: y - CARD_H, width: 4, height: CARD_H, color: BRAND_TEAL });

  const cardY = y - 16;
  const metaRows = [
    ['Brand / Business', brandName],
    ['Client Name',      clientName],
    ['Email',            clientEmail],
    ['Delivery',         deliveryDate],
    ['Submitted',        submittedAt]
  ];
  metaRows.forEach(([label, value], i) => {
    const rowY = cardY - i * 17;
    page.drawText(sanitize(label + ':'), { x: MARGIN + 12, y: rowY, size: 9, font: boldFont, color: BRAND_DARK });
    const lines = wrapText(value, regularFont, 9, COL_W - 110);
    page.drawText(sanitize(lines[0] || ''), { x: MARGIN + 110, y: rowY, size: 9, font: regularFont, color: GRAY_TEXT });
  });
  y -= CARD_H + 20;

  // ── Section divider helper ────────────────────────────────────────────────
  function drawSectionHeader(title) {
    spacer(12);
    ensureSpace(30);
    page.drawRectangle({ x: MARGIN, y: y - 22, width: COL_W, height: 26, color: BRAND_TEAL });
    page.drawText(sanitize(title.toUpperCase()), {
      x: MARGIN + 10, y: y - 16,
      size: 10, font: boldFont, color: WHITE
    });
    y -= 26 + 12;
  }

  // ── Q&A divider helper ────────────────────────────────────────────────────
  function drawQuestionBlock(label, value) {
    spacer(6);
    ensureSpace(14);

    // Question label with teal left accent
    page.drawRectangle({ x: MARGIN, y: y - 14, width: 3, height: 16, color: BRAND_TEAL });
    const labelLines = wrapText(label, boldFont, 9.5, COL_W - 10);
    labelLines.forEach(line => {
      ensureSpace(12);
      page.drawText(sanitize(line), { x: MARGIN + 9, y, size: 9.5, font: boldFont, color: BRAND_DARK });
      y -= 13;
    });

    // Answer
    const answerLines = wrapText(value || 'No response', regularFont, 9.5, COL_W);
    answerLines.forEach(line => {
      ensureSpace(13);
      page.drawText(sanitize(line), { x: MARGIN, y, size: 9.5, font: regularFont, color: GRAY_TEXT });
      y -= 13;
    });

    // Subtle rule
    spacer(3);
    ensureSpace(2);
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + COL_W, y }, thickness: 0.4, color: GRAY_LIGHT });
    spacer(2);
  }

  // ── Render all questions ──────────────────────────────────────────────────
  const metaFields  = new Set(['client-name', 'brand-name', 'email', 'delivery-date']);
  let currentSection = null;

  for (const [key, rawValue] of sortedEntries(payload)) {
    if (metaFields.has(key) || SYSTEM_FIELDS.has(key)) continue;

    const label          = FIELD_LABELS[key] || prettifyKey(key);
    const questionNumber = extractQuestionNumber(key);
    const sectionLabel   = getSectionLabel(questionNumber);

    if (sectionLabel && sectionLabel !== currentSection) {
      currentSection = sectionLabel;
      drawSectionHeader(sectionLabel);
    }

    if (key === 'q15-inspiration-refs') {
      const refs = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
      spacer(6);
      ensureSpace(14);
      page.drawRectangle({ x: MARGIN, y: y - 14, width: 3, height: 16, color: BRAND_TEAL });
      page.drawText(sanitize(label), { x: MARGIN + 9, y, size: 9.5, font: boldFont, color: BRAND_DARK });
      y -= 16;

      if (refs.length > 0) {
        const IMG_SIZE = 90;
        const IMG_GAP  = 8;
        const PER_ROW  = Math.max(1, Math.floor(COL_W / (IMG_SIZE + IMG_GAP)));
        let embeddedAny = false;

        for (let start = 0; start < refs.length; start += PER_ROW) {
          const row = refs.slice(start, start + PER_ROW);
          ensureSpace(IMG_SIZE + IMG_GAP + 6);
          let xPos = MARGIN;

          for (const ref of row) {
            const buf = imageBuffers[ref];
            if (buf) {
              try {
                const embedded = await pdfDoc.embedJpg(buf);
                const dims     = embedded.scaleToFit(IMG_SIZE, IMG_SIZE);
                page.drawImage(embedded, { x: xPos, y: y - dims.height, width: dims.width, height: dims.height });
                xPos += dims.width + IMG_GAP;
                embeddedAny = true;
              } catch {
                drawWrapped(`[${getPhotoFilename(ref)}]`, { size: 9 });
              }
            } else {
              drawWrapped(`[${getPhotoFilename(ref)}]`, { size: 9 });
            }
          }
          if (embeddedAny) y -= IMG_SIZE + IMG_GAP;
        }
      } else {
        drawWrapped('No images uploaded', { size: 9, color: GRAY_TEXT });
      }

      spacer(2);
      page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + COL_W, y }, thickness: 0.4, color: GRAY_LIGHT });
      spacer(2);
    } else {
      drawQuestionBlock(label, normalizeValue(rawValue));
    }
  }

  // Final bottom padding
  spacer(16);

  return Buffer.from(await pdfDoc.save());
}

/* ─────────────────────────────────────────────────────────────────────────────
   Email helpers
───────────────────────────────────────────────────────────────────────────── */

// Shared transactional email wrapper style
function emailWrapper(bodyHtml) {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <!-- Header bar -->
        <tr><td style="background:#006d77;padding:24px 32px;">
          <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.5px;">NEATMARK</span>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;">
          ${bodyHtml}
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#f9f9f9;padding:16px 32px;border-top:1px solid #eee;">
          <p style="margin:0;font-size:12px;color:#999;">
            &copy; 2026 Neatmark™ &nbsp;·&nbsp;
            <a href="https://neatmark.studio/privacy" style="color:#006d77;text-decoration:none;">Privacy Policy</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Admin notification email.
 * No inline images — all content delivered via PDF/DOCX attachments.
 */
function buildAdminEmail({ brandName, clientName, email, deliveryDate }) {
  const safeBrand    = escapeHtml(brandName    || 'Unknown Brand');
  const safeClient   = escapeHtml(clientName   || 'Unknown Client');
  const safeEmail    = escapeHtml(email        || 'Not provided');
  const safeDelivery = escapeHtml(deliveryDate || 'Not provided');

  const bodyHtml = `
    <h2 style="color:#006d77;margin:0 0 20px;">New Client Intake Submission</h2>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
      ${[
        ['Client', safeClient],
        ['Brand / Business', safeBrand],
        ['Email', safeEmail],
        ['Requested Delivery', safeDelivery]
      ].map(([label, value]) => `
        <tr>
          <td style="padding:8px 12px;background:#f0faf8;font-size:13px;font-weight:700;color:#00373c;width:160px;border-bottom:1px solid #e0f0ee;">${label}</td>
          <td style="padding:8px 12px;font-size:13px;color:#333;border-bottom:1px solid #e0f0ee;">${value}</td>
        </tr>`).join('')}
    </table>
    <p style="margin:24px 0 0;font-size:13px;color:#666;">
      The full submission (PDF, DOCX &amp; Markdown) is attached to this email.
    </p>`;

  return {
    subject: `New Intake: ${String(brandName || 'Unknown Brand')} · ${String(clientName || 'Unknown Client')}`,
    html: emailWrapper(bodyHtml),
    text: `New Client Intake\n\nClient: ${String(clientName)}\nBrand: ${String(brandName)}\nEmail: ${String(email)}\nDelivery: ${String(deliveryDate)}\n\nFull submission attached.`
  };
}

/**
 * Client confirmation email — sent on NEW submission.
 * Includes a 30-day edit link.
 */
function buildClientEmail({ brandName, clientName, editLink }) {
  const safeBrand  = escapeHtml(brandName  || 'your brand');
  const safeClient = escapeHtml(clientName || 'there');

  const bodyHtml = `
    <h2 style="color:#006d77;margin:0 0 8px;">Thank you, ${safeClient}!</h2>
    <p style="color:#333;line-height:1.7;margin:0 0 16px;">
      We've received your brand intake submission for <strong>${safeBrand}</strong>. 
      Our team will review your answers and reach out within 2 business days.
    </p>
    <p style="color:#333;line-height:1.7;margin:0 0 16px;">
      A copy of your submission is attached to this email as a PDF for your records.
    </p>
    <div style="margin:24px 0;padding:20px;background:#f0faf8;border-radius:8px;border-left:4px solid #006d77;">
      <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#00373c;">
        Need to make changes?
      </p>
      <p style="margin:0 0 16px;font-size:13px;color:#444;line-height:1.6;">
        You have 30 days to update your answers using the secure link below. 
        This link is personal — please don't share it.
      </p>
      <a href="${editLink}"
         style="display:inline-block;background:#006d77;color:#ffffff;text-decoration:none;
                padding:12px 24px;border-radius:6px;font-size:14px;font-weight:700;">
        Edit My Submission &rarr;
      </a>
    </div>`;

  return {
    subject: `Received: Brand Intake for ${String(brandName || 'your brand')}`,
    html: emailWrapper(bodyHtml),
    text: `Thank you, ${String(clientName)}!\n\nWe've received your brand intake for ${String(brandName)}.\n\nTo edit your answers (valid for 30 days):\n${editLink}\n\nWe'll be in touch within 2 business days.\n\n— The Neatmark Team`
  };
}

/**
 * Edit confirmation email — sent after a successful token-based edit.
 */
function buildEditConfirmationEmail({ brandName, clientName }) {
  const safeBrand  = escapeHtml(brandName  || 'your brand');
  const safeClient = escapeHtml(clientName || 'there');
  const editedAt   = new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });

  const bodyHtml = `
    <h2 style="color:#006d77;margin:0 0 8px;">Edits received, ${safeClient}!</h2>
    <p style="color:#333;line-height:1.7;margin:0 0 16px;">
      Your updates to the brand intake for <strong>${safeBrand}</strong> have been 
      successfully received by Neatmark on <strong>${editedAt}</strong>.
    </p>
    <p style="color:#333;line-height:1.7;margin:0 0 16px;">
      Our team has been notified and will incorporate your latest answers into the project.
      If you have any further questions, reply to this email.
    </p>
    <div style="margin-top:24px;padding-top:20px;border-top:2px solid #e0f0ee;">
      <p style="margin:0;color:#888;font-size:13px;">
        — The Neatmark Team
      </p>
    </div>`;

  return {
    subject: `Edits Received: Brand Intake for ${String(brandName || 'your brand')}`,
    html: emailWrapper(bodyHtml),
    text: `Edits received!\n\nYour updates to the brand intake for ${String(brandName)} have been received on ${editedAt}.\n\nOur team has been notified.\n\n— The Neatmark Team`
  };
}

async function sendResendEmail({ apiKey, to, from, subject, html, text, attachments = [] }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text, attachments })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend API error (${response.status}): ${errorText}`);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Exports
───────────────────────────────────────────────────────────────────────────── */

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
  buildClientEmail,
  buildEditConfirmationEmail
};
