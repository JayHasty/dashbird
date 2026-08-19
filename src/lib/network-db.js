/**
 * Network CRM — local SQLite (data/network.db). Gitignored; not pushed with the repo.
 * Uses Node's built-in node:sqlite (DatabaseSync), same pattern as events-finder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  CONTACT_DISPLAY_ALIASES,
  SCENE_ALIASES_MIGRATION,
  SCENE_APL_EMPLOYEE,
  SCENE_APL_GROUPIE,
  SCENE_OLD_SHIPYARD,
  isDroppedSceneToken,
  isMisplacedLocationSceneToken,
  isMisplacedKindSceneToken,
  isPolidayToken,
  normalizeContactDisplayName,
  normalizeSceneGroupName,
  remapAplShipyardCircles,
  relocateOutOfTownFromScenes,
  kindsFromMisplacedScenes,
  mergeKinds,
} from './network-scene-normalize.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Stable contact ids (not “seed” — normal first rows). */
export const JULIA_CONTACT_ID = 'julia-hasty';
export const SAM_CONTACT_ID = 'sam-levac-levey';

export const CORVIDAE_ORG_ID = 'corvidae-labs';
export const ALL_POWER_LABS_ORG_ID = 'all-power-labs';
export const STARSHOT_ORG_ID = 'starshot-capital';
export const RUNWAY_HOUSE_GROUP_ID = 'runway-house';

/** @deprecated use JULIA_CONTACT_ID */
export const JULIA_SEED_ID = JULIA_CONTACT_ID;
/** @deprecated use SAM_CONTACT_ID */
export const SAM_LEVAC_LEVEY_ID = SAM_CONTACT_ID;

const LEGACY_ID_MAP = {
  'seed-julia-hasty': JULIA_CONTACT_ID,
  'seed-sam-levac-levey': SAM_CONTACT_ID,
  'seed-org-corvidae-labs': CORVIDAE_ORG_ID,
  'seed-org-all-power-labs': ALL_POWER_LABS_ORG_ID,
  'seed-group-runway-house': RUNWAY_HOUSE_GROUP_ID,
};

/** @type {DatabaseSync | null} */
let dbSingleton = null;
/** @type {string | null} */
let dbPathSingleton = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function networkDbPath(env = process.env) {
  const override = String(env.NETWORK_DB_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data', 'network.db');
}

/**
 * @param {string | null | undefined} id
 */
export function remapLegacyNetworkId(id) {
  const s = String(id || '').trim();
  if (!s) return s;
  return LEGACY_ID_MAP[s] || s;
}

/**
 * @param {DatabaseSync} db
 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_network_orgs_name ON organizations(name);

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      org TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_network_contacts_name ON contacts(display_name);
    CREATE INDEX IF NOT EXISTS idx_network_contacts_created ON contacts(created_at);

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_network_groups_name ON groups(name);

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_network_notes_created ON notes(created_at DESC);
  `);
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 */
function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? String(row.value) : null;
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 * @param {string} value
 */
function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** Meta key: user deleted a foundation contact — do not re-seed on DB open. */
export function foundationOptOutMetaKey(contactId) {
  return `foundation_opt_out:${remapLegacyNetworkId(String(contactId || ''))}`;
}

/**
 * @param {DatabaseSync} db
 * @param {string} contactId
 */
export function isFoundationContactOptedOut(db, contactId) {
  const id = remapLegacyNetworkId(String(contactId || ''));
  if (!id) return false;
  return getMeta(db, foundationOptOutMetaKey(id)) === '1';
}

/**
 * @param {DatabaseSync} db
 * @param {string} contactId
 */
export function markFoundationContactOptedOut(db, contactId) {
  const id = remapLegacyNetworkId(String(contactId || ''));
  if (!id) return;
  setMeta(db, foundationOptOutMetaKey(id), '1');
}

/**
 * Allocate the next system-only numeric contact id (returned as a decimal string).
 * Existing slug/UUID ids are left alone; new contacts get 1, 2, 3, …
 * @param {DatabaseSync} db
 * @returns {string}
 */
export function allocateNextContactId(db) {
  const key = 'contact_id_seq';
  let next = Number(getMeta(db, key) || 0);
  if (!Number.isFinite(next) || next < 1) {
    const rows = db.prepare('SELECT id FROM contacts').all();
    let max = 0;
    for (const r of rows) {
      const n = Number(String(r.id || ''));
      if (Number.isInteger(n) && String(n) === String(r.id).trim() && n > max) max = n;
    }
    next = max + 1;
  }
  setMeta(db, key, String(next + 1));
  return String(next);
}

/**
 * @param {unknown} v
 */
function parsePayload(v) {
  if (v && typeof v === 'object') return v;
  try {
    return JSON.parse(String(v || '{}'));
  } catch {
    return {};
  }
}

/**
 * @param {object} contact
 */
export function contactToRow(contact) {
  return {
    id: contact.id,
    display_name: String(contact.displayName || ''),
    org: String(contact.org || ''),
    payload: JSON.stringify(contact),
    created_at: String(contact.createdAt || new Date().toISOString()),
    updated_at: String(contact.updatedAt || new Date().toISOString()),
  };
}

/**
 * @param {object} org
 */
export function orgToRow(org) {
  return {
    id: org.id,
    name: String(org.name || ''),
    payload: JSON.stringify(org),
    created_at: String(org.createdAt || new Date().toISOString()),
    updated_at: String(org.updatedAt || new Date().toISOString()),
  };
}

/**
 * @param {object} group
 */
export function groupToRow(group) {
  return {
    id: group.id,
    name: String(group.name || ''),
    payload: JSON.stringify(group),
    created_at: String(group.createdAt || new Date().toISOString()),
    updated_at: String(group.updatedAt || new Date().toISOString()),
  };
}

/**
 * @param {{ id: string, display_name?: string, org?: string, payload: string, created_at?: string, updated_at?: string }} row
 */
export function rowToContact(row) {
  const p = parsePayload(row.payload);
  return {
    ...p,
    id: row.id,
    displayName: p.displayName ?? row.display_name ?? '',
    org: p.org ?? row.org ?? '',
    createdAt: p.createdAt || row.created_at,
    updatedAt: p.updatedAt || row.updated_at,
  };
}

/**
 * @param {{ id: string, name?: string, payload: string, created_at?: string, updated_at?: string }} row
 */
export function rowToOrg(row) {
  const p = parsePayload(row.payload);
  return {
    ...p,
    id: row.id,
    name: p.name ?? row.name ?? '',
    createdAt: p.createdAt || row.created_at,
    updatedAt: p.updatedAt || row.updated_at,
  };
}

/**
 * @param {{ id: string, name?: string, payload: string, created_at?: string, updated_at?: string }} row
 */
export function rowToGroup(row) {
  const p = parsePayload(row.payload);
  return {
    ...p,
    id: row.id,
    name: p.name ?? row.name ?? '',
    createdAt: p.createdAt || row.created_at,
    updatedAt: p.updatedAt || row.updated_at,
  };
}

/**
 * @param {DatabaseSync} db
 * @param {object} contact
 */
export function upsertContactRow(db, contact) {
  const row = contactToRow(contact);
  db.prepare(
    `INSERT INTO contacts (id, display_name, org, payload, created_at, updated_at)
     VALUES (@id, @display_name, @org, @payload, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       org = excluded.org,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  ).run(row);
}

/**
 * @param {DatabaseSync} db
 * @param {object} org
 */
export function upsertOrgRow(db, org) {
  const row = orgToRow(org);
  db.prepare(
    `INSERT INTO organizations (id, name, payload, created_at, updated_at)
     VALUES (@id, @name, @payload, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  ).run(row);
}

/**
 * @param {DatabaseSync} db
 * @param {object} group
 */
export function upsertGroupRow(db, group) {
  const row = groupToRow(group);
  db.prepare(
    `INSERT INTO groups (id, name, payload, created_at, updated_at)
     VALUES (@id, @name, @payload, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  ).run(row);
}

/**
 * @param {string} rel
 * @param {NodeJS.ProcessEnv} [env]
 */
function dataFile(rel, env = process.env) {
  return path.join(PKG_ROOT, 'data', rel);
}

/**
 * @param {string} filePath
 */
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * One-time import from legacy JSON files into SQLite.
 * @param {DatabaseSync} db
 * @param {NodeJS.ProcessEnv} [env]
 */
function migrateFromJsonIfNeeded(db, env = process.env) {
  if (getMeta(db, 'json_migrated') === '1') return;

  const contactsPath = String(env.NETWORK_CONTACTS_PATH || '').trim()
    ? path.isAbsolute(env.NETWORK_CONTACTS_PATH)
      ? env.NETWORK_CONTACTS_PATH
      : path.join(PKG_ROOT, env.NETWORK_CONTACTS_PATH)
    : dataFile('network-contacts.json', env);
  const orgsPath = dataFile('network-organizations.json', env);
  const groupsPath = dataFile('network-groups.json', env);
  const notesPath = dataFile('network-notes.json', env);

  const contactsJson = readJsonFile(contactsPath);
  const orgsJson = readJsonFile(orgsPath);
  const groupsJson = readJsonFile(groupsPath);
  const notesJson = readJsonFile(notesPath);

  const hasAny =
    (contactsJson?.contacts?.length || 0) +
      (orgsJson?.organizations?.length || 0) +
      (groupsJson?.groups?.length || 0) +
      (notesJson?.notes?.length || 0) >
    0;

  if (!hasAny) {
    setMeta(db, 'json_migrated', '1');
    return;
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM contacts').get();
  if (Number(count?.n) > 0) {
    setMeta(db, 'json_migrated', '1');
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const raw of orgsJson?.organizations || []) {
      const id = remapLegacyNetworkId(raw.id);
      const source = raw.source === 'seed' ? 'manual' : raw.source || 'manual';
      upsertOrgRow(db, { ...raw, id, source });
    }
    for (const raw of contactsJson?.contacts || []) {
      const id = remapLegacyNetworkId(raw.id);
      const orgId = raw.orgId ? remapLegacyNetworkId(raw.orgId) : raw.orgId;
      const source = raw.source === 'seed' ? 'manual' : raw.source || 'manual';
      upsertContactRow(db, { ...raw, id, orgId, source });
    }
    for (const raw of groupsJson?.groups || []) {
      const id = remapLegacyNetworkId(raw.id);
      const memberIds = (Array.isArray(raw.memberIds) ? raw.memberIds : []).map(remapLegacyNetworkId);
      const source = raw.source === 'seed' ? 'manual' : raw.source || 'manual';
      upsertGroupRow(db, { ...raw, id, memberIds, source });
    }
    const noteStmt = db.prepare(
      `INSERT OR REPLACE INTO notes (id, contact_id, text, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const n of notesJson?.notes || []) {
      noteStmt.run(
        String(n.id || ''),
        n.contactId ? remapLegacyNetworkId(n.contactId) : null,
        String(n.text || ''),
        String(n.source || 'manual'),
        String(n.createdAt || new Date().toISOString()),
      );
    }
    setMeta(db, 'json_migrated', '1');
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Ensure optional local foundation rows exist when data/network-foundation.local.json is present.
 * @param {DatabaseSync} db
 * @param {NodeJS.ProcessEnv} [env]
 */

/**
 * Personal Network foundation seed (owner + close contacts). Gitignored —
 * copy from backups or keep local. Without this file, Dashbird does not
 * invent personal contacts/orgs on a fresh DB.
 * @returns {object | null}
 */
function loadNetworkFoundationLocal() {
  const filePath = path.join(PKG_ROOT, 'data', 'network-foundation.local.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureFoundationRows(db, env = process.env) {
  const now = new Date().toISOString();
  const juliaCreated = '2020-01-01T00:00:00.000Z';
  const samCreated = '2020-01-01T00:00:01.000Z';
  const alreadyBootstrapped = getMeta(db, 'foundation_v1') === '1';
  const juliaOptOut = isFoundationContactOptedOut(db, JULIA_CONTACT_ID);
  const samOptOut = isFoundationContactOptedOut(db, SAM_CONTACT_ID);

  // After first bootstrap: only re-insert missing foundation rows. Never rewrite
  // existing Julia/Sam/Runway payloads on every process open (that looked like
  // edits "not sticking" across restarts and raced with live saves).
  // User-deleted foundation contacts (opt-out meta) stay gone — do not reseed.
  if (alreadyBootstrapped) {
    const missingJulia =
      !juliaOptOut && !db.prepare('SELECT 1 AS ok FROM contacts WHERE id = ?').get(JULIA_CONTACT_ID);
    const missingSam =
      !samOptOut && !db.prepare('SELECT 1 AS ok FROM contacts WHERE id = ?').get(SAM_CONTACT_ID);
    const missingRunway = !db.prepare('SELECT 1 AS ok FROM groups WHERE id = ?').get(RUNWAY_HOUSE_GROUP_ID);
    // #region agent log
    if (missingJulia || missingSam || missingRunway || juliaOptOut || samOptOut) {
      dbgFoundation({
        hypothesisId: 'H1',
        location: 'network-db.js:ensureFoundationRows',
        message: 'foundation check after bootstrap',
        data: {
          alreadyBootstrapped,
          missingJulia,
          missingSam,
          missingRunway,
          juliaOptOut,
          samOptOut,
          willReseed: Boolean(missingJulia || missingSam || missingRunway),
        },
      });
    }
    // #endregion
    if (!missingJulia && !missingSam && !missingRunway) return;
  }

  const foundationLocal = loadNetworkFoundationLocal();
  if (!foundationLocal) {
    // Public / fresh clones: never seed personal owner/friend rows from source.
    if (!alreadyBootstrapped) setMeta(db, 'foundation_v1', '1');
    return;
  }

  const orgs = Array.isArray(foundationLocal.organizations) ? foundationLocal.organizations : [];
  for (const org of orgs) {
    const id = String(org?.id || '').trim();
    if (!id || db.prepare('SELECT 1 AS ok FROM organizations WHERE id = ?').get(id)) continue;
    const createdAt = String(org.createdAt || juliaCreated);
    upsertOrgRow(db, {
      id,
      name: String(org.name || id),
      aliases: Array.isArray(org.aliases) ? org.aliases : [],
      summary: String(org.summary || ''),
      description: String(org.description || ''),
      website: org.website ?? null,
      location: String(org.location || ''),
      urls: Array.isArray(org.urls) ? org.urls : [],
      logoUrl: org.logoUrl ?? null,
      enrichment: { sources: [], enrichedAt: null, rawSummary: null },
      createdAt,
      updatedAt: now,
      source: 'manual',
    });
  }

  const assetsDir = path.join(PKG_ROOT, 'data', 'network-assets');
  const contacts = Array.isArray(foundationLocal.contacts) ? foundationLocal.contacts : [];
  for (const c of contacts) {
    const id = String(c?.id || '').trim();
    if (!id) continue;
    if (isFoundationContactOptedOut(db, id)) continue;
    if (db.prepare('SELECT 1 AS ok FROM contacts WHERE id = ?').get(id)) continue;
    let avatarUrl = null;
    const avatarFile = String(c.avatarFile || '').trim();
    if (avatarFile) {
      try {
        fs.accessSync(path.join(assetsDir, avatarFile));
        avatarUrl = `/api/network/assets/${avatarFile}`;
      } catch {
        avatarUrl = null;
      }
    }
    const channels = c.channels && typeof c.channels === 'object' ? { ...c.channels } : {};
    upsertContactRow(db, {
      id,
      displayName: String(c.displayName || id),
      aliases: Array.isArray(c.aliases) ? c.aliases : [],
      kinds: Array.isArray(c.kinds) ? c.kinds : ['friend'],
      summary: String(c.summary || ''),
      notes: String(c.notes || ''),
      bio: String(c.bio || ''),
      howWeMet: String(c.howWeMet || ''),
      networkCircles: String(c.networkCircles || ''),
      alignedActivities: Array.isArray(c.alignedActivities) ? c.alignedActivities : [],
      org: String(c.org || ''),
      orgId: c.orgId || null,
      title: String(c.title || ''),
      location: String(c.location || ''),
      preferredContactMethods: Array.isArray(c.preferredContactMethods) ? c.preferredContactMethods : [],
      channels: {
        email: null,
        phone: null,
        sms: null,
        signal: null,
        whatsapp: null,
        linkedin: channels.linkedin || null,
        urls: Array.isArray(channels.urls) ? channels.urls : [],
        ...channels,
      },
      avatarUrl,
      lastContactAt: null,
      lastContactChannel: null,
      enrichment: { sources: [], enrichedAt: null, rawSummary: null },
      createdAt: String(c.createdAt || juliaCreated),
      updatedAt: now,
      source: 'manual',
    });
  }

  const groups = Array.isArray(foundationLocal.groups) ? foundationLocal.groups : [];
  for (const g of groups) {
    const id = String(g?.id || '').trim();
    if (!id || db.prepare('SELECT 1 AS ok FROM groups WHERE id = ?').get(id)) continue;
    upsertGroupRow(db, {
      id,
      name: String(g.name || id),
      kind: String(g.kind || 'community'),
      description: String(g.description || ''),
      memberIds: Array.isArray(g.memberIds) ? g.memberIds : [],
      commonalities: [],
      suggestions: [],
      commonalitiesUpdatedAt: null,
      createdAt: String(g.createdAt || juliaCreated),
      updatedAt: now,
      source: 'manual',
    });
  }

  // First bootstrap only: pin Julia/Sam created_at ordering and drop seed labeling.
  if (!alreadyBootstrapped) {
    const foundationTimes = {
      [JULIA_CONTACT_ID]: juliaCreated,
      [SAM_CONTACT_ID]: samCreated,
    };
    for (const id of [JULIA_CONTACT_ID, SAM_CONTACT_ID]) {
      const row = db
        .prepare('SELECT id, display_name, org, payload, created_at, updated_at FROM contacts WHERE id = ?')
        .get(id);
      if (!row) continue;
      const c = rowToContact(row);
      upsertContactRow(db, {
        ...c,
        source: 'manual',
        createdAt: foundationTimes[id],
        updatedAt: c.updatedAt || now,
      });
    }
    setMeta(db, 'foundation_v1', '1');
  }
}

/**
 * Rewrite stored scene aliases / known display renames once per migration version.
 * Load/save already canonicalize via normalizeContact/normalizeGroup; this keeps
 * SQLite columns + payloads consistent for backups and raw queries.
 * @param {DatabaseSync} db
 */
function migrateSceneAliasesIfNeeded(db) {
  if (getMeta(db, SCENE_ALIASES_MIGRATION) === '1') return;
  const now = new Date().toISOString();

  const contactRows = db
    .prepare('SELECT id, display_name, org, payload, created_at, updated_at FROM contacts')
    .all();
  const upsert = db.prepare(
    `INSERT INTO contacts (id, display_name, org, payload, created_at, updated_at)
     VALUES (@id, @display_name, @org, @payload, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       org = excluded.org,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  );

  for (const row of contactRows) {
    const c = rowToContact(row);
    const nextName = normalizeContactDisplayName(c.displayName, (s) => s);
    // Prefer alias map; otherwise keep existing casing (don't title-case in migration).
    const aliased = CONTACT_DISPLAY_ALIASES[String(c.displayName || '').trim().toLowerCase()];
    const displayName = aliased || nextName || c.displayName || '';
    const relocated = relocateOutOfTownFromScenes(c.networkCircles, c.location, 4000, 300);
    const kindsFromScene = kindsFromMisplacedScenes(c.networkCircles);
    const kinds = mergeKinds(c.kinds, kindsFromScene);
    const networkCircles = remapAplShipyardCircles(relocated.networkCircles, {
      id: c.id,
      displayName,
      kinds,
    });
    const kindsChanged = JSON.stringify(kinds) !== JSON.stringify(c.kinds || []);
    if (
      displayName === c.displayName
      && networkCircles === (c.networkCircles || '')
      && relocated.location === (c.location || '')
      && !kindsChanged
    ) {
      continue;
    }
    const next = {
      ...c,
      displayName,
      networkCircles,
      location: relocated.location,
      kinds,
      updatedAt: now,
    };
    upsert.run(contactToRow(next));
  }

  const groupRows = db.prepare('SELECT id, name, payload, created_at, updated_at FROM groups').all();
  const upsertG = db.prepare(
    `INSERT INTO groups (id, name, payload, created_at, updated_at)
     VALUES (@id, @name, @payload, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  );
  /** @type {Map<string, { keepId: string, memberIds: string[], payload: object }>} */
  const byCanon = new Map();
  for (const row of groupRows) {
    const g = rowToGroup(row);
    // Misplaced location tags (Out of town, Delta) are not scene groups — drop them.
    if (isMisplacedLocationSceneToken(g.name)) {
      db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
      continue;
    }
    // Type-as-scene tags (Family) are not scene groups — drop them.
    if (isMisplacedKindSceneToken(g.name)) {
      db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
      continue;
    }
    // Retired scenes (e.g. Jake) — delete the group; tokens already stripped on contacts.
    if (isDroppedSceneToken(g.name)) {
      db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
      continue;
    }
    // Poliday is event-only — demote community → event and keep members.
    if (isPolidayToken(g.name)) {
      const name = String(g.name || '')
        .replace(/\s+/g, ' ')
        .trim() || 'Poliday';
      upsertG.run(
        groupToRow({
          ...g,
          name,
          kind: 'event',
          updatedAt: now,
        }),
      );
      continue;
    }
    const name = normalizeSceneGroupName(g.name, 300);
    if (!name) continue;
    const key = name.toLowerCase();
    const existing = byCanon.get(key);
    if (!existing) {
      byCanon.set(key, {
        keepId: g.id,
        memberIds: [...(g.memberIds || [])],
        payload: { ...g, name, updatedAt: now },
      });
      if (name !== g.name) {
        upsertG.run(groupToRow({ ...g, name, updatedAt: now }));
      }
      continue;
    }
    for (const mid of g.memberIds || []) {
      if (!existing.memberIds.includes(mid)) existing.memberIds.push(mid);
    }
    db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
  }
  for (const entry of byCanon.values()) {
    const payload = {
      ...entry.payload,
      id: entry.keepId,
      name: entry.payload.name,
      memberIds: entry.memberIds,
      updatedAt: now,
    };
    upsertG.run(groupToRow(payload));
  }

  // Rebuild APL / shipyard community membership from contact Scene tags.
  const sceneBuckets = [SCENE_APL_GROUPIE, SCENE_APL_EMPLOYEE, SCENE_OLD_SHIPYARD];
  /** @type {Map<string, string[]>} */
  const membersByScene = new Map(sceneBuckets.map((n) => [n.toLowerCase(), []]));
  const refreshedContacts = db
    .prepare('SELECT id, display_name, org, payload, created_at, updated_at FROM contacts')
    .all();
  for (const row of refreshedContacts) {
    const c = rowToContact(row);
    const tokens = String(c.networkCircles || '')
      .split(/[,;|/]+/)
      .map((p) => String(p || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    for (const token of tokens) {
      const list = membersByScene.get(token.toLowerCase());
      if (!list) continue;
      if (!list.includes(c.id)) list.push(c.id);
    }
  }
  for (const sceneName of sceneBuckets) {
    const key = sceneName.toLowerCase();
    const memberIds = membersByScene.get(key) || [];
    const existing = byCanon.get(key);
    if (existing) {
      upsertG.run(
        groupToRow({
          ...existing.payload,
          id: existing.keepId,
          name: sceneName,
          kind: 'community',
          memberIds,
          updatedAt: now,
        }),
      );
      continue;
    }
    if (!memberIds.length) continue;
    upsertG.run(
      groupToRow({
        id: randomUUID(),
        name: sceneName,
        kind: 'community',
        memberIds,
        notes: '',
        createdAt: now,
        updatedAt: now,
        source: 'manual',
      }),
    );
  }

  setMeta(db, SCENE_ALIASES_MIGRATION, '1');
}

const ORPHAN_CONTACT_REFS_MIGRATION = 'orphan_contact_refs_v1';
const TELEGRAM_LAST_CONTACT_MIGRATION = 'clear_telegram_last_contact_v1';

/**
 * Clear lastContact* stamped by Telegram ingest (message arrival ≠ last contact).
 * @param {DatabaseSync} db
 */
function migrateClearTelegramLastContactIfNeeded(db) {
  if (getMeta(db, TELEGRAM_LAST_CONTACT_MIGRATION) === '1') return;
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db
      .prepare('SELECT id, display_name, org, payload, created_at, updated_at FROM contacts')
      .all();
    for (const row of rows) {
      const c = rowToContact(row);
      const channel = String(c.lastContactChannel || '').trim().toLowerCase();
      if (channel !== 'telegram') continue;
      upsertContactRow(db, {
        ...c,
        lastContactAt: null,
        lastContactPrecision: null,
        lastContactChannel: null,
        updatedAt: now,
      });
    }
    setMeta(db, TELEGRAM_LAST_CONTACT_MIGRATION, '1');
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Drop group memberIds / note contact_ids that no longer point at a contact row.
 * @param {DatabaseSync} db
 * @returns {{ groupsTouched: number, membersRemoved: number, notesCleared: number }}
 */
export function pruneOrphanContactRefs(db) {
  const contactIds = new Set(db.prepare('SELECT id FROM contacts').all().map((r) => String(r.id)));
  let groupsTouched = 0;
  let membersRemoved = 0;
  const now = new Date().toISOString();

  const groupRows = db.prepare('SELECT id, name, payload, created_at, updated_at FROM groups').all();
  for (const row of groupRows) {
    const g = rowToGroup(row);
    const members = Array.isArray(g.memberIds) ? g.memberIds.map((id) => String(id)) : [];
    const next = members.filter((id) => contactIds.has(id));
    const removed = members.length - next.length;
    if (!removed) continue;
    membersRemoved += removed;
    groupsTouched += 1;
    upsertGroupRow(db, { ...g, memberIds: next, updatedAt: now });
  }

  const noteRows = db.prepare('SELECT id, contact_id FROM notes WHERE contact_id IS NOT NULL').all();
  let notesCleared = 0;
  const clearNote = db.prepare('UPDATE notes SET contact_id = NULL WHERE id = ?');
  for (const row of noteRows) {
    const cid = String(row.contact_id || '');
    if (!cid || contactIds.has(cid)) continue;
    clearNote.run(row.id);
    notesCleared += 1;
  }


  return { groupsTouched, membersRemoved, notesCleared };
}

/**
 * @param {DatabaseSync} db
 */
function migrateOrphanContactRefsIfNeeded(db) {
  if (getMeta(db, ORPHAN_CONTACT_REFS_MIGRATION) === '1') return;
  db.exec('BEGIN IMMEDIATE');
  try {
    pruneOrphanContactRefs(db);
    setMeta(db, ORPHAN_CONTACT_REFS_MIGRATION, '1');
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Remove deleted contact ids from groups + notes (no survivor remap).
 * @param {DatabaseSync} db
 * @param {string[]} ids
 */
export function removeContactRefs(db, ids) {
  const drop = new Set((Array.isArray(ids) ? ids : []).map((id) => remapLegacyNetworkId(String(id))).filter(Boolean));
  if (!drop.size) return;

  db.prepare(
    `UPDATE notes SET contact_id = NULL WHERE contact_id IN (${[...drop].map(() => '?').join(',')})`,
  ).run(...drop);

  const now = new Date().toISOString();
  const groupRows = db.prepare('SELECT id, name, payload, created_at, updated_at FROM groups').all();
  for (const row of groupRows) {
    const g = rowToGroup(row);
    const members = Array.isArray(g.memberIds) ? g.memberIds.map((id) => String(id)) : [];
    if (!members.some((id) => drop.has(remapLegacyNetworkId(id)))) continue;
    const memberIds = members.filter((id) => !drop.has(remapLegacyNetworkId(id)));
    upsertGroupRow(db, { ...g, memberIds, updatedAt: now });
  }

}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {DatabaseSync}
 */
export function openNetworkDb(env = process.env) {
  const dbPath = networkDbPath(env);
  if (dbSingleton && dbPathSingleton === dbPath) return dbSingleton;

  if (dbSingleton) {
    try {
      dbSingleton.close();
    } catch {
      /* ignore */
    }
    dbSingleton = null;
    dbPathSingleton = null;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // WAL so readers/writers don't clobber each other across restarts / host tools.
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  } catch {
    /* ignore */
  }
  migrate(db);
  migrateFromJsonIfNeeded(db, env);
  ensureFoundationRows(db, env);
  migrateSceneAliasesIfNeeded(db);
  migrateOrphanContactRefsIfNeeded(db);
  migrateClearTelegramLastContactIfNeeded(db);
  dbSingleton = db;
  dbPathSingleton = dbPath;
  return db;
}

export function closeNetworkDb() {
  if (!dbSingleton) return;
  try {
    dbSingleton.close();
  } catch {
    /* ignore */
  }
  dbSingleton = null;
  dbPathSingleton = null;
}

// #region agent log
function dbgFoundation(payload) {
  const body = {
    sessionId: '7b26c0',
    runId: 'post-fix',
    timestamp: Date.now(),
    ...payload,
  };
  try {
    const p = path.join(PKG_ROOT, '.cursor/debug-7b26c0.log');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(body)}\n`, 'utf8');
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
