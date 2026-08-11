/**
 * Floating daily scratch sticky — same chrome as the old DEV NOTES pad,
 * green theme. Highlight text and convert to bullets or checkboxes.
 * Checking a box strikes the row, then deletes it after 5s (uncheck to cancel).
 * Body autosaves to the server; position/collapse stay in localStorage.
 */
import { loadDailyScratch, saveDailyScratch } from '../lib/daily-scratch-storage.js';

const NOTE_WIDTH = 240;
const HEADER_HEIGHT = 28;
const VARIANT_ID = 'green';
const SERVER_SAVE_MS = 400;
const CHECK_DELETE_MS = 5000;

function defaultPosition() {
  return clampPosition(24, 96);
}

/**
 * @param {number} x
 * @param {number} y
 */
function clampPosition(x, y) {
  const maxX = Math.max(8, window.innerWidth - NOTE_WIDTH - 8);
  const maxY = Math.max(56, window.innerHeight - HEADER_HEIGHT - 48);
  return {
    x: Math.max(8, Math.min(x, maxX)),
    y: Math.max(56, Math.min(y, maxY)),
  };
}

function chevronSvg(collapsed) {
  if (collapsed) {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
  }
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
}

const ICON_BULLETS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="5" cy="18" r="1.4" fill="currentColor" stroke="none"/><path d="M10 6h10M10 12h10M10 18h10"/></svg>`;
const ICON_CHECKS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 3 3 5-6"/></svg>`;

/**
 * @param {string} line
 * @returns {{ kind: 'check' | 'bullet' | 'plain', text: string, checked?: boolean }}
 */
function parseScratchLine(line) {
  const raw = String(line ?? '');
  const checkMd = raw.match(/^\s*(?:[-*•]\s+)?\[([ xX])\]\s*(.*)$/);
  if (checkMd) return { kind: 'check', checked: checkMd[1] !== ' ', text: checkMd[2] };
  const checkBox = raw.match(/^\s*([☐☑])\s*(.*)$/);
  if (checkBox) return { kind: 'check', checked: checkBox[1] === '☑', text: checkBox[2] };
  const bullet = raw.match(/^\s*[•\-\*]\s+(.*)$/);
  if (bullet) return { kind: 'bullet', text: bullet[1] };
  return { kind: 'plain', text: raw };
}

/**
 * Mount once on document.body (fixed overlay).
 */
export function mountDailyScratchSticky() {
  if (document.getElementById('dashbird-daily-scratch')) return;

  /** @type {import('../lib/daily-scratch-storage.js').DailyScratchState} */
  let state = loadDailyScratch(VARIANT_ID, defaultPosition, clampPosition);

  /** @type {{ pointerId: number, startX: number, startY: number, origX: number, origY: number } | null} */
  let drag = null;
  let hydrated = false;
  let dirty = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let saveTimer = null;
  let saveInFlight = false;
  let saveAgain = false;
  /** @type {Map<HTMLElement, ReturnType<typeof setTimeout>>} */
  const pendingDeletes = new Map();

  const root = document.createElement('div');
  root.id = 'dashbird-daily-scratch';
  root.className = 'dev-sticky-note dev-sticky-note--scratch-green';
  root.setAttribute('role', 'complementary');
  root.setAttribute('aria-label', 'Daily scratch');
  document.body.append(root);

  const header = document.createElement('div');
  header.className = 'dev-sticky-note__header';

  const dragHandle = document.createElement('div');
  dragHandle.className = 'dev-sticky-note__drag';
  const title = document.createElement('span');
  title.className = 'dev-sticky-note__title';
  title.textContent = 'SCRATCH';
  dragHandle.append(title);

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'dev-sticky-note__collapse';

  header.append(dragHandle, collapseBtn);

  const body = document.createElement('div');
  body.className = 'dev-sticky-note__body';

  const tools = document.createElement('div');
  tools.className = 'dev-sticky-note__scratch-tools';

  const bulletsBtn = document.createElement('button');
  bulletsBtn.type = 'button';
  bulletsBtn.className = 'dev-sticky-note__tool';
  bulletsBtn.setAttribute('aria-label', 'Turn highlighted lines into bullets');
  bulletsBtn.title = 'Bullets';
  bulletsBtn.innerHTML = ICON_BULLETS;

  const checksBtn = document.createElement('button');
  checksBtn.type = 'button';
  checksBtn.className = 'dev-sticky-note__tool';
  checksBtn.setAttribute('aria-label', 'Turn highlighted lines into checkboxes');
  checksBtn.title = 'Checkboxes';
  checksBtn.innerHTML = ICON_CHECKS;

  tools.append(bulletsBtn, checksBtn);

  const editor = document.createElement('div');
  editor.className = 'scratch-editor';
  editor.contentEditable = 'true';
  editor.spellcheck = false;
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', "Today's scratch");
  editor.dataset.placeholder = "Today's scratch…";

  body.append(editor, tools);
  root.append(header, body);

  function persistLocal() {
    saveDailyScratch(VARIANT_ID, state);
  }

  function applyLayout() {
    root.style.left = `${state.x}px`;
    root.style.top = `${state.y}px`;
    root.style.width = `${NOTE_WIDTH}px`;
    root.classList.toggle('dev-sticky-note--collapsed', state.collapsed);
    body.hidden = state.collapsed;
    header.classList.toggle('dev-sticky-note__header--collapsed', state.collapsed);
    collapseBtn.setAttribute('aria-label', state.collapsed ? 'Expand scratch' : 'Collapse scratch');
    collapseBtn.innerHTML = chevronSvg(state.collapsed);
  }

  function clearPendingDeletes() {
    for (const t of pendingDeletes.values()) clearTimeout(t);
    pendingDeletes.clear();
  }

  /**
   * @param {HTMLElement} line
   */
  function lineText(line) {
    const span = line.querySelector('.scratch-line__text');
    const raw = span ? span.textContent : line.textContent;
    return String(raw || '').replace(/\u00a0/g, ' ').replace(/\n$/u, '');
  }

  /**
   * @param {string} text
   */
  function makePlainLine(text) {
    const el = document.createElement('div');
    el.className = 'scratch-line scratch-line--plain';
    if (text) el.textContent = text;
    else el.append(document.createElement('br'));
    return el;
  }

  /**
   * @param {string} text
   */
  function makeBulletLine(text) {
    const el = document.createElement('div');
    el.className = 'scratch-line scratch-line--bullet';
    el.contentEditable = 'false';
    const span = document.createElement('span');
    span.className = 'scratch-line__text';
    span.contentEditable = 'true';
    span.textContent = text;
    el.append(span);
    return el;
  }

  /**
   * @param {string} text
   * @param {boolean} checked
   */
  function makeCheckLine(text, checked) {
    const el = document.createElement('div');
    el.className = 'scratch-line scratch-line--check';
    el.contentEditable = 'false';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'scratch-line__box';
    input.checked = Boolean(checked);
    input.setAttribute('aria-label', 'Mark done');
    const span = document.createElement('span');
    span.className = 'scratch-line__text';
    span.contentEditable = 'true';
    span.textContent = text;
    el.append(input, span);
    el.classList.toggle('scratch-line--checked', input.checked);
    bindCheckLine(el);
    if (input.checked) scheduleCheckDelete(el, true);
    return el;
  }

  /**
   * @param {HTMLElement} el
   */
  function bindCheckLine(el) {
    const input = el.querySelector('input.scratch-line__box');
    if (!input || input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('change', () => {
      el.classList.toggle('scratch-line--checked', input.checked);
      scheduleCheckDelete(el, input.checked);
      syncFromEditor();
    });
  }

  /**
   * @param {HTMLElement} el
   * @param {boolean} checked
   */
  function scheduleCheckDelete(el, checked) {
    const prev = pendingDeletes.get(el);
    if (prev) {
      clearTimeout(prev);
      pendingDeletes.delete(el);
    }
    if (!checked) return;
    const t = setTimeout(() => {
      pendingDeletes.delete(el);
      if (!el.isConnected) return;
      const input = el.querySelector('input.scratch-line__box');
      if (!input?.checked) return;
      el.remove();
      if (!editor.querySelector('.scratch-line')) editor.append(makePlainLine(''));
      updatePlaceholder();
      syncFromEditor();
    }, CHECK_DELETE_MS);
    pendingDeletes.set(el, t);
  }

  function serializeEditor() {
    const lines = [...editor.querySelectorAll('.scratch-line')];
    if (!lines.length) return '';
    return lines
      .map((line) => {
        const text = lineText(line);
        if (line.classList.contains('scratch-line--check')) {
          const checked = Boolean(line.querySelector('input.scratch-line__box')?.checked);
          return `- [${checked ? 'x' : ' '}] ${text}`;
        }
        if (line.classList.contains('scratch-line--bullet')) return `• ${text}`;
        return text;
      })
      .join('\n');
  }

  function updatePlaceholder() {
    const empty = !serializeEditor().replace(/\s/g, '');
    editor.classList.toggle('scratch-editor--empty', empty);
  }

  /**
   * @param {string} content
   */
  function renderFromText(content) {
    clearPendingDeletes();
    const rawLines = String(content ?? '').split('\n');
    if (!rawLines.length) rawLines.push('');
    const frag = document.createDocumentFragment();
    for (const raw of rawLines) {
      const parsed = parseScratchLine(raw);
      if (parsed.kind === 'check') frag.append(makeCheckLine(parsed.text, Boolean(parsed.checked)));
      else if (parsed.kind === 'bullet') frag.append(makeBulletLine(parsed.text));
      else frag.append(makePlainLine(parsed.text));
    }
    editor.replaceChildren(frag);
    updatePlaceholder();
  }

  function applyContent() {
    if (editor.querySelector('.scratch-line') && serializeEditor() === state.content) {
      updatePlaceholder();
      return;
    }
    renderFromText(state.content);
  }

  function ensureLineStructure() {
    for (const node of [...editor.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.replaceWith(makePlainLine(node.textContent || ''));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = /** @type {HTMLElement} */ (node);
      if (el.classList.contains('scratch-line')) continue;
      if (el.tagName === 'BR') {
        el.replaceWith(makePlainLine(''));
        continue;
      }
      if (!el.querySelector('.scratch-line')) {
        el.classList.add('scratch-line', 'scratch-line--plain');
      }
    }
  }

  /**
   * @param {{ keepalive?: boolean }} [opts]
   */
  async function persistServer(opts = {}) {
    if (!hydrated) return;
    if (saveInFlight) {
      saveAgain = true;
      return;
    }
    saveInFlight = true;
    const content = state.content;
    try {
      const r = await fetch('/api/daily-scratch', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        keepalive: Boolean(opts.keepalive),
        cache: 'no-store',
      });
      const data = await r.json().catch(() => null);
      if (data?.ok && data?.note && !dirty) {
        state = { ...state, updatedAt: String(data.note.updatedAt || state.updatedAt || '') };
        persistLocal();
      }
    } catch {
      // keep the local draft; retry on next edit / flush
    } finally {
      saveInFlight = false;
      if (saveAgain) {
        saveAgain = false;
        void persistServer(opts);
      }
    }
  }

  function scheduleServerSave() {
    persistLocal();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      dirty = false;
      void persistServer();
    }, SERVER_SAVE_MS);
  }

  function flushSave() {
    persistLocal();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    dirty = false;
    void persistServer({ keepalive: true });
  }

  function syncFromEditor() {
    ensureLineStructure();
    updatePlaceholder();
    dirty = true;
    state = {
      ...state,
      content: serializeEditor(),
      updatedAt: new Date().toISOString(),
    };
    scheduleServerSave();
  }

  /**
   * @param {Node | null} node
   * @returns {HTMLElement | null}
   */
  function lineFromNode(node) {
    if (!node) return null;
    const el = node.nodeType === Node.ELEMENT_NODE ? /** @type {HTMLElement} */ (node) : node.parentElement;
    const line = el?.closest?.('.scratch-line');
    return line instanceof HTMLElement && editor.contains(line) ? line : null;
  }

  /**
   * @returns {HTMLElement[]}
   */
  function selectedScratchLines() {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const rootNode = range.commonAncestorContainer;
    if (rootNode !== editor && !editor.contains(rootNode)) return [];
    const all = [...editor.querySelectorAll('.scratch-line')];
    if (range.collapsed) {
      const line = lineFromNode(range.startContainer);
      return line ? [line] : [];
    }
    return all.filter((line) => range.intersectsNode(line));
  }

  /**
   * @param {'bullet' | 'check'} kind
   */
  function convertSelection(kind) {
    const lines = selectedScratchLines();
    if (!lines.length) return;
    /** @type {HTMLElement | null} */
    let last = null;
    for (const line of lines) {
      if (kind === 'check' && line.classList.contains('scratch-line--check')) {
        last = line;
        continue;
      }
      if (kind === 'bullet' && line.classList.contains('scratch-line--bullet')) {
        last = line;
        continue;
      }
      const parsed = parseScratchLine(lineText(line));
      const text = parsed.text;
      const prev = pendingDeletes.get(line);
      if (prev) {
        clearTimeout(prev);
        pendingDeletes.delete(line);
      }
      const next = kind === 'check' ? makeCheckLine(text, false) : makeBulletLine(text);
      line.replaceWith(next);
      last = next;
    }
    if (last) {
      const focusEl = last.querySelector('.scratch-line__text') || last;
      const range = document.createRange();
      range.selectNodeContents(focusEl);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    syncFromEditor();
  }

  /**
   * @param {HTMLElement} line
   */
  function focusLineEnd(line) {
    const textEl = line.querySelector('.scratch-line__text') || line;
    const range = document.createRange();
    range.selectNodeContents(textEl);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  applyLayout();
  applyContent();

  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state = { ...state, collapsed: !state.collapsed };
    persistLocal();
    applyLayout();
  });

  collapseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

  for (const btn of [bulletsBtn, checksBtn]) {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }
  bulletsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    convertSelection('bullet');
  });
  checksBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    convertSelection('check');
  });

  editor.addEventListener('input', () => syncFromEditor());

  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const line = e.target instanceof Node ? lineFromNode(e.target) : null;
    const listLine =
      line &&
      (line.classList.contains('scratch-line--check') || line.classList.contains('scratch-line--bullet'));
    if (listLine && text.includes('\n')) {
      const parts = text.split(/\r?\n/);
      document.execCommand('insertText', false, parts[0]);
      const kind = line.classList.contains('scratch-line--check') ? 'check' : 'bullet';
      let at = line;
      for (let i = 1; i < parts.length; i++) {
        const parsed = parseScratchLine(parts[i]);
        const next = kind === 'check' ? makeCheckLine(parsed.text, false) : makeBulletLine(parsed.text);
        at.after(next);
        at = next;
      }
      focusLineEnd(at);
      syncFromEditor();
      return;
    }
    document.execCommand('insertText', false, text);
  });

  editor.addEventListener('keydown', (e) => {
    const line = e.target instanceof Node ? lineFromNode(e.target) : null;
    if (!line) return;
    const isList =
      line.classList.contains('scratch-line--check') || line.classList.contains('scratch-line--bullet');
    if (!isList) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      if (!lineText(line).trim()) {
        const plain = makePlainLine('');
        const prev = pendingDeletes.get(line);
        if (prev) {
          clearTimeout(prev);
          pendingDeletes.delete(line);
        }
        line.replaceWith(plain);
        focusLineEnd(plain);
        syncFromEditor();
        return;
      }
      const next = line.classList.contains('scratch-line--check')
        ? makeCheckLine('', false)
        : makeBulletLine('');
      line.after(next);
      focusLineEnd(next);
      syncFromEditor();
      return;
    }

    if (e.key === 'Backspace' && !lineText(line)) {
      e.preventDefault();
      const prev = pendingDeletes.get(line);
      if (prev) {
        clearTimeout(prev);
        pendingDeletes.delete(line);
      }
      const previous = line.previousElementSibling;
      line.remove();
      if (!editor.querySelector('.scratch-line')) editor.append(makePlainLine(''));
      const focus = previous instanceof HTMLElement ? previous : editor.querySelector('.scratch-line');
      if (focus instanceof HTMLElement) focusLineEnd(focus);
      syncFromEditor();
    }
  });

  editor.addEventListener('blur', () => flushSave());

  dragHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: state.x,
      origY: state.y,
    };
    dragHandle.setPointerCapture(e.pointerId);
  });

  dragHandle.addEventListener('pointermove', (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const pos = clampPosition(drag.origX + (e.clientX - drag.startX), drag.origY + (e.clientY - drag.startY));
    state = { ...state, ...pos };
    applyLayout();
  });

  function endDrag(e) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag = null;
    try {
      dragHandle.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    persistLocal();
  }

  dragHandle.addEventListener('pointerup', endDrag);
  dragHandle.addEventListener('pointercancel', endDrag);

  window.addEventListener('pagehide', () => flushSave());
  window.addEventListener('resize', () => {
    state = { ...state, ...clampPosition(state.x, state.y) };
    persistLocal();
    applyLayout();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });

  void (async () => {
    try {
      const r = await fetch('/api/daily-scratch', { cache: 'no-store' });
      const data = await r.json();
      if (!data?.ok || !data?.note) {
        hydrated = true;
        if (state.content) void persistServer();
        return;
      }
      const serverContent = typeof data.note.content === 'string' ? data.note.content : '';
      const serverUpdated = String(data.note.updatedAt || '');
      const localUpdated = String(state.updatedAt || '');
      if (dirty) {
        hydrated = true;
        void persistServer();
        return;
      }
      const preferLocal =
        Boolean(state.content) &&
        (!serverContent || (localUpdated && serverUpdated && localUpdated > serverUpdated));
      if (preferLocal) {
        hydrated = true;
        if (state.content !== serverContent) void persistServer();
        return;
      }
      state = {
        ...state,
        content: serverContent,
        updatedAt: serverUpdated || state.updatedAt || '',
      };
      persistLocal();
      applyContent();
    } catch {
      // offline — keep the local draft
    } finally {
      hydrated = true;
      if (dirty) void persistServer();
    }
  })();
}
