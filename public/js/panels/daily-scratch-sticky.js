/**
 * Floating daily scratch sticky — same chrome as the old DEV NOTES pad,
 * green theme. Highlight text and convert to bullets or checkboxes.
 * Checking a box strikes the row, then deletes it after 5s (uncheck to cancel).
 * Body autosaves to /api/daily-scratch (shared with phone); position/collapse stay local.
 */
import {
  DAILY_SCRATCH_VARIANT_ID,
  mountScratchPad,
} from '../lib/daily-scratch-editor.js';

const NOTE_WIDTH = 240;
const HEADER_HEIGHT = 28;
const VARIANT_ID = DAILY_SCRATCH_VARIANT_ID;

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

  root.append(header, body);

  const pad = mountScratchPad(body, {
    variantId: VARIANT_ID,
    defaultPosition,
    clampPosition,
  });

  function applyLayout() {
    const state = pad.getState();
    root.style.left = `${state.x}px`;
    root.style.top = `${state.y}px`;
    root.style.width = `${NOTE_WIDTH}px`;
    root.classList.toggle('dev-sticky-note--collapsed', state.collapsed);
    body.hidden = state.collapsed;
    header.classList.toggle('dev-sticky-note__header--collapsed', state.collapsed);
    collapseBtn.setAttribute('aria-label', state.collapsed ? 'Expand scratch' : 'Collapse scratch');
    collapseBtn.innerHTML = chevronSvg(state.collapsed);
  }

  applyLayout();

  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nextCollapsed = !pad.getState().collapsed;
    pad.patchState({ collapsed: nextCollapsed });
    pad.persistLocal();
    applyLayout();
    if (!nextCollapsed) void pad.hydrateFromServer();
  });

  collapseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

  dragHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const state = pad.getState();
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
    pad.patchState(pos);
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
    pad.persistLocal();
  }

  dragHandle.addEventListener('pointerup', endDrag);
  dragHandle.addEventListener('pointercancel', endDrag);

  window.addEventListener('pagehide', () => pad.flushSave());
  window.addEventListener('resize', () => {
    const state = pad.getState();
    pad.patchState(clampPosition(state.x, state.y));
    pad.persistLocal();
    applyLayout();
  });
}
