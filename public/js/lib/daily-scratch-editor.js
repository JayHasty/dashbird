/**
 * Shared daily scratch editor (bullets, checkboxes, autosave).
 * Desktop sticky and mobile sheet both bind this to the same /api/daily-scratch store.
 */
import { loadDailyScratch, saveDailyScratch } from './daily-scratch-storage.js';

export const DAILY_SCRATCH_VARIANT_ID = 'green';
const SERVER_SAVE_MS = 400;
const CHECK_DELETE_MS = 5000;
const PULL_WHILE_VISIBLE_MS = 12_000;
const SCRATCH_SYNC_CHANNEL = 'dashbird-daily-scratch-sync';

export const ICON_BULLETS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="5" cy="18" r="1.4" fill="currentColor" stroke="none"/><path d="M10 6h10M10 12h10M10 18h10"/></svg>`;
export const ICON_CHECKS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 3 3 5-6"/></svg>`;

/**
 * @param {string} line
 * @returns {{ kind: 'check' | 'bullet' | 'plain', text: string, checked?: boolean }}
 */
export function parseScratchLine(line) {
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
 * Mount editor + tool row into `body`. Content autosaves to the server;
 * layout fields in localStorage are preserved unless the caller patches them.
 *
 * @param {HTMLElement} body
 * @param {{
 *   variantId?: string,
 *   defaultPosition: () => { x: number, y: number },
 *   clampPosition: (x: number, y: number) => { x: number, y: number },
 * }} opts
 */
export function mountScratchPad(body, opts) {
  const variantId = opts.variantId || DAILY_SCRATCH_VARIANT_ID;

  /** @type {import('./daily-scratch-storage.js').DailyScratchState} */
  let state = loadDailyScratch(variantId, opts.defaultPosition, opts.clampPosition);
  let hydrated = false;
  let dirty = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let saveTimer = null;
  let saveInFlight = false;
  let saveAgain = false;
  /** Content last acknowledged by the server; null until first successful GET/PUT. */
  /** @type {string | null} */
  let ackContent = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let pullTimer = null;
  /** @type {BroadcastChannel | null} */
  let syncChannel = null;
  try {
    syncChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SCRATCH_SYNC_CHANNEL) : null;
  } catch {
    syncChannel = null;
  }
  /** @type {Map<HTMLElement, ReturnType<typeof setTimeout>>} */
  const pendingDeletes = new Map();

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

  function persistLocal() {
    saveDailyScratch(variantId, state);
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

  function notifyPeers() {
    try {
      syncChannel?.postMessage({
        type: 'scratch-updated',
        updatedAt: state.updatedAt,
        content: state.content,
      });
    } catch {
      // channel closed / unsupported
    }
  }

  /**
   * @param {{ keepalive?: boolean }} [saveOpts]
   */
  async function persistServer(saveOpts = {}) {
    if (!hydrated) return;
    if (!dirty && ackContent !== null && state.content === ackContent) return;
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
        keepalive: Boolean(saveOpts.keepalive),
        cache: 'no-store',
      });
      const data = await r.json().catch(() => null);
      if (data?.ok && data?.note) {
        const serverUpdated = String(data.note.updatedAt || '');
        if (state.content === content) {
          dirty = false;
          ackContent = content;
          state = { ...state, updatedAt: serverUpdated || state.updatedAt || '' };
          persistLocal();
          notifyPeers();
        }
      }
    } catch {
      // keep the local draft; retry on next edit / flush
    } finally {
      saveInFlight = false;
      if (saveAgain || dirty) {
        saveAgain = false;
        if (dirty) void persistServer(saveOpts);
      }
    }
  }

  function scheduleServerSave() {
    persistLocal();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persistServer();
    }, SERVER_SAVE_MS);
  }

  /** Push only when there are unsaved edits — never overwrite peers with a stale tab. */
  function flushSave() {
    if (!dirty && ackContent !== null && state.content === ackContent) return;
    persistLocal();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
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

  /**
   * @param {HTMLElement} line
   */
  function focusLineStart(line) {
    const textEl = line.querySelector('.scratch-line__text') || line;
    const range = document.createRange();
    range.selectNodeContents(textEl);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /**
   * Collapsed caret offset within a line's editable text, or null if unavailable.
   * @param {HTMLElement} line
   * @returns {number | null}
   */
  function caretOffsetInLine(line) {
    const sel = window.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return null;
    const textEl = line.querySelector('.scratch-line__text') || line;
    const range = sel.getRangeAt(0);
    if (range.startContainer !== textEl && !textEl.contains(range.startContainer)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(textEl);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().replace(/\u00a0/g, ' ').length;
  }

  /**
   * @param {HTMLElement} line
   * @param {string} text
   */
  function setLineText(line, text) {
    const span = line.querySelector('.scratch-line__text');
    if (span) {
      span.textContent = text;
      if (!text) span.append(document.createElement('br'));
      return;
    }
    if (text) line.textContent = text;
    else {
      line.replaceChildren();
      line.append(document.createElement('br'));
    }
  }

  /**
   * Drop check/bullet formatting on a line, keeping its text.
   * @param {HTMLElement} line
   * @param {{ focus?: 'start' | 'end' }} [opts]
   * @returns {HTMLElement}
   */
  function exitListFormatting(line, opts = {}) {
    const text = lineText(line);
    const prev = pendingDeletes.get(line);
    if (prev) {
      clearTimeout(prev);
      pendingDeletes.delete(line);
    }
    const plain = makePlainLine(text);
    line.replaceWith(plain);
    if (opts.focus === 'end') focusLineEnd(plain);
    else focusLineStart(plain);
    return plain;
  }

  async function hydrateFromServer() {
    try {
      const r = await fetch('/api/daily-scratch', { cache: 'no-store' });
      const data = await r.json();
      if (!data?.ok || !data?.note) {
        hydrated = true;
        if (dirty || state.content) void persistServer();
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
      // Only push a local draft when we have never acked the server (or are dirty — handled above).
      // After a successful sync, server always wins so idle tabs cannot clobber phone/desktop peers.
      const preferLocal =
        ackContent === null &&
        Boolean(state.content) &&
        state.content !== serverContent &&
        (!serverContent || (localUpdated && serverUpdated && localUpdated > serverUpdated));
      if (preferLocal) {
        hydrated = true;
        void persistServer();
        return;
      }
      const contentChanged = serverContent !== state.content;
      state = {
        ...state,
        content: serverContent,
        updatedAt: serverUpdated || state.updatedAt || '',
      };
      ackContent = serverContent;
      persistLocal();
      if (contentChanged) applyContent();
    } catch {
      // offline — keep the local draft
    } finally {
      hydrated = true;
      if (dirty) void persistServer();
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      flushSave();
      return;
    }
    void hydrateFromServer();
  }

  function startPullLoop() {
    if (pullTimer) return;
    pullTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (dirty || document.activeElement === editor || editor.contains(document.activeElement)) {
        return;
      }
      void hydrateFromServer();
    }, PULL_WHILE_VISIBLE_MS);
  }

  applyContent();

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
    if (e.isComposing) return;
    const line = e.target instanceof Node ? lineFromNode(e.target) : lineFromNode(window.getSelection()?.anchorNode ?? null);
    if (!line) return;
    const isList =
      line.classList.contains('scratch-line--check') || line.classList.contains('scratch-line--bullet');
    if (!isList) return;

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const text = lineText(line);
      const offset = caretOffsetInLine(line);
      const at = offset == null ? text.length : offset;
      // Empty checklist/bullet line → leave list mode (plain line).
      if (!text.trim()) {
        exitListFormatting(line, { focus: 'end' });
        syncFromEditor();
        return;
      }
      const before = text.slice(0, at);
      const after = text.slice(at);
      setLineText(line, before);
      const next = line.classList.contains('scratch-line--check')
        ? makeCheckLine(after, false)
        : makeBulletLine(after);
      line.after(next);
      focusLineStart(next);
      syncFromEditor();
      return;
    }

    // Backspace at the start of a check/bullet line erases the marker and
    // exits list formatting for that line (text is kept).
    if (e.key === 'Backspace' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const offset = caretOffsetInLine(line);
      if (offset !== 0) return;
      e.preventDefault();
      exitListFormatting(line, { focus: 'start' });
      syncFromEditor();
    }
  });

  editor.addEventListener('blur', () => flushSave());

  if (syncChannel) {
    syncChannel.addEventListener('message', (ev) => {
      const msg = ev?.data;
      if (!msg || msg.type !== 'scratch-updated') return;
      if (dirty) return;
      const peerContent = typeof msg.content === 'string' ? msg.content : null;
      if (peerContent == null || peerContent === state.content) return;
      state = {
        ...state,
        content: peerContent,
        updatedAt: String(msg.updatedAt || state.updatedAt || ''),
      };
      ackContent = peerContent;
      persistLocal();
      applyContent();
    });
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  startPullLoop();

  void hydrateFromServer();

  return {
    editor,
    tools,
    getState: () => state,
    isDirty: () => dirty,
    /**
     * @param {Partial<import('./daily-scratch-storage.js').DailyScratchState>} partial
     */
    patchState(partial) {
      state = { ...state, ...partial };
    },
    persistLocal,
    flushSave,
    applyContent,
    hydrateFromServer,
    focus() {
      editor.focus();
    },
  };
}
