let translations = {};
let currentLanguage = 'en';
const SUPPORTED_LANGS = ['en', 'fr', 'ar'];
const DOM_LANGS = ['en']; // content lives in HTML, no JSON fetch needed

function localePath(lang) {
  const base = window.location.pathname.replace(/\/[^/]*$/, '/');
  return `${base}locales/${lang}/translation.json`;
}

async function loadLanguage(lang) {
  if (DOM_LANGS.includes(lang) || translations[lang]) return;
  try {
    const data = await fetch(localePath(lang)).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    translations[lang] = data;
  } catch (err) {
    console.warn(`[i18n] Could not load "${lang}":`, err);
  }
}

async function initI18n() {
  const saved   = localStorage.getItem('preferred-language');
  const browser = navigator.language.startsWith('fr') ? 'fr'
                : navigator.language.startsWith('ar') ? 'ar' : 'en';
  currentLanguage = (saved && SUPPORTED_LANGS.includes(saved)) ? saved : browser;
  if (!SUPPORTED_LANGS.includes(currentLanguage)) currentLanguage = 'en';
  await loadLanguage(currentLanguage);
  applyRTL();
  return currentLanguage;
}

function getTranslation(key, defaultValue = '') {
  if (DOM_LANGS.includes(currentLanguage) || !translations[currentLanguage]) return defaultValue;
  const keys = key.split('.');
  let value = translations[currentLanguage];
  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) value = value[k];
    else return defaultValue;
  }
  return (value !== null && value !== undefined) ? String(value) : defaultValue;
}

function t(key, options = '') {
  let defaultValue = '', interpolateVars = {};
  if (typeof options === 'string')      defaultValue    = options;
  else if (typeof options === 'object') interpolateVars = options;
  return interpolate(getTranslation(key, defaultValue), interpolateVars);
}

function interpolate(text, values = {}) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? '');
}

async function setLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) return;
  await loadLanguage(lang);
  currentLanguage = lang;
  localStorage.setItem('preferred-language', lang);
  applyRTL();
  updatePageTranslations();
}

function getLanguage() { return currentLanguage; }

function applyRTL() {
  const html = document.documentElement;
  const isArabic = currentLanguage === 'ar';
  html.setAttribute('dir',  isArabic ? 'rtl' : 'ltr');
  html.setAttribute('lang', currentLanguage);
  html.classList.toggle('rtl-mode',  isArabic);
  html.classList.toggle('ltr-mode', !isArabic);
  requestAnimationFrame(() => {
    window.scrollTo(0, window.scrollY);
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;
  });
}

function updatePageTranslations() {
  function applyText(el) {
    if (!el.dataset.i18nFallback) el.dataset.i18nFallback = el.innerHTML || '';
    const val = t(el.getAttribute('data-i18n'));
    if (val) el.textContent = val;
    else     el.innerHTML   = el.dataset.i18nFallback;
  }

  document.querySelectorAll('[data-i18n]:not(option)').forEach(el => {
    const attrName = el.getAttribute('data-i18n-attr');
    if (attrName && attrName !== 'textContent') el.setAttribute(attrName, t(el.getAttribute('data-i18n')));
    else applyText(el);
  });

  document.querySelectorAll('option[data-i18n]').forEach(applyText);

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    if (!el.dataset.i18nPlaceholderFallback) el.dataset.i18nPlaceholderFallback = el.placeholder || '';
    el.placeholder = t(el.getAttribute('data-i18n-placeholder')) || el.dataset.i18nPlaceholderFallback;
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    if (!el.dataset.i18nTitleFallback) el.dataset.i18nTitleFallback = el.title || '';
    el.title = t(el.getAttribute('data-i18n-title')) || el.dataset.i18nTitleFallback;
  });

  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    if (!el.dataset.i18nAriaFallback) el.dataset.i18nAriaFallback = el.getAttribute('aria-label') || '';
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')) || el.dataset.i18nAriaFallback);
  });

  window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language: currentLanguage } }));
}

(function boot() {
  function run() { initI18n().then(() => updatePageTranslations()); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
})();

window.i18n = { t, setLanguage, getLanguage, interpolate, updatePageTranslations };
