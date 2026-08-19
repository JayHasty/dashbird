/**
 * Planning & logistics helpers for notable / distant events.
 * Uses deep links (no paid travel APIs) + nearest major airport lookup.
 */
import { haversineMiles } from './dashboard-geo.js';
import { BAY_AREA_CITY_COORDS, resolveEventLatLon } from './events-finder-geo.js';
import { scoreEventTaste } from './events-finder-taste.js';

/**
 * @typedef {{
 *   id: string,
 *   text: string,
 *   checked: boolean,
 * }} PackingItem
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   items: PackingItem[],
 * }} PackingCategory
 *
 * @typedef {{
 *   categories: PackingCategory[],
 * }} PackingList
 *
 * @typedef {{
 *   enabled: boolean,
 *   notes: string | null,
 *   destination?: 'accommodations' | 'event' | null,
 * }} LogisticsModuleState
 *
 * @typedef {{
 *   packingList: PackingList | null,
 *   accommodations: string | null,
 *   flightsTransport: string | null,
 *   beforeTrip: string | null,
 *   notes: string | null,
 *   modules: {
 *     local: { notes: string | null },
 *     flights: LogisticsModuleState,
 *     transportation: LogisticsModuleState,
 *     accommodations: LogisticsModuleState,
 *   },
 * }} TripPlanning
 */

const PACKING_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_PACKING_CATEGORIES = 40;
const MAX_PACKING_ITEMS_PER_CATEGORY = 80;
const MAX_PACKING_TEXT = 200;
const MAX_PACKING_CATEGORY_NAME = 80;

/**
 * @param {unknown} raw
 * @param {number} [max]
 * @returns {string | null}
 */
function tripField(raw, max = 4000) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * @returns {string}
 */
function newPackingId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function packingId(raw) {
  const s = String(raw ?? '').trim();
  if (PACKING_ID_RE.test(s)) return s;
  return newPackingId();
}

/**
 * @param {unknown} raw
 * @returns {PackingItem | null}
 */
function normalizePackingItem(raw) {
  if (typeof raw === 'string') {
    const text = tripField(raw, MAX_PACKING_TEXT);
    if (!text) return null;
    return { id: newPackingId(), text, checked: false };
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const text = tripField(r.text ?? r.label ?? r.name, MAX_PACKING_TEXT);
  if (!text) return null;
  return {
    id: packingId(r.id),
    text,
    checked: r.checked === true || r.done === true,
  };
}

/**
 * @param {unknown} raw
 * @returns {PackingCategory | null}
 */
function normalizePackingCategory(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const name = tripField(r.name ?? r.title ?? r.label, MAX_PACKING_CATEGORY_NAME) || 'General';
  const itemsRaw = Array.isArray(r.items) ? r.items : [];
  /** @type {PackingItem[]} */
  const items = [];
  for (const it of itemsRaw) {
    if (items.length >= MAX_PACKING_ITEMS_PER_CATEGORY) break;
    const item = normalizePackingItem(it);
    if (item) items.push(item);
  }
  return {
    id: packingId(r.id),
    name,
    items,
  };
}

/**
 * Migrate legacy newline packing text into a single General category.
 * @param {string} text
 * @returns {PackingList | null}
 */
function packingListFromLegacyText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_PACKING_ITEMS_PER_CATEGORY);
  if (!lines.length) return null;
  return {
    categories: [
      {
        id: newPackingId(),
        name: 'General',
        items: lines.map((line) => {
          const checked = /^\[[xX✓]\]\s*/.test(line);
          const textOnly = line.replace(/^\[[xX✓\s]?\]\s*/, '').trim();
          return {
            id: newPackingId(),
            text: textOnly.slice(0, MAX_PACKING_TEXT) || line.slice(0, MAX_PACKING_TEXT),
            checked,
          };
        }),
      },
    ],
  };
}

/**
 * Structured packing checklist (categories → checkbox items).
 * Accepts legacy plain-text packing lists and migrates them.
 * @param {unknown} raw
 * @returns {PackingList | null}
 */
export function normalizePackingList(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') return packingListFromLegacyText(raw);
  if (typeof raw !== 'object') return null;

  const r = /** @type {Record<string, unknown>} */ (raw);
  const catsRaw = Array.isArray(r.categories)
    ? r.categories
    : Array.isArray(raw)
      ? /** @type {unknown[]} */ (raw)
      : null;
  if (!catsRaw) {
    // Single category-shaped object
    const one = normalizePackingCategory(raw);
    return one ? { categories: [one] } : null;
  }

  /** @type {PackingCategory[]} */
  const categories = [];
  for (const c of catsRaw) {
    if (categories.length >= MAX_PACKING_CATEGORIES) break;
    const cat = normalizePackingCategory(c);
    if (cat) categories.push(cat);
  }
  if (!categories.length) return null;
  return { categories };
}

/**
 * @param {PackingList | null | undefined} pl
 * @returns {boolean}
 */
export function packingListHasContent(pl) {
  if (!pl || typeof pl !== 'object' || !Array.isArray(pl.categories)) return false;
  return pl.categories.some(
    (c) =>
      (Array.isArray(c.items) && c.items.length > 0)
      || Boolean(String(c.name || '').trim()),
  );
}

/**
 * Plain-text dump for legacy notes / badges.
 * @param {PackingList | null | undefined} pl
 * @returns {string | null}
 */
export function packingListToPlainText(pl) {
  if (!packingListHasContent(pl)) return null;
  const blocks = [];
  for (const cat of pl.categories) {
    const name = String(cat.name || '').trim() || 'General';
    const lines = (cat.items || []).map((it) => {
      const mark = it.checked ? '[x]' : '[ ]';
      return `${mark} ${it.text}`;
    });
    if (!lines.length) {
      blocks.push(`${name}:`);
      continue;
    }
    blocks.push(`${name}:\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n').slice(0, 4000) || null;
}

/**
 * @param {unknown} raw
 * @param {{ notesFallback?: string | null, enabledFallback?: boolean }} [opts]
 * @returns {LogisticsModuleState}
 */
function normalizeModuleState(raw, opts = {}) {
  const o = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const destRaw = String(o.destination || '').trim().toLowerCase();
  /** @type {'accommodations' | 'event' | null} */
  const destination =
    destRaw === 'accommodations' || destRaw === 'stay' || destRaw === 'stays'
      ? 'accommodations'
      : destRaw === 'event' || destRaw === 'venue'
        ? 'event'
        : null;
  return {
    enabled: o.enabled === true || opts.enabledFallback === true,
    notes: tripField(o.notes, 4000) || tripField(opts.notesFallback, 4000),
    destination,
  };
}

/**
 * Structured trip logistics fields (packing, stays, flights, prep, notes).
 * Falls back to legacy freeform `planningNotes` as Notes when structured notes are empty.
 * @param {unknown} raw
 * @param {string | null | undefined} [legacyPlanningNotes]
 * @returns {TripPlanning}
 */
export function normalizeTripPlanning(raw, legacyPlanningNotes = null) {
  const r = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const notes =
    tripField(r.notes, 4000)
    || tripField(legacyPlanningNotes, 4000)
    || tripField(r.planningNotes, 4000);
  const accommodations = tripField(r.accommodations, 4000);
  const flightsTransport = tripField(r.flightsTransport, 4000);
  const mods =
    r.modules && typeof r.modules === 'object'
      ? /** @type {Record<string, unknown>} */ (r.modules)
      : {};
  const localMod =
    mods.local && typeof mods.local === 'object'
      ? /** @type {Record<string, unknown>} */ (mods.local)
      : {};
  return {
    packingList: normalizePackingList(r.packingList),
    accommodations,
    flightsTransport,
    beforeTrip: tripField(r.beforeTrip, 4000),
    notes,
    modules: {
      local: { notes: tripField(localMod.notes, 4000) },
      flights: normalizeModuleState(mods.flights),
      transportation: normalizeModuleState(mods.transportation, {
        notesFallback: flightsTransport,
      }),
      accommodations: normalizeModuleState(mods.accommodations, {
        notesFallback: accommodations,
      }),
    },
  };
}

/**
 * @param {TripPlanning | null | undefined} tp
 * @returns {boolean}
 */
export function tripPlanningHasContent(tp) {
  if (!tp || typeof tp !== 'object') return false;
  const mods = tp.modules;
  const modNotes =
    mods
    && (mods.local?.notes
      || mods.flights?.notes
      || mods.transportation?.notes
      || mods.accommodations?.notes
      || mods.flights?.enabled
      || mods.transportation?.enabled
      || mods.accommodations?.enabled);
  return Boolean(
    packingListHasContent(tp.packingList)
    || tp.accommodations
    || tp.flightsTransport
    || tp.beforeTrip
    || tp.notes
    || modNotes,
  );
}

/**
 * Compact legacy string for badges / older clients.
 * @param {TripPlanning} tp
 * @returns {string | null}
 */
export function tripPlanningToLegacyNotes(tp) {
  if (!tripPlanningHasContent(tp)) return null;
  const parts = [];
  const packing = packingListToPlainText(tp.packingList);
  if (packing) parts.push(`Packing:\n${packing}`);
  if (tp.accommodations) parts.push(`Accommodations:\n${tp.accommodations}`);
  if (tp.flightsTransport) parts.push(`Flights / transport:\n${tp.flightsTransport}`);
  if (tp.beforeTrip) parts.push(`Before the trip:\n${tp.beforeTrip}`);
  if (tp.notes) parts.push(`Notes:\n${tp.notes}`);
  return parts.join('\n\n').slice(0, 4000);
}

/**
 * Popular platform discover links for a city (no scrape — deep links only).
 * @param {string | null | undefined} city
 * @returns {{ label: string, detail: string, url: string, host: string }[]}
 */
export function suggestAreaEventFeeds(city) {
  const place = String(city || '').trim();
  if (!place) return [];
  const q = encodeURIComponent(place);
  return [
    {
      label: `Meetup · ${place}`,
      detail: 'Popular groups and events near this city.',
      url: `https://www.meetup.com/find/?location=${q}&source=EVENTS`,
      host: 'meetup.com',
    },
    {
      label: `Luma · ${place}`,
      detail: 'Discover city calendars and upcoming Luma events.',
      url: `https://lu.ma/discover?query=${q}`,
      host: 'lu.ma',
    },
    {
      label: `Eventbrite · ${place}`,
      detail: 'Local Eventbrite listings around the trip dates.',
      url: `https://www.eventbrite.com/d/united-states/events/?q=${q}`,
      host: 'eventbrite.com',
    },
    {
      label: `Google · events in ${place}`,
      detail: 'Broad search for festivals, shows, and one-offs.',
      url: `https://www.google.com/search?q=${encodeURIComponent(`events in ${place}`)}`,
      host: 'google.com',
    },
  ];
}

/**
 * Fold city names for soft equality (SF ≈ San Francisco is not handled — substring only).
 * @param {unknown} a
 * @param {unknown} b
 */
function sameCity(a, b) {
  const na = String(a || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const nb = String(b || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * @param {number} ms
 * @returns {'before' | 'during' | 'after' | null}
 */
function classifyTravelWindow(ms, startMs, endMs, beforeMs, afterMs) {
  if (!Number.isFinite(ms) || !Number.isFinite(startMs)) return null;
  const end = Number.isFinite(endMs) && endMs >= startMs ? endMs : startMs + 24 * 60 * 60 * 1000;
  if (ms >= startMs && ms <= end) return 'during';
  if (ms >= beforeMs && ms < startMs) return 'before';
  if (ms > end && ms <= afterMs) return 'after';
  return null;
}

/** Approximate Bay Area centroid (SF downtown). */
export const BAY_AREA_CENTER = Object.freeze({
  name: 'San Francisco Bay Area',
  lat: 37.7749,
  lon: -122.4194,
});

/** Major US international airports (lat/lon centroids). */
export const MAJOR_INTL_AIRPORTS = Object.freeze([
  { code: 'SFO', name: 'San Francisco International', lat: 37.6213, lon: -122.379 },
  { code: 'OAK', name: 'Oakland International', lat: 37.7126, lon: -122.2195 },
  { code: 'SJC', name: 'San Jose Mineta International', lat: 37.3639, lon: -121.9289 },
  { code: 'LAX', name: 'Los Angeles International', lat: 33.9416, lon: -118.4085 },
  { code: 'SAN', name: 'San Diego International', lat: 32.7336, lon: -117.1897 },
  { code: 'SEA', name: 'Seattle-Tacoma International', lat: 47.4502, lon: -122.3088 },
  { code: 'PDX', name: 'Portland International', lat: 45.5898, lon: -122.5951 },
  { code: 'DEN', name: 'Denver International', lat: 39.8561, lon: -104.6737 },
  { code: 'LAS', name: 'Harry Reid International', lat: 36.084, lon: -115.1537 },
  { code: 'PHX', name: 'Phoenix Sky Harbor', lat: 33.4373, lon: -112.0078 },
  { code: 'ORD', name: 'Chicago O\'Hare', lat: 41.9742, lon: -87.9073 },
  { code: 'JFK', name: 'John F. Kennedy International', lat: 40.6413, lon: -73.7781 },
  { code: 'EWR', name: 'Newark Liberty International', lat: 40.6895, lon: -74.1745 },
  { code: 'BOS', name: 'Boston Logan International', lat: 42.3656, lon: -71.0096 },
  { code: 'ATL', name: 'Hartsfield-Jackson Atlanta', lat: 33.6407, lon: -84.4277 },
  { code: 'MIA', name: 'Miami International', lat: 25.7959, lon: -80.287 },
  { code: 'DFW', name: 'Dallas/Fort Worth International', lat: 32.8998, lon: -97.0403 },
  { code: 'IAH', name: 'Houston George Bush Intercontinental', lat: 29.9902, lon: -95.3368 },
  { code: 'MSP', name: 'Minneapolis–Saint Paul International', lat: 44.8848, lon: -93.2223 },
  { code: 'DTW', name: 'Detroit Metro', lat: 42.2162, lon: -83.3554 },
  { code: 'SLC', name: 'Salt Lake City International', lat: 40.7899, lon: -111.9791 },
  { code: 'AUS', name: 'Austin-Bergstrom International', lat: 30.1945, lon: -97.6699 },
  { code: 'BNA', name: 'Nashville International', lat: 36.1263, lon: -86.6774 },
  { code: 'MSY', name: 'Louis Armstrong New Orleans', lat: 29.9934, lon: -90.258 },
  { code: 'RNO', name: 'Reno-Tahoe International', lat: 39.4991, lon: -119.7681 },
  { code: 'BOI', name: 'Boise Airport', lat: 43.5644, lon: -116.2228 },
  { code: 'SMF', name: 'Sacramento International', lat: 38.6954, lon: -121.5908 },
]);

const BAY_AIRPORTS = new Set(['SFO', 'OAK', 'SJC']);

/**
 * @param {number | null | undefined} lat
 * @param {number | null | undefined} lon
 * @returns {number | null}
 */
export function milesFromBayArea(lat, lon) {
  if (lat == null || lon == null || lat === '' || lon === '') return null;
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (Math.abs(la) < 0.01 && Math.abs(lo) < 0.01) return null;
  return haversineMiles(BAY_AREA_CENTER.lat, BAY_AREA_CENTER.lon, la, lo);
}

/**
 * True when the event is more than `thresholdMiles` outside the Bay Area centroid.
 * Also treats known Bay cities within ~60mi as "in Bay" even if centroid distance is high.
 * @param {{ lat?: unknown, lon?: unknown, city?: unknown }} event
 * @param {number} [thresholdMiles]
 */
export function isOutsideBayArea(event, thresholdMiles = 100) {
  const miles = milesFromBayArea(event?.lat, event?.lon);
  if (miles != null) return miles > thresholdMiles;

  const city = String(event?.city || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!city) return false;
  for (const c of BAY_AREA_CITY_COORDS) {
    const name = c.name.toLowerCase();
    if (city === name || city.includes(name) || name.includes(city)) return false;
  }
  // Unknown city with no coords — don't assume travel.
  return false;
}

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {{ code: string, name: string, lat: number, lon: number, miles: number } | null}
 */
export function nearestInternationalAirport(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  let best = null;
  for (const a of MAJOR_INTL_AIRPORTS) {
    const miles = haversineMiles(la, lo, a.lat, a.lon);
    if (!best || miles < best.miles) {
      best = { ...a, miles };
    }
  }
  return best;
}

/**
 * Suggested ground transport from nearest airport to venue.
 * @param {{ code: string, name: string, miles: number }} airport
 * @param {{ lat?: unknown, lon?: unknown, venue?: unknown, city?: unknown }} event
 */
/**
 * Airport → destination deep links.
 * @param {{ code: string, name: string, miles: number }} airport
 * @param {object} event
 * @param {{ kind?: 'accommodations' | 'event' }} [opts]
 */
export function airportTransportOptions(airport, event, opts = {}) {
  const kind = opts.kind === 'accommodations' ? 'accommodations' : 'event';
  const city = String(event?.city || event?.venue || '').trim() || 'destination';
  const eventDest =
    [event?.venue, event?.city].map((s) => String(s || '').trim()).filter(Boolean).join(', ')
    || (Number.isFinite(Number(event?.lat)) && Number.isFinite(Number(event?.lon))
      ? `${event.lat},${event.lon}`
      : city);
  const dest =
    kind === 'accommodations'
      ? `hotels near ${city}`
      : eventDest;
  const destLabel = kind === 'accommodations' ? 'your accommodations' : 'the event';
  const mapsDir = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    `${airport.name} (${airport.code})`,
  )}&destination=${encodeURIComponent(dest)}`;
  const rideshare = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `rideshare from ${airport.code} to ${dest}`,
  )}`;
  /** @type {{ label: string, detail: string, url: string }[]} */
  const options = [
    {
      label: 'Rideshare / taxi',
      detail:
        kind === 'accommodations'
          ? `Door-to-door from ${airport.code} to lodging in ${city}.`
          : `Door-to-door from ${airport.code} (~${Math.round(airport.miles)} mi to venue area).`,
      url: rideshare,
    },
    {
      label: 'Driving directions',
      detail: `Google Maps route from ${airport.code} to ${destLabel}.`,
      url: mapsDir,
    },
    {
      label: 'Public transit',
      detail: `Transit from ${airport.code} toward ${destLabel}.`,
      url: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
        `${airport.name} (${airport.code})`,
      )}&destination=${encodeURIComponent(dest)}&travelmode=transit`,
    },
  ];
  if (airport.code === 'SFO' || airport.code === 'OAK' || airport.code === 'SJC') {
    options.unshift({
      label: 'BART / Caltrain / VTA',
      detail: 'Bay Area rail + local transit from the airport — check schedules for arrival day.',
      url: 'https://www.google.com/maps/travel/flights?tfs=transit',
    });
  } else if (airport.miles <= 15 && kind === 'event') {
    options.unshift({
      label: 'Airport transit / shuttle',
      detail: `Venue is ~${Math.round(airport.miles)} mi from ${airport.code} — local transit or hotel shuttle may work.`,
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${airport.code} airport transit to ${dest}`,
      )}`,
    });
  } else if (kind === 'event' && airport.miles > 15) {
    options.push({
      label: 'Rental car',
      detail: `~${Math.round(airport.miles)} mi from ${airport.code} — rental may be simplest for the area.`,
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `car rental ${airport.code}`,
      )}`,
    });
  } else if (kind === 'accommodations') {
    options.push({
      label: 'Hotel shuttle / airport transfer',
      detail: `Many stays near ${city} offer airport pickups — check your booking.`,
      url: `https://www.google.com/search?q=${encodeURIComponent(
        `${airport.code} hotel shuttle to ${city}`,
      )}`,
    });
  }
  return options;
}

/**
 * @param {string | null | undefined} iso
 * @returns {string} YYYY-MM-DD or empty
 */
function ymd(iso) {
  const d = Date.parse(String(iso || ''));
  if (!Number.isFinite(d)) return '';
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Build deep-link suggestions (no live fare quotes).
 * @param {object} event
 * @param {{
 *   milesFromBay: number | null,
 *   outsideBay: boolean,
 *   nearestAirport: ReturnType<typeof nearestInternationalAirport>,
 * }} geo
 */
export function buildTravelDeepLinks(event, geo) {
  const city = String(event?.city || event?.venue || '').trim() || 'destination';
  const start = ymd(event?.start);
  const end = ymd(event?.end) || start;
  const destQuery = encodeURIComponent(city);

  /** @type {{ label: string, detail: string, url: string }[]} */
  const flights = [];
  /** @type {{ label: string, detail: string, url: string }[]} */
  const stays = [];
  /** @type {{ label: string, detail: string, url: string }[]} */
  const other = [];

  if (geo.outsideBay && geo.nearestAirport && !BAY_AIRPORTS.has(geo.nearestAirport.code)) {
    const destCode = geo.nearestAirport.code;
    const q = start
      ? `flights from SFO to ${destCode} on ${start}`
      : `flights from SFO to ${destCode}`;
    flights.push({
      label: `Flights SFO → ${destCode}`,
      detail: start
        ? `Suggested arrival window around ${start}${end && end !== start ? `–${end}` : ''}.`
        : 'Open Google Flights and pick dates.',
      url: `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`,
    });
    flights.push({
      label: `Flights OAK → ${destCode}`,
      detail: 'Alternate Bay Area departure.',
      url: `https://www.google.com/travel/flights?q=${encodeURIComponent(
        start ? `flights from OAK to ${destCode} on ${start}` : `flights from OAK to ${destCode}`,
      )}`,
    });
  } else if (geo.outsideBay) {
    flights.push({
      label: 'Search flights',
      detail: `Look up flights toward ${city}.`,
      url: `https://www.google.com/travel/flights?q=${encodeURIComponent(
        start ? `flights to ${city} on ${start}` : `flights to ${city}`,
      )}`,
    });
  }

  stays.push({
    label: 'Hotels near venue',
    detail: start
      ? `Stay search for ${city} (${start}${end && end !== start ? ` → ${end}` : ''}).`
      : `Stay search for ${city}.`,
    url: `https://www.google.com/travel/search?q=${encodeURIComponent(
      start ? `hotels in ${city} ${start}` : `hotels in ${city}`,
    )}`,
  });
  stays.push({
    label: 'Airbnb',
    detail: `Short-term rentals in ${city}.`,
    url: `https://www.airbnb.com/s/${encodeURIComponent(city)}/homes${
      start && end
        ? `?checkin=${encodeURIComponent(start)}&checkout=${encodeURIComponent(end)}`
        : ''
    }`,
  });
  stays.push({
    label: 'Hostels',
    detail: `Budget / hostel search for ${city}.`,
    url: `https://www.google.com/search?q=${encodeURIComponent(`hostels in ${city}`)}`,
  });
  stays.push({
    label: 'Map lodging nearby',
    detail: 'Browse hotels / short-term stays on Maps.',
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`hotels near ${city}`)}`,
  });

  other.push({
    label: 'Venue on map',
    detail: String(event?.venue || city),
    url:
      Number.isFinite(Number(event?.lat)) && Number.isFinite(Number(event?.lon))
        ? `https://www.google.com/maps/search/?api=1&query=${Number(event.lat)},${Number(event.lon)}`
        : `https://www.google.com/maps/search/?api=1&query=${destQuery}`,
  });
  other.push({
    label: 'Weather around event',
    detail: 'Check the forecast before packing.',
    url: `https://www.google.com/search?q=${encodeURIComponent(
      start ? `weather ${city} ${start}` : `weather ${city}`,
    )}`,
  });
  other.push({
    label: 'Local transit overview',
    detail: `Getting around ${city}.`,
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `public transit ${city}`,
    )}`,
  });

  return { flights, stays, other };
}

/**
 * Whether overnight camping looks pleasant for the event forecast window.
 * @param {{ ok?: boolean, days?: { highF?: number | null, lowF?: number | null, precipProb?: number | null, code?: number }[] } | null | undefined} weather
 * @returns {{ suitable: boolean, reason: string }}
 */
export function campingWeatherSuitable(weather) {
  if (!weather?.ok || !Array.isArray(weather.days) || !weather.days.length) {
    return { suitable: false, reason: 'no_forecast' };
  }
  for (const day of weather.days) {
    const high = day.highF;
    const low = day.lowF;
    const precip = day.precipProb;
    const code = Number(day.code) || 0;
    if (typeof high === 'number' && (high < 50 || high > 95)) {
      return { suitable: false, reason: 'temperature' };
    }
    if (typeof low === 'number' && low < 38) {
      return { suitable: false, reason: 'cold_nights' };
    }
    if (typeof precip === 'number' && precip >= 40) {
      return { suitable: false, reason: 'rain' };
    }
    // WMO: rain/showers/storm/snow roughly 51+
    if (code >= 51) {
      return { suitable: false, reason: 'wet_or_stormy' };
    }
  }
  return { suitable: true, reason: 'fair' };
}

/**
 * Structured deep links for the Transportation logistics module.
 * Two primary destinations: airport → accommodations, airport → event.
 * @param {object} event
 * @param {{
 *   nearestAirport: { code: string, name: string, miles: number } | null,
 *   outsideBay: boolean,
 * }} geo
 */
export function buildTransportationModuleLinks(event, geo) {
  const city = String(event?.city || event?.venue || '').trim() || 'destination';
  const dest =
    [event?.venue, event?.city].map((s) => String(s || '').trim()).filter(Boolean).join(', ')
    || city;
  const airport = geo.nearestAirport;
  /** @type {{
   *   id: string,
   *   title: string,
   *   destination: 'accommodations' | 'event' | 'either',
   *   items: { label: string, detail: string, url: string }[],
   * }[]} */
  const groups = [];

  if (airport) {
    groups.push({
      id: 'to-accommodations',
      title: `From ${airport.code} to your accommodations`,
      destination: 'accommodations',
      items: airportTransportOptions(airport, event, { kind: 'accommodations' }),
    });
    groups.push({
      id: 'to-event',
      title: `From ${airport.code} to the event`,
      destination: 'event',
      items: airportTransportOptions(airport, event, { kind: 'event' }),
    });
    groups.push({
      id: 'taxis',
      title: 'Popular taxis / rideshare',
      destination: 'either',
      items: [
        {
          label: 'Uber',
          detail: `Estimate a ride from ${airport.code} toward ${city}.`,
          url: `https://www.google.com/search?q=${encodeURIComponent(
            `Uber from ${airport.code} to ${city}`,
          )}`,
        },
        {
          label: 'Lyft',
          detail: `Rideshare options near ${airport.code}.`,
          url: `https://www.google.com/search?q=${encodeURIComponent(
            `Lyft ${airport.code} airport to ${city}`,
          )}`,
        },
        {
          label: 'Local taxi companies',
          detail: `Taxi services in ${city}.`,
          url: `https://www.google.com/search?q=${encodeURIComponent(
            `taxi ${city} airport ${airport.code}`,
          )}`,
        },
      ],
    });
    groups.push({
      id: 'rentals',
      title: 'Car rentals',
      destination: 'either',
      items: [
        {
          label: `Rental cars at ${airport.code}`,
          detail: 'Major counters at the airport.',
          url: `https://www.google.com/search?q=${encodeURIComponent(
            `car rental ${airport.code} airport`,
          )}`,
        },
        {
          label: 'Kayak car rentals',
          detail: 'Compare popular rental brands and daily rates.',
          url: `https://www.kayak.com/cars/${encodeURIComponent(airport.code)}`,
        },
        {
          label: 'Enterprise / Hertz / Avis',
          detail: `Search major brands near ${airport.code}.`,
          url: `https://www.google.com/search?q=${encodeURIComponent(
            `Enterprise Hertz Avis rental ${airport.code}`,
          )}`,
        },
      ],
    });
  } else {
    groups.push({
      id: 'to-accommodations',
      title: 'To your accommodations',
      destination: 'accommodations',
      items: [
        {
          label: 'Transit to lodging',
          detail: `Getting to stays in ${city}.`,
          url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
            `public transit to hotels ${city}`,
          )}`,
        },
        {
          label: 'Taxi / rideshare to lodging',
          detail: `Rides toward accommodations in ${city}.`,
          url: `https://www.google.com/search?q=${encodeURIComponent(
            `taxi rideshare to hotels ${city}`,
          )}`,
        },
      ],
    });
    groups.push({
      id: 'to-event',
      title: 'To the event',
      destination: 'event',
      items: [
        {
          label: 'Public transit',
          detail: `Transit options to ${dest}.`,
          url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
            `public transit ${city}`,
          )}`,
        },
        {
          label: 'Taxis / rideshare',
          detail: `Local taxis near ${dest}.`,
          url: `https://www.google.com/search?q=${encodeURIComponent(`taxi rideshare ${city}`)}`,
        },
        {
          label: 'Car rentals',
          detail: `Rentals in ${city}.`,
          url: `https://www.google.com/search?q=${encodeURIComponent(`car rental ${city}`)}`,
        },
      ],
    });
  }

  groups.push({
    id: 'costs',
    title: 'Options & typical costs',
    destination: 'either',
    items: [
      {
        label: 'Airport → accommodations cost',
        detail: 'Taxi, transit, and transfer prices to lodging.',
        url: `https://www.google.com/search?q=${encodeURIComponent(
          airport
            ? `${airport.code} to hotels ${city} taxi vs transit cost`
            : `${city} airport to hotel taxi vs transit cost`,
        )}`,
      },
      {
        label: 'Airport → event cost',
        detail: 'Taxi, transit, and transfer prices to the venue.',
        url: `https://www.google.com/search?q=${encodeURIComponent(
          airport
            ? `${airport.code} to ${dest} taxi vs transit cost`
            : `${city} taxi vs public transit cost`,
        )}`,
      },
      {
        label: 'Public transport routes',
        detail: 'Schedules and fares.',
        url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=transit`,
      },
    ],
  });

  return groups;
}

/**
 * Structured deep links for the Accommodations logistics module.
 * @param {object} event
 * @param {{ weather?: object | null }} [opts]
 */
export function buildAccommodationsModuleLinks(event, opts = {}) {
  const city = String(event?.city || event?.venue || '').trim() || 'destination';
  const start = ymd(event?.start);
  const end = ymd(event?.end) || start;
  const camping = campingWeatherSuitable(opts.weather);
  /** @type {{ id: string, title: string, items: { label: string, detail: string, url: string }[] }[]} */
  const groups = [
    {
      id: 'airbnb',
      title: 'Airbnb & short stays',
      items: [
        {
          label: 'Airbnb',
          detail: start
            ? `${city} · ${start}${end && end !== start ? ` → ${end}` : ''}`
            : city,
          url: `https://www.airbnb.com/s/${encodeURIComponent(city)}/homes${
            start && end
              ? `?checkin=${encodeURIComponent(start)}&checkout=${encodeURIComponent(end)}`
              : ''
          }`,
        },
        {
          label: 'VRBO',
          detail: `Vacation rentals in ${city}.`,
          url: `https://www.vrbo.com/search?destination=${encodeURIComponent(city)}`,
        },
      ],
    },
    {
      id: 'hostels',
      title: 'Hostels',
      items: [
        {
          label: 'Hostelworld',
          detail: `Hostels in ${city}.`,
          url: `https://www.hostelworld.com/find/?search_keywords=${encodeURIComponent(city)}`,
        },
        {
          label: 'Google · hostels',
          detail: `Find hostels near ${city}.`,
          url: `https://www.google.com/search?q=${encodeURIComponent(`hostels in ${city}`)}`,
        },
      ],
    },
    {
      id: 'hotels',
      title: 'Hotels',
      items: [
        {
          label: 'Google Hotels',
          detail: start
            ? `Stay search for ${city} (${start}${end && end !== start ? ` → ${end}` : ''}).`
            : `Stay search for ${city}.`,
          url: `https://www.google.com/travel/search?q=${encodeURIComponent(
            start ? `hotels in ${city} ${start}` : `hotels in ${city}`,
          )}`,
        },
      ],
    },
  ];

  if (camping.suitable) {
    groups.unshift({
      id: 'camping',
      title: 'Camping (weather looks good)',
      items: [
        {
          label: 'Campgrounds nearby',
          detail: `Overnight camping near ${city} — forecast looks camping-friendly.`,
          url: `https://www.google.com/search?q=${encodeURIComponent(
            `campgrounds near ${city}`,
          )}`,
        },
        {
          label: 'Recreation.gov / parks',
          detail: 'Public campground reservations (US).',
          url: `https://www.google.com/search?q=${encodeURIComponent(
            `Recreation.gov camping near ${city}`,
          )}`,
        },
        {
          label: 'Hipcamp',
          detail: `Private / unique camping near ${city}.`,
          url: `https://www.hipcamp.com/en-US/search?q=${encodeURIComponent(city)}`,
        },
      ],
    });
  }

  return { groups, camping };
}

/**
 * Nearby catalog events in the same city (preferred) or within radiusMiles,
 * overlapping one week before → during → one week after the target trip.
 * Taste-ranked when criteria are provided.
 * @param {object} target
 * @param {object[]} catalog
 * @param {{
 *   radiusMiles?: number,
 *   weekDays?: number,
 *   limit?: number,
 *   taste?: { lookFor?: string, skip?: string, blacklist?: string },
 * }} [opts]
 */
export function findNearbyEvents(target, catalog, opts = {}) {
  const radius = Number(opts.radiusMiles) > 0 ? Number(opts.radiusMiles) : 40;
  const weekDays = Number(opts.weekDays) > 0 ? Number(opts.weekDays) : 7;
  const limit = Number(opts.limit) > 0 ? Math.min(Number(opts.limit), 40) : 24;
  const tLat = Number(target?.lat);
  const tLon = Number(target?.lon);
  const hasCoords = Number.isFinite(tLat) && Number.isFinite(tLon);
  const tStart = Date.parse(String(target?.start || ''));
  const tEnd = Date.parse(String(target?.end || target?.start || ''));
  const targetId = String(target?.id || '');
  const targetCity = String(target?.city || '').trim();
  const dayMs = 24 * 60 * 60 * 1000;
  const beforeMs = Number.isFinite(tStart) ? tStart - weekDays * dayMs : NaN;
  const afterMs = Number.isFinite(tEnd)
    ? (Number.isFinite(tEnd) ? tEnd : tStart) + weekDays * dayMs
    : Number.isFinite(tStart)
      ? tStart + weekDays * dayMs
      : NaN;

  /** @type {{ event: object, miles: number | null, window: 'before'|'during'|'after', sameCity: boolean, tasteScore: number, matchedLookFor: string[] }[]} */
  const scored = [];
  for (const ev of Array.isArray(catalog) ? catalog : []) {
    if (!ev || String(ev.id || '') === targetId) continue;
    const cityMatch = targetCity ? sameCity(ev.city, targetCity) : false;
    const lat = Number(ev.lat);
    const lon = Number(ev.lon);
    let miles = null;
    if (hasCoords && Number.isFinite(lat) && Number.isFinite(lon)) {
      miles = haversineMiles(tLat, tLon, lat, lon);
    }
    // Prefer same city; otherwise require coords within radius.
    if (!cityMatch) {
      if (miles == null || miles > radius) continue;
    }

    const s = Date.parse(String(ev.start || ''));
    let window = /** @type {'before'|'during'|'after'|null} */ (null);
    if (Number.isFinite(tStart) && Number.isFinite(s)) {
      window = classifyTravelWindow(s, tStart, tEnd, beforeMs, afterMs);
      if (!window) continue;
    } else if (Number.isFinite(tStart)) {
      // Undated candidates skip date filter only when same city.
      if (!cityMatch) continue;
      window = 'during';
    } else {
      window = 'during';
    }

    const taste = scoreEventTaste(ev, opts.taste || {});
    if (!taste.ok) continue;

    scored.push({
      event: ev,
      miles,
      window,
      sameCity: cityMatch,
      tasteScore: taste.score,
      matchedLookFor: taste.matchedLookFor,
    });
  }

  const windowRank = { before: 0, during: 1, after: 2 };
  scored.sort((a, b) => {
    if (b.tasteScore !== a.tasteScore) return b.tasteScore - a.tasteScore;
    if (a.sameCity !== b.sameCity) return a.sameCity ? -1 : 1;
    if (windowRank[a.window] !== windowRank[b.window]) {
      return windowRank[a.window] - windowRank[b.window];
    }
    const ma = a.miles == null ? 9999 : a.miles;
    const mb = b.miles == null ? 9999 : b.miles;
    if (ma !== mb) return ma - mb;
    return String(a.event.start || '').localeCompare(String(b.event.start || ''));
  });

  return scored.slice(0, limit).map(({ event, miles, window, sameCity, tasteScore, matchedLookFor }) => ({
    id: event.id,
    title: event.title,
    start: event.start,
    end: event.end || null,
    city: event.city,
    venue: event.venue,
    url: event.url,
    imageUrl: event.imageUrl || event.raw?.imageUrl || null,
    description: event.description || null,
    priceLabel: event.priceLabel || null,
    lat: event.lat ?? null,
    lon: event.lon ?? null,
    source: event.source || null,
    miles: miles != null ? Math.round(miles * 10) / 10 : null,
    notable: event.notable === true,
    sameCity,
    window,
    tasteScore,
    matchedLookFor,
  }));
}

/**
 * Prefer stored coords; fall back to Bay Area city centroid resolution.
 * Rejects Null Island / missing pairs (Number(null) === 0).
 * @param {object} event
 * @returns {{ lat: number, lon: number } | null}
 */
export function resolveLogisticsLatLon(event) {
  const resolved = resolveEventLatLon(event);
  if (
    resolved
    && Number.isFinite(resolved.lat)
    && Number.isFinite(resolved.lon)
    && !(Math.abs(resolved.lat) < 0.01 && Math.abs(resolved.lon) < 0.01)
  ) {
    return resolved;
  }
  const la = Number(event?.lat);
  const lo = Number(event?.lon);
  if (
    event?.lat != null
    && event?.lon != null
    && Number.isFinite(la)
    && Number.isFinite(lo)
    && !(Math.abs(la) < 0.01 && Math.abs(lo) < 0.01)
  ) {
    return { lat: la, lon: lo };
  }
  return null;
}

/**
 * Open-Meteo daily forecast horizon (days). Logistics publishes weather as soon
 * as the event start falls inside this window.
 */
export const EVENT_WEATHER_FORECAST_DAYS = 16;

/** Auto-show forecast module in logistics this many days before event start. */
export const EVENT_WEATHER_LEAD_DAYS = EVENT_WEATHER_FORECAST_DAYS;

const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_FETCH_MS = 12_000;
const WEATHER_CACHE_MS = 30 * 60 * 1000;

/** @type {Map<string, { at: number, value: object }>} */
const weatherCache = new Map();

const WMO_SHORT = Object.freeze({
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Fog',
  51: 'Drizzle',
  53: 'Drizzle',
  55: 'Drizzle',
  61: 'Rain',
  63: 'Rain',
  65: 'Rain',
  71: 'Snow',
  73: 'Snow',
  75: 'Snow',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Rain showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Thunderstorm',
});

/**
 * @param {number} code
 * @returns {string}
 */
export function describeEventWeatherCode(code) {
  const n = Number(code);
  if (WMO_SHORT[n]) return WMO_SHORT[n];
  if (n >= 95) return 'Thunderstorm';
  if (n >= 80) return 'Rain showers';
  if (n >= 71) return 'Snow';
  if (n >= 61) return 'Rain';
  if (n >= 51) return 'Drizzle';
  if (n >= 45) return 'Fog';
  if (n >= 3) return 'Overcast';
  if (n === 2) return 'Partly cloudy';
  if (n === 1) return 'Mainly clear';
  return 'Clear';
}

/**
 * Whole calendar days from now until event start (negative if started).
 * @param {string | null | undefined} startIso
 * @param {Date} [now]
 * @returns {number | null}
 */
export function daysUntilEventStart(startIso, now = new Date()) {
  const startMs = Date.parse(String(startIso || ''));
  if (!Number.isFinite(startMs)) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  const startDay = Date.UTC(
    new Date(startMs).getUTCFullYear(),
    new Date(startMs).getUTCMonth(),
    new Date(startMs).getUTCDate(),
  );
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((startDay - nowDay) / dayMs);
}

/**
 * True when logistics should include the forecast module (≤ lead days before start,
 * through the end of the event day).
 * @param {object} event
 * @param {Date} [now]
 * @param {number} [leadDays]
 */
export function isEventWeatherModuleActive(event, now = new Date(), leadDays = EVENT_WEATHER_LEAD_DAYS) {
  const startMs = Date.parse(String(event?.start || ''));
  if (!Number.isFinite(startMs)) return false;
  const endParsed = Date.parse(String(event?.end || event?.start || ''));
  const endMs = Number.isFinite(endParsed) ? endParsed : startMs;
  const lead = Number(leadDays) > 0 ? Number(leadDays) : EVENT_WEATHER_LEAD_DAYS;
  const t = now.getTime();
  return t >= startMs - lead * 24 * 60 * 60 * 1000 && t <= endMs + 24 * 60 * 60 * 1000;
}

/**
 * @param {string} dateYmd
 * @returns {string}
 */
function weekdayShortUtc(dateYmd) {
  const ms = Date.parse(`${dateYmd}T12:00:00Z`);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

/**
 * Fetch daily forecast covering the event dates (Open-Meteo). Cached ~30m.
 * @param {number} lat
 * @param {number} lon
 * @param {object} event
 * @returns {Promise<{
 *   ok: true,
 *   daysUntil: number | null,
 *   city: string,
 *   timezone: string | null,
 *   days: {
 *     date: string,
 *     weekday: string,
 *     highF: number | null,
 *     lowF: number | null,
 *     code: number,
 *     summary: string,
 *     precipProb: number | null,
 *   }[],
 *   moreUrl: string,
 * } | { ok: false, daysUntil: number | null, city: string, reason: string, moreUrl: string }>}
 */
export async function fetchEventLogisticsWeather(lat, lon, event) {
  const city = String(event?.city || event?.venue || '').trim() || 'destination';
  const startYmd = ymd(event?.start);
  const endYmd = ymd(event?.end) || startYmd;
  const daysUntil = daysUntilEventStart(event?.start);
  const moreUrl = `https://www.google.com/search?q=${encodeURIComponent(
    startYmd ? `weather ${city} ${startYmd}` : `weather ${city}`,
  )}`;

  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || !startYmd) {
    return { ok: false, daysUntil, city, reason: 'no_coords', moreUrl };
  }

  const cacheKey = `${la.toFixed(3)},${lo.toFixed(3)}:${startYmd}:${endYmd}`;
  const hit = weatherCache.get(cacheKey);
  if (hit && Date.now() - hit.at < WEATHER_CACHE_MS) {
    return /** @type {any} */ ({ ...hit.value, cached: true });
  }

  const url = new URL(OPEN_METEO_FORECAST);
  url.searchParams.set('latitude', String(la));
  url.searchParams.set('longitude', String(lo));
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  );
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', String(EVENT_WEATHER_FORECAST_DAYS));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WEATHER_FETCH_MS);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: { 'User-Agent': 'dashbird/1.0 (event logistics weather; open-meteo.com)' },
    });
    if (!r.ok) {
      return { ok: false, daysUntil, city, reason: `open_meteo_http_${r.status}`, moreUrl };
    }
    const data = await r.json();
    const times = Array.isArray(data?.daily?.time) ? data.daily.time : [];
    const codes = Array.isArray(data?.daily?.weather_code) ? data.daily.weather_code : [];
    const highs = Array.isArray(data?.daily?.temperature_2m_max)
      ? data.daily.temperature_2m_max
      : [];
    const lows = Array.isArray(data?.daily?.temperature_2m_min)
      ? data.daily.temperature_2m_min
      : [];
    const precip = Array.isArray(data?.daily?.precipitation_probability_max)
      ? data.daily.precipitation_probability_max
      : [];

    /** @type {{ date: string, weekday: string, highF: number | null, lowF: number | null, code: number, summary: string, precipProb: number | null }[]} */
    const days = [];
    for (let i = 0; i < times.length; i++) {
      const date = String(times[i] || '');
      if (!date || date < startYmd || (endYmd && date > endYmd)) continue;
      const code = Number(codes[i]) || 0;
      const highRaw = highs[i];
      const lowRaw = lows[i];
      const precipRaw = precip[i];
      days.push({
        date,
        weekday: weekdayShortUtc(date),
        highF: typeof highRaw === 'number' && Number.isFinite(highRaw) ? Math.round(highRaw) : null,
        lowF: typeof lowRaw === 'number' && Number.isFinite(lowRaw) ? Math.round(lowRaw) : null,
        code,
        summary: describeEventWeatherCode(code),
        precipProb:
          typeof precipRaw === 'number' && Number.isFinite(precipRaw)
            ? Math.round(precipRaw)
            : null,
      });
    }

    if (!days.length) {
      return { ok: false, daysUntil, city, reason: 'no_forecast_days', moreUrl };
    }

    const value = {
      ok: true,
      daysUntil,
      city,
      timezone: typeof data?.timezone === 'string' ? data.timezone : null,
      days,
      moreUrl,
    };
    weatherCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (e) {
    const reason =
      e?.name === 'AbortError' ? 'timeout' : String(e?.message || e || 'fetch_failed');
    return { ok: false, daysUntil, city, reason, moreUrl };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full logistics payload for one event.
 * When the event is within {@link EVENT_WEATHER_LEAD_DAYS} days, includes a `weather` module.
 * @param {object} event
 * @param {object[]} catalog
 * @param {{
 *   taste?: { lookFor?: string, skip?: string, blacklist?: string },
 *   tripPlanning?: unknown,
 *   now?: Date,
 *   includeFlightLinks?: boolean,
 * }} [opts]
 */
export async function buildEventLogistics(event, catalog = [], opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const coords = resolveLogisticsLatLon(event);
  const located = coords ? { ...event, lat: coords.lat, lon: coords.lon } : { ...event };
  const milesFromBay = milesFromBayArea(located.lat, located.lon);
  const outsideBay = isOutsideBayArea(located, 100);
  const nearestAirport = coords
    ? nearestInternationalAirport(coords.lat, coords.lon)
    : null;
  const links = buildTravelDeepLinks(located, { milesFromBay, outsideBay, nearestAirport });
  const transport =
    outsideBay && nearestAirport ? airportTransportOptions(nearestAirport, located) : [];
  const nearby = findNearbyEvents(
    located,
    catalog.map((ev) => {
      const c = resolveLogisticsLatLon(ev);
      return c ? { ...ev, lat: c.lat, lon: c.lon } : ev;
    }),
    { taste: opts.taste, weekDays: 7, radiusMiles: 40, limit: 24 },
  );
  const tripPlanning = normalizeTripPlanning(
    opts.tripPlanning ?? event?.tripPlanning,
    event?.planningNotes,
  );
  const city = String(located.city || '').trim();
  const includeFlightLinks = opts.includeFlightLinks === true;

  /** @type {Awaited<ReturnType<typeof fetchEventLogisticsWeather>> | null} */
  let weather = null;
  if (isEventWeatherModuleActive(located, now)) {
    if (coords) {
      weather = await fetchEventLogisticsWeather(coords.lat, coords.lon, located);
    } else {
      const startYmd = ymd(located?.start);
      const place = city || 'destination';
      weather = {
        ok: false,
        daysUntil: daysUntilEventStart(located?.start, now),
        city: place,
        reason: 'no_coords',
        moreUrl: `https://www.google.com/search?q=${encodeURIComponent(
          startYmd ? `weather ${place} ${startYmd}` : `weather ${place}`,
        )}`,
      };
    }
  }

  return {
    ok: true,
    eventId: String(event?.id || ''),
    map: {
      lat: coords?.lat ?? null,
      lon: coords?.lon ?? null,
      label: [event?.venue, event?.city].filter(Boolean).join(', ') || event?.title || 'Event',
      bayCenter: BAY_AREA_CENTER,
    },
    milesFromBay: milesFromBay != null ? Math.round(milesFromBay * 10) / 10 : null,
    outsideBay,
    nearestAirport: nearestAirport
      ? {
          code: nearestAirport.code,
          name: nearestAirport.name,
          lat: nearestAirport.lat,
          lon: nearestAirport.lon,
          miles: Math.round(nearestAirport.miles * 10) / 10,
        }
      : null,
    transportFromAirport: transport,
    flights: includeFlightLinks ? links.flights : [],
    flightModuleAvailable: Boolean(
      outsideBay
      && (
        (nearestAirport && !BAY_AIRPORTS.has(nearestAirport.code))
        || city
      ),
    ),
    accommodations: links.stays,
    otherConsiderations: links.other,
    transportationModule: buildTransportationModuleLinks(located, {
      nearestAirport: nearestAirport
        ? {
            code: nearestAirport.code,
            name: nearestAirport.name,
            miles: nearestAirport.miles,
          }
        : null,
      outsideBay,
    }),
    accommodationsModule: buildAccommodationsModuleLinks(located, { weather }),
    nearbyEvents: nearby,
    nearbyByWindow: {
      before: nearby.filter((e) => e.window === 'before'),
      during: nearby.filter((e) => e.window === 'during'),
      after: nearby.filter((e) => e.window === 'after'),
    },
    areaFeeds: suggestAreaEventFeeds(city),
    tripPlanning,
    planningNotes: tripPlanning.notes || event?.planningNotes || null,
    weather,
  };
}
