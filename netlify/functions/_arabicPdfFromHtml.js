// netlify/functions/_arabicPdfFromHtml.js
// ─────────────────────────────────────────────────────────────────────────────
// HTML → PDF with full Arabic / RTL support via headless Chromium.
//
// FIX vs previous version: ALL requires are LAZY (inside the async function).
// This means if puppeteer-core is unavailable, the module still loads cleanly
// and only the call to htmlToPdfBuffer() fails — not the entire Lambda init.
//
// Fallback chain:
//   1. @sparticuz/chromium (Lambda/Netlify)
//   2. Local Chrome via CHROME_PATH env var (dev)
//   3. /usr/bin/google-chrome, /usr/bin/chromium-browser (Linux CI)
//
// npm install puppeteer-core @sparticuz/chromium
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const fs   = require('fs');

// ── Font cache (loaded once per warm instance) ────────────────────────────────
let _norsalBase64 = null;
let _amiriBase64  = null;

function getFontBase64(name) {
  if (name === 'Norsal' && _norsalBase64) return _norsalBase64;
  if (name === 'Amiri'  && _amiriBase64)  return _amiriBase64;

  const base = name === 'Norsal' ? 'Norsal.ttf' : 'Amiri-Regular.ttf';
  const candidates = [
    path.join(process.cwd(), 'assets', base),
    path.join(__dirname, '../../assets', base),
    path.join(__dirname, '../assets', base),
    path.join(__dirname, 'assets', base),
  ];

  for (const p of candidates) {
    try {
      const b64 = fs.readFileSync(p).toString('base64');
      if (name === 'Norsal') _norsalBase64 = b64;
      else                   _amiriBase64  = b64;
      return b64;
    } catch (_) { /* try next */ }
  }
  return null; // caller decides what to do
}

// ── Browser pool (reused across warm invocations) ─────────────────────────────
let _browser = null;

async function getBrowser() {
  // Try to reuse existing browser instance
  if (_browser) {
    try { await _browser.version(); return _browser; } catch (_) { _browser = null; }
  }

  // ALL requires are lazy here — if puppeteer-core is missing this throws
  // inside the async function, not at module-load time.
  const puppeteer = require('puppeteer-core');

  let executablePath;
  let extraArgs = ['--no-sandbox', '--disable-setuid-sandbox',
                   '--disable-dev-shm-usage', '--single-process'];
  let defaultViewport = { width: 1280, height: 900 };

  // 1. Try @sparticuz/chromium (Netlify / Lambda bundled binary)
  try {
    const chromium = require('@sparticuz/chromium');
    executablePath   = await chromium.executablePath();
    extraArgs        = [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage'];
    defaultViewport  = chromium.defaultViewport;
  } catch (_) {
    // 2. Fall back to local / CI Chrome
    const localPaths = [
      process.env.CHROME_PATH,
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean);

    for (const p of localPaths) {
      try { fs.accessSync(p); executablePath = p; break; } catch (_) {}
    }

    if (!executablePath) {
      throw new Error(
        'No Chromium executable found. Set CHROME_PATH env var or install @sparticuz/chromium.'
      );
    }
  }

  _browser = await puppeteer.launch({
    executablePath,
    args: extraArgs,
    defaultViewport,
    headless: true,
  });
  return _browser;
}

/**
 * Converts a complete HTML document string to a PDF Buffer.
 * @param {string} html
 * @returns {Promise<Buffer>}
 */
async function htmlToPdfBuffer(html) {
  const browser = await getBrowser();
  const page    = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 25000 });
    const pdfBytes = await page.pdf({
      format:          'A4',
      printBackground: true,
      margin:          { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdfBytes);
  } finally {
    await page.close();
  }
}

// ── Brand palette ─────────────────────────────────────────────────────────────
const C = {
  teal:   '#006d77',
  dark:   '#00373c',
  accent: '#e6fcf8',
  gray:   '#505050',
  light:  '#dcdcdc',
};

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Builds a complete branded HTML document for one Arabic form submission.
 *
 * @param {object} payload       - Raw form payload
 * @param {string} lang          - 'ar' | 'en' | 'fr'
 * @param {object} strings       - DOC_STRINGS[lang]
 * @param {object} fieldLabels   - Translated field-label map
 * @param {Array}  sortedFields  - [{label, value, sectionTitle?}] in display order
 * @returns {string}             - Complete HTML document string
 */
function buildArabicHtml(payload, lang, strings, fieldLabels, sortedFields) {
  const s      = strings;
  const isRtl  = (lang === 'ar');
  const dir    = isRtl ? 'rtl' : 'ltr';
  const align  = isRtl ? 'right' : 'left';
  const oAlign = isRtl ? 'left' : 'right';

  // Prefer Norsal (brand font), fall back to Amiri if Norsal not found
  const norsalB64 = getFontBase64('Norsal');
  const amiriB64  = getFontBase64('Amiri');

  const fontFaceBlocks = [];
  if (norsalB64) {
    fontFaceBlocks.push(`@font-face {
  font-family: 'Norsal';
  src: url('data:font/truetype;base64,${norsalB64}') format('truetype');
  font-weight: normal; font-style: normal;
}`);
  }
  if (amiriB64) {
    fontFaceBlocks.push(`@font-face {
  font-family: 'Amiri';
  src: url('data:font/truetype;base64,${amiriB64}') format('truetype');
  font-weight: normal; font-style: normal;
}`);
  }

  // Font stack: Norsal first (brand), Amiri as accurate Arabic fallback
  const fontStack = [
    norsalB64 ? "'Norsal'" : null,
    amiriB64  ? "'Amiri'"  : null,
    "'Arial Unicode MS'", "Arial", "sans-serif",
  ].filter(Boolean).join(', ');

  // Meta card rows
  const metaRows = [
    [s.brandBusiness,     payload['brand-name']    || '—'],
    [s.clientName,        payload['client-name']   || '—'],
    [s.clientEmail,       payload['email']         || '—'],
    [s.requestedDelivery, payload['delivery-date'] || '—'],
  ];
  if (payload['client-country']) {
    metaRows.push([(s.country || 'Country'), payload['client-country']]);
  }

  const metaHtml = metaRows.map(([label, value]) => `
      <tr>
        <td class="ml">${escHtml(label)}</td>
        <td class="mv">${escHtml(value)}</td>
      </tr>`).join('');

  const qaHtml = sortedFields.map(({ sectionTitle, label, value }) => {
    let html = '';
    if (sectionTitle) html += `\n  <div class="sec">${escHtml(sectionTitle)}</div>`;
    html += `
  <div class="qa">
    <div class="qa-bar"></div>
    <div class="qa-body">
      <div class="qa-q">${escHtml(label)}</div>
      <div class="qa-a">${escHtml(value || s.noResponse || '—')}</div>
    </div>
  </div>
  <div class="qa-rule"></div>`;
    return html;
  }).join('');

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="UTF-8">
<style>
${fontFaceBlocks.join('\n')}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  font-family: ${fontStack};
  font-size: 10pt;
  color: ${C.gray};
  background: #fff;
  direction: ${dir};
  unicode-bidi: embed;
  font-feature-settings: "calt" 1, "kern" 1, "liga" 1, "curs" 1, "clig" 1;
  -webkit-font-feature-settings: "calt" 1, "kern" 1, "liga" 1, "curs" 1, "clig" 1;
}

@page { size: A4; margin: 0; }

.hdr {
  background: ${C.teal};
  width: 100%; height: 56px;
  display: flex; align-items: center;
  justify-content: space-between;
  padding: 0 48px;
  page-break-inside: avoid;
}
.hdr-title { color: #fff; font-size: 14pt; font-weight: bold; }
.hdr-brand {
  color: rgba(204,255,249,.9); font-size: 10pt; font-weight: bold;
  font-family: Arial, sans-serif; direction: ltr; unicode-bidi: isolate;
}

.content { padding: 20px 48px 60px; }

.meta {
  background: ${C.accent};
  border-${isRtl ? 'right' : 'left'}: 4px solid ${C.teal};
  padding: 10px 14px; margin-bottom: 22px;
}
.meta table { width: 100%; border-collapse: collapse; }
.ml {
  font-weight: bold; font-size: 9pt; color: ${C.dark};
  padding: 3px 6px; width: 44%;
  text-align: ${align}; direction: ${dir}; unicode-bidi: embed;
}
.mv { font-size: 9pt; color: ${C.gray}; padding: 3px 6px; text-align: ${oAlign}; }

.sec {
  background: ${C.teal}; color: #fff;
  font-size: 10pt; font-weight: bold;
  padding: 6px 12px; margin: 18px 0 10px;
  text-transform: uppercase;
  direction: ${dir}; unicode-bidi: embed;
  page-break-after: avoid;
}

.qa {
  display: flex;
  flex-direction: ${isRtl ? 'row-reverse' : 'row'};
  margin-bottom: 2px; page-break-inside: avoid;
}
.qa-bar {
  width: 3px; background: ${C.teal}; flex-shrink: 0;
  margin-${isRtl ? 'left' : 'right'}: 9px; margin-top: 3px;
}
.qa-body { flex: 1; direction: ${dir}; unicode-bidi: embed; }
.qa-q { font-weight: bold; font-size: 9.5pt; color: ${C.dark}; margin-bottom: 3px; text-align: ${align}; }
.qa-a { font-size: 9.5pt; color: ${C.gray}; line-height: 1.55; text-align: ${align}; white-space: pre-wrap; word-break: break-word; }
.qa-rule { border-bottom: .4px solid ${C.light}; margin: 5px 0; }

.ftr {
  position: fixed; bottom: 0; left: 0; right: 0;
  height: 28px; border-top: .5px solid ${C.light};
  display: flex; align-items: center; justify-content: center;
  font-size: 8pt; color: ${C.gray};
  font-family: Arial, sans-serif; direction: ltr; background: #fff;
}
</style>
</head>
<body>
<div class="hdr">
  <div class="hdr-title">${escHtml(s.reportTitle || 'Submission Report')}</div>
  <div class="hdr-brand">Neatmark Studio</div>
</div>
<div class="content">
  <div class="meta"><table>${metaHtml}</table></div>
  ${qaHtml}
</div>
<div class="ftr">Neatmark Studio &nbsp;&middot;&nbsp; ${escHtml(s.reportTitle || 'Report')}</div>
</body>
</html>`;
}

module.exports = { htmlToPdfBuffer, buildArabicHtml, escHtml };
