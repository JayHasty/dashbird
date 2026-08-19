/**
 * Daily local-conditions brief for Events Finder logistics.
 * Web research (Brave API or Chrome search) + OpenRouter summary of travel /
 * packing impacts: outages, water, weather alerts, smoke, unrest, elections, etc.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchChromeResultUrls } from './chrome-web-search.js';
import { braveApiEnabled, braveApiWebSearch } from './brave-search-api.js';
import { openRouterChatJson } from './openrouter-chat-json.js';
import { assertPublicHttpUrl } from './public-http-url.js';
import { dataBackupLocalParts } from './data-backup-schedule.js';
import {
  daysUntilEventStart,
  resolveLogisticsLatLon,
} from './events-finder-travel-logistics.js';
import { loadConferenceWatchlistStore } from './events-finder-conference-watchlist-store.js';
import {
  loadNotableEventsStore,
  applyNotableToEvent,
} from './events-finder-notable-store.js';
import { getEventsFinderEventById } from './events-finder-store.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Start researching this many days before event start. */
export const TRAVEL_BRIEF_LEAD_DAYS = 30;

/** Treat a brief as fresh for this long (daily refresh). */
const FRESH_MS = 20 * 60 * 60 * 1000;

const FETCH_UA = 'Dashbird/1.0 (events travel brief; local dashboard)';
const CHECK_MS = 60_000;
const STARTUP_DELAY_MS = 45_000;
const DELAY_BETWEEN_MS = 10_000;

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
/** @type {string | null} */
let lastRunYmd = null;
let dailyInFlight = false;

/** @type {Map<string, Promise<object>>} */
const inFlightByKey = new Map();

/**
 * @typedef {{
 *   key: string,
 *   kind: 'big' | 'notable',
 *   id: string,
 *   city: string | null,
 *   eventStart: string | null,
 *   eventEnd: string | null,
 *   ok: boolean,
 *   summary: string | null,
 *   items: { title: string, detail: string, category: string, packingHint: string | null }[],
 *   packingTips: string[],
 *   sources: { title: string, url: string }[],
 *   nwsAlerts: { event: string, headline: string }[],
 *   generatedAt: string | null,
 *   researching: boolean,
 *   error: string | null,
 * }} TravelBriefRecord
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function travelBriefsStorePath(env = process.env) {
  const override = String(env.EVENTS_FINDER_TRAVEL_BRIEFS_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data', 'events-finder-travel-briefs.json');
}

/**
 * @param {string} kind
 * @param {string} id
 */
export function travelBriefKey(kind, id) {
  const k = kind === 'notable' ? 'notable' : 'big';
  const i = String(id || '').trim().slice(0, 200);
  return i ? `${k}:${i}` : '';
}

/**
 * @param {unknown} raw
 * @returns {TravelBriefRecord | null}
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const key = String(r.key || '').trim().slice(0, 220);
  if (!key) return null;
  const kind = key.startsWith('notable:') ? 'notable' : 'big';
  const id = key.slice(key.indexOf(':') + 1);

  /** @type {TravelBriefRecord['items']} */
  const items = [];
  if (Array.isArray(r.items)) {
    for (const row of r.items.slice(0, 12)) {
      if (!row || typeof row !== 'object') continue;
      const o = /** @type {Record<string, unknown>} */ (row);
      const title = String(o.title || '').trim().slice(0, 160);
      if (!title) continue;
      items.push({
        title,
        detail: String(o.detail || '').trim().slice(0, 500),
        category: String(o.category || 'other').trim().slice(0, 40) || 'other',
        packingHint:
          o.packingHint != null && String(o.packingHint).trim()
            ? String(o.packingHint).trim().slice(0, 200)
            : null,
      });
    }
  }

  /** @type {string[]} */
  const packingTips = [];
  if (Array.isArray(r.packingTips)) {
    for (const tip of r.packingTips) {
      const t = String(tip || '').trim().slice(0, 240);
      if (t) packingTips.push(t);
      if (packingTips.length >= 10) break;
    }
  }

  /** @type {TravelBriefRecord['sources']} */
  const sources = [];
  if (Array.isArray(r.sources)) {
    for (const row of r.sources.slice(0, 10)) {
      if (!row || typeof row !== 'object') continue;
      const o = /** @type {Record<string, unknown>} */ (row);
      const url = String(o.url || '').trim().slice(0, 800);
      if (!/^https?:\/\//i.test(url)) continue;
      sources.push({
        title: String(o.title || url).trim().slice(0, 160),
        url,
      });
    }
  }

  /** @type {TravelBriefRecord['nwsAlerts']} */
  const nwsAlerts = [];
  if (Array.isArray(r.nwsAlerts)) {
    for (const row of r.nwsAlerts.slice(0, 8)) {
      if (!row || typeof row !== 'object') continue;
      const o = /** @type {Record<string, unknown>} */ (row);
      const event = String(o.event || '').trim().slice(0, 120);
      if (!event) continue;
      nwsAlerts.push({
        event,
        headline: String(o.headline || '').trim().slice(0, 280),
      });
    }
  }

  return {
    key,
    kind,
    id,
    city: String(r.city || '').trim().slice(0, 120) || null,
    eventStart: String(r.eventStart || '').trim().slice(0, 40) || null,
    eventEnd: String(r.eventEnd || '').trim().slice(0, 40) || null,
    ok: r.ok !== false,
    summary: r.summary != null && String(r.summary).trim()
      ? String(r.summary).trim().slice(0, 2000)
      : null,
    items,
    packingTips,
    sources,
    nwsAlerts,
    generatedAt: String(r.generatedAt || '').trim().slice(0, 40) || null,
    researching: r.researching === true,
    error: r.error != null && String(r.error).trim()
      ? String(r.error).trim().slice(0, 240)
      : null,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Record<string, TravelBriefRecord>>}
 */
export async function loadTravelBriefsStore(env = process.env) {
  try {
    const raw = JSON.parse(await fs.readFile(travelBriefsStorePath(env), 'utf8'));
    const records = raw?.records && typeof raw.records === 'object' ? raw.records : {};
    /** @type {Record<string, TravelBriefRecord>} */
    const out = {};
    for (const [k, v] of Object.entries(records)) {
      const n = normalizeRecord({ .../** @type {object} */ (v), key: k });
      if (n) out[n.key] = n;
    }
    return out;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e)?.code === 'ENOENT') return {};
    throw e;
  }
}

/**
 * @param {Record<string, TravelBriefRecord>} records
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveTravelBriefsStore(records, env = process.env) {
  const filePath = travelBriefsStorePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  /** @type {Record<string, TravelBriefRecord>} */
  const clean = {};
  for (const [k, v] of Object.entries(records || {})) {
    const n = normalizeRecord({ ...v, key: k });
    if (n) clean[n.key] = n;
  }
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), records: clean }, null, 2)}\n`,
    'utf8',
  );
  return clean;
}

/**
 * @param {string} kind
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function getTravelBrief(kind, id, env = process.env) {
  const key = travelBriefKey(kind, id);
  if (!key) return null;
  const store = await loadTravelBriefsStore(env);
  return store[key] || null;
}

/**
 * @param {TravelBriefRecord | null | undefined} brief
 * @param {Date} [now]
 */
export function isTravelBriefFresh(brief, now = new Date()) {
  if (!brief?.generatedAt || !brief.ok || !brief.summary) return false;
  const at = Date.parse(brief.generatedAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at < FRESH_MS;
}

/**
 * @param {{
 *   start?: string | null,
 *   end?: string | null,
 *   city?: string | null,
 *   lat?: number | null,
 *   lon?: number | null,
 * }} event
 * @param {Date} [now]
 */
export function isTravelBriefEligible(event, now = new Date()) {
  const city = String(event?.city || '').trim();
  const coords = resolveLogisticsLatLon(event);
  if (!city && !coords) return false;
  const until = daysUntilEventStart(event?.start, now);
  if (until == null) return Boolean(city || coords);
  if (until > TRAVEL_BRIEF_LEAD_DAYS) return false;
  const endMs = Date.parse(String(event?.end || event?.start || ''));
  if (Number.isFinite(endMs)) {
    const endDay = Date.UTC(
      new Date(endMs).getUTCFullYear(),
      new Date(endMs).getUTCMonth(),
      new Date(endMs).getUTCDate(),
    );
    const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (nowDay > endDay) return false;
  } else if (until < -1) {
    return false;
  }
  return true;
}

/**
 * @param {string} url
 * @returns {Promise<string>}
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
      .slice(0, 8_000);
  } catch {
    return '';
  }
}

/**
 * @param {string} query
 * @param {number} limit
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<Array<{ url: string, title: string, snippet: string }>>}
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
 * @param {number} lat
 * @param {number} lon
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<TravelBriefRecord['nwsAlerts']>}
 */
async function fetchNwsAlerts(lat, lon, env = process.env) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  // NWS covers US territories only.
  if (lat < 15 || lat > 72 || lon < -180 || lon > -60) return [];
  const ua =
    String(env.NWS_USER_AGENT || '').trim()
    || 'Dashbird/1.0 (dashbird dashboard; events travel brief)';
  try {
    const url = `https://api.weather.gov/alerts/active?point=${encodeURIComponent(`${lat},${lon}`)}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': ua, Accept: 'application/geo+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    const features = Array.isArray(j?.features) ? j.features : [];
    /** @type {TravelBriefRecord['nwsAlerts']} */
    const out = [];
    for (const f of features.slice(0, 8)) {
      const p = f?.properties || {};
      const event = String(p.event || '').trim();
      if (!event) continue;
      out.push({
        event: event.slice(0, 120),
        headline: String(p.headline || '').trim().slice(0, 280),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * @param {string} city
 * @param {string | null} startYmd
 * @param {string | null} endYmd
 */
function researchQueries(city, startYmd, endYmd) {
  const place = String(city || '').trim();
  const when =
    startYmd && endYmd && startYmd !== endYmd
      ? `${startYmd} to ${endYmd}`
      : startYmd || 'upcoming';
  return [
    `${place} local news ${when}`,
    `${place} power outage OR blackout OR water advisory OR boil water`,
    `${place} wildfire smoke OR air quality OR weather advisory`,
    `${place} protest OR demonstration OR civil unrest OR election`,
    `${place} transit strike OR airport delay OR travel disruption`,
  ];
}

const SYSTEM_PROMPT = `You write a practical travel brief for someone visiting a city for an event.
Focus only on things that affect travel, safety, comfort, or packing around the event dates.
Prioritize: power/utility outages, drinking-water advisories, weather alerts, wildfire smoke / air quality,
civil unrest or local tension, elections or large demonstrations, transit/airport disruptions, health alerts.
Ignore sports scores, celebrity gossip, and unrelated national politics unless they create local disruption.
Reply JSON only:
{
  "summary": "2-4 sentences on what the area is going through relevant to a visitor",
  "items": [{"title":"...","detail":"...","category":"power|water|weather|smoke|unrest|election|transit|health|other","packingHint":"optional short tip or null"}],
  "packingTips": ["short actionable packing or prep tips"],
  "sources": [{"title":"...","url":"https://..."}]
}
Use only the provided research. If nothing notable, say so calmly in summary and return empty items/packingTips.
Never invent incidents. Prefer concrete, current/local items. Max 6 items, max 6 packing tips.`;

/**
 * @param {{
 *   kind: 'big' | 'notable',
 *   id: string,
 *   city: string,
 *   start?: string | null,
 *   end?: string | null,
 *   lat?: number | null,
 *   lon?: number | null,
 *   title?: string | null,
 * }} event
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<TravelBriefRecord>}
 */
export async function researchTravelBrief(event, env = process.env) {
  const key = travelBriefKey(event.kind, event.id);
  const city = String(event.city || '').trim().slice(0, 120);
  const start = String(event.start || '').trim().slice(0, 40) || null;
  const end = String(event.end || '').trim().slice(0, 40) || null;
  const startYmd = start ? start.slice(0, 10) : null;
  const endYmd = end ? end.slice(0, 10) : startYmd;

  /** @type {TravelBriefRecord} */
  const base = {
    key,
    kind: event.kind === 'notable' ? 'notable' : 'big',
    id: String(event.id || '').trim(),
    city: city || null,
    eventStart: start,
    eventEnd: end,
    ok: false,
    summary: null,
    items: [],
    packingTips: [],
    sources: [],
    nwsAlerts: [],
    generatedAt: null,
    researching: false,
    error: null,
  };

  if (!key || !city) {
    return { ...base, error: city ? 'missing_key' : 'missing_city' };
  }

  const coords =
    event.lat != null && event.lon != null
      ? { lat: Number(event.lat), lon: Number(event.lon) }
      : resolveLogisticsLatLon({ city, lat: event.lat, lon: event.lon });

  const nwsAlerts = coords
    ? await fetchNwsAlerts(coords.lat, coords.lon, env)
    : [];

  /** @type {Array<{ url: string, title: string, text: string }>} */
  const collected = [];
  const seen = new Set();

  for (const q of researchQueries(city, startYmd, endYmd)) {
    const hits = await searchHits(q, 5, env);
    for (const hit of hits.slice(0, 3)) {
      const url = String(hit.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const text = hit.snippet || (await fetchPageText(url));
      if (text.length < 60 && !hit.title) continue;
      collected.push({
        url,
        title: String(hit.title || url).slice(0, 160),
        text: (text || hit.title || '').slice(0, 2500),
      });
      if (collected.length >= 8) break;
    }
    if (collected.length >= 8) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  const nwsBlock = nwsAlerts.length
    ? `\nActive NWS alerts:\n${nwsAlerts.map((a) => `- ${a.event}: ${a.headline}`).join('\n')}`
    : '\nNo active NWS alerts for this point (or outside NWS coverage).';

  const snippetBlock = collected.length
    ? collected.map((c, i) => `[${i + 1}] ${c.title}\nURL: ${c.url}\n${c.text}`).join('\n---\n')
    : '(No web snippets retrieved.)';

  const ai = await openRouterChatJson(
    env,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `Event: ${String(event.title || event.id || 'Event').slice(0, 160)}`,
          `City: ${city}`,
          `Travel window: ${startYmd || 'unknown'}${endYmd && endYmd !== startYmd ? ` → ${endYmd}` : ''}`,
          nwsBlock,
          '',
          'Research snippets:',
          snippetBlock.slice(0, 14_000),
        ].join('\n'),
      },
    ],
    {
      xTitle: 'dashbird-events-travel-brief',
      maxTokens: 1800,
      timeoutMs: 90_000,
    },
  );

  if (!ai.ok || !ai.parsed || typeof ai.parsed !== 'object') {
    return {
      ...base,
      nwsAlerts,
      sources: collected.slice(0, 6).map((c) => ({ title: c.title, url: c.url })),
      generatedAt: new Date().toISOString(),
      error: ai.error || 'summarize_failed',
      ok: nwsAlerts.length > 0,
      summary:
        nwsAlerts.length > 0
          ? `Active weather alerts near ${city}: ${nwsAlerts.map((a) => a.event).join('; ')}.`
          : null,
      items: nwsAlerts.map((a) => ({
        title: a.event,
        detail: a.headline || a.event,
        category: 'weather',
        packingHint: null,
      })),
    };
  }

  const parsed = /** @type {Record<string, unknown>} */ (ai.parsed);
  const normalized = normalizeRecord({
    ...base,
    ok: true,
    summary: parsed.summary,
    items: parsed.items,
    packingTips: parsed.packingTips,
    sources: Array.isArray(parsed.sources) && parsed.sources.length
      ? parsed.sources
      : collected.slice(0, 6).map((c) => ({ title: c.title, url: c.url })),
    nwsAlerts,
    generatedAt: new Date().toISOString(),
    researching: false,
    error: null,
  });

  return normalized || { ...base, error: 'normalize_failed', generatedAt: new Date().toISOString() };
}

/**
 * Research + persist. Dedupes concurrent runs for the same key.
 * @param {{
 *   kind: 'big' | 'notable',
 *   id: string,
 *   city: string,
 *   start?: string | null,
 *   end?: string | null,
 *   lat?: number | null,
 *   lon?: number | null,
 *   title?: string | null,
 * }} event
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ force?: boolean }} [opts]
 */
export async function refreshTravelBrief(event, env = process.env, opts = {}) {
  const key = travelBriefKey(event.kind, event.id);
  if (!key) {
    return {
      key: '',
      kind: event.kind === 'notable' ? 'notable' : 'big',
      id: String(event.id || ''),
      city: null,
      eventStart: null,
      eventEnd: null,
      ok: false,
      summary: null,
      items: [],
      packingTips: [],
      sources: [],
      nwsAlerts: [],
      generatedAt: null,
      researching: false,
      error: 'missing_key',
    };
  }

  if (!opts.force) {
    const existing = await getTravelBrief(event.kind, event.id, env);
    if (isTravelBriefFresh(existing)) return /** @type {TravelBriefRecord} */ (existing);
  }

  const pending = inFlightByKey.get(key);
  if (pending) return pending;

  const run = (async () => {
    const store = await loadTravelBriefsStore(env);
    const prev = store[key];
    store[key] = normalizeRecord({
      ...(prev || {}),
      key,
      kind: event.kind,
      id: event.id,
      city: event.city,
      eventStart: event.start || null,
      eventEnd: event.end || null,
      researching: true,
      error: null,
    }) || store[key];
    await saveTravelBriefsStore(store, env);

    try {
      const brief = await researchTravelBrief(event, env);
      const next = await loadTravelBriefsStore(env);
      next[key] = { ...brief, researching: false };
      await saveTravelBriefsStore(next, env);
      return next[key];
    } catch (e) {
      const next = await loadTravelBriefsStore(env);
      const err = String(e?.message || e || 'research_failed').slice(0, 240);
      next[key] = normalizeRecord({
        ...(next[key] || prev || { key, kind: event.kind, id: event.id }),
        researching: false,
        ok: false,
        error: err,
        generatedAt: new Date().toISOString(),
      }) || next[key];
      await saveTravelBriefsStore(next, env);
      return next[key];
    } finally {
      inFlightByKey.delete(key);
    }
  })();

  inFlightByKey.set(key, run);
  return run;
}

/**
 * API-facing trim of a brief record.
 * @param {TravelBriefRecord | null | undefined} brief
 */
export function publicTravelBrief(brief) {
  if (!brief) return null;
  return {
    ok: brief.ok === true,
    city: brief.city,
    summary: brief.summary,
    items: brief.items,
    packingTips: brief.packingTips,
    sources: brief.sources,
    nwsAlerts: brief.nwsAlerts,
    generatedAt: brief.generatedAt,
    researching: brief.researching === true,
    error: brief.error,
    fresh: isTravelBriefFresh(brief),
    leadDays: TRAVEL_BRIEF_LEAD_DAYS,
  };
}

/**
 * Ensure a brief exists for logistics: return cache, refresh if stale/missing.
 * @param {{
 *   kind: 'big' | 'notable',
 *   id: string,
 *   city?: string | null,
 *   start?: string | null,
 *   end?: string | null,
 *   lat?: number | null,
 *   lon?: number | null,
 *   title?: string | null,
 * }} event
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ wait?: boolean }} [opts]
 */
export async function ensureTravelBriefForLogistics(event, env = process.env, opts = {}) {
  const city = String(event.city || '').trim();
  if (!isTravelBriefEligible({ ...event, city }, new Date())) {
    return { eligible: false, brief: null };
  }
  if (!city) {
    return { eligible: true, brief: null };
  }

  const cached = await getTravelBrief(event.kind, event.id, env);
  if (isTravelBriefFresh(cached) && !cached?.researching) {
    return { eligible: true, brief: cached };
  }

  const wait = opts.wait !== false;
  if (!wait) {
    void refreshTravelBrief(
      {
        kind: event.kind,
        id: event.id,
        city,
        start: event.start,
        end: event.end,
        lat: event.lat,
        lon: event.lon,
        title: event.title,
      },
      env,
      { force: !isTravelBriefFresh(cached) },
    );
    return { eligible: true, brief: cached };
  }

  const brief = await refreshTravelBrief(
    {
      kind: event.kind,
      id: event.id,
      city,
      start: event.start,
      end: event.end,
      lat: event.lat,
      lon: event.lon,
      title: event.title,
    },
    env,
    { force: true },
  );
  return { eligible: true, brief };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function travelBriefDailyRefreshEnabled(env = process.env) {
  return String(env.TRAVEL_BRIEF_DAILY_REFRESH ?? '1').trim() !== '0';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function refreshHour(env = process.env) {
  const n = Number(env.TRAVEL_BRIEF_DAILY_REFRESH_HOUR);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.round(n) : 5;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function refreshTz(env = process.env) {
  return (
    String(env.TRAVEL_BRIEF_DAILY_REFRESH_TZ || env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles'
  );
}

/**
 * Collect eligible Big Events + notable events for daily refresh.
 * @param {NodeJS.ProcessEnv} [env]
 */
async function listEligibleTravelBriefTargets(env = process.env) {
  const now = new Date();
  /** @type {Array<{
   *   kind: 'big' | 'notable',
   *   id: string,
   *   city: string,
   *   start?: string | null,
   *   end?: string | null,
   *   lat?: number | null,
   *   lon?: number | null,
   *   title?: string | null,
   * }>} */
  const out = [];

  const conf = await loadConferenceWatchlistStore(env);
  for (const [slug, rec] of Object.entries(conf.bySlug || {})) {
    if (rec?.skipped === true) continue;
    const city = String(rec.city || '').trim();
    if (!city) continue;
    const start = rec.eventStart || null;
    const end = rec.eventEnd || start;
    if (!isTravelBriefEligible({ city, start, end }, now)) continue;
    out.push({
      kind: 'big',
      id: slug,
      city,
      start,
      end,
      title: rec.name || rec.query || slug,
    });
  }

  const notableStore = await loadNotableEventsStore(env);
  for (const [id, notable] of Object.entries(notableStore)) {
    const event = getEventsFinderEventById(id, env);
    if (!event) continue;
    const merged = applyNotableToEvent(event, notable);
    const city = String(merged.city || '').trim();
    if (!city) continue;
    if (!isTravelBriefEligible(merged, now)) continue;
    const coords = resolveLogisticsLatLon(merged);
    out.push({
      kind: 'notable',
      id,
      city,
      start: merged.start || null,
      end: merged.end || merged.start || null,
      lat: coords?.lat ?? merged.lat ?? null,
      lon: coords?.lon ?? merged.lon ?? null,
      title: merged.title || id,
    });
  }

  return out;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ count: number, ok: number }>}
 */
export async function runTravelBriefDailyRefresh(env = process.env) {
  const targets = await listEligibleTravelBriefTargets(env);
  let ok = 0;
  for (const t of targets) {
    try {
      const brief = await refreshTravelBrief(t, env, { force: true });
      if (brief?.ok && brief.summary) ok += 1;
    } catch (e) {
      console.warn('[travel-brief] daily refresh failed for', t.kind, t.id, e?.message || e);
    }
    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_MS));
  }
  return { count: targets.length, ok };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startTravelBriefDailyRefreshScheduler(env = process.env) {
  if (!travelBriefDailyRefreshEnabled(env)) {
    console.log('[travel-brief] daily refresh disabled');
    return;
  }
  if (timer) return;

  const hour = refreshHour(env);
  const zone = refreshTz(env);
  console.log(`[travel-brief] daily refresh: ${String(hour).padStart(2, '0')}:00 ${zone}`);

  const tick = async () => {
    if (dailyInFlight) return;
    const local = dataBackupLocalParts(new Date(), zone);
    if (local.hour !== hour) return;
    if (lastRunYmd === local.ymd) return;
    dailyInFlight = true;
    lastRunYmd = local.ymd;
    console.log(`[travel-brief] daily refresh starting (${local.ymd})`);
    try {
      const r = await runTravelBriefDailyRefresh(env);
      console.log(`[travel-brief] daily refresh done (${r.ok}/${r.count})`);
    } catch (e) {
      console.warn('[travel-brief] daily refresh failed', e?.message || e);
      lastRunYmd = null;
    } finally {
      dailyInFlight = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, CHECK_MS);
  if (typeof timer.unref === 'function') timer.unref();

  setTimeout(() => {
    void tick();
  }, STARTUP_DELAY_MS);
}
