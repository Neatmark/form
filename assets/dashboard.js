/**
 * Dashboard translation helper.
 * Falls back to the English default when i18n is not loaded or key is missing.
 * Usage: dt('dashboard.loading', 'Loading…')
 *        dt('dashboard.showing', 'Showing {{count}} submissions', { count: 5 })
 */
function dt(key, fallback, vars) {
  if (!window.i18n) return fallback || '';
  const result = window.i18n.t(key, vars !== undefined ? vars : (fallback || ''));
  if (result) return result;
  // When the key has no translation (English uses DOM fallbacks), interpolate
  // vars into the fallback string so {{count}} etc. are still replaced.
  if (vars && fallback) return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  return fallback || '';
}

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

if (isLocalDashboardMode) {
  console.warn(
    '%c[SECURITY] Dashboard is running in local dev mode — all authentication checks are BYPASSED. ' +
    'Never expose this to a network or run `netlify dev` on a shared machine.',
    'color: #ff6b35; font-weight: bold; font-size: 13px;'
  );
}

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
    return dt('detail.history.unknownDate', 'Unknown date');
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
    return dt('detail.history.unknownTime', 'Unknown time');
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
    return dt('detail.history.justNow', 'just now');
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
        <div class="response-label">${dt('detail.history.label', 'History')}</div>
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
        <div class="response-label">${dt('detail.history.label', 'History')}</div>
        <div class="history-empty">${dt('detail.history.noData', 'No history data available.')}</div>
      </div>
    `;
  }

  const latestIndex = timeline.length - 1;
  const itemsMarkup = timeline.map((entry, index) => {
    const isOriginal = entry.label === 'original';
    const isLatest = index === latestIndex;
    const badgeText = isOriginal ? dt('history.originalSubmission', 'Original Submission') : dt('history.edited', 'Edited');
    const editedByText = entry.editedBy === 'admin'
      ? dt('history.byAdmin', 'By Admin')
      : entry.editedBy === 'client'
        ? dt('history.byClient', 'By Client')
        : dt('detail.history.unknown', 'Unknown');
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
            ${isLatest ? `<span class="history-latest-tag">${dt('detail.history.latestTag', 'Latest')}</span>` : ''}
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
      <div class="response-label">${dt('detail.history.label', 'History')}</div>
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
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('dashboardScreen').classList.remove('visible');
}

function showDashboard() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('dashboardScreen').classList.add('visible');
}

async function loadSubmissions() {
  const container = document.getElementById('submissionsContainer');
  container.innerHTML = `<div class="loading">${dt('dashboard.loading', 'Loading submissions...')}</div>`;

  try {
    let token = null;

    if (window.netlifyIdentity) {
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
      container.innerHTML = `<div class="empty"><strong>${dt('dashboard.error.accessDenied', 'Access denied. Ask the site admin to add your email to ADMIN_EMAILS.')}</strong></div>`;
      return;
    }
    if (message === 'Unauthorized') {
      container.innerHTML = `<div class="empty"><strong>${dt('dashboard.error.sessionExpired', 'Your session expired. Please log in again.')}</strong></div>`;
      return;
    }
    container.innerHTML = `<div class="empty"><strong>${dt('dashboard.error.failedToLoad', 'Failed to load submissions. Please try again.')}</strong></div>`;
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
    { key: 'q6-playful-serious', leftLabel: dt('detail.q6.playful', 'Playful'), rightLabel: dt('detail.q6.serious', 'Serious') },
    { key: 'q6-minimalist-expressive', leftLabel: dt('detail.q6.minimalist', 'Minimalist'), rightLabel: dt('detail.q6.expressive', 'Expressive') },
    { key: 'q6-approachable-authoritative', leftLabel: dt('detail.q6.approachable', 'Approachable'), rightLabel: dt('detail.q6.authoritative', 'Authoritative') },
    { key: 'q6-classic-contemporary', leftLabel: dt('detail.q6.classic', 'Classic'), rightLabel: dt('detail.q6.contemporary', 'Contemporary') }
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
        <div class="qa-label-row"><span class="qa-num-badge">06</span><span class="qa-label-text">${dt('detail.q6.title', 'Personality Spectrums')}</span></div>
        <div class="q6-hint">${dt('detail.q6.hint', '1 = far left, 5 = far right')}</div>
        <div class="q6-spectrums q6-edit-spectrums">${editRows}</div>
      </article>
    `;
  }

  // View mode: numbered button rows (same layout as edit mode but disabled)
  const spectrumRowsHtml = spectrumDefs.map(({ key, leftLabel, rightLabel }) => {
    const rawValue = q6Values[key];
    const value = Number(rawValue) || 3;
    const hasResponse = Boolean(rawValue && !Number.isNaN(Number(rawValue)));

    const buttons = [1, 2, 3, 4, 5].map(n => {
      const isActive = hasResponse && n === value;
      return `<button class="q6-num-btn${isActive ? ' active' : ''}" disabled aria-label="${n}">${n}</button>`;
    }).join('');

    return `
      <div class="q6-num-row q6-view-row">
        <div class="q6-num-left-label">${escapeHtml(leftLabel)}</div>
        <div class="q6-num-buttons">${buttons}</div>
        <div class="q6-num-right-label">${escapeHtml(rightLabel)}</div>
      </div>
    `;
  }).join('');

  return `
    <article class="qa-card q6-spectrum-card">
      <div class="qa-label-row"><span class="qa-num-badge">06</span><span class="qa-label-text">${dt('detail.q6.title', 'Personality Spectrums')}</span></div>
      <div class="q6-hint">${dt('detail.q6.hint', '1 = far left, 5 = far right')}</div>
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
    return `<span class="overview-empty-badge">${dt('detail.overview.notSpecified', 'Not specified')}</span>`;
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

function sectionHeader(icon, title, opts = {}) {
  if (opts.collapsible) {
    return `
      <button type="button" class="detail-section-head detail-section-toggle${opts.collapsed ? ' collapsed' : ''}" aria-expanded="${opts.collapsed ? 'false' : 'true'}" data-collapse-target="${opts.targetId || ''}">
        <span class="detail-section-icon" aria-hidden="true">
          <i data-lucide="${icon}" class="icon icon-section"></i>
        </span>
        <h3 class="detail-section-title">${title}</h3>
        <i data-lucide="chevron-down" class="icon detail-section-chevron"></i>
      </button>
    `;
  }
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

/**
 * The canonical set of questionnaire field keys that exist in the
 * current form (index.html) and database schema (supabase-submissions.sql).
 * Any key NOT in this set is legacy/old and will be hidden in the UI.
 */
const VALID_QUESTIONNAIRE_FIELDS = new Set([
  'q1-business-description',
  'q2-problem-transformation',
  'q3-ideal-customer',
  'q3b-customer-desire',
  'q4-competitors',
  'q5-brand-personality',
  'q6-positioning',
  'q-launch-context',
  'q8-brands-admired',
  'q9-color',
  'q10-colors-to-avoid',
  'q11-aesthetic',
  'q11-aesthetic-description',
  'q13-deliverables',
  'q14-budget',
  'q15-inspiration-refs',
  'q7-decision-maker',
  'q7-decision-maker-other',
  'q12-existing-assets',
  'delivery-date',
  'q16-anything-else'
]);

// Explicit display order matching the form's question numbering (01-19)
const QUESTIONNAIRE_FIELD_ORDER = {
  'q1-business-description':  1,
  'q2-problem-transformation':2,
  'q3-ideal-customer':        3,
  'q3b-customer-desire':      4,
  'q4-competitors':           5,
  'q5-brand-personality':     6,
  'q6-positioning':           7,
  'q-launch-context':         8,
  'q8-brands-admired':        9,
  'q9-color':                10,
  'q10-colors-to-avoid':     11,
  'q11-aesthetic':           12,
  'q11-aesthetic-description':12.5,
  'q13-deliverables':        13,
  'q15-inspiration-refs':    14,   // moved: was 15, now 14 (budget moved to section 3)
  'q7-decision-maker':       15,   // was 16
  'q7-decision-maker-other': 15.5, // was 16.5
  'delivery-date':           16,   // was 18
  'q14-budget':              17,   // was 14, moved to section 3
  'q12-existing-assets':     18,   // was 17
  'q16-anything-else':       19,
};

// Clean display numbers shown in the dashboard badge
const QUESTIONNAIRE_DISPLAY_NUM = {
  'q1-business-description':  '01',
  'q2-problem-transformation':'02',
  'q3-ideal-customer':        '03',
  'q3b-customer-desire':      '04',
  'q4-competitors':           '05',
  'q5-brand-personality':     '06',
  'q6-positioning':           '07',
  'q-launch-context':         '08',
  'q8-brands-admired':        '09',
  'q9-color':                 '10',
  'q10-colors-to-avoid':      '11',
  'q11-aesthetic':            '12',
  'q11-aesthetic-description':'12b',
  'q13-deliverables':         '13',
  'q15-inspiration-refs':     '14',
  'q7-decision-maker':        '15',
  'q7-decision-maker-other':  '15b',
  'delivery-date':            '16',
  'q14-budget':               '17',
  'q12-existing-assets':      '18',
  'q16-anything-else':        '19',
};

// Human-readable labels for the dashboard cards
function getFieldLabel(key) {
  const fallbacks = {
    'q1-business-description':  'Business Description',
    'q2-problem-transformation':'Before and After',
    'q3-ideal-customer':        'Ideal Client',
    'q3b-customer-desire':      'Client Trigger',
    'q4-competitors':           'Competitors',
    'q5-brand-personality':     'Brand Personality',
    'q6-positioning':           'Positioning Statement',
    'q-launch-context':         'Launch Context',
    'q8-brands-admired':        'Admired Brands',
    'q9-color':                 'Color Directions',
    'q10-colors-to-avoid':      'Colors to Avoid',
    'q11-aesthetic':            'Aesthetic Direction',
    'q11-aesthetic-description':'Aesthetic Notes',
    'q13-deliverables':         'Deliverables',
    'q15-inspiration-refs':     'Inspiration Images',
    'q7-decision-maker':        'Action Taker',
    'q7-decision-maker-other':  'Action Taker (Other)',
    'delivery-date':            'Delivery Timeframe',
    'q14-budget':               'Budget Approach',
    'q12-existing-assets':      'Brand Assets',
    'q16-anything-else':        'Past Experience and Fears',
  };
  const i18nKeys = {
    'q1-business-description':  'detail.questionnaire.labels.q1',
    'q2-problem-transformation':'detail.questionnaire.labels.q2',
    'q3-ideal-customer':        'detail.questionnaire.labels.q3',
    'q3b-customer-desire':      'detail.questionnaire.labels.q3b',
    'q4-competitors':           'detail.questionnaire.labels.q4',
    'q5-brand-personality':     'detail.questionnaire.labels.q5',
    'q6-positioning':           'detail.questionnaire.labels.q6',
    'q-launch-context':         'detail.questionnaire.labels.qlaunch',
    'q8-brands-admired':        'detail.questionnaire.labels.q8',
    'q9-color':                 'detail.questionnaire.labels.q9',
    'q10-colors-to-avoid':      'detail.questionnaire.labels.q10',
    'q11-aesthetic':            'detail.questionnaire.labels.q11',
    'q11-aesthetic-description':'detail.questionnaire.labels.q11b',
    'q13-deliverables':         'detail.questionnaire.labels.q13',
    'q14-budget':               'detail.questionnaire.labels.q14',
    'q15-inspiration-refs':     'detail.questionnaire.labels.q15',
    'q7-decision-maker':        'detail.questionnaire.labels.q7',
    'q7-decision-maker-other':  'detail.questionnaire.labels.q7b',
    'q12-existing-assets':      'detail.questionnaire.labels.q12',
    'delivery-date':            'detail.questionnaire.labels.delivery',
    'q16-anything-else':        'detail.questionnaire.labels.q16',
  };
  return dt(i18nKeys[key] || '', fallbacks[key] || key);
}
// Legacy compatibility shim — used only for export functions which do their own label logic
const QUESTIONNAIRE_FIELD_LABELS = {
  'q1-business-description':  'Business Description',
  'q2-problem-transformation':'Before and After',
  'q3-ideal-customer':        'Ideal Client',
  'q3b-customer-desire':      'Client Trigger',
  'q4-competitors':           'Competitors',
  'q5-brand-personality':     'Brand Personality',
  'q6-positioning':           'Positioning Statement',
  'q-launch-context':         'Launch Context',
  'q8-brands-admired':        'Admired Brands',
  'q9-color':                 'Color Directions',
  'q10-colors-to-avoid':      'Colors to Avoid',
  'q11-aesthetic':            'Aesthetic Direction',
  'q11-aesthetic-description':'Aesthetic Notes',
  'q13-deliverables':         'Deliverables',
  'q15-inspiration-refs':     'Inspiration Images',
  'q7-decision-maker':        'Action Taker',
  'q7-decision-maker-other':  'Action Taker (Other)',
  'delivery-date':            'Delivery Timeframe',
  'q14-budget':               'Budget Approach',
  'q12-existing-assets':      'Brand Assets',
  'q16-anything-else':        'Past Experience and Fears',
};

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
    labelEl.textContent = dt('dashboard.export.filtered', 'Export filtered ({{count}}) ▾', { count: visibleCount });
    if (countEl) countEl.textContent = `(${visibleCount}) ▾`;
    return;
  }

  labelEl.textContent = dt('dashboard.export.visible', 'Export visible ({{count}}) ▾', { count: visibleCount });
  if (countEl) countEl.textContent = `(${visibleCount}) ▾`;
}

function questionnaireSortKey(key) {
  const order = QUESTIONNAIRE_FIELD_ORDER[key];
  if (order != null) return { group: order, key };
  // Legacy or unknown fields go to the end
  const match = String(key).match(/^q(\d+)-/i);
  return { group: match ? Number(match[1]) + 100 : Number.MAX_SAFE_INTEGER, key };
}

function getLogoRefFromData(data) {
  return String(data?.['brand-logo-ref'] || '').trim();
}

function getLogoUrlFromRef(logoRef) {
  const ref = String(logoRef || '').trim();
  if (!ref) return '';
  return `/.netlify/functions/get-logo?ref=${encodeURIComponent(ref)}`;
}

/**
 * Parse an inspiration photo ref entry.
 * Handles both new JSON format {"smallRef":"…","originalRef":"…"}
 * and legacy plain-string format.
 */
function parsePhotoRef(entry) {
  if (!entry) return null;
  try {
    const obj = typeof entry === 'string' ? JSON.parse(entry) : entry;
    if (obj && obj.smallRef) return obj;
  } catch (_) { /* fall through */ }
  // Legacy: plain storage path — treat as the single known ref for both sizes
  return { smallRef: entry, originalRef: entry };
}

function getSmallPhotoUrl(ref) {
  const parsed = parsePhotoRef(ref);
  if (!parsed) return '';
  return `/.netlify/functions/get-photo?bucket=small-photos&ref=${encodeURIComponent(parsed.smallRef)}`;
}

function getOriginalPhotoUrl(ref) {
  const parsed = parsePhotoRef(ref);
  if (!parsed) return '';
  return `/.netlify/functions/get-photo?bucket=original-photos&ref=${encodeURIComponent(parsed.originalRef)}`;
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
    errors['client-name'] = dt('detail.edit.validation.clientName', 'Client name is required.');
  }
  if (!getDisplayValue(data['brand-name'])) {
    errors['brand-name'] = dt('detail.edit.validation.brandName', 'Brand name is required.');
  }
  const email = getDisplayValue(data.email);
  if (!email) {
    errors.email = dt('detail.edit.validation.email', 'Email is required.');
  } else if (!isValidEmail(email)) {
    errors.email = dt('detail.edit.validation.emailInvalid', 'Please enter a valid email address.');
  }
  return errors;
}

async function uploadLogoFile(file, token) {
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

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch('/.netlify/functions/upload-logo', {
    method: 'POST',
    headers,
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
    // Use submit.js — skips emails gracefully and does not hard-fail on missing RESEND_API_KEY
    const response = await fetch('/.netlify/functions/submit', {
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

    if (!response.ok) {
      let errMsg = 'Server error ' + response.status;
      try { const j = await response.json(); errMsg = j.error || errMsg; } catch (_) {}
      throw new Error(errMsg);
    }

    // submit.js returns { success: true } — patch state locally
    if (currentSubmission && String(currentSubmission.id) === String(submissionId)) {
      currentSubmission = { ...currentSubmission, data: { ...currentSubmission.data, status } };
    }
    allSubmissions = allSubmissions.map(item =>
      String(item.id) === String(submissionId)
        ? { ...item, data: { ...item.data, status } }
        : item
    );
    applyCurrentFiltersAndRender();
    renderDetailPanel();
  } catch (error) {
    console.error('setSubmissionStatus failed:', error);
    const msg = error instanceof Error ? error.message : String(error);
    alert(dt('dashboard.alert.statusFailed', 'Failed to update status: {{error}}\n\nMake sure you have run the SQL migration to add the "status" column.', { error: msg }));
  }
}

function setModalActionButtons(mode) {
  const modalActions = document.getElementById('modalActions');
  const modalEditIconBtn = document.getElementById('modalEditIconBtn');
  const modalDeleteIconBtn = document.getElementById('modalDeleteIconBtn');
  if (!modalActions) return;

  if (mode === 'edit') {
    // Hide header icon buttons while editing
    if (modalEditIconBtn) modalEditIconBtn.classList.add('hidden-in-edit');
    if (modalDeleteIconBtn) modalDeleteIconBtn.classList.add('hidden-in-edit');
    modalActions.innerHTML = `
      <button class="btn" id="cancelEditBtn">${dt('detail.edit.cancel', 'Cancel')}</button>
      <button class="btn btn-primary" id="saveEditBtn">${dt('detail.edit.save', 'Save Changes')}</button>
    `;

    // Add cancel icon button to header
    const headerActions = document.getElementById('modalHeaderActions');
    let cancelIconBtn = document.getElementById('modalCancelIconBtn');
    if (!cancelIconBtn && headerActions) {
      cancelIconBtn = document.createElement('button');
      cancelIconBtn.id = 'modalCancelIconBtn';
      cancelIconBtn.className = 'modal-icon-btn modal-cancel-icon-btn';
      cancelIconBtn.setAttribute('aria-label', dt('detail.cancelEdit', 'Cancel editing'));
      cancelIconBtn.innerHTML = '<i data-lucide="rotate-ccw" class="icon icon-btn"></i>';
      const closeBtn = document.getElementById('modalCloseBtn');
      closeBtn?.parentNode?.insertBefore(cancelIconBtn, closeBtn);
    }
    if (cancelIconBtn) cancelIconBtn.classList.remove('hidden-in-edit');
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // view mode: show header icon buttons, clear modal-actions, hide cancel icon
  if (modalEditIconBtn) modalEditIconBtn.classList.remove('hidden-in-edit');
  if (modalDeleteIconBtn) modalDeleteIconBtn.classList.remove('hidden-in-edit');
  const cancelIconBtn = document.getElementById('modalCancelIconBtn');
  if (cancelIconBtn) cancelIconBtn.classList.add('hidden-in-edit');

  // No approve/reject buttons in footer — they live in the overview card dropdown
  modalActions.innerHTML = '';
}

function syncDraftFromInputs() {
  if (!isEditingSubmission || !editDraftData) return;
  const modalBody = document.getElementById('modalBody');
  if (!modalBody) return;

  // Text / email / date inputs and textareas (not checkbox or radio)
  modalBody.querySelectorAll('[data-edit-key]').forEach(element => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
    const type = element.getAttribute('type') || '';
    if (type === 'checkbox' || type === 'radio') return;
    const key = String(element.getAttribute('data-edit-key') || '');
    if (!key) return;
    editDraftData[key] = element.value;
  });

  // Checkbox groups → collect all checked values into an array keyed by data-edit-group
  const checkboxGroups = {};
  modalBody.querySelectorAll('input[type="checkbox"][data-edit-group]').forEach(cb => {
    const group = cb.getAttribute('data-edit-group') || '';
    if (!group) return;
    if (!checkboxGroups[group]) checkboxGroups[group] = [];
    if (cb.checked) checkboxGroups[group].push(cb.value);
  });
  Object.assign(editDraftData, checkboxGroups);

  // Radio groups → single selected value per key
  const radioSeen = new Set();
  modalBody.querySelectorAll('input[type="radio"][data-edit-key]').forEach(radio => {
    const key = radio.getAttribute('data-edit-key') || '';
    if (!key) return;
    if (!radioSeen.has(key)) { radioSeen.add(key); editDraftData[key] = ''; }
    if (radio.checked) editDraftData[key] = radio.value;
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
        <div class="empty-state-title">${dt('dashboard.noSubmissions.title', 'No submissions found')}</div>
        <div class="empty-state-copy">${dt('dashboard.noSubmissions.message', 'Try adjusting your search or date filter.')}</div>
        <button class="btn empty-state-action" id="clearFiltersBtn">${dt('dashboard.clearFilters', 'Clear filters')}</button>
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
        if (dfLabel) dfLabel.textContent = dt('dashboard.toolbar.dateOptions.all', 'All dates');
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
    const statusLabel = submissionStatus === 'approved' ? dt('dashboard.status.approved', 'Approved') : submissionStatus === 'rejected' ? dt('dashboard.status.rejected', 'Rejected') : dt('dashboard.status.pending', 'Pending');
    const statusBadge = `<span class="status-badge ${submissionStatus}">${statusLabel}</span>`;

    const projectStatusRaw = String(data['project-status'] || '').toLowerCase();
    const projectStatusLabels = { 'not-started': dt('dashboard.status.notStarted', 'Not Started'), 'in-progress': dt('dashboard.status.inProgress', 'In Progress'), 'done': dt('dashboard.status.done', 'Done'), 'abandoned': dt('dashboard.status.abandoned', 'Abandoned') };
    const projectStatusBadge = projectStatusRaw && projectStatusLabels[projectStatusRaw]
      ? `<span class="status-badge project-status-badge project-status-${projectStatusRaw}">${projectStatusLabels[projectStatusRaw]}</span>`
      : '';

    const agreedDeliveryRaw = getDisplayValue(data['agreed-delivery-date']);
    const deliveryRaw = getDisplayValue(data['delivery-date']);
    let deliveryDisplay;
    let deliveryLabel;
    if (agreedDeliveryRaw) {
      deliveryDisplay = escapeHtml(agreedDeliveryRaw);
      deliveryLabel = dt('dashboard.card.agreed', 'Agreed');
    } else if (deliveryRaw) {
      deliveryDisplay = `${escapeHtml(deliveryRaw)} <span class="delivery-proposed-tag">${dt('dashboard.card.proposed', 'Proposed')}</span>`;
      deliveryLabel = dt('dashboard.card.delivery', 'Delivery');
    } else {
      deliveryDisplay = `<span class="delivery-badge-not-set">${dt('dashboard.card.notSet', 'Not set')}</span>`;
      deliveryLabel = dt('dashboard.card.delivery', 'Delivery');
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
          <div class="submission-text">
            <div class="submission-brand">${brandName}</div>
            <div class="submission-badges">${statusBadge}${projectStatusBadge}</div>
            <div class="submission-client">${clientName}</div>
          </div>
        </div>
        <div class="submission-meta">
          <div class="submission-date" title="${relativeTime}">${dateStr} · ${timeStr}</div>
          <button class="card-edit-btn" aria-label="Edit submission ${brandName}">
            <i data-lucide="pen" class="icon icon-btn"></i>
            <span class="card-btn-label">${dt('dashboard.card.edit', 'Edit')}</span>
          </button>
          <div class="card-export">
            <button class="card-export-btn" aria-haspopup="menu" aria-expanded="${exportMenuOpen ? 'true' : 'false'}" aria-label="Export submission ${brandName}">
              <i data-lucide="download" class="icon icon-btn"></i>
              <span class="card-btn-label">${dt('dashboard.card.export', 'Export')}</span>
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
          <div class="detail-label">${dt('dashboard.card.email', 'Email')}</div>
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
  applyTheme(getDashActiveMode());

  // Listen for OS changes when in auto mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getDashActiveMode() === 'auto') applyTheme('auto');
  });
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
      ? dt('dashboard.selected', '{{count}} selected', { count: selectedCount })
      : dt('dashboard.showing', 'Showing {{count}} submissions', { count: currentRenderedSubmissions.length });
  }

  if (clearSelectionBtn) {
    clearSelectionBtn.disabled = selectedCount === 0;
  }

  if (deleteSelectedBtn) {
    deleteSelectedBtn.disabled = selectedCount === 0;
  }

  if (selectVisibleBtn) {
    selectVisibleBtn.title = allVisibleSelected ? dt('dashboard.select.deselect', 'Deselect Visible') : dt('dashboard.select.visible', 'Select Visible');
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

  if (!confirm(dt('dashboard.confirm.deleteSelected', 'Delete {{count}} selected submission(s)? This action cannot be undone.', { count: selectedIds.length }))) {
    return;
  }

  const deleteBtn = document.getElementById('deleteSelectedBtn');
  const originalBtnText = deleteBtn ? deleteBtn.textContent : '';

  try {
    let token = null;

    if (window.netlifyIdentity) {
      const user = netlifyIdentity.currentUser();
      if (!user) {
        alert('Not authenticated');
        return;
      }
      token = await user.jwt();
    }

    if (deleteBtn) {
      deleteBtn.disabled = true;
      deleteBtn.textContent = dt('dashboard.alert.deleting', 'Deleting...');
    }

    let deletedCount = 0;
    const chunkSize = 5;

    for (let index = 0; index < selectedIds.length; index += chunkSize) {
      const batch = selectedIds.slice(index, index + chunkSize);
      const results = await Promise.allSettled(batch.map(id => deleteSubmissionById(id, token)));
      deletedCount += results.filter(result => result.status === 'fulfilled' && result.value === true).length;
    }

    if (deletedCount === 0) {
      alert(dt('dashboard.alert.failedDeleteSelected', 'Failed to delete selected submissions. Please try again.'));
      return;
    }

    const failedCount = selectedIds.length - deletedCount;
    selectedSubmissionIds.clear();
    await loadSubmissions();

    if (failedCount > 0) {
      alert(dt('dashboard.alert.deletedWithFails', 'Deleted {{count}} submission(s). {{failed}} failed.', { count: deletedCount, failed: failedCount }));
    } else {
      alert(dt('dashboard.alert.deletedSuccess', 'Deleted {{count}} submission(s) successfully.', { count: deletedCount }));
    }
  } catch (error) {
    console.error('Error deleting selected submissions:', error);
    alert(dt('dashboard.alert.failedDeleteSelected', 'Failed to delete selected submissions. Please try again.'));
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

// ── Edit-mode: field-aware questionnaire renderer ──────────────────────────
// Returns proper HTML (checkboxes, radios, text inputs, textareas) matching
// the exact input types used in index.html — so editing feels like filling
// the form, not typing free text.
// i18n-aware: labels resolved at render time via dt()
const EDIT_CHECKBOX_DEFS = {
  'q9-color': [
    { value: 'Warm neutrals',    i18n: 'form.questions.q9.options.warmNeutrals',       en: 'Warm neutrals (cream, sand, terracotta)' },
    { value: 'Cool neutrals',    i18n: 'form.questions.q9.options.coolNeutrals',       en: 'Cool neutrals (slate, stone, mist)' },
    { value: 'Deep & moody',     i18n: 'form.questions.q9.options.deepMoody',          en: 'Deep & moody (navy, forest, burgundy)' },
    { value: 'Bold & saturated', i18n: 'form.questions.q9.options.boldSaturated',      en: 'Bold & saturated (vibrant primaries)' },
    { value: 'Pastels',          i18n: 'form.questions.q9.options.pastels',            en: 'Pastels & soft tones' },
    { value: 'Monochrome',       i18n: 'form.questions.q9.options.monochrome',         en: 'Black & white / monochrome' },
    { value: 'Metallic',         i18n: 'form.questions.q9.options.metallic',           en: 'Metallic / luxury tones (gold, bronze)' },
    { value: 'Nature-inspired',  i18n: 'form.questions.q9.options.natureInspired',     en: 'Nature-inspired (moss, rust, clay)' },
    { value: 'No preference',    i18n: 'form.questions.q9.options.noPreference',       en: 'No preference, I trust your judgment' },
  ],
  'q11-aesthetic': [
    { value: 'Luxury & refined',         i18n: 'form.questions.q11.options.luxuryRefined',         en: 'Luxury & refined' },
    { value: 'Organic & artisan',         i18n: 'form.questions.q11.options.organicArtisan',        en: 'Organic & artisan' },
    { value: 'Minimal & functional',      i18n: 'form.questions.q11.options.minimalFunctional',     en: 'Minimal & functional' },
    { value: 'Bold & graphic',            i18n: 'form.questions.q11.options.boldGraphic',           en: 'Bold & graphic' },
    { value: 'Playful & illustrative',    i18n: 'form.questions.q11.options.playfulIllustrative',   en: 'Playful & illustrative' },
    { value: 'Editorial & intellectual',  i18n: 'form.questions.q11.options.editorialIntellectual', en: 'Editorial & intellectual' },
    { value: 'Tech-forward',              i18n: 'form.questions.q11.options.techForward',           en: 'Tech-forward & innovative' },
    { value: 'Nostalgic & heritage',      i18n: 'form.questions.q11.options.nostalgicHeritage',     en: 'Nostalgic & heritage' },
  ],
  'q13-deliverables': [
    { value: 'Primary logo',       i18n: 'form.questions.q13.options.primaryLogo',       en: 'Primary logo' },
    { value: 'Logo variations',    i18n: 'form.questions.q13.options.logoVariations',    en: 'Logo variations & submarks' },
    { value: 'Color & typography', i18n: 'form.questions.q13.options.colorTypography',   en: 'Color palette & typography system' },
    { value: 'Brand guidelines',   i18n: 'form.questions.q13.options.brandGuidelines',   en: 'Brand guidelines document' },
    { value: 'Stationery',         i18n: 'form.questions.q13.options.stationery',        en: 'Business cards & stationery' },
    { value: 'Social media',       i18n: 'form.questions.q13.options.socialMedia',       en: 'Social media templates' },
    { value: 'Website design',     i18n: 'form.questions.q13.options.websiteDesign',     en: 'Website design' },
    { value: 'Packaging',          i18n: 'form.questions.q13.options.packaging',         en: 'Packaging design' },
  ],
};
function getEditCheckboxOptions(key) {
  const defs = EDIT_CHECKBOX_DEFS[key];
  if (!defs) return null;
  return defs.map(d => ({ value: d.value, label: dt(d.i18n, d.en) }));
}

// i18n-aware: labels resolved at render time via dt()
const EDIT_RADIO_DEFS = {
  'q14-budget': [
    { value: 'Low / lowest possible cost',         i18n: 'form.questions.q14.options.low',  en: 'Low / lowest possible cost' },
    { value: 'Mid-range / balanced price–1quality', i18n: 'form.questions.q14.options.mid',  en: 'Mid-range / balanced price–quality' },
    { value: 'High / premium',                      i18n: 'form.questions.q14.options.high', en: 'High / premium' },
    { value: 'Premium / full brand investment',     i18n: 'form.questions.q14.options.best', en: 'Premium / full brand investment (€3,000+)' },
  ],
  'q7-decision-maker': [
    { value: 'Me / myself',        i18n: 'form.questions.q7.options.me',    en: 'Me / myself' },
    { value: 'My boss / the boss', i18n: 'form.questions.q7.options.boss',  en: 'My boss / the boss' },
    { value: 'Other',              i18n: 'form.questions.q7.options.other', en: 'Other (please specify)' },
  ],
  'delivery-date': [
    { value: 'ASAP',         i18n: 'form.metadata.deliveryDateOptions.asap',       en: 'ASAP (As Soon As Possible)' },
    { value: '2–4 weeks', i18n: 'form.metadata.deliveryDateOptions.weeks2to4', en: '2–4 weeks' },
    { value: '1–2 months', i18n: 'form.metadata.deliveryDateOptions.months1to2', en: '1–2 months' },
    { value: '3+ months',    i18n: 'form.metadata.deliveryDateOptions.months3plus', en: '3+ months' },
  ],
};
function getEditRadioOptions(key) {
  const defs = EDIT_RADIO_DEFS[key];
  if (!defs) return null;
  return defs.map(d => ({ value: d.value, label: dt(d.i18n, d.en) }));
}

// Single-line text fields (use <input type="text"> instead of <textarea>)
const EDIT_TEXT_INPUT_FIELDS = new Set([
  'q6-positioning', 'q10-colors-to-avoid', 'q12-existing-assets', 'q7-decision-maker-other'
]);

// These fields are rendered inline as part of another field; skip standalone rendering
const EDIT_INLINE_FIELDS = new Set(['q11-aesthetic-description', 'q7-decision-maker-other']);

function renderEditInspirationUpload(rawValue, qNum, labelText) {
  const refs = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
  const safeKey = 'q15-inspiration-refs';
  const editLabel = qNum ? `${qNum}: ${escapeHtml(labelText)}` : escapeHtml(labelText);
  const uploadLabel   = dt('form.questions.q15.uploadPrompt', 'Click or drag images here');
  const uploadSublabel = dt('form.questions.q15.uploadLimit', 'Up to 8 images · PNG, JPG, WEBP, GIF');

  const thumbsHtml = refs.map((ref, i) => {
    const smallUrl = escapeHtml(getSmallPhotoUrl(String(ref)));
    const refJson  = escapeHtml(JSON.stringify(ref));
    return `<div class="edit-insp-thumb" data-ref-index="${i}">
      <img src="${smallUrl}" alt="Inspiration ${i + 1}" loading="lazy">
      <button type="button" class="edit-insp-remove" data-ref-index="${i}" aria-label="Remove image ${i + 1}">×</button>
    </div>`;
  }).join('');

  const atLimit = refs.length >= 8;
  const dropzoneHtml = atLimit ? '' : `
    <label class="edit-insp-dropzone" id="editInspDropzone" tabindex="0" role="button"
           aria-label="${uploadLabel}">
      <input type="file" id="editInspFileInput"
             accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif"
             multiple hidden>
      <i data-lucide="upload-cloud" class="icon edit-insp-upload-icon"></i>
      <span class="edit-insp-upload-label">${escapeHtml(uploadLabel)}</span>
      <span class="edit-insp-upload-sub">${escapeHtml(uploadSublabel)}</span>
    </label>`;

  return `
    <article class="qa-card" id="editInspCard">
      <div class="qa-label-row edit-qa-label-row">
        ${qNum ? `<span class="qa-num-badge">${qNum}</span>` : ''}
        <span class="qa-label-text">${editLabel}</span>
      </div>
      <div class="edit-insp-grid" id="editInspGrid">${thumbsHtml}</div>
      ${dropzoneHtml}
      <div class="edit-insp-status" id="editInspStatus" aria-live="polite"></div>
    </article>`;
}

function renderEditableQuestionnaireField(key, rawValue, qNum, labelText) {
  // Skip inline fields — they're rendered inside their parent field
  if (EDIT_INLINE_FIELDS.has(key)) return '';

  // ── Inspiration image upload zone (Q14 / q15-inspiration-refs) ─────────────
  if (key === 'q15-inspiration-refs') {
    return renderEditInspirationUpload(rawValue, qNum, labelText);
  }

  const safeKey = escapeHtml(key);
  const displayNum = qNum ? `Q${qNum}` : '';
  const editLabel = displayNum ? `${displayNum}: ${escapeHtml(labelText)}` : escapeHtml(labelText);

  function wrap(inner) {
    return `
      <article class="qa-card">
        <div class="qa-label-row edit-qa-label-row">
          ${qNum ? `<span class="qa-num-badge">${qNum}</span>` : ''}
          <label class="qa-label-text">${editLabel}</label>
        </div>
        ${inner}
      </article>`;
  }

  // ── CHECKBOX groups ─────────────────────────────────────────────────────────
  const checkboxOpts = getEditCheckboxOptions(key);
  if (checkboxOpts) {
    const checked = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
    const optionsHtml = checkboxOpts.map(opt => {
      const isChecked = checked.includes(opt.value);
      return `<label class="edit-check-label${isChecked ? ' edit-check-label--checked' : ''}">
        <input type="checkbox"
               data-edit-key="${safeKey}"
               data-edit-group="${safeKey}"
               value="${escapeHtml(opt.value)}"
               ${isChecked ? 'checked' : ''}>
        <span>${escapeHtml(opt.label)}</span>
      </label>`;
    }).join('');

    // q11-aesthetic gets an extra "describe your own" textarea below
    let extra = '';
    if (key === 'q11-aesthetic') {
      const descVal = escapeHtml(String(editDraftData?.['q11-aesthetic-description'] ?? ''));
      extra = `<textarea class="edit-textarea edit-aesthetic-desc"
                         data-edit-key="q11-aesthetic-description"
                         maxlength="1000"
                         placeholder="${dt('form.questions.q11Description.placeholder', 'Or describe your own aesthetic direction...')}">${descVal}</textarea>`;
    }

    return wrap(`<div class="edit-check-grid">${optionsHtml}</div>${extra}`);
  }

  // ── RADIO groups ────────────────────────────────────────────────────────────
  const radioOpts = getEditRadioOptions(key);
  if (radioOpts) {
    const currentVal = String(rawValue ?? '');
    const optionsHtml = radioOpts.map(opt => {
      const isChecked = currentVal === opt.value;
      return `<label class="edit-check-label${isChecked ? ' edit-check-label--checked' : ''}">
        <input type="radio"
               name="edit-radio-${safeKey}"
               data-edit-key="${safeKey}"
               value="${escapeHtml(opt.value)}"
               ${isChecked ? 'checked' : ''}>
        <span>${escapeHtml(opt.label)}</span>
      </label>`;
    }).join('');

    // q7-decision-maker gets an "Other" text input below
    let extra = '';
    if (key === 'q7-decision-maker') {
      const otherVal = escapeHtml(String(editDraftData?.['q7-decision-maker-other'] ?? ''));
      const otherPh  = dt('form.questions.q7.otherPlaceholder', 'Please specify...');
      extra = `<input type="text"
                      class="edit-input edit-other-input"
                      data-edit-key="q7-decision-maker-other"
                      value="${otherVal}"
                      placeholder="${escapeHtml(otherPh)}"
                      maxlength="300">`;
    }

    return wrap(`<div class="edit-check-grid edit-radio-grid">${optionsHtml}</div>${extra}`);
  }

  // ── Single-line text input ──────────────────────────────────────────────────
  if (EDIT_TEXT_INPUT_FIELDS.has(key)) {
    const val = escapeHtml(String(rawValue ?? ''));
    return wrap(`<input type="text" class="edit-input" data-edit-key="${safeKey}" value="${val}" maxlength="300">`);
  }

  // ── Default: textarea ───────────────────────────────────────────────────────
  const val = escapeHtml(String(rawValue ?? ''));
  return wrap(`<textarea class="edit-textarea" data-edit-key="${safeKey}">${val}</textarea>`);
}

// ── Inspiration image upload in edit mode ────────────────────────────────────
async function uploadInspirationFile(file) {
  const contentBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });

  const response = await fetch('/.netlify/functions/upload-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, mimeType: file.type, contentBase64 })
  });

  if (!response.ok) {
    let msg = 'Upload failed.';
    try { const j = await response.json(); msg = j.error || msg; } catch (_) {}
    throw new Error(msg);
  }
  const json = await response.json();
  // Return the compact JSON string that the DB stores
  return JSON.stringify({ smallRef: json.smallRef, originalRef: json.originalRef });
}

function refreshEditInspGrid() {
  const grid   = document.getElementById('editInspGrid');
  const card   = document.getElementById('editInspCard');
  if (!grid || !card || !editDraftData) return;

  const refs = Array.isArray(editDraftData['q15-inspiration-refs'])
    ? editDraftData['q15-inspiration-refs']
    : (editDraftData['q15-inspiration-refs'] ? [editDraftData['q15-inspiration-refs']] : []);

  grid.innerHTML = refs.map((ref, i) => {
    const smallUrl = escapeHtml(getSmallPhotoUrl(String(ref)));
    return `<div class="edit-insp-thumb">
      <img src="${smallUrl}" alt="Inspiration ${i + 1}" loading="lazy">
      <button type="button" class="edit-insp-remove" data-ref-index="${i}" aria-label="Remove image">×</button>
    </div>`;
  }).join('');

  // Show/hide the dropzone depending on whether we're at the 8-image limit
  const atLimit = refs.length >= 8;
  let dropzone = card.querySelector('.edit-insp-dropzone');
  if (atLimit && dropzone) {
    dropzone.remove();
  } else if (!atLimit && !dropzone) {
    const uploadLabel    = dt('form.questions.q15.uploadPrompt', 'Click or drag images here');
    const uploadSublabel = dt('form.questions.q15.uploadLimit', 'Up to 8 images · PNG, JPG, WEBP, GIF');
    const dzEl = document.createElement('label');
    dzEl.className = 'edit-insp-dropzone';
    dzEl.id = 'editInspDropzone';
    dzEl.setAttribute('tabindex', '0');
    dzEl.setAttribute('role', 'button');
    dzEl.setAttribute('aria-label', uploadLabel);
    dzEl.innerHTML = `<input type="file" id="editInspFileInput"
             accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif"
             multiple hidden>
      <i data-lucide="upload-cloud" class="icon edit-insp-upload-icon"></i>
      <span class="edit-insp-upload-label">${escapeHtml(uploadLabel)}</span>
      <span class="edit-insp-upload-sub">${escapeHtml(uploadSublabel)}</span>`;
    card.insertBefore(dzEl, card.querySelector('.edit-insp-status'));
    setupInspirationDropzone(dzEl);
  } else if (!atLimit && dropzone) {
    // ensure the file input listener is alive (re-attach after innerHTML refresh)
    setupInspirationDropzone(dropzone);
  }

  // Wire remove buttons
  grid.querySelectorAll('.edit-insp-remove[data-ref-index]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-ref-index'), 10);
      const current = Array.isArray(editDraftData['q15-inspiration-refs'])
        ? editDraftData['q15-inspiration-refs']
        : [];
      editDraftData['q15-inspiration-refs'] = current.filter((_, i) => i !== idx);
      markEditDirty();
      refreshEditInspGrid();
      if (window.lucide) window.lucide.createIcons();
    });
  });
}

function setupInspirationDropzone(dropzone) {
  if (!dropzone) return;
  const fileInput = dropzone.querySelector('input[type="file"]') || document.getElementById('editInspFileInput');
  if (!fileInput) return;

  async function handleFiles(files) {
    const statusEl = document.getElementById('editInspStatus');
    const current  = Array.isArray(editDraftData?.['q15-inspiration-refs'])
      ? [...editDraftData['q15-inspiration-refs']]
      : [];
    const slots = 8 - current.length;
    const toUpload = Array.from(files).slice(0, slots);
    if (!toUpload.length) return;

    if (statusEl) statusEl.textContent = dt('form.questions.q15.uploadPrompt', 'Uploading…');

    let uploaded = 0, failed = 0;
    for (const file of toUpload) {
      try {
        const ref = await uploadInspirationFile(file);
        current.push(ref);
        uploaded++;
      } catch (err) {
        failed++;
        console.error('[editInsp] Upload error:', err);
      }
    }

    editDraftData['q15-inspiration-refs'] = current;
    markEditDirty();

    if (statusEl) {
      statusEl.textContent = failed
        ? `${uploaded} uploaded, ${failed} failed.`
        : '';
    }
    refreshEditInspGrid();
    if (window.lucide) window.lucide.createIcons();
  }

  // Click-to-browse
  dropzone.addEventListener('click', e => {
    if (e.target !== fileInput) fileInput.click();
  });
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) handleFiles(fileInput.files);
    fileInput.value = '';
  });

  // Drag & drop
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('edit-insp-dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('edit-insp-dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('edit-insp-dragover');
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });
}

function setupEditInspirationUpload() {
  const dropzone = document.getElementById('editInspDropzone');
  setupInspirationDropzone(dropzone);
  // Wire existing remove buttons
  refreshEditInspGrid();
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
        <div class="edit-banner">${dt('detail.editBanner', 'Editing submission, changes are not saved yet')}</div>
        ${sectionHeader('list', dt('detail.sections.overview', 'Overview'))}
        <div class="logo-upload-wrap">
          <div class="logo-upload-row">
            <label class="logo-dropzone" id="logoDropzone" tabindex="0" aria-label="Upload brand logo">
              <input id="logoFileInput" type="file" accept=".png,.jpg,.jpeg,.svg,.webp,image/png,image/jpeg,image/svg+xml,image/webp" hidden />
              <i data-lucide="upload" class="icon icon-upload-sm"></i>
              <span>${dt('detail.edit.logoUpload', 'Drop logo or click to upload')}</span>
            </label>
            <button class="modal-icon-btn logo-remove-btn" id="removeLogoBtn" type="button" aria-label="Remove logo" title="Remove logo">
              <i data-lucide="trash" class="icon icon-btn"></i>
            </button>
          </div>
          <div class="edit-error" id="logoUploadError"></div>
        </div>
        <div class="overview-grid">
          ${renderEditableField(dt('detail.overview.clientName', 'Client Name'), 'client-name', 'text')}
          ${renderEditableField(dt('detail.overview.email', 'Email'), 'email', 'email')}
          ${renderEditableField(dt('detail.overview.brandName', 'Brand Name'), 'brand-name', 'text')}
          <div class="overview-card edit-field">
            <label class="overview-label" for="edit-delivery-date">${dt('detail.overview.formDelivery', 'Form Delivery Date')}</label>
            <div class="custom-delivery-select" id="editDeliveryDropdown">
              <button type="button" class="edit-input edit-delivery-btn" id="editDeliveryBtn" aria-haspopup="listbox" aria-expanded="false">
                <span class="edit-delivery-label" id="editDeliveryLabel">${escapeHtml(data['delivery-date'] || dt('detail.edit.selectTimeframe', 'Select a timeframe'))}</span>
                <i data-lucide="chevron-down" class="icon edit-delivery-caret"></i>
              </button>
              <div class="edit-delivery-menu" id="editDeliveryMenu" role="listbox">
                <button class="edit-delivery-option${!data['delivery-date'] ? ' active' : ''}" data-value="" role="option">${dt('detail.edit.notSet', '— Not set —')}</button>
                <button class="edit-delivery-option${data['delivery-date'] === 'ASAP' ? ' active' : ''}" data-value="ASAP" role="option">${dt('detail.edit.asap', 'ASAP (As Soon As Possible)')}</button>
                <button class="edit-delivery-option${data['delivery-date'] === '2–4 weeks' ? ' active' : ''}" data-value="2–4 weeks" role="option">2–4 weeks</button>
                <button class="edit-delivery-option${data['delivery-date'] === '1–2 months' ? ' active' : ''}" data-value="1–2 months" role="option">1–2 months</button>
                <button class="edit-delivery-option${data['delivery-date'] === '3+ months' ? ' active' : ''}" data-value="3+ months" role="option">3+ months</button>
              </div>
            </div>
          </div>
          <div class="overview-card edit-field">
            <label class="overview-label" for="edit-agreed-delivery-date">${dt('detail.overview.agreedDelivery', 'Agreed Delivery Date')}</label>
            <input id="edit-agreed-delivery-date" class="edit-input" type="date" data-edit-key="agreed-delivery-date" value="${escapeHtml(normalizeDateInputValue(data['agreed-delivery-date']))}" />
          </div>
          <div class="overview-card edit-field">
            <label class="overview-label">${dt('detail.overview.submissionStatus', 'Submission Status')}</label>
            <div class="custom-delivery-select" id="editSubmissionStatusDropdown">
              <button type="button" class="edit-input edit-delivery-btn" id="editSubmissionStatusBtn" aria-haspopup="listbox" aria-expanded="false">
                <span class="edit-delivery-label" id="editSubmissionStatusLabel">${(function(){ const s = String(data['status'] || 'pending').toLowerCase(); return s === 'approved' ? dt('dashboard.status.approved','Approved') : s === 'rejected' ? dt('dashboard.status.rejected','Rejected') : dt('dashboard.status.pending','Pending'); })()}</span>
                <i data-lucide="chevron-down" class="icon edit-delivery-caret"></i>
              </button>
              <div class="edit-delivery-menu" id="editSubmissionStatusMenu" role="listbox">
                <button class="edit-delivery-option submission-status-option submission-status-pending${(!data['status'] || data['status'] === 'pending') ? ' active' : ''}" data-value="pending" role="option">${dt('dashboard.status.pending','Pending')}</button>
                <button class="edit-delivery-option submission-status-option submission-status-approved${data['status'] === 'approved' ? ' active' : ''}" data-value="approved" role="option">${dt('dashboard.status.approved','Approved')}</button>
                <button class="edit-delivery-option submission-status-option submission-status-rejected${data['status'] === 'rejected' ? ' active' : ''}" data-value="rejected" role="option">${dt('dashboard.status.rejected','Rejected')}</button>
              </div>
            </div>
          </div>
          <div class="overview-card edit-field">
            <label class="overview-label">${dt('detail.overview.projectStatus', 'Project Status')}</label>
            <div class="custom-delivery-select" id="editProjectStatusDropdown">
              <button type="button" class="edit-input edit-delivery-btn" id="editProjectStatusBtn" aria-haspopup="listbox" aria-expanded="false">
                <span class="edit-delivery-label" id="editProjectStatusLabel">${(function(){ const ps = String(data['project-status'] || ''); const lbs = {'not-started': dt('dashboard.status.notStarted','Not Started'),'in-progress': dt('dashboard.status.inProgress','In Progress'),'done': dt('dashboard.status.done','Done'),'abandoned': dt('dashboard.status.abandoned','Abandoned')}; return ps && lbs[ps] ? lbs[ps] : dt('detail.edit.notSet','— Not set —'); })()}</span>
                <i data-lucide="chevron-down" class="icon edit-delivery-caret"></i>
              </button>
              <div class="edit-delivery-menu" id="editProjectStatusMenu" role="listbox">
                <button class="edit-delivery-option${!data['project-status'] ? ' active' : ''}" data-value="" role="option">${dt('detail.edit.notSet','— Not set —')}</button>
                <button class="edit-delivery-option project-status-option project-status-not-started${data['project-status'] === 'not-started' ? ' active' : ''}" data-value="not-started" role="option">${dt('dashboard.status.notStarted','Not Started')}</button>
                <button class="edit-delivery-option project-status-option project-status-in-progress${data['project-status'] === 'in-progress' ? ' active' : ''}" data-value="in-progress" role="option">${dt('dashboard.status.inProgress','In Progress')}</button>
                <button class="edit-delivery-option project-status-option project-status-done${data['project-status'] === 'done' ? ' active' : ''}" data-value="done" role="option">${dt('dashboard.status.done','Done')}</button>
                <button class="edit-delivery-option project-status-option project-status-abandoned${data['project-status'] === 'abandoned' ? ' active' : ''}" data-value="abandoned" role="option">${dt('dashboard.status.abandoned','Abandoned')}</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    `;
  } else {
    overviewSection = `
      <section class="detail-section">
        ${sectionHeader('list', dt('detail.sections.overview', 'Overview'))}
        <div class="overview-grid">
          <div class="overview-card"><div class="overview-label">${dt('detail.overview.clientName', 'Client Name')}</div><div class="overview-value">${escapeHtml(clientName)}</div></div>
          <div class="overview-card"><div class="overview-label">${dt('detail.overview.email', 'Email')}</div><div class="overview-value">${escapeHtml(email)}</div></div>
          <div class="overview-card"><div class="overview-label">${dt('detail.overview.brandName', 'Brand Name')}</div><div class="overview-value">${escapeHtml(brandName)}</div></div>
          <div class="overview-card"><div class="overview-label">${dt('detail.overview.deliveryDate', 'Delivery Date')}</div><div class="overview-value">${formatDeliveryDateForOverview(data['delivery-date'])}</div></div>
          <div class="overview-card"><div class="overview-label">${dt('detail.overview.agreedDelivery', 'Agreed Delivery Date')}</div><div class="overview-value">${data['agreed-delivery-date'] ? escapeHtml(formatDeliveryDateForOverview(data['agreed-delivery-date'])) : `<span class="overview-empty-badge">${dt('detail.overview.notSetYet', 'Not set yet')}</span>`}</div></div>
          <div class="overview-card"><div class="overview-label">${dt('detail.overview.projectStatus', 'Project Status')}</div><div class="overview-value">${(function(){ const ps = String(data['project-status'] || '').toLowerCase(); const lbs = {'not-started': dt('dashboard.status.notStarted','Not Started'),'in-progress': dt('dashboard.status.inProgress','In Progress'),'done': dt('dashboard.status.done','Done'),'abandoned': dt('dashboard.status.abandoned','Abandoned')}; return ps && lbs[ps] ? '<span class="status-badge project-status-badge project-status-' + ps + '">' + lbs[ps] + '</span>' : `<span class="overview-empty-badge">${dt('detail.overview.notSet','Not set')}</span>`; })()}</div></div>
          <div class="overview-card"><div class="overview-label">${dt('detail.overview.submissionStatus', 'Submission Status')}</div><div class="overview-value">${(function(){ const s = String(data['status'] || 'pending').toLowerCase(); if (s === 'approved') return `<span class="status-badge approved">${dt('dashboard.status.approved','Approved')}</span>`; if (s === 'rejected') return `<span class="status-badge rejected">${dt('dashboard.status.rejected','Rejected')}</span>`; return `<span class="status-badge pending">${dt('dashboard.status.pending','Pending')}</span>`; })()}</div></div>
        </div>
      </section>
    `;
  }

  const historySection = `
    <section class="detail-section">
      ${sectionHeader('history', dt('detail.sections.history', 'Submission History'), { collapsible: true, collapsed: true, targetId: 'historyBody' })}
      <div class="detail-section-body" id="historyBody" hidden>
        ${renderHistoryTimeline(history, { isLoading: !Array.isArray(history) })}
      </div>
    </section>
  `;

  const questionnaireEntries = Object.entries(data)
    .filter(([key]) => isQuestionnaireKey(key) && VALID_QUESTIONNAIRE_FIELDS.has(key))
    .sort(([a], [b]) => {
      const aKey = questionnaireSortKey(a);
      const bKey = questionnaireSortKey(b);
      if (aKey.group !== bKey.group) return aKey.group - bKey.group;
      return aKey.key.localeCompare(bKey.key);
    });

  const hasAnyResponse = questionnaireEntries.some(([, value]) => Boolean(getDisplayValue(value)));

  // Render questionnaire items in sorted order
  const questionnaireItems = questionnaireEntries.map(([key, value]) => {
    const qNum = QUESTIONNAIRE_DISPLAY_NUM[key] || null;
    const labelText = getFieldLabel(key) || key
      .replace(/^q[\w]*-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
    const safeLabel = escapeHtml(labelText);

    if (isEditingSubmission) {
      const qNumEdit = QUESTIONNAIRE_DISPLAY_NUM[key] || null;
      const labelForEdit = getFieldLabel(key) || key
        .replace(/^q[\w]*-/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());
      return renderEditableQuestionnaireField(key, value, qNumEdit, labelForEdit);
    }

    const displayValue = getDisplayValue(value);

    // Special rendering for q15-inspiration-refs (also handles legacy q20-inspiration-refs key)
    if ((key === 'q15-inspiration-refs' || key === 'q20-inspiration-refs') && !isEditingSubmission) {
      const refs = Array.isArray(value) ? value : (value ? [value] : []);
      const imagesHtml = refs.length > 0
        ? `<div class="q20-dash-preview-grid">${refs.map((ref, i) => {
            const smallUrl    = escapeHtml(getSmallPhotoUrl(String(ref)));
            const originalUrl = escapeHtml(getOriginalPhotoUrl(String(ref)));
            return `<div class="q20-dash-thumb-wrap" title="Click to open full resolution" data-original-url="${originalUrl}"><img src="${smallUrl}" class="q20-dash-thumb" alt="Inspiration ${i + 1}" loading="lazy" /><div class="q20-dash-thumb-overlay"><i data-lucide="zoom-in" class="icon q20-zoom-icon"></i></div></div>`;
          }).join('')}</div>`
        : `<div class="qa-value qa-empty">${dt('detail.questionnaire.noImages', 'No images uploaded')}</div>`;
      return `<article class="qa-card"><div class="qa-label-row"><span class="qa-num-badge">15</span><span class="qa-label-text">Inspiration Images</span></div>${imagesHtml}</article>`;
    }

    const valueMarkup = displayValue
      ? `<div class="qa-value">${escapeHtml(displayValue)}</div>`
      : `<div class="qa-value qa-empty">${dt('detail.questionnaire.noResponse', 'No response')}</div>`;

    const labelHtml = qNum
      ? `<div class="qa-label-row"><span class="qa-num-badge">${qNum}</span><span class="qa-label-text">${safeLabel}</span></div>`
      : `<div class="qa-label">${safeLabel}</div>`;

    return `<article class="qa-card">${labelHtml}${valueMarkup}</article>`;
  }).join('');

  const questionnaireCallout = hasAnyResponse
    ? ''
    : `<div class="questionnaire-callout">${dt('detail.questionnaire.noResponses', 'This submission has no questionnaire responses yet.')}</div>`;

  const questionnaireSection = `
    <section class="detail-section">
      ${sectionHeader('puzzle', dt('detail.sections.questionnaire', 'Brand Questionnaire'))}
      ${questionnaireCallout}
      <div class="qa-grid">${questionnaireItems}</div>
    </section>
  `;

  modalBody.innerHTML = `${overviewSection}${historySection}${questionnaireSection}`;

  // Wire inspiration image thumbnails — open full-res in new tab safely (noopener)
  modalBody.querySelectorAll('.q20-dash-thumb-wrap[data-original-url]').forEach(el => {
    el.addEventListener('click', () => {
      window.open(el.dataset.originalUrl, '_blank', 'noopener,noreferrer');
    });
  });

  // Wire collapsible section toggles
  modalBody.querySelectorAll('.detail-section-toggle').forEach(toggleBtn => {
    toggleBtn.addEventListener('click', () => {
      const targetId = toggleBtn.dataset.collapseTarget;
      const body = targetId ? document.getElementById(targetId) : null;
      const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
      toggleBtn.setAttribute('aria-expanded', isExpanded ? 'false' : 'true');
      toggleBtn.classList.toggle('collapsed', isExpanded);
      if (body) body.hidden = isExpanded;
    });
  });

  setModalActionButtons(isEditingSubmission ? 'edit' : 'view');

  const modalEditIconBtn = document.getElementById('modalEditIconBtn');
  const modalDeleteIconBtn = document.getElementById('modalDeleteIconBtn');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const saveEditBtn = document.getElementById('saveEditBtn');

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

  // Text inputs and textareas
  modalBody.querySelectorAll('[data-edit-key]').forEach(element => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
    const type = element.getAttribute('type') || '';
    if (type === 'checkbox' || type === 'radio') return;
    element.addEventListener('input', () => {
      markEditDirty();
      syncDraftFromInputs();
    });
  });

  // Checkboxes
  modalBody.querySelectorAll('input[type="checkbox"][data-edit-group]').forEach(cb => {
    cb.addEventListener('change', () => {
      // Update checked styling on the parent label
      const label = cb.closest('.edit-check-label');
      if (label) label.classList.toggle('edit-check-label--checked', cb.checked);
      markEditDirty();
      syncDraftFromInputs();
    });
  });

  // Radios
  modalBody.querySelectorAll('input[type="radio"][data-edit-key]').forEach(radio => {
    radio.addEventListener('change', () => {
      // Update checked styling for all radios in the same group
      const groupName = radio.getAttribute('name') || '';
      if (groupName) {
        modalBody.querySelectorAll(`input[name="${groupName}"]`).forEach(r => {
          const lbl = r.closest('.edit-check-label');
          if (lbl) lbl.classList.toggle('edit-check-label--checked', r.checked);
        });
      }
      markEditDirty();
      syncDraftFromInputs();
    });
  });

  // Inspiration image upload zone
  setupEditInspirationUpload();

  // ── Delivery date custom dropdown ──────────────────────────────────
  const editDeliveryBtn = document.getElementById('editDeliveryBtn');
  const editDeliveryMenu = document.getElementById('editDeliveryMenu');
  const editDeliveryLabel = document.getElementById('editDeliveryLabel');
  const editDeliveryDropdown = document.getElementById('editDeliveryDropdown');

  // ── Project Status dropdown ──────────────────────────────────────
  // ── Submission Status dropdown (edit mode) ─────────────────────
  const editSubmissionStatusBtn = document.getElementById('editSubmissionStatusBtn');
  const editSubmissionStatusMenu = document.getElementById('editSubmissionStatusMenu');
  const editSubmissionStatusLabel = document.getElementById('editSubmissionStatusLabel');
  const editSubmissionStatusDropdown = document.getElementById('editSubmissionStatusDropdown');

  if (editSubmissionStatusBtn && editSubmissionStatusMenu) {
    editSubmissionStatusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = editSubmissionStatusMenu.classList.toggle('open');
      editSubmissionStatusBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    editSubmissionStatusMenu.querySelectorAll('.edit-delivery-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const val = opt.dataset.value || 'pending';
        editSubmissionStatusMenu.querySelectorAll('.edit-delivery-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        const labels = { pending: dt('dashboard.status.pending','Pending'), approved: dt('dashboard.status.approved','Approved'), rejected: dt('dashboard.status.rejected','Rejected') };
        if (editSubmissionStatusLabel) editSubmissionStatusLabel.textContent = labels[val] || 'Pending';
        editSubmissionStatusMenu.classList.remove('open');
        editSubmissionStatusBtn.setAttribute('aria-expanded', 'false');
        if (editDraftData) editDraftData['status'] = val;
        markEditDirty();
      });
    });

    document.addEventListener('click', (e) => {
      if (editSubmissionStatusDropdown && !editSubmissionStatusDropdown.contains(e.target)) {
        editSubmissionStatusMenu.classList.remove('open');
        editSubmissionStatusBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  const editProjectStatusBtn = document.getElementById('editProjectStatusBtn');
  const editProjectStatusMenu = document.getElementById('editProjectStatusMenu');
  const editProjectStatusLabel = document.getElementById('editProjectStatusLabel');
  const editProjectStatusDropdown = document.getElementById('editProjectStatusDropdown');

  if (editProjectStatusBtn && editProjectStatusMenu) {
    editProjectStatusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = editProjectStatusMenu.classList.toggle('open');
      editProjectStatusBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    editProjectStatusMenu.querySelectorAll('.edit-delivery-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const val = opt.dataset.value || '';
        editProjectStatusMenu.querySelectorAll('.edit-delivery-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        const labels = {'not-started': dt('dashboard.status.notStarted','Not Started'),'in-progress': dt('dashboard.status.inProgress','In Progress'),'done': dt('dashboard.status.done','Done'),'abandoned': dt('dashboard.status.abandoned','Abandoned')};
        if (editProjectStatusLabel) editProjectStatusLabel.textContent = val && labels[val] ? labels[val] : dt('detail.edit.notSet','— Not set —');
        editProjectStatusMenu.classList.remove('open');
        editProjectStatusBtn.setAttribute('aria-expanded', 'false');
        if (editDraftData) editDraftData['project-status'] = val;
        markEditDirty();
      });
    });

    document.addEventListener('click', (e) => {
      if (editProjectStatusDropdown && !editProjectStatusDropdown.contains(e.target)) {
        editProjectStatusMenu.classList.remove('open');
        editProjectStatusBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  if (editDeliveryBtn && editDeliveryMenu) {
    editDeliveryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = editDeliveryMenu.classList.toggle('open');
      editDeliveryBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    editDeliveryMenu.querySelectorAll('.edit-delivery-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const val = opt.dataset.value || '';
        editDeliveryMenu.querySelectorAll('.edit-delivery-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        if (editDeliveryLabel) editDeliveryLabel.textContent = val || dt('detail.edit.notSet','— Not set —');
        editDeliveryMenu.classList.remove('open');
        editDeliveryBtn.setAttribute('aria-expanded', 'false');
        if (editDraftData) editDraftData['delivery-date'] = val;
        markEditDirty();
      });
    });

    const closeDeliveryOnOutsideClick = (e) => {
      if (editDeliveryDropdown && !editDeliveryDropdown.contains(e.target)) {
        editDeliveryMenu.classList.remove('open');
        editDeliveryBtn.setAttribute('aria-expanded', 'false');
      }
    };
    document.addEventListener('click', closeDeliveryOnOutsideClick);
    // Store for cleanup (will be garbage collected with modal re-render)
    if (editDeliveryDropdown) editDeliveryDropdown._closeHandler = closeDeliveryOnOutsideClick;
  }

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
      if (logoUploadError) logoUploadError.textContent = dt('detail.edit.logoErrorType', 'Unsupported file type. Use PNG, JPG, SVG, or WEBP.');
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      if (logoUploadError) logoUploadError.textContent = dt('detail.edit.logoErrorSize', 'File is too large. Maximum size is 2MB.');
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
    // ── Get admin JWT token ──────────────────────────────────────────────────
    let token = null;
    if (window.netlifyIdentity) {
      const user = netlifyIdentity.currentUser();
      if (!user) {
        alert('Not authenticated. Please log in again.');
        return;
      }
      token = await user.jwt();
    }

    const payload = cloneSubmissionData(editDraftData || {});

    // Upload logo if a new one was staged
    if (pendingLogoFile) {
      const logoRef = await uploadLogoFile(pendingLogoFile, token);
      payload['brand-logo-ref'] = logoRef;
    } else if (removeExistingLogo) {
      payload['brand-logo-ref'] = '';
    }

    // ── Call admin-update (authenticated, dedicated endpoint) ───────────────
    // Previously this incorrectly called /submit with __overrideSubmissionId,
    // which was silently stripped and created duplicate submissions instead.
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch('/.netlify/functions/admin-update', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        submissionId: currentSubmission.id,
        fields: payload,
        historyEntry: { editedBy: 'admin' }
      })
    });

    if (!response.ok) {
      let errorMsg = 'Failed to save changes.';
      try { errorMsg = (await response.json()).error || errorMsg; } catch (_) {}
      throw new Error(errorMsg);
    }

    // Update local state
    const updatedData = { ...((currentSubmission.data) || {}), ...payload };
    const updatedSubmission = { ...currentSubmission, data: updatedData };

    allSubmissions = allSubmissions.map(item =>
      String(item.id) === String(updatedSubmission.id) ? updatedSubmission : item
    );
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

  if (!confirm(dt('dashboard.confirm.deleteSubmission', 'Are you sure you want to delete "{{name}}"? This action cannot be undone.', { name: brandName }))) {
    return;
  }

  try {
    let token = null;

    if (window.netlifyIdentity) {
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
    alert(dt('dashboard.alert.deleteSuccess', 'Submission deleted successfully'));
    loadSubmissions();
  } catch (error) {
    console.error('Error deleting submission:', error);
    alert(dt('dashboard.alert.deleteFailed', 'Failed to delete submission. Please try again.'));
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
    'date-desc': dt('dashboard.sort.newest', 'Newest'), 'date-asc': dt('dashboard.sort.oldest', 'Oldest'),
    'name-asc': dt('dashboard.sort.az', 'A→Z'), 'name-desc': dt('dashboard.sort.za', 'Z→A'),
    'delivery-asc': dt('dashboard.sort.soonest', 'Soonest'), 'delivery-desc': dt('dashboard.sort.latest', 'Latest')
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
  const metaKeys = ['client-name', 'brand-name', 'email', 'client-website'];
  const rows = [];

  // Meta fields first
  metaKeys.forEach(key => {
    if (data[key] != null) {
      const label = { 'client-name': 'Client Name', 'brand-name': 'Brand / Business', email: 'Email', 'client-website': 'Website' }[key] || key;
      rows.push({ label, value: String(data[key] || '') });
    }
  });

  // Questionnaire fields in display order
  const orderedKeys = Object.keys(QUESTIONNAIRE_FIELD_ORDER)
    .sort((a, b) => QUESTIONNAIRE_FIELD_ORDER[a] - QUESTIONNAIRE_FIELD_ORDER[b]);

  orderedKeys.forEach(key => {
    if (data[key] == null) return;
    const num = QUESTIONNAIRE_DISPLAY_NUM[key];
    const labelText = QUESTIONNAIRE_FIELD_LABELS[key] || key;
    const label = num ? `Q${num}: ${labelText}` : labelText;
    const val = Array.isArray(data[key]) ? data[key].join(', ') : String(data[key] || 'No response');
    rows.push({ label, value: val });
  });

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
  if (submissions.length === 0) { alert(dt('dashboard.export.noData', 'No submissions to export.')); return; }

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
  if (submissions.length === 0) { alert(dt('dashboard.export.noData', 'No submissions to export.')); return; }

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
  if (submissions.length === 0) { alert(dt('dashboard.export.noData', 'No submissions to export.')); return; }

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
  if (submissions.length === 0) { alert(dt('dashboard.export.noData', 'No submissions to export.')); return; }

  const columns = [
    'id', 'created_at', 'status',
    'client-name', 'brand-name', 'email', 'client-website',
    'agreed-delivery-date',
    // Questions in display order (matching new numbering Q01–Q19)
    'q1-business-description', 'q2-problem-transformation',
    'q3-ideal-customer', 'q3b-customer-desire',
    'q4-competitors', 'q5-brand-personality',
    'q6-positioning', 'q-launch-context',
    'q8-brands-admired',
    'q9-color', 'q10-colors-to-avoid',
    'q11-aesthetic', 'q11-aesthetic-description',
    'q13-deliverables',
    'q15-inspiration-refs',      // Q14
    'q7-decision-maker',         // Q15
    'q7-decision-maker-other',   // Q15b
    'delivery-date',             // Q16
    'q14-budget',                // Q17
    'q12-existing-assets',       // Q18
    'q16-anything-else'          // Q19
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

const DASH_THEME_COLORS = { dark: '#00373c', light: '#e6fcf8' };

function getDashOsTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function getDashActiveMode() {
  const saved = localStorage.getItem('user-theme');
  return (saved === 'dark' || saved === 'light') ? saved : 'auto';
}

function applyTheme(mode) {
  const effectiveTheme = mode === 'auto' ? getDashOsTheme() : mode;
  const html = document.documentElement;
  html.setAttribute('data-theme', effectiveTheme);
  html.setAttribute('data-theme-mode', mode);

  // Sync meta theme-color
  let metaTheme = document.querySelector('meta[name="theme-color"]');
  if (!metaTheme) {
    metaTheme = document.createElement('meta');
    metaTheme.name = 'theme-color';
    document.head.appendChild(metaTheme);
  }
  metaTheme.content = DASH_THEME_COLORS[effectiveTheme];

  if (mode === 'auto') localStorage.removeItem('user-theme');
  else                  localStorage.setItem('user-theme', mode);

  const label = document.getElementById('themeBtnLabel');
  const themeLabels = { auto: dt('dashboard.theme.auto', 'Auto'), light: dt('dashboard.theme.light', 'Light'), dark: dt('dashboard.theme.dark', 'Dark') };
  if (label) label.textContent = themeLabels[mode] || (mode.charAt(0).toUpperCase() + mode.slice(1));
}

function toggleTheme() {
  const current = getDashActiveMode();
  // Cycle: auto -> light -> dark -> auto
  const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
  applyTheme(next);
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
    const arrayFields = new Set(['q9-color', 'q11-aesthetic', 'q13-deliverables', 'q15-inspiration-refs']);
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
      'Website': 'client-website',
      'Delivery Timeframe': 'delivery-date',
      'Q01: Business Description': 'q1-business-description',
      'Q02: Before and After': 'q2-problem-transformation',
      'Q03: Ideal Client': 'q3-ideal-customer',
      'Q04: Client Trigger': 'q3b-customer-desire',
      'Q05: Competitors': 'q4-competitors',
      'Q06: Brand Personality': 'q5-brand-personality',
      'Q07: Positioning Statement': 'q6-positioning',
      'Q08: Launch Context': 'q-launch-context',
      'Q09: Admired Brands': 'q8-brands-admired',
      'Q10: Color Directions': 'q9-color',
      'Q11: Colors to Avoid': 'q10-colors-to-avoid',
      'Q12: Aesthetic Direction': 'q11-aesthetic',
      'Q12: Aesthetic Notes': 'q11-aesthetic-description',
      'Q13: Deliverables': 'q13-deliverables',
      'Q14: Budget Approach': 'q14-budget',
      'Q15: Inspiration Images': 'q15-inspiration-refs',
      'Q16: Decision Maker': 'q7-decision-maker',
      'Q16: Decision Maker (Other)': 'q7-decision-maker-other',
      'Q17: Existing Assets': 'q12-existing-assets',
      'Q19: Past Experience and Fears': 'q16-anything-else',
      // Legacy keys (backwards compat for old exports)
      'Q1 — Business Description': 'q1-business-description',
      'Q2 — Problem + Transformation': 'q2-problem-transformation',
      'Q3 — Ideal Customer': 'q3-ideal-customer',
      'Q4 — Competitors + Market Gap': 'q4-competitors',
      'Q5 — Brand Personality': 'q5-brand-personality',
      'Q6 — Positioning Statement': 'q6-positioning',
      'Q7 — Decision Maker': 'q7-decision-maker',
      'Q7 — Decision Maker (Other)': 'q7-decision-maker-other',
      'Q8 — Admired Brands': 'q8-brands-admired',
      'Q9 — Color Directions': 'q9-color',
      'Q10 — Colors To Avoid': 'q10-colors-to-avoid',
      'Q11 — Aesthetic Direction': 'q11-aesthetic',
      'Q11 — Additional Aesthetic Notes': 'q11-aesthetic-description',
      'Q12 — Existing Assets': 'q12-existing-assets',
      'Q13 — Needed Deliverables': 'q13-deliverables',
      'Q14 — Budget Approach': 'q14-budget',
      'Q15 — Inspiration Images': 'q15-inspiration-refs',
      'Q16 — Anything Else': 'q16-anything-else',
    };
    return map[heading] || heading.toLowerCase().replace(/\s+/g, '-');
  }

  async function handleImport(file) {
    const isCSV = file.name.endsWith('.csv') || file.type === 'text/csv';
    const isMarkdown = file.name.endsWith('.md') || file.name.endsWith('.markdown');

    if (!isCSV && !isMarkdown) {
      alert(dt('dashboard.alert.importUnsupported', 'Unsupported file type. Please use .md or .csv'));
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
        alert(dt('dashboard.alert.importMissing', 'Import failed: Missing required fields (Brand Name, Client Name, or Email)'));
        return;
      }

      // Convert multi-select fields to arrays
      const multiSelectFields = ['q9-color', 'q11-aesthetic', 'q13-deliverables'];
      multiSelectFields.forEach(field => {
        if (parsedData[field]) {
          parsedData[field] = parsedData[field].split(',').map(v => v.trim()).filter(Boolean);
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

      alert(dt('dashboard.alert.importSuccess', 'Successfully imported: {{name}}', { name: parsedData['brand-name'] }));
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
      if (dateFilterLabel) dateFilterLabel.textContent = opt.textContent; // data-i18n already applied
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
/* ── Language switcher ─────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const dashLangToggle  = document.getElementById('dashLangToggle');
  const dashLangMenu    = document.getElementById('dashLangMenu');
  const dashLangDropdown = document.getElementById('dashLangDropdownWrap');

  function syncDashLangUI(lang) {
    if (dashLangToggle) {
      const codeEl = dashLangToggle.querySelector('.dash-lang-code');
      if (codeEl) codeEl.textContent = lang.toUpperCase();
    }
    if (dashLangMenu) {
      dashLangMenu.querySelectorAll('li[data-lang]').forEach(li => {
        li.setAttribute('aria-selected', li.getAttribute('data-lang') === lang ? 'true' : 'false');
      });
    }
  }

  if (dashLangToggle && dashLangMenu) {
    dashLangToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dashLangToggle.getAttribute('aria-expanded') === 'true';
      dashLangToggle.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      dashLangMenu.classList.toggle('open', !isOpen);
    });

    dashLangMenu.querySelectorAll('li[data-lang]').forEach(li => {
      const handleSelect = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const lang = li.getAttribute('data-lang');
        dashLangMenu.classList.remove('open');
        dashLangToggle.setAttribute('aria-expanded', 'false');
        if (lang && window.i18n) {
          window.i18n.setLanguage(lang);
        }
      };
      li.addEventListener('click', handleSelect);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelect(e); }
      });
    });

    document.addEventListener('click', (e) => {
      if (dashLangDropdown && !dashLangDropdown.contains(e.target)) {
        dashLangMenu.classList.remove('open');
        dashLangToggle.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        dashLangMenu.classList.remove('open');
        dashLangToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Sync the lang badge to the active language on load
  syncDashLangUI(window.i18n?.getLanguage() || 'en');

  // Re-render everything whenever language changes
  window.addEventListener('languageChanged', (e) => {
    const lang = e.detail?.language || window.i18n?.getLanguage() || 'en';
    syncDashLangUI(lang);

    // Re-render dynamic content with new language
    applyCurrentFiltersAndRender();
    if (currentSubmission) renderDetailPanel();

    // Re-apply theme label (it uses dt())
    const themeMode = getDashActiveMode();
    const themeLabel = document.getElementById('themeBtnLabel');
    const themeLabels = {
      auto: dt('dashboard.theme.auto', 'Auto'),
      light: dt('dashboard.theme.light', 'Light'),
      dark: dt('dashboard.theme.dark', 'Dark')
    };
    if (themeLabel) themeLabel.textContent = themeLabels[themeMode] || themeMode;

    // Re-apply translated date filter label for active option
    const activeOpt = document.querySelector('.date-filter-option[aria-selected="true"]');
    const dfLabel = document.getElementById('dateFilterLabel');
    if (activeOpt && dfLabel) dfLabel.textContent = activeOpt.textContent;

    // Re-apply translated sort label for active option
    const activeSortOpt = document.querySelector('.sort-option.active');
    const sortBtnLabelEl = document.querySelector('.sort-btn-label');
    if (!activeSortOpt && sortBtnLabelEl) {
      sortBtnLabelEl.textContent = dt('dashboard.sort.label', 'Sort by');
    }

    updateExportButtonLabel();
    updateSelectionToolbar();
  });
});