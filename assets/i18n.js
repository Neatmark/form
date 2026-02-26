// i18n — lazy-loading, no dead code
let translations = {};
let currentLanguage = 'en';
const SUPPORTED_LANGS = ['en', 'fr', 'ar'];

function localePath(lang) {
  const base = window.location.pathname.replace(/\/[^/]*$/, '/');
  return `${base}locales/${lang}/translation.json`;
}

async function loadLanguage(lang) {
  if (translations[lang]) return;
  try {
    const data = await fetch(localePath(lang)).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    translations[lang] = data;
  } catch (err) {
    console.error(`[i18n] Failed to load "${lang}":`, err);
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
  if (!translations[currentLanguage]) return defaultValue;
  const keys = key.split('.');
  let value = translations[currentLanguage];
  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      return defaultValue;
    }
  }
  return value || defaultValue;
}

function t(key, options = '') {
  let defaultValue = '';
  let interpolateVars = {};
  if (typeof options === 'string')      defaultValue    = options;
  else if (typeof options === 'object') interpolateVars = options;
  return interpolate(getTranslation(key, defaultValue), interpolateVars);
}

function interpolate(text, values = {}) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

async function setLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) {
    console.warn(`[i18n] Invalid language: ${lang}`);
    return;
  }
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
}

function updatePageTranslations() {
  function applyText(el) {
    if (!el.dataset.i18nFallback) el.dataset.i18nFallback = el.textContent || '';
    const val = t(el.getAttribute('data-i18n'));
    el.textContent = val || el.dataset.i18nFallback;
  }

  document.querySelectorAll('[data-i18n]:not(option)').forEach(el => {
    const isAttr   = el.hasAttribute('data-i18n-attr');
    const attrName = isAttr ? el.getAttribute('data-i18n-attr') : 'textContent';
    if (isAttr && attrName !== 'textContent') {
      el.setAttribute(attrName, t(el.getAttribute('data-i18n')));
    } else {
      applyText(el);
    }
  });

  document.querySelectorAll('option[data-i18n]').forEach(applyText);
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'), el.placeholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.getAttribute('data-i18n-title'), el.title);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  });

  window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language: currentLanguage } }));
}

(function boot() {
  function run() {
    initI18n().then(() => updatePageTranslations());
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();

window.i18n = { t, setLanguage, getLanguage, interpolate, updatePageTranslations };
