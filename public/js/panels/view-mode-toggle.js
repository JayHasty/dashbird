import { detectMobileDevice, readViewMode, writeViewMode } from '../lib/view-mode.js';

/**
 * Phone / desktop icons in the topbar. Changing mode reloads so the other
 * boot path never downloads unused panel chunks.
 * @param {HTMLElement | null} root
 */
export function mountViewModeToggle(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('view-mode-toggle');

  const current = readViewMode();
  const phoneUa = detectMobileDevice();

  /**
   * @param {'mobile' | 'desktop'} mode
   * @param {string} label
   * @param {string} svgHtml
   */
  function makeBtn(mode, label, svgHtml) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'view-mode-toggle__btn';
    btn.classList.toggle('view-mode-toggle__btn--active', current === mode);
    btn.setAttribute('aria-pressed', current === mode ? 'true' : 'false');
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.innerHTML = svgHtml;
    btn.addEventListener('click', () => {
      if (readViewMode() === mode) return;
      // Desktop layout on a phone UA overloads cloud auth; keep phone on mobile.
      if (phoneUa && mode === 'desktop') return;
      writeViewMode(mode);
      location.reload();
    });
    return btn;
  }

  const phoneSvg =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ' +
    'd="M8 2.75h8a1.75 1.75 0 0 1 1.75 1.75v15a1.75 1.75 0 0 1-1.75 1.75H8A1.75 1.75 0 0 1 6.25 19.5v-15A1.75 1.75 0 0 1 8 2.75z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" d="M10.5 18.25h3"/>' +
    '</svg>';

  const desktopSvg =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ' +
    'd="M4.5 5.5h15A1.5 1.5 0 0 1 21 7v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5V7a1.5 1.5 0 0 1 1.5-1.5z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" d="M8 20.5h8M12 17v3.5"/>' +
    '</svg>';

  if (phoneUa) {
    root.append(makeBtn('mobile', 'Mobile view', phoneSvg));
  } else {
    root.append(
      makeBtn('desktop', 'View desktop', desktopSvg),
      makeBtn('mobile', 'View mobile', phoneSvg),
    );
  }
}
