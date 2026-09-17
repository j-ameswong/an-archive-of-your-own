const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const retryEl = document.getElementById('retry');
const loadMoreEl = document.getElementById('loadMore');
const searchEl = document.getElementById('search');
const filterPanel = document.getElementById('filterPanel');
const filterToggle = document.getElementById('filterToggle');
const favToggle = document.getElementById('favToggle');
const sortSelect = document.getElementById('sortSelect');
const statusChips = [...document.querySelectorAll('.chip[data-status]')];
const detailEl = document.getElementById('detail');
const detailBody = document.getElementById('detailBody');
const detailClose = document.getElementById('detailClose');
const srStatus = document.getElementById('srStatus');
const importToggle = document.getElementById('importToggle');
const importPanel = document.getElementById('importPanel');
const importUrl = document.getElementById('importUrl');
const importSubmit = document.getElementById('importSubmit');
const importStatus = document.getElementById('importStatus');

const PAGE_SIZE = 30;

// Everything reads best newest/highest first, except alphabetical titles.
const SORT_DIR = { title: 'asc' };

const state = {
  status: new Set(),
  favourite: false,
  sort: 'updated_at',
  q: '',
  offset: 0,
  total: 0,
};

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function buildQuery() {
  const params = new URLSearchParams();
  if (state.status.size) params.set('status', [...state.status].join(','));
  if (state.favourite) params.set('favourite', '1');
  if (state.q) params.set('q', state.q);
  params.set('sort', state.sort);
  params.set('dir', SORT_DIR[state.sort] || 'desc');
  params.set('limit', PAGE_SIZE);
  params.set('offset', state.offset);
  return params.toString();
}

// Filters live in the query string so a filtered view can be linked or reloaded.
// replaceState, not pushState: filter tweaks shouldn't each cost a Back press.
function syncUrl() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.status.size) params.set('status', [...state.status].join(','));
  if (state.favourite) params.set('fav', '1');
  if (state.sort !== 'updated_at') params.set('sort', state.sort);
  const qs = params.toString();
  history.replaceState(history.state, '', qs ? `?${qs}` : location.pathname);
}

function restoreFromUrl() {
  const p = new URLSearchParams(location.search);

  state.q = p.get('q') || '';
  searchEl.value = state.q;

  for (const s of (p.get('status') || '').split(',').filter(Boolean)) {
    state.status.add(s);
  }
  statusChips.forEach((chip) => setChipState(chip, state.status.has(chip.dataset.status)));

  state.favourite = p.get('fav') === '1';
  setChipState(favToggle, state.favourite);

  const sort = p.get('sort');
  if (sort && [...sortSelect.options].some((o) => o.value === sort)) {
    state.sort = sort;
    sortSelect.value = sort;
  }

  const anyFilter = state.q || state.status.size || state.favourite;
  if (anyFilter) {
    filterPanel.hidden = false;
    filterToggle.setAttribute('aria-expanded', 'true');
  }
}

const STATUS_LABELS = {
  to_read: 'To read',
  unfinished: 'Unfinished',
  caught_up: 'Caught up',
  read: 'Read',
  dropped: 'Dropped',
};

function statusLabel(s) {
  return STATUS_LABELS[s] || s;
}

function fmtWords(n) {
  if (n == null) return '?';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function chapterProgress(fic, unit) {
  const done = fic.chapters_done ?? '?';
  return `${done}/${fic.chapters_total ?? '?'} ${unit}`;
}

// A <button> may only contain phrasing content, so these are spans, not divs.
function cardHtml(fic) {
  const fandoms = fic.fandoms?.length ? fic.fandoms.join(', ') : '';
  return `
    <button class="card" data-id="${escapeHtml(fic.id)}">
      <span class="card-top">
        <span class="card-title">${escapeHtml(fic.title || 'Untitled')}</span>
        ${fic.favourite ? '<span class="card-fav">★</span>' : ''}
      </span>
      <span class="card-author">${escapeHtml(fic.author || 'Unknown')}</span>
      ${fandoms ? `<span class="card-fandoms">${escapeHtml(fandoms)}</span>` : ''}
      <span class="card-meta">
        <span class="badge status-${escapeHtml(fic.status)}">${escapeHtml(statusLabel(fic.status))}</span>
        <span class="badge">${fmtWords(fic.word_count)} words</span>
        <span class="badge">${escapeHtml(chapterProgress(fic, 'ch'))}</span>
      </span>
    </button>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Scraped URLs land in an href, so only let http(s) through.
function safeUrl(u) {
  try {
    const parsed = new URL(u, location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

// Bumped on every request so slow responses that lost the race are discarded.
let listSeq = 0;

function setListLoading(on) {
  loadingEl.hidden = !on;
  loadMoreEl.disabled = on;
  if (on) {
    errorEl.hidden = true;
    emptyEl.hidden = true;
  }
}

async function fetchList({ reset }) {
  const seq = ++listSeq;

  if (reset) {
    state.offset = 0;
    listEl.innerHTML = '';
    loadMoreEl.hidden = true;
    // The list is replaced wholesale, so a deep scroll position is meaningless.
    window.scrollTo({ top: 0 });
  }
  setListLoading(true);

  let data;
  try {
    const res = await fetch(`/api/fics?${buildQuery()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    if (seq !== listSeq) return;
    setListLoading(false);
    errorEl.hidden = false;
    srStatus.textContent = 'Could not load fics.';
    return;
  }

  if (seq !== listSeq) return;
  setListLoading(false);

  state.total = data.total;
  listEl.insertAdjacentHTML('beforeend', data.items.map(cardHtml).join(''));

  // Track what is actually rendered rather than counting clicks, so a failed
  // or superseded page can't leave a gap in the list.
  state.offset += data.items.length;
  loadMoreEl.hidden = state.offset >= state.total;
  emptyEl.hidden = state.total > 0;

  srStatus.textContent = state.total === 0
    ? 'No fics match these filters.'
    : `Showing ${state.offset} of ${state.total} fics.`;
}

function reload() {
  syncUrl();
  fetchList({ reset: true });
}

loadMoreEl.addEventListener('click', () => fetchList({ reset: false }));

retryEl.addEventListener('click', () => fetchList({ reset: false }));

listEl.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) openDetail(card.dataset.id, card);
});

searchEl.addEventListener('input', debounce((e) => {
  state.q = e.target.value.trim();
  reload();
}, 300));

filterToggle.addEventListener('click', () => {
  const open = !filterPanel.hidden;
  filterPanel.hidden = open;
  filterToggle.setAttribute('aria-expanded', String(!open));
});

importToggle.addEventListener('click', () => {
  const open = !importPanel.hidden;
  importPanel.hidden = open;
  importToggle.setAttribute('aria-expanded', String(!open));
  if (!open) importUrl.focus();
});

function setImportStatus(text, isError = false) {
  importStatus.textContent = text;
  importStatus.classList.toggle('is-error', isError);
  importStatus.hidden = !text;
}

function setImportBusy(on) {
  importUrl.disabled = on;
  importSubmit.disabled = on;
}

importPanel.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = importUrl.value.trim();
  if (!url) return;

  // A cold fetch from AO3 takes seconds, and imports run one at a time
  // server-side, so lock the form rather than letting them queue up.
  setImportBusy(true);
  setImportStatus('Fetching from AO3…');

  let res;
  let data;
  try {
    res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    data = await res.json();
  } catch {
    setImportBusy(false);
    setImportStatus('Could not reach the server.', true);
    return;
  }

  setImportBusy(false);

  if (!res.ok) {
    setImportStatus(data?.message || `Import failed (HTTP ${res.status}).`, true);
    return;
  }

  importUrl.value = '';
  const title = data.fic?.title || 'Untitled';
  setImportStatus(data.created ? `Added “${title}”.` : `Refreshed “${title}”.`);

  // The new fic may not pass the current filters, so refresh the counts and
  // the list, then show it regardless.
  await Promise.all([loadMeta(), fetchList({ reset: true })]);
  openDetail(data.fic.id, importSubmit);
});

function setChipState(chip, on) {
  chip.classList.toggle('active', on);
  chip.setAttribute('aria-pressed', String(on));
}

statusChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    const s = chip.dataset.status;
    const on = !state.status.has(s);
    if (on) state.status.add(s);
    else state.status.delete(s);
    setChipState(chip, on);
    reload();
  });
});

favToggle.addEventListener('click', () => {
  state.favourite = !state.favourite;
  setChipState(favToggle, state.favourite);
  reload();
});

sortSelect.addEventListener('change', (e) => {
  state.sort = e.target.value;
  reload();
});

const TAG_LABELS = {
  relationship: 'Relationships',
  character: 'Characters',
  freeform: 'Additional tags',
  category: 'Category',
  warning: 'Warnings',
  genre: 'Genre',
  fandom: 'Fandom',
};

let detailSeq = 0;
let lastFocused = null;

// trigger is whatever the reader acted on -- a card, or the import button --
// and gets focus back when the dialog closes.
async function openDetail(id, trigger) {
  const seq = ++detailSeq;
  trigger?.classList.add('is-loading');

  let fic;
  try {
    const res = await fetch(`/api/fics/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fic = await res.json();
  } catch (err) {
    if (seq !== detailSeq) return;
    trigger?.classList.remove('is-loading');
    showDetail('<p class="detail-error">Couldn’t load this fic.</p>', trigger);
    return;
  }

  if (seq !== detailSeq) return;
  trigger?.classList.remove('is-loading');

  const tagGroups = Object.entries(fic.tags)
    .filter(([, tags]) => tags.length)
    .map(([type, tags]) => `
      <div class="tag-group">
        <div class="tag-group-label">${escapeHtml(TAG_LABELS[type] || type)}</div>
        <div class="tag-list">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      </div>
    `).join('');

  const progress = chapterProgress(fic, 'chapters');
  const href = safeUrl(fic.resume_url || fic.url);

  showDetail(`
    <h2 class="detail-title">${escapeHtml(fic.title || 'Untitled')} ${fic.favourite ? '★' : ''}</h2>
    <p class="detail-author">${escapeHtml(fic.author || 'Unknown')}</p>
    <div class="card-meta" style="margin-bottom:1rem">
      <span class="badge status-${escapeHtml(fic.status)}" data-status-badge>${escapeHtml(statusLabel(fic.status))}</span>
      <span class="badge">${fmtWords(fic.word_count)} words</span>
      <span class="badge">${escapeHtml(progress)}</span>
      <span class="badge">${escapeHtml(fic.kudos ?? 0)} kudos</span>
      <span class="badge">${escapeHtml(fic.bookmarks ?? 0)} bookmarks</span>
    </div>
    <label class="detail-status">
      Reading status
      <select data-status-for="${escapeHtml(fic.id)}" data-current="${escapeHtml(fic.status)}">
        ${Object.entries(STATUS_LABELS).map(([value, label]) => `
          <option value="${escapeHtml(value)}"${value === fic.status ? ' selected' : ''}>${escapeHtml(label)}</option>
        `).join('')}
      </select>
    </label>
    ${fic.summary ? `<p class="detail-summary">${escapeHtml(fic.summary)}</p>` : ''}
    ${fic.note ? `<div class="detail-note">${escapeHtml(fic.note)}</div>` : ''}
    ${tagGroups}
    ${href ? `<a class="detail-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">
      ${fic.resume_url ? 'Continue Reading' : 'Open on AO3 →'}
    </a>` : ''}
  `, trigger);
}

// Delegated rather than bound per render: showDetail replaces the panel's
// markup wholesale, so there is nothing stable to bind to.
detailBody.addEventListener('change', async (e) => {
  const select = e.target.closest('select[data-status-for]');
  if (!select) return;

  const label = select.closest('.detail-status');
  const previous = select.dataset.current ?? '';
  label.querySelector('.detail-status-error')?.remove();
  label.setAttribute('aria-busy', 'true');
  select.disabled = true;

  try {
    const res = await fetch(`/api/fics/${select.dataset.statusFor}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: select.value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fic = await res.json();

    select.dataset.current = fic.status;
    const badge = detailBody.querySelector('[data-status-badge]');
    if (badge) {
      badge.className = `badge status-${fic.status}`;
      badge.textContent = statusLabel(fic.status);
    }
    // The list and the counts both key off status, so both are now stale.
    await Promise.all([loadMeta(), fetchList({ reset: true })]);
  } catch {
    // Put the control back where it was: the row did not change.
    if (previous) select.value = previous;
    label.insertAdjacentHTML('beforeend',
      '<span class="detail-status-error">Couldn\u2019t save that.</span>');
  } finally {
    label.removeAttribute('aria-busy');
    select.disabled = false;
  }
});

// The open modal owns a history entry, so Back dismisses it instead of
// leaving the app. Only popstate tears it down, keeping both paths identical.
let modalInHistory = false;

function showDetail(html, trigger) {
  lastFocused = trigger;
  detailBody.innerHTML = html;
  detailEl.hidden = false;
  document.body.classList.add('no-scroll');
  detailClose.focus();
  if (!modalInHistory) {
    history.pushState({ modal: true }, '');
    modalInHistory = true;
  }
}

function closeDetail() {
  if (detailEl.hidden) return;
  if (modalInHistory) {
    history.back(); // popstate runs dismissDetail
    return;
  }
  dismissDetail();
}

function dismissDetail() {
  detailSeq++; // discard any open still in flight
  detailEl.hidden = true;
  detailBody.innerHTML = '';
  document.body.classList.remove('no-scroll');
  if (lastFocused?.isConnected) lastFocused.focus();
  lastFocused = null;
}

window.addEventListener('popstate', () => {
  modalInHistory = false;
  if (!detailEl.hidden) dismissDetail();
});

// Keep Tab inside the dialog while it is open.
function trapTab(e) {
  const focusables = detailEl.querySelectorAll('button, a[href]');
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

detailClose.addEventListener('click', closeDetail);
detailEl.addEventListener('click', (e) => {
  if (e.target === detailEl) closeDetail();
});

document.addEventListener('keydown', (e) => {
  if (detailEl.hidden) return;
  if (e.key === 'Escape') closeDetail();
  else if (e.key === 'Tab') trapTab(e);
});

async function loadMeta() {
  let meta;
  try {
    const res = await fetch('/api/meta');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    meta = await res.json();
  } catch (err) {
    return; // Status chips stay uncounted; the list still works.
  }

  // Show how many fics each status holds, and disable the ones that are empty.
  const counts = Object.fromEntries(meta.status_counts.map((r) => [r.status, r.c]));
  for (const chip of statusChips) {
    const n = counts[chip.dataset.status] ?? 0;
    // Reused after an import, so update the count in place rather than
    // appending a second one.
    let countEl = chip.querySelector('.chip-count');
    if (!countEl) {
      chip.insertAdjacentHTML('beforeend', ' <span class="chip-count"></span>');
      countEl = chip.querySelector('.chip-count');
    }
    countEl.textContent = n;

    const empty = n === 0 && !state.status.has(chip.dataset.status);
    chip.disabled = empty;
    chip.title = empty ? 'No fics with this status' : '';
  }
}

restoreFromUrl();
loadMeta();
fetchList({ reset: true });
