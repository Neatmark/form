/* ── Theme ───────────────────────────────────────────────────────────────────
   'auto'  → follows OS, never persisted
   'dark'  → manual, persisted
   'light' → manual, persisted
────────────────────────────────────────────────────────────────────────── */

const THEME_STORAGE_KEY = 'user-theme';
const THEME_COLORS = { dark: '#005560', light: '#e6fcf8' };

function getOsTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getSavedMode() {
  const s = localStorage.getItem(THEME_STORAGE_KEY);
  return (s === 'dark' || s === 'light') ? s : 'auto';
}

function resolveTheme(mode) {
  return mode === 'auto' ? getOsTheme() : mode;
}

// Auto mode: media-query <meta> tags in <head> handle theme-color natively.
// Manual mode: inject a plain (no media) tag — it takes precedence per spec.
function applyThemeColor(mode) {
  const id = 'theme-color-manual';
  let manual = document.getElementById(id);
  if (mode === 'auto') {
    if (manual) manual.remove();
  } else {
    if (!manual) {
      manual = document.createElement('meta');
      manual.name = 'theme-color';
      manual.id = id;
      const ref = document.querySelector('meta[name="theme-color"][media]');
      ref ? ref.after(manual) : document.head.appendChild(manual);
    }
    manual.content = THEME_COLORS[resolveTheme(mode)];
  }
}

function applyTheme(mode, save) {
  const theme = resolveTheme(mode);
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-theme-mode', mode);
  applyThemeColor(mode);
  if (save) {
    if (mode === 'auto') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, mode);
  }
  const menu = document.getElementById('themeMenu');
  if (menu) {
    menu.querySelectorAll('li[data-theme-option]').forEach(li => {
      li.setAttribute('aria-selected', li.dataset.themeOption === mode ? 'true' : 'false');
    });
  }
}

function selectThemeMode(mode) { applyTheme(mode, true); }

// Init
applyTheme(getSavedMode(), false);

// Follow OS changes in auto mode
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getSavedMode() === 'auto') applyTheme('auto', false);
});

function updateThemeToggleIcon() {
  const mode = getSavedMode();
  document.getElementById('themeMenu')?.querySelectorAll('li[data-theme-option]').forEach(li => {
    li.setAttribute('aria-selected', li.dataset.themeOption === mode ? 'true' : 'false');
  });
}

// Custom branded alert popup — replaces native alert()
function showAlert(message, type = 'success') {
  const overlay = document.getElementById('customAlertOverlay');
  const msgEl = document.getElementById('customAlertMsg');
  const titleEl = document.getElementById('customAlertTitle');
  const iconWrap = document.getElementById('customAlertIconWrap');
  const icon = document.getElementById('customAlertIcon');
  const closeBtn = document.getElementById('customAlertCloseBtn');
  if (!overlay || !msgEl) { alert(message); return; }

  const isError = type === 'error';
  msgEl.textContent = message;
  titleEl.textContent = isError
    ? window.i18n.t('messages.alertError', 'Something went wrong')
    : window.i18n.t('messages.alertSuccess', 'Success');
  closeBtn.textContent = window.i18n.t('messages.alertClose', 'OK');
  iconWrap.className = 'custom-alert-icon-wrap' + (isError ? ' error' : '');
  closeBtn.className = 'custom-alert-close-btn' + (isError ? ' error-btn' : '');

  // Swap icon via lucide
  icon.setAttribute('data-lucide', isError ? 'x-circle' : 'check-circle');
  if (window.lucide) window.lucide.createIcons();

  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('active');

  return new Promise(resolve => {
    function dismiss() {
      overlay.classList.remove('active');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.removeEventListener('click', onOverlayClick);
      closeBtn.removeEventListener('click', dismiss);
      resolve();
    }
    function onOverlayClick(e) { if (e.target === overlay) dismiss(); }
    closeBtn.addEventListener('click', dismiss);
    overlay.addEventListener('click', onOverlayClick);
  });
}



function formDataToObject(formData) {
  const payload = {};

  for (const [key, value] of formData.entries()) {
    if (payload[key] === undefined) {
      payload[key] = value;
      continue;
    }

    if (!Array.isArray(payload[key])) {
      payload[key] = [payload[key]];
    }

    payload[key].push(value);
  }

  return payload;
}

function normalizeComparable(value) {
  return String(value ?? '').trim().toLowerCase();
}

async function checkDuplicateSubmission(formData) {
  const payload = formDataToObject(formData);
  const email = normalizeComparable(payload.email);
  const brandName = normalizeComparable(payload['brand-name']);

  if (!email || !brandName) {
    return null;
  }

  try {
    const response = await fetch('/.netlify/functions/check-duplicate-submission', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, brandName })
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (!data || data.duplicate !== true || !data.submissionId) {
      return null;
    }

    return {
      submissionId: String(data.submissionId)
    };
  } catch {
    return null;
  }
}

function askDuplicateSubmissionAction() {
  const modal = document.getElementById('duplicateModal');
  const overrideBtn = document.getElementById('duplicateOverrideBtn');
  const sendNewBtn = document.getElementById('duplicateSendNewBtn');
  const cancelBtn = document.getElementById('duplicateCancelBtn');

  if (!modal || !overrideBtn || !sendNewBtn || !cancelBtn) {
    throw new Error('Duplicate confirmation modal is missing.');
  }

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');

  return new Promise(resolve => {
    const cleanup = () => {
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
      overrideBtn.removeEventListener('click', onOverride);
      sendNewBtn.removeEventListener('click', onSendNew);
      cancelBtn.removeEventListener('click', onCancel);
    };

    const onOverride = () => {
      cleanup();
      resolve('override');
    };

    const onSendNew = () => {
      cleanup();
      resolve('send-as-new');
    };

    const onCancel = () => {
      cleanup();
      resolve('cancel');
    };

    overrideBtn.addEventListener('click', onOverride);
    sendNewBtn.addEventListener('click', onSendNew);
    cancelBtn.addEventListener('click', onCancel);
  });
}

async function submitToSupabase(formData) {
  const payload = formDataToObject(formData);

  const response = await fetch('/.netlify/functions/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    let parsed;

    try {
      parsed = JSON.parse(errorText);
    } catch {
      parsed = null;
    }

    if (parsed && typeof parsed === 'object') {
      const details = typeof parsed.details === 'string' ? parsed.details : '';
      const message = typeof parsed.error === 'string' ? parsed.error : 'Submission failed.';
      throw new Error(details ? `${message} ${details}` : message);
    }

    throw new Error(errorText || 'Submission failed.');
  }

  // Return parsed JSON so caller can fire the send-emails background task
  return response.json();
}

/* ── Draft persistence (localStorage) ──────────────────── */

const DRAFT_KEY = 'brand-intake-draft';

function saveDraft(form) {
  const data = {};
  const formData = new FormData(form);
  const checkboxNames = new Set();

  form.querySelectorAll('input[type="checkbox"]').forEach(cb => checkboxNames.add(cb.name));

  // Initialize all checkbox groups as empty arrays
  checkboxNames.forEach(name => { data[name] = []; });

  for (const [key, value] of formData.entries()) {
    if (checkboxNames.has(key)) {
      data[key].push(value);
    } else {
      data[key] = value;
    }
  }

  localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
  showDraftBanner(true);
}

function loadDraft(form) {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return false;

  let data;
  try { data = JSON.parse(raw); } catch { return false; }
  if (!data || typeof data !== 'object') return false;

  for (const [key, value] of Object.entries(data)) {
    const elements = form.elements.namedItem(key);
    if (!elements) continue;

    // Checkbox group (stored as array)
    if (Array.isArray(value)) {
      const checkboxes = form.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(key)}"]`);
      checkboxes.forEach(cb => {
        cb.checked = value.includes(cb.value);
      });
      continue;
    }

    // Radio group — namedItem returns a RadioNodeList, not an HTMLInputElement
    if (elements.length !== undefined && elements[0] instanceof HTMLInputElement && elements[0].type === 'radio') {
      Array.from(elements).forEach(r => { r.checked = r.value === value; });
      continue;
    }

    // Single element (text, textarea, select, etc.)
    if (elements instanceof HTMLInputElement || elements instanceof HTMLTextAreaElement || elements instanceof HTMLSelectElement) {
      elements.value = value;
      // Update range badge
      if (elements.type === 'range') {
        const badge = elements.parentElement?.querySelector('.scale-value');
        if (badge) badge.textContent = value;
      }
    }
  }

  return true;
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
  showDraftBanner(false);
}

let draftBannerTimer = null;

function showDraftBanner(visible) {
  const banner = document.getElementById('draftBanner');
  if (!banner) return;

  clearTimeout(draftBannerTimer);

  if (visible) {
    banner.classList.remove('hiding');
    banner.style.display = 'flex';
    // Auto-dismiss after 5 seconds
    draftBannerTimer = setTimeout(() => {
      banner.classList.add('hiding');
      setTimeout(() => { banner.style.display = 'none'; }, 300);
    }, 5000);
  } else {
    banner.classList.add('hiding');
    setTimeout(() => { banner.style.display = 'none'; }, 300);
  }
}

/* ══════════════════════════════════════════════════════════════
   MULTI-PAGE WIZARD — Page navigation controller
══════════════════════════════════════════════════════════════ */

const TOTAL_PAGES = 4;
let currentPage  = 1;
let goingBack    = false;

/**
 * Navigate to a given page number.
 * @param {number} targetPage  1–4
 * @param {boolean} [back]     Whether we're going backwards (affects animation)
 */
function showPage(targetPage, back = false) {
  if (targetPage < 1 || targetPage > TOTAL_PAGES) return;

  // Hide current page
  const current = document.getElementById(`formPage${currentPage}`);
  if (current) {
    current.classList.remove('active', 'slide-back');
    current.style.display = 'none';
  }

  // Show target page
  const target = document.getElementById(`formPage${targetPage}`);
  if (target) {
    target.style.display = 'block';
    // Briefly remove active so animation re-triggers
    target.classList.remove('active', 'slide-back');
    // Force reflow
    void target.offsetWidth;
    if (back) target.classList.add('slide-back');
    target.classList.add('active');
  }

  currentPage = targetPage;
  updateStepper();
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Re-create lucide icons in the newly shown page
  if (window.lucide) window.lucide.createIcons();
}

/** Update the stepper bar to reflect currentPage */
function updateStepper() {
  const steps = document.querySelectorAll('.step-btn');
  steps.forEach(btn => {
    const step = parseInt(btn.dataset.step, 10);
    btn.classList.remove('active', 'completed');
    if (step === currentPage)   btn.classList.add('active');
    if (step < currentPage)     btn.classList.add('completed');
  });

  // Fill connector lines
  for (let i = 1; i <= TOTAL_PAGES - 1; i++) {
    const conn = document.getElementById(`connector${i}`);
    if (conn) conn.classList.toggle('filled', i < currentPage);
  }
}

/**
 * Validate all required fields within a given page.
 * Returns true if valid, false (and scrolls to first error) if not.
 */
function validatePage(pageNum) {
  const pageEl = document.getElementById(`formPage${pageNum}`);
  if (!pageEl) return true;

  const form = document.querySelector('form[name="brand-intake"]');
  let firstError = null;

  // Check standard required inputs / textareas
  pageEl.querySelectorAll('[required]').forEach(el => {
    if (el.type === 'radio') return; // handled separately below
    if (!el.value.trim()) {
      el.reportValidity?.();
      el.style.borderColor = 'var(--red)';
      if (!firstError) firstError = el;
      el.addEventListener('input', function fix() {
        el.style.borderColor = '';
        el.removeEventListener('input', fix);
      }, { once: true });
    } else {
      el.style.borderColor = '';
    }
  });

  // Check required radio groups on this page
  const radioGroupsDone = new Set();
  pageEl.querySelectorAll('input[type="radio"][required]').forEach(radio => {
    if (radioGroupsDone.has(radio.name)) return;
    radioGroupsDone.add(radio.name);
    const anyChecked = pageEl.querySelector(`input[type="radio"][name="${CSS.escape(radio.name)}"]:checked`);
    if (!anyChecked) {
      const group = pageEl.querySelector(`input[type="radio"][name="${CSS.escape(radio.name)}"]`);
      if (!firstError) firstError = group;
    }
  });

  // Page 3 custom validators: q9-color and q13-deliverables
  if (pageNum === 3) {
    const q9Checked  = pageEl.querySelectorAll('input[name="q9-color"]:checked');
    const q13Checked = pageEl.querySelectorAll('input[name="q13-deliverables"]:checked');
    const q9Error    = document.getElementById('q9ValidationError');
    const q13Error   = document.getElementById('q13ValidationError');

    if (q9Checked.length === 0) {
      if (q9Error) q9Error.classList.add('visible');
      if (!firstError) firstError = q9Error;
    } else {
      if (q9Error) q9Error.classList.remove('visible');
    }

    if (q13Checked.length === 0) {
      if (q13Error) q13Error.classList.add('visible');
      if (!firstError) firstError = q13Error;
    } else {
      if (q13Error) q13Error.classList.remove('visible');
    }
  }

  if (firstError) {
    firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }
  return true;
}

/** Wire up next buttons, back buttons, and stepper buttons */
function initWizard() {
  // Next buttons
  for (let i = 1; i < TOTAL_PAGES; i++) {
    const btn = document.getElementById(`nextBtn${i}`);
    if (!btn) continue;
    btn.addEventListener('click', () => {
      if (validatePage(currentPage)) showPage(currentPage + 1, false);
    });
  }

  // Back buttons (any element with data-back="true")
  document.querySelectorAll('[data-back="true"]').forEach(btn => {
    btn.addEventListener('click', () => {
      showPage(currentPage - 1, true);
    });
  });

  // Stepper buttons — always allow clicking (free navigation)
  document.querySelectorAll('.step-btn[data-step]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = parseInt(btn.dataset.step, 10);
      if (target === currentPage) { btn.blur(); return; }
      const back = target < currentPage;
      // If going forward, validate all pages up to current
      if (!back) {
        for (let p = currentPage; p < target; p++) {
          if (!validatePage(p)) { btn.blur(); return; }
        }
      }
      showPage(target, back);
      btn.blur();
    });
  });

  // Initial stepper state
  updateStepper();

  // On edit-mode (?token=), jump to page 1 (already there) but show all pages reachable
}

document.addEventListener('DOMContentLoaded', () => {
  // Init wizard first so pages are shown correctly
  initWizard();

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }

  /* ── Theme dropdown ───────────────────────────────────── */
  const themeToggleButton = document.getElementById('themeToggle');
  const themeMenu         = document.getElementById('themeMenu');

  function openThemeMenu() {
    if (!themeToggleButton || !themeMenu) return;
    themeToggleButton.setAttribute('aria-expanded', 'true');
    themeMenu.classList.add('open');
  }
  function closeThemeMenu() {
    if (!themeToggleButton || !themeMenu) return;
    themeToggleButton.setAttribute('aria-expanded', 'false');
    themeMenu.classList.remove('open');
  }

  if (themeToggleButton && themeMenu) {
    themeToggleButton.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = themeToggleButton.getAttribute('aria-expanded') === 'true';
      isOpen ? closeThemeMenu() : openThemeMenu();
    });

    themeMenu.addEventListener('click', (e) => { e.stopPropagation(); });

    themeMenu.querySelectorAll('li[data-theme-option]').forEach(li => {
      li.setAttribute('tabindex', '0');
      const handleSelect = (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectThemeMode(li.getAttribute('data-theme-option'));
        closeThemeMenu();
        if (window.lucide) window.lucide.createIcons();
      };
      li.addEventListener('click', handleSelect);
      li.addEventListener('touchend', handleSelect);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelect(e); }
      });
    });

    document.addEventListener('click', (e) => {
      if (!themeToggleButton.contains(e.target) && !themeMenu.contains(e.target)) closeThemeMenu();
    });
    document.addEventListener('touchstart', (e) => {
      if (!themeToggleButton.contains(e.target) && !themeMenu.contains(e.target)) closeThemeMenu();
    }, { passive: true });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeThemeMenu();
    });
  }
  updateThemeToggleIcon();

  /* ── Language dropdown ────────────────────────────── */
  const langToggle  = document.getElementById('langToggle');
  const langMenu    = document.getElementById('langMenu');

  function openLangMenu()  {
    if (!langToggle || !langMenu) return;
    langToggle.setAttribute('aria-expanded', 'true');
    langMenu.classList.add('open');
  }
  function closeLangMenu() {
    if (!langToggle || !langMenu) return;
    langToggle.setAttribute('aria-expanded', 'false');
    langMenu.classList.remove('open');
  }
  function syncLangUI(lang) {
    if (langToggle) {
      const codeEl = langToggle.querySelector('.lang-code');
      if (codeEl) codeEl.textContent = lang.toUpperCase();
    }
    if (langMenu) {
      langMenu.querySelectorAll('li[data-lang]').forEach(li => {
        li.setAttribute('aria-selected', li.getAttribute('data-lang') === lang ? 'true' : 'false');
      });
    }
  }

  if (langToggle && langMenu) {
    langToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = langToggle.getAttribute('aria-expanded') === 'true';
      isOpen ? closeLangMenu() : openLangMenu();
    });

    langMenu.addEventListener('click', (e) => { e.stopPropagation(); });

    langMenu.querySelectorAll('li[data-lang]').forEach(li => {
      li.setAttribute('tabindex', '0');

      const handleSelect = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const lang = li.getAttribute('data-lang');
        closeLangMenu();
        try { window.i18n.setLanguage(lang); } catch (_) { /* safe */ }
      };

      li.addEventListener('click', handleSelect);
      li.addEventListener('touchend', handleSelect);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelect(e); }
      });
    });

    // Close on outside click / touch
    document.addEventListener('click', (e) => {
      if (!langToggle.contains(e.target) && !langMenu.contains(e.target)) closeLangMenu();
    });
    document.addEventListener('touchstart', (e) => {
      if (!langToggle.contains(e.target) && !langMenu.contains(e.target)) closeLangMenu();
    }, { passive: true });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLangMenu();
    });
  }

  // Listen for language changes — bound here, inside DOMContentLoaded where DOM is ready
  window.addEventListener('languageChanged', (event) => {
    const lang = event?.detail?.language || window.i18n.getLanguage();
    syncLangUI(lang);
    updateThemeToggleIcon();
  });

  syncLangUI(window.i18n.getLanguage());

  /* ── Custom select dropdowns (delivery date etc.) ── */
  document.querySelectorAll('.custom-select').forEach(wrapper => {
    const trigger = wrapper.querySelector('.custom-select-trigger');
    const menu    = wrapper.querySelector('.custom-select-menu');
    const label   = wrapper.querySelector('.custom-select-label');
    const hidden  = wrapper.parentElement.querySelector('input[type="hidden"]');
    if (!trigger || !menu) return;

    const placeholderText = label?.textContent || '';
    label?.classList.add('placeholder');

    function openMenu()  { trigger.setAttribute('aria-expanded', 'true');  menu.classList.add('open'); }
    function closeMenu() { trigger.setAttribute('aria-expanded', 'false'); menu.classList.remove('open'); }

    function selectOption(li) {
      const value = li.getAttribute('data-value');
      menu.querySelectorAll('li').forEach(el => el.setAttribute('aria-selected', 'false'));
      li.setAttribute('aria-selected', 'true');
      if (label) {
        label.textContent = li.textContent;
        label.classList.remove('placeholder');
      }
      if (hidden) {
        hidden.value = value;
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      }
      closeMenu();
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      trigger.getAttribute('aria-expanded') === 'true' ? closeMenu() : openMenu();
    });
    menu.addEventListener('click', (e) => { e.stopPropagation(); });

    menu.querySelectorAll('li[data-value]').forEach(li => {
      li.setAttribute('tabindex', '0');
      const handle = (e) => { e.preventDefault(); e.stopPropagation(); selectOption(li); };
      li.addEventListener('click', handle);
      li.addEventListener('touchend', handle);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handle(e); }
      });
    });

    document.addEventListener('click', (e) => {
      if (!wrapper.contains(e.target)) closeMenu();
    });
    document.addEventListener('touchstart', (e) => {
      if (!wrapper.contains(e.target)) closeMenu();
    }, { passive: true });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    // Restore from draft: if hidden input already has a value, sync the label
    if (hidden && hidden.value) {
      const match = menu.querySelector(`li[data-value="${CSS.escape(hidden.value)}"]`);
      if (match) {
        match.setAttribute('aria-selected', 'true');
        if (label) { label.textContent = match.textContent; label.classList.remove('placeholder'); }
      }
    }

    // Listen for languageChanged to update the visible label from the translated li text
    window.addEventListener('languageChanged', () => {
      const selected = menu.querySelector('li[aria-selected="true"]');
      if (selected && label) {
        label.textContent = selected.textContent;
      } else if (label) {
        // Re-read placeholder from data-i18n
        const key = label.getAttribute('data-i18n');
        if (key) label.textContent = window.i18n?.t(key, placeholderText) || placeholderText;
        label.classList.add('placeholder');
      }
    });
  });

  const form = document.querySelector('form[name="brand-intake"]');
  if (!form) {
    return;
  }

  // ── Token-based edit mode ────────────────────────────────────────────────────
  // Check if URL has ?token= parameter — if so, enter edit mode
  (async function initEditMode() {
    const urlParams = new URLSearchParams(window.location.search);
    const editToken = urlParams.get('token');
    if (!editToken) return;

    // Apply the language the client used when they originally submitted.
    // The edit link includes &lang=xx (added when the link is generated).
    // We do this early — before pre-filling — so translated placeholder text
    // and the delivery-date dropdown label both end up in the right language.
    const langParam = urlParams.get('lang');
    if (langParam && ['en', 'fr', 'ar'].includes(langParam)) {
      try { await window.i18n.setLanguage(langParam); } catch (_) { /* safe */ }
    }

    try {
      const resp = await fetch(`/.netlify/functions/get-submission-by-token?token=${encodeURIComponent(editToken)}`);
      const data = await resp.json();

      if (!resp.ok || !data.submission) {
        const errMsg = data.error || 'This edit link is invalid or has expired.';
        await showAlert(errMsg, 'error');
        // Clean URL without reloading
        window.history.replaceState({}, '', window.location.pathname);
        return;
      }

      // Store token globally for submission handler
      window.__editToken = editToken;

      // Pre-fill form with stored data
      const sub = data.submission;

      // Text / textarea inputs
      const textFields = [
        'client-name','brand-name','email','client-website',
        'q1-business-description','q2-problem-transformation','q3-ideal-customer',
        'q3b-customer-desire','q4-competitors','q5-brand-personality','q6-positioning',
        'q-launch-context','q7-decision-maker-other','q8-brands-admired','q10-colors-to-avoid',
        'q11-aesthetic-description','q12-existing-assets','q16-anything-else'
      ];
      textFields.forEach(name => {
        if (sub[name] == null) return;
        const el = form.elements.namedItem(name);
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.value = sub[name];
        }
      });

      // Single-value radio fields
      ['q7-decision-maker','q14-budget'].forEach(name => {
        if (!sub[name]) return;
        const radios = form.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
        radios.forEach(r => { r.checked = r.value === sub[name]; });
      });

      // Multi-value checkbox fields
      ['q9-color','q11-aesthetic','q13-deliverables'].forEach(name => {
        const vals = Array.isArray(sub[name]) ? sub[name] : (sub[name] ? [sub[name]] : []);
        const checkboxes = form.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`);
        checkboxes.forEach(cb => { cb.checked = vals.includes(cb.value); });
      });

      // Delivery-date — now radio buttons, check the matching one
      if (sub['delivery-date']) {
        const deliveryRadio = form.querySelector(`input[type="radio"][name="delivery-date"][value="${CSS.escape(sub['delivery-date'])}"]`);
        if (deliveryRadio) deliveryRadio.checked = true;
      }

      // Sync checked state visual
      form.querySelectorAll('.check-label').forEach(lbl => {
        const inp = lbl.querySelector('input[type="checkbox"], input[type="radio"]');
        if (inp) lbl.classList.toggle('checked', inp.checked);
      });

      // Re-sync Q11 ranks
      syncQ11Ranks();

      // ── Pre-fill Q15 inspiration images ─────────────────────────────────
      // Restore previously uploaded images so the client can view, add, or
      // remove them. q15UploadedRefs / renderQ15Preview / syncQ15HiddenInputs
      // are all declared later in the same DOMContentLoaded scope; because
      // initEditMode is async and has already awaited the fetch above, those
      // declarations have already executed by the time we reach this point.
      const existingRefs = Array.isArray(sub['q15-inspiration-refs'])
        ? sub['q15-inspiration-refs']
        : (sub['q15-inspiration-refs'] ? [sub['q15-inspiration-refs']] : []);

      if (existingRefs.length > 0) {
        // Populate the module-level ref array used by upload/remove handlers
        q15UploadedRefs = existingRefs;
        // Render thumbnails with individual remove buttons
        renderQ15Preview();
        // Inject hidden inputs so existing refs survive a save with no changes
        syncQ15HiddenInputs();
      }
      // ── End Q15 pre-fill ─────────────────────────────────────────────────

      // Show edit mode banner, hide draft banner
      const editBanner = document.getElementById('editModeBanner');
      if (editBanner) editBanner.style.display = 'flex';

      // Update submit button label to "Save Changes"
      const submitBtn = document.getElementById('submitBtn');
      if (submitBtn) {
        submitBtn.innerHTML = window.i18n.t('form.cta.saveChanges', 'Save Changes') + ' &nbsp;→';
      }

      // Clean token from URL (security — don't leave token in history)
      window.history.replaceState({}, '', window.location.pathname);

    } catch (err) {
      console.error('Edit mode init failed:', err);
    }
  })();

  // ── Q11: ranked selection (no hard cap — selection order = priority) ────────
  function syncQ11Ranks() {
    const checkboxes = Array.from(form.querySelectorAll('input[type="checkbox"][name="q11-aesthetic"]'));
    let rank = 1;
    checkboxes.forEach(cb => {
      const badge = cb.closest('.check-label')?.querySelector('.rank-badge');
      if (!badge) return;
      if (cb.checked) {
        badge.textContent = rank++;
        badge.classList.add('visible');
      } else {
        badge.textContent = '';
        badge.classList.remove('visible');
      }
    });
  }

  form.querySelectorAll('input[type="checkbox"][name="q11-aesthetic"]').forEach(cb => {
    cb.addEventListener('change', syncQ11Ranks);
  });
  syncQ11Ranks(); // initial state

  // ── Q9 / Q13: clear validation error on first selection ────────────────────
  form.querySelectorAll('input[name="q9-color"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        document.getElementById('q9ValidationError')?.classList.remove('visible');
      }
    });
  });
  form.querySelectorAll('input[name="q13-deliverables"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) {
        document.getElementById('q13ValidationError')?.classList.remove('visible');
      }
    });
  });

  // Restore saved draft
  const hasDraft = loadDraft(form);
  showDraftBanner(hasDraft);

  // Sync custom selects after draft restoration
  document.querySelectorAll('.custom-select').forEach(wrapper => {
    const hidden = wrapper.parentElement.querySelector('input[type="hidden"]');
    const menu   = wrapper.querySelector('.custom-select-menu');
    const label  = wrapper.querySelector('.custom-select-label');
    if (hidden && hidden.value && menu && label) {
      const match = menu.querySelector(`li[data-value="${CSS.escape(hidden.value)}"]`);
      if (match) {
        match.setAttribute('aria-selected', 'true');
        label.textContent = match.textContent;
        label.classList.remove('placeholder');
      }
    }
  });

  // Auto-save: single debounced listener handles both input and change
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveDraft(form), 400);
  }
  form.addEventListener('input',  scheduleSave);
  form.addEventListener('change', scheduleSave);

  // Draft clear button — uses dedicated modal (no DOM mutation)
  const clearDraftBtn = document.getElementById('clearDraftBtn');
  const draftClearModal      = document.getElementById('draftClearModal');
  const draftClearConfirmBtn = document.getElementById('draftClearConfirmBtn');
  const draftClearCancelBtn  = document.getElementById('draftClearCancelBtn');

  if (clearDraftBtn && draftClearModal && draftClearConfirmBtn && draftClearCancelBtn) {
    clearDraftBtn.addEventListener('click', (e) => {
      e.preventDefault();
      draftClearModal.setAttribute('aria-hidden', 'false');
      draftClearModal.style.display = 'flex';
    });

    draftClearConfirmBtn.addEventListener('click', () => {
      clearDraft();
      form.reset();
      form.querySelectorAll('.check-label').forEach(lbl => lbl.classList.remove('checked'));
      draftClearModal.setAttribute('aria-hidden', 'true');
      draftClearModal.style.display = 'none';
    });

    draftClearCancelBtn.addEventListener('click', () => {
      draftClearModal.setAttribute('aria-hidden', 'true');
      draftClearModal.style.display = 'none';
    });

    draftClearModal.addEventListener('click', (e) => {
      if (e.target === draftClearModal) {
        draftClearModal.setAttribute('aria-hidden', 'true');
        draftClearModal.style.display = 'none';
      }
    });
  }

  // Checkbox and radio checked styling
  form.querySelectorAll('.check-label').forEach(label => {
    const input = label.querySelector('input[type="checkbox"], input[type="radio"]');
    if (!input) return;
    label.classList.toggle('checked', input.checked);
    input.addEventListener('change', () => {
      if (input.type === 'radio') {
        form.querySelectorAll(`input[type="radio"][name="${CSS.escape(input.name)}"]`).forEach(r => {
          r.closest('.check-label')?.classList.toggle('checked', r.checked);
        });
      } else {
        label.classList.toggle('checked', input.checked);
      }
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    // ── Custom validation: Q9 and Q13 must have at least one selection ───────
    const q9Checked  = form.querySelectorAll('input[name="q9-color"]:checked');
    const q13Checked = form.querySelectorAll('input[name="q13-deliverables"]:checked');

    const q9Error  = document.getElementById('q9ValidationError');
    const q13Error = document.getElementById('q13ValidationError');

    let validationFailed = false;

    if (q9Checked.length === 0) {
      if (q9Error) q9Error.classList.add('visible');
      q9Error?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      validationFailed = true;
    } else {
      if (q9Error) q9Error.classList.remove('visible');
    }

    if (q13Checked.length === 0) {
      if (q13Error) q13Error.classList.add('visible');
      if (!validationFailed) q13Error?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      validationFailed = true;
    } else {
      if (q13Error) q13Error.classList.remove('visible');
    }

    if (validationFailed) return;

    const submitButton = document.getElementById('submitBtn') || form.querySelector('button[type="submit"]');
    const originalHTML = submitButton ? submitButton.innerHTML : '';

    // ── Loading state ─────────────────────────────────────────────────────
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.setAttribute('data-loading', 'true');
      submitButton.innerHTML = window.i18n.t('messages.submitting', 'Submitting…');
    }

    try {
      // ── Turnstile verification ────────────────────────────────────────────
      // Skip turnstile in token-edit mode (already validated on first submit)
      if (!window.__editToken) {
        const turnstileInput = form.querySelector('input[name="cf-turnstile-response"]');
        const turnstileToken = turnstileInput ? turnstileInput.value.trim() : '';
        if (!turnstileToken) {
          await showAlert(
            window.i18n.t('messages.turnstileError', 'Please wait for the security check to complete, then try again.'),
            'error'
          );
          return;
        }
      }

      const formData = new FormData(form);
      formData.set('__requestOrigin', 'public-form');
      // Send the user's selected language so the server can translate emails and documents
      formData.set('__lang', window.i18n.getLanguage ? window.i18n.getLanguage() : (localStorage.getItem('preferred-language') || 'en'));

      // ── Token-based edit mode ─────────────────────────────────────────────
      if (window.__editToken) {
        formData.set('__editToken', window.__editToken);
        // Remove turnstile token from token-edit submissions (not needed)
        formData.delete('cf-turnstile-response');
      } else {
        // ── Normal mode: duplicate check ────────────────────────────────────
        const duplicateMatch = await checkDuplicateSubmission(formData);
        if (duplicateMatch) {
          const action = await askDuplicateSubmissionAction();
          if (action === 'cancel') return;
          formData.append('__submissionAction', action);
          if (action === 'override') {
            formData.append('__overrideSubmissionId', duplicateMatch.submissionId);
            formData.append('__editedBy', 'client');
            formData.append('editedBy', 'client');
          }
        }
      }

      const submitResult = await submitToSupabase(formData);

      clearDraft();

      // ── Show success to the user immediately — DB write is done ──────────
      if (window.__editToken) {
        window.__editToken = null;
        await showAlert(window.i18n.t('messages.editSuccess', 'Your edits have been saved and sent to Neatmark!'), 'success');
      } else {
        await showAlert(window.i18n.t('messages.submitSuccess', 'Thank you! Your form has been submitted and the files were emailed successfully.'), 'success');
      }

      // ── Fire email / PDF generation in the background (no await) ─────────
      // The send-emails function runs inside its own Netlify Lambda execution.
      // The client never waits for it — emails and documents arrive shortly after.
      if (submitResult && submitResult.record) {
        fetch('/.netlify/functions/send-emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            record:   submitResult.record,
            isEdit:   submitResult.isEdit   ?? false,
            editLink: submitResult.editLink ?? '',
            lang:     submitResult.lang     ?? (window.i18n.getLanguage ? window.i18n.getLanguage() : 'en')
          })
        }).catch(err => console.warn('[send-emails] Background call failed:', err));
      }

    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      await showAlert(window.i18n.t('messages.submitError', {error: message}) || `Submission failed: ${message}`, 'error');
      if (window.turnstile) window.turnstile.reset('#cfTurnstile');
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.removeAttribute('data-loading');
        submitButton.innerHTML = originalHTML;
      }
    }
  });

  // Clear button handler with confirmation modal
  const clearFormBtn = document.getElementById('clearFormBtn');
  const clearConfirmModal = document.getElementById('clearConfirmModal');
  const clearConfirmBtn = document.getElementById('clearConfirmBtn');
  const clearCancelBtn = document.getElementById('clearCancelBtn');

  if (clearFormBtn && clearConfirmModal && clearConfirmBtn && clearCancelBtn) {
    clearFormBtn.addEventListener('click', (e) => {
      e.preventDefault();
      clearConfirmModal.setAttribute('aria-hidden', 'false');
      clearConfirmModal.style.display = 'flex';
    });

    clearConfirmBtn.addEventListener('click', async () => {
      form.reset();
      clearDraft();
      // Fix: also strip visual "checked" state from radio/checkbox pills
      form.querySelectorAll('.check-label').forEach(lbl => lbl.classList.remove('checked'));
      clearConfirmModal.setAttribute('aria-hidden', 'true');
      clearConfirmModal.style.display = 'none';
      await showAlert(window.i18n.t('messages.clearSuccess', 'Form cleared. Your draft has been removed from your browser.'), 'success');
    });

    clearCancelBtn.addEventListener('click', () => {
      clearConfirmModal.setAttribute('aria-hidden', 'true');
      clearConfirmModal.style.display = 'none';
    });

    // Close modal when clicking outside
    clearConfirmModal.addEventListener('click', (e) => {
      if (e.target === clearConfirmModal) {
        clearConfirmModal.setAttribute('aria-hidden', 'true');
        clearConfirmModal.style.display = 'none';
      }
    });
  }

  // ── Q7: show "Please specify" textbox only when "Other" is selected ──
  const q7OtherInput = document.getElementById('q7OtherInput');
  const q7Radios = form.querySelectorAll('input[type="radio"][name="q7-decision-maker"]');
  function syncQ7Other() {
    if (!q7OtherInput) return;
    const otherSelected = Array.from(q7Radios).some(r => r.value === 'Other' && r.checked);
    q7OtherInput.style.display = otherSelected ? '' : 'none';
    if (!otherSelected) q7OtherInput.value = '';
  }
  q7Radios.forEach(r => r.addEventListener('change', syncQ7Other));
  syncQ7Other(); // initial state (also covers draft restore)
  // Re-sync after draft load (draft load runs before this, safe here)
  // ── End Q7 ────────────────────────────────────────────────────────────

  // ── Q15 inspiration image uploads ────────────────────────────────
  const q15Dropzone = document.getElementById('q15Dropzone');
  const q15FileInput = document.getElementById('q15FileInput');
  const q15PreviewGrid = document.getElementById('q15PreviewGrid');
  const MAX_Q15_IMAGES = 8;
  let q15UploadedRefs = [];

  function getQ15Count() {
    return q15UploadedRefs.length;
  }

  /**
   * Upload one inspiration photo.
   * Returns a JSON-stringified object: '{"smallRef":"…","originalRef":"…"}'
   * which is stored as a text entry in the q15-inspiration-refs text[] column.
   */
  async function uploadImageToStorage(file) {
    const base64 = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(String(reader.result).split(',')[1]);
      reader.onerror = () => rej(new Error('Read failed'));
      reader.readAsDataURL(file);
    });
    const response = await fetch('/.netlify/functions/upload-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, mimeType: file.type, contentBase64: base64 })
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => 'Upload failed');
      throw new Error(errText);
    }
    const result = await response.json();
    if (!result.smallRef || !result.originalRef) throw new Error('Upload response missing refs.');
    // Store as JSON string so both refs travel together through the text[] column
    return JSON.stringify({ smallRef: result.smallRef, originalRef: result.originalRef });
  }

  /**
   * Parse a stored ref entry — handles both new JSON format and legacy plain-string format.
   * Returns { smallRef, originalRef } or null if unparseable.
   */
  function parsePhotoRef(entry) {
    if (!entry) return null;
    try {
      const obj = typeof entry === 'string' ? JSON.parse(entry) : entry;
      if (obj && obj.smallRef) return obj;
    } catch (_) { /* fall through */ }
    // Legacy format: plain storage path string
    return { smallRef: entry, originalRef: entry };
  }

  function getSmallPhotoUrl(ref) {
    const parsed = parsePhotoRef(ref);
    if (!parsed) return '';
    return `/.netlify/functions/get-photo?bucket=small-photos&ref=${encodeURIComponent(parsed.smallRef)}`;
  }

  function renderQ15Preview() {
    if (!q15PreviewGrid) return;
    q15PreviewGrid.innerHTML = q15UploadedRefs.map((ref, i) => {
      const smallUrl = getSmallPhotoUrl(ref);
      return `
        <div class="q20-thumb-wrap">
          <img src="${smallUrl}" class="q20-thumb" alt="Inspiration ${i + 1}" />
          <button type="button" class="q20-remove-btn" data-index="${i}" aria-label="Remove image ${i + 1}">
            <i data-lucide="x" class="icon"></i>
          </button>
        </div>
      `;
    }).join('');

    q15PreviewGrid.querySelectorAll('.q20-remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        q15UploadedRefs.splice(idx, 1);
        renderQ15Preview();
        syncQ15HiddenInputs();
        if (window.lucide) window.lucide.createIcons();
      });
    });

    if (window.lucide) window.lucide.createIcons();
    if (q15Dropzone) q15Dropzone.style.display = getQ15Count() >= MAX_Q15_IMAGES ? 'none' : '';
  }

  function syncQ15HiddenInputs() {
    document.querySelectorAll('input[name="q15-inspiration-refs"]').forEach(el => el.remove());
    const form = document.querySelector('form[name="brand-intake"]');
    if (!form) return;
    // Each ref is a JSON string — stored as-is in the text[] column
    q15UploadedRefs.forEach(ref => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'q15-inspiration-refs';
      input.value = ref;
      form.appendChild(input);
    });
  }

  async function handleQ15Files(files) {
    const remaining = MAX_Q15_IMAGES - getQ15Count();
    const toUpload = Array.from(files).slice(0, remaining);

    // Show loading state on dropzone
    if (q15Dropzone) {
      q15Dropzone.classList.add('uploading');
      q15Dropzone.setAttribute('aria-busy', 'true');
    }

    let errorCount = 0;
    for (const file of toUpload) {
      const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
      if (!allowedTypes.has(file.type)) {
        errorCount++;
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        await showAlert(`"${file.name}" is too large. Max size is 5 MB.`, 'error');
        continue;
      }
      try {
        const ref = await uploadImageToStorage(file);
        q15UploadedRefs.push(ref);
        renderQ15Preview();
        syncQ15HiddenInputs();
      } catch (e) {
        console.error('Q15 upload failed', e);
        await showAlert(`Failed to upload "${file.name}". Please try again.`, 'error');
      }
    }

    if (errorCount > 0) {
      await showAlert(`${errorCount} file(s) skipped — only PNG, JPG, WEBP, and GIF are accepted.`, 'error');
    }

    // Remove loading state
    if (q15Dropzone) {
      q15Dropzone.classList.remove('uploading');
      q15Dropzone.removeAttribute('aria-busy');
    }
  }

  if (q15Dropzone && q15FileInput) {
    q15Dropzone.addEventListener('click', () => q15FileInput.click());
    q15Dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); q15FileInput.click(); } });
    q15FileInput.addEventListener('change', () => { if (q15FileInput.files) handleQ15Files(q15FileInput.files); });
    q15Dropzone.addEventListener('dragover', e => { e.preventDefault(); q15Dropzone.classList.add('dragging'); });
    q15Dropzone.addEventListener('dragleave', () => q15Dropzone.classList.remove('dragging'));
    q15Dropzone.addEventListener('drop', e => { e.preventDefault(); q15Dropzone.classList.remove('dragging'); if (e.dataTransfer && e.dataTransfer.files) handleQ15Files(e.dataTransfer.files); });
  }
  // Progress is handled by the stepper bar — no per-scroll bar needed.
  function updateProgress() { /* handled by wizard stepper */ }
  form.addEventListener('change', updateProgress);
  form.addEventListener('input',  updateProgress);
  window.addEventListener('languageChanged', updateProgress);
  // ── End progress ──────────────────────────────────────────────────────

});
