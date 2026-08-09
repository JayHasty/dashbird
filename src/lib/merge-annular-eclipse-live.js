/**
 * Annular eclipses are intentionally not shown on the sky strip.
 * Kept as a no-op so older call sites / env docs stay harmless.
 *
 * @param {unknown[]} active
 * @param {Date} [_now]
 * @returns {Promise<unknown[]>}
 */
export async function mergeAnnularEclipseLiveRows(active, _now = new Date()) {
  return Array.isArray(active) ? active : [];
}
