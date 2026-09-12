import { fillLinkifiedText } from '../lib/linkify-text.js';

/**
 * Google Keep-style scratch notes — pinned cards, scrollable grid, image + voice attachments.
 * @param {HTMLElement | null} root
 */
export function mountKeepNotes(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('keep-notes');

  const shell = document.createElement('div');
  shell.className = 'keep-notes__shell';

  const compose = document.createElement('div');
  compose.className = 'keep-notes__compose';

  const composeTitle = document.createElement('input');
  composeTitle.type = 'text';
  composeTitle.className = 'keep-notes__compose-title';
  composeTitle.placeholder = 'Title';
  composeTitle.maxLength = 200;
  composeTitle.autocomplete = 'off';

  const composeBody = document.createElement('textarea');
  composeBody.className = 'keep-notes__compose-body';
  composeBody.placeholder = 'Take a note…';
  composeBody.rows = 1;
  composeBody.maxLength = 20000;

  const composeCatRow = document.createElement('div');
  composeCatRow.className = 'keep-notes__cat-row';

  const composeCatSelect = document.createElement('select');
  composeCatSelect.className = 'keep-notes__cat-select';
  composeCatSelect.setAttribute('aria-label', 'Add to collection');
  composeCatSelect.title = 'Add to collection';

  const composeNewCat = document.createElement('input');
  composeNewCat.type = 'text';
  composeNewCat.className = 'keep-notes__cat-new';
  composeNewCat.placeholder = 'New collection name';
  composeNewCat.maxLength = 48;
  composeNewCat.autocomplete = 'off';
  composeNewCat.hidden = true;

  composeCatRow.append(composeCatSelect, composeNewCat);

  const PIN_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H8c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1.03-1 1.03 1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';
  const IMAGE_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>';
  const VOICE_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';
  const MORE_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';
  const SEND_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  const CHECKLIST_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
  const BULLETS_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5" cy="6" r="1.6" fill="currentColor"/><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="5" cy="18" r="1.6" fill="currentColor"/><path fill="currentColor" d="M10 5h10v2H10zm0 6h10v2H10zm0 6h10v2H10z"/></svg>';
  const ARCHIVE_ICON_14 =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M20.54 5.23 19.15 3.55C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5 6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>';
  const ARCHIVE_ICON_18 =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M20.54 5.23 19.15 3.55C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5 6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>';
  const TRASH_ICON_14 =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
  const TRASH_ICON_18 =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
  const RESTORE_ICON_16 =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M20.54 5.23 19.15 3.55C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 9.5l5.5 5.5H14v2h-4v-2H6.5L12 9.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>';

  /** Keep Takeout / import format for checklist lines in note body. */
  const CHECK_OPEN = '\u2610';
  const CHECK_DONE = '\u2611';
  const CHECK_LINE_RE = /^([\u2610\u2611])(?:[ \t]+(.*))?$/;
  const BULLET_MARK = '\u2022';
  const BULLET_PREFIX = `${BULLET_MARK} `;
  const BULLET_LINE_RE = /^[\u2022]\s+(.*)$/;

  /**
   * @param {string} line
   * @returns {{ checked: boolean, text: string } | null}
   */
  function parseCheckLine(line) {
    const m = String(line || '').match(CHECK_LINE_RE);
    if (!m) return null;
    return { checked: m[1] === CHECK_DONE, text: m[2] != null ? m[2] : '' };
  }

  /**
   * @param {string} line
   * @returns {{ text: string } | null}
   */
  function parseBulletLine(line) {
    const m = String(line || '').match(BULLET_LINE_RE);
    if (!m) return null;
    return { text: m[1] != null ? m[1] : '' };
  }

  /**
   * @param {string} body
   */
  function bodyHasChecklist(body) {
    return String(body || '')
      .split('\n')
      .some((line) => parseCheckLine(line));
  }

  /**
   * @param {string} body
   */
  function bodyHasBullets(body) {
    return String(body || '')
      .split('\n')
      .some((line) => parseBulletLine(line));
  }

  /**
   * @param {string} body
   */
  function bodyHasList(body) {
    return bodyHasChecklist(body) || bodyHasBullets(body);
  }

  /**
   * @param {boolean} checked
   * @param {string} text
   */
  function formatCheckLine(checked, text) {
    const mark = checked ? CHECK_DONE : CHECK_OPEN;
    const t = String(text || '');
    return t ? `${mark} ${t}` : mark;
  }

  /**
   * Insert or convert the current textarea line into a checklist item.
   * @param {HTMLTextAreaElement} textarea
   */
  function insertChecklistLine(textarea) {
    const value = textarea.value;
    const start = textarea.selectionStart ?? value.length;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEndIdx = value.indexOf('\n', start);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const line = value.slice(lineStart, lineEnd);
    const parsed = parseCheckLine(line);
    if (parsed) {
      const addition = `\n${CHECK_OPEN} `;
      const next = value.slice(0, lineEnd) + addition + value.slice(lineEnd);
      textarea.value = next;
      const caret = lineEnd + addition.length;
      textarea.setSelectionRange(caret, caret);
    } else if (!line.trim()) {
      const next = `${value.slice(0, lineStart)}${CHECK_OPEN} ${value.slice(lineEnd)}`;
      textarea.value = next;
      const caret = lineStart + `${CHECK_OPEN} `.length;
      textarea.setSelectionRange(caret, caret);
    } else {
      const bullet = parseBulletLine(line);
      const text = bullet ? bullet.text : line;
      const next = `${value.slice(0, lineStart)}${CHECK_OPEN} ${text}${value.slice(lineEnd)}`;
      textarea.value = next;
      const caret = lineStart + `${CHECK_OPEN} `.length + text.length;
      textarea.setSelectionRange(caret, caret);
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  /**
   * Continue checklist on Enter; blank item exits checklist mode (Keep-style).
   * @param {KeyboardEvent} e
   * @param {HTMLTextAreaElement} textarea
   */
  function handleChecklistKeydown(e, textarea) {
    if (e.defaultPrevented) return;
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const value = textarea.value;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    if (start !== end) return;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEndIdx = value.indexOf('\n', start);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const line = value.slice(lineStart, lineEnd);
    const parsed = parseCheckLine(line);
    if (!parsed) return;
    e.preventDefault();
    const itemText = parsed.text.trim();
    if (!itemText && start === lineEnd) {
      const dropEnd = lineEnd < value.length && value[lineEnd] === '\n' ? lineEnd + 1 : lineEnd;
      const next = value.slice(0, lineStart) + value.slice(dropEnd);
      textarea.value = next;
      textarea.setSelectionRange(lineStart, lineStart);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const insertion = `\n${CHECK_OPEN} `;
    const next = value.slice(0, start) + insertion + value.slice(end);
    textarea.value = next;
    const caret = start + insertion.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Insert or convert the current textarea line into a bullet.
   * @param {HTMLTextAreaElement} textarea
   */
  function insertBulletLine(textarea) {
    const value = textarea.value;
    const start = textarea.selectionStart ?? value.length;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEndIdx = value.indexOf('\n', start);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const line = value.slice(lineStart, lineEnd);
    const parsed = parseBulletLine(line);
    if (parsed) {
      const addition = `\n${BULLET_PREFIX}`;
      const next = value.slice(0, lineEnd) + addition + value.slice(lineEnd);
      textarea.value = next;
      const caret = lineEnd + addition.length;
      textarea.setSelectionRange(caret, caret);
    } else if (!line.trim()) {
      const next = `${value.slice(0, lineStart)}${BULLET_PREFIX}${value.slice(lineEnd)}`;
      textarea.value = next;
      const caret = lineStart + BULLET_PREFIX.length;
      textarea.setSelectionRange(caret, caret);
    } else {
      const check = parseCheckLine(line);
      const text = check ? check.text : line;
      const next = `${value.slice(0, lineStart)}${BULLET_PREFIX}${text}${value.slice(lineEnd)}`;
      textarea.value = next;
      const caret = lineStart + BULLET_PREFIX.length + text.length;
      textarea.setSelectionRange(caret, caret);
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  /**
   * Continue bullets on Enter; blank item exits bullet mode.
   * @param {KeyboardEvent} e
   * @param {HTMLTextAreaElement} textarea
   */
  function handleBulletKeydown(e, textarea) {
    if (e.defaultPrevented) return;
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const value = textarea.value;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    if (start !== end) return;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEndIdx = value.indexOf('\n', start);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const line = value.slice(lineStart, lineEnd);
    const parsed = parseBulletLine(line);
    if (!parsed) return;
    e.preventDefault();
    const itemText = parsed.text.trim();
    if (!itemText && start === lineEnd) {
      const dropEnd = lineEnd < value.length && value[lineEnd] === '\n' ? lineEnd + 1 : lineEnd;
      const next = value.slice(0, lineStart) + value.slice(dropEnd);
      textarea.value = next;
      textarea.setSelectionRange(lineStart, lineStart);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const insertion = `\n${BULLET_PREFIX}`;
    const next = value.slice(0, start) + insertion + value.slice(end);
    textarea.value = next;
    const caret = start + insertion.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const composeActions = document.createElement('div');
  composeActions.className = 'keep-notes__compose-actions';
  composeActions.hidden = true;

  const composePinBtn = document.createElement('button');
  composePinBtn.type = 'button';
  composePinBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  composePinBtn.title = 'Pin';
  composePinBtn.setAttribute('aria-label', 'Pin');
  composePinBtn.setAttribute('aria-pressed', 'false');
  composePinBtn.innerHTML = PIN_ICON;

  const composeCheckBtn = document.createElement('button');
  composeCheckBtn.type = 'button';
  composeCheckBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  composeCheckBtn.title = 'Add checklist item';
  composeCheckBtn.setAttribute('aria-label', 'Add checklist item');
  composeCheckBtn.innerHTML = CHECKLIST_ICON;

  const composeBulletBtn = document.createElement('button');
  composeBulletBtn.type = 'button';
  composeBulletBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  composeBulletBtn.title = 'Add bullet';
  composeBulletBtn.setAttribute('aria-label', 'Add bullet');
  composeBulletBtn.innerHTML = BULLETS_ICON;

  const composeImageInput = document.createElement('input');
  composeImageInput.type = 'file';
  composeImageInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
  composeImageInput.hidden = true;

  const composeImageBtn = document.createElement('button');
  composeImageBtn.type = 'button';
  composeImageBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  composeImageBtn.title = 'Add image';
  composeImageBtn.setAttribute('aria-label', 'Add image');
  composeImageBtn.innerHTML = IMAGE_ICON;

  const composeVoiceBtn = document.createElement('button');
  composeVoiceBtn.type = 'button';
  composeVoiceBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  composeVoiceBtn.title = 'Record voice note';
  composeVoiceBtn.setAttribute('aria-label', 'Record voice note');
  composeVoiceBtn.innerHTML = VOICE_ICON;

  const composeClose = document.createElement('button');
  composeClose.type = 'button';
  composeClose.className = 'keep-notes__btn keep-notes__btn--ghost';
  composeClose.textContent = 'Cancel';

  const composeSave = document.createElement('button');
  composeSave.type = 'button';
  composeSave.className = 'keep-notes__btn keep-notes__btn--primary';
  composeSave.textContent = 'Add';

  composeActions.append(
    composePinBtn,
    composeCheckBtn,
    composeBulletBtn,
    composeImageBtn,
    composeVoiceBtn,
    composeClose,
    composeSave,
  );
  compose.append(composeTitle, composeBody, composeCatRow, composeActions);
  document.body.append(composeImageInput);

  const collectionFilterRow = document.createElement('div');
  collectionFilterRow.className = 'keep-notes__collection-filter';

  const collectionFilterSelect = document.createElement('select');
  collectionFilterSelect.className = 'keep-notes__cat-select keep-notes__collection-filter-select';
  collectionFilterSelect.setAttribute('aria-label', 'Filter by collection');
  collectionFilterSelect.title = 'Filter by collection';

  collectionFilterRow.append(collectionFilterSelect);

  const scroll = document.createElement('div');
  scroll.className = 'keep-notes__scroll';

  const pinnedSection = document.createElement('section');
  pinnedSection.className = 'keep-notes__section keep-notes__section--pinned';
  pinnedSection.hidden = true;

  const pinnedLabel = document.createElement('h3');
  pinnedLabel.className = 'keep-notes__section-label';
  pinnedLabel.textContent = 'Pinned';

  const pinnedGrid = document.createElement('div');
  pinnedGrid.className = 'keep-notes__grid';
  pinnedSection.append(pinnedLabel, pinnedGrid);

  const othersSection = document.createElement('section');
  othersSection.className = 'keep-notes__section';

  const othersGrid = document.createElement('div');
  othersGrid.className = 'keep-notes__grid';
  othersSection.append(othersGrid);

  const empty = document.createElement('p');
  empty.className = 'keep-notes__empty muted';
  empty.hidden = true;
  empty.textContent = 'No notes yet — jot something above.';

  scroll.append(pinnedSection, othersSection, empty);

  const selectBar = document.createElement('div');
  selectBar.className = 'keep-notes__select-bar';
  selectBar.hidden = true;

  const selectCount = document.createElement('span');
  selectCount.className = 'keep-notes__select-count';

  const archiveSelectedBtn = document.createElement('button');
  archiveSelectedBtn.type = 'button';
  archiveSelectedBtn.className = 'keep-notes__btn keep-notes__btn--ghost';
  archiveSelectedBtn.textContent = 'Archive';

  const unarchiveSelectedBtn = document.createElement('button');
  unarchiveSelectedBtn.type = 'button';
  unarchiveSelectedBtn.className = 'keep-notes__btn keep-notes__btn--ghost';
  unarchiveSelectedBtn.textContent = 'Unarchive';
  unarchiveSelectedBtn.hidden = true;

  const deleteSelectedBtn = document.createElement('button');
  deleteSelectedBtn.type = 'button';
  deleteSelectedBtn.className = 'keep-notes__btn keep-notes__btn--danger-text';
  deleteSelectedBtn.textContent = 'Delete';
  deleteSelectedBtn.hidden = true;

  const cancelSelectBtn = document.createElement('button');
  cancelSelectBtn.type = 'button';
  cancelSelectBtn.className = 'keep-notes__btn keep-notes__btn--ghost';
  cancelSelectBtn.textContent = 'Cancel';

  selectBar.append(selectCount, archiveSelectedBtn, unarchiveSelectedBtn, deleteSelectedBtn, cancelSelectBtn);

  const status = document.createElement('p');
  status.className = 'keep-notes__status';
  status.hidden = true;
  status.setAttribute('aria-live', 'polite');

  shell.append(compose, collectionFilterRow, selectBar, scroll, status);
  root.append(shell);

  /** @type {Array<object>} */
  let notes = [];
  /** @type {string[]} */
  let categories = [];
  /** @type {string} */
  let collectionFilter = '';
  /** @type {object | null} */
  let editingNote = null;
  /** @type {MediaRecorder | null} */
  let recorder = null;
  /** @type {Blob[]} */
  let recordChunks = [];
  /** @type {boolean} */
  let composePinned = false;
  /** @type {MediaRecorder | null} */
  let composeRecorder = null;
  /** @type {Blob[]} */
  let composeRecordChunks = [];
  /** @type {boolean} */
  let selectMode = false;
  /** @type {Set<string>} */
  const selectedIds = new Set();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let cardClickTimer = null;
  /** @type {boolean} */
  let noteDragActive = false;
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pendingDeletes = new Map();

  /**
   * @param {object} a
   * @param {object} b
   */
  function compareNotes(a, b) {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ao = typeof a.sortOrder === 'number' ? a.sortOrder : null;
    const bo = typeof b.sortOrder === 'number' ? b.sortOrder : null;
    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return -1;
    if (ao === null && bo !== null) return 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  }

  function sortNotes() {
    notes.sort(compareNotes);
  }

  /**
   * @param {HTMLSelectElement} select
   * @param {HTMLInputElement} newInput
   * @param {string} [selected]
   */
  function populateCategorySelect(select, newInput, selected = '') {
    const current = String(selected || '').trim();
    select.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Add to collection';
    select.appendChild(blank);
    const titles = [...categories];
    if (current && !titles.some((t) => t.toLowerCase() === current.toLowerCase())) {
      titles.push(current);
    }
    for (const t of titles) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      select.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ New collection…';
    select.appendChild(newOpt);
    if (current && titles.some((t) => t === current)) {
      select.value = current;
    } else if (current) {
      const match = titles.find((t) => t.toLowerCase() === current.toLowerCase());
      select.value = match || '';
    } else {
      select.value = '';
    }
    const isNew = select.value === '__new__';
    newInput.hidden = !isNew;
    if (!isNew) newInput.value = '';
  }

  function populateCollectionFilter() {
    const prev = collectionFilter;
    collectionFilterSelect.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All collections';
    collectionFilterSelect.appendChild(all);
    for (const t of categories) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      collectionFilterSelect.appendChild(opt);
    }
    const none = document.createElement('option');
    none.value = '__none__';
    none.textContent = 'No collection';
    collectionFilterSelect.appendChild(none);
    const archived = document.createElement('option');
    archived.value = '__archived__';
    archived.textContent = 'Archived';
    collectionFilterSelect.appendChild(archived);
    if (prev === '__archived__') {
      collectionFilterSelect.value = '__archived__';
    } else if (prev === '__none__') {
      collectionFilterSelect.value = '__none__';
    } else if (prev) {
      const match = categories.find((t) => t.toLowerCase() === prev.toLowerCase());
      collectionFilterSelect.value = match || '';
      collectionFilter = match || '';
    } else {
      collectionFilterSelect.value = '';
    }
  }

  /**
   * @returns {boolean}
   */
  function viewingArchived() {
    return collectionFilter === '__archived__';
  }

  /**
   * @param {object} note
   * @returns {boolean}
   */
  function noteMatchesCollectionFilter(note) {
    if (viewingArchived()) return true;
    if (!collectionFilter) return true;
    const cat = String(note.category || '').trim();
    if (collectionFilter === '__none__') return !cat;
    return cat.toLowerCase() === collectionFilter.toLowerCase();
  }

  collectionFilterSelect.addEventListener('change', () => {
    const next = collectionFilterSelect.value;
    const wasArchived = collectionFilter === '__archived__';
    collectionFilter = next;
    if (wasArchived !== (next === '__archived__')) void loadNotes();
    else renderNotes();
  });

  /**
   * @param {HTMLSelectElement} select
   * @param {HTMLInputElement} newInput
   * @returns {string}
   */
  function resolveCategoryValue(select, newInput) {
    if (select.value === '__new__') return newInput.value.trim();
    return String(select.value || '').trim();
  }

  /**
   * @param {HTMLSelectElement} select
   * @param {HTMLInputElement} newInput
   */
  function wireCategorySelect(select, newInput) {
    select.addEventListener('change', () => {
      const isNew = select.value === '__new__';
      newInput.hidden = !isNew;
      if (isNew) {
        newInput.focus();
      } else {
        newInput.value = '';
      }
    });
  }

  wireCategorySelect(composeCatSelect, composeNewCat);
  composeCatSelect.addEventListener('focus', () => expandCompose(true));
  composeNewCat.addEventListener('focus', () => expandCompose(true));
  populateCategorySelect(composeCatSelect, composeNewCat, '');

  /**
   * @param {HTMLElement} grid
   * @param {number} clientX
   * @param {number} clientY
   */
  function dragInsertBefore(grid, clientX, clientY) {
    const cards = [...grid.querySelectorAll('.keep-notes__card:not(.keep-notes__card--dragging)')];
    if (!cards.length) return null;

    let closest = null;
    let closestDist = Infinity;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = (clientX - cx) ** 2 + (clientY - cy) ** 2;
      if (dist < closestDist) {
        closestDist = dist;
        closest = { card, rect, cx, cy };
      }
    }
    if (!closest) return null;

    const { card, rect, cx, cy } = closest;
    const onSameRow = clientY >= rect.top && clientY <= rect.bottom;
    const insertBefore = onSameRow ? clientX < cx : clientY < cy;
    return insertBefore ? card : card.nextElementSibling;
  }

  /**
   * @param {HTMLElement} grid
   */
  function wireGridDragDrop(grid) {
    grid.addEventListener('dragover', (e) => {
      if (selectMode) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const dragging = grid.querySelector('.keep-notes__card--dragging');
      if (!dragging) return;
      const before = dragInsertBefore(grid, e.clientX, e.clientY);
      if (before) grid.insertBefore(dragging, before);
      else grid.append(dragging);
    });
    grid.addEventListener('drop', (e) => {
      if (selectMode) return;
      e.preventDefault();
    });
  }

  async function persistNoteOrder() {
    const pinnedIds = [...pinnedGrid.querySelectorAll('.keep-notes__card')].map((c) => c.dataset.id).filter(Boolean);
    const othersIds = [...othersGrid.querySelectorAll('.keep-notes__card')].map((c) => c.dataset.id).filter(Boolean);
    const expectedPinned = notes.filter((n) => n.pinned).sort(compareNotes).map((n) => n.id);
    const expectedOthers = notes.filter((n) => !n.pinned).sort(compareNotes).map((n) => n.id);
    if (pinnedIds.join('|') === expectedPinned.join('|') && othersIds.join('|') === expectedOthers.join('|')) {
      renderNotes();
      return;
    }
    pinnedIds.forEach((id, i) => {
      const note = notes.find((n) => n.id === id);
      if (note) note.sortOrder = i;
    });
    othersIds.forEach((id, i) => {
      const note = notes.find((n) => n.id === id);
      if (note) note.sortOrder = i;
    });
    sortNotes();
    try {
      const r = await fetch('/api/keep-notes/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: pinnedIds, others: othersIds }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'reorder failed');
      notes = Array.isArray(data.notes) ? data.notes : notes;
      renderNotes();
    } catch (e) {
      showStatus(String(e?.message || e), true);
      void loadNotes();
    }
  }

  function syncCardDraggables() {
    root.querySelectorAll('.keep-notes__card-drag').forEach((handle) => {
      handle.draggable = !selectMode && !viewingArchived();
    });
  }

  /**
   * @param {string} id
   */
  function setCardSelected(id, on) {
    if (on) selectedIds.add(id);
    else selectedIds.delete(id);
    const card = root.querySelector(`.keep-notes__card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.toggle('keep-notes__card--selected', on);
    const check = card.querySelector('.keep-notes__card-check');
    if (check) check.checked = on;
  }

  function syncSelectBar() {
    const n = selectedIds.size;
    selectBar.hidden = !selectMode;
    root.classList.toggle('keep-notes--select-mode', selectMode);
    selectCount.textContent = n === 1 ? '1 selected' : `${n} selected`;
    const archivedView = viewingArchived();
    archiveSelectedBtn.hidden = archivedView;
    unarchiveSelectedBtn.hidden = !archivedView;
    deleteSelectedBtn.hidden = !archivedView;
    archiveSelectedBtn.disabled = n === 0;
    unarchiveSelectedBtn.disabled = n === 0;
    deleteSelectedBtn.disabled = n === 0;
    syncCardDraggables();
  }

  /**
   * @param {string} id
   */
  function enterSelectMode(id) {
    if (!selectMode) {
      selectMode = true;
      closeEditor();
    }
    setCardSelected(id, true);
    syncSelectBar();
  }

  function exitSelectMode() {
    selectMode = false;
    for (const id of [...selectedIds]) setCardSelected(id, false);
    selectedIds.clear();
    syncSelectBar();
  }

  /**
   * @param {string} id
   */
  function toggleSelected(id) {
    setCardSelected(id, !selectedIds.has(id));
    syncSelectBar();
    if (selectedIds.size === 0) selectMode = false;
  }

  async function bulkAction(action) {
    const ids = [...selectedIds];
    if (!ids.length) return;
    if (action === 'delete') {
      const label = ids.length === 1 ? 'Delete this note?' : `Delete ${ids.length} notes?`;
      if (!window.confirm(label)) return;
    }
    archiveSelectedBtn.disabled = true;
    unarchiveSelectedBtn.disabled = true;
    deleteSelectedBtn.disabled = true;
    try {
      const r = await fetch('/api/keep-notes/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || `${action} failed`);
      const affected = new Set(Array.isArray(data.affected) ? data.affected : []);
      if (action === 'delete') {
        notes = notes.filter((n) => !affected.has(n.id));
      } else {
        notes = notes.filter((n) => !affected.has(n.id));
      }
      exitSelectMode();
      renderNotes();
      const n = affected.size;
      const labels = {
        delete: `Deleted ${n} note${n === 1 ? '' : 's'}`,
        archive: `Archived ${n} note${n === 1 ? '' : 's'}`,
        unarchive: `Unarchived ${n} note${n === 1 ? '' : 's'}`,
      };
      showStatus(labels[action] || `Updated ${n} note${n === 1 ? '' : 's'}`);
    } catch (e) {
      showStatus(String(e?.message || e), true);
    } finally {
      syncSelectBar();
    }
  }

  cancelSelectBtn.addEventListener('click', () => exitSelectMode());
  archiveSelectedBtn.addEventListener('click', () => void bulkAction('archive'));
  unarchiveSelectedBtn.addEventListener('click', () => void bulkAction('unarchive'));
  deleteSelectedBtn.addEventListener('click', () => void bulkAction('delete'));

  /**
   * @param {string} msg
   * @param {boolean} [err]
   */
  function showStatus(msg, err = false) {
    status.textContent = msg;
    status.hidden = !msg;
    status.classList.toggle('keep-notes__status--err', err);
  }

  /**
   * @param {object} note
   */
  function attachmentUrl(note) {
    if (!note?.attachment?.filename) return '';
    return `/api/keep-notes/${encodeURIComponent(note.id)}/attachment/${encodeURIComponent(note.attachment.filename)}`;
  }

  /**
   * Small "x" overlay that removes the note's attachment.
   * @param {string} noteId
   * @returns {HTMLButtonElement}
   */
  function makeAttachmentRemoveBtn(noteId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'keep-notes__att-remove';
    btn.title = 'Remove attachment';
    btn.setAttribute('aria-label', 'Remove attachment');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (cardClickTimer) {
        clearTimeout(cardClickTimer);
        cardClickTimer = null;
      }
      void removeAttachment(noteId);
    });
    return btn;
  }

  /**
   * @param {HTMLElement} bodyEl
   * @param {object} note
   */
  function fillCardBody(bodyEl, note) {
    const body = String(note.body || '');
    bodyEl.replaceChildren();
    bodyEl.classList.toggle('keep-notes__card-body--checklist', bodyHasList(body));
    if (!bodyHasList(body)) {
      fillLinkifiedText(bodyEl, body.trim());
      return;
    }
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parsed = parseCheckLine(line);
      const bullet = parseBulletLine(line);
      if (parsed) {
        // Preview only — clicks open the note; checklist edits happen in the editor.
        const row = document.createElement('div');
        row.className = 'keep-notes__check-item';
        if (parsed.checked) row.classList.add('keep-notes__check-item--done');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'keep-notes__check-item-input';
        cb.checked = parsed.checked;
        cb.disabled = true;
        cb.tabIndex = -1;
        cb.setAttribute('aria-hidden', 'true');

        const text = document.createElement('span');
        text.className = 'keep-notes__check-item-text';
        fillLinkifiedText(text, parsed.text || ' ');

        row.append(cb, text);
        bodyEl.append(row);
      } else if (bullet) {
        const row = document.createElement('div');
        row.className = 'keep-notes__bullet-item';
        const mark = document.createElement('span');
        mark.className = 'keep-notes__bullet-mark';
        mark.textContent = BULLET_MARK;
        mark.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'keep-notes__bullet-text';
        fillLinkifiedText(text, bullet.text || ' ');
        row.append(mark, text);
        bodyEl.append(row);
      } else if (line.length) {
        const plain = document.createElement('div');
        plain.className = 'keep-notes__check-plain';
        fillLinkifiedText(plain, line);
        bodyEl.append(plain);
      } else if (i < lines.length - 1) {
        const gap = document.createElement('div');
        gap.className = 'keep-notes__check-plain keep-notes__check-plain--gap';
        gap.textContent = '\u00a0';
        bodyEl.append(gap);
      }
    }
  }

  /**
   * @param {HTMLElement} card
   * @param {object} note
   */
  function fillCard(card, note) {
    card.dataset.id = note.id;
    card.classList.toggle('keep-notes__card--pinned', Boolean(note.pinned));
    card.classList.toggle('keep-notes__card--selected', selectedIds.has(note.id));

    const checkEl = card.querySelector('.keep-notes__card-check');
    const dragHandle = card.querySelector('.keep-notes__card-drag');
    const titleEl = card.querySelector('.keep-notes__card-title');
    const bodyEl = card.querySelector('.keep-notes__card-body');
    const catEl = card.querySelector('.keep-notes__card-cat');
    const mediaEl = card.querySelector('.keep-notes__card-media');
    const pinBtn = card.querySelector('.keep-notes__card-pin');

    if (checkEl) checkEl.checked = selectedIds.has(note.id);
    if (dragHandle) dragHandle.draggable = !selectMode;

    const title = String(note.title || '').trim();
    const body = String(note.body || '').trim();
    const category = String(note.category || '').trim();
    if (titleEl) {
      fillLinkifiedText(titleEl, title);
      titleEl.hidden = !title;
    }
    if (bodyEl) {
      fillCardBody(bodyEl, note);
      bodyEl.hidden = !body;
    }
    if (catEl) {
      catEl.textContent = category;
      catEl.hidden = !category;
    }
    if (pinBtn) {
      if (note.archived) {
        pinBtn.innerHTML = RESTORE_ICON_16;
        pinBtn.title = 'Unarchive';
        pinBtn.setAttribute('aria-label', 'Unarchive note');
        pinBtn.setAttribute('aria-pressed', 'false');
      } else {
        pinBtn.innerHTML =
          '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H8c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1.03-1 1.03 1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';
        pinBtn.setAttribute('aria-pressed', note.pinned ? 'true' : 'false');
        pinBtn.title = note.pinned ? 'Unpin' : 'Pin';
        pinBtn.setAttribute('aria-label', note.pinned ? 'Unpin' : 'Pin');
      }
    }
    const delBtn = card.querySelector('.keep-notes__card-del');
    if (delBtn) {
      if (note.archived) {
        delBtn.innerHTML = TRASH_ICON_14;
        delBtn.title = 'Delete forever';
        delBtn.setAttribute('aria-label', 'Delete note permanently');
        delBtn.classList.remove('keep-notes__card-del--archive');
        delBtn.classList.add('keep-notes__card-del--trash');
      } else {
        delBtn.innerHTML = ARCHIVE_ICON_14;
        delBtn.title = 'Archive';
        delBtn.setAttribute('aria-label', 'Archive note');
        delBtn.classList.add('keep-notes__card-del--archive');
        delBtn.classList.remove('keep-notes__card-del--trash');
      }
    }
    if (mediaEl) {
      mediaEl.replaceChildren();
      mediaEl.hidden = !note.attachment;
      if (note.attachment) {
        const item = document.createElement('div');
        item.className = 'keep-notes__card-media-item';
        if (note.attachment.type === 'image') {
          const img = document.createElement('img');
          img.className = 'keep-notes__card-img';
          img.alt = title || 'Note image';
          img.loading = 'lazy';
          img.src = attachmentUrl(note);
          item.append(img);
        } else if (note.attachment.type === 'voice') {
          const audio = document.createElement('audio');
          audio.className = 'keep-notes__card-audio';
          audio.controls = true;
          audio.preload = 'none';
          audio.setAttribute('playsinline', '');
          audio.src = attachmentUrl(note);
          item.append(audio);
        }
        item.append(makeAttachmentRemoveBtn(note.id));
        mediaEl.append(item);
      }
    }
  }

  function createCard() {
    const card = document.createElement('article');
    card.className = 'keep-notes__card';
    card.tabIndex = 0;

    const checkEl = document.createElement('input');
    checkEl.type = 'checkbox';
    checkEl.className = 'keep-notes__card-check';
    checkEl.setAttribute('aria-label', 'Select note');
    checkEl.addEventListener('click', (e) => e.stopPropagation());
    checkEl.addEventListener('change', () => {
      if (!selectMode) enterSelectMode(card.dataset.id);
      else setCardSelected(card.dataset.id, checkEl.checked);
      syncSelectBar();
      if (selectedIds.size === 0) selectMode = false;
    });

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'keep-notes__card-pin';
    pinBtn.setAttribute('aria-label', 'Pin note');
    pinBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H8c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1.03-1 1.03 1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';

    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'keep-notes__card-more';
    moreBtn.title = 'Send to…';
    moreBtn.setAttribute('aria-label', 'Send note to another app');
    moreBtn.innerHTML = MORE_ICON;
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cardClickTimer) {
        clearTimeout(cardClickTimer);
        cardClickTimer = null;
      }
      openTransfer(card.dataset.id);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'keep-notes__card-del keep-notes__card-del--archive';
    delBtn.title = 'Archive';
    delBtn.setAttribute('aria-label', 'Archive note');
    delBtn.innerHTML = ARCHIVE_ICON_14;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cardClickTimer) {
        clearTimeout(cardClickTimer);
        cardClickTimer = null;
      }
      if (viewingArchived()) beginPendingDelete(card.dataset.id);
      else void archiveNoteById(card.dataset.id);
    });

    const titleEl = document.createElement('h4');
    titleEl.className = 'keep-notes__card-title';

    const bodyEl = document.createElement('div');
    bodyEl.className = 'keep-notes__card-body';

    const catEl = document.createElement('span');
    catEl.className = 'keep-notes__card-cat';
    catEl.hidden = true;

    const mediaEl = document.createElement('div');
    mediaEl.className = 'keep-notes__card-media';
    mediaEl.hidden = true;

    const dragHandle = document.createElement('span');
    dragHandle.className = 'keep-notes__card-drag';
    dragHandle.draggable = true;
    dragHandle.title = 'Drag to reorder';
    dragHandle.setAttribute('aria-label', 'Drag to reorder');
    const grip = document.createElement('span');
    grip.className = 'keep-notes__card-grip';
    grip.setAttribute('aria-hidden', 'true');
    dragHandle.append(grip);

    card.append(checkEl, dragHandle, pinBtn, moreBtn, delBtn, titleEl, bodyEl, mediaEl, catEl);

    dragHandle.addEventListener('dragstart', (e) => {
      if (selectMode || viewingArchived()) {
        e.preventDefault();
        return;
      }
      e.stopPropagation();
      noteDragActive = true;
      if (cardClickTimer) {
        clearTimeout(cardClickTimer);
        cardClickTimer = null;
      }
      card.classList.add('keep-notes__card--dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.id || '');
    });
    dragHandle.addEventListener('dragend', (e) => {
      e.stopPropagation();
      noteDragActive = false;
      card.classList.remove('keep-notes__card--dragging');
      if (!selectMode) void persistNoteOrder();
    });
    dragHandle.addEventListener('mousedown', (e) => e.stopPropagation());
    dragHandle.addEventListener('click', (e) => e.stopPropagation());

    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (viewingArchived()) void unarchiveNoteById(card.dataset.id);
      else void togglePin(card.dataset.id);
    });
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      if (noteDragActive) return;
      if (pendingDeletes.has(id)) return;
      if (selectMode) {
        toggleSelected(id);
        return;
      }
      if (cardClickTimer) clearTimeout(cardClickTimer);
      cardClickTimer = setTimeout(() => {
        cardClickTimer = null;
        openEditor(id);
      }, 220);
    });
    card.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (cardClickTimer) {
        clearTimeout(cardClickTimer);
        cardClickTimer = null;
      }
      enterSelectMode(card.dataset.id);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (selectMode) toggleSelected(card.dataset.id);
        else openEditor(card.dataset.id);
      }
    });

    return card;
  }

  function renderNotes() {
    pinnedGrid.replaceChildren();
    othersGrid.replaceChildren();
    sortNotes();
    const visible = notes.filter(noteMatchesCollectionFilter);
    const pinned = visible.filter((n) => n.pinned);
    const others = visible.filter((n) => !n.pinned);
    pinnedSection.hidden = pinned.length === 0;
    empty.hidden = visible.length > 0;
    if (!notes.length) {
      empty.textContent = viewingArchived()
        ? 'No archived notes.'
        : 'No notes yet — jot something above.';
    } else if (!visible.length) {
      empty.textContent = 'No notes in this collection.';
    }
    root.classList.toggle('keep-notes--archived-view', viewingArchived());

    for (const note of pinned) {
      const card = createCard();
      fillCard(card, note);
      pinnedGrid.append(card);
    }
    for (const note of others) {
      const card = createCard();
      fillCard(card, note);
      othersGrid.append(card);
    }
    for (const id of pendingDeletes.keys()) markCardPendingDelete(id);
    syncSelectBar();
  }

  /**
   * @param {string} id
   */
  function markCardPendingDelete(id) {
    const card = root.querySelector(`.keep-notes__card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add('keep-notes__card--pending-delete');
    if (card.querySelector('.keep-notes__card-undo')) return;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'keep-notes__btn keep-notes__card-undo';
    undo.textContent = 'Undo';
    undo.setAttribute('aria-label', 'Undo delete');
    undo.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelPendingDelete(id);
    });
    card.append(undo);
  }

  /**
   * @param {string} id
   */
  function beginPendingDelete(id) {
    if (pendingDeletes.has(id)) return;
    const timer = setTimeout(() => {
      void performDelete(id);
    }, 3000);
    pendingDeletes.set(id, timer);
    markCardPendingDelete(id);
  }

  /**
   * @param {string} id
   */
  function cancelPendingDelete(id) {
    const timer = pendingDeletes.get(id);
    if (timer) clearTimeout(timer);
    pendingDeletes.delete(id);
    const card = root.querySelector(`.keep-notes__card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.remove('keep-notes__card--pending-delete');
    card.querySelector('.keep-notes__card-undo')?.remove();
  }

  /**
   * @param {string} id
   */
  async function performDelete(id) {
    if (!pendingDeletes.has(id)) return;
    pendingDeletes.delete(id);
    try {
      const r = await fetch(`/api/keep-notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'delete failed');
      notes = notes.filter((n) => n.id !== id);
      renderNotes();
    } catch (err) {
      showStatus(String(err?.message || err), true);
      cancelPendingDelete(id);
    }
  }

  async function loadCategories() {
    try {
      const r = await fetch('/api/keep-notes/categories', { cache: 'no-store' });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'categories failed');
      categories = Array.isArray(data.categories) ? data.categories : [];
    } catch {
      categories = [
        'recommendations',
        'music',
        'biz ideas',
        'feature requests',
        'gym notes',
        'logistics notes',
      ];
    }
    const composeSelected = resolveCategoryValue(composeCatSelect, composeNewCat);
    populateCategorySelect(
      composeCatSelect,
      composeNewCat,
      composeCatSelect.value === '__new__' ? '' : composeSelected,
    );
    populateCollectionFilter();
  }

  async function loadNotes() {
    try {
      await loadCategories();
      const qs = viewingArchived() ? '?archived=1' : '';
      const r = await fetch(`/api/keep-notes${qs}`, { cache: 'no-store' });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'load failed');
      notes = Array.isArray(data.notes) ? data.notes : [];
      renderNotes();
    } catch (e) {
      showStatus(String(e?.message || e), true);
    }
  }

  /**
   * @param {string} id
   */
  async function togglePin(id) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    try {
      const r = await fetch(`/api/keep-notes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !note.pinned }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'pin failed');
      notes = notes.map((n) => (n.id === id ? data.note : n));
      sortNotes();
      renderNotes();
    } catch (e) {
      showStatus(String(e?.message || e), true);
    }
  }

  /**
   * @param {Blob} file
   * @returns {Promise<string>}
   */
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(/** @type {string} */ (reader.result));
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * @param {{ title?: string, body?: string, pinned?: boolean, category?: string }} fields
   * @returns {Promise<object>}
   */
  async function createNote(fields) {
    const r = await fetch('/api/keep-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'create failed');
    notes.push(data.note);
    sortNotes();
    if (fields.category) {
      const cat = String(fields.category).trim();
      if (cat && !categories.some((c) => c.toLowerCase() === cat.toLowerCase())) {
        categories = [...categories, cat];
      }
    }
    return data.note;
  }

  /**
   * @param {string} noteId
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async function uploadAttachment(noteId, payload) {
    const r = await fetch(`/api/keep-notes/${encodeURIComponent(noteId)}/attachment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'upload failed');
    notes = notes.map((n) => (n.id === data.note.id ? data.note : n));
    if (editingNote?.id === noteId) {
      editingNote = data.note;
      renderEditorMedia(data.note);
    }
    return data.note;
  }

  function resetCompose() {
    composeTitle.value = '';
    composeBody.value = '';
    composePinned = false;
    composePinBtn.setAttribute('aria-pressed', 'false');
    composePinBtn.title = 'Pin';
    composePinBtn.setAttribute('aria-label', 'Pin');
    composeVoiceBtn.classList.remove('keep-notes__btn--recording');
    composeVoiceBtn.title = 'Record voice note';
    populateCategorySelect(composeCatSelect, composeNewCat, '');
    expandCompose(false);
  }

  function expandCompose(on) {
    compose.classList.toggle('keep-notes__compose--expanded', on);
    composeActions.hidden = !on;
  }

  composeBody.addEventListener('focus', () => {
    expandCompose(true);
    queueMicrotask(() => {
      if (document.activeElement !== composeBody) composeBody.focus();
    });
  });
  composeBody.addEventListener('keydown', (e) => {
    handleChecklistKeydown(e, composeBody);
    handleBulletKeydown(e, composeBody);
  });
  composeTitle.addEventListener('focus', () => expandCompose(true));
  composeClose.addEventListener('click', (e) => {
    e.stopPropagation();
    if (composeRecorder && composeRecorder.state !== 'inactive') composeRecorder.stop();
    composeBody.blur();
    resetCompose();
  });

  composePinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    composePinned = !composePinned;
    composePinBtn.setAttribute('aria-pressed', composePinned ? 'true' : 'false');
    composePinBtn.title = composePinned ? 'Unpin' : 'Pin';
    composePinBtn.setAttribute('aria-label', composePinned ? 'Unpin' : 'Pin');
  });

  composeCheckBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    expandCompose(true);
    insertChecklistLine(composeBody);
  });

  composeBulletBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    expandCompose(true);
    insertBulletLine(composeBody);
  });

  composeImageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    expandCompose(true);
    composeImageInput.click();
  });

  composeImageInput.addEventListener('change', async () => {
    const file = composeImageInput.files?.[0];
    composeImageInput.value = '';
    if (!file) return;
    if (file.size > 8_000_000) {
      showStatus('Image too large (max 8 MB)', true);
      return;
    }
    composeImageBtn.disabled = true;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const note = await createNote({
        title: composeTitle.value.trim(),
        body: composeBody.value.trim(),
        pinned: composePinned,
        category: resolveCategoryValue(composeCatSelect, composeNewCat),
      });
      await uploadAttachment(note.id, {
        kind: 'image',
        dataUrl,
        mimeType: file.type,
        filename: file.name,
      });
      renderNotes();
      resetCompose();
      showStatus('');
    } catch (e) {
      showStatus(String(e?.message || e), true);
    } finally {
      composeImageBtn.disabled = false;
    }
  });

  composeVoiceBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (composeRecorder && composeRecorder.state === 'recording') {
      composeRecorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      showStatus('Microphone not available in this browser', true);
      return;
    }
    expandCompose(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      composeRecordChunks = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      composeRecorder = new MediaRecorder(stream, { mimeType });
      composeRecorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) composeRecordChunks.push(ev.data);
      };
      composeRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        composeVoiceBtn.classList.remove('keep-notes__btn--recording');
        composeVoiceBtn.title = 'Record voice note';
        const blob = new Blob(composeRecordChunks, { type: composeRecorder?.mimeType || 'audio/webm' });
        composeRecorder = null;
        if (blob.size === 0) return;
        try {
          const dataUrl = await readFileAsDataUrl(blob);
          const note = await createNote({
            title: composeTitle.value.trim(),
            body: composeBody.value.trim(),
            pinned: composePinned,
            category: resolveCategoryValue(composeCatSelect, composeNewCat),
          });
          await uploadAttachment(note.id, {
            kind: 'voice',
            dataUrl,
            mimeType: blob.type || 'audio/webm',
          });
          renderNotes();
          resetCompose();
          showStatus('Voice note saved');
        } catch (err) {
          showStatus(String(err?.message || err), true);
        }
      };
      composeRecorder.start();
      composeVoiceBtn.classList.add('keep-notes__btn--recording');
      composeVoiceBtn.title = 'Stop recording';
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  composeSave.addEventListener('click', async () => {
    const title = composeTitle.value.trim();
    const body = composeBody.value.trim();
    if (!title && !body) return;
    composeSave.disabled = true;
    try {
      await createNote({
        title,
        body,
        pinned: composePinned,
        category: resolveCategoryValue(composeCatSelect, composeNewCat),
      });
      renderNotes();
      resetCompose();
      showStatus('');
    } catch (e) {
      showStatus(String(e?.message || e), true);
    } finally {
      composeSave.disabled = false;
    }
  });

  /** Editor overlay — portaled to body so fixed positioning isn't clipped. */
  const overlay = document.createElement('div');
  overlay.className = 'keep-notes__overlay';
  overlay.hidden = true;

  const editor = document.createElement('div');
  editor.className = 'keep-notes__editor';
  editor.setAttribute('role', 'dialog');
  editor.setAttribute('aria-modal', 'true');
  editor.setAttribute('aria-label', 'Edit note');

  const editorTitle = document.createElement('input');
  editorTitle.type = 'text';
  editorTitle.className = 'keep-notes__editor-title';
  editorTitle.placeholder = 'Title';
  editorTitle.maxLength = 200;

  const editorBody = document.createElement('textarea');
  editorBody.className = 'keep-notes__editor-body';
  editorBody.placeholder = 'Note';
  editorBody.maxLength = 20000;

  const editorCatRow = document.createElement('div');
  editorCatRow.className = 'keep-notes__cat-row';

  const editorCatSelect = document.createElement('select');
  editorCatSelect.className = 'keep-notes__cat-select';
  editorCatSelect.setAttribute('aria-label', 'Add to collection');
  editorCatSelect.title = 'Add to collection';

  const editorNewCat = document.createElement('input');
  editorNewCat.type = 'text';
  editorNewCat.className = 'keep-notes__cat-new';
  editorNewCat.placeholder = 'New collection name';
  editorNewCat.maxLength = 48;
  editorNewCat.autocomplete = 'off';
  editorNewCat.hidden = true;

  editorCatRow.append(editorCatSelect, editorNewCat);
  wireCategorySelect(editorCatSelect, editorNewCat);
  populateCategorySelect(editorCatSelect, editorNewCat, '');

  const editorMedia = document.createElement('div');
  editorMedia.className = 'keep-notes__editor-media';
  editorMedia.hidden = true;

  const editorToolbar = document.createElement('div');
  editorToolbar.className = 'keep-notes__editor-toolbar';

  const pinEditorBtn = document.createElement('button');
  pinEditorBtn.type = 'button';
  pinEditorBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  pinEditorBtn.title = 'Pin';
  pinEditorBtn.setAttribute('aria-label', 'Pin');
  pinEditorBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H8c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1.03-1 1.03 1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';

  const checkEditorBtn = document.createElement('button');
  checkEditorBtn.type = 'button';
  checkEditorBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  checkEditorBtn.title = 'Add checklist item';
  checkEditorBtn.setAttribute('aria-label', 'Add checklist item');
  checkEditorBtn.innerHTML = CHECKLIST_ICON;

  const bulletEditorBtn = document.createElement('button');
  bulletEditorBtn.type = 'button';
  bulletEditorBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  bulletEditorBtn.title = 'Add bullet';
  bulletEditorBtn.setAttribute('aria-label', 'Add bullet');
  bulletEditorBtn.innerHTML = BULLETS_ICON;

  const imageInput = document.createElement('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
  imageInput.hidden = true;

  const imageBtn = document.createElement('button');
  imageBtn.type = 'button';
  imageBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  imageBtn.title = 'Add image';
  imageBtn.setAttribute('aria-label', 'Add image');
  imageBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>';

  const voiceBtn = document.createElement('button');
  voiceBtn.type = 'button';
  voiceBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  voiceBtn.title = 'Record voice note';
  voiceBtn.setAttribute('aria-label', 'Record voice note');
  voiceBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  deleteBtn.title = 'Archive';
  deleteBtn.setAttribute('aria-label', 'Archive note');
  deleteBtn.innerHTML = ARCHIVE_ICON_18;

  const sendEditorBtn = document.createElement('button');
  sendEditorBtn.type = 'button';
  sendEditorBtn.className = 'keep-notes__btn keep-notes__btn--icon';
  sendEditorBtn.title = 'Send to…';
  sendEditorBtn.setAttribute('aria-label', 'Send note to Task, Event, or Contact');
  sendEditorBtn.innerHTML = SEND_ICON;

  const closeEditorBtn = document.createElement('button');
  closeEditorBtn.type = 'button';
  closeEditorBtn.className = 'keep-notes__btn keep-notes__btn--ghost';
  closeEditorBtn.textContent = 'Close';

  editorToolbar.append(
    pinEditorBtn,
    checkEditorBtn,
    bulletEditorBtn,
    imageBtn,
    voiceBtn,
    sendEditorBtn,
    deleteBtn,
    closeEditorBtn,
  );
  editor.append(editorTitle, editorMedia, editorBody, editorCatRow, editorToolbar);
  overlay.append(editor);
  document.body.append(overlay);
  document.body.append(imageInput);

  editor.addEventListener('click', (e) => e.stopPropagation());
  editorBody.addEventListener('keydown', (e) => {
    handleChecklistKeydown(e, editorBody);
    handleBulletKeydown(e, editorBody);
  });
  editorTitle.addEventListener('input', queueEditorAutosave);
  editorBody.addEventListener('input', queueEditorAutosave);
  editorCatSelect.addEventListener('change', queueEditorAutosave);
  checkEditorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    insertChecklistLine(editorBody);
  });
  bulletEditorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    insertBulletLine(editorBody);
  });

  /**
   * @param {{ pinned?: boolean, archived?: boolean } | null | undefined} note
   */
  function syncPinEditorBtn(note) {
    if (note?.archived) {
      pinEditorBtn.innerHTML = RESTORE_ICON_16.replace('width="16" height="16"', 'width="18" height="18"');
      pinEditorBtn.setAttribute('aria-pressed', 'false');
      pinEditorBtn.title = 'Unarchive';
      pinEditorBtn.setAttribute('aria-label', 'Unarchive');
      return;
    }
    pinEditorBtn.innerHTML = PIN_ICON;
    const pinned = Boolean(note?.pinned);
    pinEditorBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    pinEditorBtn.title = pinned ? 'Unpin' : 'Pin';
    pinEditorBtn.setAttribute('aria-label', pinned ? 'Unpin' : 'Pin');
  }

  /**
   * @param {{ archived?: boolean } | null | undefined} note
   */
  function syncEditorDiscard(note) {
    if (note?.archived) {
      deleteBtn.classList.add('keep-notes__btn--danger');
      deleteBtn.innerHTML = TRASH_ICON_18;
      deleteBtn.title = 'Delete forever';
      deleteBtn.setAttribute('aria-label', 'Delete note permanently');
    } else {
      deleteBtn.classList.remove('keep-notes__btn--danger');
      deleteBtn.innerHTML = ARCHIVE_ICON_18;
      deleteBtn.title = 'Archive';
      deleteBtn.setAttribute('aria-label', 'Archive note');
    }
  }

  /**
   * @param {object | null} note
   */
  function renderEditorMedia(note) {
    editorMedia.replaceChildren();
    editorMedia.hidden = !note?.attachment;
    if (!note?.attachment) return;
    const item = document.createElement('div');
    item.className = 'keep-notes__editor-media-item';
    if (note.attachment.type === 'image') {
      const img = document.createElement('img');
      img.className = 'keep-notes__editor-img';
      img.alt = note.title || 'Attachment';
      img.src = attachmentUrl(note);
      item.append(img);
    } else {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.setAttribute('playsinline', '');
      audio.className = 'keep-notes__editor-audio';
      audio.src = attachmentUrl(note);
      item.append(audio);
    }
    item.append(makeAttachmentRemoveBtn(note.id));
    editorMedia.append(item);
  }

  /**
   * @param {string} id
   */
  function openEditor(id) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    editingNote = note;
    editorTitle.value = note.title || '';
    editorBody.value = note.body || '';
    populateCategorySelect(editorCatSelect, editorNewCat, note.category || '');
    syncPinEditorBtn(note);
    syncEditorDiscard(note);
    renderEditorMedia(note);
    overlay.hidden = false;
    editorBody.focus();
  }

  function closeEditor() {
    window.clearTimeout(editorSaveTimer);
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    voiceBtn.classList.remove('keep-notes__btn--recording');
    editingNote = null;
    overlay.hidden = true;
  }

  /**
   * @param {string} id
   * @param {string} title
   * @param {string} body
   * @param {string} [category]
   */
  async function persistNote(id, title, body, category, opts = {}) {
    try {
      const r = await fetch(`/api/keep-notes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, category }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'save failed');
      notes = notes.map((n) => (n.id === id ? data.note : n));
      const cat = String(category || '').trim();
      if (cat && !categories.some((c) => c.toLowerCase() === cat.toLowerCase())) {
        categories = [...categories, cat];
        populateCategorySelect(composeCatSelect, composeNewCat, resolveCategoryValue(composeCatSelect, composeNewCat));
        populateCollectionFilter();
      }
      if (!opts.quiet) {
        sortNotes();
        renderNotes();
      }
      return data.note;
    } catch (e) {
      showStatus(String(e?.message || e), true);
      return null;
    }
  }

  let editorSaveTimer = 0;
  function queueEditorAutosave() {
    if (!editingNote) return;
    window.clearTimeout(editorSaveTimer);
    editorSaveTimer = window.setTimeout(() => {
      if (!editingNote) return;
      const id = editingNote.id;
      const title = editorTitle.value.trim();
      const body = editorBody.value;
      const category = resolveCategoryValue(editorCatSelect, editorNewCat);
      void persistNote(id, title, body, category, { quiet: true }).then((saved) => {
        if (saved && editingNote?.id === id) editingNote = saved;
      });
    }, 1200);
  }

  function dismissEditor() {
    if (!editingNote) return;
    const { id } = editingNote;
    const title = editorTitle.value.trim();
    const body = editorBody.value;
    const category = resolveCategoryValue(editorCatSelect, editorNewCat);
    closeEditor();
    void persistNote(id, title, body, category);
  }

  closeEditorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissEditor();
  });

  overlay.addEventListener('click', () => {
    dismissEditor();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (selectMode) {
      e.preventDefault();
      exitSelectMode();
      return;
    }
    if (overlay.hidden) return;
    e.preventDefault();
    dismissEditor();
  });

  /**
   * @returns {Promise<object | null>}
   */
  async function saveEditor() {
    if (!editingNote) return null;
    const id = editingNote.id;
    const title = editorTitle.value.trim();
    const body = editorBody.value;
    const saved = await persistNote(id, title, body);
    if (saved) editingNote = saved;
    return saved;
  }

  pinEditorBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!editingNote) return;
    const noteId = editingNote.id;
    if (editingNote.archived) {
      closeEditor();
      await unarchiveNoteById(noteId);
      return;
    }
    await saveEditor();
    await togglePin(noteId);
    const refreshed = notes.find((n) => n.id === noteId);
    if (refreshed && editingNote?.id === noteId) {
      editingNote = refreshed;
    }
    syncPinEditorBtn(refreshed);
  });

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!editingNote) return;
    const noteId = editingNote.id;
    const archived = Boolean(editingNote.archived);
    closeEditor();
    if (archived) beginPendingDelete(noteId);
    else void archiveNoteById(noteId);
  });

  imageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    imageInput.click();
  });

  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    imageInput.value = '';
    if (!file || !editingNote) return;
    const noteId = editingNote.id;
    if (file.size > 8_000_000) {
      showStatus('Image too large (max 8 MB)', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await persistNote(noteId, editorTitle.value.trim(), editorBody.value);
        const r = await fetch(`/api/keep-notes/${encodeURIComponent(noteId)}/attachment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'image',
            dataUrl: reader.result,
            mimeType: file.type,
            filename: file.name,
          }),
        });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || 'upload failed');
        notes = notes.map((n) => (n.id === data.note.id ? data.note : n));
        if (editingNote?.id === noteId) {
          editingNote = data.note;
          renderEditorMedia(data.note);
        }
        renderNotes();
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    };
    reader.readAsDataURL(file);
  });

  /**
   * @param {string} noteId
   */
  async function removeAttachment(noteId) {
    const note = notes.find((n) => n.id === noteId);
    if (!note?.attachment) return;
    try {
      const r = await fetch(`/api/keep-notes/${encodeURIComponent(noteId)}/attachment`, {
        method: 'DELETE',
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'remove failed');
      notes = notes.map((n) => (n.id === data.note.id ? data.note : n));
      if (editingNote?.id === noteId) {
        editingNote = data.note;
        renderEditorMedia(data.note);
      }
      renderNotes();
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  }

  /**
   * @param {Blob} blob
   * @param {string} noteId
   */
  async function uploadVoice(blob, noteId) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await persistNote(noteId, editorTitle.value.trim(), editorBody.value);
        const r = await fetch(`/api/keep-notes/${encodeURIComponent(noteId)}/attachment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'voice',
            dataUrl: reader.result,
            mimeType: blob.type || 'audio/webm',
          }),
        });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || 'voice upload failed');
        notes = notes.map((n) => (n.id === data.note.id ? data.note : n));
        if (editingNote?.id === noteId) {
          editingNote = data.note;
          renderEditorMedia(data.note);
        }
        renderNotes();
        showStatus('Voice note saved');
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    };
    reader.readAsDataURL(blob);
  }

  voiceBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!editingNote) return;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      showStatus('Microphone not available in this browser', true);
      return;
    }
    const noteId = editingNote.id;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordChunks = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordChunks.push(ev.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        voiceBtn.classList.remove('keep-notes__btn--recording');
        voiceBtn.title = 'Record voice note';
        const blob = new Blob(recordChunks, { type: recorder?.mimeType || 'audio/webm' });
        if (blob.size > 0) void uploadVoice(blob, noteId);
        recorder = null;
      };
      recorder.start();
      voiceBtn.classList.add('keep-notes__btn--recording');
      voiceBtn.title = 'Stop recording';
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  /* ---- Transfer: send a note to Task / Event / Contact ------------------- */

  /**
   * @param {object} note
   * @returns {string}
   */
  function noteText(note) {
    return [String(note?.title || '').trim(), String(note?.body || '').trim()]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * @param {object} note
   * @returns {string}
   */
  function noteFirstLine(note) {
    const title = String(note?.title || '').trim();
    if (title) return title;
    const body = String(note?.body || '').trim();
    return body.split(/\r?\n/).find((l) => l.trim()) || '';
  }

  /**
   * @param {string} id
   */
  async function archiveNoteById(id) {
    try {
      const r = await fetch(`/api/keep-notes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true, pinned: false }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'archive failed');
      notes = notes.filter((n) => n.id !== id);
      renderNotes();
      showStatus('Note archived');
    } catch (e) {
      showStatus(String(e?.message || e), true);
    }
  }

  /**
   * @param {string} id
   */
  async function unarchiveNoteById(id) {
    try {
      const r = await fetch(`/api/keep-notes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: false }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'unarchive failed');
      notes = notes.filter((n) => n.id !== id);
      renderNotes();
      showStatus('Note restored');
    } catch (e) {
      showStatus(String(e?.message || e), true);
    }
  }

  /**
   * @param {object} note
   * @param {string} label
   */
  function offerArchive(note, label) {
    showStatus(label);
    if (note && window.confirm(`${label}. Archive this note now?`)) {
      void archiveNoteById(note.id);
    }
  }

  /**
   * Google Calendar "create event" template URL — the note becomes a new event.
   * @param {object} note
   * @returns {string}
   */
  function googleCalendarAddUrl(note) {
    const params = new URLSearchParams();
    params.set('action', 'TEMPLATE');
    params.set('text', (noteFirstLine(note) || 'Note').slice(0, 500));
    const details = noteText(note).slice(0, 6000);
    if (details) params.set('details', details);
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  /** @type {object | null} */
  let transferNote = null;
  /** @type {Array<object> | null} */
  let contactsCache = null;

  const transferOverlay = document.createElement('div');
  transferOverlay.className = 'keep-notes__overlay keep-notes__transfer-overlay';
  transferOverlay.hidden = true;

  const transfer = document.createElement('div');
  transfer.className = 'keep-notes__editor keep-notes__transfer';
  transfer.setAttribute('role', 'dialog');
  transfer.setAttribute('aria-modal', 'true');
  transfer.setAttribute('aria-label', 'Send note');

  const transferHeading = document.createElement('h3');
  transferHeading.className = 'keep-notes__transfer-heading';
  transferHeading.textContent = 'Send note to…';

  const transferPreview = document.createElement('p');
  transferPreview.className = 'keep-notes__transfer-preview';

  const transferActions = document.createElement('div');
  transferActions.className = 'keep-notes__transfer-actions';

  const toTaskBtn = document.createElement('button');
  toTaskBtn.type = 'button';
  toTaskBtn.className = 'keep-notes__btn';
  toTaskBtn.textContent = 'Send to Task';

  const toEventBtn = document.createElement('button');
  toEventBtn.type = 'button';
  toEventBtn.className = 'keep-notes__btn';
  toEventBtn.textContent = 'Send to Event';

  const toContactBtn = document.createElement('button');
  toContactBtn.type = 'button';
  toContactBtn.className = 'keep-notes__btn';
  toContactBtn.textContent = 'Send to Contact';

  transferActions.append(toTaskBtn, toEventBtn, toContactBtn);

  const contactPicker = document.createElement('div');
  contactPicker.className = 'keep-notes__transfer-contact';
  contactPicker.hidden = true;

  const contactSearch = document.createElement('input');
  contactSearch.type = 'search';
  contactSearch.className = 'keep-notes__transfer-search';
  contactSearch.placeholder = 'Search contacts…';
  contactSearch.autocomplete = 'off';

  const newContactBtn = document.createElement('button');
  newContactBtn.type = 'button';
  newContactBtn.className = 'keep-notes__btn keep-notes__btn--primary keep-notes__transfer-new';
  newContactBtn.textContent = 'Create new contact from note';

  const contactResults = document.createElement('div');
  contactResults.className = 'keep-notes__transfer-results';

  contactPicker.append(contactSearch, newContactBtn, contactResults);

  const transferFoot = document.createElement('div');
  transferFoot.className = 'keep-notes__transfer-foot';

  const transferCancel = document.createElement('button');
  transferCancel.type = 'button';
  transferCancel.className = 'keep-notes__btn keep-notes__btn--ghost';
  transferCancel.textContent = 'Cancel';
  transferFoot.append(transferCancel);

  transfer.append(transferHeading, transferPreview, transferActions, contactPicker, transferFoot);
  transferOverlay.append(transfer);
  document.body.append(transferOverlay);

  transfer.addEventListener('click', (e) => e.stopPropagation());
  transferOverlay.addEventListener('click', () => closeTransfer());

  /**
   * @param {string} id
   */
  function openTransfer(id) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    transferNote = note;
    const preview = noteText(note) || '(empty note)';
    transferPreview.textContent = preview.length > 160 ? `${preview.slice(0, 160)}…` : preview;
    contactPicker.hidden = true;
    contactSearch.value = '';
    contactResults.replaceChildren();
    transferOverlay.hidden = false;
  }

  function closeTransfer() {
    transferOverlay.hidden = true;
    transferNote = null;
  }

  async function sendNoteToTask() {
    if (!transferNote) return;
    const note = transferNote;
    const text = noteText(note).replace(/\s+/g, ' ').trim().slice(0, 280);
    if (!text) {
      showStatus('Note is empty — nothing to send.', true);
      return;
    }
    toTaskBtn.disabled = true;
    try {
      const r = await fetch('/api/vikunja/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false || !j.item) {
        throw new Error(
          j.error === 'vikunja_not_configured'
            ? 'Tasks not configured (set VIKUNJA_BASE_URL/TOKEN).'
            : j.detail || j.error || 'Could not create task.',
        );
      }
      closeTransfer();
      offerArchive(note, 'Sent to Tasks');
    } catch (e) {
      showStatus(String(e?.message || e), true);
    } finally {
      toTaskBtn.disabled = false;
    }
  }

  function sendNoteToEvent() {
    if (!transferNote) return;
    const note = transferNote;
    const url = googleCalendarAddUrl(note);
    window.open(url, '_blank', 'noopener');
    closeTransfer();
    offerArchive(note, 'Opened Google Calendar');
  }

  async function loadContactsForPicker() {
    if (contactsCache) return contactsCache;
    const r = await fetch('/api/network/contacts', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!j.ok || !Array.isArray(j.contacts)) throw new Error(j.error || 'Could not load contacts.');
    contactsCache = j.contacts;
    return contactsCache;
  }

  function renderContactResults() {
    const q = contactSearch.value.trim().toLowerCase();
    const list = (contactsCache || [])
      .filter((c) => !q || String(c.displayName || '').toLowerCase().includes(q))
      .slice(0, 40);
    contactResults.replaceChildren();
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'keep-notes__transfer-empty muted';
      p.textContent = contactsCache && contactsCache.length ? 'No matching contacts.' : 'No contacts yet.';
      contactResults.append(p);
      return;
    }
    for (const c of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'keep-notes__btn keep-notes__btn--ghost keep-notes__transfer-result';
      btn.textContent = String(c.displayName || 'Unnamed');
      btn.addEventListener('click', () => void attachNoteToContact(c));
      contactResults.append(btn);
    }
  }

  async function openContactPicker() {
    contactPicker.hidden = false;
    contactResults.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'keep-notes__transfer-empty muted';
    loading.textContent = 'Loading contacts…';
    contactResults.append(loading);
    try {
      await loadContactsForPicker();
      renderContactResults();
      contactSearch.focus();
    } catch (e) {
      contactResults.replaceChildren();
      const p = document.createElement('p');
      p.className = 'keep-notes__transfer-empty muted';
      p.textContent = String(e?.message || e);
      contactResults.append(p);
    }
  }

  /**
   * @param {object} contact
   */
  async function attachNoteToContact(contact) {
    if (!transferNote) return;
    const note = transferNote;
    const addition = noteText(note).trim();
    if (!addition) {
      showStatus('Note is empty — nothing to attach.', true);
      return;
    }
    const stamp = new Date().toLocaleDateString();
    const block = `Keep note (${stamp}): ${addition}`;
    const merged = [String(contact.notes || '').trim(), block].filter(Boolean).join('\n\n').slice(0, 8000);
    try {
      const r = await fetch(`/api/network/contacts/${encodeURIComponent(contact.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: merged }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || 'Could not attach note.');
      contactsCache = null;
      closeTransfer();
      offerArchive(note, `Attached to ${contact.displayName || 'contact'}`);
    } catch (e) {
      showStatus(String(e?.message || e), true);
    }
  }

  async function createContactFromNote() {
    if (!transferNote) return;
    const note = transferNote;
    const displayName = (noteFirstLine(note) || 'New contact').slice(0, 200);
    try {
      const r = await fetch('/api/network/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, notes: noteText(note).slice(0, 8000), source: 'keep-note' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false || !j.contact) throw new Error(j.error || 'Could not create contact.');
      contactsCache = null;
      closeTransfer();
      offerArchive(note, `Created contact ${j.contact.displayName || displayName}`);
    } catch (e) {
      showStatus(String(e?.message || e), true);
    }
  }

  toTaskBtn.addEventListener('click', () => void sendNoteToTask());
  toEventBtn.addEventListener('click', () => sendNoteToEvent());
  toContactBtn.addEventListener('click', () => void openContactPicker());
  contactSearch.addEventListener('input', () => renderContactResults());
  newContactBtn.addEventListener('click', () => void createContactFromNote());
  transferCancel.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTransfer();
  });

  sendEditorBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!editingNote) return;
    const id = editingNote.id;
    await saveEditor();
    closeEditor();
    openTransfer(id);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !transferOverlay.hidden) {
      e.preventDefault();
      closeTransfer();
    }
  });

  wireGridDragDrop(pinnedGrid);
  wireGridDragDrop(othersGrid);

  document.addEventListener('dashbird:mobile-nav', (e) => {
    if (e.detail?.tab === 'notes') void loadNotes();
  });

  void loadNotes();
}
