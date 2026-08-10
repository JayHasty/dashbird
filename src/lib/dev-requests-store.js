/**
 * Dashbird dev / feature change requests — local SQLite index + one folder per request.
 * Screenshots live beside request.json under data/dev-requests/<folder>/ for easy dev browsing.
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fixHostOwnership } from './fix-host-ownership.js';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  areaLabel,
  DEV_REQUEST_PRIORITIES,
  findArea,
  normalizePlatform,
  normalizePriority,
  resolveAreaId,
} from './dev-request-areas.js';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEV_REQUESTS_ROOT = path.join(PKG_ROOT, 'data', 'dev-requests');
export const DEV_REQUESTS_INBOX_PATH = path.join(DEV_REQUESTS_ROOT, 'inbox.md');
export const DEV_REQUESTS_DB_PATH = path.join(PKG_ROOT, 'data', 'dev-requests.db');

/** @type {DatabaseSync | null} */
let dbSingleton = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function devRequestsDbPath(env = process.env) {
  const override = String(env.DEV_REQUESTS_DB_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return DEV_REQUESTS_DB_PATH;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function devRequestsRoot(env = process.env) {
  const override = String(env.DEV_REQUESTS_ROOT || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return DEV_REQUESTS_ROOT;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function openDb(env = process.env) {
  const dbPath = devRequestsDbPath(env);
  if (dbSingleton && dbPath === DEV_REQUESTS_DB_PATH) return dbSingleton;
  mkdir(path.dirname(dbPath), { recursive: true }).catch(() => {});
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS dev_requests (
      id TEXT PRIMARY KEY NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT 'desktop',
      area TEXT NOT NULL DEFAULT 'other',
      section TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'open',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dev_requests_status_priority
      ON dev_requests(status, priority, created_at);
  `);
  if (dbPath === DEV_REQUESTS_DB_PATH) {
    dbSingleton = db;
  }
  return db;
}

/**
 * @param {string} s
 */
function slugPart(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item';
}

/**
 * @returns {string}
 */
function newId() {
  return randomBytes(4).toString('hex');
}

/**
 * @param {number} priority
 * @param {string} area
 * @param {string} platform
 * @param {string} id
 */
function folderNameFor(priority, area, platform, id) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const p = DEV_REQUEST_PRIORITIES[normalizePriority(priority)]?.short?.toLowerCase() || 'med';
  return `${ts}-${p}-${slugPart(area)}-${platform}-${id}`;
}

/**
 * @param {{ dataUrl?: string, base64?: string, mimeType?: string, filename?: string }} payload
 */
function decodeImagePayload(payload) {
  let mime = String(payload?.mimeType || '').trim().toLowerCase() || 'image/png';
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
  let ext = '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg';
  else if (mime.includes('webp')) ext = '.webp';
  else if (mime.includes('gif')) ext = '.gif';
  const base = slugPart(path.basename(String(payload?.filename || ''), path.extname(String(payload?.filename || ''))));
  const filename = `${base || 'screenshot'}${ext}`;
  return { buf, mime, filename };
}

/**
 * @param {Record<string, unknown>} row
 */
function rowToRequest(row) {
  /** @type {string[]} */
  let attachments = [];
  try {
    attachments = JSON.parse(String(row.attachments_json || '[]'));
    if (!Array.isArray(attachments)) attachments = [];
  } catch {
    attachments = [];
  }
  return {
    id: String(row.id),
    folder: String(row.folder),
    title: String(row.title),
    body: String(row.body || ''),
    platform: normalizePlatform(row.platform),
    area: String(row.area || 'other'),
    areaLabel: areaLabel(normalizePlatform(row.platform), String(row.area || 'other')),
    section: row.section ? String(row.section) : null,
    priority: normalizePriority(row.priority),
    priorityLabel: DEV_REQUEST_PRIORITIES[normalizePriority(row.priority)]?.label || 'Med',
    status: String(row.status || 'open'),
    attachments,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    path: path.join(devRequestsRoot(), String(row.folder)),
  };
}

/**
 * @param {{ status?: string }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function listDevRequests(opts = {}, env = process.env) {
  const db = openDb(env);
  const status = String(opts.status || 'open').trim() || 'open';
  const rows = db
    .prepare(
      `SELECT * FROM dev_requests
       WHERE status = ?
       ORDER BY priority ASC, created_at ASC`,
    )
    .all(status);
  return rows.map((row) => rowToRequest(/** @type {Record<string, unknown>} */ (row)));
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
export function getDevRequest(id, env = process.env) {
  const db = openDb(env);
  const row = db.prepare('SELECT * FROM dev_requests WHERE id = ?').get(String(id || '').trim());
  if (!row) return null;
  return rowToRequest(/** @type {Record<string, unknown>} */ (row));
}

/**
 * @param {{
 *   title: string,
 *   body?: string,
 *   platform?: string,
 *   area?: string,
 *   section?: string,
 *   priority?: number,
 *   attachments?: Array<{ dataUrl?: string, base64?: string, mimeType?: string, filename?: string }>,
 * }} input
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function createDevRequest(input, env = process.env) {
  const title = String(input?.title || '').trim();
  if (!title) {
    const err = new Error('title_required');
    err.code = 'title_required';
    throw err;
  }

  const platform = normalizePlatform(input?.platform);
  const area = resolveAreaId(String(input?.area || 'events').trim() || 'events');
  if (!findArea(platform, area)) {
    const err = new Error('invalid_area');
    err.code = 'invalid_area';
    throw err;
  }
  const section = input?.section == null ? '' : String(input.section).trim().slice(0, 120);
  const priority = normalizePriority(input?.priority);
  const body = String(input?.body || '').trim();
  const id = newId();
  const folder = folderNameFor(priority, area, platform, id);
  const root = devRequestsRoot(env);
  const dir = path.join(root, folder);
  const now = new Date().toISOString();

  await mkdir(dir, { recursive: true });

  /** @type {string[]} */
  const savedAttachments = [];
  const attachments = Array.isArray(input?.attachments) ? input.attachments.slice(0, 4) : [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att || typeof att !== 'object') continue;
    const { buf, filename } = decodeImagePayload(att);
    let name = filename;
    if (savedAttachments.includes(name)) name = `${path.basename(name, path.extname(name))}-${i + 1}${path.extname(name)}`;
    await writeFile(path.join(dir, name), buf);
    savedAttachments.push(name);
  }

  const requestJson = {
    id,
    folder,
    title,
    body,
    platform,
    area,
    areaLabel: areaLabel(platform, area),
    section: section || null,
    priority,
    priorityLabel: DEV_REQUEST_PRIORITIES[priority]?.label || 'Med',
    status: 'open',
    attachments: savedAttachments,
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(path.join(dir, 'request.json'), `${JSON.stringify(requestJson, null, 2)}\n`, 'utf8');
  await fixHostOwnership([dir, path.join(dir, 'request.json'), ...savedAttachments.map((n) => path.join(dir, n))], env);

  const db = openDb(env);
  db.prepare(
    `INSERT INTO dev_requests
      (id, folder, title, body, platform, area, section, priority, status, attachments_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
  ).run(
    id,
    folder,
    title,
    body,
    platform,
    area,
    section,
    priority,
    JSON.stringify(savedAttachments),
    now,
    now,
  );

  await syncDevRequestsInbox(env);
  return getDevRequest(id, env);
}

/**
 * @param {string} id
 * @param {{ status?: string, priority?: number, title?: string, body?: string }} patch
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function updateDevRequest(id, patch, env = process.env) {
  const existing = getDevRequest(id, env);
  if (!existing) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }

  const status = patch?.status != null ? String(patch.status).trim() : existing.status;
  const priority = patch?.priority != null ? normalizePriority(patch.priority) : existing.priority;
  const nextTitle = patch?.title != null ? String(patch.title).trim() : existing.title;
  const title = nextTitle || existing.title;
  const body = patch?.body != null ? String(patch.body).trim() : existing.body;
  const now = new Date().toISOString();

  const db = openDb(env);
  db.prepare(
    `UPDATE dev_requests SET status = ?, priority = ?, title = ?, body = ?, updated_at = ? WHERE id = ?`,
  ).run(status, priority, title, body, now, id);

  try {
    const jsonPath = path.join(devRequestsRoot(env), existing.folder, 'request.json');
    const raw = await readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.status = status;
    parsed.priority = priority;
    parsed.priorityLabel = DEV_REQUEST_PRIORITIES[priority]?.label || 'Med';
    parsed.title = title;
    parsed.body = body;
    parsed.updatedAt = now;
    await writeFile(jsonPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  } catch {
    // folder/json missing — DB row still authoritative for inbox
  }

  await syncDevRequestsInbox(env);
  return getDevRequest(id, env);
}

/**
 * @param {string} id
 * @param {string} filename
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function readDevRequestAttachment(id, filename, env = process.env) {
  const req = getDevRequest(id, env);
  if (!req) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const safe = path.basename(String(filename || ''));
  if (!safe || !req.attachments.includes(safe)) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const filePath = path.join(devRequestsRoot(env), req.folder, safe);
  const buf = await readFile(filePath);
  return { buf, filename: safe };
}

/**
 * Regenerate data/dev-requests/inbox.md for Cursor agents.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function syncDevRequestsInbox(env = process.env) {
  const open = listDevRequests({ status: 'open' }, env);
  const root = devRequestsRoot(env);
  const relRoot = path.relative(path.join(PKG_ROOT, 'data'), root) || 'dev-requests';

  const lines = [
    '# Dashbird dev requests inbox',
    '',
    'Structured feature / dev change requests from desktop and mobile.',
    'Each request has its own folder under `data/dev-requests/` with `request.json` and any screenshots.',
    'Ask Cursor to work open items by priority; mark done via `PATCH /api/dev-requests/:id`.',
    '',
  ];

  if (!open.length) {
    lines.push('_No open dev requests._', '');
  } else {
    let lastPriority = null;
    for (const req of open) {
      if (req.priority !== lastPriority) {
        lastPriority = req.priority;
        lines.push(`## ${DEV_REQUEST_PRIORITIES[req.priority]?.label || 'Med'}`, '');
      }
      const folderRel = `${relRoot}/${req.folder}`;
      lines.push(
        `- [ ] **${req.title}** — ${req.areaLabel} (${req.platform})`,
        `  - Folder: \`${folderRel}/\``,
      );
      if (req.body) {
        lines.push(`  - Notes: ${req.body.replace(/\r?\n/g, ' · ')}`);
      }
      for (const att of req.attachments) {
        lines.push(`  - Screenshot: \`${folderRel}/${att}\``);
      }
      lines.push('');
    }
  }

  await mkdir(root, { recursive: true });
  await writeFile(DEV_REQUESTS_INBOX_PATH, lines.join('\n'), 'utf8');
  await fixHostOwnership([root, DEV_REQUESTS_INBOX_PATH], env);
  return DEV_REQUESTS_INBOX_PATH;
}

/**
 * One-time rebuild of SQLite index from folders (if DB lost).
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function rebuildDevRequestsIndex(env = process.env) {
  const root = devRequestsRoot(env);
  await mkdir(root, { recursive: true });
  const db = openDb(env);
  db.exec('DELETE FROM dev_requests');
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const jsonPath = path.join(root, ent.name, 'request.json');
    try {
      const raw = await readFile(jsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      const now = String(parsed.updatedAt || parsed.createdAt || new Date().toISOString());
      db.prepare(
        `INSERT OR REPLACE INTO dev_requests
          (id, folder, title, body, platform, area, section, priority, status, attachments_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        String(parsed.id || ent.name),
        ent.name,
        String(parsed.title || 'Untitled'),
        String(parsed.body || ''),
        normalizePlatform(parsed.platform),
        String(parsed.area || 'other'),
        String(parsed.section || ''),
        normalizePriority(parsed.priority),
        String(parsed.status || 'open'),
        JSON.stringify(Array.isArray(parsed.attachments) ? parsed.attachments : []),
        String(parsed.createdAt || now),
        now,
      );
    } catch {
      // skip malformed folders
    }
  }
  await syncDevRequestsInbox(env);
}
