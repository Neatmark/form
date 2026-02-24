let allSubmissions = [];
let sortAscending = false;
let sortMode = 'date-desc'; // date-desc | date-asc | name-asc | name-desc | delivery-asc | delivery-desc
let currentSubmission = null;
let selectedSubmissionIds = new Set();
let currentRenderedSubmissions = [];
let searchDebounceTimer = null;
let isSortApplied = false;
let openCardExportSubmissionId = null;
let isEditingSubmission = false;
let editDraftData = null;
let editOriginalData = null;
let editValidationErrors = {};
let pendingLogoFile = null;
let pendingLogoObjectUrl = '';
let removeExistingLogo = false;
let editDirty = false;
const host = String(window.location.hostname || '').toLowerCase();
const isLocalDashboardMode = host === 'localhost' || host === '127.0.0.1' || String(window.location.port || '') === '8888';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const dayjsLib = window.dayjs;
if (dayjsLib && window.dayjs_plugin_relativeTime) {
  dayjsLib.extend(window.dayjs_plugin_relativeTime);
}

function extractHistoryDateValue(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const candidates = [
    entry.date,
    entry.createdAt,
    entry.timestamp,
    entry.submittedAt
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') {
      return String(candidate).trim();
    }
  }

  return null;
}

function parseHistoryDate(entry, contextLabel) {
  const rawDate = extractHistoryDateValue(entry);
  if (!rawDate) {
    console.warn(`[history] Missing date value for ${contextLabel}`, entry);
    return null;
  }

  if (dayjsLib) {
    const parsedWithDayjs = dayjsLib(rawDate);
    if (parsedWithDayjs.isValid()) {
      return new Date(parsedWithDayjs.valueOf());
    }
  }

  const parsedNative = new Date(rawDate);
  if (!Number.isNaN(parsedNative.getTime())) {
    return parsedNative;
  }

  console.warn(`[history] Unparseable date value "${rawDate}" for ${contextLabel}`, entry);
  return null;
}

function toFriendlyDate(dateValue) {
  if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) {
    return 'Unknown date';
  }

  if (dayjsLib) {
    const parsed = dayjsLib(dateValue);
    if (parsed.isValid()) {
      return parsed.format('MMMM D, YYYY - h:mm A');
    }
  }

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(dateValue).replace(',', ' -');
}

function toRelativeDate(dateValue) {
  if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) {
    return 'Unknown time';
  }

  if (dayjsLib && dayjsLib().isValid()) {
    const parsed = dayjsLib(dateValue);
    if (parsed.isValid()) {
      return parsed.fromNow();
    }
  }

  const diffMs = dateValue.getTime() - Date.now();
  const diffSeconds = Math.round(diffMs / 1000);
  const absSeconds = Math.abs(diffSeconds);

  if (absSeconds < 10) {
    return 'just now';
  }

  const steps = [
    { unit: 'year', seconds: 31536000 },
    { unit: 'month', seconds: 2592000 },
    { unit: 'week', seconds: 604800 },
    { unit: 'day', seconds: 86400 },
    { unit: 'hour', seconds: 3600 },
    { unit: 'minute', seconds: 60 }
  ];

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const step of steps) {
    if (absSeconds >= step.seconds) {
      const value = Math.round(diffSeconds / step.seconds);
      return formatter.format(value, step.unit);
    }
  }

  return formatter.format(diffSeconds, 'second');
}

function isValidDateObject(dateValue) {
  return dateValue instanceof Date && !Number.isNaN(dateValue.getTime());
}

function normalizeHistoryEntries(historyEntries) {
  if (!Array.isArray(historyEntries)) {
    return [];
  }

  return [...historyEntries]
    .map((entry, index) => {
      const rawLabel = String(entry?.label || '').toLowerCase();
      const label = rawLabel === 'edited' ? 'edited' : 'original';
      const rawEditedBy = String(entry?.editedBy || '').toLowerCase();
      const editedBy = rawEditedBy === 'admin' || rawEditedBy === 'client' ? rawEditedBy : 'unknown';
      const parsedDate = parseHistoryDate(entry, `history[${index}]`);

      return {
        label,
        editedBy,
        parsedDate,
        sortKey: isValidDateObject(parsedDate) ? parsedDate.getTime() : Number.MAX_SAFE_INTEGER,
        fallbackOrder: index
      };
    })
    .sort((a, b) => {
      if (a.sortKey !== b.sortKey) {
        return a.sortKey - b.sortKey;
      }
      return a.fallbackOrder - b.fallbackOrder;
    });
}

function renderHistoryTimeline(historyEntries, options = {}) {
  const isLoading = Boolean(options.isLoading);
  if (isLoading) {
    return `
      <div class="response-item history-item">
        <div class="response-label">History</div>
        <div class="history-skeleton" aria-hidden="true">
          <div class="history-skeleton-line"></div>
          <div class="history-skeleton-line short"></div>
          <div class="history-skeleton-line"></div>
        </div>
      </div>
    `;
  }

  const timeline = normalizeHistoryEntries(historyEntries);
  if (timeline.length === 0) {
    return `
      <div class="response-item history-item">
        <div class="response-label">History</div>
        <div class="history-empty">No history data available.</div>
      </div>
    `;
  }

  const latestIndex = timeline.length - 1;
  const itemsMarkup = timeline.map((entry, index) => {
    const isOriginal = entry.label === 'original';
    const isLatest = index === latestIndex;
    const badgeText = isOriginal ? 'Original Submission' : 'Edited';
    const editedByText = entry.editedBy === 'admin'
      ? 'By Admin'
      : entry.editedBy === 'client'
        ? 'By Client'
        : 'Unknown';
    const editedByIconName = entry.editedBy === 'admin'
      ? 'shield'
      : entry.editedBy === 'client'
        ? 'user'
        : 'help-circle';

    return `
      <li class="history-node${isLatest ? ' latest' : ''}">
        <div class="history-marker${isOriginal ? ' original' : ''}"></div>
        <div class="history-content">
          <div class="history-head">
            <span class="history-badge ${isOriginal ? 'original' : 'edited'}">${badgeText}</span>
            <span class="history-attribution ${entry.editedBy}">
              <span aria-hidden="true"><i data-lucide="${editedByIconName}" class="icon icon-btn"></i></span>
              <span>${editedByText}</span>
            </span>
            ${isLatest ? '<span class="history-latest-tag">Latest</span>' : ''}
          </div>
          <div class="history-date">${escapeHtml(toFriendlyDate(entry.parsedDate))}</div>
          <div class="history-relative">${escapeHtml(toRelativeDate(entry.parsedDate))}</div>
        </div>
      </li>
    `;
  }).join('');

  const singleEntryNote = timeline.length === 1
    ? '<div class="history-single-note">No edits yet, this is the original submission.</div>'
    : '';

  return `
    <div class="response-item history-item">
      <div class="response-label">History</div>
      <div class="history-timeline-wrap">
        <ol class="history-timeline">${itemsMarkup}</ol>
        ${singleEntryNote}
      </div>
    </div>
  `;
}

function isWithinRelativeDateRange(date, range) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return false;
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (range === 'today') {
    return date >= startOfToday;
  }

  if (range === 'last7') {
    const since = new Date(startOfToday);
    since.setDate(since.getDate() - 6);
    return date >= since;
  }

  if (range === 'last30') {
    const since = new Date(startOfToday);
    since.setDate(since.getDate() - 29);
    return date >= since;
  }

  if (range === 'thisMonth') {
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  }

  if (range === 'lastMonth') {
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return date.getFullYear() === lastMonthDate.getFullYear() && date.getMonth() === lastMonthDate.getMonth();
  }

  return true;
}

function getFilteredSubmissions() {
  const searchBox = document.getElementById('searchBox');
  const query = (searchBox && searchBox.value ? searchBox.value : '').toLowerCase().trim();
  const selectedRange = document.querySelector('.date-filter-option[aria-selected="true"]')?.dataset.value || 'all';

  return allSubmissions.filter(submission => {
    const data = submission.data || {};
    const searchText = [
      data['brand-name'],
      data['client-name'],
      data['email']
    ].join(' ').toLowerCase();

    if (query.length > 0 && !searchText.includes(query)) {
      return false;
    }

    const createdAt = new Date(submission.created_at);
    return isWithinRelativeDateRange(createdAt, selectedRange);
  });
}

function applyCurrentFiltersAndRender() {
  let submissions = getFilteredSubmissions();

  if (isSortApplied) {
    submissions = [...submissions].sort((a, b) => {
      if (sortMode === 'date-asc' || sortMode === 'date-desc') {
        const dateA = new Date(a.created_at);
        const dateB = new Date(b.created_at);
        return sortMode === 'date-asc' ? dateA - dateB : dateB - dateA;
      }
      if (sortMode === 'name-asc' || sortMode === 'name-desc') {
        const nameA = String(a.data?.['brand-name'] || '').toLowerCase();
        const nameB = String(b.data?.['brand-name'] || '').toLowerCase();
        const cmp = nameA.localeCompare(nameB);
        return sortMode === 'name-asc' ? cmp : -cmp;
      }
      if (sortMode === 'delivery-asc' || sortMode === 'delivery-desc') {
        const dA = new Date(a.data?.['delivery-date'] || '9999-12-31').getTime();
        const dB = new Date(b.data?.['delivery-date'] || '9999-12-31').getTime();
        return sortMode === 'delivery-asc' ? dA - dB : dB - dA;
      }
      return 0;
    });
  }

  renderSubmissions(submissions);
}

async function deleteSubmissionById(submissionId, token) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch('/.netlify/functions/delete-submission', {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ submissionId })
  });

  return response.ok;
}

if (window.netlifyIdentity) {
  if (isLocalDashboardMode) {
    showDashboard();
    loadSubmissions();
  }

  window.netlifyIdentity.on('init', user => {
    if (isLocalDashboardMode) {
      showDashboard();
      loadSubmissions();
      return;
    }

    if (user) {
      showDashboard();
      loadSubmissions();
    } else {
      showLogin();
    }
  });

  window.netlifyIdentity.on('login', () => {
    if (isLocalDashboardMode) {
      showDashboard();
      loadSubmissions();
      return;
    }

    showDashboard();
    loadSubmissions();
  });

  window.netlifyIdentity.on('logout', () => {
    if (isLocalDashboardMode) {
      showDashboard();
      return;
    }

    showLogin();
  });
} else if (isLocalDashboardMode) {
  showDashboard();
  loadSubmissions();
}

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('dashboardScreen').style.display = 'none';
}

function showDashboard() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboardScreen').style.display = 'block';
}

async function loadSubmissions() {
  const container = document.getElementById('submissionsContainer');
  container.innerHTML = '<div class="loading">Loading submissions...</div>';

  try {
    let token = null;

    if (!isLocalDashboardMode && window.netlifyIdentity) {
      const user = netlifyIdentity.currentUser();
      if (!user) {
        throw new Error('Not authenticated');
      }
      token = await user.jwt();
    }

    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const response = await fetch(`/.netlify/functions/get-submissions?ts=${Date.now()}`, {
      headers,
      cache: 'no-store'
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Unauthorized');
      }
      if (response.status === 403) {
        throw new Error('Forbidden');
      }
      throw new Error('Failed to fetch submissions');
    }

    const data = await response.json();
    allSubmissions = data.submissions || [];
    const validIds = new Set(allSubmissions.map(s => String(s.id)));
    selectedSubmissionIds = new Set([...selectedSubmissionIds].filter(id => validIds.has(id)));

    updateStats();
    applyCurrentFiltersAndRender();
  } catch (error) {
    console.error('Error loading submissions:', error);
    const message = error instanceof Error ? error.message : 'Failed to load submissions';
    if (message === 'Forbidden') {
      container.innerHTML = '<div class="empty"><strong>Access denied.</strong> Ask the site admin to add your email to ADMIN_EMAILS.</div>';
      return;
    }
    if (message === 'Unauthorized') {
      container.innerHTML = '<div class="empty"><strong>Your session expired.</strong> Please log in again.</div>';
      return;
    }
    container.innerHTML = '<div class="empty"><strong>Failed to load submissions.</strong> Please try again.</div>';
  }
}

function updateStats() {
  const totalCountEl = document.getElementById('totalCount');
  const withDeliveryEl = document.getElementById('withDeliveryCount');
  const latestSubmissionEl = document.getElementById('latestSubmissionDate');
  const latestSubmissionShortEl = document.getElementById('latestSubmissionDateShort');

  const total = allSubmissions.length;
  const withDelivery = allSubmissions.filter(hasDeliveryDate).length;

  let latestText = '-';
  let latestShort = '-';
  if (total > 0) {
    const latestSubmission = [...allSubmissions].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const latestDate = new Date(latestSubmission.created_at);
    if (!Number.isNaN(latestDate.getTime())) {
      latestText = toFriendlyDate(latestDate);
      const mo = latestDate.toLocaleDateString('en-US', { month: 'short' });
      const day = latestDate.getDate();
      const h = latestDate.getHours();
      const ampm = h >= 12 ? 'pm' : 'am';
      const h12 = h % 12 || 12;
      const min = String(latestDate.getMinutes()).padStart(2, '0');
      latestShort = `${mo} ${day} · ${h12}:${min}${ampm}`;
    } else {
      latestText = 'Unknown';
      latestShort = '?';
    }
  }

  if (totalCountEl) totalCountEl.textContent = String(total);
  if (withDeliveryEl) withDeliveryEl.textContent = String(withDelivery);
  if (latestSubmissionEl) {
    latestSubmissionEl.textContent = latestText;
    latestSubmissionEl.dataset.short = latestShort;
  }
  if (latestSubmissionShortEl) {
    latestSubmissionShortEl.textContent = latestShort;
  }
}

/**
 * Renders the Q6 personality spectrum group as a single card with 4 spectrum rows.
 * @param {Object} q6Values - Map of Q6 keys to their values (e.g., { 'q6-playful-serious': '3', ... })
 * @param {boolean} isEditMode - Whether the panel is in edit mode
 * @returns {string} HTML string for the Q6 grouped card
 */
function renderQ6SpectrumGroup(q6Values, isEditMode = false) {
  const spectrumDefs = [
    { key: 'q6-playful-serious', leftLabel: 'Playful', rightLabel: 'Serious' },
    { key: 'q6-minimalist-expressive', leftLabel: 'Minimalist', rightLabel: 'Expressive' },
    { key: 'q6-approachable-authoritative', leftLabel: 'Approachable', rightLabel: 'Authoritative' },
    { key: 'q6-classic-contemporary', leftLabel: 'Classic', rightLabel: 'Contemporary' }
  ];

  if (isEditMode) {
    const editRows = spectrumDefs.map(({ key, leftLabel, rightLabel }) => {
      const rawValue = q6Values[key];
      const value = Number(rawValue) || 3;

      const buttons = [1, 2, 3, 4, 5].map(n => {
        const isActive = n === value;
        return `<button type="button" class="q6-num-btn${isActive ? ' active' : ''}" data-edit-key="${escapeHtml(key)}" data-val="${n}">${n}</button>`;
      }).join('');

      return `
        <div class="q6-num-row q6-edit-row">
          <div class="q6-num-left-label">${escapeHtml(leftLabel)}</div>
          <div class="q6-num-buttons">${buttons}</div>
          <div class="q6-num-right-label">${escapeHtml(rightLabel)}</div>
        </div>
      `;
    }).join('');

    return `
      <article class="qa-card q6-spectrum-card">
        <div class="qa-label-row"><span class="qa-num-badge">06</span><span class="qa-label-text">Personality Spectrums</span></div>
        <div class="q6-hint">1 = far left, 5 = far right</div>
        <div class="q6-spectrums q6-edit-spectrums">${editRows}</div>
      </article>
    `;
  }

  // View mode: render both desktop slider and mobile numbered buttons (CSS shows the right one)
  const spectrumRowsHtml = spectrumDefs.map(({ key, leftLabel, rightLabel }) => {
    const rawValue = q6Values[key];
    const value = Number(rawValue) || 3;
    const hasResponse = Boolean(rawValue && !Number.isNaN(Number(rawValue)));
    const labelClass = hasResponse ? '' : ' no-response';
    const percentage = ((value - 1) / 4) * 100;
    const displayValue = hasResponse ? value : 'N/A';

    // Desktop: slider row
    const sliderRow = `
      <div class="scale-row q6-desktop-row">
        <div class="scale-end${labelClass}">${escapeHtml(leftLabel)}</div>
        <div class="scale-slider">
          <div class="q6-track">
            <div class="q6-fill" style="width: ${percentage}%;"></div>
            <div class="q6-thumb" style="left: ${percentage}%;"></div>
          </div>
          <div class="scale-value${labelClass}">${displayValue}</div>
        </div>
        <div class="scale-end right${labelClass}">${escapeHtml(rightLabel)}</div>
      </div>
    `;

    // Mobile: numbered button row
    const buttons = [1, 2, 3, 4, 5].map(n => {
      const isActive = hasResponse && n === value;
      return `<button class="q6-num-btn${isActive ? ' active' : ''}" disabled aria-label="${n}">${n}</button>`;
    }).join('');
    const numRow = `
      <div class="q6-num-row q6-mobile-row">
        <div class="q6-num-left-label">${escapeHtml(leftLabel)}</div>
        <div class="q6-num-buttons">${buttons}</div>
        <div class="q6-num-right-label">${escapeHtml(rightLabel)}</div>
      </div>
    `;

    return sliderRow + numRow;
  }).join('');

  return `
    <article class="qa-card q6-spectrum-card">
      <div class="qa-label-row"><span class="qa-num-badge">06</span><span class="qa-label-text">Personality Spectrums</span></div>
      <div class="q6-hint">1 = far left, 5 = far right</div>
      <div class="q6-spectrums">
        ${spectrumRowsHtml}
      </div>
    </article>
  `;
}

function getDisplayValue(rawValue) {
  if (Array.isArray(rawValue)) {
    const joined = rawValue.filter(Boolean).join(', ').trim();
    return joined.length > 0 ? joined : null;
  }

  const text = String(rawValue ?? '').trim();
  return text.length > 0 ? text : null;
}

function formatDeliveryDateForOverview(rawValue) {
  const value = getDisplayValue(rawValue);
  if (!value) {
    return '<span class="overview-empty-badge">Not specified</span>';
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return escapeHtml(toFriendlyDate(parsed));
  }

  return escapeHtml(value);
}

function buildBrandInitials(brandName) {
  const value = String(brandName || '').trim();
  if (!value) {
    return 'N';
  }

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0].slice(0, 1).toUpperCase();
  }

  return (words[0].slice(0, 1) + words[1].slice(0, 1)).toUpperCase();
}

function sectionHeader(icon, title) {
  return `
    <div class="detail-section-head">
      <span class="detail-section-icon" aria-hidden="true">
        <i data-lucide="${icon}" class="icon icon-section"></i>
      </span>
      <h3 class="detail-section-title">${title}</h3>
    </div>
  `;
}

function isQuestionnaireKey(key) {
  return /^q\d+-/i.test(key);
}

function hasDeliveryDate(submission) {
  return Boolean(getDisplayValue(submission?.data?.['delivery-date']));
}

function hasAnyQuestionnaireResponse(submission) {
  const data = submission?.data || {};
  const questionnaireEntries = Object.entries(data).filter(([key]) => isQuestionnaireKey(key));
  return questionnaireEntries.some(([, value]) => Boolean(getDisplayValue(value)));
}

function hasActiveFilters() {
  const searchBox = document.getElementById('searchBox');
  const query = String(searchBox?.value || '').trim();
  const range = document.querySelector('.date-filter-option[aria-selected="true"]')?.dataset.value || 'all';
  return query.length > 0 || range !== 'all';
}

function updateExportButtonLabel() {
  const exportBtn = document.getElementById('exportBtn');
  if (!exportBtn) return;

  const labelEl = exportBtn.querySelector('.btn-label');
  const countEl = exportBtn.querySelector('.btn-count');
  if (!labelEl) return;

  const visibleCount = currentRenderedSubmissions.length;
  if (hasActiveFilters()) {
    labelEl.textContent = `Export filtered (${visibleCount}) ▾`;
    if (countEl) countEl.textContent = `(${visibleCount}) ▾`;
    return;
  }

  labelEl.textContent = `Export visible (${visibleCount}) ▾`;
  if (countEl) countEl.textContent = `(${visibleCount}) ▾`;
}

function questionnaireSortKey(key) {
  const match = String(key).match(/^q(\d+)-/i);
  if (!match) {
    return { group: Number.MAX_SAFE_INTEGER, key };
  }

  return {
    group: Number(match[1]),
    key
  };
}

function getLogoRefFromData(data) {
  return String(data?.['brand-logo-ref'] || '').trim();
}

function getLogoUrlFromRef(logoRef) {
  const ref = String(logoRef || '').trim();
  if (!ref) return '';
  return `/.netlify/functions/get-logo?ref=${encodeURIComponent(ref)}`;
}

function cloneSubmissionData(data) {
  return Object.entries(data || {}).reduce((accumulator, [key, value]) => {
    if (Array.isArray(value)) {
      accumulator[key] = [...value];
    } else {
      accumulator[key] = value;
    }
    return accumulator;
  }, {});
}

function markEditDirty() {
  editDirty = true;
}

function resetEditState() {
  if (pendingLogoObjectUrl) {
    URL.revokeObjectURL(pendingLogoObjectUrl);
    pendingLogoObjectUrl = '';
  }
  isEditingSubmission = false;
  editDraftData = null;
  editOriginalData = null;
  editValidationErrors = {};
  pendingLogoFile = null;
  removeExistingLogo = false;
  editDirty = false;
}

function isValidEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateEditData(data) {
  const errors = {};
  if (!getDisplayValue(data['client-name'])) {
    errors['client-name'] = 'Client name is required.';
  }
  if (!getDisplayValue(data['brand-name'])) {
    errors['brand-name'] = 'Brand name is required.';
  }
  const email = getDisplayValue(data.email);
  if (!email) {
    errors.email = 'Email is required.';
  } else if (!isValidEmail(email)) {
    errors.email = 'Please enter a valid email address.';
  }
  return errors;
}

async function uploadLogoFile(file) {
  const contentBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read logo file.'));
    reader.readAsDataURL(file);
  });

  const response = await fetch('/.netlify/functions/upload-logo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type,
      contentBase64
    })
  });

  if (!response.ok) {
    let errorMsg = 'Failed to upload logo.';
    try {
      const errorJson = await response.json();
      errorMsg = errorJson.error || errorMsg;
    } catch (_) {
      const errorText = await response.text();
      errorMsg = errorText || errorMsg;
    }
    throw new Error(errorMsg);
  }

  const result = await response.json();
  return String(result.logoRef || '');
}

async function setSubmissionStatus(submissionId, status) {
  try {
    const response = await fetch('/.netlify/functions/submit-form', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        __submissionAction: 'override',
        __overrideSubmissionId: submissionId,
        __editedBy: 'admin',
        editedBy: 'admin',
        status
      })
    });
    if (!response.ok) throw new Error('Failed to update status');
    const result = await response.json();
    const updatedSubmission = result.submission;
    if (updatedSubmission) {
      allSubmissions = allSubmissions.map(item => String(item.id) === String(updatedSubmission.id) ? updatedSubmission : item);
      currentSubmission = updatedSubmission;
    } else {
      // Patch locally
      if (currentSubmission) {
        currentSubmission = { ...currentSubmission, data: { ...currentSubmission.data, status } };
      }
      allSubmissions = allSubmissions.map(item => String(item.id) === String(submissionId) ? { ...item, data: { ...item.data, status } } : item);
    }
    applyCurrentFiltersAndRender();
    renderDetailPanel();
  } catch (error) {
    console.error('setSubmissionStatus failed:', error);
    alert('Failed to update status. Please try again.');
  }
}

function setModalActionButtons(mode) {
  const modalActions = document.getElementById('modalActions');
  const modalEditIconBtn = document.getElementById('modalEditIconBtn');
  const modalDeleteIconBtn = document.getElementById('modalDeleteIconBtn');
  if (!modalActions) return;

  if (mode === 'edit') {
    // Hide header icon buttons while editing
    if (modalEditIconBtn) modalEditIconBtn.style.display = 'none';
    if (modalDeleteIconBtn) modalDeleteIconBtn.style.display = 'none';
    modalActions.innerHTML = `
      <button class="btn" id="cancelEditBtn">Cancel</button>
      <button class="btn btn-primary" id="saveEditBtn">Save Changes</button>
    `;

    // Add cancel icon button to header
    const headerActions = document.getElementById('modalHeaderActions');
    let cancelIconBtn = document.getElementById('modalCancelIconBtn');
    if (!cancelIconBtn && headerActions) {
      cancelIconBtn = document.createElement('button');
      cancelIconBtn.id = 'modalCancelIconBtn';
      cancelIconBtn.className = 'modal-icon-btn modal-cancel-icon-btn';
      cancelIconBtn.setAttribute('aria-label', 'Cancel editing');
      cancelIconBtn.innerHTML = '<i data-lucide="rotate-ccw" class="icon icon-btn"></i>';
      const closeBtn = document.getElementById('modalCloseBtn');
      closeBtn?.parentNode?.insertBefore(cancelIconBtn, closeBtn);
    }
    if (cancelIconBtn) cancelIconBtn.style.display = '';
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // view mode: show header icon buttons, clear modal-actions, hide cancel icon
  if (modalEditIconBtn) modalEditIconBtn.style.display = '';
  if (modalDeleteIconBtn) modalDeleteIconBtn.style.display = '';
  const cancelIconBtn = document.getElementById('modalCancelIconBtn');
  if (cancelIconBtn) cancelIconBtn.style.display = 'none';

  // Render approve/reject buttons based on current status
  const status = currentSubmission?.data?.status || 'pending';
  let statusButtons = '';
  if (status !== 'approved') {
    statusButtons += `<button class="btn btn-approve" id="approveBtn"><i data-lucide="check-circle" class="icon icon-btn"></i> Approve</button>`;
  }
  if (status !== 'rejected') {
    statusButtons += `<button class="btn btn-reject" id="rejectBtn"><i data-lucide="x-circle" class="icon icon-btn"></i> Reject</button>`;
  }
  modalActions.innerHTML = statusButtons;
}

function syncDraftFromInputs() {
  if (!isEditingSubmission || !editDraftData) return;
  const modalBody = document.getElementById('modalBody');
  if (!modalBody) return;

  const inputElements = modalBody.querySelectorAll('[data-edit-key]');
  inputElements.forEach(element => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
    const key = String(element.getAttribute('data-edit-key') || '');
    if (!key) return;
    editDraftData[key] = element.value;
  });
}

function renderSubmissions(submissions) {
  const container = document.getElementById('submissionsContainer');
  currentRenderedSubmissions = submissions;
  updateSelectionToolbar();
  updateExportButtonLabel();

  if (submissions.length === 0) {
    container.innerHTML = `
      <div class="empty-state" role="status" aria-live="polite">
        <div class="empty-state-icon" aria-hidden="true">
          <i data-lucide="inbox" class="icon icon-stat"></i>
        </div>
        <div class="empty-state-title">No submissions found</div>
        <div class="empty-state-copy">Try adjusting your search or date filter.</div>
        <button class="btn empty-state-action" id="clearFiltersBtn">Clear filters</button>
      </div>
    `;
    const clearFiltersBtn = document.getElementById('clearFiltersBtn');
    clearFiltersBtn?.addEventListener('click', () => {
      const searchBox = document.getElementById('searchBox');
      if (searchBox instanceof HTMLInputElement) {
        searchBox.value = '';
      }
      // Reset custom date filter dropdown
      const dfMenu = document.getElementById('dateFilterMenu');
      const dfLabel = document.getElementById('dateFilterLabel');
      if (dfMenu) {
        dfMenu.querySelectorAll('.date-filter-option').forEach(o => {
          o.classList.remove('active');
          o.setAttribute('aria-selected', 'false');
        });
        const allOpt = dfMenu.querySelector('[data-value="all"]');
        if (allOpt) { allOpt.classList.add('active'); allOpt.setAttribute('aria-selected', 'true'); }
        if (dfLabel) dfLabel.textContent = 'All dates';
      }
      applyCurrentFiltersAndRender();
    });
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'submissions-grid';

  submissions.forEach(submission => {
    const data = submission.data || {};
    const submissionId = String(submission.id);
    const isSelected = selectedSubmissionIds.has(submissionId);
    const escapedSubmissionId = escapeHtml(submissionId);
    const brandName = escapeHtml(data['brand-name'] || 'Unknown Brand');
    const clientName = escapeHtml(data['client-name'] || 'Unknown Client');
    const email = escapeHtml(data['email'] || 'N/A');
    const submissionStatus = String(data['status'] || 'pending').toLowerCase();
    const statusLabel = submissionStatus === 'approved' ? 'Approved' : submissionStatus === 'rejected' ? 'Rejected' : 'Pending';
    const statusBadge = `<span class="status-badge ${submissionStatus}">${statusLabel}</span>`;
    const agreedDeliveryRaw = getDisplayValue(data['agreed-delivery-date']);
    const deliveryRaw = getDisplayValue(data['delivery-date']);
    let deliveryDisplay;
    let deliveryLabel;
    if (agreedDeliveryRaw) {
      deliveryDisplay = escapeHtml(agreedDeliveryRaw);
      deliveryLabel = 'Agreed';
    } else if (deliveryRaw) {
      deliveryDisplay = `${escapeHtml(deliveryRaw)} <span class="delivery-proposed-tag">Proposed</span>`;
      deliveryLabel = 'Delivery';
    } else {
      deliveryDisplay = '<span class="delivery-badge-not-set">Not set</span>';
      deliveryLabel = 'Delivery';
    }
    const avatarInitials = escapeHtml(buildBrandInitials(data['brand-name'] || 'Unknown Brand'));
    const logoRef = getLogoRefFromData(data);
    const logoUrl = logoRef ? getLogoUrlFromRef(logoRef) : '';
    const avatarContent = logoUrl
      ? `<img src="${escapeHtml(logoUrl)}" alt="${brandName} logo" class="submission-avatar-image">`
      : `<span class="submission-avatar-fallback">${avatarInitials}</span>`;
    const card = document.createElement('div');
    card.className = `submission-card${isSelected ? ' selected' : ''}${hasDeliveryDate(submission) ? ' delivery-set' : ''}`;
    card.addEventListener('click', () => showDetails(submission));

    const date = new Date(submission.created_at);
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    const timeStr = date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    });
    const relativeTime = escapeHtml(toRelativeDate(date));
    const exportMenuOpen = openCardExportSubmissionId === submissionId;

    card.innerHTML = `
      <div class="submission-header">
        <div class="submission-main">
          <div class="avatar-wrap">
            <div class="submission-avatar">
              ${avatarContent}
            </div>
            <label class="select-control" aria-label="Select submission ${brandName}">
              <input type="checkbox" class="submission-select" data-submission-id="${escapedSubmissionId}" ${isSelected ? 'checked' : ''}>
            </label>
          </div>
          <div>
            <div class="submission-brand">${brandName} ${statusBadge}</div>
            <div class="submission-client">${clientName}</div>
          </div>
        </div>
        <div class="submission-meta">
          <div class="submission-date" title="${relativeTime}">${dateStr} · ${timeStr}</div>
          <button class="card-edit-btn" aria-label="Edit submission ${brandName}">
            <i data-lucide="pen" class="icon icon-btn"></i>
            <span class="card-btn-label">Edit</span>
          </button>
          <div class="card-export">
            <button class="card-export-btn" aria-haspopup="menu" aria-expanded="${exportMenuOpen ? 'true' : 'false'}" aria-label="Export submission ${brandName}">
              <i data-lucide="download" class="icon icon-btn"></i>
              <span class="card-btn-label">Export</span>
            </button>
            <div class="card-export-menu${exportMenuOpen ? ' open' : ''}" role="menu">
              <button class="card-export-option" data-format="md" role="menuitem">Markdown (.md)</button>
              <button class="card-export-option" data-format="pdf" role="menuitem">PDF (.pdf)</button>
              <button class="card-export-option" data-format="docx" role="menuitem">Word (.docx)</button>
              <button class="card-export-option" data-format="csv" role="menuitem">CSV (.csv)</button>
            </div>
          </div>
        </div>
      </div>
      <div class="submission-details">
        <div class="detail-item">
          <div class="detail-label">Email</div>
          <div class="detail-value">${email}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">${deliveryLabel}</div>
          <div class="detail-value">${deliveryDisplay}</div>
        </div>
      </div>
    `;

    const selectControl = card.querySelector('.select-control');
    const selectInput = card.querySelector('.submission-select');
    if (selectControl && selectInput) {
      selectControl.addEventListener('click', e => {
        e.stopPropagation();
      });
      selectInput.addEventListener('change', e => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.checked) {
          selectedSubmissionIds.add(submissionId);
        } else {
          selectedSubmissionIds.delete(submissionId);
        }
        card.classList.toggle('selected', target.checked);
        updateSelectionToolbar();
      });
    }

    const cardExport = card.querySelector('.card-export');
    const cardExportBtn = card.querySelector('.card-export-btn');
    const cardEditBtn = card.querySelector('.card-edit-btn');
    if (cardEditBtn instanceof HTMLButtonElement) {
      cardEditBtn.addEventListener('click', event => {
        event.stopPropagation();
        showDetails(submission, true);
      });
    }

    if (cardExport && cardExportBtn instanceof HTMLButtonElement) {
      cardExport.addEventListener('click', event => {
        event.stopPropagation();
      });

      cardExportBtn.addEventListener('click', event => {
        event.stopPropagation();
        openCardExportSubmissionId = openCardExportSubmissionId === submissionId ? null : submissionId;
        renderSubmissions(currentRenderedSubmissions);
      });

      cardExportBtn.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          openCardExportSubmissionId = null;
          renderSubmissions(currentRenderedSubmissions);
        }
      });

      card.querySelectorAll('.card-export-option').forEach(option => {
        option.addEventListener('click', event => {
          event.stopPropagation();
          const format = option.getAttribute('data-format');
          openCardExportSubmissionId = null;
          if (format) {
            handleExport(format, [submission]);
          }
          renderSubmissions(currentRenderedSubmissions);
        });
      });
    }

    grid.appendChild(card);
  });

  container.innerHTML = '';
  container.appendChild(grid);
  updateSelectionToolbar();

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }

  // Restore persisted theme and update button state
  try {
    const saved = localStorage.getItem('dashboard-theme');
    if (saved === 'light' || saved === 'dark') {
      applyTheme(saved);
    } else {
      applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    }
  } catch (_) {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
  }
}

function updateSelectionToolbar() {
  const selectionInfo = document.getElementById('selectionInfo');
  const clearSelectionBtn = document.getElementById('clearSelectionBtn');
  const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
  const selectVisibleBtn = document.getElementById('selectVisibleBtn');

  const selectedCount = selectedSubmissionIds.size;
  const visibleIds = currentRenderedSubmissions.map(s => String(s.id));
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedSubmissionIds.has(id));

  if (selectionInfo) {
    selectionInfo.textContent = selectedCount > 0
      ? `${selectedCount} selected`
      : `Showing ${currentRenderedSubmissions.length} submissions`;
  }

  if (clearSelectionBtn) {
    clearSelectionBtn.disabled = selectedCount === 0;
  }

  if (deleteSelectedBtn) {
    deleteSelectedBtn.disabled = selectedCount === 0;
  }

  if (selectVisibleBtn) {
    selectVisibleBtn.title = allVisibleSelected ? 'Deselect Visible' : 'Select Visible';
    selectVisibleBtn.disabled = visibleIds.length === 0;
  }
}

function toggleSelectVisible() {
  const visibleIds = currentRenderedSubmissions.map(s => String(s.id));
  if (visibleIds.length === 0) return;

  const allVisibleSelected = visibleIds.every(id => selectedSubmissionIds.has(id));
  if (allVisibleSelected) {
    visibleIds.forEach(id => selectedSubmissionIds.delete(id));
  } else {
    visibleIds.forEach(id => selectedSubmissionIds.add(id));
  }

  renderSubmissions(currentRenderedSubmissions);
}

function clearSelection() {
  if (selectedSubmissionIds.size === 0) return;
  selectedSubmissionIds.clear();
  renderSubmissions(currentRenderedSubmissions);
}

async function deleteSelectedSubmissions() {
  const selectedIds = [...selectedSubmissionIds];
  if (selectedIds.length === 0) {
    return;
  }

  if (!confirm(`Delete ${selectedIds.length} selected submission(s)? This action cannot be undone.`)) {
    return;
  }

  const deleteBtn = document.getElementById('deleteSelectedBtn');
  const originalBtnText = deleteBtn ? deleteBtn.textContent : '';

  try {
    let token = null;

    if (!isLocalDashboardMode && window.netlifyIdentity) {
      const user = netlifyIdentity.currentUser();
      if (!user) {
        alert('Not authenticated');
        return;
      }
      token = await user.jwt();
    }

    if (deleteBtn) {
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting...';
    }

    let deletedCount = 0;
    const chunkSize = 5;

    for (let index = 0; index < selectedIds.length; index += chunkSize) {
      const batch = selectedIds.slice(index, index + chunkSize);
      const results = await Promise.allSettled(batch.map(id => deleteSubmissionById(id, token)));
      deletedCount += results.filter(result => result.status === 'fulfilled' && result.value === true).length;
    }

    if (deletedCount === 0) {
      alert('Failed to delete selected submissions. Please try again.');
      return;
    }

    const failedCount = selectedIds.length - deletedCount;
    selectedSubmissionIds.clear();
    await loadSubmissions();

    if (failedCount > 0) {
      alert(`Deleted ${deletedCount} submission(s). ${failedCount} failed.`);
    } else {
      alert(`Deleted ${deletedCount} submission(s) successfully.`);
    }
  } catch (error) {
    console.error('Error deleting selected submissions:', error);
    alert('Failed to delete selected submissions. Please try again.');
  } finally {
    if (deleteBtn) {
      deleteBtn.textContent = originalBtnText;
    }
    updateSelectionToolbar();
  }
}

function setHeroAvatar(brandName, logoRef) {
  const avatarEl = document.getElementById('detailAvatar');
  if (!avatarEl) return;

  const shouldUseExistingLogo = Boolean(logoRef) && !removeExistingLogo;
  if (pendingLogoFile) {
    if (pendingLogoObjectUrl) {
      URL.revokeObjectURL(pendingLogoObjectUrl);
    }
    pendingLogoObjectUrl = URL.createObjectURL(pendingLogoFile);
    avatarEl.innerHTML = `<img src="${escapeHtml(pendingLogoObjectUrl)}" alt="Logo preview" class="detail-avatar-image">`;
    return;
  }

  if (shouldUseExistingLogo) {
    avatarEl.innerHTML = `<img src="${escapeHtml(getLogoUrlFromRef(logoRef))}" alt="Brand logo" class="detail-avatar-image">`;
    return;
  }

  avatarEl.textContent = buildBrandInitials(brandName);
}

function normalizeDateInputValue(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function renderEditableField(label, key, type = 'text') {
  const value = String(editDraftData?.[key] ?? '');
  const error = String(editValidationErrors[key] || '');
  return `
    <div class="overview-card edit-field">
      <label class="overview-label" for="edit-${escapeHtml(key)}">${escapeHtml(label)}</label>
      <input id="edit-${escapeHtml(key)}" class="edit-input${error ? ' invalid' : ''}" type="${type}" data-edit-key="${escapeHtml(key)}" value="${escapeHtml(value)}" />
      ${error ? `<div class="edit-error">${escapeHtml(error)}</div>` : ''}
    </div>
  `;
}

function renderDetailPanel() {
  if (!currentSubmission) return;

  const modal = document.getElementById('detailModal');
  const modalBody = document.getElementById('modalBody');
  const titleEl = document.getElementById('modalTitle');
  const clientChipEl = document.getElementById('detailClientChip');
  const emailChipEl = document.getElementById('detailEmailChip');
  const data = isEditingSubmission ? (editDraftData || {}) : (currentSubmission.data || {});
  const history = currentSubmission.history;

  const brandName = getDisplayValue(data['brand-name']) || 'Submission Details';
  const clientName = getDisplayValue(data['client-name']) || 'Unknown Client';
  const email = getDisplayValue(data['email']) || 'N/A';
  const logoRef = getLogoRefFromData(data);

  if (titleEl) titleEl.textContent = brandName;
  if (clientChipEl) {
    const clientTextEl = clientChipEl.querySelector('.detail-chip-text');
    if (clientTextEl) clientTextEl.textContent = clientName;
  }
  if (emailChipEl) {
    const emailTextEl = emailChipEl.querySelector('.detail-chip-text');
    if (emailTextEl) emailTextEl.textContent = email;
  }
  setHeroAvatar(brandName, logoRef);

  modal?.classList.toggle('editing-active', isEditingSubmission);

  let overviewSection = '';
  if (isEditingSubmission) {
    overviewSection = `
      <section class="detail-section">
        <div class="edit-banner">Editing submission, changes are not saved yet</div>
        ${sectionHeader('list', 'Overview')}
        <div class="logo-upload-wrap">
          <label class="logo-dropzone" id="logoDropzone" tabindex="0" aria-label="Upload brand logo">
            <input id="logoFileInput" type="file" accept=".png,.jpg,.jpeg,.svg,.webp,image/png,image/jpeg,image/svg+xml,image/webp" hidden />
            <span>Drop logo here or click to upload (PNG, JPG, SVG, WEBP · max 2MB)</span>
          </label>
          <button class="btn" id="removeLogoBtn" type="button">Remove Logo</button>
          <div class="edit-error" id="logoUploadError"></div>
        </div>
        <div class="overview-grid">
          ${renderEditableField('Client Name', 'client-name', 'text')}
          ${renderEditableField('Email', 'email', 'email')}
          ${renderEditableField('Brand Name', 'brand-name', 'text')}
          <div class="overview-card edit-field">
            <label class="overview-label" for="edit-delivery-date">Delivery Date</label>
            <input id="edit-delivery-date" class="edit-input" type="date" data-edit-key="delivery-date" value="${escapeHtml(normalizeDateInputValue(data['delivery-date']))}" />
          </div>
          <div class="overview-card edit-field">
            <label class="overview-label" for="edit-agreed-delivery-date">Agreed Delivery Date</label>
            <input id="edit-agreed-delivery-date" class="edit-input" type="date" data-edit-key="agreed-delivery-date" value="${escapeHtml(normalizeDateInputValue(data['agreed-delivery-date']))}" />
          </div>
        </div>
      </section>
    `;
  } else {
    overviewSection = `
      <section class="detail-section">
        ${sectionHeader('list', 'Overview')}
        <div class="overview-grid">
          <div class="overview-card"><div class="overview-label">Client Name</div><div class="overview-value">${escapeHtml(clientName)}</div></div>
          <div class="overview-card"><div class="overview-label">Email</div><div class="overview-value">${escapeHtml(email)}</div></div>
          <div class="overview-card"><div class="overview-label">Brand Name</div><div class="overview-value">${escapeHtml(brandName)}</div></div>
          <div class="overview-card"><div class="overview-label">Delivery Date</div><div class="overview-value">${formatDeliveryDateForOverview(data['delivery-date'])}</div></div>
          <div class="overview-card"><div class="overview-label">Agreed Delivery Date</div><div class="overview-value">${data['agreed-delivery-date'] ? escapeHtml(formatDeliveryDateForOverview(data['agreed-delivery-date'])) : '<span class="overview-empty-badge">Not set yet</span>'}</div></div>
        </div>
      </section>
    `;
  }

  const historySection = `
    <section class="detail-section">
      ${sectionHeader('history', 'Submission History')}
      ${renderHistoryTimeline(history, { isLoading: !Array.isArray(history) })}
    </section>
  `;

  const questionnaireEntries = Object.entries(data)
    .filter(([key]) => isQuestionnaireKey(key))
    .sort(([a], [b]) => {
      const aKey = questionnaireSortKey(a);
      const bKey = questionnaireSortKey(b);
      if (aKey.group !== bKey.group) return aKey.group - bKey.group;
      return aKey.key.localeCompare(bKey.key);
    });

  const hasAnyResponse = questionnaireEntries.some(([, value]) => Boolean(getDisplayValue(value)));

  // Extract Q6 entries for grouped rendering
  const q6Entries = questionnaireEntries.filter(([key]) => key.startsWith('q6-'));
  const q6Values = {};
  q6Entries.forEach(([key, value]) => {
    q6Values[key] = value;
  });

  let hasRenderedQ6Group = false;

  // Render questionnaire items in sorted order, inserting the Q6 group
  const questionnaireItems = questionnaireEntries.map(([key, value]) => {
    if (key.startsWith('q6-')) {
      if (hasRenderedQ6Group || q6Entries.length === 0) {
        return '';
      }
      hasRenderedQ6Group = true;
      return renderQ6SpectrumGroup(q6Values, isEditingSubmission);
    }

    // Extract number badge and text label from key like "q1-business-description"
    const numMatch = key.match(/^q(\d+)-/);
    const qNum = numMatch ? numMatch[1].padStart(2, '0') : null;
    const labelText = key
      .replace(/^q\d+-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
    const safeLabel = escapeHtml(labelText);

    if (isEditingSubmission) {
      const editLabel = key
        .replace(/^q(\d+)-/, 'Q$1 - ')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());
      return `
        <article class="qa-card">
          <label class="qa-label" for="edit-${escapeHtml(key)}">${escapeHtml(editLabel)}</label>
          <textarea id="edit-${escapeHtml(key)}" class="edit-textarea" data-edit-key="${escapeHtml(key)}">${escapeHtml(String(value ?? ''))}</textarea>
        </article>
      `;
    }

    const displayValue = getDisplayValue(value);

    // Special rendering for q20-inspiration-refs
    if (key === 'q20-inspiration-refs' && !isEditingSubmission) {
      const refs = Array.isArray(value) ? value : (value ? [value] : []);
      const imagesHtml = refs.length > 0
        ? `<div class="q20-dash-preview-grid">${refs.map((ref, i) => `<div class="q20-dash-thumb-wrap"><img src="${escapeHtml(getLogoUrlFromRef(String(ref)))}" class="q20-dash-thumb" alt="Inspiration ${i + 1}" loading="lazy" /></div>`).join('')}</div>`
        : '<div class="qa-value qa-empty">No images uploaded</div>';
      return `<article class="qa-card"><div class="qa-label-row"><span class="qa-num-badge">20</span><span class="qa-label-text">Inspiration Images</span></div>${imagesHtml}</article>`;
    }

    const valueMarkup = displayValue
      ? `<div class="qa-value">${escapeHtml(displayValue)}</div>`
      : '<div class="qa-value qa-empty">No response</div>';

    const labelHtml = qNum
      ? `<div class="qa-label-row"><span class="qa-num-badge">${qNum}</span><span class="qa-label-text">${safeLabel}</span></div>`
      : `<div class="qa-label">${safeLabel}</div>`;

    return `<article class="qa-card">${labelHtml}${valueMarkup}</article>`;
  }).join('');

  const questionnaireCallout = hasAnyResponse
    ? ''
    : '<div class="questionnaire-callout">This submission has no questionnaire responses yet.</div>';

  const questionnaireSection = `
    <section class="detail-section">
      ${sectionHeader('puzzle', 'Brand Questionnaire')}
      ${questionnaireCallout}
      <div class="qa-grid">${questionnaireItems}</div>
    </section>
  `;

  modalBody.innerHTML = `${overviewSection}${historySection}${questionnaireSection}`;
  setModalActionButtons(isEditingSubmission ? 'edit' : 'view');

  const modalEditIconBtn = document.getElementById('modalEditIconBtn');
  const modalDeleteIconBtn = document.getElementById('modalDeleteIconBtn');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const saveEditBtn = document.getElementById('saveEditBtn');

  // Approve / Reject buttons (view mode)
  const approveBtn = document.getElementById('approveBtn');
  const rejectBtn = document.getElementById('rejectBtn');
  if (approveBtn) {
    approveBtn.addEventListener('click', () => {
      if (currentSubmission) setSubmissionStatus(String(currentSubmission.id), 'approved');
    });
  }
  if (rejectBtn) {
    rejectBtn.addEventListener('click', () => {
      if (currentSubmission) setSubmissionStatus(String(currentSubmission.id), 'rejected');
    });
  }

  // Cancel icon button in header (edit mode)
  const modalCancelIconBtn = document.getElementById('modalCancelIconBtn');
  if (modalCancelIconBtn) {
    modalCancelIconBtn.onclick = async () => {
      if (editDirty) {
        const shouldDiscard = await confirmDiscardChanges();
        if (!shouldDiscard) return;
      }
      isEditingSubmission = false;
      editDraftData = cloneSubmissionData(editOriginalData || currentSubmission?.data || {});
      editValidationErrors = {};
      pendingLogoFile = null;
      removeExistingLogo = false;
      editDirty = false;
      renderDetailPanel();
    };
  }

  // Re-attach listeners to persistent header icon buttons
  if (modalEditIconBtn) {
    modalEditIconBtn.onclick = () => {
      if (!currentSubmission) return;
      isEditingSubmission = true;
      editDraftData = cloneSubmissionData(currentSubmission.data || {});
      editOriginalData = cloneSubmissionData(currentSubmission.data || {});
      editValidationErrors = {};
      pendingLogoFile = null;
      removeExistingLogo = false;
      editDirty = false;
      renderDetailPanel();
    };
  }

  if (modalDeleteIconBtn) {
    modalDeleteIconBtn.onclick = () => {
      deleteCurrentSubmission();
    };
  }

  cancelEditBtn?.addEventListener('click', async () => {
    if (editDirty) {
      const shouldDiscard = await confirmDiscardChanges();
      if (!shouldDiscard) {
        return;
      }
    }

    isEditingSubmission = false;
    editDraftData = cloneSubmissionData(editOriginalData || currentSubmission?.data || {});
    editValidationErrors = {};
    pendingLogoFile = null;
    removeExistingLogo = false;
    editDirty = false;
    renderDetailPanel();
  });

  saveEditBtn?.addEventListener('click', () => {
    saveEditedSubmission();
  });

  setupEditModeInteractions();
  modal?.classList.add('active');

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function setupEditModeInteractions() {
  if (!isEditingSubmission) return;

  const modalBody = document.getElementById('modalBody');
  if (!modalBody) return;

  modalBody.querySelectorAll('[data-edit-key]').forEach(element => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
    element.addEventListener('input', () => {
      markEditDirty();
      syncDraftFromInputs();
    });
  });

  // Q6 interactive buttons in edit mode
  modalBody.querySelectorAll('.q6-edit-spectrums .q6-num-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-edit-key');
      const val = btn.getAttribute('data-val');
      if (!key || !val || !editDraftData) return;
      editDraftData[key] = val;
      markEditDirty();
      const row = btn.closest('.q6-num-row');
      row?.querySelectorAll('.q6-num-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
    });
  });

  const logoFileInput = document.getElementById('logoFileInput');
  const logoDropzone = document.getElementById('logoDropzone');
  const removeLogoBtn = document.getElementById('removeLogoBtn');
  const logoUploadError = document.getElementById('logoUploadError');

  const applyLogoFile = (file) => {
    if (!file) return;
    const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);

    if (!allowedTypes.has(file.type)) {
      if (logoUploadError) logoUploadError.textContent = 'Unsupported file type. Use PNG, JPG, SVG, or WEBP.';
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      if (logoUploadError) logoUploadError.textContent = 'File is too large. Maximum size is 2MB.';
      return;
    }

    if (logoUploadError) logoUploadError.textContent = '';
    pendingLogoFile = file;
    removeExistingLogo = false;
    markEditDirty();
    renderDetailPanel();
  };

  if (logoFileInput instanceof HTMLInputElement) {
    logoFileInput.addEventListener('change', () => {
      const file = logoFileInput.files && logoFileInput.files[0] ? logoFileInput.files[0] : null;
      applyLogoFile(file);
    });
  }

  if (logoDropzone) {
    logoDropzone.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        (logoFileInput instanceof HTMLInputElement) && logoFileInput.click();
      }
    });
    logoDropzone.addEventListener('dragover', event => {
      event.preventDefault();
      logoDropzone.classList.add('dragging');
    });
    logoDropzone.addEventListener('dragleave', () => {
      logoDropzone.classList.remove('dragging');
    });
    logoDropzone.addEventListener('drop', event => {
      event.preventDefault();
      logoDropzone.classList.remove('dragging');
      const file = event.dataTransfer?.files && event.dataTransfer.files[0] ? event.dataTransfer.files[0] : null;
      applyLogoFile(file);
    });
  }

  removeLogoBtn?.addEventListener('click', () => {
    pendingLogoFile = null;
    removeExistingLogo = true;
    markEditDirty();
    renderDetailPanel();
  });
}

function showDetails(submission, startEditing = false) {
  currentSubmission = submission;
  if (startEditing) {
    isEditingSubmission = true;
    editDraftData = cloneSubmissionData(submission.data || {});
    editOriginalData = cloneSubmissionData(submission.data || {});
    editValidationErrors = {};
    pendingLogoFile = null;
    removeExistingLogo = false;
    editDirty = false;
  } else {
    resetEditState();
    currentSubmission = submission;
  }

  renderDetailPanel();
}

function confirmDiscardChanges() {
  const modal = document.getElementById('discardChangesModal');
  const keepBtn = document.getElementById('keepEditingBtn');
  const discardBtn = document.getElementById('discardChangesBtn');
  if (!modal || !keepBtn || !discardBtn) {
    return Promise.resolve(confirm('Discard unsaved changes?'));
  }

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');

  return new Promise(resolve => {
    const cleanup = () => {
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
      keepBtn.removeEventListener('click', onKeep);
      discardBtn.removeEventListener('click', onDiscard);
    };

    const onKeep = () => {
      cleanup();
      resolve(false);
    };

    const onDiscard = () => {
      cleanup();
      resolve(true);
    };

    keepBtn.addEventListener('click', onKeep);
    discardBtn.addEventListener('click', onDiscard);
  });
}

async function closeModal() {
  if (isEditingSubmission && editDirty) {
    const shouldDiscard = await confirmDiscardChanges();
    if (!shouldDiscard) {
      return;
    }
  }

  document.getElementById('detailModal').classList.remove('active');
  document.getElementById('modalBody').innerHTML = '';
  currentSubmission = null;
  resetEditState();
}

async function saveEditedSubmission() {
  if (!currentSubmission || !isEditingSubmission) return;
  syncDraftFromInputs();

  const errors = validateEditData(editDraftData || {});
  editValidationErrors = errors;
  if (Object.keys(errors).length > 0) {
    renderDetailPanel();
    return;
  }

  try {
    const payload = cloneSubmissionData(editDraftData || {});

    payload.__editedBy = 'admin';
    payload.editedBy = 'admin';

    const newHistoryEntry = {
      label: 'edited',
      date: new Date().toISOString(),
      editedBy: 'admin'
    };

    if (!newHistoryEntry.editedBy || !['admin', 'client'].includes(newHistoryEntry.editedBy)) {
      console.error('History entry is missing a valid editedBy value:', newHistoryEntry);
      alert('Unable to save changes due to missing editor attribution.');
      return;
    }

    if (pendingLogoFile) {
      const logoRef = await uploadLogoFile(pendingLogoFile);
      payload['brand-logo-ref'] = logoRef;
    } else if (removeExistingLogo) {
      payload['brand-logo-ref'] = '';
    }

    payload.__submissionAction = 'override';
    payload.__overrideSubmissionId = String(currentSubmission.id);
    payload.__editedBy = payload.__editedBy || newHistoryEntry.editedBy;
    payload.editedBy = payload.__editedBy;

    const response = await fetch('/.netlify/functions/submit-form', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Failed to save changes.');
    }

    const result = await response.json();
    const updatedSubmission = result.submission || {
      ...currentSubmission,
      data: payload
    };

    allSubmissions = allSubmissions.map(item => String(item.id) === String(updatedSubmission.id) ? updatedSubmission : item);
    currentSubmission = updatedSubmission;
    isEditingSubmission = false;
    editDirty = false;
    pendingLogoFile = null;
    removeExistingLogo = false;
    editValidationErrors = {};
    editDraftData = null;
    editOriginalData = null;
    updateStats();
    applyCurrentFiltersAndRender();
    renderDetailPanel();
  } catch (error) {
    console.error('Save edit failed:', error);
    alert(error instanceof Error ? error.message : 'Failed to save changes.');
  }
}

async function deleteCurrentSubmission() {
  if (!currentSubmission) return;

  const brandName = currentSubmission.data?.['brand-name'] || 'this submission';

  if (!confirm(`Are you sure you want to delete "${brandName}"? This action cannot be undone.`)) {
    return;
  }

  try {
    let token = null;

    if (!isLocalDashboardMode && window.netlifyIdentity) {
      const user = netlifyIdentity.currentUser();
      if (!user) {
        alert('Not authenticated');
        return;
      }
      token = await user.jwt();
    }
    const deleted = await deleteSubmissionById(currentSubmission.id, token);

    if (!deleted) {
      throw new Error('Failed to delete submission');
    }

    selectedSubmissionIds.delete(String(currentSubmission.id));
    closeModal();
    alert('Submission deleted successfully');
    loadSubmissions();
  } catch (error) {
    console.error('Error deleting submission:', error);
    alert('Failed to delete submission. Please try again.');
  }
}

function sortSubmissions(mode) {
  isSortApplied = true;
  sortMode = mode;
  applyCurrentFiltersAndRender();
  // Update active state on menu options
  document.querySelectorAll('.sort-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.sort === mode);
  });
  // Update sort button label
  const labels = {
    'date-desc': 'Newest', 'date-asc': 'Oldest',
    'name-asc': 'A→Z', 'name-desc': 'Z→A',
    'delivery-asc': 'Soonest', 'delivery-desc': 'Latest'
  };
  const labelEl = document.querySelector('.sort-btn-label');
  if (labelEl) labelEl.textContent = labels[mode] || 'Sort';
}

/* ── Export helpers ─────────────────────────────────────── */

function getExportableSubmissions() {
  if (currentRenderedSubmissions.length > 0) return currentRenderedSubmissions;
  return allSubmissions;
}

function resolveExportSubmissions(submissionsOverride) {
  if (Array.isArray(submissionsOverride)) {
    return submissionsOverride;
  }

  return getExportableSubmissions();
}

function submissionToPlainRows(submission) {
  const data = submission.data || {};
  const rows = [];
  for (const [key, value] of Object.entries(data)) {
    const label = key
      .replace(/^q(\d+)-/, 'Q$1 - ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
    const val = Array.isArray(value) ? value.join(', ') : String(value || 'No response');
    rows.push({ label, value: val });
  }
  return rows;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

function exportAsMarkdown(submissionsOverride) {
  const submissions = resolveExportSubmissions(submissionsOverride);
  if (submissions.length === 0) { alert('No submissions to export.'); return; }

  const parts = submissions.map((sub, idx) => {
    const data = sub.data || {};
    const brand = data['brand-name'] || 'Untitled';
    const date = new Date(sub.created_at);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const rows = submissionToPlainRows(sub);
    const body = rows.map(r => `**${r.label}:** ${r.value}`).join('\n\n');
    return `## ${idx + 1}. ${brand}\n\n*Submitted: ${dateStr}*\n\n${body}`;
  });

  const md = `# Form Submissions\n\nExported on ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}\n\n---\n\n${parts.join('\n\n---\n\n')}\n`;
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, `submissions-${Date.now()}.md`);
}

function exportAsPDF(submissionsOverride) {
  const submissions = resolveExportSubmissions(submissionsOverride);
  if (submissions.length === 0) { alert('No submissions to export.'); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 18;
  const maxW = pageW - margin * 2;
  let y = 20;

  function checkPage(needed) {
    if (y + needed > doc.internal.pageSize.getHeight() - 20) {
      doc.addPage();
      y = 20;
    }
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Form Submissions', margin, y);
  y += 8;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(120);
  doc.text(`Exported on ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`, margin, y);
  doc.setTextColor(0);
  y += 10;

  submissions.forEach((sub, idx) => {
    const data = sub.data || {};
    const brand = data['brand-name'] || 'Untitled';
    const date = new Date(sub.created_at);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const rows = submissionToPlainRows(sub);

    checkPage(18);
    doc.setDrawColor(200);
    if (idx > 0) { doc.line(margin, y, pageW - margin, y); y += 6; }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(`${idx + 1}. ${brand}`, margin, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`Submitted: ${dateStr}`, margin, y);
    doc.setTextColor(0);
    y += 7;

    rows.forEach(r => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      const labelLines = doc.splitTextToSize(`${r.label}:`, maxW);
      checkPage(labelLines.length * 5 + 8);
      doc.text(labelLines, margin, y);
      y += labelLines.length * 5;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      const valLines = doc.splitTextToSize(r.value, maxW);
      checkPage(valLines.length * 5 + 4);
      doc.text(valLines, margin, y);
      y += valLines.length * 5 + 4;
    });

    y += 4;
  });

  doc.save(`submissions-${Date.now()}.pdf`);
}

async function exportAsDOCX(submissionsOverride) {
  const submissions = resolveExportSubmissions(submissionsOverride);
  if (submissions.length === 0) { alert('No submissions to export.'); return; }

  const { Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle } = window.docx;

  const children = [];

  children.push(new Paragraph({
    text: 'Form Submissions',
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 120 }
  }));

  children.push(new Paragraph({
    children: [new TextRun({
      text: `Exported on ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
      color: '888888',
      size: 20
    })],
    spacing: { after: 300 }
  }));

  submissions.forEach((sub, idx) => {
    const data = sub.data || {};
    const brand = data['brand-name'] || 'Untitled';
    const date = new Date(sub.created_at);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const rows = submissionToPlainRows(sub);

    if (idx > 0) {
      children.push(new Paragraph({
        text: '',
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
        spacing: { before: 200, after: 200 }
      }));
    }

    children.push(new Paragraph({
      text: `${idx + 1}. ${brand}`,
      heading: HeadingLevel.HEADING_2,
      spacing: { after: 60 }
    }));

    children.push(new Paragraph({
      children: [new TextRun({ text: `Submitted: ${dateStr}`, italics: true, color: '888888', size: 18 })],
      spacing: { after: 200 }
    }));

    rows.forEach(r => {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${r.label}: `, bold: true, size: 22 }),
          new TextRun({ text: r.value, size: 22 })
        ],
        spacing: { after: 100 }
      }));
    });
  });

  const doc = new Document({
    sections: [{ properties: {}, children }]
  });

  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, `submissions-${Date.now()}.docx`);
}

function exportAsCSV(submissionsOverride) {
  const submissions = resolveExportSubmissions(submissionsOverride);
  if (submissions.length === 0) { alert('No submissions to export.'); return; }

  const columns = [
    'id', 'created_at', 'status',
    'client-name', 'brand-name', 'email', 'delivery-date', 'agreed-delivery-date',
    'q1-business-description', 'q2-problem-transformation', 'q3-ideal-customer',
    'q4-competitors', 'q5-brand-personality',
    'q6-playful-serious', 'q6-minimalist-expressive', 'q6-approachable-authoritative', 'q6-classic-contemporary',
    'q7-core-values', 'q8-positioning', 'q9-success-vision',
    'q10-brands-admired', 'q11-brands-disliked',
    'q12-color', 'q13-colors-to-avoid', 'q14-typography', 'q15-aesthetic', 'q15-aesthetic-description',
    'q16-brand-space', 'q17-existing-assets', 'q18-deliverables',
    'q19-first-feeling', 'q20-inspiration-refs', 'q21-anything-else'
  ];

  function escapeCSVCell(value) {
    const str = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
    if (str.includes(',') || str.includes('\n') || str.includes('"')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  const header = columns.map(escapeCSVCell).join(',');
  const rows = submissions.map(sub => {
    return columns.map(col => {
      if (col === 'id') return escapeCSVCell(sub.id);
      if (col === 'created_at') return escapeCSVCell(sub.created_at);
      if (col === 'status') return escapeCSVCell(sub.data?.status || 'pending');
      return escapeCSVCell(sub.data?.[col] ?? '');
    }).join(',');
  });

  const csv = [header, ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `submissions-${Date.now()}.csv`);
}

function handleExport(format, submissionsOverride) {
  if (format === 'md') exportAsMarkdown(submissionsOverride);
  else if (format === 'pdf') exportAsPDF(submissionsOverride);
  else if (format === 'docx') exportAsDOCX(submissionsOverride);
  else if (format === 'csv') exportAsCSV(submissionsOverride);
}

/* ── End export helpers ────────────────────────────────── */

function applyTheme(theme) {
  const html = document.documentElement;
  html.setAttribute('data-theme', theme);
  try { localStorage.setItem('dashboard-theme', theme); } catch (_) {}

  const isDark = theme === 'dark';
  const darkIcon = document.querySelector('.theme-icon-dark');
  const lightIcon = document.querySelector('.theme-icon-light');
  const label = document.getElementById('themeBtnLabel');

  if (darkIcon) darkIcon.style.display = isDark ? '' : 'none';
  if (lightIcon) lightIcon.style.display = isDark ? 'none' : '';
  if (label) label.textContent = isDark ? 'Dark' : 'Light';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }

  const searchBox = document.getElementById('searchBox');
  const loginBtn = document.getElementById('loginBtn');
  const themeBtn = document.getElementById('themeBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const accountBtn = document.getElementById('accountBtn');
  const sortBtn = document.getElementById('sortBtn');
  const sortMenu = document.getElementById('sortMenu');
  const sortDropdown = document.getElementById('sortDropdown');
  const selectVisibleBtn = document.getElementById('selectVisibleBtn');
  const clearSelectionBtn = document.getElementById('clearSelectionBtn');
  const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const modalDeleteBtn = document.getElementById('modalDeleteBtn');
  const exportBtn = document.getElementById('exportBtn');
  const exportMenu = document.getElementById('exportMenu');
  const importBtn = document.getElementById('importBtn');

  function parseCSVRow(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  function parseCSVSubmission(text) {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) throw new Error('CSV must have at least a header row and one data row.');
    const headers = parseCSVRow(lines[0]);
    const values = parseCSVRow(lines[1]);
    const data = {};
    const arrayFields = new Set(['q12-color', 'q14-typography', 'q15-aesthetic', 'q18-deliverables', 'q20-inspiration-refs']);
    headers.forEach((header, i) => {
      const value = values[i] ?? '';
      if (arrayFields.has(header) && value.includes(' | ')) {
        data[header] = value.split(' | ').map(v => v.trim()).filter(Boolean);
      } else if (header !== 'id' && header !== 'created_at') {
        data[header] = value;
      }
    });
    return data;
  }

  // Parse markdown submission file
  function parseMarkdownSubmission(text) {
    const lines = text.split('\n');
    const data = {};
    let currentKey = null;
    let currentValue = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Match markdown heading format: ## Key Name
      const headingMatch = line.match(/^##\s+(.+)$/);
      if (headingMatch) {
        // Save previous key-value pair
        if (currentKey) {
          data[currentKey] = currentValue.join('\n').trim();
        }
        
        // Map heading to field key
        const heading = headingMatch[1].trim();
        currentKey = mapHeadingToFieldKey(heading);
        currentValue = [];
        continue;
      }

      // Skip metadata lines and headers
      if (line.startsWith('#') || line.startsWith('-') || line.startsWith('---')) {
        continue;
      }

      // Accumulate content lines
      if (currentKey && line.trim()) {
        currentValue.push(line);
      }
    }

    // Save last key-value pair
    if (currentKey) {
      data[currentKey] = currentValue.join('\n').trim();
    }

    return data;
  }

  function mapHeadingToFieldKey(heading) {
    const map = {
      'Brand / Business': 'brand-name',
      'Client Name': 'client-name',
      'Client Email': 'email',
      'Delivery Date': 'delivery-date',
      'Q1 — Business Description': 'q1-business-description',
      'Q2 — Problem + Transformation': 'q2-problem-transformation',
      'Q3 — Ideal Customer': 'q3-ideal-customer',
      'Q4 — Competitors + Market Gap': 'q4-competitors',
      'Q5 — Brand Personality': 'q5-brand-personality',
      'Q6 — Playful <-> Serious': 'q6-playful-serious',
      'Q6 — Minimalist <-> Expressive': 'q6-minimalist-expressive',
      'Q6 — Approachable <-> Authoritative': 'q6-approachable-authoritative',
      'Q6 — Classic <-> Contemporary': 'q6-classic-contemporary',
      'Q7 — Core Values': 'q7-core-values',
      'Q8 — Positioning Statement': 'q8-positioning',
      'Q9 — 3-Year Success Vision': 'q9-success-vision',
      'Q10 — Admired Brands': 'q10-brands-admired',
      'Q11 — Disliked Brands': 'q11-brands-disliked',
      'Q12 — Color Directions': 'q12-color',
      'Q13 — Colors To Avoid': 'q13-colors-to-avoid',
      'Q14 — Typography Directions': 'q14-typography',
      'Q15 — Aesthetic Direction': 'q15-aesthetic',
      'Q15 — Additional Aesthetic Notes': 'q15-aesthetic-description',
      'Q16 — Brand As Physical Space': 'q16-brand-space',
      'Q17 — Existing Assets To Keep': 'q17-existing-assets',
      'Q18 — Needed Deliverables': 'q18-deliverables',
      'Q19 — First Feeling': 'q19-first-feeling',
      'Q20 — Inspiration Images': 'q20-inspiration-refs',
      'Q21 — Anything Else': 'q21-anything-else'
    };
    return map[heading] || heading.toLowerCase().replace(/\s+/g, '-');
  }

  async function handleImport(file) {
    const isCSV = file.name.endsWith('.csv') || file.type === 'text/csv';
    const isMarkdown = file.name.endsWith('.md') || file.name.endsWith('.markdown');

    if (!isCSV && !isMarkdown) {
      alert('Unsupported file type. Please use .md or .csv');
      return;
    }

    try {
      const text = await file.text();
      let parsedData;

      if (isCSV) {
        parsedData = parseCSVSubmission(text);
      } else {
        parsedData = parseMarkdownSubmission(text);
      }
      
      // Validate required fields
      if (!parsedData['brand-name'] || !parsedData['client-name'] || !parsedData['email']) {
        alert('Import failed: Missing required fields (Brand Name, Client Name, or Email)');
        return;
      }

      // Convert multi-select fields to arrays
      const multiSelectFields = ['q12-color', 'q14-typography', 'q15-aesthetic', 'q18-deliverables'];
      multiSelectFields.forEach(field => {
        if (parsedData[field]) {
          parsedData[field] = parsedData[field].split(',').map(v => v.trim()).filter(Boolean);
        }
      });

      // Convert range fields to numbers
      const rangeFields = ['q6-playful-serious', 'q6-minimalist-expressive', 'q6-approachable-authoritative', 'q6-classic-contemporary'];
      rangeFields.forEach(field => {
        if (parsedData[field]) {
          const num = parseInt(parsedData[field], 10);
          if (!isNaN(num)) {
            parsedData[field] = num;
          }
        }
      });

      // Submit to backend
      const apiUrl = isLocalDashboardMode 
        ? '/.netlify/functions/submit'
        : 'https://form.neatmark.studio/.netlify/functions/submit';

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsedData)
      });

      if (!response.ok) {
        throw new Error(`Import failed: ${response.statusText}`);
      }

      alert(`Successfully imported: ${parsedData['brand-name']}`);
      loadSubmissions();
    } catch (error) {
      console.error('Import error:', error);
      alert(`Import failed: ${error.message}`);
    }
  }

  // Import button handler
  importBtn?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.csv,text/markdown,text/csv';
    input.onchange = (e) => {
      const file = e.target?.files?.[0];
      if (file) {
        handleImport(file);
      }
    };
    input.click();
  });

  if (searchBox) {
    searchBox.addEventListener('input', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;

      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        openCardExportSubmissionId = null;
        applyCurrentFiltersAndRender();
      }, 180);
    });
  }

  // Custom date filter dropdown (Feature 6)
  const dateFilterBtn = document.getElementById('dateFilterBtn');
  const dateFilterMenu = document.getElementById('dateFilterMenu');
  const dateFilterLabel = document.getElementById('dateFilterLabel');
  const dateFilterDropdown = document.getElementById('dateFilterDropdown');

  dateFilterBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = dateFilterMenu?.classList.toggle('open');
    dateFilterBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });

  dateFilterMenu?.querySelectorAll('.date-filter-option').forEach(opt => {
    opt.addEventListener('click', () => {
      dateFilterMenu.querySelectorAll('.date-filter-option').forEach(o => {
        o.classList.remove('active');
        o.setAttribute('aria-selected', 'false');
      });
      opt.classList.add('active');
      opt.setAttribute('aria-selected', 'true');
      if (dateFilterLabel) dateFilterLabel.textContent = opt.textContent;
      dateFilterMenu.classList.remove('open');
      dateFilterBtn?.setAttribute('aria-expanded', 'false');
      openCardExportSubmissionId = null;
      applyCurrentFiltersAndRender();
    });
  });

  document.addEventListener('click', (e) => {
    if (dateFilterDropdown && !dateFilterDropdown.contains(e.target)) {
      dateFilterMenu?.classList.remove('open');
      dateFilterBtn?.setAttribute('aria-expanded', 'false');
    }
  });

  loginBtn?.addEventListener('click', () => window.netlifyIdentity?.open());
  themeBtn?.addEventListener('click', () => toggleTheme());
  refreshBtn?.addEventListener('click', () => loadSubmissions());
  accountBtn?.addEventListener('click', () => window.netlifyIdentity?.open());
  sortBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = sortMenu?.classList.toggle('open');
    sortBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });

  document.querySelectorAll('.sort-option').forEach(opt => {
    opt.addEventListener('click', () => {
      sortSubmissions(opt.dataset.sort);
      sortMenu?.classList.remove('open');
      sortBtn?.setAttribute('aria-expanded', 'false');
    });
  });

  document.addEventListener('click', (e) => {
    if (sortDropdown && !sortDropdown.contains(e.target)) {
      sortMenu?.classList.remove('open');
      sortBtn?.setAttribute('aria-expanded', 'false');
    }
  });
  selectVisibleBtn?.addEventListener('click', () => toggleSelectVisible());
  clearSelectionBtn?.addEventListener('click', () => clearSelection());
  deleteSelectedBtn?.addEventListener('click', () => deleteSelectedSubmissions());
  modalCloseBtn?.addEventListener('click', () => closeModal());
  modalDeleteBtn?.addEventListener('click', () => deleteCurrentSubmission());

  // Export dropdown
  exportBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu?.classList.toggle('open');
  });

  document.querySelectorAll('.export-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const format = btn.getAttribute('data-format');
      exportMenu?.classList.remove('open');
      if (format) handleExport(format);
    });
  });

  document.addEventListener('click', () => {
    exportMenu?.classList.remove('open');
    if (openCardExportSubmissionId !== null) {
      openCardExportSubmissionId = null;
      renderSubmissions(currentRenderedSubmissions);
    }
  });

  updateExportButtonLabel();

  const detailModal = document.getElementById('detailModal');
  detailModal?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLElement && e.target.id === 'detailModal') {
      closeModal();
    }
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openCardExportSubmissionId !== null) {
    openCardExportSubmissionId = null;
    renderSubmissions(currentRenderedSubmissions);
  }

  if (e.key === 'Escape' && document.getElementById('detailModal').classList.contains('active')) {
    closeModal();
  }
});