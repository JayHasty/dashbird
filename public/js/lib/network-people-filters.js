import { compareContactLocationLabels } from './network-california-location.js';

/**
 * Shared people-list filter helpers (desktop + mobile Network contacts).
 * Location options: California cities first, then everywhere else (A→Z within each group).
 * @param {object[]} list
 * @returns {string[]}
 */
export function collectContactLocationOptions(list = []) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const c of list || []) {
    const loc = String(c?.location || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!loc) continue;
    const key = loc.toLowerCase();
    if (!seen.has(key)) seen.set(key, loc);
  }
  return [...seen.values()].sort(compareContactLocationLabels);
}
