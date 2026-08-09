/**
 * Kids birth-year helpers (age is derived at display time).
 */

/**
 * @param {unknown} year
 * @param {Date} [now]
 * @returns {number | null}
 */
export function ageFromBirthYear(year, now = new Date()) {
  const y = Number(year);
  if (!Number.isFinite(y) || !Number.isInteger(y)) return null;
  const age = now.getFullYear() - y;
  if (age < 0 || age > 120) return null;
  return age;
}

/**
 * @param {unknown} year
 * @param {Date} [now]
 * @returns {string}
 */
export function formatKidAgeLabel(year, now = new Date()) {
  const age = ageFromBirthYear(year, now);
  if (age == null) return '';
  if (age === 0) return 'under 1';
  if (age === 1) return '1 year old';
  return `${age} years old`;
}

/**
 * @param {unknown} years
 * @returns {number[]}
 */
export function normalizeKidsBirthYears(years) {
  const nowY = new Date().getFullYear();
  const minY = nowY - 120;
  const list = Array.isArray(years)
    ? years
    : String(years || '')
        .split(/[,;\s]+/)
        .filter(Boolean);
  /** @type {number[]} */
  const out = [];
  for (const raw of list) {
    const y = Number(raw);
    if (!Number.isFinite(y) || !Number.isInteger(y)) continue;
    if (y < minY || y > nowY) continue;
    if (!out.includes(y)) out.push(y);
  }
  out.sort((a, b) => b - a);
  return out.slice(0, 20);
}
