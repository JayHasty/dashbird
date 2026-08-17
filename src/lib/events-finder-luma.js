/**
 * Events finder — Luma calendar / event pins from docs/luma-calendar-pins.md.
 * Calendar hubs → api.lu.ma/calendar/get-items;
 * discover places (e.g. luma.com/sf) → api.lu.ma/discover/get-paginated-events;
 * event pages → __NEXT_DATA__.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEventImageUrl } from './events-finder-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const PINS_DOC = path.join(root, 'docs', 'luma-calendar-pins.md');

const UA =
  'Mozilla/5.0 (compatible; DashbirdEvents/1.0; +https://github.com/local/dashbird)';

const FALLBACK_PINS = [
  'https://luma.com/sf',
  'https://luma.com/9zero',
  'https://luma.com/Big-Brain-SF',
  'https://luma.com/genai-sf',
  'https://luma.com/buildercommunityanz',
  'https://luma.com/climatecafe',
  'https://luma.com/climatedraft-community',
  'https://luma.com/frontiertower',
  'https://luma.com/netzeroinsights',
  'https://luma.com/outinclimate',
  'https://luma.com/sf-builders-collective',
  'https://luma.com/sf-hardware-meetup',
  'https://luma.com/theclimateparty',
  'https://luma.com/tiat',
  'https://luma.com/h.h',
  'https://luma.com/4esilsg5',
  'https://luma.com/ghnew59o',
];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function lumaEventsCachePath(env = process.env) {
  const override = String(env.LUMA_EVENTS_CACHE_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(root, override);
  }
  return path.join(root, 'data', 'luma-events-cache.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function lumaCacheTtlMs(env = process.env) {
  const raw = Number(env.LUMA_EVENTS_CACHE_MS);
  if (Number.isFinite(raw) && raw >= 60_000) return raw;
  return 6 * 60 * 60 * 1000;
}

/**
 * Normalize a Luma URL to https://luma.com/<slug-or-path>
 * @param {string} href
 * @returns {string | null}
 */
export function normalizeLumaUrl(href) {
  try {
    const u = new URL(String(href || '').trim());
    if (!/^https?:$/i.test(u.protocol)) return null;
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'luma.com' && host !== 'lu.ma' && !host.endsWith('.luma.com')) {
      return null;
    }
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    // Drop map / about / etc. trailing segments for calendar hubs when present.
    const drop = new Set(['map', 'about', 'members', 'submit']);
    while (parts.length > 1 && drop.has(parts[parts.length - 1].toLowerCase())) {
      parts.pop();
    }
    const pathPart = parts.map((p) => encodeURIComponent(decodeURIComponent(p))).join('/');
    return `https://luma.com/${pathPart}`;
  } catch {
    return null;
  }
}

/**
 * Load pin URLs from docs/luma-calendar-pins.md (## Pins section).
 * @param {string} [docPath]
 * @returns {Promise<string[]>}
 */
export async function loadLumaCalendarPins(docPath = PINS_DOC) {
  let md = '';
  try {
    md = await readFile(docPath, 'utf8');
  } catch {
    return [...FALLBACK_PINS];
  }
  const idx = md.search(/^##\s+Pins\s*$/m);
  const body = idx >= 0 ? md.slice(idx) : md;
  const next = body.slice(3).search(/^##\s+/m);
  const section = next > 0 ? body.slice(0, next + 3) : body;

  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
    const m = trimmed.match(/https?:\/\/[^\s)\]]+/i);
    if (!m) continue;
    const norm = normalizeLumaUrl(m[0]);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.length ? out : [...FALLBACK_PINS];
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, status: number, html: string, err?: string }>}
 */
async function fetchHtml(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html };
  } catch (e) {
    return { ok: false, status: 0, html: '', err: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, status: number, json: any, err?: string }>}
 */
async function fetchJson(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, json: null, err: 'bad_json' };
    }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: null, err: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} html
 * @returns {{ kind: string, data: Record<string, any> } | null}
 */
export function extractLumaInitialData(html) {
  const m = String(html || '').match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i,
  );
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    const init = data?.props?.pageProps?.initialData;
    if (!init || typeof init !== 'object') return null;
    const kind = String(init.kind || '').trim();
    const payload = init.data;
    if (!kind || !payload || typeof payload !== 'object') return null;
    return { kind, data: /** @type {Record<string, any>} */ (payload) };
  } catch {
    return null;
  }
}

/**
 * @param {unknown} centsObj
 * @returns {number | null}
 */
function dollarsFromCentsObj(centsObj) {
  if (!centsObj || typeof centsObj !== 'object') return null;
  const cents = Number(/** @type {Record<string, unknown>} */ (centsObj).cents);
  if (!Number.isFinite(cents) || cents < 0) return null;
  return Math.round(cents) / 100;
}

/**
 * @param {Record<string, any> | null | undefined} ticketInfo
 * @returns {{ price: number | null, priceMax: number | null }}
 */
function priceFromTicketInfo(ticketInfo) {
  if (!ticketInfo || typeof ticketInfo !== 'object') {
    return { price: null, priceMax: null };
  }
  if (ticketInfo.is_free === true && !ticketInfo.price) {
    return { price: 0, priceMax: dollarsFromCentsObj(ticketInfo.max_price) };
  }
  const min = dollarsFromCentsObj(ticketInfo.price);
  const max = dollarsFromCentsObj(ticketInfo.max_price);
  return {
    price: min,
    priceMax: max != null && min != null && max > min ? max : max,
  };
}

/**
 * @param {Record<string, any>} event
 * @param {Record<string, any> | null} [calendar]
 * @param {Record<string, any> | null} [ticketInfo]
 * @param {string} [pageUrl]
 * @returns {object | null}
 */
export function lumaEventToNormalized(event, calendar = null, ticketInfo = null, pageUrl = '') {
  if (!event || typeof event !== 'object') return null;
  const title = String(event.name || '').trim();
  const apiId = String(event.api_id || '').trim();
  const slug = String(event.url || '').trim();
  if (!title || (!apiId && !slug && !pageUrl)) return null;

  const startRaw = event.start_at || null;
  const endRaw = event.end_at || null;
  const startMs = startRaw ? Date.parse(String(startRaw)) : NaN;
  const endMs = endRaw ? Date.parse(String(endRaw)) : NaN;

  const geo = event.geo_address_info && typeof event.geo_address_info === 'object'
    ? event.geo_address_info
    : null;
  const venue =
    String(geo?.address || geo?.full_address || geo?.short_address || '').trim().slice(0, 200)
    || null;
  const city = String(geo?.city || '').trim() || null;

  let lat = null;
  let lon = null;
  const coord = event.coordinate;
  if (coord && typeof coord === 'object') {
    const gLat = Number(coord.latitude);
    const gLon = Number(coord.longitude);
    // Reject Null Island — Luma often sends 0,0 when geo is missing.
    if (
      Number.isFinite(gLat)
      && Number.isFinite(gLon)
      && !(Math.abs(gLat) < 0.01 && Math.abs(gLon) < 0.01)
    ) {
      lat = gLat;
      lon = gLon;
    }
  }

  const online =
    String(event.location_type || '').toLowerCase() === 'online'
    || String(event.location_type || '').toLowerCase() === 'virtual';

  const url = slug
    ? `https://luma.com/${slug}`
    : pageUrl || (apiId ? `https://luma.com/${apiId}` : '');

  const { price, priceMax } = priceFromTicketInfo(ticketInfo);
  const calName = calendar ? String(calendar.name || '').trim() || null : null;
  const calSlug = calendar ? String(calendar.slug || '').trim() || null : null;

  return {
    id: `luma:${apiId || slug || Buffer.from(url).toString('base64url').slice(0, 32)}`,
    title: title.slice(0, 500),
    start: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
    end: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
    venue,
    city,
    lat,
    lon,
    url,
    source: 'luma',
    online,
    isOnline: online,
    location: venue,
    description: null,
    imageUrl: normalizeEventImageUrl(
      String(event.cover_url || event.social_image_url || '').trim() || null,
    ),
    ticketPrice: price,
    price,
    priceMax: priceMax != null && price != null && priceMax !== price ? priceMax : priceMax,
    calendarName: calName,
    calendarSlug: calSlug,
    raw: {
      lumaId: apiId || null,
      visibility: event.visibility || null,
      locationType: event.location_type || null,
      calendarApiId: event.calendar_api_id || calendar?.api_id || null,
    },
  };
}

/**
 * Walk a Luma list API that returns { entries, has_more, next_cursor }.
 * @param {(cursor: string) => Promise<{ ok: boolean, status: number, json: any, err?: string }>} fetchPage
 * @param {{ maxPages?: number }} [opts]
 * @returns {Promise<{ ok: boolean, entries: object[], error?: string }>}
 */
async function fetchPaginatedEntries(fetchPage, opts = {}) {
  const maxPages = Math.min(Math.max(Number(opts.maxPages) || 16, 1), 40);
  /** @type {object[]} */
  const entries = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const res = await fetchPage(cursor);
    if (!res.ok || !res.json) {
      return {
        ok: entries.length > 0,
        entries,
        error: res.err || `HTTP ${res.status}`,
      };
    }
    const batch = Array.isArray(res.json.entries) ? res.json.entries : [];
    entries.push(...batch);
    const hasMore = res.json.has_more === true;
    const next =
      res.json.next_cursor
      || res.json.pagination_cursor
      || (typeof res.json.cursor === 'string' ? res.json.cursor : '');
    if (!hasMore || !next || next === cursor) break;
    cursor = String(next);
  }
  return { ok: true, entries };
}

/**
 * @param {string} calendarApiId
 * @returns {Promise<{ ok: boolean, entries: object[], error?: string }>}
 */
async function fetchCalendarItems(calendarApiId) {
  const id = String(calendarApiId || '').trim();
  if (!id) return { ok: false, entries: [], error: 'no_calendar_id' };

  return fetchPaginatedEntries((cursor) => {
    const params = new URLSearchParams({
      calendar_api_id: id,
      pagination_limit: '200',
    });
    if (cursor) params.set('pagination_cursor', cursor);
    return fetchJson(`https://api.lu.ma/calendar/get-items?${params}`);
  });
}

/**
 * City / discover-place feed (e.g. luma.com/sf → discplace-…).
 * @param {string} discoverPlaceApiId
 * @returns {Promise<{ ok: boolean, entries: object[], error?: string }>}
 */
async function fetchDiscoverPlaceEvents(discoverPlaceApiId) {
  const id = String(discoverPlaceApiId || '').trim();
  if (!id) return { ok: false, entries: [], error: 'no_discover_place_id' };

  return fetchPaginatedEntries((cursor) => {
    const params = new URLSearchParams({
      discover_place_api_id: id,
      pagination_limit: '100',
    });
    if (cursor) params.set('pagination_cursor', cursor);
    return fetchJson(`https://api.lu.ma/discover/get-paginated-events?${params}`);
  });
}

/**
 * @param {object[]} entries
 * @param {Record<string, any> | null} [fallbackCalendar]
 * @param {string} [pinUrl]
 * @returns {object[]}
 */
function normalizeLumaEntries(entries, fallbackCalendar = null, pinUrl = '') {
  /** @type {object[]} */
  const events = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const norm = lumaEventToNormalized(
      entry?.event,
      entry?.calendar || fallbackCalendar,
      entry?.ticket_info || null,
      pinUrl,
    );
    if (norm) events.push(norm);
  }
  return events;
}

/**
 * @param {string} pinUrl
 * @returns {Promise<{ ok: boolean, pinUrl: string, kind: string | null, events: object[], error?: string }>}
 */
async function fetchLumaPin(pinUrl) {
  const page = await fetchHtml(pinUrl);
  if (!page.ok) {
    return {
      ok: false,
      pinUrl,
      kind: null,
      events: [],
      error: page.err || `HTTP ${page.status}`,
    };
  }
  const init = extractLumaInitialData(page.html);
  if (!init) {
    return { ok: false, pinUrl, kind: null, events: [], error: 'no_next_data' };
  }

  if (init.kind === 'event') {
    const event = init.data.event;
    const calendar = init.data.calendar || null;
    const ticketInfo = init.data.ticket_info || null;
    const norm = lumaEventToNormalized(event, calendar, ticketInfo, pinUrl);
    return {
      ok: Boolean(norm),
      pinUrl,
      kind: 'event',
      events: norm ? [norm] : [],
      error: norm ? undefined : 'parse_failed',
    };
  }

  if (init.kind === 'calendar') {
    const calendar = init.data.calendar || null;
    const calendarApiId = String(calendar?.api_id || '').trim();
    if (!calendarApiId) {
      // Fallback: featured_items embedded in the page
      const events = normalizeLumaEntries(
        Array.isArray(init.data.featured_items) ? init.data.featured_items : [],
        calendar,
        pinUrl,
      );
      return {
        ok: events.length > 0,
        pinUrl,
        kind: 'calendar',
        events,
        error: events.length ? undefined : 'no_calendar_id',
      };
    }

    const items = await fetchCalendarItems(calendarApiId);
    let events = normalizeLumaEntries(items.entries, calendar, pinUrl);

    // If API returned nothing, fall back to featured_items from HTML.
    if (!events.length) {
      events = normalizeLumaEntries(
        Array.isArray(init.data.featured_items) ? init.data.featured_items : [],
        calendar,
        pinUrl,
      );
    }

    return {
      ok: events.length > 0 || items.ok,
      pinUrl,
      kind: 'calendar',
      events,
      error: events.length ? undefined : items.error || 'no_events',
    };
  }

  if (init.kind === 'discover-place') {
    const place = init.data.place && typeof init.data.place === 'object'
      ? init.data.place
      : null;
    const placeApiId = String(place?.api_id || '').trim();
    const placeName = String(place?.name || place?.slug || '').trim() || null;
    const placeSlug = String(place?.slug || '').trim() || null;
    const placeAsCalendar = place
      ? { api_id: placeApiId || null, name: placeName, slug: placeSlug }
      : null;

    let events = [];
    let apiError;
    if (placeApiId) {
      const items = await fetchDiscoverPlaceEvents(placeApiId);
      events = normalizeLumaEntries(items.entries, placeAsCalendar, pinUrl);
      apiError = items.error;
    }

    // Fallback: events embedded in the discover HTML (first page only).
    if (!events.length) {
      events = normalizeLumaEntries(
        Array.isArray(init.data.events) ? init.data.events : [],
        placeAsCalendar,
        pinUrl,
      );
    }

    return {
      ok: events.length > 0,
      pinUrl,
      kind: 'discover-place',
      events,
      error: events.length
        ? undefined
        : apiError || (placeApiId ? 'no_events' : 'no_discover_place_id'),
    };
  }

  return {
    ok: false,
    pinUrl,
    kind: init.kind,
    events: [],
    error: `unsupported_kind:${init.kind}`,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function readCache(env = process.env) {
  try {
    const raw = await readFile(lumaEventsCachePath(env), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * @param {object} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeCache(payload, env = process.env) {
  const p = lumaEventsCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * @param {object | null} cache
 * @param {NodeJS.ProcessEnv} [env]
 */
function cacheFresh(cache, env = process.env) {
  if (!cache?.cachedAt) return false;
  const age = Date.now() - Date.parse(cache.cachedAt);
  return Number.isFinite(age) && age >= 0 && age < lumaCacheTtlMs(env);
}

/**
 * Fetch upcoming events for all pinned Luma calendars / event pages.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean, concurrency?: number }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   fromCache: boolean,
 *   stale: boolean,
 *   cachedAt: string | null,
 *   pins: string[],
 *   pinsOk: number,
 *   pinsFailed: number,
 *   events: object[],
 *   error?: string | null,
 * }>}
 */
export async function fetchLumaPinnedEvents(env = process.env, opts = {}) {
  const pins = await loadLumaCalendarPins();
  if (!pins.length) {
    return {
      ok: false,
      fromCache: false,
      stale: false,
      cachedAt: null,
      pins: [],
      pinsOk: 0,
      pinsFailed: 0,
      events: [],
      error: 'no_pins',
    };
  }

  const force = opts.forceRefresh === true;
  const cache = await readCache(env);
  if (!force && cacheFresh(cache, env)) {
    return {
      ok: true,
      fromCache: true,
      stale: false,
      cachedAt: cache.cachedAt || null,
      pins: cache.pins || pins,
      pinsOk: cache.pinsOk ?? 0,
      pinsFailed: cache.pinsFailed ?? 0,
      events: cache.events || [],
      error: null,
    };
  }

  const concurrency = Math.min(Math.max(Number(opts.concurrency) || 3, 1), 6);
  const queue = [...pins];
  /** @type {object[]} */
  const events = [];
  let pinsOk = 0;
  let pinsFailed = 0;

  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      if (!url) break;
      const result = await fetchLumaPin(url);
      if (result.ok) {
        pinsOk += 1;
        events.push(...result.events);
      } else {
        pinsFailed += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const seen = new Set();
  /** @type {object[]} */
  const unique = [];
  for (const ev of events) {
    const id = String(ev.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(ev);
  }

  const payload = {
    cachedAt: new Date().toISOString(),
    pins,
    pinsOk,
    pinsFailed,
    count: unique.length,
    events: unique,
  };
  try {
    await writeCache(payload, env);
  } catch {
    /* ignore cache write errors */
  }

  return {
    ok: unique.length > 0 || pinsOk > 0,
    fromCache: false,
    stale: false,
    cachedAt: payload.cachedAt,
    pins,
    pinsOk,
    pinsFailed,
    events: unique,
    error: null,
  };
}
