/** localStorage helpers for floating daily scratch stickies. */

export const DAILY_SCRATCH_STORAGE_PREFIX = 'dashbird-daily-scratch-v1:';

/**
 * @typedef {{ content: string, day: string, x: number, y: number, collapsed: boolean }} DailyScratchState
 */

/** @returns {string} Local YYYY-MM-DD */
export function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {string} variantId
 * @returns {string}
 */
export function dailyScratchStorageKey(variantId) {
  return `${DAILY_SCRATCH_STORAGE_PREFIX}${variantId}`;
}

/**
 * @param {string} variantId
 * @param {() => Pick<DailyScratchState, 'x' | 'y'>} defaultPosition
 * @param {(x: number, y: number) => Pick<DailyScratchState, 'x' | 'y'>} clampPosition
 * @returns {DailyScratchState}
 */
export function loadDailyScratch(variantId, defaultPosition, clampPosition) {
  const day = todayKey();
  try {
    const raw = localStorage.getItem(dailyScratchStorageKey(variantId));
    if (raw) {
      const parsed = JSON.parse(raw);
      const pos = clampPosition(
        Number.isFinite(parsed?.x) ? parsed.x : defaultPosition().x,
        Number.isFinite(parsed?.y) ? parsed.y : defaultPosition().y,
      );
      const sameDay = parsed?.day === day;
      return {
        content: sameDay && typeof parsed?.content === 'string' ? parsed.content : '',
        day,
        collapsed: Boolean(parsed?.collapsed),
        ...pos,
      };
    }
  } catch {
    // ignore corrupt storage
  }
  return { content: '', day, collapsed: true, ...defaultPosition() };
}

/**
 * @param {string} variantId
 * @param {DailyScratchState} state
 */
export function saveDailyScratch(variantId, state) {
  try {
    localStorage.setItem(
      dailyScratchStorageKey(variantId),
      JSON.stringify({ ...state, day: todayKey() }),
    );
  } catch {
    // ignore quota errors
  }
}
