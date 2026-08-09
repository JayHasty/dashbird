/** Shared view-mode helpers (desktop | mobile). */

export const VIEW_MODE_KEY = 'dashbirdView';

/**
 * Best-effort phone / tablet detection for first visit (before an explicit pick).
 * @returns {boolean}
 */
export function detectMobileDevice() {
  try {
    if (typeof navigator !== 'undefined') {
      const ua = String(navigator.userAgent || '');
      if (/Android|iPhone|iPod|iPad|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
        return true;
      }
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      if (window.matchMedia('(max-width: 820px)').matches) return true;
      if (window.matchMedia('(pointer: coarse) and (max-width: 1024px)').matches) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Phones always get the lean mobile shell (desktop boot on a phone stalls hard
 * on cloud: many parallel assets each paying forward_auth / basic-auth cost).
 * On non-phone UAs, an explicit icon pick wins; otherwise desktop.
 * @returns {'mobile' | 'desktop'}
 */
export function readViewMode() {
  if (detectMobileDevice()) return 'mobile';
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if (v === 'mobile' || v === 'desktop') return v;
  } catch {
    /* ignore */
  }
  return 'desktop';
}

/**
 * @param {'mobile' | 'desktop'} mode
 */
export function writeViewMode(mode) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode === 'mobile' ? 'mobile' : 'desktop');
  } catch {
    /* ignore */
  }
}

export function isMobileView() {
  return readViewMode() === 'mobile';
}
