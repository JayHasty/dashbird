import { compareContactLocationLabels } from './network-california-location.js';
import { CONTACT_REGION_IN_BAY } from './network-contact-region.js';

/**
 * Bump when page-load people-filter defaults change so restored session/local
 * state with older empty/old defaults is replaced (in-session changes still persist).
 */
export const PEOPLE_FILTER_DEFAULTS_VERSION = 2;

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

/**
 * Page-load defaults for the People filter bar (desktop + mobile).
 * @returns {{
 *   kinds: string[],
 *   hasTasks: string[],
 *   relationships: string[],
 *   statuses: string[],
 *   locations: string[],
 *   regions: string[],
 *   hidePaused: boolean,
 *   hideFormer: boolean,
 * }}
 */
export function createDefaultPeopleFilters() {
  return {
    kinds: ['friend', 'organizer', 'family'],
    hasTasks: [],
    relationships: ['Family', 'Meta', 'Collaborator', 'Inner Circle', 'Cultivating'],
    statuses: ['Fan', 'Hot', 'Warm'],
    locations: [],
    regions: [CONTACT_REGION_IN_BAY],
    hidePaused: true,
    hideFormer: true,
  };
}
