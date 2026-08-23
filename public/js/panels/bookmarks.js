import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

function hostnameFromHref(href) {
  try {
    const u = new URL(href);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname;
  } catch {
    return '';
  }
  return '';
}

/** Prefer this registrable domain when fetching a favicon (aliases). */
const FAVICON_HOST_ALIAS = {
  'my.found.com': 'found.com',
  'investor.vanguard.com': 'vanguard.com',
  'go.xero.com': 'xero.com',
  'healthy.kaiserpermanente.org': 'kaiserpermanente.org',
  'www.bayareafastrak.org': 'bayareafastrak.org',
  'app.slack.com': 'slack.com',
  'play.google.com': 'google.com',
  'messages.google.com': 'google.com',
  'mail.google.com': 'google.com',
  'news.google.com': 'google.com',
  'www.google.com': 'google.com',
  'maxetaenergy.sharepoint.com': 'sharepoint.com',
  'rocompliance.maxetaenergy.com': 'maxetaenergy.com',
};

/** Local brand tiles (company logos). */
const HOST_TILE = {
  'keep.google.com': '/assets/tile-google-keep.png',
  'calendar.google.com': '/assets/tile-google-calendar.png',
  'drive.google.com': '/assets/tile-google-drive.svg',
  'docs.google.com': '/assets/tile-google-drive.svg',
  'teams.microsoft.com': '/assets/tile-microsoft-teams.png',
  'outlook.office.com': '/assets/tile-microsoft-outlook.svg',
  'sharepoint.com': '/assets/tile-sharepoint.png',
  'maxetaenergy.com': '/assets/tile-maxeta.png',
  'rocompliance.maxetaenergy.com': '/assets/tile-maxeta.png',
  'found.com': '/assets/tile-found.png',
  'fetlife.com': '/assets/tile-fetlife.png',
  'secretparty.io': '/assets/tile-secretparty.png',
  'www.secretparty.io': '/assets/tile-secretparty.png',
  'web.whatsapp.com': '/assets/tile-whatsapp.svg',
  'whatsapp.com': '/assets/tile-whatsapp.svg',
  'facebook.com': '/assets/tile-facebook.svg',
  'chat.co': '/assets/tile-maxeta.png',
  'energia.pr.gov': '/assets/tile-preb.png',
  'jayhasty.com': '/assets/tile-portfolio.svg',
  'portfolio.jayhasty.com': '/assets/tile-portfolio.svg',
  'calclaim.jayhasty.com': '/assets/tile-calclaim.png',
};

/** Files were once mis-suffixed `.png` but are WebP; fix old bookmark `icon` paths. */
function normalizeTileIconPath(p) {
  const s = String(p).trim();
  if (s === '/assets/tile-google-messages.png') return '/assets/tile-google-messages.webp';
  if (s === '/assets/tile-cursor.png') return '/assets/tile-cursor.webp';
  if (/tile-gemini|tile-perplexity/i.test(s)) return '';
  return s;
}

function explicitBookmarkIcon(row) {
  if (!row.icon || typeof row.icon !== 'string') return null;
  const s = normalizeTileIconPath(row.icon.trim());
  if (!s) return null;
  if (/tile-android-messages/i.test(s)) return '/assets/tile-google-messages.webp';
  return s;
}

function isGoogleMessagesHttpUrl(href) {
  try {
    const u = new URL(String(href).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'messages.google.com' || host === 'www.messages.google.com';
  } catch {
    return false;
  }
}

function faviconHostForHref(href) {
  const raw = hostnameFromHref(href).toLowerCase();
  if (!raw) return '';
  const bare = raw.replace(/^www\./, '');
  return FAVICON_HOST_ALIAS[raw] || FAVICON_HOST_ALIAS[bare] || bare;
}

function googleFaviconUrl(domain) {
  if (!domain) return '';
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

function duckDuckGoIconUrl(domain) {
  if (!domain) return '';
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

function tileForHost(host) {
  if (!host) return '';
  const h = host.toLowerCase().replace(/^www\./, '');
  if (HOST_TILE[h]) return HOST_TILE[h];
  if (HOST_TILE[`www.${h}`]) return HOST_TILE[`www.${h}`];
  return '';
}

function iconSrc(row) {
  const word = String(row?.word || '').trim().toLowerCase();
  if (word === 'rate order' || word === 'rateorder') return '/assets/tile-maxeta.png';
  if (word === 'preb') return '/assets/tile-preb.png';

  const explicit = explicitBookmarkIcon(row);
  if (explicit) return explicit;

  const h = String(row.href || '').trim();
  if (/^cursor:/i.test(h)) return '/assets/tile-cursor.webp';
  if (/^command:/i.test(h)) return '/assets/tile-cursor.webp';
  if (/^signal:/i.test(h)) return '/assets/tile-signal.svg';
  if (/^https?:\/\/drive\.google\.com/i.test(h)) return '/assets/tile-google-drive.svg';
  if (/^https?:\/\/docs\.google\.com\/spreadsheets/i.test(h)) return '/assets/tile-google-drive.svg';
  if (/^https?:\/\/teams\.microsoft\.com/i.test(h)) return '/assets/tile-microsoft-teams.png';
  if (/^https?:\/\/(www\.)?outlook\.office\.com/i.test(h)) return '/assets/tile-microsoft-outlook.svg';
  if (/sharepoint\.com/i.test(h)) return '/assets/tile-sharepoint.png';
  if (/^https?:\/\/rocompliance\.maxetaenergy\.com/i.test(h)) return '/assets/tile-maxeta.png';
  if (/^https?:\/\/(www\.)?calendar\.google\.com/i.test(h)) return '/assets/tile-google-calendar.png';
  if (/^https?:\/\/(www\.)?keep\.google\.com/i.test(h)) return '/assets/tile-google-keep.png';
  if (isGoogleMessagesHttpUrl(h)) return '/assets/tile-google-messages.webp';
  if (/^https?:\/\/(www\.)?fetlife\.com/i.test(h)) return '/assets/tile-fetlife.png';
  if (/^https?:\/\/([a-z0-9-]+\.)?secretparty\.io(\/|$)/i.test(h)) return '/assets/tile-secretparty.png';
  if (/^https?:\/\/(web\.)?whatsapp\.com/i.test(h)) return '/assets/tile-whatsapp.svg';
  if (/^https?:\/\/(www\.)?facebook\.com/i.test(h)) return '/assets/tile-facebook.svg';
  if (/^https?:\/\/my\.found\.com/i.test(h)) return '/assets/tile-found.png';
  if (/^https?:\/\/(www\.)?chat\.co\/?/i.test(h)) return '/assets/tile-maxeta.png';
  if (/^https?:\/\/(www\.)?energia\.pr\.gov(\/|$)/i.test(h)) return '/assets/tile-preb.png';

  const host = faviconHostForHref(h);
  const local = tileForHost(host) || tileForHost(hostnameFromHref(h));
  if (local) return local;
  return googleFaviconUrl(host);
}

function isLocalLaunchHref(href) {
  const h = String(href || '').trim();
  if (/^(cursor|signal|command):/i.test(h)) return true;
  if (/^\/api\/open-desktop\//i.test(h)) return true;
  return false;
}

function fallbackGlyph(word) {
  const span = document.createElement('span');
  span.className = 'bookmark-tile__fallback';
  span.textContent = (word || '?').slice(0, 1).toUpperCase();
  return span;
}

function createTile(row, opts = {}) {
  const { section = '', mode = 'view', selected = false, synthetic = false, onToggle } = opts;
  const a = document.createElement('a');
  a.className = 'bookmark-tile';
  a.href = row.href;
  a.dataset.word = String(row.word || '');
  a.dataset.href = String(row.href || '');
  if (section) a.dataset.section = section;
  if (synthetic) a.dataset.synthetic = '1';
  if (isLocalLaunchHref(row.href)) {
    a.target = '_self';
    a.rel = 'noopener';
  } else {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }

  // Reorder / move by drag (view mode only, real bookmarks only).
  if (mode === 'view' && !synthetic) {
    a.draggable = true;
  }

  if (mode === 'select' && !synthetic) {
    a.classList.add('is-selectable');
    if (selected) a.classList.add('is-selected');
    const check = document.createElement('span');
    check.className = 'bookmark-tile__check';
    check.setAttribute('aria-hidden', 'true');
    a.appendChild(check);
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof onToggle === 'function') onToggle(row, section, a);
    });
  }

  const src = iconSrc(row);
  if (src) {
    const icon = document.createElement('img');
    icon.className = 'bookmark-tile__icon';
    icon.alt = '';
    icon.decoding = 'async';
    icon.loading = 'lazy';
    icon.referrerPolicy = 'no-referrer';
    icon.src = src;
    icon.addEventListener('error', () => {
      if (icon.dataset.fallback === 'ddg') {
        icon.replaceWith(fallbackGlyph(row.word));
        return;
      }
      const host = faviconHostForHref(row.href);
      const ddg = duckDuckGoIconUrl(host);
      if (ddg && icon.src !== ddg) {
        icon.dataset.fallback = 'ddg';
        icon.src = ddg;
        return;
      }
      icon.replaceWith(fallbackGlyph(row.word));
    });
    a.appendChild(icon);
  } else {
    a.appendChild(fallbackGlyph(row.word));
  }

  const word = document.createElement('span');
  word.className = 'bookmark-tile__word';
  word.textContent = String(row.word || 'Link').trim() || 'Link';

  if (row.title && typeof row.title === 'string') {
    a.title = row.title;
  }

  a.appendChild(word);
  return a;
}

const BOOKMARK_CACHE_PREFIX = 'bookmarks:';
const BOOKMARK_CACHE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** Bookmark categories expanded on load (Personal + Admin columns). */
const AUTO_OPEN_SECTION_TITLES = new Set([
  'tools',
  'utilities',
  'clients',
  'community',
  'social',
  'shopping',
]);

function shouldAutoOpenSection(title) {
  return AUTO_OPEN_SECTION_TITLES.has(String(title || '').trim().toLowerCase());
}

/** @param {string} dataPath */
function readBookmarkCache(dataPath) {
  return readPanelCache(BOOKMARK_CACHE_PREFIX + dataPath, BOOKMARK_CACHE_MAX_MS);
}

/** @param {string} dataPath @param {unknown} payload */
function writeBookmarkCache(dataPath, payload) {
  writePanelCache(BOOKMARK_CACHE_PREFIX + dataPath, payload);
}

function showBookmarkSkeleton(root, count = 6) {
  root.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'bookmark-section-grid bookmark-section-grid--skeleton';
  grid.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i += 1) {
    const tile = document.createElement('div');
    tile.className = 'bookmark-tile bookmark-tile--skeleton';
    grid.appendChild(tile);
  }
  root.appendChild(grid);
}

function countBookmarkItems(data) {
  if (!data || !Array.isArray(data.sections)) return 0;
  let n = 0;
  for (const sec of data.sections) {
    if (Array.isArray(sec?.items)) n += sec.items.length;
  }
  return n;
}

/**
 * Guard against applying a server payload that wiped most tiles (e.g. after a
 * deploy deleted the live JSON and Add rewrote a one-item file). Prefer keeping
 * the in-memory / cached view and forcing a reload for the operator to notice.
 */
function isCatastrophicBookmarkShrink(prev, next) {
  const before = countBookmarkItems(prev);
  const after = countBookmarkItems(next);
  return before >= 5 && after < Math.max(2, Math.floor(before / 2));
}

async function apiJson(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let payload = null;
  try {
    payload = await r.json();
  } catch {
    payload = null;
  }
  if (!r.ok || !payload || payload.ok !== true) {
    const msg = payload && payload.error ? payload.error : `Request failed (${r.status})`;
    throw new Error(msg);
  }
  return payload;
}

function normalizeHrefInput(raw) {
  const href = String(raw || '').trim();
  if (!href) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return href;
  return `https://${href}`;
}

/**
 * Modal popup to add a bookmark to any column/category.
 * Resolves `{ scope }` when saved, or `false` when dismissed.
 * @param {Array<{ scope: string, label: string, titles: string[] }>} columns
 */
function openAddBookmarkDialog(columns) {
  return new Promise((resolve) => {
    const cols = Array.isArray(columns) && columns.length ? columns : [];
    const backdrop = document.createElement('div');
    backdrop.className = 'bookmark-modal-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('form');
    dialog.className = 'bookmark-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Add bookmark');

    const title = document.createElement('h3');
    title.className = 'bookmark-modal__title';
    title.textContent = 'Add bookmark';

    const nameField = document.createElement('label');
    nameField.className = 'bookmark-modal__field';
    nameField.innerHTML = '<span>Name</span>';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 40;
    nameInput.required = true;
    nameInput.placeholder = 'e.g. Figma';
    nameField.appendChild(nameInput);

    const urlField = document.createElement('label');
    urlField.className = 'bookmark-modal__field';
    urlField.innerHTML = '<span>URL</span>';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.required = true;
    urlInput.placeholder = 'https://…';
    urlField.appendChild(urlInput);

    // Column (Personal / Admin)
    const colField = document.createElement('label');
    colField.className = 'bookmark-modal__field';
    colField.innerHTML = '<span>Column</span>';
    const colSelect = document.createElement('select');
    for (const c of cols) {
      const opt = document.createElement('option');
      opt.value = c.scope;
      opt.textContent = c.label;
      colSelect.appendChild(opt);
    }
    colField.appendChild(colSelect);
    colField.hidden = cols.length <= 1;

    const catField = document.createElement('label');
    catField.className = 'bookmark-modal__field';
    catField.innerHTML = '<span>Category</span>';
    const catSelect = document.createElement('select');
    catField.appendChild(catSelect);

    const newCatInput = document.createElement('input');
    newCatInput.type = 'text';
    newCatInput.maxLength = 32;
    newCatInput.placeholder = 'New category name';
    newCatInput.className = 'bookmark-modal__newcat';
    catField.appendChild(newCatInput);

    function currentTitles() {
      const col = cols.find((c) => c.scope === colSelect.value);
      return col ? col.titles : [];
    }
    function populateCategories() {
      catSelect.replaceChildren();
      const titles = currentTitles();
      for (const t of titles) {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        catSelect.appendChild(opt);
      }
      const newOpt = document.createElement('option');
      newOpt.value = '__new__';
      newOpt.textContent = '+ New category…';
      catSelect.appendChild(newOpt);
      if (titles.length === 0) catSelect.value = '__new__';
      newCatInput.hidden = catSelect.value !== '__new__';
    }
    populateCategories();

    colSelect.addEventListener('change', populateCategories);
    catSelect.addEventListener('change', () => {
      const isNew = catSelect.value === '__new__';
      newCatInput.hidden = !isNew;
      if (isNew) newCatInput.focus();
    });

    const error = document.createElement('p');
    error.className = 'bookmark-modal__error';
    error.setAttribute('role', 'alert');

    const actions = document.createElement('div');
    actions.className = 'bookmark-modal__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'bookmark-modal__btn bookmark-modal__btn--ghost';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'bookmark-modal__btn bookmark-modal__btn--primary';
    save.textContent = 'Add';
    actions.append(cancel, save);

    dialog.append(title, nameField, urlField, colField, catField, error, actions);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    nameInput.focus();

    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') finish(false);
    }
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(false);
    });
    cancel.addEventListener('click', () => finish(false));

    dialog.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      error.textContent = '';
      const scope = colSelect.value || (cols[0] && cols[0].scope);
      const word = nameInput.value.trim();
      const href = normalizeHrefInput(urlInput.value);
      const section =
        catSelect.value === '__new__' ? newCatInput.value.trim() : catSelect.value;
      if (!scope) {
        error.textContent = 'No column available';
        return;
      }
      if (!word) {
        error.textContent = 'Name is required';
        return;
      }
      if (!href) {
        error.textContent = 'A valid URL is required';
        return;
      }
      if (!section) {
        error.textContent = 'Pick or name a category';
        return;
      }
      save.disabled = true;
      try {
        const res = await apiJson('POST', `/api/bookmarks/${encodeURIComponent(scope)}/items`, {
          section,
          word,
          href,
        });
        finish({ scope, data: res.data });
      } catch (e) {
        error.textContent = String(e?.message || e);
        save.disabled = false;
      }
    });
  });
}

const SCOPE_LABEL = { personal: 'Personal', work: 'Admin' };

/**
 * Shared controller for a single Add + Delete toolbar that operates on every
 * registered bookmark column (Personal + Admin).
 */
export function createBookmarksCoordinator() {
  const grids = [];
  let mode = 'view';
  let toolbarEl = null;

  const totalSelected = () => grids.reduce((n, g) => n + g.selectedSize(), 0);

  function makeBtn(label, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    return b;
  }

  function renderToolbar() {
    if (!toolbarEl) return;
    toolbarEl.replaceChildren();
    if (mode === 'view') {
      const add = makeBtn('+ Add bookmark', 'bookmark-toolbar__btn bookmark-toolbar__btn--primary');
      add.addEventListener('click', onAdd);
      const del = makeBtn('Delete…', 'bookmark-toolbar__btn');
      del.addEventListener('click', () => setMode('select'));
      toolbarEl.append(add, del);
    } else {
      const n = totalSelected();
      const del = makeBtn(
        n ? `Delete (${n})` : 'Delete',
        'bookmark-toolbar__btn bookmark-toolbar__btn--danger',
      );
      del.disabled = n === 0;
      del.addEventListener('click', onDelete);
      const cancel = makeBtn('Cancel', 'bookmark-toolbar__btn');
      cancel.addEventListener('click', () => setMode('view'));
      const hint = document.createElement('span');
      hint.className = 'bookmark-toolbar__hint';
      hint.textContent = 'Tap bookmarks to select';
      toolbarEl.append(hint, del, cancel);
    }
  }

  function setMode(next) {
    mode = next;
    grids.forEach((g) => g.clearSelected());
    grids.forEach((g) => g.rerender());
    renderToolbar();
  }

  async function onAdd() {
    const columns = grids.map((g) => ({
      scope: g.scope,
      label: SCOPE_LABEL[g.scope] || g.scope,
      titles: g.getTitles(),
    }));
    const saved = await openAddBookmarkDialog(columns);
    if (saved && saved.scope) {
      const g = grids.find((x) => x.scope === saved.scope);
      if (!g) return;
      // Prefer API payload so we never re-fetch static JSON after a successful write
      // (avoids SPA/HTML or stale responses looking like "Invalid JSON").
      if (saved.data) {
        if (isCatastrophicBookmarkShrink(g.getData(), saved.data)) {
          window.alert(
            'Bookmark was saved, but the server returned far fewer tiles than before — not applying that wipe. Hard-refresh Admin bookmarks; if they are still wrong, restore from backup.',
          );
          await g.reload(true);
        } else {
          g.applyData(saved.data);
        }
      } else await g.reload(true);
    }
  }

  async function onDelete() {
    const n = totalSelected();
    if (!n) return;
    if (!window.confirm(`Delete ${n} bookmark(s)?`)) return;
    for (const g of grids) {
      const items = g.collectSelected();
      if (items.length === 0) continue;
      try {
        const res = await apiJson('POST', `/api/bookmarks/${encodeURIComponent(g.scope)}/bulk-delete`, {
          items,
        });
        if (res?.data) g.applyData(res.data);
        else await g.reload(true);
      } catch (e) {
        window.alert(`Could not delete from ${SCOPE_LABEL[g.scope] || g.scope}: ${String(e?.message || e)}`);
        await g.reload(true);
      }
    }
    mode = 'view';
    grids.forEach((g) => g.clearSelected());
    renderToolbar();
  }

  return {
    register(controller) {
      grids.push(controller);
    },
    getMode() {
      return mode;
    },
    onSelectionChanged() {
      renderToolbar();
    },
    mountToolbar(el) {
      toolbarEl = el;
      renderToolbar();
    },
  };
}

/** Serialize the current DOM order into a layout payload (skips synthetic tiles). */
function serializeLayout(root) {
  const sections = [];
  for (const details of root.querySelectorAll('.bookmark-section')) {
    const label = details.querySelector('.bookmark-section-summary__label');
    const title = label ? label.textContent.trim() : '';
    if (!title) continue;
    const items = [];
    for (const tile of details.querySelectorAll('.bookmark-tile')) {
      if (tile.dataset.synthetic === '1') continue;
      if (!tile.dataset.href) continue;
      items.push({ word: tile.dataset.word || '', href: tile.dataset.href });
    }
    sections.push({ title, items });
  }
  return { sections };
}

function withChatCoFallback(title, items) {
  if (!/client/i.test(title)) return items;
  const hasChatCo = items.some((row) =>
    /https?:\/\/(www\.)?chat\.co\/?/i.test(String(row.href || '')),
  );
  if (hasChatCo) return items;
  return items.concat([
    {
      word: 'chat.co',
      href: 'https://www.chat.co/',
      title: 'chat.co',
      icon: '/assets/tile-chatco.ico',
      __synthetic: true,
    },
  ]);
}

/** Map a bookmark JSON path to its editable scope (personal/work). */
function scopeFromPath(dataPath) {
  const p = String(dataPath || '').toLowerCase();
  if (p.includes('bookmarks-personal')) return 'personal';
  if (p.includes('bookmarks-work')) return 'work';
  return '';
}

export async function mountBookmarkGrid(root, dataPath, emptyHint, coordinator = null) {
  if (!root) return;
  root.dataset.bookmarkPath = dataPath;

  const scope = scopeFromPath(dataPath);
  const editable = Boolean(scope) && Boolean(coordinator);
  const getMode = () => (coordinator ? coordinator.getMode() : 'view');

  /** @type {any} */
  let currentData = null;
  const selected = new Map(); // key -> { section, word, href }

  const keyOf = (section, row) =>
    `${String(section).toLowerCase()}||${String(row.word).toLowerCase()}||${String(row.href)}`;

  function captureOpenTitles() {
    const open = new Set();
    for (const d of root.querySelectorAll('.bookmark-section[open]')) {
      const label = d.querySelector('.bookmark-section-summary__label');
      if (label) open.add(label.textContent.trim().toLowerCase());
    }
    return open;
  }

  function render() {
    const mode = getMode();
    const openTitles = captureOpenTitles();
    root.replaceChildren();

    if (!currentData || !Array.isArray(currentData.sections)) {
      // Legacy flat array support (view only).
      if (Array.isArray(currentData) && currentData.length > 0) {
        const grid = document.createElement('div');
        grid.className = 'bookmark-section-grid';
        for (const row of currentData) {
          if (!row?.href || row.word == null) continue;
          grid.appendChild(createTile(row));
        }
        root.appendChild(grid);
        return;
      }
      root.innerHTML = `<p class="muted">${emptyHint}</p>`;
      return;
    }

    let any = false;
    for (const sec of currentData.sections) {
      if (!sec || typeof sec.title !== 'string' || !Array.isArray(sec.items)) continue;
      let items = sec.items.filter((row) => row && typeof row.href === 'string' && row.word != null);
      items = withChatCoFallback(sec.title, items);
      if (items.length === 0) continue;
      any = true;

      const details = document.createElement('details');
      details.className = 'bookmark-section';
      const titleKey = sec.title.trim().toLowerCase();
      details.open = openTitles.size
        ? openTitles.has(titleKey)
        : shouldAutoOpenSection(sec.title);

      const summary = document.createElement('summary');
      summary.className = 'bookmark-section-summary';
      const summaryLabel = document.createElement('span');
      summaryLabel.className = 'bookmark-section-summary__label';
      summaryLabel.textContent = sec.title;
      summary.appendChild(summaryLabel);

      const grid = document.createElement('div');
      grid.className = 'bookmark-section-grid';
      for (const row of items) {
        const synthetic = Boolean(row.__synthetic);
        const tile = createTile(row, {
          section: sec.title,
          mode: editable ? mode : 'view',
          synthetic,
          selected: selected.has(keyOf(sec.title, row)),
          onToggle: (r, section, tileEl) => {
            const key = keyOf(section, r);
            if (selected.has(key)) {
              selected.delete(key);
              tileEl.classList.remove('is-selected');
            } else {
              selected.set(key, { section, word: r.word, href: r.href });
              tileEl.classList.add('is-selected');
            }
            coordinator?.onSelectionChanged();
          },
        });
        grid.appendChild(tile);
      }
      details.append(summary, grid);
      root.appendChild(details);
    }

    if (!any) {
      root.innerHTML = `<p class="muted">${emptyHint}</p>`;
    }
  }

  // Drag-to-reorder / move between categories (view mode only). Bound once.
  if (editable && !root.dataset.dndBound) {
    root.dataset.dndBound = '1';
    let dragEl = null;
    let dragStartLayout = '';

    root.addEventListener('dragstart', (e) => {
      if (getMode() !== 'view') return;
      const tile = e.target.closest?.('.bookmark-tile[draggable="true"]');
      if (!tile || !root.contains(tile)) return;
      dragEl = tile;
      dragStartLayout = JSON.stringify(serializeLayout(root));
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', tile.dataset.href || '');
      } catch {
        /* some browsers require setData; ignore failures */
      }
      setTimeout(() => tile.classList.add('is-dragging'), 0);
    });

    root.addEventListener('dragover', (e) => {
      if (!dragEl) return;
      const grid = e.target.closest?.('.bookmark-section-grid');
      if (!grid || grid.classList.contains('bookmark-section-grid--skeleton')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const over = e.target.closest?.('.bookmark-tile');
      if (over && over !== dragEl && !over.dataset.synthetic) {
        const rect = over.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        grid.insertBefore(dragEl, before ? over : over.nextSibling);
      } else if (!over) {
        grid.appendChild(dragEl);
      }
    });

    root.addEventListener('drop', (e) => {
      if (dragEl) e.preventDefault();
    });

    root.addEventListener('dragend', async () => {
      if (!dragEl) return;
      dragEl.classList.remove('is-dragging');
      dragEl = null;
      const now = JSON.stringify(serializeLayout(root));
      if (now === dragStartLayout) return;
      try {
        const res = await apiJson('PUT', `/api/bookmarks/${encodeURIComponent(scope)}/layout`,
          serializeLayout(root));
        currentData = res.data;
        writeBookmarkCache(dataPath, currentData);
        render();
      } catch (e) {
        window.alert(`Could not save order: ${String(e?.message || e)}`);
        await loadAndMount(true);
      }
    });
  }

  async function loadAndMount(force) {
    try {
      const url = force ? `${dataPath}?_=${Date.now()}` : dataPath;
      const r = await fetch(url, { cache: force ? 'no-store' : 'default' });
      if (!r.ok) {
        if (!currentData && !root.querySelector('.bookmark-section, .bookmark-section-grid')) {
          root.innerHTML = `<p class="muted">${emptyHint}</p>`;
        }
        return;
      }
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('json')) {
        // SPA/HTML fallback used to land here as "Invalid JSON" — keep tiles if we have them.
        if (!currentData) {
          root.innerHTML = '<p class="muted">Bookmark file unavailable.</p>';
        }
        return;
      }
      let data;
      try {
        data = await r.json();
      } catch {
        if (!currentData) {
          root.innerHTML = '<p class="muted">Invalid JSON in bookmark file.</p>';
        }
        return;
      }
      applyData(data);
    } catch {
      if (!currentData && !root.querySelector('.bookmark-section, .bookmark-section-grid')) {
        root.innerHTML = `<p class="muted">${emptyHint}</p>`;
      }
    }
  }

  function applyData(data) {
    currentData = data;
    writeBookmarkCache(dataPath, data);
    render();
  }

  if (editable && coordinator) {
    coordinator.register({
      scope,
      getTitles: () =>
        (currentData?.sections || [])
          .map((s) => (typeof s.title === 'string' ? s.title.trim() : ''))
          .filter(Boolean),
      getData: () => currentData,
      reload: (force) => loadAndMount(force),
      applyData,
      rerender: () => render(),
      selectedSize: () => selected.size,
      clearSelected: () => selected.clear(),
      collectSelected: () => Array.from(selected.values()),
    });
  }

  const cached = readBookmarkCache(dataPath);
  if (cached) {
    currentData = cached;
    render();
  } else {
    showBookmarkSkeleton(root);
  }

  await loadAndMount(false);
}
