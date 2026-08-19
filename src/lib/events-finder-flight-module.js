/**
 * Opt-in Google Flights module for Big Events / notable travel.
 * Live quotes via headless Chrome → Google Flights; price history for buy-by + tier.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withChromePage } from './chrome-web-search.js';
import {
  nearestInternationalAirport,
  resolveLogisticsLatLon,
  BAY_AREA_CENTER,
} from './events-finder-travel-logistics.js';
import { haversineMiles } from './dashboard-geo.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Prefer departures at or after 9:45am local. */
export const MIN_DEPART_MINUTES = 9 * 60 + 45;

const DEFAULT_ORIGINS = Object.freeze(['SFO', 'OAK']);
const HISTORY_CAP = 48;
const CHECK_EVERY_MS = 2 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   origin: string,
 *   destination: string,
 *   departDate: string,
 *   airline: string | null,
 *   departTime: string | null,
 *   arriveTime: string | null,
 *   duration: string | null,
 *   stops: number | null,
 *   priceUsd: number,
 *   score: number,
 *   googleFlightsUrl: string,
 * }} FlightOffer
 */

/**
 * @typedef {{
 *   key: string,
 *   kind: 'big' | 'notable',
 *   id: string,
 *   enabled: boolean,
 *   origins: string[],
 *   destination: string | null,
 *   destinationCity: string | null,
 *   departDate: string | null,
 *   eventStart: string | null,
 *   cheapest: FlightOffer | null,
 *   best: FlightOffer | null,
 *   priceTier: 'low' | 'med' | 'high' | null,
 *   buyByDate: string | null,
 *   buyByReason: string | null,
 *   priceHistory: { at: string, cheapestUsd: number, bestUsd: number | null }[],
 *   googleFlightsUrl: string | null,
 *   lastCheckedAt: string | null,
 *   nextCheckAt: string | null,
 *   checking: boolean,
 *   error: string | null,
 * }} FlightModuleRecord
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function flightModulesStorePath(env = process.env) {
  const override = String(env.EVENTS_FINDER_FLIGHT_MODULES_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data', 'events-finder-flight-modules.json');
}

/**
 * @param {string} kind
 * @param {string} id
 */
export function flightModuleKey(kind, id) {
  const k = kind === 'notable' ? 'notable' : 'big';
  const i = String(id || '').trim().slice(0, 200);
  return i ? `${k}:${i}` : '';
}

/**
 * @param {unknown} raw
 * @returns {FlightModuleRecord | null}
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const key = String(r.key || '').trim().slice(0, 220);
  if (!key) return null;
  const kind = key.startsWith('notable:') ? 'notable' : 'big';
  const id = key.slice(key.indexOf(':') + 1);
  const origins = Array.isArray(r.origins)
    ? r.origins.map((o) => String(o || '').trim().toUpperCase()).filter(Boolean).slice(0, 4)
    : [...DEFAULT_ORIGINS];
  /** @type {{ at: string, cheapestUsd: number, bestUsd: number | null }[]} */
  const priceHistory = [];
  if (Array.isArray(r.priceHistory)) {
    for (const row of r.priceHistory.slice(-HISTORY_CAP)) {
      if (!row || typeof row !== 'object') continue;
      const at = String(/** @type {Record<string, unknown>} */ (row).at || '').trim();
      const cheapestUsd = Number(/** @type {Record<string, unknown>} */ (row).cheapestUsd);
      const bestUsdRaw = /** @type {Record<string, unknown>} */ (row).bestUsd;
      const bestUsd = bestUsdRaw == null || bestUsdRaw === '' ? null : Number(bestUsdRaw);
      if (!at || !Number.isFinite(cheapestUsd)) continue;
      priceHistory.push({
        at,
        cheapestUsd,
        bestUsd: Number.isFinite(bestUsd) ? bestUsd : null,
      });
    }
  }
  return {
    key,
    kind,
    id,
    enabled: r.enabled === true,
    origins: origins.length ? origins : [...DEFAULT_ORIGINS],
    destination: String(r.destination || '').trim().toUpperCase().slice(0, 8) || null,
    destinationCity: String(r.destinationCity || '').trim().slice(0, 80) || null,
    departDate: String(r.departDate || '').trim().slice(0, 10) || null,
    eventStart: String(r.eventStart || '').trim().slice(0, 40) || null,
    cheapest: normalizeOffer(r.cheapest),
    best: normalizeOffer(r.best),
    priceTier: r.priceTier === 'low' || r.priceTier === 'med' || r.priceTier === 'high'
      ? r.priceTier
      : null,
    buyByDate: String(r.buyByDate || '').trim().slice(0, 10) || null,
    buyByReason: String(r.buyByReason || '').trim().slice(0, 240) || null,
    priceHistory,
    googleFlightsUrl: String(r.googleFlightsUrl || '').trim().slice(0, 800) || null,
    lastCheckedAt: String(r.lastCheckedAt || '').trim().slice(0, 40) || null,
    nextCheckAt: String(r.nextCheckAt || '').trim().slice(0, 40) || null,
    checking: r.checking === true,
    error: String(r.error || '').trim().slice(0, 240) || null,
  };
}

/**
 * @param {unknown} raw
 * @returns {FlightOffer | null}
 */
function normalizeOffer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const priceUsd = Number(o.priceUsd);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  return {
    origin: String(o.origin || '').trim().toUpperCase().slice(0, 8),
    destination: String(o.destination || '').trim().toUpperCase().slice(0, 8),
    departDate: String(o.departDate || '').trim().slice(0, 10),
    airline: o.airline != null ? String(o.airline).trim().slice(0, 80) : null,
    departTime: o.departTime != null ? String(o.departTime).trim().slice(0, 20) : null,
    arriveTime: o.arriveTime != null ? String(o.arriveTime).trim().slice(0, 20) : null,
    duration: o.duration != null ? String(o.duration).trim().slice(0, 40) : null,
    stops: o.stops == null || o.stops === '' ? null : Math.max(0, Math.round(Number(o.stops))),
    priceUsd: Math.round(priceUsd),
    score: Number.isFinite(Number(o.score)) ? Number(o.score) : 0,
    googleFlightsUrl: String(o.googleFlightsUrl || '').trim().slice(0, 800),
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Record<string, FlightModuleRecord>>}
 */
export async function loadFlightModulesStore(env = process.env) {
  try {
    const raw = JSON.parse(await fs.readFile(flightModulesStorePath(env), 'utf8'));
    const records = raw?.records && typeof raw.records === 'object' ? raw.records : {};
    /** @type {Record<string, FlightModuleRecord>} */
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
 * @param {Record<string, FlightModuleRecord>} records
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveFlightModulesStore(records, env = process.env) {
  const filePath = flightModulesStorePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  /** @type {Record<string, FlightModuleRecord>} */
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
export async function getFlightModule(kind, id, env = process.env) {
  const key = flightModuleKey(kind, id);
  if (!key) return null;
  const store = await loadFlightModulesStore(env);
  return store[key] || null;
}

/**
 * @param {string} iso
 * @returns {string}
 */
function ymd(iso) {
  const d = Date.parse(String(iso || ''));
  if (!Number.isFinite(d)) return '';
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Suggest outbound date: day before event when start is before noon, else same day.
 * @param {string | null | undefined} eventStart
 */
export function suggestDepartDate(eventStart) {
  const start = String(eventStart || '').trim();
  const ms = Date.parse(start);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const hour = d.getUTCHours();
  // Event times are often date-only (T00:00Z) or local morning — leave a day early
  // when the clock is before 14:00 UTC (~morning West Coast).
  if (hour < 14 || /^\d{4}-\d{2}-\d{2}$/.test(start)) {
    const prev = new Date(ms - 24 * 60 * 60 * 1000);
    return prev.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * @param {string} origin
 * @param {string} dest airport code or city name
 * @param {string} date
 */
export function googleFlightsSearchUrl(origin, dest, date) {
  const o = String(origin || 'SFO').toUpperCase();
  const d = String(dest || '').trim();
  const day = String(date || '').trim();
  const destLabel = /^[A-Z]{3}$/.test(d.toUpperCase()) ? d.toUpperCase() : d;
  const q = day
    ? `One way flights from ${o} to ${destLabel} on ${day}`
    : `One way flights from ${o} to ${destLabel}`;
  return `https://www.google.com/travel/flights?hl=en&curr=USD&q=${encodeURIComponent(q)}`;
}

/**
 * Parse "9:45 AM" / "21:30" → minutes from midnight.
 * @param {string | null | undefined} t
 * @returns {number | null}
 */
export function parseClockToMinutes(t) {
  const s = String(t || '').trim();
  if (!s) return null;
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = Number(m12[1]);
    const min = Number(m12[2]);
    const ap = m12[3].toUpperCase();
    if (ap === 'AM') {
      if (h === 12) h = 0;
    } else if (h !== 12) h += 12;
    return h * 60 + min;
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return Number(m24[1]) * 60 + Number(m24[2]);
  return null;
}

/**
 * @param {string | null | undefined} duration
 * @returns {number | null} minutes
 */
function parseDurationMinutes(duration) {
  const s = String(duration || '');
  const h = s.match(/(\d+)\s*h/i);
  const m = s.match(/(\d+)\s*m/i);
  if (!h && !m) return null;
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

/**
 * Score: lower is better. Prefer fewer stops, shorter duration, later morning departures,
 * and arriving with buffer before event start.
 * @param {FlightOffer} offer
 * @param {{ eventStartMs?: number | null }} [opts]
 */
export function scoreFlightOffer(offer, opts = {}) {
  let score = offer.priceUsd;
  const stops = offer.stops == null ? 1 : offer.stops;
  score += stops * 55;
  const dur = parseDurationMinutes(offer.duration);
  if (dur != null) score += dur * 0.15;
  const depMin = parseClockToMinutes(offer.departTime);
  if (depMin != null && depMin < MIN_DEPART_MINUTES) {
    score += (MIN_DEPART_MINUTES - depMin) * 2.5;
  }
  if (Number.isFinite(opts.eventStartMs) && offer.arriveTime && offer.departDate) {
    // Soft penalty only — arrival clock without TZ is approximate.
    const arrMin = parseClockToMinutes(offer.arriveTime);
    if (arrMin != null) {
      const arriveGuess = Date.parse(`${offer.departDate}T${String(Math.floor(arrMin / 60)).padStart(2, '0')}:${String(arrMin % 60).padStart(2, '0')}:00Z`);
      if (Number.isFinite(arriveGuess) && arriveGuess > opts.eventStartMs - 3 * 60 * 60 * 1000) {
        score += 80;
      }
    }
  }
  return Math.round(score);
}

/**
 * @param {FlightOffer[]} offers
 * @param {{ eventStart?: string | null, minDepartMinutes?: number }} [opts]
 */
export function pickCheapestAndBest(offers, opts = {}) {
  const minDep = Number.isFinite(opts.minDepartMinutes) ? Number(opts.minDepartMinutes) : MIN_DEPART_MINUTES;
  const eventStartMs = Date.parse(String(opts.eventStart || ''));
  const scored = (Array.isArray(offers) ? offers : [])
    .filter((o) => o && Number.isFinite(o.priceUsd) && o.priceUsd > 0)
    .map((o) => {
      const withScore = { ...o, score: scoreFlightOffer(o, { eventStartMs }) };
      return withScore;
    });

  const preferred = scored.filter((o) => {
    const m = parseClockToMinutes(o.departTime);
    return m == null || m >= minDep;
  });
  const pool = preferred.length ? preferred : scored;

  /** @type {FlightOffer | null} */
  let cheapest = null;
  /** @type {FlightOffer | null} */
  let best = null;
  for (const o of pool) {
    if (!cheapest || o.priceUsd < cheapest.priceUsd) cheapest = o;
    if (!best || o.score < best.score) best = o;
  }
  return { cheapest, best, offers: pool };
}

/**
 * @param {number} priceUsd
 * @param {{ at: string, cheapestUsd: number }[]} history
 * @returns {'low' | 'med' | 'high'}
 */
export function classifyPriceTier(priceUsd, history) {
  const prices = (history || [])
    .map((h) => Number(h.cheapestUsd))
    .filter((n) => Number.isFinite(n) && n > 0);
  prices.push(priceUsd);
  if (prices.length < 2) {
    // Single observation: treat mid-range default until we have history.
    return 'med';
  }
  const sorted = [...prices].sort((a, b) => a - b);
  const p33 = sorted[Math.floor((sorted.length - 1) * 0.33)];
  const p66 = sorted[Math.floor((sorted.length - 1) * 0.66)];
  if (priceUsd <= p33) return 'low';
  if (priceUsd >= p66) return 'high';
  return 'med';
}

/**
 * Suggest a buy-by date from price history + days-to-departure rules of thumb.
 * @param {{ at: string, cheapestUsd: number }[]} history
 * @param {string | null | undefined} departDate
 * @param {'low' | 'med' | 'high' | null} tier
 */
export function suggestBuyByDate(history, departDate, tier) {
  const dep = String(departDate || '').trim();
  const depMs = Date.parse(`${dep}T12:00:00Z`);
  const now = Date.now();
  if (!Number.isFinite(depMs)) {
    return { buyByDate: null, buyByReason: null };
  }
  const daysOut = Math.round((depMs - now) / (24 * 60 * 60 * 1000));
  const ymdFromMs = (ms) => new Date(ms).toISOString().slice(0, 10);

  const samples = (history || [])
    .map((h) => ({ at: Date.parse(h.at), usd: Number(h.cheapestUsd) }))
    .filter((h) => Number.isFinite(h.at) && Number.isFinite(h.usd))
    .sort((a, b) => a.at - b.at);

  let rising = false;
  if (samples.length >= 3) {
    const last3 = samples.slice(-3);
    rising = last3[2].usd > last3[0].usd * 1.04;
  }

  // Classic domestic/short-haul: prices often climb inside ~3 weeks.
  const hardCeiling = depMs - 21 * 24 * 60 * 60 * 1000;
  // International / long lead: start watching ~8 weeks out.
  const softTarget = depMs - 45 * 24 * 60 * 60 * 1000;

  if (daysOut <= 10) {
    return {
      buyByDate: ymdFromMs(now),
      buyByReason: 'Departure is within 10 days — buy now before last-minute fares spike.',
    };
  }
  if (tier === 'low' || rising) {
    const soon = Math.min(now + 2 * 24 * 60 * 60 * 1000, hardCeiling);
    return {
      buyByDate: ymdFromMs(Math.max(now, soon)),
      buyByReason: rising
        ? 'Recent checks show fares rising — buy before the next jump.'
        : 'Current fare looks low vs recent checks — good window to buy.',
    };
  }
  if (tier === 'high' && daysOut > 28) {
    const waitUntil = Math.min(softTarget, hardCeiling);
    return {
      buyByDate: ymdFromMs(Math.max(now + 5 * 24 * 60 * 60 * 1000, waitUntil)),
      buyByReason: 'Fare looks high vs history — wait a bit, but buy by ~3 weeks before departure.',
    };
  }
  const target = Math.min(Math.max(now + 7 * 24 * 60 * 60 * 1000, softTarget), hardCeiling);
  return {
    buyByDate: ymdFromMs(Math.max(now, target)),
    buyByReason:
      daysOut > 45
        ? 'Aim to lock a ticket about 6–8 weeks out; reassess every few hours.'
        : 'Buy within the next couple of weeks before the typical 21-day price climb.',
  };
}

/**
 * Scrape Google Flights results with Playwright.
 * @param {{ origin: string, destination: string, date: string }} params
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ offers: FlightOffer[], error: string | null }>}
 */
export async function scrapeGoogleFlights(params, env = process.env) {
  const origin = String(params.origin || 'SFO').toUpperCase();
  const destination = String(params.destination || '').trim();
  const date = String(params.date || '').trim();
  if (!destination) {
    return { offers: [], error: 'invalid_destination' };
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { offers: [], error: 'invalid_depart_date' };
  }
  const destCode = /^[A-Z]{3}$/i.test(destination) ? destination.toUpperCase() : destination;
  const url = googleFlightsSearchUrl(origin, destCode, date);

  const scraped = await withChromePage(
    async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 28_000 });
      // Consent / cookie banners
      await page
        .evaluate(() => {
          const buttons = [...document.querySelectorAll('button, [role="button"]')];
          for (const b of buttons) {
            const t = String(b.textContent || '').trim().toLowerCase();
            if (/^(accept all|i agree|reject all|got it)$/i.test(t) || t.includes('accept all')) {
              /** @type {HTMLElement} */ (b).click();
              break;
            }
          }
        })
        .catch(() => {});
      await page.waitForTimeout(2200);
      // Wait for dollar amounts to appear
      await page
        .waitForFunction(
          () => /\$\s?\d/.test(document.body?.innerText || ''),
          { timeout: 16_000 },
        )
        .catch(() => {});
      await page.waitForTimeout(800);

      return page.evaluate(
        ({ originCode, destCode, departDate, flightsUrl }) => {
          /** @type {Array<{
           *   origin: string,
           *   destination: string,
           *   departDate: string,
           *   airline: string | null,
           *   departTime: string | null,
           *   arriveTime: string | null,
           *   duration: string | null,
           *   stops: number | null,
           *   priceUsd: number,
           *   score: number,
           *   googleFlightsUrl: string,
           * }>} */
          const offers = [];
          const seen = new Set();

          const parsePrice = (text) => {
            const m = String(text || '').replace(/,/g, '').match(/\$\s?(\d{2,5})(?:\.\d{2})?/);
            return m ? Number(m[1]) : null;
          };
          const parseStops = (text) => {
            const s = String(text || '').toLowerCase();
            if (/nonstop|non-stop|direct/.test(s)) return 0;
            const m = s.match(/(\d+)\s*stop/);
            return m ? Number(m[1]) : null;
          };

          const cards = [
            ...document.querySelectorAll('li, [role="listitem"], div[class*="result"]'),
          ].slice(0, 80);

          for (const card of cards) {
            const text = String(card.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.length < 20 || text.length > 900) continue;
            if (!/\$\s?\d/.test(text)) continue;
            // Must look like a flight itinerary row
            if (!/\d{1,2}:\d{2}/.test(text)) continue;
            const priceUsd = parsePrice(text);
            if (priceUsd == null || priceUsd < 30 || priceUsd > 8000) continue;

            const times = [...text.matchAll(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/gi)].map((m) => m[1]);
            const departTime = times[0] || null;
            const arriveTime = times[1] || null;
            const durMatch = text.match(/\b(\d+\s*hr?\s*\d*\s*min|\d+\s*h\s*\d*\s*m|\d+\s*hr)\b/i);
            const duration = durMatch ? durMatch[1] : null;
            const stops = parseStops(text);

            // Airline: first capitalized token sequence before first time
            let airline = null;
            const beforeTime = departTime ? text.slice(0, text.indexOf(departTime)) : text.slice(0, 80);
            const airMatch = beforeTime.match(
              /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:\s+Air(?:lines|ways)?)?|United|Delta|American|Alaska|Southwest|JetBlue|Frontier|Spirit|Hawaiian|Air Canada|British Airways|Lufthansa)\b/,
            );
            if (airMatch) airline = airMatch[1];

            const key = `${priceUsd}|${departTime}|${arriveTime}|${stops}`;
            if (seen.has(key)) continue;
            seen.add(key);

            offers.push({
              origin: originCode,
              destination: destCode,
              departDate,
              airline,
              departTime,
              arriveTime,
              duration,
              stops,
              priceUsd,
              score: 0,
              googleFlightsUrl: flightsUrl,
            });
            if (offers.length >= 24) break;
          }
          return offers;
        },
        { originCode: origin, destCode, departDate: date, flightsUrl: url },
      );
    },
    { env, width: 1400, height: 1100, timeoutMs: 45_000 },
  );

  if (!scraped) {
    return { offers: [], error: 'chrome_unavailable' };
  }
  if (!Array.isArray(scraped) || !scraped.length) {
    return { offers: [], error: 'no_flights_parsed' };
  }
  return { offers: scraped.map((o) => normalizeOffer(o)).filter(Boolean), error: null };
}

/**
 * Resolve destination airport for an event.
 * @param {{ city?: unknown, venue?: unknown, lat?: unknown, lon?: unknown, start?: unknown }} event
 */
export function resolveFlightDestination(event) {
  const coords = resolveLogisticsLatLon(event);
  if (coords) {
    const ap = nearestInternationalAirport(coords.lat, coords.lon);
    if (ap && !['SFO', 'OAK', 'SJC'].includes(ap.code)) {
      return {
        code: ap.code,
        city: String(event?.city || '').trim() || null,
        milesFromBay: Math.round(haversineMiles(BAY_AREA_CENTER.lat, BAY_AREA_CENTER.lon, coords.lat, coords.lon)),
      };
    }
  }
  const city = String(event?.city || '').trim();
  return { code: null, city: city || null, milesFromBay: null };
}

/**
 * Enable / refresh a flight module for one event.
 * @param {{
 *   kind: 'big' | 'notable',
 *   id: string,
 *   event: { title?: string, city?: string, venue?: string, lat?: number, lon?: number, start?: string, end?: string },
 *   enabled?: boolean,
 *   forceRefresh?: boolean,
 *   wait?: boolean,
 * }} opts
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function upsertFlightModule(opts, env = process.env) {
  const key = flightModuleKey(opts.kind, opts.id);
  if (!key) throw new Error('invalid_id');
  const store = await loadFlightModulesStore(env);
  const existing = store[key] || normalizeRecord({
    key,
    enabled: false,
    origins: [...DEFAULT_ORIGINS],
  });
  if (!existing) throw new Error('normalize_failed');

  const enabled = opts.enabled === false ? false : opts.enabled === true ? true : existing.enabled;
  if (!enabled) {
    const disabled = {
      ...existing,
      enabled: false,
      checking: false,
      nextCheckAt: null,
    };
    store[key] = disabled;
    await saveFlightModulesStore(store, env);
    return disabled;
  }

  const dest = resolveFlightDestination(opts.event);
  const departDate =
    suggestDepartDate(opts.event?.start) || existing.departDate || ymd(opts.event?.start);
  const destination =
    dest.code
    || existing.destination
    || (dest.city ? dest.city.slice(0, 80) : null)
    || existing.destinationCity
    || null;
  const destinationCity = dest.city || existing.destinationCity || null;

  /** @type {FlightModuleRecord} */
  let rec = {
    ...existing,
    enabled: true,
    destination,
    destinationCity,
    departDate,
    eventStart: String(opts.event?.start || existing.eventStart || '').slice(0, 40) || null,
    origins: existing.origins?.length ? existing.origins : [...DEFAULT_ORIGINS],
    checking: false,
    error: null,
    googleFlightsUrl: destination && departDate
      ? googleFlightsSearchUrl(existing.origins?.[0] || 'SFO', destination, departDate)
      : existing.googleFlightsUrl,
  };
  store[key] = rec;
  await saveFlightModulesStore(store, env);

  if (!rec.destination || !rec.departDate) {
    const nowIso = new Date().toISOString();
    rec = {
      ...rec,
      checking: false,
      error: !rec.destination ? 'missing_destination_airport' : 'missing_depart_date',
      lastCheckedAt: nowIso,
      nextCheckAt: new Date(Date.now() + CHECK_EVERY_MS).toISOString(),
    };
    store[key] = rec;
    await saveFlightModulesStore(store, env);
    return rec;
  }

  const stale =
    !rec.lastCheckedAt
    || Date.now() - Date.parse(rec.lastCheckedAt) > CHECK_EVERY_MS * 0.9
    || opts.forceRefresh === true;

  if (!stale && rec.cheapest && opts.forceRefresh !== true) {
    return rec;
  }

  // Default: kick scrape in the background so the UI can show "Checking…" immediately.
  if (opts.wait === false) {
    const pending = { ...rec, checking: true, error: null };
    store[key] = pending;
    await saveFlightModulesStore(store, env);
    void refreshFlightModuleByKey(key, env).catch((e) => {
      console.warn('[flight-module] background refresh failed', key, String(e?.message || e).slice(0, 160));
    });
    return pending;
  }

  return refreshFlightModuleByKey(key, env);
}

/**
 * Refresh all enabled modules that are due.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function refreshDueFlightModules(env = process.env) {
  const store = await loadFlightModulesStore(env);
  const now = Date.now();
  /** @type {string[]} */
  const refreshed = [];
  for (const rec of Object.values(store)) {
    if (!rec.enabled || !rec.destination || !rec.departDate) continue;
    const next = Date.parse(String(rec.nextCheckAt || ''));
    const last = Date.parse(String(rec.lastCheckedAt || ''));
    const due =
      !Number.isFinite(next)
      || next <= now
      || !Number.isFinite(last)
      || now - last >= CHECK_EVERY_MS;
    if (!due || rec.checking) continue;
    try {
      await refreshFlightModuleByKey(rec.key, env);
      refreshed.push(rec.key);
    } catch (e) {
      console.warn('[flight-module] refresh failed', rec.key, String(e?.message || e).slice(0, 160));
    }
  }
  return { ok: true, refreshed };
}

/**
 * @param {string} key
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function refreshFlightModuleByKey(key, env = process.env) {
  const store = await loadFlightModulesStore(env);
  const rec = store[key];
  if (!rec?.enabled || !rec.destination || !rec.departDate) return rec;
  const nowIso = new Date().toISOString();
  store[key] = { ...rec, checking: true, error: null };
  await saveFlightModulesStore(store, env);

  /** @type {FlightOffer[]} */
  const allOffers = [];
  let lastErr = null;
  for (const origin of rec.origins) {
    const { offers, error } = await scrapeGoogleFlights(
      { origin, destination: rec.destination, date: rec.departDate },
      env,
    );
    if (error) lastErr = error;
    for (const o of offers) allOffers.push(o);
  }
  const picked = pickCheapestAndBest(allOffers, { eventStart: rec.eventStart });
  const history = [...(rec.priceHistory || [])];
  if (picked.cheapest) {
    history.push({
      at: nowIso,
      cheapestUsd: picked.cheapest.priceUsd,
      bestUsd: picked.best?.priceUsd ?? null,
    });
    while (history.length > HISTORY_CAP) history.shift();
  }
  const tier = picked.cheapest
    ? classifyPriceTier(picked.cheapest.priceUsd, history)
    : rec.priceTier;
  const buy = suggestBuyByDate(history, rec.departDate, tier);
  const next = {
    ...rec,
    cheapest: picked.cheapest,
    best: picked.best,
    priceTier: tier,
    buyByDate: buy.buyByDate,
    buyByReason: buy.buyByReason,
    priceHistory: history,
    googleFlightsUrl: googleFlightsSearchUrl(rec.origins[0] || 'SFO', rec.destination, rec.departDate),
    lastCheckedAt: nowIso,
    nextCheckAt: new Date(Date.now() + CHECK_EVERY_MS).toISOString(),
    checking: false,
    error: picked.cheapest ? null : lastErr || 'no_offers',
  };
  store[key] = next;
  await saveFlightModulesStore(store, env);
  return next;
}

let flightModuleTimer = null;

/**
 * Every couple of hours, reassess enabled flight modules.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startFlightModuleScheduler(env = process.env) {
  if (flightModuleTimer) return;
  const tick = async () => {
    try {
      await refreshDueFlightModules(env);
    } catch (e) {
      console.warn('[flight-module] scheduler tick failed', String(e?.message || e).slice(0, 160));
    }
  };
  console.log('[flight-module] scheduler: every ~2h for enabled modules');
  // First pass after a short delay so boot is not blocked.
  setTimeout(() => void tick(), 90_000);
  flightModuleTimer = setInterval(() => void tick(), 15 * 60 * 1000);
}
