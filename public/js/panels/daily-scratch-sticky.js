/**
 * Floating daily scratch sticky — same chrome as the old DEV NOTES pad,
 * green theme, textarea only (no export / agent features).
 */
import { loadDailyScratch, saveDailyScratch, todayKey } from '../lib/daily-scratch-storage.js';

const NOTE_WIDTH = 240;
const HEADER_HEIGHT = 28;
const VARIANT_ID = 'green';

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

/**
 * Mount once on document.body (fixed overlay).
 */
export function mountDailyScratchSticky() {
  if (document.getElementById('dashbird-daily-scratch')) return;

  /** @type {import('../lib/daily-scratch-storage.js').DailyScratchState} */
  let state = loadDailyScratch(VARIANT_ID, defaultPosition, clampPosition);

  /** @type {{ pointerId: number, startX: number, startY: number, origX: number, origY: number } | null} */
  let drag = null;

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

  const textarea = document.createElement('textarea');
  textarea.className = 'dev-sticky-note__textarea';
  textarea.placeholder = "Today's scratch…";
  textarea.spellcheck = false;

  body.append(textarea);
  root.append(header, body);

  function persist() {
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

  function applyContent() {
    if (textarea.value !== state.content) textarea.value = state.content;
  }

  /** If the calendar day rolled over while the tab stayed open, start fresh. */
  function ensureToday() {
    const day = todayKey();
    if (state.day === day) return;
    state = { ...state, day, content: '' };
    persist();
    applyContent();
  }

  applyLayout();
  applyContent();

  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ensureToday();
    state = { ...state, collapsed: !state.collapsed };
    persist();
    applyLayout();
  });

  collapseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

  textarea.addEventListener('focus', () => ensureToday());

  textarea.addEventListener('input', () => {
    ensureToday();
    state = { ...state, content: textarea.value, day: todayKey() };
    persist();
  });

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
    persist();
  }

  dragHandle.addEventListener('pointerup', endDrag);
  dragHandle.addEventListener('pointercancel', endDrag);

  window.addEventListener('pagehide', () => persist());
  window.addEventListener('resize', () => {
    state = { ...state, ...clampPosition(state.x, state.y) };
    persist();
    applyLayout();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ensureToday();
  });
}
