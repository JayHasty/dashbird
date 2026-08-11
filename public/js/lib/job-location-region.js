/**
 * Metro buckets for Opportunity Watch location filters.
 * Keep in sync with `src/lib/job-watch-detail.js` LOCATION_REGIONS.
 * @type {ReadonlyArray<{ region: string, re: RegExp }>}
 */
const LOCATION_REGIONS = Object.freeze([
  {
    region: 'Bay Area',
    re: /\b(san francisco|oakland|emeryville|mountain view|sunnyvale|san jose|san bruno|palo alto|bay area|berkeley|menlo park|redwood city|cupertino|santa clara|san mateo|foster city|milpitas|fremont|daly city|south san francisco)\b/i,
  },
  {
    region: 'NYC Area',
    re: /\b(new york city|new york|nyc|brooklyn|manhattan|queens|the bronx|staten island)\b/i,
  },
  {
    region: 'DC Area',
    re: /\b(reston|arlington|alexandria|mclean|tysons|washington,?\s*d\.?c\.?|district of columbia)\b/i,
  },
  {
    region: 'Remote',
    re: /\b(remote|home[-\s]?based)\b/i,
  },
]);

const PLACE_JUNK =
  /^(united states of america|united states|usa|u\.s\.a\.|u\.s\.|us|united kingdom|great britain|england|scotland|wales|uk|canada|germany|france|india|japan|australia|ireland|netherlands|switzerland|california|ca|new york|ny|washington|wa|virginia|va|massachusetts|ma|texas|tx|colorado|co|illinois|il|oregon|or)$/i;

/**
 * Collapse a posting location to a region / city for filters.
 * Specific office strings stay on the job card.
 * @param {string} value
 * @returns {string}
 */
export function locationRegion(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  for (const { region, re } of LOCATION_REGIONS) {
    if (re.test(s)) return region;
  }
  const bits = s
    .replace(/\s*[-–—]\s*(remote|hybrid|on[-\s]?site).*$/i, '')
    .split(/[,|/]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !PLACE_JUNK.test(p));
  const city = (bits[0] || s.split(/[,|/]/)[0] || s).replace(/\s+/g, ' ').trim();
  return city;
}

/**
 * @param {string[]} locations
 * @param {(value: string) => boolean} [skip]
 * @returns {string[]}
 */
export function locationRegions(locations, skip) {
  const out = [];
  for (const loc of locations || []) {
    const s = String(loc || '');
    if (skip && skip(s)) continue;
    const region = locationRegion(s);
    if (!region) continue;
    if (!out.some((x) => x.toLowerCase() === region.toLowerCase())) out.push(region);
  }
  return out;
}
