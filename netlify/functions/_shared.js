const fs   = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
// fontkit is required for embedding custom Unicode fonts (Arabic support).
// If you haven't run npm install yet, Arabic PDFs will fall back gracefully.
let fontkit;
try { fontkit = require('@pdf-lib/fontkit'); } catch (_) { fontkit = null; }
const {
  Document, Packer, Paragraph, TextRun,
  HeadingLevel, AlignmentType, BorderStyle, ImageRun
} = require('docx');

// Arabic HTML→PDF engine — lazy-loaded inside, safe to require at module level.
// If puppeteer-core is unavailable this module still loads; the error only
// surfaces when htmlToPdfBuffer() is actually called (Arabic submissions only).
const { htmlToPdfBuffer, buildArabicHtml } = require('./_arabicPdfFromHtml');

/* ─────────────────────────────────────────────────────────────────────────────
   Constants
───────────────────────────────────────────────────────────────────────────── */

const MAX_FIELD_VALUE_LENGTH = 6000;

/**
 * Strip control characters from email subjects to prevent header injection.
 * Newlines (\r, \n) and tabs in a subject header can trick some mail parsers
 * into interpreting extra headers in folded lines.
 */
function sanitizeSubject(str) {
  return String(str || '').replace(/[\r\n\t]/g, ' ').trim();
}

const FIELD_LABELS = {
  'client-name':               'Client Name',
  'brand-name':                'Brand / Business',
  email:                       'Client Email',
  'client-website':            'Website',
  'delivery-date':             'Delivery Timeframe',
  'q1-business-description':  'Q01: Business Description',
  'q2-problem-transformation':'Q02: Before and After',
  'q3-ideal-customer':        'Q03: Ideal Client',
  'q3b-customer-desire':      'Q04: Client Trigger',
  'q4-competitors':           'Q05: Competitors',
  'q5-brand-personality':     'Q06: Brand Personality',
  'q6-positioning':           'Q07: Positioning Statement',
  'q-launch-context':         'Q08: Launch Context',
  'q8-brands-admired':        'Q09: Admired Brands',
  'q9-color':                 'Q10: Color Directions',
  'q10-colors-to-avoid':      'Q11: Colors to Avoid',
  'q11-aesthetic':            'Q12: Aesthetic Direction',
  'q11-aesthetic-description':'Q12: Aesthetic Notes',
  'q12-existing-assets':      'Q17: Existing Assets',
  'q13-deliverables':         'Q13: Deliverables',
  'q14-budget':               'Q14: Budget Approach',
  'q15-inspiration-refs':     'Q15: Inspiration Images',
  'q7-decision-maker':        'Q16: Decision Maker',
  'q7-decision-maker-other':  'Q16: Decision Maker (Other)',
  'q16-anything-else':        'Q19: Past Experience and Fears'
};

// French field labels (Latin-1 safe for PDF rendering)
const FIELD_LABELS_FR = {
  'client-name':               'Nom du client',
  'brand-name':                'Marque / Entreprise',
  email:                       'Email du client',
  'client-website':            'Site web',
  'delivery-date':             'Delai de livraison',
  'q1-business-description':  'Q01: Description de l\'entreprise',
  'q2-problem-transformation':'Q02: Avant et Apres',
  'q3-ideal-customer':        'Q03: Client ideal',
  'q3b-customer-desire':      'Q04: Declencheur client',
  'q4-competitors':           'Q05: Concurrents',
  'q5-brand-personality':     'Q06: Personnalite de la marque',
  'q6-positioning':           'Q07: Positionnement',
  'q-launch-context':         'Q08: Contexte de lancement',
  'q8-brands-admired':        'Q09: Marques admirees',
  'q9-color':                 'Q10: Directions de couleurs',
  'q10-colors-to-avoid':      'Q11: Couleurs a eviter',
  'q11-aesthetic':            'Q12: Direction esthetique',
  'q11-aesthetic-description':'Q12: Notes esthetiques',
  'q12-existing-assets':      'Q17: Ressources existantes',
  'q13-deliverables':         'Q13: Livrables',
  'q14-budget':               'Q14: Approche budgetaire',
  'q15-inspiration-refs':     'Q15: Images d\'inspiration',
  'q7-decision-maker':        'Q16: Decideur',
  'q7-decision-maker-other':  'Q16: Decideur (Autre)',
  'q16-anything-else':        'Q19: Experiences passees et craintes'
};

// Arabic field labels — used for Markdown only (PDF/DOCX can't render Arabic glyphs)
const FIELD_LABELS_AR = {
  'client-name':               'اسم العميل',
  'brand-name':                'البراند / الشركة',
  email:                       'البريد الإلكتروني',
  'client-website':            'الموقع الإلكتروني',
  'delivery-date':             'الإطار الزمني للتسليم',
  'q1-business-description':  'Q01: وصف النشاط التجاري',
  'q2-problem-transformation':'Q02: قبل وبعد',
  'q3-ideal-customer':        'Q03: العميل المثالي',
  'q3b-customer-desire':      'Q04: محرك العميل',
  'q4-competitors':           'Q05: المنافسون',
  'q5-brand-personality':     'Q06: شخصية البراند',
  'q6-positioning':           'Q07: جملة التموضع',
  'q-launch-context':         'Q08: سياق الإطلاق',
  'q8-brands-admired':        'Q09: براندات معجب بها',
  'q9-color':                 'Q10: اتجاهات الألوان',
  'q10-colors-to-avoid':      'Q11: الألوان المستبعدة',
  'q11-aesthetic':            'Q12: الاتجاه الجمالي',
  'q11-aesthetic-description':'Q12: ملاحظات جمالية',
  'q12-existing-assets':      'Q17: الأصول الموجودة',
  'q13-deliverables':         'Q13: المخرجات',
  'q14-budget':               'Q14: نهج الميزانية',
  'q15-inspiration-refs':     'Q15: صور الإلهام',
  'q7-decision-maker':        'Q16: صاحب القرار',
  'q7-decision-maker-other':  'Q16: صاحب القرار (أخرى)',
  'q16-anything-else':        'Q19: تجارب سابقة ومخاوف'
};

function getFieldLabels(lang) {
  if (lang === 'fr') return FIELD_LABELS_FR;
  if (lang === 'ar') return FIELD_LABELS_AR;
  return FIELD_LABELS;
}

// Alias — PDF, DOCX, and Markdown all use the same labels now (Arabic supported everywhere).
const getFieldLabelsForDoc = getFieldLabels;

// Section headers per language
const SECTION_LABELS = {
  en: {
    1: 'Section 01: Brand Foundation',
    2: 'Section 02: Visual Direction',
    3: 'Section 03: Project and Scope'
  },
  fr: {
    1: 'Section 01: Fondation de la marque',
    2: 'Section 02: Direction visuelle',
    3: 'Section 03: Projet et Cadrage'
  },
  ar: {
    1: 'القسم 01: أساس البراند',
    2: 'القسم 02: الاتجاه البصري',
    3: 'القسم 03: المشروع والنطاق'
  }
};

// Section headers used only in Markdown — identical to SECTION_LABELS (both support Arabic)
const SECTION_LABELS_MARKDOWN = SECTION_LABELS;


// UI strings for generated documents per language
const DOC_STRINGS = {
  en: {
    reportTitle:       'CLIENT INTAKE REPORT',
    preparedBy:        'Prepared by Neatmark',
    submissionDetails: 'Submission Details',
    submitted:         'Submitted:',
    clientName:        'Client Name:',
    brandBusiness:     'Brand / Business:',
    clientEmail:       'Email:',
    requestedDelivery: 'Requested Delivery:',
    country:           'Country:',
    noResponse:        'No response',
    noImages:          'No images uploaded',
    neatmarkStudio:    'Neatmark Studio',
    pageLabel:         'Page'
  },
  fr: {
    reportTitle:       'RAPPORT D\'INTEGR. CLIENT',
    preparedBy:        'Prepare par Neatmark',
    submissionDetails: 'Details de la soumission',
    submitted:         'Soumis le:',
    clientName:        'Nom du client:',
    brandBusiness:     'Marque / Entreprise:',
    clientEmail:       'Email:',
    requestedDelivery: 'Livraison demandee:',
    country:           'Pays:',
    noResponse:        'Pas de reponse',
    noImages:          'Aucune image deposee',
    neatmarkStudio:    'Neatmark Studio',
    pageLabel:         'Page'
  },
  ar: {
    reportTitle:       'تقرير استقبال العميل',
    preparedBy:        'من إعداد Neatmark',
    submissionDetails: 'تفاصيل الاستمارة',
    submitted:         'تاريخ التقديم',
    clientName:        'اسم العميل',
    brandBusiness:     'البراند / الشركة',
    clientEmail:       'البريد الإلكتروني',
    requestedDelivery: 'الإطار الزمني المطلوب',
    country:           'الدولة:',
    noResponse:        'لا توجد إجابة',
    noImages:          'لم يتم رفع صور',
    neatmarkStudio:    'Neatmark Studio',
    pageLabel:         'صفحة'
  }
};

// Markdown-only strings (Arabic renders fine in plain text)
const MARKDOWN_STRINGS = {
  en: {
    reportTitle: 'Client Intake Submission',
    submitted:   'Submitted',
    clientName:  'Client Name',
    brandName:   'Brand Name',
    noImages:    '_No images uploaded_',
    noResponse:  '_No response_'
  },
  fr: {
    reportTitle: 'Soumission d\'admission client',
    submitted:   'Soumis le',
    clientName:  'Nom du client',
    brandName:   'Nom de la marque',
    noImages:    '_Aucune image deposee_',
    noResponse:  '_Pas de reponse_'
  },
  ar: {
    reportTitle: 'استمارة استقبال العميل',
    submitted:   'تاريخ التقديم',
    clientName:  'اسم العميل',
    brandName:   'اسم البراند',
    noImages:    '_لم يتم رفع صور_',
    noResponse:  '_لا توجد إجابة_'
  }
};

// Email copy per language
const EMAIL_COPY = {
  en: {
    // Client confirmation email
    clientSubject:        (brandName) => `Received: Brand Intake for ${brandName}`,
    clientGreeting:       (clientName) => `Thank you, ${clientName}!`,
    clientIntro:          (brandName) => `We've received your brand intake submission for <strong>${brandName}</strong>. Our team will review your answers and reach out within 2 business days.`,
    clientPdfNote:        'A copy of your submission is attached to this email as a PDF for your records.',
    clientEditHeading:    'Need to make changes?',
    clientEditBody:       'You have 30 days to update your answers using the secure link below. This link is personal, so please keep it to yourself.',
    clientEditBtn:        'Edit My Submission &rarr;',
    clientPlainText:      (clientName, brandName, editLink) =>
      `Thank you, ${clientName}!\n\nWe've received your brand intake for ${brandName}.\n\nTo edit your answers (valid for 30 days):\n${editLink}\n\nWe'll be in touch within 2 business days.\n\n— The Neatmark Team`,

    // Edit confirmation email
    editSubject:          (brandName) => `Edits Received: Brand Intake for ${brandName}`,
    editGreeting:         (clientName) => `Edits received, ${clientName}!`,
    editIntro:            (brandName, editedAt) => `Your updates to the brand intake for <strong>${brandName}</strong> have been successfully received by Neatmark on <strong>${editedAt}</strong>.`,
    editBody:             'Our team has been notified and will incorporate your latest answers into the project. If you have any questions, just reply to this email.',
    editSignoff:          '— The Neatmark Team',
    editPlainText:        (clientName, brandName, editedAt) =>
      `Edits received!\n\nYour updates to the brand intake for ${brandName} have been received on ${editedAt}.\n\nOur team has been notified.\n\n— The Neatmark Team`
  },

  fr: {
    clientSubject:        (brandName) => `Recu : Formulaire de marque pour ${brandName}`,
    clientGreeting:       (clientName) => `Merci, ${clientName}\u00a0!`,
    clientIntro:          (brandName) => `Nous avons bien recu votre formulaire d'admission de marque pour <strong>${brandName}</strong>. Notre equipe examinera vos reponses et vous recontactera sous 2 jours ouvrables.`,
    clientPdfNote:        'Une copie de votre soumission est jointe a cet email en PDF pour vos archives.',
    clientEditHeading:    'Des modifications a apporter\u00a0?',
    clientEditBody:       'Vous avez 30 jours pour mettre a jour vos reponses via le lien securise ci-dessous. Ce lien est personnel, ne le partagez pas.',
    clientEditBtn:        'Modifier ma soumission &rarr;',
    clientPlainText:      (clientName, brandName, editLink) =>
      `Merci, ${clientName} !\n\nNous avons bien recu votre formulaire de marque pour ${brandName}.\n\nPour modifier vos reponses (valable 30 jours) :\n${editLink}\n\nNous vous recontacterons sous 2 jours ouvrables.\n\n— L'equipe Neatmark`,

    editSubject:          (brandName) => `Modifications recues : Formulaire de marque pour ${brandName}`,
    editGreeting:         (clientName) => `Modifications recues, ${clientName}\u00a0!`,
    editIntro:            (brandName, editedAt) => `Vos mises a jour du formulaire de marque pour <strong>${brandName}</strong> ont ete bien recues par Neatmark le <strong>${editedAt}</strong>.`,
    editBody:             'Notre equipe a ete notifiee et integrera vos dernieres reponses dans le projet. Si vous avez des questions, repondez simplement a cet email.',
    editSignoff:          '— L\'equipe Neatmark',
    editPlainText:        (clientName, brandName, editedAt) =>
      `Modifications recues !\n\nVos mises a jour du formulaire de marque pour ${brandName} ont ete recues le ${editedAt}.\n\nNotre equipe a ete notifiee.\n\n— L'equipe Neatmark`
  },

  ar: {
    clientSubject:        (brandName) => `\u062a\u0645 \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645: \u0627\u0633\u062a\u0645\u0627\u0631\u0629 \u0627\u0644\u0628\u0631\u0627\u0646\u062f \u0644\u0640 ${brandName}`,
    clientGreeting:       (clientName) => `\u0634\u0643\u0631\u0627\u064b \u0644\u0643\u060c ${clientName}!`,
    clientIntro:          (brandName) => `\u0644\u0642\u062f \u0627\u0633\u062a\u0644\u0645\u0646\u0627 \u0627\u0633\u062a\u0645\u0627\u0631\u0629 \u0627\u0644\u0628\u0631\u0627\u0646\u062f \u0627\u0644\u062e\u0627\u0635\u0629 \u0628\u0640 <strong>${brandName}</strong>. \u0633\u064a\u0631\u0627\u062c\u0639 \u0641\u0631\u064a\u0642\u0646\u0627 \u0625\u062c\u0627\u0628\u0627\u062a\u0643 \u0648\u0633\u064a\u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0643 \u062e\u0644\u0627\u0644 \u064a\u0648\u0645\u064a \u0639\u0645\u0644.`,
    clientPdfNote:        '\u0646\u0633\u062e\u0629 \u0645\u0646 \u0627\u0633\u062a\u0645\u0627\u0631\u062a\u0643 \u0645\u0631\u0641\u0642\u0629 \u0628\u0647\u0630\u0627 \u0627\u0644\u0628\u0631\u064a\u062f \u0643\u0645\u0644\u0641 PDF \u0644\u0644\u0631\u062c\u0648\u0639 \u0625\u0644\u064a\u0647\u0627.',
    clientEditHeading:    '\u0647\u0644 \u062a\u0631\u064a\u062f \u0625\u062c\u0631\u0627\u0621 \u062a\u0639\u062f\u064a\u0644\u0627\u062a\u061f',
    clientEditBody:       '\u0644\u062f\u064a\u0643 30 \u064a\u0648\u0645\u0627\u064b \u0644\u062a\u062d\u062f\u064a\u062b \u0625\u062c\u0627\u0628\u0627\u062a\u0643 \u0639\u0628\u0631 \u0627\u0644\u0631\u0627\u0628\u0637 \u0627\u0644\u0622\u0645\u0646 \u0623\u062f\u0646\u0627\u0647. \u0647\u0630\u0627 \u0627\u0644\u0631\u0627\u0628\u0637 \u0634\u062e\u0635\u064a\u060c \u0644\u0627 \u062a\u0634\u0627\u0631\u0643\u0647 \u0645\u0639 \u0623\u062d\u062f.',
    clientEditBtn:        '\u062a\u0639\u062f\u064a\u0644 \u0627\u0633\u062a\u0645\u0627\u0631\u062a\u064a \u2192',
    clientPlainText:      (clientName, brandName, editLink) =>
      `\u0634\u0643\u0631\u0627\u064b \u0644\u0643\u060c ${clientName}!\n\n\u0644\u0642\u062f \u0627\u0633\u062a\u0644\u0645\u0646\u0627 \u0627\u0633\u062a\u0645\u0627\u0631\u0629 \u0627\u0644\u0628\u0631\u0627\u0646\u062f \u0644\u0640 ${brandName}.\n\n\u0644\u062a\u0639\u062f\u064a\u0644 \u0625\u062c\u0627\u0628\u0627\u062a\u0643 (\u0635\u0627\u0644\u062d \u0644\u0645\u062f\u0629 30 \u064a\u0648\u0645\u0627\u064b):\n${editLink}\n\n\u0633\u0646\u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0643 \u062e\u0644\u0627\u0644 \u064a\u0648\u0645\u064a \u0639\u0645\u0644.\n\n\u2014 \u0641\u0631\u064a\u0642 Neatmark`,

    editSubject:          (brandName) => `\u062a\u0645 \u0627\u0633\u062a\u0644\u0627\u0645 \u0627\u0644\u062a\u0639\u062f\u064a\u0644\u0627\u062a: \u0627\u0633\u062a\u0645\u0627\u0631\u0629 \u0627\u0644\u0628\u0631\u0627\u0646\u062f \u0644\u0640 ${brandName}`,
    editGreeting:         (clientName) => `\u062a\u0645 \u0627\u0633\u062a\u0644\u0627\u0645 \u0627\u0644\u062a\u0639\u062f\u064a\u0644\u0627\u062a\u060c ${clientName}!`,
    editIntro:            (brandName, editedAt) => `\u062a\u0645 \u0627\u0633\u062a\u0644\u0627\u0645 \u062a\u062d\u062f\u064a\u062b\u0627\u062a\u0643 \u0639\u0644\u0649 \u0627\u0633\u062a\u0645\u0627\u0631\u0629 \u0627\u0644\u0628\u0631\u0627\u0646\u062f \u0644\u0640 <strong>${brandName}</strong> \u0628\u0646\u062c\u0627\u062d \u0645\u0646 \u0642\u0650\u0628\u064e\u0644 Neatmark \u0641\u064a <strong>${editedAt}</strong>.`,
    editBody:             '\u062a\u0645 \u0625\u0634\u0639\u0627\u0631 \u0641\u0631\u064a\u0642\u0646\u0627 \u0648\u0633\u064a\u0623\u062e\u0630 \u0625\u062c\u0627\u0628\u0627\u062a\u0643 \u0627\u0644\u0623\u062e\u064a\u0631\u0629 \u0628\u0639\u064a\u0646 \u0627\u0644\u0627\u0639\u062a\u0628\u0627\u0631 \u0641\u064a \u0627\u0644\u0645\u0634\u0631\u0648\u0639. \u0625\u0630\u0627 \u0643\u0627\u0646 \u0644\u062f\u064a\u0643 \u0623\u064a \u0633\u0624\u0627\u0644\u060c \u0631\u062f \u0639\u0644\u0649 \u0647\u0630\u0627 \u0627\u0644\u0628\u0631\u064a\u062f.',
    editSignoff:          '\u2014 \u0641\u0631\u064a\u0642 Neatmark',
    editPlainText:        (clientName, brandName, editedAt) =>
      `\u062a\u0645 \u0627\u0633\u062a\u0644\u0627\u0645 \u0627\u0644\u062a\u0639\u062f\u064a\u0644\u0627\u062a!\n\n\u062a\u0645 \u0627\u0633\u062a\u0644\u0627\u0645 \u062a\u062d\u062f\u064a\u062b\u0627\u062a\u0643 \u0644\u0640 ${brandName} \u0641\u064a ${editedAt}.\n\n\u062a\u0645 \u0625\u0634\u0639\u0627\u0631 \u0641\u0631\u064a\u0642\u0646\u0627.\n\n\u2014 \u0641\u0631\u064a\u0642 Neatmark`
  }
};

/* ─────────────────────────────────────────────────────────────────────────────
   Arabic text reshaper + RTL font loader
   pdf-lib ships only Latin-1 fonts. To render Arabic properly we need to:
   1. Load the Norsal font from the local assets/ directory
   2. Reshape Arabic characters to their correct contextual forms
      (isolated / initial / medial / final) so letters connect properly
   3. Reverse the shaped string so pdf-lib's LTR engine displays it right-to-left
───────────────────────────────────────────────────────────────────────────── */

// Module-level font cache — loaded once per warm Lambda instance
let _norsalFontBytes = null;

function loadNorsalFont() {
  if (_norsalFontBytes) return _norsalFontBytes;

  // Try multiple paths because __dirname shifts when esbuild bundles the function.
  // process.cwd() is /var/task on Lambda, which is where Netlify places included_files.
  const candidates = [
    path.join(process.cwd(), 'assets/Norsal.ttf'),
    path.join(__dirname, 'assets/Norsal.ttf'),
    path.join(__dirname, '../../assets/Norsal.ttf'),
    path.join(__dirname, '../assets/Norsal.ttf')
  ];

  for (const candidate of candidates) {
    try {
      _norsalFontBytes = new Uint8Array(fs.readFileSync(candidate));
      return _norsalFontBytes;
    } catch (_) { /* try next path */ }
  }

  throw new Error(
    'Norsal.ttf not found. Make sure assets/Norsal.ttf exists and ' +
    'included_files = ["assets/Norsal.ttf"] is set in netlify.toml under [functions].'
  );
}

// Arabic character shaping table
// Each entry: [codepoint, isolatedCP, finalCP, initialCP, medialCP, joinsLeft]
// joinsLeft = true means dual-joining (can connect to next char)
// joinsLeft = false means right-joining only (only connects to previous char)
const ARABIC_SHAPING_TABLE = new Map([
  [0x0621, [null,   null,   null,   null,   false]], // ء hamza
  [0x0622, [null,   0xFE82, null,   null,   false]], // آ
  [0x0623, [null,   0xFE84, null,   null,   false]], // أ
  [0x0624, [null,   0xFE86, null,   null,   false]], // ؤ
  [0x0625, [null,   0xFE88, null,   null,   false]], // إ
  [0x0626, [null,   0xFE8A, 0xFE8B, 0xFE8C, true]],  // ئ
  [0x0627, [null,   0xFE8E, null,   null,   false]], // ا
  [0x0628, [null,   0xFE90, 0xFE91, 0xFE92, true]],  // ب
  [0x0629, [null,   0xFE94, null,   null,   false]], // ة
  [0x062A, [null,   0xFE96, 0xFE97, 0xFE98, true]],  // ت
  [0x062B, [null,   0xFE9A, 0xFE9B, 0xFE9C, true]],  // ث
  [0x062C, [null,   0xFE9E, 0xFE9F, 0xFEA0, true]],  // ج
  [0x062D, [null,   0xFEA2, 0xFEA3, 0xFEA4, true]],  // ح
  [0x062E, [null,   0xFEA6, 0xFEA7, 0xFEA8, true]],  // خ
  [0x062F, [null,   0xFEAA, null,   null,   false]], // د
  [0x0630, [null,   0xFEAC, null,   null,   false]], // ذ
  [0x0631, [null,   0xFEAE, null,   null,   false]], // ر
  [0x0632, [null,   0xFEB0, null,   null,   false]], // ز
  [0x0633, [null,   0xFEB2, 0xFEB3, 0xFEB4, true]],  // س
  [0x0634, [null,   0xFEB6, 0xFEB7, 0xFEB8, true]],  // ش
  [0x0635, [null,   0xFEBA, 0xFEBB, 0xFEBC, true]],  // ص
  [0x0636, [null,   0xFEBE, 0xFEBF, 0xFEC0, true]],  // ض
  [0x0637, [null,   0xFEC2, 0xFEC3, 0xFEC4, true]],  // ط
  [0x0638, [null,   0xFEC6, 0xFEC7, 0xFEC8, true]],  // ظ
  [0x0639, [null,   0xFECA, 0xFECB, 0xFECC, true]],  // ع
  [0x063A, [null,   0xFECE, 0xFECF, 0xFED0, true]],  // غ
  [0x0640, [0x0640, 0x0640, 0x0640, 0x0640, true]],  // ـ tatweel
  [0x0641, [null,   0xFED2, 0xFED3, 0xFED4, true]],  // ف
  [0x0642, [null,   0xFED6, 0xFED7, 0xFED8, true]],  // ق
  [0x0643, [null,   0xFEDA, 0xFEDB, 0xFEDC, true]],  // ك
  [0x0644, [null,   0xFEDE, 0xFEDF, 0xFEE0, true]],  // ل
  [0x0645, [null,   0xFEE2, 0xFEE3, 0xFEE4, true]],  // م
  [0x0646, [null,   0xFEE6, 0xFEE7, 0xFEE8, true]],  // ن
  [0x0647, [0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC, true]],  // ه
  [0x0648, [null,   0xFEEE, null,   null,   false]], // و
  [0x0649, [null,   0xFEF0, null,   null,   false]], // ى
  [0x064A, [null,   0xFEF2, 0xFEF3, 0xFEF4, true]],  // ي
  // Extended Arabic (Urdu / Persian / Pashto common letters)
  [0x0671, [0xFB50, 0xFB51, null,   null,   false]], // ٱ alef wasla
  [0x067E, [0xFB56, 0xFB57, 0xFB58, 0xFB59, true]],  // پ peh
  [0x0686, [0xFB7A, 0xFB7B, 0xFB7C, 0xFB7D, true]],  // چ cheh
  [0x0698, [0xFB8A, 0xFB8B, null,   null,   false]], // ژ jeh
  [0x06A9, [0xFB8E, 0xFB8F, 0xFB90, 0xFB91, true]],  // ک keheh
  [0x06AF, [0xFB92, 0xFB93, 0xFB94, 0xFB95, true]],  // گ gaf
  [0x06CC, [0xFBFC, 0xFBFD, 0xFBFE, 0xFBFF, true]],  // ی farsi yeh
  [0x06D2, [0xFBAE, 0xFBAF, null,   null,   false]], // ے yeh barree
]);

// Tashkeel (diacritics): transparent characters that don't affect letter joining
const ARABIC_TASHKEEL = new Set([
  0x0610,0x0611,0x0612,0x0613,0x0614,0x0615,0x0616,0x0617,0x0618,0x0619,0x061A,
  0x064B,0x064C,0x064D,0x064E,0x064F,0x0650,0x0651,0x0652,0x0653,0x0654,0x0655,
  0x0656,0x0657,0x0658,0x0659,0x065A,0x065B,0x065C,0x065D,0x065E,0x065F,
  0x0670
]);

// Lam-alef mandatory ligatures: [initial-lam + alef-form] → ligature codepoint
// FEDF = initial lam, FEE0 = medial lam
const LAM_ALEF_MAP = [
  [String.fromCodePoint(0xFEDF, 0xFE8D), String.fromCodePoint(0xFEFB)], // لا isolated
  [String.fromCodePoint(0xFEDF, 0xFE8E), String.fromCodePoint(0xFEFC)], // لا final
  [String.fromCodePoint(0xFEDF, 0xFE82), String.fromCodePoint(0xFEF5)], // لآ
  [String.fromCodePoint(0xFEDF, 0xFE84), String.fromCodePoint(0xFEF7)], // لأ
  [String.fromCodePoint(0xFEDF, 0xFE88), String.fromCodePoint(0xFEF9)], // لإ
  [String.fromCodePoint(0xFEE0, 0xFE8D), String.fromCodePoint(0xFEFC)], // لا (medial lam)
  [String.fromCodePoint(0xFEE0, 0xFE82), String.fromCodePoint(0xFEF6)],
  [String.fromCodePoint(0xFEE0, 0xFE84), String.fromCodePoint(0xFEF8)],
  [String.fromCodePoint(0xFEE0, 0xFE88), String.fromCodePoint(0xFEFA)],
];

/**
 * Reshapes Arabic text and reverses it for LTR rendering in pdf-lib.
 *
 * How it works:
 * 1. Each Arabic letter is mapped to its contextual form (initial/medial/final/isolated)
 *    based on whether its neighbors join.
 * 2. Lam-alef ligatures are applied (the mandatory ل + ا → لا merge).
 * 3. The string is split into Arabic-script and non-Arabic tokens, each Arabic token's
 *    characters are reversed, then the token order is reversed. This converts the logical
 *    RTL string into display-order LTR so pdf-lib can draw it left-to-right correctly.
 */
function reshapeArabicText(text) {
  if (!text) return '';
  const chars = [...String(text)];
  const n = chars.length;
  const shaped = new Array(n);

  for (let i = 0; i < n; i++) {
    const cp = chars[i].codePointAt(0);
    const entry = ARABIC_SHAPING_TABLE.get(cp);

    if (!entry) {
      shaped[i] = chars[i];
      continue;
    }

    const [iso, fin, ini, med, joinsLeft] = entry;

    // Find the nearest previous non-tashkeel char and whether it joins left
    let prevJoinsLeft = false;
    for (let j = i - 1; j >= 0; j--) {
      const pcp = chars[j].codePointAt(0);
      if (ARABIC_TASHKEEL.has(pcp)) continue;
      const pe = ARABIC_SHAPING_TABLE.get(pcp);
      if (pe) prevJoinsLeft = pe[4];
      break;
    }

    // Find whether the nearest next non-tashkeel char is Arabic
    let nextIsArabic = false;
    for (let j = i + 1; j < n; j++) {
      const ncp = chars[j].codePointAt(0);
      if (ARABIC_TASHKEEL.has(ncp)) continue;
      if (ARABIC_SHAPING_TABLE.has(ncp)) nextIsArabic = true;
      break;
    }

    const fromRight = prevJoinsLeft;
    const toLeft    = joinsLeft && nextIsArabic;

    let formCP;
    if (fromRight && toLeft)       formCP = med ?? fin ?? iso;
    else if (fromRight && !toLeft) formCP = fin ?? iso;
    else if (!fromRight && toLeft) formCP = ini ?? iso;
    else                           formCP = iso;

    shaped[i] = formCP != null ? String.fromCodePoint(formCP) : chars[i];
  }

  // Apply mandatory lam-alef ligatures
  let result = shaped.join('');
  for (const [pair, lig] of LAM_ALEF_MAP) {
    result = result.split(pair).join(lig);
  }

  // Split into tokens (Arabic run vs non-Arabic run), reverse each Arabic token's
  // characters, then reverse the token order — converting RTL to LTR display order
  const tokens = [];
  let cur = '';
  let curIsAr = false;

  for (const ch of result) {
    const cp   = ch.codePointAt(0);
    const isAr = (cp >= 0x0600 && cp <= 0x06FF)
              || (cp >= 0xFB50 && cp <= 0xFDFF)
              || (cp >= 0xFE70 && cp <= 0xFEFF);
    const isSp = ch === ' ' || ch === '\t' || ch === '\n';

    if (isSp) {
      if (cur) { tokens.push({ t: cur, ar: curIsAr }); cur = ''; curIsAr = false; }
      tokens.push({ t: ch, ar: false });
    } else if (isAr !== curIsAr && cur) {
      tokens.push({ t: cur, ar: curIsAr });
      cur = ch; curIsAr = isAr;
    } else {
      cur += ch; curIsAr = isAr;
    }
  }
  if (cur) tokens.push({ t: cur, ar: curIsAr });

  const processed = tokens.map(tok => ({
    t: tok.ar ? [...tok.t].reverse().join('') : tok.t
  }));
  processed.reverse();

  return processed.map(t => t.t).join('');
}


/* ─────────────────────────────────────────────────────────────────────────────
   Option value translations
   Checkboxes, radios, and selects store English keys in the database.
   These maps let the document generators show the correct translated label.
───────────────────────────────────────────────────────────────────────────── */

const OPTION_TRANSLATIONS = {
  // q9-color
  'Warm neutrals':     { fr: 'Neutres chauds (crème, sable, terre cuite)',          ar: 'محايدات دافئة (كريمي، رملي، تيراكوتا)' },
  'Cool neutrals':     { fr: 'Neutres froids (ardoise, pierre, brume)',              ar: 'محايدات باردة (أردوازي، حجري، ضبابي)' },
  'Deep & moody':      { fr: 'Profond & intense (marine, forêt, bordeaux)',          ar: 'داكن وعميق (كحلي، أخضر غابي، خمري)' },
  'Bold & saturated':  { fr: 'Vif & saturé (primaires vibrantes)',                   ar: 'جريء ومشبع (ألوان أساسية زاهية)' },
  'Pastels':           { fr: 'Pastels & tons doux',                                  ar: 'باستيل ودرجات ناعمة' },
  'Monochrome':        { fr: 'Noir & blanc / monochrome',                            ar: 'أبيض وأسود / أحادي اللون' },
  'Metallic':          { fr: 'Métallique / tons luxe (or, bronze)',                  ar: 'معدني / درجات فاخرة (ذهبي، برونزي)' },
  'Nature-inspired':   { fr: 'Inspiré de la nature (mousse, rouille, argile)',       ar: 'مستوحى من الطبيعة (طحلبي، صدئي، طيني)' },
  'No preference':     { fr: "Pas de préférence, je fais confiance à votre jugement", ar: 'لا تفضيل، أثق في حكمك' },

  // q11-aesthetic
  'Luxury & refined':          { fr: 'Luxe & raffiné',                   ar: 'فاخر وراقي' },
  'Organic & artisan':         { fr: 'Organique & artisanal',             ar: 'عضوي وحرفي' },
  'Minimal & functional':      { fr: 'Minimal & fonctionnel',             ar: 'بسيط وعملي' },
  'Bold & graphic':             { fr: 'Audacieux & graphique',             ar: 'جريء ورسومي' },
  'Playful & illustrative':    { fr: 'Ludique & illustratif',              ar: 'مرح وتوضيحي' },
  'Editorial & intellectual':  { fr: 'Éditorial & intellectuel',           ar: 'تحريري وفكري' },
  'Tech-forward':              { fr: 'Tourné vers la tech & innovant',     ar: 'تقني ومتجدد' },
  'Nostalgic & heritage':      { fr: 'Nostalgique & patrimonial',          ar: 'حنيني وتراثي' },

  // q13-deliverables
  'Primary logo':       { fr: 'Logo principal',                                          ar: 'الشعار الرئيسي' },
  'Logo variations':    { fr: 'Variantes de logo & sous-marques',                        ar: 'تنويعات الشعار والعلامات الفرعية' },
  'Color & typography': { fr: 'Palette de couleurs & système typographique',             ar: 'لوحة الألوان ونظام الخطوط' },
  'Brand guidelines':   { fr: 'Document de directives de marque',                        ar: 'وثيقة إرشادات العلامة التجارية' },
  'Stationery':         { fr: 'Cartes de visite & papeterie',                            ar: 'بطاقات عمل وقرطاسية' },
  'Social media':       { fr: 'Modèles réseaux sociaux',                                 ar: 'قوالب وسائل التواصل' },
  'Website design':     { fr: 'Design de site web',                                      ar: 'تصميم موقع ويب' },
  'Packaging':          { fr: 'Design packaging',                                        ar: 'تصميم التغليف' },

  // q7-decision-maker
  'Me / myself':            { fr: 'Moi / moi-même',           ar: 'أنا / بنفسي' },
  'My boss / the boss':     { fr: 'Mon patron / le patron',   ar: 'مديري / صاحب العمل' },
  'Other':                  { fr: 'Autre',                    ar: 'آخر' },

  // q14-budget
  'Low / lowest possible cost':            { fr: 'Faible / coût le plus bas possible',                              ar: 'منخفضة / أقل تكلفة ممكنة' },
  'Mid-range / balanced price\u2013quality': { fr: 'Moyen / équilibre prix-qualité',                                 ar: 'متوسطة / توازن بين السعر والجودة' },
  'High / premium':                        { fr: 'Élevé / premium',                                                 ar: 'مرتفعة / مميزة' },
  'Premium / full brand investment':       { fr: 'Premium / investissement complet en identité (3 000 €+)',          ar: 'بريميوم / استثمار كامل في هوية البراند (+3,000 €)' },

  // delivery-date (shown in the metadata card)
  'ASAP':        { fr: 'Dès que possible',  ar: 'في أقرب وقت ممكن' },
  '2\u20134 weeks':  { fr: '2–4 semaines',     ar: '2–4 أسابيع' },
  '1\u20132 months': { fr: '1–2 mois',          ar: '1–2 أشهر' },
  '3+ months':   { fr: '3 mois et plus',    ar: 'أكثر من 3 أشهر' }
};

/**
 * Returns the translated label for a stored option value.
 * Falls back to the original English value when no translation is found.
 */
function getOptionLabel(value, lang) {
  if (!value || !lang || lang === 'en') return String(value ?? '');
  const entry = OPTION_TRANSLATIONS[String(value).trim()];
  return (entry && entry[lang]) || String(value);
}

/**
 * Like normalizeValue, but runs each item through getOptionLabel first
 * so that stored English option keys are shown in the document language.
 */
function normalizeValueForDoc(value, lang) {
  if (Array.isArray(value)) {
    return value.filter(Boolean)
      .map(item => getOptionLabel(String(item).trim(), lang))
      .join(', ')
      .slice(0, MAX_FIELD_VALUE_LENGTH);
  }
  if (value === undefined || value === null) return '';
  return getOptionLabel(String(value).trim().slice(0, MAX_FIELD_VALUE_LENGTH), lang);
}


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
    .replace(/^q(\d+)-/, 'Q$1: ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
}

// Explicit display order for all fields — used by sortedEntries and getSectionLabel
const FIELD_DISPLAY_ORDER = {
  'client-name': -4,
  'brand-name': -3,
  'email': -2,
  'client-website': -1,
  'q1-business-description': 1,
  'q2-problem-transformation': 2,
  'q3-ideal-customer': 3,
  'q3b-customer-desire': 4,
  'q4-competitors': 5,
  'q5-brand-personality': 6,
  'q6-positioning': 7,
  'q-launch-context': 8,
  'q8-brands-admired': 9,
  'q9-color': 10,
  'q10-colors-to-avoid': 11,
  'q11-aesthetic': 12,
  'q11-aesthetic-description': 12.5,
  'q13-deliverables': 13,
  'q14-budget': 14,
  'q15-inspiration-refs': 15,
  'q7-decision-maker': 16,
  'q7-decision-maker-other': 16.5,
  'q12-existing-assets': 17,
  'delivery-date': 18,
  'q16-anything-else': 19,
};

function sortedEntries(payload) {
  return Object.entries(payload).sort(([a], [b]) => {
    const aOrder = FIELD_DISPLAY_ORDER[a] ?? 999;
    const bOrder = FIELD_DISPLAY_ORDER[b] ?? 999;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.localeCompare(b);
  });
}

function extractQuestionNumber(key) {
  const order = FIELD_DISPLAY_ORDER[key];
  if (order == null || order < 1) return null;
  return Math.floor(order);
}

function getSectionLabel(questionNumber, lang, forMarkdown) {
  if (!questionNumber) return null;
  const labels = forMarkdown
    ? (SECTION_LABELS_MARKDOWN[lang] || SECTION_LABELS_MARKDOWN.en)
    : (SECTION_LABELS[lang] || SECTION_LABELS.en);
  if (questionNumber >= 1  && questionNumber <= 8)  return labels[1];
  if (questionNumber >= 9  && questionNumber <= 15) return labels[2];
  if (questionNumber >= 16 && questionNumber <= 19) return labels[3];
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

function buildMarkdown(payload, lang = 'en') {
  const now         = new Date();
  const clientName  = normalizeValue(payload['client-name']) || 'Unknown Client';
  const brandName   = normalizeValue(payload['brand-name'])  || 'Unknown Brand';
  const s           = MARKDOWN_STRINGS[lang] || MARKDOWN_STRINGS.en;
  const fieldLabels = getFieldLabels(lang);

  const lines = [
    `# ${s.reportTitle}`, '',
    `- **${s.submitted}:** ${formatHumanDate(now)}`,
    `- **${s.clientName}:** ${clientName}`,
    `- **${s.brandName}:** ${brandName}`,
    '', '---', ''
  ];

  const clientCountry = normalizeValue(payload['client-country']);
  if (clientCountry) lines.push(`- **Country:** ${clientCountry}`);
  lines.push('', '---', '');

  for (const [key, rawValue] of sortedEntries(payload)) {
    if (SYSTEM_FIELDS.has(key) || key === 'client-country') continue;
    const label = fieldLabels[key] || prettifyKey(key);
    lines.push(`## ${label}`, '');

    if (key === 'q15-inspiration-refs') {
      const refs = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
      if (refs.length > 0) {
        refs.forEach((ref, i) => lines.push(`- Inspiration ${i + 1}: ${getPhotoFilename(ref)}`));
      } else {
        lines.push(s.noImages);
      }
    } else {
      lines.push(normalizeValueForDoc(rawValue, lang) || s.noResponse);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/* ─────────────────────────────────────────────────────────────────────────────
   DOCX
───────────────────────────────────────────────────────────────────────────── */

async function buildDocxBuffer(payload, imageBuffers = {}, lang = 'en') {
  const now          = new Date();
  const clientName   = normalizeValue(payload['client-name']) || 'Unknown Client';
  const brandName    = normalizeValue(payload['brand-name'])  || 'Unknown Brand';
  const clientEmail  = normalizeValue(payload.email)          || 'Not provided';
  const deliveryDate = normalizeValue(payload['delivery-date']) || 'Not provided';
  const s            = DOC_STRINGS[lang] || DOC_STRINGS.en;
  const fieldLabels  = getFieldLabelsForDoc(lang);
  const isRtl        = (lang === 'ar');

  const children = [
    new Paragraph({
      text: s.reportTitle,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      bidirectional: isRtl,
      spacing: { before: 200, after: 140 }
    }),
    new Paragraph({
      children: [new TextRun({ text: s.preparedBy, italics: true, color: '666666' })],
      alignment: AlignmentType.CENTER,
      bidirectional: isRtl,
      spacing: { after: 260 }
    }),
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '006D77' } },
      spacing: { after: 260 }
    }),
    new Paragraph({
      children: [new TextRun({ text: s.submissionDetails, bold: true, allCaps: true, color: '006D77' })],
      bidirectional: isRtl,
      alignment: isRtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { after: 120 }
    }),
    ...(([
      [s.submitted,         formatHumanDate(now)],
      [s.clientName,        clientName],
      [s.brandBusiness,     brandName],
      [s.clientEmail,       clientEmail],
      [s.requestedDelivery, getOptionLabel(deliveryDate, lang)],
      ...(normalizeValue(payload['client-country'])
        ? [[s.country || 'Country:', normalizeValue(payload['client-country'])]]
        : [])
    ]).map(([label, value]) => new Paragraph({
      children: [new TextRun({ text: label + '  ', bold: true }), new TextRun({ text: value })],
      bidirectional: isRtl,
      alignment: isRtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { after: 80 }
    })))
  ];

  let currentSection = null;
  for (const [key, rawValue] of sortedEntries(payload)) {
    if (['client-name', 'brand-name', 'email', 'delivery-date', 'client-country'].includes(key)) continue;
    if (SYSTEM_FIELDS.has(key)) continue;

    const label          = fieldLabels[key] || prettifyKey(key);
    const questionNumber = extractQuestionNumber(key);
    const sectionLabel   = getSectionLabel(questionNumber, lang, false);

    if (sectionLabel && sectionLabel !== currentSection) {
      currentSection = sectionLabel;
      children.push(new Paragraph({
        text: sectionLabel, heading: HeadingLevel.HEADING_1,
        bidirectional: isRtl,
        alignment: isRtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
        spacing: { before: 260, after: 130 }
      }));
    }

    children.push(new Paragraph({
      children: [new TextRun({ text: label, bold: true, color: '1F1F1F' })],
      bidirectional: isRtl,
      alignment: isRtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
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
          children: [new TextRun({ text: s.noImages, italics: true, color: '888888' })],
          bidirectional: isRtl,
          alignment: isRtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
          spacing: { after: 110 }
        }));
      }
    } else {
      const value = normalizeValueForDoc(rawValue, lang) || s.noResponse;
      children.push(new Paragraph({
        children: [new TextRun({ text: value })],
        bidirectional: isRtl,
        alignment: isRtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
        spacing: { after: 110 }
      }));
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
      properties: {
        page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } },
        bidi: isRtl
      },
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

async function _buildPdfBufferLatin(payload, imageBuffers = {}, lang = 'en') {
  const s          = DOC_STRINGS[lang] || DOC_STRINGS.en;
  const fieldLabels = getFieldLabelsForDoc(lang);
  const isRtl      = (lang === 'ar');

  const pdfDoc = await PDFDocument.create();

  // ── Font setup ────────────────────────────────────────────────────────────
  let regularFont, boldFont;
  let arabicFontAvailable = false;

  if (isRtl && fontkit) {
    try {
      pdfDoc.registerFontkit(fontkit);
      const norsalBytes = loadNorsalFont();
      regularFont = await pdfDoc.embedFont(norsalBytes, { subset: false });
      boldFont    = regularFont; // Norsal is a single-weight font
      arabicFontAvailable = true;
    } catch (fontErr) {
      console.warn('[PDF] Norsal font unavailable, falling back to Helvetica:', fontErr.message);
      regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
      boldFont    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    }
  } else {
    regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    boldFont    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }

  const PAGE_W  = 595;
  const PAGE_H  = 842;
  const MARGIN  = 48;
  const COL_W   = PAGE_W - MARGIN * 2;
  const RIGHT   = MARGIN + COL_W;

  // ── Text preparation ──────────────────────────────────────────────────────
  // For Latin: strip non-Latin-1 chars. For Arabic: reshape + reverse for LTR.
  const REPLACEMENTS = { '\u2194': '<->', '\u2190': '<-', '\u2192': '->', '\u2022': '-', '\u00A0': ' ' };
  function sanitizeLatin(text) {
    let safe = '';
    for (const ch of String(text ?? '')) {
      const rep = REPLACEMENTS[ch] ?? ch;
      try { regularFont.encodeText(rep); safe += rep; } catch { safe += '?'; }
    }
    return safe;
  }

  function prepText(text) {
    if (isRtl && arabicFontAvailable) return reshapeArabicText(String(text ?? ''));
    return sanitizeLatin(text);
  }

  // ── Word-wrap ─────────────────────────────────────────────────────────────
  function wrapText(text, font, size, maxW) {
    const src   = prepText(text);
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

  // x-position for right-aligned RTL text
  function rtlX(text, font, size, rightEdge = RIGHT) {
    return rightEdge - font.widthOfTextAtSize(text, size);
  }

  // x-position that respects RTL/LTR + optional indent
  function textX(text, font, size, indent = 0) {
    if (isRtl) return rtlX(text, font, size) - indent;
    return MARGIN + indent;
  }

  // ── Page & cursor state ───────────────────────────────────────────────────
  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y    = PAGE_H - MARGIN;
  let pageNum = 1;

  const HEADER_H    = 56;
  const FOOTER_H    = 32;
  const CONTENT_TOP = PAGE_H - HEADER_H;
  const CONTENT_BOT = FOOTER_H;

  function drawPageDecor(p, num) {
    p.drawRectangle({ x: 0, y: PAGE_H - HEADER_H, width: PAGE_W, height: HEADER_H, color: BRAND_TEAL });

    const title     = prepText(s.reportTitle);
    const titleSize = 14;
    const titleX    = isRtl
      ? rtlX(title, boldFont, titleSize, RIGHT - 4)
      : MARGIN;
    p.drawText(title, { x: titleX, y: PAGE_H - HEADER_H + 20, size: titleSize, font: boldFont, color: WHITE });

    // Studio name always in Latin (brand name)
    const studio = 'Neatmark Studio';
    p.drawText(studio, {
      x: isRtl ? MARGIN : RIGHT - boldFont.widthOfTextAtSize(studio, 10),
      y: PAGE_H - HEADER_H + 22,
      size: 10, font: boldFont, color: rgb(0.8, 1, 0.97)
    });

    p.drawLine({
      start: { x: MARGIN, y: FOOTER_H + 12 },
      end:   { x: RIGHT,  y: FOOTER_H + 12 },
      thickness: 0.5, color: GRAY_LIGHT
    });
    const pageLabel = `${s.pageLabel} ${num}`;
    p.drawText(pageLabel, {
      x: PAGE_W / 2 - boldFont.widthOfTextAtSize(pageLabel, 8) / 2,
      y: FOOTER_H - 4,
      size: 8, font: regularFont, color: GRAY_TEXT
    });
  }

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
    const t = prepText(text);
    page.drawText(t, { x: textX(t, font, size, indent), y, size, font, color });
    y -= size + 5;
  }

  function drawWrapped(text, { size = 10, font = regularFont, color = GRAY_TEXT, indent = 0, lineGap = 4 } = {}) {
    const lines = wrapText(text, font, size, COL_W - indent);
    for (const line of lines) {
      ensureSpace(size + lineGap);
      page.drawText(line, { x: textX(line, font, size, indent), y, size, font, color });
      y -= size + lineGap;
    }
  }

  function spacer(h = 8) { ensureSpace(h); y -= h; }

  // ── Metadata card ─────────────────────────────────────────────────────────
  const now          = new Date();
  const clientName   = normalizeValue(payload['client-name'])    || (isRtl ? '\u063a\u064a\u0631 \u0645\u062d\u062f\u062f' : 'Unknown Client');
  const brandName    = normalizeValue(payload['brand-name'])     || (isRtl ? '\u063a\u064a\u0631 \u0645\u062d\u062f\u062f' : 'Unknown Brand');
  const clientEmail  = normalizeValue(payload.email)             || (isRtl ? '\u063a\u064a\u0631 \u0645\u062a\u0648\u0641\u0631' : 'Not provided');
  const deliveryDate = normalizeValue(payload['delivery-date'])  || (isRtl ? '\u063a\u064a\u0631 \u0645\u062d\u062f\u062f' : 'Not provided');
  const clientCountry = normalizeValue(payload['client-country']) || '';
  const submittedAt  = formatHumanDate(now);

  drawPageDecor(page, pageNum);
  y = CONTENT_TOP - 24;

  const deliveryDateLabel = getOptionLabel(deliveryDate, lang) || deliveryDate;

  const metaRows = [
    [s.brandBusiness,     brandName],
    [s.clientName,        clientName],
    [s.clientEmail,       clientEmail],
    [s.requestedDelivery, deliveryDateLabel],
    ...(clientCountry ? [[s.country || 'Country:', clientCountry]] : []),
    [s.submitted,         submittedAt]
  ];

  const CARD_H = 17 * metaRows.length + 20;
  ensureSpace(CARD_H + 16);
  page.drawRectangle({ x: MARGIN, y: y - CARD_H, width: COL_W, height: CARD_H, color: ACCENT_LIGHT });

  // Accent bar: right side for Arabic, left side for Latin
  if (isRtl) {
    page.drawRectangle({ x: RIGHT - 4, y: y - CARD_H, width: 4, height: CARD_H, color: BRAND_TEAL });
  } else {
    page.drawRectangle({ x: MARGIN, y: y - CARD_H, width: 4, height: CARD_H, color: BRAND_TEAL });
  }

  const cardY = y - 16;
  metaRows.forEach(([label, value], i) => {
    const rowY = cardY - i * 17;

    // Label
    const labelText = prepText(label);
    const labelX    = isRtl
      ? rtlX(labelText, boldFont, 9, RIGHT - 12)
      : MARGIN + 12;
    page.drawText(labelText, { x: labelX, y: rowY, size: 9, font: boldFont, color: BRAND_DARK });

    // Value: email and date are always Latin; other values go through prepText
    const isLatinOnly = label === s.clientEmail || label === s.submitted;
    const valRaw  = isLatinOnly ? sanitizeLatin(value) : prepText(value);
    const valLines = wrapText(value, regularFont, 9, COL_W - 140);
    const valText  = valLines[0] || '';

    const valueX = isRtl
      ? MARGIN + 12
      : MARGIN + 110;
    page.drawText(isRtl ? prepText(valText) : sanitizeLatin(valText), {
      x: valueX, y: rowY, size: 9, font: regularFont, color: GRAY_TEXT
    });
  });
  y -= CARD_H + 20;

  // ── Section divider ───────────────────────────────────────────────────────
  function drawSectionHeader(title) {
    spacer(12);
    ensureSpace(30);
    page.drawRectangle({ x: MARGIN, y: y - 22, width: COL_W, height: 26, color: BRAND_TEAL });
    const t = prepText(title.toUpperCase ? title.toUpperCase() : title);
    page.drawText(t, {
      x: isRtl ? rtlX(t, boldFont, 10, RIGHT - 10) : MARGIN + 10,
      y: y - 16,
      size: 10, font: boldFont, color: WHITE
    });
    y -= 26 + 12;
  }

  // ── Q&A block ─────────────────────────────────────────────────────────────
  function drawQuestionBlock(label, value) {
    spacer(6);
    ensureSpace(14);

    // Accent bar: right side for RTL, left for LTR
    if (isRtl) {
      page.drawRectangle({ x: RIGHT - 3, y: y - 14, width: 3, height: 16, color: BRAND_TEAL });
    } else {
      page.drawRectangle({ x: MARGIN, y: y - 14, width: 3, height: 16, color: BRAND_TEAL });
    }

    const labelLines = wrapText(label, boldFont, 9.5, COL_W - 10);
    labelLines.forEach(line => {
      ensureSpace(12);
      page.drawText(line, { x: textX(line, boldFont, 9.5, 9), y, size: 9.5, font: boldFont, color: BRAND_DARK });
      y -= 13;
    });

    const answerLines = wrapText(value || s.noResponse, regularFont, 9.5, COL_W);
    answerLines.forEach(line => {
      ensureSpace(13);
      page.drawText(line, { x: textX(line, regularFont, 9.5), y, size: 9.5, font: regularFont, color: GRAY_TEXT });
      y -= 13;
    });

    spacer(3);
    ensureSpace(2);
    page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT, y }, thickness: 0.4, color: GRAY_LIGHT });
    spacer(2);
  }

  // ── Render all questions ──────────────────────────────────────────────────
  const metaFields   = new Set(['client-name', 'brand-name', 'email', 'delivery-date', 'client-country']);
  let currentSection = null;

  for (const [key, rawValue] of sortedEntries(payload)) {
    if (metaFields.has(key) || SYSTEM_FIELDS.has(key)) continue;

    const label          = fieldLabels[key] || prettifyKey(key);
    const questionNumber = extractQuestionNumber(key);
    const sectionLabel   = getSectionLabel(questionNumber, lang, false);

    if (sectionLabel && sectionLabel !== currentSection) {
      currentSection = sectionLabel;
      drawSectionHeader(sectionLabel);
    }

    if (key === 'q15-inspiration-refs') {
      const refs = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
      spacer(6);
      ensureSpace(14);

      if (isRtl) {
        page.drawRectangle({ x: RIGHT - 3, y: y - 14, width: 3, height: 16, color: BRAND_TEAL });
      } else {
        page.drawRectangle({ x: MARGIN, y: y - 14, width: 3, height: 16, color: BRAND_TEAL });
      }

      const labelPrepared = prepText(label);
      page.drawText(labelPrepared, {
        x: textX(labelPrepared, boldFont, 9.5, 9),
        y, size: 9.5, font: boldFont, color: BRAND_DARK
      });
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
        drawWrapped(s.noImages, { size: 9, color: GRAY_TEXT });
      }

      spacer(2);
      page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT, y }, thickness: 0.4, color: GRAY_LIGHT });
      spacer(2);
    } else {
      drawQuestionBlock(label, normalizeValueForDoc(rawValue, lang));
    }
  }

  spacer(16);
  return Buffer.from(await pdfDoc.save());
}

/**
 * Public entry point.
 * Arabic  → Puppeteer HTML→PDF (correct OpenType shaping via HarfBuzz in Chromium).
 * EN / FR → existing pdf-lib path (untouched).
 *
 * If Puppeteer is unavailable or times out, falls back to _buildPdfBufferLatin
 * so at least a PDF (with best-effort Arabic) is still delivered.
 */
async function buildPdfBuffer(payload, imageBuffers = {}, lang = 'en') {
  if (lang === 'ar') {
    try {
      const s           = DOC_STRINGS.ar;
      const fieldLabels = getFieldLabelsForDoc('ar');
      const metaFields  = new Set(['client-name', 'brand-name', 'email', 'delivery-date', 'client-country']);

      let currentSection = null;
      const sortedFields = [];

      for (const [key, rawValue] of sortedEntries(payload)) {
        if (metaFields.has(key) || SYSTEM_FIELDS.has(key)) continue;

        const label          = fieldLabels[key] || prettifyKey(key);
        const questionNumber = extractQuestionNumber(key);
        const sectionLabel   = getSectionLabel(questionNumber, 'ar', false);
        const value          = normalizeValueForDoc(rawValue, 'ar');

        const entry = { label, value };
        if (sectionLabel && sectionLabel !== currentSection) {
          currentSection     = sectionLabel;
          entry.sectionTitle = sectionLabel;
        }
        sortedFields.push(entry);
      }

      const html = buildArabicHtml(payload, 'ar', s, fieldLabels, sortedFields);
      return await htmlToPdfBuffer(html);

    } catch (puppeteerErr) {
      // Puppeteer unavailable (cold-start timeout, bundle missing, etc.)
      // Fall back to pdf-lib so the submission still succeeds.
      console.warn('[PDF] Puppeteer path failed, falling back to pdf-lib:', puppeteerErr.message);
    }
  }

  return _buildPdfBufferLatin(payload, imageBuffers, lang);
}

/* ─────────────────────────────────────────────────────────────────────────────
   Email helpers
───────────────────────────────────────────────────────────────────────────── */

// Shared transactional email wrapper style
function emailWrapper(bodyHtml, lang = 'en') {
  const isRtl = lang === 'ar';
  const dir   = isRtl ? 'rtl' : 'ltr';
  const textAlign = isRtl ? 'right' : 'left';
  return `
<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;direction:${dir};text-align:${textAlign};">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:600px;">
        <!-- Header bar -->
        <tr><td style="background:#006d77;padding:24px 32px;">
          <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.5px;">NEATMARK</span>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;direction:${dir};text-align:${textAlign};">
          ${bodyHtml}
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#f9f9f9;padding:16px 32px;border-top:1px solid #eee;">
          <p style="margin:0;font-size:12px;color:#999;">
            &copy; 2026 Neatmark&trade; &nbsp;&middot;&nbsp;
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
function buildAdminEmail({ brandName, clientName, email, deliveryDate, country }) {
  const safeBrand    = escapeHtml(brandName    || 'Unknown Brand');
  const safeClient   = escapeHtml(clientName   || 'Unknown Client');
  const safeEmail    = escapeHtml(email        || 'Not provided');
  const safeDelivery = escapeHtml(deliveryDate || 'Not provided');
  const safeCountry  = escapeHtml(country      || '');

  const rows = [
    ['Client', safeClient],
    ['Brand / Business', safeBrand],
    ['Email', safeEmail],
    ['Requested Delivery', safeDelivery],
    ...(safeCountry ? [['Country', safeCountry]] : [])
  ];

  const bodyHtml = `
    <h2 style="color:#006d77;margin:0 0 20px;">New Client Intake Submission</h2>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
      ${rows.map(([label, value]) => `
        <tr>
          <td style="padding:8px 12px;background:#f0faf8;font-size:13px;font-weight:700;color:#00373c;width:160px;border-bottom:1px solid #e0f0ee;">${label}</td>
          <td style="padding:8px 12px;font-size:13px;color:#333;border-bottom:1px solid #e0f0ee;">${value}</td>
        </tr>`).join('')}
    </table>
    <p style="margin:24px 0 0;font-size:13px;color:#666;">
      The full submission (PDF, DOCX &amp; Markdown) is attached to this email.
    </p>`;

  return {
    subject: sanitizeSubject(`New Intake: ${String(brandName || 'Unknown Brand')} · ${String(clientName || 'Unknown Client')}`),    
    html: emailWrapper(bodyHtml),
    text: `New Client Intake\n\nClient: ${String(clientName)}\nBrand: ${String(brandName)}\nEmail: ${String(email)}\nDelivery: ${String(deliveryDate)}${country ? `\nCountry: ${country}` : ''}\n\nFull submission attached.`
  };
}

/**
 * Client confirmation email — sent on NEW submission.
 * Includes a 30-day edit link.
 */
function buildClientEmail({ brandName, clientName, editLink }, lang = 'en') {
  const copy       = EMAIL_COPY[lang] || EMAIL_COPY.en;
  const safeBrand  = escapeHtml(brandName  || 'your brand');
  const safeClient = escapeHtml(clientName || 'there');
  // Validate editLink: must be a full https URL on the expected origin before embedding in HTML.
  // escapeHtml converts quotes/angle brackets so the href attribute cannot be broken out of.
  const safeEditLink = (() => {
    try {
      const u = new URL(String(editLink || ''));
      if (u.protocol !== 'https:') return '#';
      return escapeHtml(u.href);
    } catch {
      return '#';
    }
  })();

  const bodyHtml = `
    <h2 style="color:#006d77;margin:0 0 8px;">${copy.clientGreeting(safeClient)}</h2>
    <p style="color:#333;line-height:1.7;margin:0 0 16px;">
      ${copy.clientIntro(safeBrand)}
    </p>
    <p style="color:#333;line-height:1.7;margin:0 0 16px;">
      ${copy.clientPdfNote}
    </p>
    <div style="margin:24px 0;padding:20px;background:#f0faf8;border-radius:8px;border-left:4px solid #006d77;">
      <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#00373c;">
        ${copy.clientEditHeading}
      </p>
      <p style="margin:0 0 16px;font-size:13px;color:#444;line-height:1.6;">
        ${copy.clientEditBody}
      </p>
      <a href="${safeEditLink}"
         style="display:inline-block;background:#006d77;color:#ffffff;text-decoration:none;
                padding:12px 24px;border-radius:6px;font-size:14px;font-weight:700;">
        ${copy.clientEditBtn}
      </a>
    </div>`;

  return {
    subject: sanitizeSubject(copy.clientSubject(String(brandName || 'your brand'))),
    html: emailWrapper(bodyHtml, lang),
    text: copy.clientPlainText(String(clientName), String(brandName), editLink)
  };
}

/**
 * Edit confirmation email — sent after a successful token-based edit.
 */
function buildEditConfirmationEmail({ brandName, clientName }, lang = 'en') {
  const copy       = EMAIL_COPY[lang] || EMAIL_COPY.en;
  const safeBrand  = escapeHtml(brandName  || 'your brand');
  const safeClient = escapeHtml(clientName || 'there');
  const editedAt   = new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });

  const bodyHtml = `
    <h2 style="color:#006d77;margin:0 0 8px;">${copy.editGreeting(safeClient)}</h2>
    <p style="color:#333;line-height:1.7;margin:0 0 16px;">
      ${copy.editIntro(safeBrand, editedAt)}
    </p>
    <p style="color:#333;line-height:1.7;margin:0 0 16px;">
      ${copy.editBody}
    </p>
    <div style="margin-top:24px;padding-top:20px;border-top:2px solid #e0f0ee;">
      <p style="margin:0;color:#888;font-size:13px;">
        ${copy.editSignoff}
      </p>
    </div>`;

  return {
    subject: sanitizeSubject(copy.editSubject(String(brandName || 'your brand'))),
    html: emailWrapper(bodyHtml, lang),
    text: copy.editPlainText(String(clientName), String(brandName), editedAt)
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
  MAX_FIELD_VALUE_LENGTH,
  normalizeValue,
  normalizeValueForDoc,
  getOptionLabel,
  escapeHtml,
  prettifyKey,
  sortedEntries,
  extractQuestionNumber,
  getSectionLabel,
  getFieldLabels,
  getFieldLabelsForDoc,
  sanitizeFilenamePart,
  buildMarkdown,
  buildDocxBuffer,
  buildPdfBuffer,
  sendResendEmail,
  buildAdminEmail,
  buildClientEmail,
  buildEditConfirmationEmail
};
