/**
 * Opt-in Transportation / Accommodations research for Events Finder logistics.
 * Deep links come from travel-logistics; this layer adds a short researched brief
 * (Brave/Chrome + OpenRouter) with typical options and cost cues.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchChromeResultUrls } from './chrome-web-search.js';
import { braveApiEnabled, braveApiWebSearch } from './brave-search-api.js';
import { openRouterChatJson } from './openrouter-chat-json.js';
import { assertPublicHttpUrl } from './public-http-url.js';
import {
  buildAccommodationsModuleLinks,
  buildTransportationModuleLinks,
  campingWeatherSuitable,
  milesFromBayArea,
  nearestInternationalAirport,
  resolveLogisticsLatLon,
  isOutsideBayArea,
} from './events-finder-travel-logistics.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const FETCH_UA = 'Dashbird/1.0 (events logistics modules; local dashboard)';
const FRESH_MS = 36 * 60 * 60 * 1000;

/** @type {Map<string, Promise<object>>} */
const inFlightByKey = new Map();

/**
 * @typedef {'transportation' | 'accommodations'} LogisticsModuleType
 *
 * @typedef {{
 *   key: string,
 *   kind: 'big' | 'notable',
 *   id: string,
 *   type: LogisticsModuleType,
 *   enabled: boolean,
 *   city: string | null,
 *   ok: boolean,
 *   summary: string | null,
 *   items: { title: string, detail: string, category: string, destination?: 'accommodations' | 'event' | 'either', priceHint: string | null }[],
 *   sources: { title: string, url: string }[],
 *   campingSuitable: boolean | null,
 *   campingReason: string | null,
 *   generatedAt: string | null,
 *   researching: boolean,
 *   error: string | null,
 * }} LogisticsModuleRecord
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function logisticsModulesStorePath(env = process.env) {
  const override = String(env.EVENTS_FINDER_LOGISTICS_MODULES_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data', 'events-finder-logistics-modules.json');
}

/**
 * @param {string} kind
 * @param {string} id
 * @param {LogisticsModuleType} type
 */
export function logisticsModuleKey(kind, id, type) {
  const k = kind === 'notable' ? 'notable' : 'big';
  const i = String(id || '').trim().slice(0, 200);
  const t = type === 'accommodations' ? 'accommodations' : 'transportation';
  return i ? `${k}:${i}:${t}` : '';
}

/**
 * @param {unknown} raw
 * @returns {LogisticsModuleRecord | null}
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const key = String(r.key || '').trim().slice(0, 240);
  if (!key) return null;
  const parts = key.split(':');
  const kind = parts[0] === 'notable' ? 'notable' : 'big';
  const type = parts[2] === 'accommodations' ? 'accommodations' : 'transportation';
  const id = parts[1] || '';

  /** @type {LogisticsModuleRecord['items']} */
  const items = [];
  if (Array.isArray(r.items)) {
    for (const row of r.items.slice(0, 14)) {
      if (!row || typeof row !== 'object') continue;
      const o = /** @type {Record<string, unknown>} */ (row);
      const title = String(o.title || '').trim().slice(0, 160);
      if (!title) continue;
      const destRaw = String(o.destination || '').trim().toLowerCase();
      /** @type {'accommodations' | 'event' | 'either'} */
      const destination =
        destRaw === 'accommodations' || destRaw === 'stay' || destRaw === 'stays'
          ? 'accommodations'
          : destRaw === 'event' || destRaw === 'venue'
            ? 'event'
            : 'either';
      items.push({
        title,
        detail: String(o.detail || '').trim().slice(0, 500),
        category: String(o.category || 'other').trim().slice(0, 40) || 'other',
        destination,
        priceHint:
          o.priceHint != null && String(o.priceHint).trim()
            ? String(o.priceHint).trim().slice(0, 120)
            : null,
      });
    }
  }

  /** @type {{ title: string, url: string }[]} */
  const sources = [];
  if (Array.isArray(r.sources)) {
    for (const s of r.sources.slice(0, 8)) {
      if (!s || typeof s !== 'object') continue;
      const o = /** @type {Record<string, unknown>} */ (s);
      const url = String(o.url || '').trim().slice(0, 500);
      if (!url) continue;
      sources.push({
        title: String(o.title || url).trim().slice(0, 160),
        url,
      });
    }
  }

  return {
    key,
    kind,
    id,
    type,
    enabled: r.enabled !== false,
    city: r.city != null ? String(r.city).trim().slice(0, 120) || null : null,
    ok: r.ok === true,
    summary: r.summary != null ? String(r.summary).trim().slice(0, 1200) || null : null,
    items,
    sources,
    campingSuitable: typeof r.campingSuitable === 'boolean' ? r.campingSuitable : null,
    campingReason: r.campingReason != null ? String(r.campingReason).slice(0, 40) : null,
    generatedAt: r.generatedAt != null ? String(r.generatedAt).slice(0, 40) : null,
    researching: r.researching === true,
    error: r.error != null ? String(r.error).slice(0, 200) : null,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Record<string, LogisticsModuleRecord>>}
 */
async function loadStore(env = process.env) {
  try {
    const raw = await fs.readFile(logisticsModulesStorePath(env), 'utf8');
    const j = JSON.parse(raw);
    const out = /** @type {Record<string, LogisticsModuleRecord>} */ ({});
    const rows = j && typeof j === 'object' && j.byKey && typeof j.byKey === 'object' ? j.byKey : j;
    if (rows && typeof rows === 'object') {
      for (const [k, v] of Object.entries(rows)) {
        const n = normalizeRecord({ .../** @type {object} */ (v), key: k });
        if (n) out[k] = n;
      }
    }
    return out;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return {};
    throw e;
  }
}

/**
 * @param {Record<string, LogisticsModuleRecord>} store
 * @param {NodeJS.ProcessEnv} [env]
 */
async function saveStore(store, env = process.env) {
  const p = logisticsModulesStorePath(env);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ byKey: store }, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, p);
}

/**
 * @param {LogisticsModuleRecord | null | undefined} rec
 */
export function isLogisticsModuleFresh(rec) {
  if (!rec?.ok || !rec.generatedAt || rec.researching) return false;
  const t = Date.parse(rec.generatedAt);
  return Number.isFinite(t) && Date.now() - t < FRESH_MS;
}

/**
 * @param {string} kind
 * @param {string} id
 * @param {LogisticsModuleType} type
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function getLogisticsModule(kind, id, type, env = process.env) {
  const key = logisticsModuleKey(kind, id, type);
  if (!key) return null;
  const store = await loadStore(env);
  return store[key] || null;
}

/**
 * @param {LogisticsModuleRecord | null | undefined} rec
 */
export function publicLogisticsModule(rec) {
  if (!rec) return null;
  return {
    enabled: rec.enabled !== false,
    type: rec.type,
    ok: rec.ok === true,
    city: rec.city,
    summary: rec.summary,
    items: rec.items,
    sources: rec.sources,
    campingSuitable: rec.campingSuitable,
    campingReason: rec.campingReason,
    generatedAt: rec.generatedAt,
    researching: rec.researching === true,
    error: rec.error,
    fresh: isLogisticsModuleFresh(rec),
  };
}

/**
 * @param {string} url
 */
async function fetchPageText(url) {
  let safe;
  try {
    safe = await assertPublicHttpUrl(url);
  } catch {
    return '';
  }
  try {
    const r = await fetch(safe, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': FETCH_UA },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return '';
    const html = await r.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6_000);
  } catch {
    return '';
  }
}

/**
 * @param {string} query
 * @param {number} limit
 * @param {NodeJS.ProcessEnv} env
 */
async function searchHits(query, limit, env) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (braveApiEnabled(env)) {
    try {
      const rows = await braveApiWebSearch(q, limit, env);
      if (rows.length) {
        return rows.map((r) => ({
          url: r.url,
          title: r.title || r.url,
          snippet: String(r.description || '').trim(),
        }));
      }
    } catch {
      // fall through
    }
  }
  const urls = await searchChromeResultUrls(q, limit, env).catch(() => []);
  return urls.map((url) => ({ url, title: url, snippet: '' }));
}

/**
 * @param {LogisticsModuleType} type
 * @param {string} city
 * @param {string | null} airportCode
 * @param {string | null} startYmd
 */
function researchQueries(type, city, airportCode, startYmd) {
  if (type === 'accommodations') {
    return [
      `hostels in ${city} prices`,
      `Airbnb average nightly cost ${city}`,
      startYmd ? `camping near ${city} ${startYmd}` : `campgrounds near ${city}`,
      `best areas to stay near ${city} events`,
    ];
  }
  const ap = airportCode || city;
  return [
    `${ap} airport to hotels ${city} taxi cost`,
    `${ap} airport to ${city} venue taxi cost`,
    `${ap} airport public transport to ${city}`,
    `car rental prices ${ap} airport`,
    `hotel shuttle ${ap} airport ${city}`,
    `popular taxi rideshare ${city}`,
  ];
}

const TRANSPORT_PROMPT = `You summarize ground transportation options for a traveler flying in.
Cover TWO destinations from the airport: (1) accommodations / lodging area, (2) the event venue.
Reply JSON only:
{
  "summary": "2-4 sentences covering airport→stay and airport→event",
  "items": [{"title":"...","detail":"...","category":"taxi|transit|rental|rideshare|shuttle|other","destination":"accommodations|event|either","priceHint":"$X–$Y or null"}],
  "sources": [{"title":"...","url":"https://..."}]
}
Tag each item destination as accommodations, event, or either.
Never invent exact prices — use ranges only when sources imply them, else null priceHint.
Max 10 items.`;

const STAYS_PROMPT = `You summarize lodging options for a traveler.
Reply JSON only:
{
  "summary": "2-4 sentences on where to stay (hostels, Airbnb, hotels; camping only if weather is camping-friendly)",
  "items": [{"title":"...","detail":"...","category":"hostel|airbnb|hotel|camping|other","priceHint":"$X–$Y/night or null"}],
  "sources": [{"title":"...","url":"https://..."}]
}
Only mention camping if campingSuitable is true in the user message.
Never invent exact prices — ranges only when sources imply them.
Max 8 items.`;

/**
 * @param {{
 *   kind: 'big' | 'notable',
 *   id: string,
 *   type: LogisticsModuleType,
 *   event: object,
 *   weather?: object | null,
 * }} opts
 * @param {NodeJS.ProcessEnv} [env]
 */
async function researchModule(opts, env = process.env) {
  const type = opts.type === 'accommodations' ? 'accommodations' : 'transportation';
  const key = logisticsModuleKey(opts.kind, opts.id, type);
  const event = opts.event || {};
  const city = String(event.city || '').trim().slice(0, 120);
  const coords = resolveLogisticsLatLon(event);
  const airport = coords
    ? nearestInternationalAirport(coords.lat, coords.lon)
    : null;
  const start = String(event.start || '').trim().slice(0, 40) || null;
  const startYmd = start ? start.slice(0, 10) : null;
  const camping =
    type === 'accommodations'
      ? campingWeatherSuitable(opts.weather)
      : { suitable: false, reason: 'n/a' };

  /** @type {LogisticsModuleRecord} */
  const base = {
    key,
    kind: opts.kind === 'notable' ? 'notable' : 'big',
    id: String(opts.id || '').trim(),
    type,
    enabled: true,
    city: city || null,
    ok: false,
    summary: null,
    items: [],
    sources: [],
    campingSuitable: type === 'accommodations' ? camping.suitable : null,
    campingReason: type === 'accommodations' ? camping.reason : null,
    generatedAt: null,
    researching: false,
    error: null,
  };

  if (!key) return { ...base, error: 'missing_key' };
  if (!city && !airport) return { ...base, error: 'missing_city' };

  /** @type {Array<{ url: string, title: string, text: string }>} */
  const collected = [];
  const seen = new Set();
  for (const q of researchQueries(type, city || 'destination', airport?.code || null, startYmd)) {
    const hits = await searchHits(q, 5, env);
    for (const hit of hits.slice(0, 3)) {
      const url = String(hit.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const text = hit.snippet || (await fetchPageText(url));
      if (text.length < 40 && !hit.title) continue;
      collected.push({
        url,
        title: String(hit.title || url).slice(0, 160),
        text: (text || hit.title || '').slice(0, 2000),
      });
      if (collected.length >= 8) break;
    }
    if (collected.length >= 8) break;
    await new Promise((r) => setTimeout(r, 350));
  }

  const snippetBlock = collected.length
    ? collected.map((c, i) => `[${i + 1}] ${c.title}\nURL: ${c.url}\n${c.text}`).join('\n---\n')
    : '(No web snippets retrieved.)';

  const ai = await openRouterChatJson(
    env,
    [
      {
        role: 'system',
        content: type === 'accommodations' ? STAYS_PROMPT : TRANSPORT_PROMPT,
      },
      {
        role: 'user',
        content: [
          `Event: ${String(event.title || opts.id || 'Event').slice(0, 160)}`,
          `City: ${city || 'unknown'}`,
          airport
            ? `Nearest airport: ${airport.name} (${airport.code}) · ${Math.round(airport.miles)} mi`
            : 'Nearest airport: unknown',
          `Dates: ${startYmd || 'unknown'}`,
          type === 'accommodations'
            ? `campingSuitable: ${camping.suitable} (${camping.reason})`
            : 'Cover airport → accommodations AND airport → event venue.',
          '',
          'Research snippets:',
          snippetBlock.slice(0, 12_000),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    {
      xTitle:
        type === 'accommodations'
          ? 'dashbird-events-logistics-stays'
          : 'dashbird-events-logistics-transport',
      maxTokens: 1600,
      timeoutMs: 90_000,
    },
  );

  if (!ai.ok || !ai.parsed || typeof ai.parsed !== 'object') {
    return {
      ...base,
      sources: collected.slice(0, 6).map((c) => ({ title: c.title, url: c.url })),
      generatedAt: new Date().toISOString(),
      error: ai.error || 'summarize_failed',
      ok: false,
      summary: null,
    };
  }

  const parsed = /** @type {Record<string, unknown>} */ (ai.parsed);
  const normalized = normalizeRecord({
    ...base,
    ok: true,
    summary: parsed.summary,
    items: parsed.items,
    sources:
      Array.isArray(parsed.sources) && parsed.sources.length
        ? parsed.sources
        : collected.slice(0, 6).map((c) => ({ title: c.title, url: c.url })),
    generatedAt: new Date().toISOString(),
    researching: false,
    error: null,
  });
  return normalized || { ...base, error: 'normalize_failed', generatedAt: new Date().toISOString() };
}

/**
 * Enable/disable + optionally research a logistics module.
 * @param {{
 *   kind: 'big' | 'notable',
 *   id: string,
 *   type: LogisticsModuleType,
 *   event: object,
 *   weather?: object | null,
 *   enabled?: boolean,
 *   forceRefresh?: boolean,
 *   wait?: boolean,
 * }} opts
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function upsertLogisticsModule(opts, env = process.env) {
  const type = opts.type === 'accommodations' ? 'accommodations' : 'transportation';
  const key = logisticsModuleKey(opts.kind, opts.id, type);
  if (!key) throw new Error('invalid_id');

  const store = await loadStore(env);
  const existing = store[key] || null;
  const enabled = opts.enabled !== false;

  if (!enabled) {
    const disabled = normalizeRecord({
      ...(existing || {}),
      key,
      kind: opts.kind,
      id: opts.id,
      type,
      enabled: false,
      researching: false,
    });
    if (disabled) {
      store[key] = disabled;
      await saveStore(store, env);
      return disabled;
    }
    return {
      key,
      kind: opts.kind === 'notable' ? 'notable' : 'big',
      id: String(opts.id),
      type,
      enabled: false,
      city: null,
      ok: false,
      summary: null,
      items: [],
      sources: [],
      campingSuitable: null,
      campingReason: null,
      generatedAt: null,
      researching: false,
      error: null,
    };
  }

  if (
    existing
    && existing.enabled
    && isLogisticsModuleFresh(existing)
    && opts.forceRefresh !== true
  ) {
    return existing;
  }

  const pending = normalizeRecord({
    ...(existing || {}),
    key,
    kind: opts.kind,
    id: opts.id,
    type,
    enabled: true,
    researching: true,
    error: null,
    city: String(opts.event?.city || existing?.city || '').trim() || null,
  });
  if (pending) {
    store[key] = pending;
    await saveStore(store, env);
  }

  const run = async () => {
    try {
      const researched = await researchModule(
        {
          kind: opts.kind,
          id: opts.id,
          type,
          event: opts.event,
          weather: opts.weather,
        },
        env,
      );
      const next = normalizeRecord({ ...researched, enabled: true, researching: false });
      if (next) {
        const s = await loadStore(env);
        s[key] = next;
        await saveStore(s, env);
        return next;
      }
      return researched;
    } catch (e) {
      const failed = normalizeRecord({
        ...(pending || {}),
        key,
        enabled: true,
        researching: false,
        error: String(e?.message || e).slice(0, 200),
        generatedAt: new Date().toISOString(),
      });
      if (failed) {
        const s = await loadStore(env);
        s[key] = failed;
        await saveStore(s, env);
        return failed;
      }
      throw e;
    } finally {
      inFlightByKey.delete(key);
    }
  };

  if (opts.wait === false) {
    if (!inFlightByKey.has(key)) {
      inFlightByKey.set(key, run());
    }
    return pending;
  }

  if (inFlightByKey.has(key)) {
    return /** @type {Promise<LogisticsModuleRecord>} */ (inFlightByKey.get(key));
  }
  const p = run();
  inFlightByKey.set(key, p);
  return p;
}

/**
 * Static link packs for the UI (no research).
 * @param {object} event
 * @param {object | null | undefined} weather
 */
export function logisticsModuleLinkPacks(event, weather = null) {
  const coords = resolveLogisticsLatLon(event);
  const milesFromBay = milesFromBayArea(event?.lat, event?.lon);
  const outsideBay = isOutsideBayArea(event, 100);
  const nearestAirport = coords
    ? nearestInternationalAirport(coords.lat, coords.lon)
    : null;
  return {
    transportation: buildTransportationModuleLinks(event, {
      nearestAirport: nearestAirport
        ? {
            code: nearestAirport.code,
            name: nearestAirport.name,
            miles: nearestAirport.miles,
          }
        : null,
      outsideBay,
    }),
    accommodations: buildAccommodationsModuleLinks(event, { weather }),
  };
}
