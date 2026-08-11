/**
 * Mobile daily scratch — FAB + bottom sheet (same store as desktop sticky).
 */
import { DAILY_SCRATCH_VARIANT_ID, mountScratchPad } from '../lib/daily-scratch-editor.js';

function defaultPosition() {
  return { x: 24, y: 96 };
}

/**
 * Preserve stored desktop layout; do not clamp against the phone viewport.
 * @param {number} x
 * @param {number} y
 */
function clampPosition(x, y) {
  return {
    x: Number.isFinite(x) ? x : 24,
    y: Number.isFinite(y) ? y : 96,
  };
}

/**
 * Mount floating scratch entry on mobile shell.
 */
export function mountDailyScratchMobile() {
  if (document.getElementById('dashbird-daily-scratch-mobile')) return;

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.id = 'dashbird-daily-scratch-mobile';
  fab.className = 'daily-scratch-mobile-fab';
  fab.setAttribute('aria-label', 'Open scratch pad');
  fab.textContent = 'Scratch';

  const backdrop = document.createElement('div');
  backdrop.className = 'daily-scratch-mobile-backdrop';
  backdrop.hidden = true;

  const sheet = document.createElement('div');
  sheet.className = 'daily-scratch-mobile-sheet';
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Daily scratch');

  const sheetHeader = document.createElement('div');
  sheetHeader.className = 'daily-scratch-mobile-sheet__header';

  const sheetTitle = document.createElement('h2');
  sheetTitle.className = 'daily-scratch-mobile-sheet__title';
  sheetTitle.textContent = 'Scratch';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'daily-scratch-mobile-sheet__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';

  sheetHeader.append(sheetTitle, closeBtn);

  const sheetHint = document.createElement('p');
  sheetHint.className = 'daily-scratch-mobile-sheet__hint';
  sheetHint.textContent = "Today's pad — same as desktop, autosaves.";

  const body = document.createElement('div');
  body.className = 'daily-scratch-mobile-sheet__body';

  sheet.append(sheetHeader, sheetHint, body);
  document.body.append(fab, backdrop, sheet);

  const pad = mountScratchPad(body, {
    variantId: DAILY_SCRATCH_VARIANT_ID,
    defaultPosition,
    clampPosition,
  });
  body.prepend(pad.tools);

  function openSheet() {
    backdrop.hidden = false;
    sheet.hidden = false;
    document.body.classList.add('daily-scratch-mobile-open');
    void pad.hydrateFromServer();
    pad.focus();
  }

  function closeSheet() {
    pad.flushSave();
    backdrop.hidden = true;
    sheet.hidden = true;
    document.body.classList.remove('daily-scratch-mobile-open');
  }

  fab.addEventListener('click', openSheet);
  closeBtn.addEventListener('click', closeSheet);
  backdrop.addEventListener('click', closeSheet);

  window.addEventListener('pagehide', () => pad.flushSave());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pad.flushSave();
  });
}
