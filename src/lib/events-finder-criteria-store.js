/**
 * Events finder taste + feed filters (Look for / grey skip / blacklist + ZIP / distance / date-time).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSkippedEventsFromStore,
  mergeHiddenIdsIntoSkipped,
  normalizeSkippedEvents,
  removeSkippedEventsFromStore,
  resolveUnskipRecordIds,
  skippedEventIds,
  syncSkippedEventsToStore,
} from './events-finder-skipped.js';
import { rollingLocalDatesForWindowWeeks } from './events-finder-window.js';
import { collectTasteLinesFromSkipRecords, removeTasteLines } from './taste-lines.js';
import { normalizeConferenceWatchlist } from './events-finder-conference-watchlist.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** @typedef {'any' | 'in_person' | 'online'} EventsAttendanceMode */

/** @typedef {{
 *   cities: string[],
 *   maxMiles: number | null,
 *   originZip: string | null,
 *   dateFrom: string | null,
 *   dateTo: string | null,
 *   dates: string[],
 *   earliestLocalTime: string | null,
 *   attendance: EventsAttendanceMode,
 *   showBigEvents: boolean,
 * }} EventsFinderFilters */

/** @typedef {{
 *   url: string,
 *   name: string,
 *   avgEventsPerMonth: number | null,
 *   avgComputedAt: string | null,
 * }} EventsFinderPinnedHost */

/** @typedef {{
 *   maxQueries: number,
 *   maxEventsPerQuery: number,
 *   cacheHours: number,
 *   windowWeeks: 1 | 2 | 3 | 4 | 5,
 *   earliestLocalTime: string | null,
 *   searchQueries: string[],
 *   pinnedHosts: EventsFinderPinnedHost[],
 * }} EventsFinderScrapeBudget */

const DEFAULT_FILTERS = /** @type {EventsFinderFilters} */ ({
  cities: [],
  maxMiles: 25,
  originZip: null,
  dateFrom: null,
  dateTo: null,
  dates: [],
  earliestLocalTime: null,
  // Include online sources (e.g. Multiverse School) unless the user unchecks Online.
  attendance: 'any',
  // Pin producer / festival cards (Burning Man, Climate Week, …) above the catalog.
  showBigEvents: true,
});

/** Defaults for Apify search budget (queries × events / query). */
const DEFAULT_SCRAPE = /** @type {EventsFinderScrapeBudget} */ ({
  maxQueries: 6,
  maxEventsPerQuery: 30,
  cacheHours: 6,
  windowWeeks: 4,
  earliestLocalTime: null,
  searchQueries: ['hack-a-thons', 'climate', 'sustainability'],
  pinnedHosts: [],
});

/** Known group names keyed by facebook path slug (lowercase). */
const KNOWN_PINNED_HOST_NAMES = /** @type {Record<string, string>} */ ({
  sfbayacro: 'SFBay AcroYoga',
  greendrinkssiliconvalley: 'Green Drinks Silicon Valley',
  fairylandoakland: "Children's Fairyland in Oakland, CA",
  athleticplayground: 'Athletic Playground',
  eastbaypermaculture: 'East Bay Permaculture',
  eastbaycommunityspace: 'East Bay Community Space',
  goldenguyalley: 'The Golden Guy',
  bayareacomedynetwork: 'Bay Area Comedy Network',
  burnerevents: 'Burner Events',
  bayareacircus: 'Bay Area Circus',
  babclassifieds: 'Burning Man Classifieds',
  libfestival: 'Lightning in a Bottle',
  bayareacomedyshowcase: 'Bay Area Comedy Showcase',
  brasstax: 'Brass Tax',
  everythingimmersive: 'Everything Immersive',
  sanfranciscoburners: 'San Francisco Burners',
  dorkbotsf: 'dorkbotSF',
  eastbaybikeparty: 'East Bay Bike Party',
  sfiop: 'San Francisco Institute of Possibility',
  '1068110536587565': 'Burning Man Theme Camps',
  '9716795555': 'Survival Research Labs',
  '318196436499494': "Oshan's Event List",
  '408645952626168': 'Burning Man Art Projects',
  '416925721848554': 'Regenerative Changemakers',
  '510events': 'Oakland Parties, Concerts, Undergrounds and Events',
  nerdnitesf: 'Nerd Nite San Francisco',
  notephemerisle: 'Ephemerisle',
});

const DEFAULT_CRITERIA = {
  lookFor:
    'ai\nai and climate\nair pusher\nanniversary\nartificial\nathletic playground\nbirthday\nbombay beach\nbox shop\nburlesque\nburningman\ncampout\ncircus\nclimate\nclimate cocktails\ncomedy\ncommunity\ncrucible\ncuriosities\ndorkbot\nearth day\nequinox\nexistential\nexploratorium\nexpo\nfail night\nfairyland\nfestival\nflea\nfounder dating\nfounder meetup\nfundraiser\ngala\ngood people\ngreen drinks\nguild\nhack-a-thons\ninteractive\njamie de wolf\nmakerfare\nmarket\nmeltdown\nmutant\nneotropolis (producers of wasteland)\nnerd night\nnoisebridge\nobtainium\nobtainium works\noddities\noddity\nomni commons\nopen sauce\noptimism\nphage\nplaya\npotluck\npride\nqueer\nreggae down the river\nretreat\nruckas\nsoiled dove\nsolstice\nstartup\nstreet fair\nsustainability\nthe institute\nthrift\ntiat\ntowne cycles\nUN\nvaudevere\nwasteland weekend',
  /** Grey list: hide only when no Look for line also matches. */
  skip:
    'anything before 11am\nbeach clean up\nbeach cleanups\nconcerts\nhike\nif DJs are the only point of interest\nmarathon\nmeditation\nsound bath',
  /** Blacklist: always hide, even when Look for also matches. */
  blacklist: '',
  filters: { ...DEFAULT_FILTERS, cities: [] },
  scrape: { ...DEFAULT_SCRAPE },
  /** Event ids the user hid from the feed. */
  hiddenEventIds: /** @type {string[]} */ ([]),
  /** Rich skip records (id + url + name/date key) so refreshes/re-scrapes stay suppressed. */
  skippedEvents: /** @type {import('./events-finder-skipped.js').SkippedEventRecord[]} */ ([]),
  /** Event ids the user favorited (heart). */
  favoriteEventIds: /** @type {string[]} */ ([]),
  /** Event ids the user added to Google Calendar. */
  calendarAddedEventIds: /** @type {string[]} */ ([]),
  /** Big conferences / festivals to track with ~2-month heads-up. */
  conferenceWatchlist: /** @type {string[]} */ ([]),
};

export function eventsFinderCriteriaPath(env = process.env) {
  const override = String(env.EVENTS_FINDER_CRITERIA_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/events-finder-criteria.json');
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeTime(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function normalizeMaxMiles(raw) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(100, Math.round(n * 10) / 10);
}

/**
 * @param {unknown} raw
 * @returns {EventsAttendanceMode}
 */
function normalizeAttendance(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (s === 'online' || s === 'virtual') return 'online';
  if (s === 'in_person' || s === 'inperson' || s === 'offline') return 'in_person';
  return 'any';
}

/**
 * @param {unknown} raw
 * @param {boolean} fallback
 * @returns {boolean}
 */
function normalizeBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return true;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false;
  return fallback;
}

/**
 * One idea per line; trim, drop blanks/dupes, sort A→Z (case-insensitive).
 * @param {string} raw
 * @returns {string}
 */
function normalizeKeywordList(raw) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out.join('\n');
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeCities(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const s = String(item || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 80) break;
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeDates(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const d = normalizeDate(item);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
    if (out.length >= 62) break;
  }
  out.sort();
  return out;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeOriginZip(raw) {
  if (raw == null || raw === '') return null;
  const z = String(raw).replace(/\D/g, '');
  return z.length === 5 ? z : null;
}

/**
 * @param {unknown} raw
 * @returns {EventsFinderFilters}
 */
function normalizeFilters(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const dates = normalizeDates(src.dates);
  return {
    cities: normalizeCities(src.cities),
    maxMiles: normalizeMaxMiles(src.maxMiles) ?? DEFAULT_FILTERS.maxMiles,
    originZip: normalizeOriginZip(src.originZip),
    // Individual days take precedence; clear range when dates are set.
    dateFrom: dates.length ? null : normalizeDate(src.dateFrom),
    dateTo: dates.length ? null : normalizeDate(src.dateTo),
    dates,
    earliestLocalTime:
      src.earliestLocalTime === undefined
        ? DEFAULT_FILTERS.earliestLocalTime
        : normalizeTime(src.earliestLocalTime),
    attendance:
      src.attendance === undefined
        ? DEFAULT_FILTERS.attendance
        : normalizeAttendance(src.attendance),
    showBigEvents:
      src.showBigEvents === undefined
        ? DEFAULT_FILTERS.showBigEvents
        : normalizeBool(src.showBigEvents, DEFAULT_FILTERS.showBigEvents),
  };
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function normalizeInt(raw, fallback, min, max) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Extract a stable slug key from a Facebook host line or URL.
 * @param {string} line
 * @returns {string | null}
 */
export function facebookHostSlugKey(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const bare = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (/^groups\//i.test(raw) || /^groups\//i.test(bare)) {
    const slug = bare.replace(/^groups\//i, '').split('/')[0];
    return slug ? `groups/${slug}`.toLowerCase() : null;
  }
  if (/facebook\.com\//i.test(raw) || /^fb\.com\//i.test(bare)) {
    try {
      const href = /^https?:\/\//i.test(raw) ? raw : `https://${bare}`;
      const u = new URL(href);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'groups' && parts[1]) return `groups/${parts[1]}`.toLowerCase();
      if (parts[0] && parts[0] !== 'events') return parts[0].toLowerCase();
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z0-9._-]+$/.test(raw)) return raw.toLowerCase();
  return null;
}

/**
 * Canonical display URL for a pinned host line.
 * @param {string} line
 * @returns {string}
 */
export function normalizeFacebookHostUrl(line) {
  const raw = String(line || '').trim();
  if (!raw) return '';
  const bare = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (/^groups\//i.test(raw) || /^groups\//i.test(bare)) {
    const slug = bare.replace(/^groups\//i, '').split('/')[0];
    return slug ? `https://www.facebook.com/groups/${slug}` : '';
  }
  if (/facebook\.com\//i.test(raw) || /^fb\.com\//i.test(bare)) {
    try {
      const href = /^https?:\/\//i.test(raw) ? raw : `https://${bare}`;
      const u = new URL(href);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'groups' && parts[1]) {
        return `https://www.facebook.com/groups/${parts[1]}`;
      }
      if (parts[0] === 'events' && parts[1] && /^\d+$/.test(parts[1])) {
        return `https://www.facebook.com/events/${parts[1]}`;
      }
      if (parts[0] && parts[0] !== 'events') {
        return `https://www.facebook.com/${parts[0]}`;
      }
    } catch {
      return raw.slice(0, 300);
    }
  }
  if (/^[A-Za-z0-9._-]+$/.test(raw)) return `https://www.facebook.com/${raw}`;
  return raw.slice(0, 300);
}

/**
 * @param {string} url
 * @param {string} [name]
 * @returns {string}
 */
function defaultPinnedHostName(url, name) {
  const explicit = String(name || '').trim().slice(0, 120);
  if (explicit) return explicit;
  const key = facebookHostSlugKey(url);
  if (key) {
    const slug = key.replace(/^groups\//, '');
    if (KNOWN_PINNED_HOST_NAMES[slug]) return KNOWN_PINNED_HOST_NAMES[slug];
    if (KNOWN_PINNED_HOST_NAMES[key]) return KNOWN_PINNED_HOST_NAMES[key];
    return slug;
  }
  return 'Facebook host';
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function normalizeAvgEventsPerMonth(raw) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(500, Math.round(n * 10) / 10);
}

/**
 * @param {unknown} raw
 * @returns {EventsFinderPinnedHost[]}
 */
export function normalizePinnedHosts(raw) {
  /** @type {EventsFinderPinnedHost[]} */
  const out = [];
  const seen = new Set();

  /**
   * @param {string} urlRaw
   * @param {string} [nameRaw]
   * @param {unknown} [avgRaw]
   * @param {unknown} [avgAtRaw]
   */
  function pushHost(urlRaw, nameRaw, avgRaw, avgAtRaw) {
    const url = normalizeFacebookHostUrl(urlRaw);
    if (!url) return;
    const key = (facebookHostSlugKey(url) || url).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const avgAt = String(avgAtRaw || '').trim();
    out.push({
      url,
      name: defaultPinnedHostName(url, nameRaw),
      avgEventsPerMonth: normalizeAvgEventsPerMonth(avgRaw),
      avgComputedAt:
        avgAt && Number.isFinite(Date.parse(avgAt)) ? new Date(avgAt).toISOString() : null,
    });
  }

  if (typeof raw === 'string') {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const pipe = trimmed.split('|').map((s) => s.trim());
      if (pipe.length >= 2 && /facebook\.com|groups\//i.test(pipe[pipe.length - 1])) {
        pushHost(pipe[pipe.length - 1], pipe.slice(0, -1).join(' | '));
      } else if (pipe.length >= 2 && /facebook\.com|groups\//i.test(pipe[0])) {
        pushHost(pipe[0], pipe.slice(1).join(' | '));
      } else {
        pushHost(trimmed);
      }
      if (out.length >= 50) break;
    }
    return out;
  }

  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item === 'string') {
      pushHost(item);
    } else if (item && typeof item === 'object') {
      const rec = /** @type {Record<string, unknown>} */ (item);
      pushHost(
        String(rec.url || rec.href || rec.host || ''),
        String(rec.name || rec.title || ''),
        rec.avgEventsPerMonth,
        rec.avgComputedAt,
      );
    }
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeSearchQueries(raw) {
  /** @type {string[]} */
  const lines = [];
  if (typeof raw === 'string') {
    for (const line of raw.split(/\r?\n/)) {
      const s = line.replace(/#.*$/, '').trim();
      if (s) lines.push(s.slice(0, 120));
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      const s = String(item || '')
        .replace(/#.*$/, '')
        .trim()
        .slice(0, 120);
      if (s) lines.push(s);
    }
  }
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    // Match buildFacebookSearchQueries / maxQueries hard cap (24).
    if (out.length >= 24) break;
  }
  return out;
}

/**
 * Seed paid Facebook searches from Look for when searchQueries was never set
 * (legacy criteria only stored lookFor + maxQueries).
 * @param {string} lookFor
 * @param {number} maxQueries
 * @returns {string[]}
 */
function seedSearchQueriesFromLookFor(lookFor, maxQueries) {
  const n = Math.min(Math.max(Number(maxQueries) || 6, 1), 24);
  return normalizeSearchQueries(
    String(lookFor || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, n),
  );
}

/**
 * @param {unknown} raw
 * @returns {1 | 2 | 3 | 4 | 5}
 */
function normalizeWindowWeeks(raw) {
  const n = normalizeInt(raw, DEFAULT_SCRAPE.windowWeeks, 1, 5);
  return /** @type {1 | 2 | 3 | 4 | 5} */ (n);
}

/**
 * @param {unknown} raw
 * @param {{ lookFor?: string }} [ctx]
 * @returns {EventsFinderScrapeBudget}
 */
function normalizeScrape(raw, ctx = {}) {
  const src = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const maxQueries = normalizeInt(src.maxQueries, DEFAULT_SCRAPE.maxQueries, 1, 24);
  let searchQueries;
  if (src.searchQueries === undefined) {
    // Migrate: first N Look for lines used to be the paid Apify searches.
    searchQueries = seedSearchQueriesFromLookFor(ctx.lookFor || '', maxQueries);
    if (!searchQueries.length) searchQueries = [...DEFAULT_SCRAPE.searchQueries];
  } else {
    searchQueries = normalizeSearchQueries(src.searchQueries);
  }
  return {
    maxQueries,
    maxEventsPerQuery: normalizeInt(
      src.maxEventsPerQuery,
      DEFAULT_SCRAPE.maxEventsPerQuery,
      1,
      200,
    ),
    cacheHours: normalizeInt(src.cacheHours, DEFAULT_SCRAPE.cacheHours, 1, 168),
    windowWeeks: normalizeWindowWeeks(
      src.windowWeeks === undefined ? DEFAULT_SCRAPE.windowWeeks : src.windowWeeks,
    ),
    earliestLocalTime:
      src.earliestLocalTime === undefined
        ? DEFAULT_SCRAPE.earliestLocalTime
        : normalizeTime(src.earliestLocalTime),
    searchQueries,
    pinnedHosts: normalizePinnedHosts(
      src.pinnedHosts === undefined ? DEFAULT_SCRAPE.pinnedHosts : src.pinnedHosts,
    ),
  };
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeHiddenEventIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item || '').trim();
    if (!id || id.length > 400) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 1000) break;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{
 *   lookFor: string,
 *   skip: string,
 *   blacklist: string,
 *   filters: EventsFinderFilters,
 *   scrape: EventsFinderScrapeBudget,
 *   hiddenEventIds: string[],
 *   skippedEvents: import('./events-finder-skipped.js').SkippedEventRecord[],
 *   favoriteEventIds: string[],
 *   calendarAddedEventIds: string[],
 *   conferenceWatchlist: string[],
 * }}
 */
function normalize(raw) {
  const lookFor = normalizeKeywordList(
    raw && typeof raw === 'object' && typeof /** @type {{ lookFor?: unknown }} */ (raw).lookFor === 'string'
      ? /** @type {{ lookFor: string }} */ (raw).lookFor
      : DEFAULT_CRITERIA.lookFor,
  );
  const skip = normalizeKeywordList(
    raw && typeof raw === 'object' && typeof /** @type {{ skip?: unknown }} */ (raw).skip === 'string'
      ? /** @type {{ skip: string }} */ (raw).skip
      : DEFAULT_CRITERIA.skip,
  );
  const blacklist = normalizeKeywordList(
    raw && typeof raw === 'object' && typeof /** @type {{ blacklist?: unknown }} */ (raw).blacklist === 'string'
      ? /** @type {{ blacklist: string }} */ (raw).blacklist
      : DEFAULT_CRITERIA.blacklist,
  );
  const filters =
    raw && typeof raw === 'object' && 'filters' in /** @type {object} */ (raw)
      ? normalizeFilters(/** @type {{ filters?: unknown }} */ (raw).filters)
      : { ...DEFAULT_FILTERS, cities: [...DEFAULT_FILTERS.cities] };
  const scrape =
    raw && typeof raw === 'object' && 'scrape' in /** @type {object} */ (raw)
      ? normalizeScrape(/** @type {{ scrape?: unknown }} */ (raw).scrape, { lookFor })
      : { ...DEFAULT_SCRAPE, searchQueries: [...DEFAULT_SCRAPE.searchQueries] };
  const hiddenEventIdsRaw =
    raw && typeof raw === 'object' && 'hiddenEventIds' in /** @type {object} */ (raw)
      ? /** @type {{ hiddenEventIds?: unknown }} */ (raw).hiddenEventIds
      : [];
  const skippedRaw =
    raw && typeof raw === 'object' && 'skippedEvents' in /** @type {object} */ (raw)
      ? /** @type {{ skippedEvents?: unknown }} */ (raw).skippedEvents
      : [];
  const skippedEvents = mergeHiddenIdsIntoSkipped(normalizeSkippedEvents(skippedRaw), hiddenEventIdsRaw);
  const hiddenEventIds = skippedEventIds(skippedEvents);
  const favoriteEventIds =
    raw && typeof raw === 'object' && 'favoriteEventIds' in /** @type {object} */ (raw)
      ? normalizeHiddenEventIds(/** @type {{ favoriteEventIds?: unknown }} */ (raw).favoriteEventIds)
      : [];
  const calendarAddedEventIds =
    raw && typeof raw === 'object' && 'calendarAddedEventIds' in /** @type {object} */ (raw)
      ? normalizeHiddenEventIds(
          /** @type {{ calendarAddedEventIds?: unknown }} */ (raw).calendarAddedEventIds,
        )
      : [];
  const conferenceWatchlist =
    raw && typeof raw === 'object' && 'conferenceWatchlist' in /** @type {object} */ (raw)
      ? normalizeConferenceWatchlist(
          /** @type {{ conferenceWatchlist?: unknown }} */ (raw).conferenceWatchlist,
        )
      : [];
  return {
    lookFor,
    skip,
    blacklist,
    filters,
    scrape,
    hiddenEventIds,
    skippedEvents,
    favoriteEventIds,
    calendarAddedEventIds,
    conferenceWatchlist,
  };
}

async function ensureFile() {
  const live = eventsFinderCriteriaPath();
  try {
    await fs.access(live);
    return live;
  } catch {
    await fs.mkdir(path.dirname(live), { recursive: true });
    await fs.writeFile(live, `${JSON.stringify(DEFAULT_CRITERIA, null, 2)}\n`, 'utf8');
    return live;
  }
}

/**
 * @returns {Promise<{
 *   lookFor: string,
 *   skip: string,
 *   blacklist: string,
 *   filters: EventsFinderFilters,
 *   scrape: EventsFinderScrapeBudget,
 *   hiddenEventIds: string[],
 *   skippedEvents: import('./events-finder-skipped.js').SkippedEventRecord[],
 *   favoriteEventIds: string[],
 *   calendarAddedEventIds: string[],
 *   conferenceWatchlist: string[],
 * }>}
 */
export async function loadEventsFinderCriteria() {
  const live = await ensureFile();
  /** @type {ReturnType<typeof normalize>} */
  let base;
  try {
    const j = JSON.parse(await fs.readFile(live, 'utf8'));
    base = normalize(j);
  } catch {
    base = {
      lookFor: DEFAULT_CRITERIA.lookFor,
      skip: DEFAULT_CRITERIA.skip,
      blacklist: DEFAULT_CRITERIA.blacklist,
      filters: { ...DEFAULT_FILTERS, cities: [] },
      scrape: { ...DEFAULT_SCRAPE },
      hiddenEventIds: [],
      skippedEvents: [],
      favoriteEventIds: [],
      calendarAddedEventIds: [],
      conferenceWatchlist: [],
    };
  }
  // SQLite is authoritative for skips (survives filter-only criteria saves).
  const skippedEvents = loadSkippedEventsFromStore(base.skippedEvents, process.env);
  return {
    ...base,
    skippedEvents,
    hiddenEventIds: skippedEventIds(skippedEvents),
  };
}

/**
 * @param {{
 *   lookFor?: unknown,
 *   skip?: unknown,
 *   blacklist?: unknown,
 *   filters?: unknown,
 *   scrape?: unknown,
 *   hiddenEventIds?: unknown,
 *   skippedEvents?: unknown,
 *   unskipEventIds?: unknown,
 *   favoriteEventIds?: unknown,
 *   calendarAddedEventIds?: unknown,
 *   conferenceWatchlist?: unknown,
 * }} body
 * @returns {Promise<
 *   | {
 *       ok: true,
 *       lookFor: string,
 *       skip: string,
 *       blacklist: string,
 *       filters: EventsFinderFilters,
 *       scrape: EventsFinderScrapeBudget,
 *       hiddenEventIds: string[],
 *       skippedEvents: import('./events-finder-skipped.js').SkippedEventRecord[],
 *       favoriteEventIds: string[],
 *       calendarAddedEventIds: string[],
 *       conferenceWatchlist: string[],
 *     }
 *   | { ok: false, error: string }
 * >}
 */
export async function saveEventsFinderCriteria(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid_body' };
  }
  if (typeof body.lookFor !== 'string' || typeof body.skip !== 'string') {
    return { ok: false, error: 'invalid_fields' };
  }
  if (body.blacklist !== undefined && typeof body.blacklist !== 'string') {
    return { ok: false, error: 'invalid_fields' };
  }
  if (
    body.lookFor.length > 20000
    || body.skip.length > 20000
    || (typeof body.blacklist === 'string' && body.blacklist.length > 20000)
  ) {
    return { ok: false, error: 'too_long' };
  }
  const existing = await loadEventsFinderCriteria();
  let skippedEvents = existing.skippedEvents;
  const unskipIds = Array.isArray(body.unskipEventIds)
    ? body.unskipEventIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  /** @type {{ lookFor: string[], grey: string[], black: string[] }} */
  let unskipTaste = { lookFor: [], grey: [], black: [] };
  if (unskipIds.length) {
    const existingSkipped = loadSkippedEventsFromStore(existing.skippedEvents, process.env);
    const resolvedIds = new Set(resolveUnskipRecordIds(unskipIds, process.env));
    const toRemove = existingSkipped.filter(
      (s) => resolvedIds.has(s.id) || unskipIds.includes(s.id),
    );
    unskipTaste = collectTasteLinesFromSkipRecords(toRemove);
    // Explicit Unskip — delete by id only; never infer removals from a partial list.
    skippedEvents = removeSkippedEventsFromStore(unskipIds, process.env);
  }
  if (body.skippedEvents !== undefined) {
    // Skip / thumbs-down — upsert into SQLite. Partial client lists must not wipe others.
    skippedEvents = syncSkippedEventsToStore(
      normalizeSkippedEvents(body.skippedEvents),
      process.env,
    );
  } else if (body.hiddenEventIds !== undefined && !unskipIds.length) {
    // Legacy clients may only send ids — upsert missing ids; do not delete others.
    const wantIds = normalizeHiddenEventIds(body.hiddenEventIds);
    const toAdd = wantIds
      .filter((id) => !skippedEvents.some((s) => s.id === id))
      .map((id) => ({
        id,
        key: null,
        url: null,
        title: null,
        start: null,
        source: null,
        venue: null,
        city: null,
        imageUrl: null,
        skippedAt: new Date().toISOString(),
      }));
    if (toAdd.length) {
      skippedEvents = syncSkippedEventsToStore(
        normalizeSkippedEvents([...skippedEvents, ...toAdd]),
        process.env,
      );
    } else {
      skippedEvents = loadSkippedEventsFromStore(existing.skippedEvents, process.env);
    }
  } else if (!unskipIds.length) {
    // Filter-only save: never touch skips (SQLite + existing criteria).
    skippedEvents = loadSkippedEventsFromStore(existing.skippedEvents, process.env);
  }
  let lookFor = normalizeKeywordList(body.lookFor);
  let skip = normalizeKeywordList(body.skip);
  // Omit blacklist to preserve (filter-only / thumbs / Facebook avg saves).
  let blacklist =
    typeof body.blacklist === 'string'
      ? normalizeKeywordList(body.blacklist)
      : existing.blacklist;
  if (unskipIds.length) {
    lookFor = removeTasteLines(lookFor, unskipTaste.lookFor);
    skip = removeTasteLines(skip, unskipTaste.grey);
    blacklist = removeTasteLines(blacklist, unskipTaste.black);
  }
  // Ingestion-only saves omit filters; browse-filter saves omit scrape — preserve the other.
  const nextScrape = body.scrape === undefined
    ? existing.scrape
    : normalizeScrape(body.scrape, { lookFor });
  let nextFilters =
    body.filters === undefined ? existing.filters : normalizeFilters(body.filters);

  // Scrape ahead is the dynamic horizon: when weeks change, roll the browse
  // calendar to match (unless the client sent an explicit dates list in this PUT).
  const weeksChanged =
    body.scrape !== undefined
    && Number(nextScrape.windowWeeks) !== Number(existing.scrape?.windowWeeks);
  const clientSentDates =
    body.filters
    && typeof body.filters === 'object'
    && (Array.isArray(/** @type {Record<string, unknown>} */ (body.filters).dates)
      || /** @type {Record<string, unknown>} */ (body.filters).dateFrom != null
      || /** @type {Record<string, unknown>} */ (body.filters).dateTo != null);
  if (weeksChanged && !clientSentDates) {
    nextFilters = {
      ...nextFilters,
      dates: rollingLocalDatesForWindowWeeks(nextScrape.windowWeeks),
      dateFrom: null,
      dateTo: null,
    };
  }

  const next = {
    lookFor,
    skip,
    blacklist,
    filters: nextFilters,
    scrape: nextScrape,
    skippedEvents,
    hiddenEventIds: skippedEventIds(skippedEvents),
    favoriteEventIds:
      body.favoriteEventIds === undefined
        ? existing.favoriteEventIds
        : normalizeHiddenEventIds(body.favoriteEventIds),
    calendarAddedEventIds:
      body.calendarAddedEventIds === undefined
        ? existing.calendarAddedEventIds
        : normalizeHiddenEventIds(body.calendarAddedEventIds),
    conferenceWatchlist:
      body.conferenceWatchlist === undefined
        ? existing.conferenceWatchlist
        : normalizeConferenceWatchlist(body.conferenceWatchlist),
  };
  const live = await ensureFile();
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, live);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  return { ok: true, ...next };
}

import { BAY_AREA_HOME_CITIES } from './events-finder-geo.js';

export { DEFAULT_FILTERS, DEFAULT_SCRAPE, BAY_AREA_HOME_CITIES, KNOWN_PINNED_HOST_NAMES };
