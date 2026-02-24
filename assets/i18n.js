// i18n Configuration
let translations = {};
let currentLanguage = 'en';

// Initialize i18n without external libraries - simple implementation
async function initI18n() {
  // Detect language preference from localStorage or browser
  const savedLanguage = localStorage.getItem('preferred-language');
  const browserLanguage = navigator.language.startsWith('fr') ? 'fr' :
                         navigator.language.startsWith('ar') ? 'ar' : 'en';
  
  currentLanguage = savedLanguage || browserLanguage;
  
  // Validate language
  if (!['en', 'fr', 'ar'].includes(currentLanguage)) {
    currentLanguage = 'en';
  }
  
  // Load translation files
  await loadTranslations();
  
  // Apply RTL for Arabic
  applyRTL();
  
  // Apply theme from localStorage
  applyTheme();
  
  return currentLanguage;
}

async function loadTranslations() {
  try {
    const [enData, frData, arData] = await Promise.all([
      fetch('../locales/en/translation.json').then(r => r.json()),
      fetch('../locales/fr/translation.json').then(r => r.json()),
      fetch('../locales/ar/translation.json').then(r => r.json())
    ]);
    
    translations = {
      en: enData,
      fr: frData,
      ar: arData
    };
  } catch (error) {
    console.error('Failed to load translations:', error);
  }
}

function getTranslation(key, defaultValue = '') {
  if (!translations[currentLanguage]) {
    return defaultValue;
  }
  
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
  // Handle both interpolation (object) and default value (string)
  let defaultValue = '';
  let interpolateVars = {};
  
  if (typeof options === 'string') {
    defaultValue = options;
  } else if (typeof options === 'object') {
    interpolateVars = options;
  }
  
  const translation = getTranslation(key, defaultValue);
  return interpolate(translation, interpolateVars);
}

function interpolate(text, values = {}) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? '');
}

function setLanguage(lang) {
  if (!['en', 'fr', 'ar'].includes(lang)) {
    console.warn(`Invalid language: ${lang}`);
    return;
  }
  
  currentLanguage = lang;
  localStorage.setItem('preferred-language', lang);
  
  // Apply RTL
  applyRTL();
  
  // Update all translatable elements
  updatePageTranslations();
}

function getLanguage() {
  return currentLanguage;
}

function applyRTL() {
  const html = document.documentElement;
  const isArabic = currentLanguage === 'ar';
  
  html.setAttribute('dir', isArabic ? 'rtl' : 'ltr');
  html.setAttribute('lang', currentLanguage);
  
  if (isArabic) {
    html.classList.add('rtl-mode');
    html.classList.remove('ltr-mode');
  } else {
    html.classList.remove('rtl-mode');
    html.classList.add('ltr-mode');
  }
}

function applyTheme() {
  const savedTheme = localStorage.getItem('theme');
  const html = document.documentElement;
  
  if (savedTheme) {
    html.setAttribute('data-theme', savedTheme);
  }
}

function updatePageTranslations() {
  const applyTranslatedText = (element) => {
    if (!element.dataset.i18nFallback) {
      element.dataset.i18nFallback = element.textContent || '';
    }

    const key = element.getAttribute('data-i18n');
    const fallbackText = element.dataset.i18nFallback;
    const value = t(key);
    element.textContent = value || fallbackText;
  };

  // Update all elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]:not(option)').forEach(element => {
    const key = element.getAttribute('data-i18n');
    const isAttribute = element.hasAttribute('data-i18n-attr');
    const attrName = isAttribute ? element.getAttribute('data-i18n-attr') : 'textContent';

    if (isAttribute && attrName !== 'textContent') {
      const value = t(key);
      element.setAttribute(attrName, value);
    } else {
      applyTranslatedText(element);
    }
  });

  // Explicitly update option text labels
  document.querySelectorAll('option[data-i18n]').forEach(applyTranslatedText);
  
  // Update placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
    const key = element.getAttribute('data-i18n-placeholder');
    element.placeholder = t(key, element.placeholder);
  });
  
  // Update title attributes
  document.querySelectorAll('[data-i18n-title]').forEach(element => {
    const key = element.getAttribute('data-i18n-title');
    element.title = t(key, element.title);
  });
  
  // Update aria-labels
  document.querySelectorAll('[data-i18n-aria]').forEach(element => {
    const key = element.getAttribute('data-i18n-aria');
    element.setAttribute('aria-label', t(key));
  });
  
  // Dispatch custom event for components to update
  window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language: currentLanguage } }));
}

// Initialize on DOMContentLoaded if not already loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.i18nInitialized) {
      initI18n().then(() => {
        window.i18nInitialized = true;
        updatePageTranslations();
      });
    }
  });
} else {
  // DOM is already loaded
  if (!window.i18nInitialized) {
    initI18n().then(() => {
      window.i18nInitialized = true;
      updatePageTranslations();
    });
  }
}

// Expose i18n globally
window.i18n = {
  t,
  setLanguage,
  getLanguage,
  interpolate,
  updatePageTranslations
};
