/** localStorage helpers for floating daily scratch stickies (layout cache + offline draft). */

export const DAILY_SCRATCH_STORAGE_PREFIX = 'dashbird-daily-scratch-v1:';

/**
 * @typedef {{ content: string, x: number, y: number, collapsed: boolean, updatedAt?: string }} DailyScratchState
 */

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
  try {
    const raw = localStorage.getItem(dailyScratchStorageKey(variantId));
    if (raw) {
      const parsed = JSON.parse(raw);
      const pos = clampPosition(
        Number.isFinite(parsed?.x) ? parsed.x : defaultPosition().x,
        Number.isFinite(parsed?.y) ? parsed.y : defaultPosition().y,
      );
      return {
        content: typeof parsed?.content === 'string' ? parsed.content : '',
        collapsed: Boolean(parsed?.collapsed),
        updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '',
        ...pos,
      };
    }
  } catch {
    // ignore corrupt storage
  }
  return { content: '', collapsed: true, updatedAt: '', ...defaultPosition() };
}

/**
 * @param {string} variantId
 * @param {DailyScratchState} state
 */
export function saveDailyScratch(variantId, state) {
  try {
    localStorage.setItem(dailyScratchStorageKey(variantId), JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}
