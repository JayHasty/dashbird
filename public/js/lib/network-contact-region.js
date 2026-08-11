/** Derived region bucket for contact location (not stored on the card). */
export const CONTACT_REGION_IN_BAY = 'Is in Bay Area';
export const CONTACT_REGION_OUT = 'Out of Bay Area';

/** @type {ReadonlyArray<string>} */
const BAY_AREA_CITY_NAMES = Object.freeze([
  'San Francisco',
  'Oakland',
  'Emeryville',
  'Berkeley',
  'Alameda',
  'Albany',
  'Piedmont',
  'San Leandro',
  'Daly City',
  'South San Francisco',
  'Richmond',
  'El Cerrito',
  'Orinda',
  'Lafayette',
  'Walnut Creek',
  'Hayward',
  'Fremont',
  'Mountain View',
  'Palo Alto',
  'Redwood City',
  'San Mateo',
  'Burlingame',
  'Millbrae',
  'Sausalito',
  'Marin City',
  'San Rafael',
  'Concord',
  'Pleasanton',
  'Livermore',
  'San Jose',
  'Santa Clara',
  'Sunnyvale',
  'Cupertino',
  'Menlo Park',
  'Pacifica',
  'Half Moon Bay',
  'Vallejo',
  'Napa',
  'Bolinas',
  'Delta',
  'Petaluma',
  'Martinez',
  'Canyon',
  'China Camp',
]);

/**
 * @param {string | null | undefined} s
 * @returns {string}
 */
function normalizeCityName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bst\b/g, 'saint')
    .replace(/\bsf\b/g, 'san francisco')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @param {string | null | undefined} location
 * @returns {boolean}
 */
export function isContactInBayArea(location) {
  const raw = String(location || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (lower === 'out of town') return false;
  if (lower.includes('bay area')) return true;

  const n = normalizeCityName(raw);
  if (!n) return false;
  return BAY_AREA_CITY_NAMES.some((city) => {
    const h = normalizeCityName(city);
    return n === h || n.includes(h) || h.includes(n);
  });
}

/**
 * @param {object | null | undefined} contact
 * @returns {string}
 */
export function contactRegionAttribute(contact) {
  const loc = String(contact?.location || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!loc) return '';
  return isContactInBayArea(loc) ? CONTACT_REGION_IN_BAY : CONTACT_REGION_OUT;
}
