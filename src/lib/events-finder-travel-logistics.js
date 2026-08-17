/**
 * Planning & logistics helpers for notable / distant events.
 * Uses deep links (no paid travel APIs) + nearest major airport lookup.
 */
import { haversineMiles } from './dashboard-geo.js';
import { BAY_AREA_CITY_COORDS, resolveEventLatLon } from './events-finder-geo.js';
import { scoreEventTaste } from './events-finder-taste.js';

/**
 * @typedef {{
 *   packingList: string | null,
 *   accommodations: string | null,
 *   flightsTransport: string | null,
 *   beforeTrip: string | null,
 *   notes: string | null,
 * }} TripPlanning
 */

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
  return {
    packingList: tripField(r.packingList, 4000),
    accommodations: tripField(r.accommodations, 4000),
    flightsTransport: tripField(r.flightsTransport, 4000),
    beforeTrip: tripField(r.beforeTrip, 4000),
    notes,
  };
}

/**
 * @param {TripPlanning | null | undefined} tp
 * @returns {boolean}
 */
export function tripPlanningHasContent(tp) {
  if (!tp || typeof tp !== 'object') return false;
  return Boolean(
    tp.packingList || tp.accommodations || tp.flightsTransport || tp.beforeTrip || tp.notes,
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
  if (tp.packingList) parts.push(`Packing:\n${tp.packingList}`);
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
export function airportTransportOptions(airport, event) {
  const dest =
    [event?.venue, event?.city].map((s) => String(s || '').trim()).filter(Boolean).join(', ')
    || `${event?.lat},${event?.lon}`;
  const mapsDir = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    `${airport.name} (${airport.code})`,
  )}&destination=${encodeURIComponent(dest)}`;
  const rideshare = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `rideshare to ${dest}`,
  )}`;
  /** @type {{ label: string, detail: string, url: string }[]} */
  const options = [
    {
      label: 'Rideshare / taxi',
      detail: `Door-to-door from ${airport.code} (~${Math.round(airport.miles)} mi to venue area).`,
      url: rideshare,
    },
    {
      label: 'Driving directions',
      detail: `Google Maps route from ${airport.code} to the venue.`,
      url: mapsDir,
    },
  ];
  if (airport.code === 'SFO' || airport.code === 'OAK' || airport.code === 'SJC') {
    options.unshift({
      label: 'BART / Caltrain / VTA',
      detail: 'Bay Area rail + local transit from the airport — check schedules for event day.',
      url: 'https://www.google.com/maps/travel/flights?tfs=transit',
    });
  } else if (airport.miles <= 15) {
    options.unshift({
      label: 'Airport transit / shuttle',
      detail: `Venue is ~${Math.round(airport.miles)} mi from ${airport.code} — local transit or hotel shuttle may work.`,
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${airport.code} airport transit to ${dest}`,
      )}`,
    });
  } else {
    options.push({
      label: 'Rental car',
      detail: `~${Math.round(airport.miles)} mi from ${airport.code} — rental may be simplest for the area.`,
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `car rental ${airport.code}`,
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
 * Full logistics payload for one event.
 * @param {object} event
 * @param {object[]} catalog
 * @param {{
 *   taste?: { lookFor?: string, skip?: string, blacklist?: string },
 *   tripPlanning?: unknown,
 * }} [opts]
 */
export function buildEventLogistics(event, catalog = [], opts = {}) {
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
    flights: links.flights,
    accommodations: links.stays,
    otherConsiderations: links.other,
    nearbyEvents: nearby,
    nearbyByWindow: {
      before: nearby.filter((e) => e.window === 'before'),
      during: nearby.filter((e) => e.window === 'during'),
      after: nearby.filter((e) => e.window === 'after'),
    },
    areaFeeds: suggestAreaEventFeeds(city),
    tripPlanning,
    planningNotes: tripPlanning.notes || event?.planningNotes || null,
  };
}
