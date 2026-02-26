function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  updateThemeToggleIcon();
}

function updateThemeToggleIcon() {
  // Icons are handled via CSS based on the [data-theme] attribute.
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
  titleEl.textContent = isError ? 'Something went wrong' : 'Success';
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



// Custom branded confirm popup — replaces native confirm()
function showConfirm(message) {
  return new Promise(resolve => {
    // Reuse the alert overlay with two buttons
    const overlay = document.getElementById('customAlertOverlay');
    const msgEl = document.getElementById('customAlertMsg');
    const titleEl = document.getElementById('customAlertTitle');
    const iconWrap = document.getElementById('customAlertIconWrap');
    const icon = document.getElementById('customAlertIcon');
    const closeBtn = document.getElementById('customAlertCloseBtn');
    if (!overlay) { resolve(confirm(message)); return; }

    msgEl.textContent = message;
    titleEl.textContent = 'Are you sure?';
    iconWrap.className = 'custom-alert-icon-wrap error';
    icon.setAttribute('data-lucide', 'alert-triangle');
    if (window.lucide) window.lucide.createIcons();

    // Inject a cancel button temporarily
    closeBtn.textContent = 'Yes, clear it';
    closeBtn.className = 'custom-alert-close-btn error-btn';
    let cancelBtn = document.getElementById('customAlertCancelBtn');
    if (!cancelBtn) {
      cancelBtn = document.createElement('button');
      cancelBtn.id = 'customAlertCancelBtn';
      cancelBtn.type = 'button';
      cancelBtn.className = 'custom-alert-cancel-btn';
      cancelBtn.textContent = 'Keep draft';
      closeBtn.parentNode.insertBefore(cancelBtn, closeBtn);
    }
    cancelBtn.style.display = '';

    overlay.setAttribute('aria-hidden', 'false');
    overlay.classList.add('active');

    function cleanup(result) {
      overlay.classList.remove('active');
      overlay.setAttribute('aria-hidden', 'true');
      closeBtn.textContent = 'OK';
      closeBtn.className = 'custom-alert-close-btn';
      if (cancelBtn) cancelBtn.style.display = 'none';
      overlay.removeEventListener('click', onOverlayClick);
      closeBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onConfirm() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlayClick(e) { if (e.target === overlay) cleanup(false); }
    closeBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
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

    // Checkbox group (NodeList/RadioNodeList)
    if (Array.isArray(value)) {
      const checkboxes = form.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(key)}"]`);
      checkboxes.forEach(cb => {
        cb.checked = value.includes(cb.value);
      });
      continue;
    }

    // Single element
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

document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }

  /* ── Theme toggle ─────────────────────────────────── */
  const themeToggleButton = document.getElementById('themeToggle');
  if (themeToggleButton) {
    themeToggleButton.addEventListener('click', () => toggleTheme());
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

  // Listen for language changes
  if (!window.__languageChangedListenerBound) {
    window.addEventListener('languageChanged', (event) => {
      const lang = event?.detail?.language || window.i18n.getLanguage();
      syncLangUI(lang);
      updateThemeToggleIcon();
    });
    window.__languageChangedListenerBound = true;
  }

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

  // Auto-save on every input change
  let saveTimer = null;
  form.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveDraft(form), 400);
  });
  form.addEventListener('change', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveDraft(form), 400);
  });

  // Clear draft button
  const clearDraftBtn = document.getElementById('clearDraftBtn');
  if (clearDraftBtn) {
    clearDraftBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (await showConfirm('Clear your saved draft? All unsaved answers will be removed.')) {
        clearDraft();
        form.reset();
        // Reset checkbox/radio styling
        form.querySelectorAll('.check-label').forEach(label => {
          label.classList.remove('checked');
        });
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

    const submitButton = form.querySelector('button[type="submit"]');
    const originalLabel = submitButton ? submitButton.textContent : '';

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Submitting...';
    }

    try {
      const formData = new FormData(form);
      formData.set('__requestOrigin', 'public-form');

      const duplicateMatch = await checkDuplicateSubmission(formData);
      if (duplicateMatch) {
        const action = await askDuplicateSubmissionAction();

        if (action === 'cancel') {
          return;
        }

        formData.append('__submissionAction', action);

        if (action === 'override') {
          formData.append('__overrideSubmissionId', duplicateMatch.submissionId);
          formData.append('__editedBy', 'client');
          formData.append('editedBy', 'client');
        }
      }

      await submitToSupabase(formData);

      clearDraft();
      await showAlert(window.i18n.t('messages.submitSuccess'), 'success');
      // ✓ Form is NOT auto-reset here, user must click "Clear" button for explicit reset
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      await showAlert(window.i18n.t('messages.submitError', {error: message}), 'error');
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
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
      clearConfirmModal.setAttribute('aria-hidden', 'true');
      clearConfirmModal.style.display = 'none';
      await showAlert(window.i18n.t('messages.clearSuccess'), 'success');
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
    for (const file of toUpload) {
      const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
      if (!allowedTypes.has(file.type)) continue;
      if (file.size > 5 * 1024 * 1024) continue;
      try {
        const ref = await uploadImageToStorage(file);
        q15UploadedRefs.push(ref);
        renderQ15Preview();
        syncQ15HiddenInputs();
      } catch (e) { console.error('Q15 upload failed', e); }
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
  // ── End Q15 ──────────────────────────────────────────────────────
});
