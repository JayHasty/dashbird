/**
 * Cached research for user-added big conferences / festivals (Events Finder watchlist).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeTripPlanning,
  tripPlanningToLegacyNotes,
} from './events-finder-travel-logistics.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CACHE_CAP = 80;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function conferenceWatchlistStorePath(env = process.env) {
  const override = String(env.EVENTS_FINDER_CONFERENCE_WATCHLIST_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/events-finder-conference-watchlist.json');
}

/**
 * Directory for cached Big Events website screenshots.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function bigEventsShotsDir(env = process.env) {
  const override = String(env.EVENTS_FINDER_BIG_EVENTS_SHOTS_DIR || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/big-events-shots');
}

/**
 * Persist a PNG screenshot for a Big Event, returning the stored filename.
 * @param {string} slug
 * @param {Buffer} buffer
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string | null>}
 */
export async function saveBigEventShot(slug, buffer, env = process.env) {
  const key = String(slug || '').trim().slice(0, 100);
  if (!key || !buffer || !buffer.length) return null;
  const dir = bigEventsShotsDir(env);
  await fs.mkdir(dir, { recursive: true });
  const file = `${key}.png`;
  const target = path.join(dir, file);
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, buffer);
  await fs.rename(staging, target);
  return file;
}

/** Image extensions we accept for a downloaded event flier / graphic. */
const FLIER_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

/**
 * Persist a downloaded flier / promotional graphic for a Big Event.
 * @param {string} slug
 * @param {Buffer} buffer
 * @param {string} ext file extension (png/jpg/jpeg/webp/gif)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string | null>}
 */
export async function saveBigEventFlier(slug, buffer, ext, env = process.env) {
  const key = String(slug || '').trim().slice(0, 100);
  if (!key || !buffer || !buffer.length) return null;
  const clean = String(ext || 'jpg').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const useExt = FLIER_EXTS.has(clean) ? clean : 'jpg';
  const dir = bigEventsShotsDir(env);
  await fs.mkdir(dir, { recursive: true });
  const file = `${key}-flier.${useExt}`;
  const target = path.join(dir, file);
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, buffer);
  await fs.rename(staging, target);
  return file;
}

/**
 * @param {string | null | undefined} file
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function removeBigEventShot(file, env = process.env) {
  const name = String(file || '').trim();
  if (!name || name.includes('/') || name.includes('..')) return;
  try {
    await fs.rm(path.join(bigEventsShotsDir(env), name), { force: true });
  } catch {
    // ignore
  }
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T12:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return s;
}

/**
 * Normalize an ISO datetime (used for snooze-until timestamps). Falls back to
 * null when unparseable. Keeps full precision (not date-only like normalizeDate).
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeIsoDateTime(raw) {
  if (raw == null || raw === '') return null;
  const ms = Date.parse(String(raw).trim());
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const query = String(r.query || '').trim().slice(0, 120);
  if (!query) return null;
  const slug = String(r.slug || slugFromQuery(query)).trim().slice(0, 100);
  if (!slug) return null;
  return {
    slug,
    query,
    name: String(r.name || query).trim().slice(0, 160) || query,
    url: String(r.url || '').trim().slice(0, 500) || null,
    // Official homepage root (holds dates) + ticketing/pricing subpage (holds
    // ticket info). `url` mirrors the homepage for backward compatibility.
    homepageUrl: String(r.homepageUrl || r.url || '').trim().slice(0, 500) || null,
    ticketUrl: String(r.ticketUrl || '').trim().slice(0, 500) || null,
    eventStart: normalizeDate(r.eventStart),
    eventEnd: normalizeDate(r.eventEnd),
    venue: String(r.venue || '').trim().slice(0, 160) || null,
    city: String(r.city || '').trim().slice(0, 80) || null,
    ticketPrice: String(r.ticketPrice || '').trim().slice(0, 120) || null,
    ticketPriceEstimated: r.ticketPriceEstimated === true,
    estimatedFromYear:
      r.estimatedFromYear != null && Number(r.estimatedFromYear) > 1900
        ? Number(r.estimatedFromYear)
        : null,
    earlyBirdPrice: String(r.earlyBirdPrice || '').trim().slice(0, 120) || null,
    earlyBirdStart: normalizeDate(r.earlyBirdStart),
    earlyBirdEnd: normalizeDate(r.earlyBirdEnd),
    // Date general (non-early-bird) ticket sales open, when announced.
    ticketSalesStart: normalizeDate(r.ticketSalesStart),
    screenshotPath: String(r.screenshotPath || '').trim().slice(0, 200) || null,
    // Downloaded flier / promo graphic for the upcoming edition (sidebar image).
    flierPath: String(r.flierPath || '').trim().slice(0, 200) || null,
    flierCheckedAt: String(r.flierCheckedAt || '').trim().slice(0, 40) || null,
    // True when dates were estimated (+1 year) because no next-edition info exists.
    nextEditionEstimated: r.nextEditionEstimated === true,
    notes: String(r.notes || '').trim().slice(0, 400) || null,
    // Structured trip logistics (packing, stays, flights, prep, notes).
    tripPlanning: normalizeTripPlanning(r.tripPlanning, r.planningNotes),
    // Freeform logistics mirror — kept for badges / older clients.
    planningNotes:
      tripPlanningToLegacyNotes(normalizeTripPlanning(r.tripPlanning, r.planningNotes))
      || (String(r.planningNotes || '').trim().slice(0, 4000) || null),
    // How many days before the event / sales to start reminding.
    // null = use the default heads-up window (~60 days).
    reminderLeadDays: normalizeLeadDays(r.reminderLeadDays),
    // Keep the producer card visible while dates are still TBD; when dates
    // appear, flash as newly announced. Default on for producers.
    notifyWhenDatesSet: r.notifyWhenDatesSet !== false,
    datesAnnouncedAt: normalizeIsoDateTime(r.datesAnnouncedAt),
    // Learned extraction hints per field after a user correction
    // ({ ticketPrice: { hint, expectedValue, learnedAt }, ... }).
    fieldWires: normalizeFieldWires(r.fieldWires),
    error: String(r.error || '').trim().slice(0, 200) || null,
    researching: r.researching === true,
    researchedAt: String(r.researchedAt || '').trim().slice(0, 40) || null,
    // Feed-card controls: hide from the events feed until this ISO timestamp
    // (Snooze), or dismiss entirely (Skip). Management table still lists them.
    snoozedUntil: normalizeIsoDateTime(r.snoozedUntil),
    skipped: r.skipped === true,
    // Set when the user hand-edits metadata — auto/daily research then leaves
    // this record alone so it never clobbers their corrections.
    manualEdit: r.manualEdit === true,
  };
}

/**
 * @param {unknown} raw
 * @returns {Record<string, { hint: string, expectedValue: string | null, learnedAt: string | null }>}
 */
function normalizeFieldWires(raw) {
  if (!raw || typeof raw !== 'object') return {};
  /** @type {Record<string, { hint: string, expectedValue: string | null, learnedAt: string | null }>} */
  const out = {};
  for (const [key, row] of Object.entries(raw)) {
    const field = String(key || '').trim().slice(0, 40);
    if (!field || !row || typeof row !== 'object') continue;
    const hint = String(/** @type {Record<string, unknown>} */ (row).hint || '').trim().slice(0, 500);
    if (!hint) continue;
    const expectedValue = String(
      /** @type {Record<string, unknown>} */ (row).expectedValue || '',
    ).trim().slice(0, 160) || null;
    const learnedAt = normalizeIsoDateTime(
      /** @type {Record<string, unknown>} */ (row).learnedAt,
    );
    out[field] = { hint, expectedValue, learnedAt };
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
export function normalizeLeadDays(raw) {
  if (raw == null || raw === '') return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 365);
}

/**
 * @param {string} query
 * @returns {string}
 */
export function slugFromQuery(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/**
 * @param {unknown} raw
 */
function normalize(raw) {
  const o = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const bySlugRaw = o.bySlug && typeof o.bySlug === 'object' ? o.bySlug : {};
  /** @type {Record<string, ReturnType<typeof normalizeRecord>>} */
  const bySlug = {};
  for (const [key, row] of Object.entries(bySlugRaw)) {
    const slug = String(key || '').trim().slice(0, 100);
    const rec = normalizeRecord({ .../** @type {object} */ (row), slug, query: row?.query || slug });
    if (!slug || !rec) continue;
    bySlug[slug] = rec;
  }
  const entries = Object.entries(bySlug);
  if (entries.length > CACHE_CAP) {
    entries.sort((a, b) => Date.parse(b[1].researchedAt || '') - Date.parse(a[1].researchedAt || ''));
    return { bySlug: Object.fromEntries(entries.slice(0, CACHE_CAP)) };
  }
  return { bySlug };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadConferenceWatchlistStore(env = process.env) {
  try {
    const raw = await fs.readFile(conferenceWatchlistStorePath(env), 'utf8');
    return normalize(JSON.parse(raw));
  } catch {
    return { bySlug: {} };
  }
}

/**
 * @param {{ bySlug: Record<string, object> }} cache
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeCache(cache, env) {
  const target = conferenceWatchlistStorePath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, `${JSON.stringify(normalize(cache), null, 2)}\n`, 'utf8');
  await fs.rename(staging, target);
}

/**
 * @param {Record<string, object>} rows keyed by slug
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function upsertConferenceWatchlistRecords(rows, env = process.env) {
  const cache = await loadConferenceWatchlistStore(env);
  for (const [slug, row] of Object.entries(rows)) {
    const key = String(slug || '').trim().slice(0, 100);
    const rec = normalizeRecord({ ...row, slug: key });
    if (!key || !rec) continue;
    cache.bySlug[key] = rec;
  }
  const normalized = normalize(cache);
  await writeCache(normalized, env);
  return normalized;
}

/**
 * @param {string[]} slugs
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function removeConferenceWatchlistSlugs(slugs, env = process.env) {
  const cache = await loadConferenceWatchlistStore(env);
  for (const slug of slugs) {
    delete cache.bySlug[String(slug || '').trim()];
  }
  const normalized = normalize(cache);
  await writeCache(normalized, env);
  return normalized;
}
