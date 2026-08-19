/**
 * Notable events — user-flagged catalog events with reminder lead time,
 * early-bird / ticket extras, and optional field overrides when scrape data is wrong.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeTripPlanning,
  tripPlanningToLegacyNotes,
} from './events-finder-travel-logistics.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * @typedef {{
 *   eventId: string,
 *   notable: boolean,
 *   reminderLeadWeeks: number | null,
 *   earlyBirdPrice: string | null,
 *   earlyBirdStart: string | null,
 *   earlyBirdEnd: string | null,
 *   ticketSalesStart: string | null,
 *   ticketPrice: string | null,
 *   ticketUrl: string | null,
 *   notes: string | null,
 *   planningNotes: string | null,
 *   tripPlanning: {
 *     packingList: {
 *       categories: {
 *         id: string,
 *         name: string,
 *         items: { id: string, text: string, checked: boolean }[],
 *       }[],
 *     } | null,
 *     accommodations: string | null,
 *     flightsTransport: string | null,
 *     beforeTrip: string | null,
 *     notes: string | null,
 *   },
 *   overrides: {
 *     title?: string | null,
 *     start?: string | null,
 *     end?: string | null,
 *     venue?: string | null,
 *     city?: string | null,
 *     lat?: number | null,
 *     lon?: number | null,
 *     description?: string | null,
 *     url?: string | null,
 *     priceLabel?: string | null,
 *   },
 *   manualEdit: boolean,
 *   updatedAt: string | null,
 * }} NotableEventRecord
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function notableEventsStorePath(env = process.env) {
  const override = String(env.EVENTS_FINDER_NOTABLE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data', 'events-finder-notable.json');
}

/**
 * @param {unknown} n
 * @returns {number | null}
 */
export function normalizeLeadWeeks(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const w = Math.trunc(v);
  if (w < 1 || w > 26) return null;
  return w;
}

/**
 * @param {unknown} raw
 * @returns {NotableEventRecord['overrides']}
 */
function normalizeOverrides(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const o = /** @type {Record<string, unknown>} */ (raw);
  /** @type {NotableEventRecord['overrides']} */
  const out = {};
  for (const key of [
    'title',
    'start',
    'end',
    'venue',
    'city',
    'description',
    'url',
    'priceLabel',
  ]) {
    if (o[key] == null || o[key] === '') continue;
    out[/** @type {'title'} */ (key)] = String(o[key]).trim().slice(0, key === 'description' ? 4000 : 500);
  }
  if (o.lat != null && o.lat !== '') {
    const lat = Number(o.lat);
    if (Number.isFinite(lat) && lat >= -90 && lat <= 90) out.lat = lat;
  }
  if (o.lon != null && o.lon !== '') {
    const lon = Number(o.lon);
    if (Number.isFinite(lon) && lon >= -180 && lon <= 180) out.lon = lon;
  }
  return out;
}

/**
 * @param {string} eventId
 * @param {unknown} raw
 * @returns {NotableEventRecord | null}
 */
export function normalizeNotableRecord(eventId, raw) {
  const id = String(eventId || '').trim().slice(0, 300);
  if (!id) return null;
  const r = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const notable = r.notable !== false;
  const legacyNotes = r.planningNotes != null && String(r.planningNotes).trim()
    ? String(r.planningNotes).trim().slice(0, 4000)
    : null;
  const tripPlanning = normalizeTripPlanning(r.tripPlanning, legacyNotes);
  return {
    eventId: id,
    notable,
    reminderLeadWeeks: normalizeLeadWeeks(r.reminderLeadWeeks ?? r.reminderLeadDays),
    earlyBirdPrice: r.earlyBirdPrice != null && String(r.earlyBirdPrice).trim()
      ? String(r.earlyBirdPrice).trim().slice(0, 80)
      : null,
    earlyBirdStart: r.earlyBirdStart != null && String(r.earlyBirdStart).trim()
      ? String(r.earlyBirdStart).trim().slice(0, 40)
      : null,
    earlyBirdEnd: r.earlyBirdEnd != null && String(r.earlyBirdEnd).trim()
      ? String(r.earlyBirdEnd).trim().slice(0, 40)
      : null,
    ticketSalesStart: r.ticketSalesStart != null && String(r.ticketSalesStart).trim()
      ? String(r.ticketSalesStart).trim().slice(0, 40)
      : null,
    ticketPrice: r.ticketPrice != null && String(r.ticketPrice).trim()
      ? String(r.ticketPrice).trim().slice(0, 80)
      : null,
    ticketUrl: r.ticketUrl != null && String(r.ticketUrl).trim()
      ? String(r.ticketUrl).trim().slice(0, 500)
      : null,
    notes: r.notes != null && String(r.notes).trim()
      ? String(r.notes).trim().slice(0, 2000)
      : null,
    planningNotes: tripPlanningToLegacyNotes(tripPlanning) || legacyNotes,
    tripPlanning,
    overrides: normalizeOverrides(r.overrides),
    manualEdit: r.manualEdit === true,
    updatedAt: r.updatedAt != null ? String(r.updatedAt) : null,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Record<string, NotableEventRecord>>}
 */
export async function loadNotableEventsStore(env = process.env) {
  const filePath = notableEventsStorePath(env);
  try {
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const records = raw && typeof raw === 'object' ? raw.records || raw : {};
    /** @type {Record<string, NotableEventRecord>} */
    const out = {};
    if (records && typeof records === 'object') {
      for (const [id, rec] of Object.entries(records)) {
        const n = normalizeNotableRecord(id, rec);
        if (n && n.notable) out[n.eventId] = n;
      }
    }
    return out;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e)?.code === 'ENOENT') return {};
    throw e;
  }
}

/**
 * @param {Record<string, NotableEventRecord>} records
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveNotableEventsStore(records, env = process.env) {
  const filePath = notableEventsStorePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const clean = {};
  for (const [id, rec] of Object.entries(records || {})) {
    const n = normalizeNotableRecord(id, rec);
    if (n && n.notable) clean[n.eventId] = n;
  }
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), records: clean }, null, 2)}\n`,
    'utf8',
  );
  return clean;
}

/**
 * @param {string} eventId
 * @param {Partial<NotableEventRecord> & { notable?: boolean }} patch
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<NotableEventRecord | null>}
 */
export async function upsertNotableEvent(eventId, patch, env = process.env) {
  const id = String(eventId || '').trim();
  if (!id) return null;
  const store = await loadNotableEventsStore(env);
  const existing = store[id] || normalizeNotableRecord(id, { notable: true });
  if (!existing) return null;

  if (patch.notable === false) {
    delete store[id];
    await saveNotableEventsStore(store, env);
    return null;
  }

  const next = normalizeNotableRecord(id, {
    ...existing,
    ...patch,
    tripPlanning:
      patch.tripPlanning !== undefined
        ? normalizeTripPlanning(patch.tripPlanning, existing.planningNotes)
        : patch.planningNotes !== undefined
          ? normalizeTripPlanning(
            { ...(existing.tripPlanning || {}), notes: patch.planningNotes },
            patch.planningNotes,
          )
          : existing.tripPlanning,
    overrides:
      patch.overrides !== undefined
        ? { ...existing.overrides, ...normalizeOverrides(patch.overrides) }
        : existing.overrides,
    notable: true,
    updatedAt: new Date().toISOString(),
  });
  if (!next) return null;
  // Keep planningNotes in sync with structured trip planning.
  if (patch.tripPlanning !== undefined || patch.planningNotes !== undefined) {
    next.planningNotes = tripPlanningToLegacyNotes(next.tripPlanning);
  }
  store[id] = next;
  await saveNotableEventsStore(store, env);
  return next;
}

/**
 * Merge notable metadata + overrides onto a catalog event for the feed.
 * @param {object} event
 * @param {NotableEventRecord | null | undefined} notable
 * @returns {object}
 */
export function applyNotableToEvent(event, notable) {
  if (!event || !notable || !notable.notable) return event;
  const o = notable.overrides || {};
  return {
    ...event,
    title: o.title || event.title,
    start: o.start || event.start,
    end: o.end != null ? o.end : event.end,
    venue: o.venue || event.venue,
    location: o.venue || event.location || event.venue,
    city: o.city || event.city,
    lat: o.lat != null ? o.lat : event.lat,
    lon: o.lon != null ? o.lon : event.lon,
    description: o.description != null ? o.description : event.description,
    url: o.url || event.url,
    priceLabel: o.priceLabel || notable.ticketPrice || event.priceLabel,
    notable: true,
    reminderLeadWeeks: notable.reminderLeadWeeks,
    earlyBirdPrice: notable.earlyBirdPrice,
    earlyBirdStart: notable.earlyBirdStart,
    earlyBirdEnd: notable.earlyBirdEnd,
    ticketSalesStart: notable.ticketSalesStart,
    ticketPrice: notable.ticketPrice || o.priceLabel || event.priceLabel || null,
    ticketUrl: notable.ticketUrl || null,
    notableNotes: notable.notes,
    planningNotes: notable.planningNotes,
    tripPlanning: notable.tripPlanning,
    manualEdit: notable.manualEdit === true,
    notableUpdatedAt: notable.updatedAt,
  };
}

/**
 * @param {NotableEventRecord} notable
 * @param {string | null | undefined} eventStartIso
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isNotableHeadsUpActive(notable, eventStartIso, now = new Date()) {
  if (!notable?.notable) return false;
  const startMs = Date.parse(String(eventStartIso || ''));
  if (!Number.isFinite(startMs)) return true; // undated — keep visible while notable
  const weeks = notable.reminderLeadWeeks != null ? notable.reminderLeadWeeks : 4;
  const leadMs = weeks * 7 * 24 * 60 * 60 * 1000;
  const t = now.getTime();
  return t >= startMs - leadMs && t <= startMs + 24 * 60 * 60 * 1000;
}
