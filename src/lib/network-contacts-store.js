/**
 * Network contacts CRM — SQLite (data/network.db) + assets on disk.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JULIA_CONTACT_ID,
  JULIA_SEED_ID,
  SAM_CONTACT_ID,
  allocateNextContactId,
  markFoundationContactOptedOut,
  openNetworkDb,
  remapLegacyNetworkId,
  removeContactRefs,
  rowToContact,
  upsertContactRow,
} from './network-db.js';
import { deleteOrganizations } from './network-organizations-store.js';
import { normalizeLastContactFields } from './network-last-contact.js';
import { normalizeBirthdayFields } from './network-birthday.js';
import { normalizeKidsBirthYears } from './network-kids.js';
import {
  normalizeContactDisplayName,
  relocateOutOfTownFromScenes,
  kindsFromMisplacedScenes,
  mergeKinds,
} from './network-scene-normalize.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export { JULIA_CONTACT_ID, JULIA_SEED_ID };

export const CONTACT_KINDS = ['friend', 'organizer', 'business', 'family'];

export const CONTACT_RATINGS = ['Fan', 'Hot', 'Warm', 'Cold'];

/** Adult / raunchy plans comfort: Down = strip club fine; Proper = keep it clean. */
export const CONTACT_SENSITIVITIES = ['Down', 'Situational', 'Proper'];

export const CONTACT_RELATIONSHIP_STATUSES = [
  'Lead',
  'Acquaintance',
  'Cultivating',
  'Inner Circle',
  'Collaborator',
  'Meta',
  'Family',
  'Paused',
  'Former',
];

/** @deprecated use CONTACT_RELATIONSHIP_STATUSES */
export const CONTACT_LIFECYCLES = ['Lead', 'Active', 'Dormant', 'Former'];

export const PREFERRED_CONTACT_METHODS = [
  'phone',
  'office_phone',
  'email',
  'signal',
  'whatsapp',
  'messenger',
  'linkedin',
  'other',
];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @deprecated JSON path unused; kept for callers that probe config.
 */
export function networkContactsPath(env = process.env) {
  const override = String(env.NETWORK_CONTACTS_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/network-contacts.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function networkAssetsDir(env = process.env) {
  const override = String(env.NETWORK_ASSETS_DIR || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/network-assets');
}

/**
 * @param {unknown} v
 */
function cleanStr(v, max = 2000) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.slice(0, max);
}

/**
 * Title-case a single name token (handles hyphens / apostrophes).
 * @param {string} word
 */
function titleCaseWord(word) {
  if (!word) return '';
  return word
    .split(/(['’-])/)
    .map((seg) => {
      if (seg === "'" || seg === '’' || seg === '-') return seg;
      if (!seg) return seg;
      return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
    })
    .join('');
}

/**
 * Short middle-initial tokens (LS, MJ, A, L.S.) stay uppercase with the given name.
 * Ordinary short middle names (Ann, Lee, Mae) stay title-cased.
 * @param {string} word
 */
function isMiddleInitialsToken(word) {
  const raw = String(word || '').trim();
  if (/^[A-Za-z](\.[A-Za-z])+\.?$/.test(raw)) return true;
  const w = raw.replace(/\./g, '');
  if (!/^[A-Za-z]{1,3}$/.test(w)) return false;
  if (w.length <= 2) return true;
  return w === w.toUpperCase();
}

/**
 * Title-case given name(s); middle initials stay UPPER with the first name.
 * @param {string} s
 */
function titleCaseGivenName(s) {
  const parts = String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts
    .map((p, i) => {
      if (i > 0 && isMiddleInitialsToken(p)) return p.replace(/\./g, '').toUpperCase();
      return titleCaseWord(p);
    })
    .join(' ');
}

/**
 * Title-case a person name: capitalize the first letter of each word
 * (and after hyphens / apostrophes). Middle initials stay with the given name as UPPER.
 * @param {string} s
 */
function titleCaseName(s) {
  if (!s) return '';
  const parts = String(s)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length <= 1) return titleCaseWord(parts[0] || '');
  const last = titleCaseWord(parts[parts.length - 1]);
  const given = titleCaseGivenName(parts.slice(0, -1).join(' '));
  return `${given} ${last}`.trim();
}

/**
 * Split a display name so middle names/initials stay on firstName; last token → lastName.
 * @param {unknown} displayName
 * @returns {{ firstName: string, lastName: string }}
 */
export function splitPersonName(displayName) {
  const parts = String(displayName ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1],
  };
}

/**
 * Join given + family name without duplicating a last name already present
 * in the first-name field (e.g. "Amanda Ravenhill" + "Ravenhill").
 * @param {unknown} firstName
 * @param {unknown} lastName
 */
export function composeDisplayName(firstName, lastName) {
  const first = String(firstName ?? '').replace(/\s+/g, ' ').trim();
  const last = String(lastName ?? '').replace(/\s+/g, ' ').trim();
  if (!first) return last.slice(0, 200);
  if (!last) return first.slice(0, 200);
  const firstLower = first.toLowerCase();
  const lastLower = last.toLowerCase();
  if (firstLower === lastLower) return first.slice(0, 200);
  // Whole last name already at end of first ("Amanda Ravenhill" + "Ravenhill")
  if (firstLower.endsWith(` ${lastLower}`)) {
    return first.slice(0, 200);
  }
  // Multi-token last name fully covered by trailing tokens of first
  const lastParts = lastLower.split(' ').filter(Boolean);
  const firstParts = firstLower.split(' ').filter(Boolean);
  if (
    lastParts.length
    && firstParts.length >= lastParts.length
    && firstParts.slice(-lastParts.length).join(' ') === lastParts.join(' ')
  ) {
    return first.slice(0, 200);
  }
  return `${first} ${last}`.slice(0, 200);
}

/**
 * @param {unknown} v
 * @param {number} [max]
 * @param {number} [itemMax]
 */
function cleanStrList(v, max = 40, itemMax = 200) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    const s = cleanStr(item, itemMax);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeKinds(raw) {
  const fromArray = Array.isArray(raw?.kinds)
    ? raw.kinds
    : Array.isArray(raw)
      ? raw
      : null;
  if (fromArray) {
    const out = [];
    for (const k of fromArray) {
      let s = cleanStr(k, 40).toLowerCase();
      if (s === 'self') {
        if (!out.includes('friend')) out.push('friend');
        continue;
      }
      // Legacy: "kids" was briefly a contact kind — migrated to hasKids.
      if (s === 'kids' || s === 'kid') continue;
      if (s === 'community' || s === 'scene' || s === 'orgainzer') s = 'organizer';
      if (
        (s === 'friend' || s === 'organizer' || s === 'business' || s === 'family')
        && !out.includes(s)
      ) {
        out.push(s);
      }
    }
    // Stable order for UI checkboxes / labels.
    const order = ['friend', 'organizer', 'business', 'family'];
    const ordered = order.filter((k) => out.includes(k));
    for (const k of out) {
      if (!ordered.includes(k)) ordered.push(k);
    }
    return ordered.length ? ordered : ['friend'];
  }
  const legacy = cleanStr(raw?.kind ?? raw, 40).toLowerCase();
  if (legacy === 'business') return ['business'];
  if (legacy === 'family') return ['family'];
  if (legacy === 'kids' || legacy === 'kid') return ['friend'];
  if (legacy === 'community' || legacy === 'scene' || legacy === 'organizer' || legacy === 'orgainzer') {
    return ['organizer'];
  }
  if (legacy === 'friend' || legacy === 'self' || !legacy) return ['friend'];
  return ['friend'];
}

/**
 * @returns {string}
 */
export function newContactTaskId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @returns {string}
 */
function newMergeSuggestionId() {
  return newContactTaskId().replace(/^task_/, 'merge_');
}

/**
 * Pending / resolved near-duplicate merge suggestions (Telegram soft matches, etc.).
 * @param {unknown} raw
 * @returns {{ id: string, otherContactId: string, otherDisplayName: string, score: number, reasons: string[], status: string, source: string, createdAt: string, taskId: string }[]}
 */
export function normalizeMergeSuggestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = cleanStr(item.id, 80) || newMergeSuggestionId();
    const otherContactId = remapLegacyNetworkId(cleanStr(item.otherContactId, 80));
    if (!otherContactId) continue;
    const key = `${otherContactId}:${cleanStr(item.status, 40) || 'pending'}`;
    if (seen.has(key) && cleanStr(item.status, 40) === 'pending') continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (cleanStr(item.status, 40) === 'pending') seen.add(key);
    let status = cleanStr(item.status, 40) || 'pending';
    if (!['pending', 'confirmed', 'dismissed'].includes(status)) status = 'pending';
    const reasons = Array.isArray(item.reasons)
      ? item.reasons.map((r) => cleanStr(r, 80)).filter(Boolean).slice(0, 12)
      : [];
    out.push({
      id,
      otherContactId,
      otherDisplayName: cleanStr(item.otherDisplayName, 200),
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
      reasons,
      status,
      source: cleanStr(item.source, 40) || 'manual',
      createdAt: cleanStr(item.createdAt, 64) || new Date().toISOString(),
      taskId: cleanStr(item.taskId, 80),
    });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Normalize contact task checklist. Migrates legacy `nextStep` string into one open task.
 * @param {unknown} raw
 * @returns {{ id: string, text: string, done: boolean, vikunjaTaskId?: string }[]}
 */
export function normalizeTasks(raw) {
  if (!raw || typeof raw !== 'object') return [];
  /** @type {{ id: string, text: string, done: boolean, vikunjaTaskId?: string }[]} */
  const out = [];
  const seen = new Set();
  const pushTask = (id, text, done, vikunjaTaskId) => {
    const t = cleanStr(text, 500);
    if (!t) return;
    const key = `${done ? '1' : '0'}:${t.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    /** @type {{ id: string, text: string, done: boolean, vikunjaTaskId?: string }} */
    const row = {
      id: cleanStr(id, 80) || newContactTaskId(),
      text: t,
      done: Boolean(done),
    };
    const vid = String(vikunjaTaskId || '').trim();
    if (/^\d+$/.test(vid)) row.vikunjaTaskId = vid;
    out.push(row);
  };

  if (Array.isArray(raw.tasks)) {
    for (const item of raw.tasks) {
      if (!item || typeof item !== 'object') {
        if (typeof item === 'string') pushTask('', item, false, '');
        continue;
      }
      pushTask(
        item.id,
        item.text ?? item.title ?? item.label,
        item.done,
        item.vikunjaTaskId ?? item.vikunja_task_id,
      );
      if (out.length >= 40) break;
    }
  }

  // Legacy free-text nextStep → open task(s), one per line / semicolon.
  const legacy = cleanStr(raw.nextStep, 2000);
  if (legacy && !out.some((t) => !t.done)) {
    const chunks = legacy
      .split(/\n+|;/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const chunk of chunks) {
      pushTask('', chunk, false);
      if (out.length >= 40) break;
    }
  }

  return out;
}

/**
 * True when the contact has at least one incomplete task.
 * @param {unknown} contact
 */
export function contactHasOpenTask(contact) {
  const tasks = Array.isArray(contact?.tasks) ? contact.tasks : normalizeTasks(contact || {});
  return tasks.some((t) => t && !t.done && String(t.text || '').trim());
}

/**
 * Open-task titles joined for search / legacy nextStep display.
 * @param {{ id?: string, text?: string, done?: boolean }[]} tasks
 */
export function openTasksSummary(tasks) {
  if (!Array.isArray(tasks)) return '';
  return tasks
    .filter((t) => t && !t.done && String(t.text || '').trim())
    .map((t) => String(t.text).trim())
    .join('; ')
    .slice(0, 2000);
}

/**
 * Whether the contact has kids. Separate from Type (friend/organizer/business).
 * Migrates legacy `kinds: ['kids']` / `kind: 'kids'`.
 * @param {unknown} raw
 * @returns {boolean}
 */
export function normalizeHasKids(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(raw, 'hasKids')) {
    const v = raw.hasKids;
    if (v === true || v === 1) return true;
    if (v === false || v === 0 || v == null || v === '') return false;
    const s = String(v).trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'y' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === 'n' || s === '0') return false;
  }
  const kinds = Array.isArray(raw.kinds) ? raw.kinds : [];
  for (const k of kinds) {
    const s = cleanStr(k, 40).toLowerCase();
    if (s === 'kids' || s === 'kid') return true;
  }
  const legacy = cleanStr(raw.kind, 40).toLowerCase();
  return legacy === 'kids' || legacy === 'kid';
}

/**
 * @param {unknown} methods
 */
function normalizePreferredMethods(methods) {
  const allowed = new Set(PREFERRED_CONTACT_METHODS);
  const list = Array.isArray(methods) ? methods : [];
  const out = [];
  for (const m of list) {
    const s = cleanStr(m, 40).toLowerCase().replace(/\s+/g, '_');
    if (!allowed.has(s) || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

/**
 * @param {unknown} channels
 */
function normalizeChannels(channels) {
  const c = channels && typeof channels === 'object' ? channels : {};
  const urls = cleanStrList(c.urls, 20);
  return {
    email: cleanStr(c.email, 320) || null,
    phone: cleanStr(c.phone, 80) || null,
    officePhone: cleanStr(c.officePhone ?? c.office_phone, 80) || null,
    sms: cleanStr(c.sms, 80) || null,
    signal: cleanStr(c.signal, 120) || null,
    whatsapp: cleanStr(c.whatsapp, 120) || null,
    telegram: cleanStr(c.telegram, 120) || null,
    messenger: cleanStr(c.messenger, 320) || null,
    linkedin: cleanStr(c.linkedin, 500) || null,
    other: cleanStr(c.other, 320) || null,
    urls,
  };
}

/**
 * @param {unknown} v
 * @param {string[]} allowed
 */
function cleanEnum(v, allowed) {
  const s = cleanStr(v, 80);
  if (!s) return '';
  for (const a of allowed) {
    if (a.toLowerCase() === s.toLowerCase()) return a;
  }
  return '';
}

/**
 * Map relationshipStatus, migrating legacy lifecycleStatus / old enums when needed.
 * @param {object} raw
 */
function normalizeRelationshipStatus(raw) {
  const direct = cleanEnum(raw.relationshipStatus, CONTACT_RELATIONSHIP_STATUSES);
  if (direct) return direct;

  const legacyVal = cleanStr(raw.relationshipStatus || raw.lifecycleStatus, 80).toLowerCase();
  if (!legacyVal) return '';

  /** @type {Record<string, string>} */
  const legacyMap = {
    lead: 'Lead',
    active: 'Collaborator',
    cultivating: 'Cultivating',
    collaborator: 'Collaborator',
    family: 'Family',
    polyfam: 'Family',
    'inner circle': 'Inner Circle',
    innercircle: 'Inner Circle',
    acquaintance: 'Acquaintance',
    aquaintance: 'Acquaintance',
    dormant: 'Paused',
    paused: 'Paused',
    retired: 'Former',
    former: 'Former',
  };
  if (legacyMap[legacyVal]) return legacyMap[legacyVal];
  return cleanEnum(raw.lifecycleStatus, CONTACT_RELATIONSHIP_STATUSES);
}

/**
 * @param {unknown} enrichment
 */
function normalizeEnrichment(enrichment) {
  const e = enrichment && typeof enrichment === 'object' ? enrichment : {};
  let confidence = null;
  if (typeof e.confidence === 'number' && Number.isFinite(e.confidence)) {
    confidence = Math.max(0, Math.min(1, e.confidence));
  } else if (e.confidence != null && e.confidence !== '') {
    const n = Number(e.confidence);
    if (Number.isFinite(n)) confidence = Math.max(0, Math.min(1, n));
  }
  return {
    sources: cleanStrList(e.sources, 30),
    enrichedAt: cleanStr(e.enrichedAt, 64) || null,
    rawSummary: cleanStr(e.rawSummary, 4000) || null,
    confidence,
    needsReview: Boolean(e.needsReview),
    lastMode: cleanStr(e.lastMode, 80) || null,
  };
}

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeContact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = remapLegacyNetworkId(cleanStr(raw.id, 80) || newContactId());
  const rawFirst = cleanStr(raw.firstName, 120);
  const rawLast = cleanStr(raw.lastName, 120);
  let displayName;
  let firstName;
  let lastName;
  if (rawFirst || rawLast) {
    firstName = titleCaseGivenName(rawFirst);
    lastName = titleCaseWord(rawLast);
    displayName = normalizeContactDisplayName(composeDisplayName(firstName, lastName), (s) => s);
  } else {
    displayName = normalizeContactDisplayName(raw.displayName, titleCaseName);
    const parts = splitPersonName(displayName);
    firstName = parts.firstName;
    lastName = parts.lastName;
  }
  const hasKids = normalizeHasKids(raw);
  const kidsBirthYears = normalizeKidsBirthYears(raw.kidsBirthYears);
  let summary = cleanStr(raw.summary, 8000);
  if (!summary && Array.isArray(raw.tags) && raw.tags.length) {
    summary = cleanStrList(raw.tags, 40).join(' ');
  }
  const now = new Date().toISOString();
  let source = cleanStr(raw.source, 40) || 'manual';
  if (source === 'seed') source = 'manual';
  // Prefer location; fold legacy region into empty location, then drop region.
  let locationSeed = cleanStr(raw.location, 300);
  if (!locationSeed) locationSeed = cleanStr(raw.region, 300);
  // Read Type-as-Scene tags (Family) from the raw string before Scene normalize strips them.
  const kindsFromScene = kindsFromMisplacedScenes(raw.networkCircles);
  const { networkCircles, location } = relocateOutOfTownFromScenes(
    raw.networkCircles,
    locationSeed,
    4000,
    300,
  );
  const kinds = mergeKinds(normalizeKinds(raw), kindsFromScene);
  const tasks = normalizeTasks(raw);
  const mergeSuggestions = normalizeMergeSuggestions(raw.mergeSuggestions);
  return {
    id,
    displayName,
    firstName,
    lastName,
    nickname: titleCaseName(cleanStr(raw.nickname, 120)),
    memoryJog: cleanStr(raw.memoryJog, 80),
    aliases: cleanStrList(raw.aliases, 20).map(titleCaseName),
    kinds,
    hasKids,
    kidsBirthYears,
    summary,
    notes: cleanStr(raw.notes, 8000),
    bio: cleanStr(raw.bio, 8000),
    howWeMet: cleanStr(raw.howWeMet, 4000),
    relationshipSummary: cleanStr(raw.relationshipSummary, 8000),
    networkCircles,
    alignedActivities: cleanStrList(raw.alignedActivities, 60, 400),
    org: cleanStr(raw.org, 300),
    orgId: raw.orgId ? remapLegacyNetworkId(cleanStr(raw.orgId, 80)) : null,
    title: cleanStr(raw.title, 300),
    department: cleanStr(raw.department, 300),
    location,
    address: cleanStr(raw.address, 500),
    rating: (() => {
      const legacy = cleanStr(raw.rating, 80).toLowerCase();
      if (legacy === 'ride or die') return 'Fan';
      return cleanEnum(raw.rating, CONTACT_RATINGS);
    })(),
    sensitivity: cleanEnum(raw.sensitivity, CONTACT_SENSITIVITIES),
    relationshipStatus: normalizeRelationshipStatus(raw),
    tasks,
    mergeSuggestions,
    // Derived from open tasks for search / older callers; not a primary edit field.
    nextStep: openTasksSummary(tasks),
    preferredContactMethods: normalizePreferredMethods(raw.preferredContactMethods),
    channels: normalizeChannels(raw.channels),
    avatarUrl: cleanStr(raw.avatarUrl, 500) || null,
    avatarSourceUrl: cleanStr(raw.avatarSourceUrl, 500) || null,
    ...normalizeLastContactFields(raw.lastContactAt, raw.lastContactPrecision),
    lastContactChannel: cleanStr(raw.lastContactChannel, 80) || null,
    ...normalizeBirthdayFields(raw),
    enrichment: normalizeEnrichment(raw.enrichment),
    // Telegram intakes start unreviewed; everything else defaults reviewed.
    intakeReviewed: raw.intakeReviewed === false ? false : true,
    createdAt: cleanStr(raw.createdAt, 64) || now,
    updatedAt: cleanStr(raw.updatedAt, 64) || now,
    source,
  };
}

/**
 * System-only unique contact id (decimal string). Not shown in the People UI.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function newContactId(env = process.env) {
  return allocateNextContactId(openNetworkDb(env));
}

/**
 * @returns {Promise<{ version: number, contacts: object[] }>}
 */
export async function loadNetworkContacts(env = process.env) {
  const db = openNetworkDb(env);
  const rows = db
    .prepare(
      'SELECT id, display_name, org, payload, created_at, updated_at FROM contacts ORDER BY display_name COLLATE NOCASE ASC, id ASC',
    )
    .all();
  const contacts = rows.map((r) => normalizeContact(rowToContact(r))).filter(Boolean);
  return { version: 1, contacts };
}

/**
 * @deprecated no-op — SQLite writes per mutation
 */
export async function saveNetworkContacts(_data, _env = process.env) {
  /* no-op */
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function getContactById(id, env = process.env) {
  const db = openNetworkDb(env);
  const want = remapLegacyNetworkId(id);
  const row = db
    .prepare('SELECT id, display_name, org, payload, created_at, updated_at FROM contacts WHERE id = ?')
    .get(want);
  if (!row) return null;
  return normalizeContact(rowToContact(row));
}

/**
 * @param {object} contact
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ skipGroupSync?: boolean, skipAbsorb?: boolean, skipContactTaskSync?: boolean }} [opts]
 */
export async function addContact(contact, env = process.env, opts = {}) {
  let payload = { ...contact };
  const orgName = cleanStr(payload?.org, 300);
  if (orgName) {
    try {
      const { ensureOrganizationByName } = await import('./network-organizations-store.js');
      const org = await ensureOrganizationByName(orgName, env);
      if (org) {
        payload.org = org.name;
        payload.orgId = org.id;
      }
    } catch {
      // ignore
    }
  }
  const normalized = normalizeContact({
    ...payload,
    id: payload?.id || newContactId(),
    createdAt: payload?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  if (!normalized) {
    const err = new Error('invalid_contact');
    err.code = 'invalid_contact';
    throw err;
  }

  if (!opts.skipAbsorb) {
    try {
      const { absorbContactIfDuplicate } = await import('./network-dedup.js');
      const absorbed = await absorbContactIfDuplicate(normalized, env);
      if (absorbed?.contact) {
        if (!opts.skipGroupSync && String(absorbed.contact.networkCircles || '').trim()) {
          try {
            const { syncContactToCommunityGroups } = await import('./network-groups-store.js');
            await syncContactToCommunityGroups(absorbed.contact.id, env);
          } catch {
            /* best-effort */
          }
        }
        return maybeSyncNewContactTasks(absorbed.contact, env, opts);
      }
    } catch {
      // Dedup is best-effort — still create the contact.
    }
  }

  const db = openNetworkDb(env);
  upsertContactRow(db, normalized);
  if (!opts.skipGroupSync && String(normalized.networkCircles || '').trim()) {
    try {
      const { syncContactToCommunityGroups } = await import('./network-groups-store.js');
      await syncContactToCommunityGroups(normalized.id, env);
    } catch {
      /* best-effort */
    }
  }
  return maybeSyncNewContactTasks(normalized, env, opts);
}

/**
 * @param {object} contact
 * @param {NodeJS.ProcessEnv} env
 * @param {{ skipContactTaskSync?: boolean }} opts
 */
async function maybeSyncNewContactTasks(contact, env, opts) {
  if (opts?.skipContactTaskSync) return contact;
  const hasTasks = (contact?.tasks || []).some((t) => t && String(t.text || '').trim());
  if (!hasTasks) return contact;
  try {
    const { syncContactTasksToVikunja } = await import('./contact-tasks-vikunja-sync.js');
    return (await syncContactTasksToVikunja(contact, env)) || contact;
  } catch (e) {
    console.warn('[contact-tasks]', e?.message || e);
    return contact;
  }
}

/**
 * @param {unknown} names
 * @param {{ kinds?: string[], preferredContactMethods?: string[], hasKids?: boolean }} [defaults]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function addContactsBulk(names, defaults = {}, env = process.env) {
  /** @type {string[]} */
  let list = [];
  if (Array.isArray(names)) {
    list = names.map((n) => cleanStr(n, 200)).filter(Boolean);
  } else {
    list = String(names || '')
      .split(/\n+/)
      .map((n) => cleanStr(n, 200))
      .filter(Boolean);
  }
  const seen = new Set();
  list = list.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!list.length) {
    const err = new Error('names_required');
    err.code = 'names_required';
    throw err;
  }

  const kinds = normalizeKinds({ kinds: defaults.kinds || ['friend'] });
  const hasKids = Boolean(defaults.hasKids);
  const preferredContactMethods = normalizePreferredMethods(defaults.preferredContactMethods || []);
  const howWeMet = cleanStr(defaults.howWeMet, 4000);
  const db = openNetworkDb(env);
  const { contacts } = await loadNetworkContacts(env);
  const existingNames = new Set(
    contacts.flatMap((c) => [
      String(c.displayName || '').toLowerCase(),
      String(c.nickname || '').toLowerCase(),
      ...(c.aliases || []).map((a) => String(a).toLowerCase()),
    ].filter(Boolean)),
  );

  const created = [];
  let absorbed = 0;
  const { absorbContactIfDuplicate } = await import('./network-dedup.js');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const displayName of list) {
      if (existingNames.has(displayName.toLowerCase())) continue;
      const normalized = normalizeContact({
        displayName,
        kinds,
        hasKids,
        preferredContactMethods,
        howWeMet: howWeMet || undefined,
        source: 'manual',
      });
      if (!normalized) continue;
      try {
        const hit = await absorbContactIfDuplicate(normalized, env);
        if (hit?.contact) {
          absorbed += 1;
          existingNames.add(displayName.toLowerCase());
          for (const a of hit.contact.aliases || []) existingNames.add(String(a).toLowerCase());
          existingNames.add(String(hit.contact.displayName || '').toLowerCase());
          continue;
        }
      } catch {
        // fall through to create
      }
      upsertContactRow(db, normalized);
      existingNames.add(displayName.toLowerCase());
      created.push(normalized);
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
  return { created, skipped: list.length - created.length - absorbed, absorbed };
}

/**
 * @param {string} id
 * @param {object} patch
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ skipGroupSync?: boolean, skipContactTaskSync?: boolean }} [opts]
 */
export async function updateContact(id, patch, env = process.env, opts = {}) {
  const prev = await getContactById(id, env);
  if (!prev) return null;
  const merged = {
    ...prev,
    ...(patch && typeof patch === 'object' ? patch : {}),
    id: prev.id,
    channels: {
      ...prev.channels,
      ...(patch?.channels && typeof patch.channels === 'object' ? patch.channels : {}),
    },
    enrichment: {
      ...prev.enrichment,
      ...(patch?.enrichment && typeof patch.enrichment === 'object' ? patch.enrichment : {}),
    },
    updatedAt: new Date().toISOString(),
  };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'kinds')) {
    merged.kinds = patch.kinds;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'preferredContactMethods')) {
    merged.preferredContactMethods = patch.preferredContactMethods;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'alignedActivities')) {
    merged.alignedActivities = patch.alignedActivities;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'tasks')) {
    const prevById = new Map(
      (Array.isArray(prev.tasks) ? prev.tasks : []).map((t) => [String(t.id || ''), t]),
    );
    merged.tasks = (Array.isArray(patch.tasks) ? patch.tasks : []).map((t) => {
      if (!t || typeof t !== 'object') return t;
      const prevT = prevById.get(String(t.id || ''));
      const vid = t.vikunjaTaskId || t.vikunja_task_id || prevT?.vikunjaTaskId;
      return vid ? { ...t, vikunjaTaskId: vid } : t;
    });
    // Prefer explicit tasks list over a stale nextStep string in the same patch.
    if (!Object.prototype.hasOwnProperty.call(patch, 'nextStep')) {
      delete merged.nextStep;
    }
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'mergeSuggestions')) {
    merged.mergeSuggestions = patch.mergeSuggestions;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'summary')) {
    merged.summary = patch.summary;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'howWeMet')) {
    merged.howWeMet = patch.howWeMet;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'relationshipSummary')) {
    merged.relationshipSummary = patch.relationshipSummary;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'networkCircles')) {
    merged.networkCircles = patch.networkCircles;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'orgId')) {
    merged.orgId = patch.orgId;
  }

  if (patch && Object.prototype.hasOwnProperty.call(patch, 'lastContactAt')) {
    const raw = String(patch.lastContactAt ?? '').trim();
    if (!raw) {
      merged.lastContactAt = null;
      merged.lastContactPrecision = null;
    } else {
      const { parseLastContactInput } = await import('./network-last-contact.js');
      const looksIso = /^\d{4}-\d{2}-\d{2}T/.test(raw);
      const prec = patch.lastContactPrecision === 'month' || patch.lastContactPrecision === 'day'
        ? patch.lastContactPrecision
        : null;
      if (looksIso && prec) {
        const ms = Date.parse(raw);
        if (!Number.isNaN(ms)) {
          merged.lastContactAt = new Date(ms).toISOString();
          merged.lastContactPrecision = prec;
        }
      } else {
        const parsed = parseLastContactInput(raw);
        if (parsed) {
          merged.lastContactAt = parsed.iso;
          merged.lastContactPrecision = parsed.precision;
        } else {
          // Mid-typing / unrecognized — keep prior stamp so autosave doesn't wipe it.
          merged.lastContactAt = prev.lastContactAt;
          merged.lastContactPrecision = prev.lastContactPrecision;
        }
      }
    }
  }

  if (patch && Object.prototype.hasOwnProperty.call(patch, 'birthday')) {
    const raw = String(patch.birthday ?? '').trim();
    delete merged.birthday;
    if (!raw) {
      merged.birthdayMonth = null;
      merged.birthdayDay = null;
      merged.birthdayYear = null;
    } else {
      const { parseBirthdayInput } = await import('./network-birthday.js');
      const parsed = parseBirthdayInput(raw);
      if (parsed) {
        merged.birthdayMonth = parsed.month;
        merged.birthdayDay = parsed.day;
        merged.birthdayYear = parsed.year;
      } else {
        // Mid-typing / unrecognized — keep prior so autosave doesn't wipe it.
        merged.birthdayMonth = prev.birthdayMonth;
        merged.birthdayDay = prev.birthdayDay;
        merged.birthdayYear = prev.birthdayYear;
      }
    }
  }

  const orgName = cleanStr(merged.org, 300);
  if (orgName) {
    try {
      const { ensureOrganizationByName } = await import('./network-organizations-store.js');
      const org = await ensureOrganizationByName(orgName, env);
      if (org) {
        merged.org = org.name;
        merged.orgId = org.id;
      }
    } catch {
      // ignore
    }
  } else if (patch && Object.prototype.hasOwnProperty.call(patch, 'org') && !orgName) {
    merged.org = '';
    merged.orgId = null;
  }

  // When only displayName changes, clear first/last so normalize re-splits
  // (middle names stay on firstName). When first/last change, prefer those.
  if (
    patch
    && Object.prototype.hasOwnProperty.call(patch, 'displayName')
    && !Object.prototype.hasOwnProperty.call(patch, 'firstName')
    && !Object.prototype.hasOwnProperty.call(patch, 'lastName')
  ) {
    delete merged.firstName;
    delete merged.lastName;
  }
  if (
    patch
    && (Object.prototype.hasOwnProperty.call(patch, 'firstName')
      || Object.prototype.hasOwnProperty.call(patch, 'lastName'))
    && !Object.prototype.hasOwnProperty.call(patch, 'displayName')
  ) {
    merged.displayName = composeDisplayName(
      Object.prototype.hasOwnProperty.call(patch, 'firstName') ? patch.firstName : prev.firstName,
      Object.prototype.hasOwnProperty.call(patch, 'lastName') ? patch.lastName : prev.lastName,
    );
  }

  const normalized = normalizeContact(merged);
  if (!normalized) {
    const err = new Error('invalid_contact');
    err.code = 'invalid_contact';
    throw err;
  }
  upsertContactRow(openNetworkDb(env), normalized);

  /** @type {object} */
  let saved = normalized;
  try {
    const { dedupeContactAfterSave } = await import('./network-dedup.js');
    const result = await dedupeContactAfterSave(normalized, env);
    if (result?.contact) saved = result.contact;
  } catch {
    // Dedup is best-effort.
  }

  const circlesChanged =
    String(prev.networkCircles || '') !== String(saved.networkCircles || '');
  if (circlesChanged && !opts.skipGroupSync) {
    try {
      const { syncContactToCommunityGroups } = await import('./network-groups-store.js');
      await syncContactToCommunityGroups(saved.id, env);
    } catch {
      // Group sync is best-effort — contact save already succeeded.
    }
  }

  if (!opts.skipContactTaskSync) {
    try {
      const { contactNeedsVikunjaTaskSync, syncContactTasksToVikunja } = await import(
        './contact-tasks-vikunja-sync.js'
      );
      if (contactNeedsVikunjaTaskSync(prev, saved)) {
        const mirrored = await syncContactTasksToVikunja(saved, env);
        if (mirrored) saved = mirrored;
      }
    } catch (e) {
      console.warn('[contact-tasks]', e?.message || e);
    }
  }
  return saved;
}

/**
 * @param {string[]} ids
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function deleteContacts(ids, env = process.env) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map((id) => remapLegacyNetworkId(String(id))))].filter(
    Boolean,
  );
  if (!want.length) return { deleted: 0 };
  /** @type {object[]} */
  const vikunjaMirror = [];
  for (const id of want) {
    const c = await getContactById(id, env);
    if (c && (c.tasks || []).some((t) => t?.vikunjaTaskId)) vikunjaMirror.push(c);
  }
  const db = openNetworkDb(env);
  const foundationIds = new Set([JULIA_CONTACT_ID, SAM_CONTACT_ID]);
  // #region agent log
  const preRows = want.map((id) => {
    const row = db.prepare('SELECT id, display_name, org, payload FROM contacts WHERE id = ?').get(id);
    if (!row) return { id, found: false };
    let payload = {};
    try {
      payload = JSON.parse(row.payload || '{}');
    } catch {
      payload = {};
    }
    return {
      id,
      found: true,
      displayName: row.display_name || null,
      org: row.org || payload.org || null,
      orgId: payload.orgId || null,
      avatarUrl: payload.avatarUrl || null,
    };
  });
  // #endregion
  const stmt = db.prepare('DELETE FROM contacts WHERE id = ?');
  let deleted = 0;
  /** @type {string[]} */
  const foundationOptedOut = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    removeContactRefs(db, want);
    for (const id of want) {
      const info = stmt.run(id);
      const n = Number(info.changes) || 0;
      deleted += n;
      if (n > 0 && foundationIds.has(id)) {
        markFoundationContactOptedOut(db, id);
        foundationOptedOut.push(id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }

  if (deleted && vikunjaMirror.length) {
    try {
      const { removeContactTasksFromVikunja } = await import('./contact-tasks-vikunja-sync.js');
      for (const c of vikunjaMirror) {
        await removeContactTasksFromVikunja(c, env);
      }
    } catch (e) {
      console.warn('[contact-tasks]', e?.message || e);
    }
  }

  // Remove local avatar files referenced by deleted contacts.
  const assetsDir = networkAssetsDir(env);
  for (const pre of preRows) {
    if (!pre.found) continue;
    await removeContactLocalAssets(pre.id, pre.avatarUrl, assetsDir);
  }

  // Cascade: delete orgs that no longer have any contacts.
  /** @type {string[]} */
  const orphanOrgIds = [
    ...new Set(preRows.filter((p) => p.found && p.orgId).map((p) => String(p.orgId))),
  ];
  let orgsDeleted = 0;
  if (orphanOrgIds.length) {
    try {
      const orgResult = await deleteOrganizations(orphanOrgIds, env);
      orgsDeleted = Number(orgResult?.deleted) || 0;
    } catch {
      /* best-effort */
    }
  }

  // #region agent log
  const postStillThere = want.map((id) => ({
    id,
    stillPresent: Boolean(db.prepare('SELECT 1 AS ok FROM contacts WHERE id = ?').get(id)),
  }));
  const orphanOrgs = [];
  for (const pre of preRows) {
    if (!pre.found || !pre.orgId) continue;
    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS n FROM contacts WHERE json_extract(payload, '$.orgId') = ? OR lower(trim(org)) = lower(trim(?))`,
      )
      .get(pre.orgId, pre.org || '');
    orphanOrgs.push({
      orgId: pre.orgId,
      orgName: pre.org,
      remainingContacts: Number(remaining?.n) || 0,
      orgRowExists: Boolean(db.prepare('SELECT 1 AS ok FROM organizations WHERE id = ?').get(pre.orgId)),
    });
  }
  void dbgDeleteContact({
    hypothesisId: 'H1-H3-H5',
    location: 'network-contacts-store.js:deleteContacts',
    message: 'contact delete result',
    data: {
      want,
      deleted,
      foundationOptedOut,
      orgsDeleted,
      preRows,
      postStillThere,
      orphanOrgs,
    },
  });
  // #endregion
  return { deleted, orgsDeleted, foundationOptedOut };
}

/**
 * Delete on-disk avatar (and contact-prefixed assets) for a removed contact.
 * @param {string} contactId
 * @param {string | null | undefined} avatarUrl
 * @param {string} assetsDir
 */
async function removeContactLocalAssets(contactId, avatarUrl, assetsDir) {
  const id = remapLegacyNetworkId(String(contactId || ''));
  /** @type {Set<string>} */
  const names = new Set();
  const url = String(avatarUrl || '');
  const m = url.match(/\/api\/network\/assets\/([^/?#]+)/i);
  if (m?.[1]) names.add(decodeURIComponent(m[1]));
  if (id === JULIA_CONTACT_ID) names.add('julia-hasty.jpg');
  if (id) {
    try {
      const entries = await fs.readdir(assetsDir);
      for (const name of entries) {
        if (name === `${id}-avatar` || name.startsWith(`${id}-avatar.`)) names.add(name);
      }
    } catch {
      /* ignore */
    }
  }
  for (const name of names) {
    const safe = path.basename(String(name || ''));
    if (!safe || safe === '.' || safe === '..') continue;
    try {
      await fs.unlink(path.join(assetsDir, safe));
    } catch {
      /* ignore missing */
    }
  }
}

// #region agent log
async function dbgDeleteContact(payload) {
  const body = {
    sessionId: '7b26c0',
    runId: 'post-fix',
    timestamp: Date.now(),
    ...payload,
  };
  try {
    const p = path.join(PKG_ROOT, '.cursor/debug-7b26c0.log');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, `${JSON.stringify(body)}\n`, 'utf8');
  } catch {
    /* ignore */
  }
  for (const url of [
    'http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22',
    'http://172.17.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22',
  ]) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7b26c0' },
      body: JSON.stringify(body),
    }).catch(() => {});
  }
}
// #endregion

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function findContactByNameOrAlias(name, env = process.env) {
  const needle = cleanStr(name, 200).toLowerCase();
  if (!needle) return null;
  const { contacts } = await loadNetworkContacts(env);
  for (const c of contacts) {
    if (String(c.displayName || '').toLowerCase() === needle) return c;
    if (String(c.nickname || '').toLowerCase() === needle) return c;
    if ((c.aliases || []).some((a) => String(a).toLowerCase() === needle)) return c;
  }
  return null;
}

/**
 * @param {{ displayName: string, aliases?: string[], notes?: string, kinds?: string[], kind?: string, org?: string, title?: string, channels?: object, summary?: string, alignedActivities?: string[] }} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
/**
 * Find an existing Network contact this Telegram intake should suggest-merge into.
 * Prefers exact name/alias, then soft near-dupe. Skips other pending telegram intakes.
 * @param {object} draft
 * @param {object[]} contacts
 * @returns {Promise<{ contact: object, score: number, reasons: string[] } | null>}
 */
async function findTelegramMergeTarget(draft, contacts) {
  const name = cleanStr(draft?.displayName, 200);
  if (!name) return null;
  const needle = name.toLowerCase();
  const pool = (Array.isArray(contacts) ? contacts : []).filter((c) => c?.id);

  for (const c of pool) {
    if (String(c.displayName || '').toLowerCase() === needle) {
      return { contact: c, score: 1, reasons: ['name_exact'] };
    }
    if (String(c.nickname || '').toLowerCase() === needle) {
      return { contact: c, score: 0.95, reasons: ['nickname_exact'] };
    }
    if ((c.aliases || []).some((a) => String(a).toLowerCase() === needle)) {
      return { contact: c, score: 0.95, reasons: ['alias_exact'] };
    }
  }

  const { findBestContactSuggestMatch } = await import('./network-dedup.js');
  // Prefer merging into established contacts, not other telegram intake stubs.
  const established = pool.filter((c) => String(c.source || '') !== 'telegram');
  const soft = findBestContactSuggestMatch(draft, established.length ? established : pool);
  if (!soft?.candidate?.id) return null;
  return {
    contact: soft.candidate,
    score: Number(soft.verdict?.score) || 0,
    reasons: Array.isArray(soft.verdict?.reasons) ? soft.verdict.reasons : ['name_similar'],
  };
}

/**
 * If an open telegram intake already suggests merge with targetId, return it.
 * @param {object[]} contacts
 * @param {string} targetId
 */
function findOpenTelegramIntakeForTarget(contacts, targetId) {
  const tid = String(targetId || '');
  if (!tid) return null;
  /** @type {object | null} */
  let best = null;
  for (const c of contacts || []) {
    if (String(c.source || '') !== 'telegram') continue;
    const pending = normalizeMergeSuggestions(c.mergeSuggestions).find(
      (s) => s.status === 'pending' && String(s.otherContactId) === tid,
    );
    if (!pending) continue;
    if (!best || String(c.updatedAt || '') > String(best.updatedAt || '')) best = c;
  }
  return best;
}

export async function upsertFromTelegram(payload, env = process.env) {
  const name = cleanStr(payload?.displayName, 200);
  if (!name) {
    const err = new Error('displayName_required');
    err.code = 'displayName_required';
    throw err;
  }
  // #region agent log
  const nameLc = name.toLowerCase();
  if (nameLc.includes('julia') || nameLc.includes('hasty') || nameLc.includes('jaybird')) {
    void dbgDeleteContact({
      hypothesisId: 'H4',
      location: 'network-contacts-store.js:upsertFromTelegram',
      message: 'telegram upsert touching julia/hasty name',
      data: { name },
    });
  }
  // #endregion
  const noteLine = cleanStr(payload?.notes, 2000);
  const kinds = normalizeKinds(payload);
  const summaryBits = [payload?.summary, 'telegram'].filter(Boolean).map((s) => cleanStr(s, 200));
  const location = cleanStr(payload?.location, 300);
  const address = cleanStr(payload?.address, 500);
  const channelUrls = [
    ...cleanStrList(payload?.channels?.urls, 20),
    cleanStr(payload?.website, 500),
  ].filter(Boolean);
  const channelsIn = {
    ...(payload.channels && typeof payload.channels === 'object' ? payload.channels : {}),
    urls: channelUrls.length
      ? [...new Set([...(payload.channels?.urls || []), ...channelUrls])].slice(0, 20)
      : payload.channels?.urls,
  };
  const preferredFromChannels = preferredMethodsForFilledChannels(
    channelsIn,
    null,
  );

  const draft = {
    displayName: name,
    aliases: payload.aliases || [],
    notes: noteLine,
    summary: summaryBits.join(' '),
    kinds,
    org: payload.org || '',
    title: payload.title || '',
    location: location || '',
    address: address || '',
    channels: channelsIn,
    source: 'telegram',
  };

  const { contacts: beforeContacts } = await loadNetworkContacts(env);
  const match = await findTelegramMergeTarget(draft, beforeContacts);
  /** @type {string | null} */
  let suggestWithId = match?.contact?.id ? String(match.contact.id) : null;

  let saved;
  // Day-to-day: name someone you already have + add info → stage on an intake
  // row and keep a suggest-merge task until you Confirm merge in Network.
  // Never silent-update the established contact from Telegram.
  const openIntake =
    suggestWithId ? findOpenTelegramIntakeForTarget(beforeContacts, suggestWithId) : null;

  if (openIntake?.id) {
    const notes = [openIntake.notes, noteLine].filter(Boolean).join('\n\n').slice(0, 8000);
    const aliases = [...new Set([...(openIntake.aliases || []), ...(payload.aliases || [])])];
    const summary = [openIntake.summary, ...summaryBits].filter(Boolean).join(' ').slice(0, 8000);
    saved = await updateContact(
      openIntake.id,
      {
        notes,
        aliases,
        summary,
        kinds: kinds.length ? kinds : openIntake.kinds,
        org: cleanStr(payload.org, 300) || openIntake.org,
        title: cleanStr(payload.title, 300) || openIntake.title,
        location: location || openIntake.location,
        address: address || openIntake.address,
        channels: { ...openIntake.channels, ...channelsIn },
        preferredContactMethods: preferredMethodsForFilledChannels(
          { ...(openIntake.channels || {}), ...channelsIn },
          openIntake.preferredContactMethods,
        ),
        source: 'telegram',
        intakeReviewed: false,
      },
      env,
      { skipGroupSync: true },
    );
    // Keep suggest-merge + open task alive if somehow cleared.
    if (suggestWithId) {
      await attachPendingMergeSuggestion(openIntake.id, suggestWithId, {
        score: match?.score,
        reasons: match?.reasons,
        source: 'telegram',
      }, env);
    }
  } else {
    saved = await addContact(
      {
        ...draft,
        relationshipStatus: 'Lead',
        preferredContactMethods: preferredFromChannels,
        intakeReviewed: false,
      },
      env,
      { skipAbsorb: true },
    );
    if (suggestWithId && saved?.id) {
      await attachPendingMergeSuggestion(saved.id, suggestWithId, {
        score: match?.score,
        reasons: match?.reasons,
        source: 'telegram',
      }, env);
    }
  }

  const verified = await getContactById(saved?.id, env);
  if (!verified?.id) {
    const err = new Error('contact_not_persisted');
    err.code = 'contact_not_persisted';
    throw err;
  }
  if (suggestWithId) {
    verified._telegramSuggestMergeWithId = suggestWithId;
    const pending = normalizeMergeSuggestions(verified.mergeSuggestions).find(
      (s) => s.status === 'pending' && String(s.otherContactId) === suggestWithId,
    );
    if (pending?.otherDisplayName) {
      verified._telegramSuggestMergeWithName = pending.otherDisplayName;
    } else if (match?.contact?.displayName) {
      verified._telegramSuggestMergeWithName = match.contact.displayName;
    }
  }
  return verified;
}

/**
 * @param {object} contact
 * @param {string} otherId
 * @param {string} otherName
 * @param {string} suggestionId
 * @param {string} taskId
 * @param {{ score?: number, reasons?: string[], source?: string }} meta
 */
function buildMergeSuggestionSide(contact, otherId, otherName, suggestionId, taskId, meta) {
  const list = normalizeMergeSuggestions(contact?.mergeSuggestions);
  const pendingSame = list.find(
    (s) => s.status === 'pending' && String(s.otherContactId) === String(otherId),
  );
  if (pendingSame) {
    return { suggestions: list, taskId: pendingSame.taskId || taskId, suggestionId: pendingSame.id, created: false };
  }
  const suggestion = {
    id: suggestionId,
    otherContactId: String(otherId),
    otherDisplayName: cleanStr(otherName, 200),
    score: Number.isFinite(Number(meta.score)) ? Number(meta.score) : 0,
    reasons: Array.isArray(meta.reasons) ? meta.reasons.map((r) => cleanStr(r, 80)).filter(Boolean) : [],
    status: 'pending',
    source: cleanStr(meta.source, 40) || 'manual',
    createdAt: new Date().toISOString(),
    taskId,
  };
  return { suggestions: [...list, suggestion], taskId, suggestionId, created: true };
}

/**
 * Ensure an open CRM task for a suggest-merge (persists until confirm/dismiss).
 * @param {object} contact
 * @param {string} otherName
 * @param {string} taskId
 */
function withMergeSuggestionTask(contact, otherName, taskId) {
  const tasks = normalizeTasks(contact);
  const needle = `suggested merge with ${cleanStr(otherName, 200).toLowerCase()}`;
  const existing = tasks.find((t) => !t.done && String(t.text || '').toLowerCase().includes(needle));
  if (existing) return { tasks, taskId: existing.id };
  const text = `Suggested merge with ${cleanStr(otherName, 200) || 'contact'}`;
  return {
    tasks: [...tasks, { id: taskId, text, done: false }],
    taskId,
  };
}

/**
 * Link two soft near-duplicates with a pending suggest-merge + open task on both.
 * @param {string} aId
 * @param {string} bId
 * @param {{ score?: number, reasons?: string[], source?: string }} [meta]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function attachPendingMergeSuggestion(aId, bId, meta = {}, env = process.env) {
  const a = await getContactById(aId, env);
  const b = await getContactById(bId, env);
  if (!a?.id || !b?.id || a.id === b.id) {
    const err = new Error('merge_suggestion_contacts_required');
    err.code = 'merge_suggestion_contacts_required';
    throw err;
  }
  const suggestionId = newMergeSuggestionId();
  const taskIdA = newContactTaskId();
  const taskIdB = newContactTaskId();

  const sideA = buildMergeSuggestionSide(a, b.id, b.displayName, suggestionId, taskIdA, meta);
  const sideB = buildMergeSuggestionSide(b, a.id, a.displayName, suggestionId, taskIdB, meta);
  // Keep a shared suggestion id when reusing an existing pending pair.
  const sharedId = sideA.created === false ? sideA.suggestionId : sideB.created === false ? sideB.suggestionId : suggestionId;
  const finalA = sideA.created
    ? buildMergeSuggestionSide(a, b.id, b.displayName, sharedId, taskIdA, meta)
    : sideA;
  const finalB = sideB.created
    ? buildMergeSuggestionSide(b, a.id, a.displayName, sharedId, taskIdB, meta)
    : sideB;

  const tasksA = withMergeSuggestionTask(a, b.displayName, finalA.taskId);
  const tasksB = withMergeSuggestionTask(b, a.displayName, finalB.taskId);

  // Patch suggestion taskIds to match ensured tasks.
  const suggestionsA = finalA.suggestions.map((s) =>
    s.id === sharedId && s.status === 'pending' ? { ...s, taskId: tasksA.taskId, otherDisplayName: b.displayName } : s,
  );
  const suggestionsB = finalB.suggestions.map((s) =>
    s.id === sharedId && s.status === 'pending' ? { ...s, taskId: tasksB.taskId, otherDisplayName: a.displayName } : s,
  );

  await updateContact(a.id, { mergeSuggestions: suggestionsA, tasks: tasksA.tasks }, env, {
    skipGroupSync: true,
  });
  await updateContact(b.id, { mergeSuggestions: suggestionsB, tasks: tasksB.tasks }, env, {
    skipGroupSync: true,
  });
  return {
    ok: true,
    suggestionId: sharedId,
    contacts: [await getContactById(a.id, env), await getContactById(b.id, env)],
  };
}

/**
 * @param {object} contact
 * @param {string} suggestionId
 * @param {'confirmed' | 'dismissed'} status
 * @param {string} [otherId]
 */
function resolveMergeSuggestionLocal(contact, suggestionId, status, otherId) {
  const list = normalizeMergeSuggestions(contact?.mergeSuggestions);
  let changed = false;
  const next = list.map((s) => {
    const hit =
      s.id === suggestionId
      || (s.status === 'pending' && otherId && String(s.otherContactId) === String(otherId));
    if (!hit || s.status !== 'pending') return s;
    changed = true;
    return { ...s, status };
  });
  const tasks = normalizeTasks(contact).map((t) => {
    const linked = next.some(
      (s) => (s.id === suggestionId || (otherId && String(s.otherContactId) === String(otherId))) && s.taskId && s.taskId === t.id,
    );
    const textHit = /^suggested merge with /i.test(String(t.text || ''));
    if ((linked || textHit) && !t.done && status !== 'pending') {
      changed = true;
      return { ...t, done: true };
    }
    return t;
  });
  return { mergeSuggestions: next, tasks, changed };
}

/**
 * Confirm a pending suggest-merge (runs real merge; task closes).
 * @param {string} contactId
 * @param {string} suggestionId
 * @param {{ displayName?: string }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function confirmMergeSuggestion(contactId, suggestionId, opts = {}, env = process.env) {
  const contact = await getContactById(contactId, env);
  if (!contact) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const suggestion = normalizeMergeSuggestions(contact.mergeSuggestions).find(
    (s) => s.id === suggestionId && s.status === 'pending',
  );
  if (!suggestion) {
    const err = new Error('merge_suggestion_not_found');
    err.code = 'merge_suggestion_not_found';
    throw err;
  }
  const other = await getContactById(suggestion.otherContactId, env);
  if (!other) {
    await dismissMergeSuggestion(contactId, suggestionId, env);
    const err = new Error('merge_suggestion_other_missing');
    err.code = 'merge_suggestion_other_missing';
    throw err;
  }
  const { mergeContacts } = await import('./network-dedup.js');
  const result = await mergeContacts(contact, other, env, {
    displayName: typeof opts.displayName === 'string' ? opts.displayName.trim() : undefined,
  });
  const survivor = result.contact;
  const resolved = resolveMergeSuggestionLocal(survivor, suggestionId, 'confirmed', other.id);
  // Drop pending suggestions that pointed at either merged id.
  const cleaned = {
    mergeSuggestions: resolved.mergeSuggestions
      .filter((s) => s.status !== 'pending' || (s.otherContactId !== contact.id && s.otherContactId !== other.id))
      .map((s) => (s.id === suggestionId ? { ...s, status: 'confirmed' } : s)),
    tasks: resolved.tasks,
  };
  const saved = await updateContact(survivor.id, cleaned, env);
  return { ok: true, contact: saved || survivor, mergedFromId: result.mergedFromId };
}

/**
 * Dismiss a pending suggest-merge (keep both contacts; close task).
 * @param {string} contactId
 * @param {string} suggestionId
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function dismissMergeSuggestion(contactId, suggestionId, env = process.env) {
  const contact = await getContactById(contactId, env);
  if (!contact) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const suggestion = normalizeMergeSuggestions(contact.mergeSuggestions).find(
    (s) => s.id === suggestionId && s.status === 'pending',
  );
  const otherId = suggestion?.otherContactId || null;
  const local = resolveMergeSuggestionLocal(contact, suggestionId, 'dismissed', otherId || undefined);
  const saved = await updateContact(contact.id, {
    mergeSuggestions: local.mergeSuggestions,
    tasks: local.tasks,
  }, env);
  if (otherId) {
    const other = await getContactById(otherId, env);
    if (other) {
      const otherLocal = resolveMergeSuggestionLocal(other, suggestionId, 'dismissed', contact.id);
      await updateContact(other.id, {
        mergeSuggestions: otherLocal.mergeSuggestions,
        tasks: otherLocal.tasks,
      }, env);
    }
  }
  return { ok: true, contact: saved || (await getContactById(contactId, env)) };
}

/**
 * Prefer methods for any channel that already has a value (so CRM fields show after Telegram ingest).
 * @param {object} channels
 * @param {unknown} [existingPrefs]
 */
function preferredMethodsForFilledChannels(channels, existingPrefs) {
  const c = channels && typeof channels === 'object' ? channels : {};
  /** @type {Record<string, string>} */
  const map = {
    phone: 'phone',
    officePhone: 'office_phone',
    email: 'email',
    signal: 'signal',
    whatsapp: 'whatsapp',
    messenger: 'messenger',
    linkedin: 'linkedin',
    other: 'other',
  };
  const out = new Set(normalizePreferredMethods(existingPrefs));
  for (const [chKey, pref] of Object.entries(map)) {
    if (cleanStr(c[chKey], 500)) out.add(pref);
  }
  return [...out];
}

/**
 * @param {Buffer} buf
 * @param {string} basename
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveNetworkAsset(buf, basename, env = process.env) {
  const dir = networkAssetsDir(env);
  await fs.mkdir(dir, { recursive: true });
  const safe = String(basename || 'asset').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  const fp = path.join(dir, safe);
  await fs.writeFile(fp, buf);
  return `/api/network/assets/${safe}`;
}

/**
 * @param {string} contactId
 * @param {{ dataUrl?: string, base64?: string, mimeType?: string }} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveContactAvatar(contactId, payload, env = process.env) {
  const contact = await getContactById(contactId, env);
  if (!contact) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }

  let mime = cleanStr(payload?.mimeType, 80).toLowerCase() || 'image/jpeg';
  let b64 = String(payload?.base64 || '').trim();
  const dataUrl = String(payload?.dataUrl || '').trim();
  if (dataUrl.startsWith('data:')) {
    const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!m) {
      const err = new Error('invalid_image');
      err.code = 'invalid_image';
      throw err;
    }
    mime = m[1].toLowerCase();
    b64 = m[2];
  }
  if (!b64) {
    const err = new Error('invalid_image');
    err.code = 'invalid_image';
    throw err;
  }

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    const err = new Error('invalid_image');
    err.code = 'invalid_image';
    throw err;
  }
  if (buf.length < 32 || buf.length > 8_000_000) {
    const err = new Error('invalid_image_size');
    err.code = 'invalid_image_size';
    throw err;
  }

  let ext = '.jpg';
  if (mime.includes('png')) ext = '.png';
  else if (mime.includes('webp')) ext = '.webp';
  else if (mime.includes('gif')) ext = '.gif';

  const avatarUrl = await saveNetworkAsset(buf, `${contactId}-avatar${ext}`, env);
  // Uploaded file has no hosting page — clear any prior photo-page association.
  return updateContact(contactId, { avatarUrl, avatarSourceUrl: null }, env);
}
