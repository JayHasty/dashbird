/**
 * Task random-picker metadata: per-task tags + per-project default location.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeDifficulty,
  normalizeDuration,
  normalizeLocation,
  normalizeLocations,
  normalizePriority,
  normalizeTime,
  normalizeTimes,
  TASK_LOCATIONS,
} from './task-random-enums.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export function taskRandomMetaJsonPath(env = process.env) {
  const override = String(env.TASK_RANDOM_META_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/task-random-meta.json');
}

export function taskProjectLocationsMdPath(env = process.env) {
  const override = String(env.TASK_PROJECT_LOCATIONS_MD_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/task-project-locations.md');
}

function isLegacyTimeToken(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
  return s === 'weekend' || s === 'afterhours' || s === 'after_hours' || s === 'evening';
}

const LEGACY_DURATION_IDS = new Set([
  '10m',
  '30m',
  '1hr+',
  '5m',
  '15m',
  '1h+',
  '1hr',
  '60m',
  '<10min',
  '<10m',
  '30min',
]);

function taskMetaNeedsMigration(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw;
  const dur = String(r.duration || '').trim().toLowerCase().replace(/\s+/g, '');
  if (LEGACY_DURATION_IDS.has(dur)) return true;
  const times = Array.isArray(r.times) ? r.times : r.time != null ? [r.time] : [];
  return times.some(isLegacyTimeToken);
}

function metaNeedsMigration(raw) {
  const taskRaw = raw?.byTaskId && typeof raw.byTaskId === 'object' ? raw.byTaskId : {};
  return Object.values(taskRaw).some(taskMetaNeedsMigration);
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeIsoDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeTaskMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw;
  const out = {};
  const diff = normalizeDifficulty(r.difficulty);
  if (diff) out.difficulty = diff;
  const pri = normalizePriority(r.priority);
  if (pri) out.priority = pri;
  const dur = normalizeDuration(r.duration);
  if (dur) out.duration = dur;
  if (r.locationAny === true) out.locationAny = true;
  if (r.location != null && r.location !== '') {
    const loc = normalizeLocation(r.location);
    if (loc) out.location = loc;
  }
  const locs = normalizeLocations(r.locations);
  if (locs.length && !out.location && !out.locationAny) out.locations = locs;
  if (r.timeAny === true) out.timeAny = true;
  const rawTimes = Array.isArray(r.times) ? r.times : r.time != null ? [r.time] : [];
  const hadLegacyOnlyTime =
    rawTimes.length > 0 && rawTimes.every(isLegacyTimeToken) && !rawTimes.some((t) => normalizeTime(t));
  const times = normalizeTimes(r.times ?? r.time);
  if (hadLegacyOnlyTime) out.timeAny = true;
  else if (times.length && !out.timeAny) out.times = times;
  const scheduledAt = normalizeIsoDate(r.scheduledAt);
  if (scheduledAt) out.scheduledAt = scheduledAt;
  const scheduledFor = normalizeIsoDate(r.scheduledFor);
  if (scheduledFor) out.scheduledFor = scheduledFor;
  if (r.waitingOn === true) out.waitingOn = true;
  const waitingNotes = String(r.waitingNotes || '').trim().slice(0, 400);
  if (waitingNotes) out.waitingNotes = waitingNotes;
  return Object.keys(out).length ? out : null;
}

function normalizeProjectMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw;
  const out = {};
  const loc = normalizeLocation(r.location);
  if (loc) out.location = loc;
  const notes = String(r.notes || '').trim().slice(0, 200);
  if (notes) out.notes = notes;
  return Object.keys(out).length ? out : null;
}

export function normalizeTaskRandomMeta(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const byTaskId = {};
  const taskRaw = o.byTaskId && typeof o.byTaskId === 'object' ? o.byTaskId : {};
  for (const [id, row] of Object.entries(taskRaw)) {
    const key = String(id || '').trim();
    if (!/^\d+$/.test(key)) continue;
    const norm = normalizeTaskMeta(row);
    if (norm) byTaskId[key] = norm;
  }
  const byProjectId = {};
  const projRaw = o.byProjectId && typeof o.byProjectId === 'object' ? o.byProjectId : {};
  for (const [id, row] of Object.entries(projRaw)) {
    const key = String(id || '').trim();
    if (!/^\d+$/.test(key)) continue;
    const norm = normalizeProjectMeta(row);
    if (norm) byProjectId[key] = norm;
  }
  return { byTaskId, byProjectId };
}

export async function loadTaskRandomMeta(env = process.env) {
  try {
    const target = taskRandomMetaJsonPath(env);
    const rawText = await fs.readFile(target, 'utf8');
    const parsed = JSON.parse(rawText);
    const meta = normalizeTaskRandomMeta(parsed);
    if (metaNeedsMigration(parsed)) await writeTaskRandomMeta(meta, env);
    return meta;
  } catch {
    const fromMd = await parseProjectLocationsMarkdown(env);
    if (Object.keys(fromMd.byProjectId).length) {
      const meta = { byTaskId: {}, byProjectId: fromMd.byProjectId };
      await writeTaskRandomMeta(meta, env);
      return meta;
    }
    return { byTaskId: {}, byProjectId: {} };
  }
}

async function writeTaskRandomMeta(meta, env = process.env) {
  const target = taskRandomMetaJsonPath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, `${JSON.stringify(normalizeTaskRandomMeta(meta), null, 2)}\n`, 'utf8');
  await fs.rename(staging, target);
}

export async function parseProjectLocationsMarkdown(env = process.env) {
  const byProjectId = {};
  const rows = [];
  let text = '';
  try {
    text = await fs.readFile(taskProjectLocationsMdPath(env), 'utf8');
  } catch {
    return { byProjectId, rows };
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\|\s*[-:]+/.test(trimmed)) continue;
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const idRaw = cells[0].replace(/\*/g, '').trim();
    if (!/^\d+$/.test(idRaw)) continue;
    const id = String(Number(idRaw));
    const title = cells[1] || '';
    const locRaw = cells[2].replace(/\*/g, '').trim();
    const notes = cells[3] || '';
    const loc = normalizeLocation(locRaw);
    const row = {};
    if (loc) row.location = loc;
    if (notes) row.notes = notes.slice(0, 200);
    if (Object.keys(row).length) byProjectId[id] = row;
    rows.push({ id: Number(id), title, ...(notes ? { notes } : {}) });
  }
  return { byProjectId, rows };
}

export function renderProjectLocationsMarkdown(projects, byProjectId) {
  const lines = [
    '# Task project locations',
    '',
    'Default location for tasks in each project (each task can override in the Tasks list).',
    'Edit the Location column, save the file; Dashbird reloads on next read.',
    '',
    `Allowed values: *(blank / any)* | ${TASK_LOCATIONS.join(' | ')}`,
    '',
    '| ID | Project | Location | Notes |',
    '|----|---------|----------|-------|',
  ];
  for (const p of projects) {
    const id = String(p.id);
    const meta = byProjectId[id] || {};
    const loc = meta.location || '';
    const notes = meta.notes || '';
    lines.push(
      `| ${p.id} | ${String(p.title || '').replace(/\|/g, '\\|')} | ${loc} | ${notes.replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export async function readProjectLocationsMarkdown(env = process.env) {
  try {
    return await fs.readFile(taskProjectLocationsMdPath(env), 'utf8');
  } catch {
    return '';
  }
}

export async function saveProjectLocationsMarkdown(markdown, env = process.env) {
  const target = taskProjectLocationsMdPath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
  await fs.rename(staging, target);
  const parsed = await parseProjectLocationsMarkdown(env);
  const meta = await loadTaskRandomMeta(env);
  meta.byProjectId = { ...meta.byProjectId, ...parsed.byProjectId };
  for (const [id, row] of Object.entries(parsed.byProjectId)) {
    if (!row.location && !row.notes) delete meta.byProjectId[id];
  }
  await writeTaskRandomMeta(meta, env);
  return meta;
}

export async function syncProjectLocationsMarkdown(projects, env = process.env) {
  const meta = await loadTaskRandomMeta(env);
  const parsed = await parseProjectLocationsMarkdown(env);
  for (const [id, row] of Object.entries(parsed.byProjectId)) {
    if (!meta.byProjectId[id]) meta.byProjectId[id] = row;
    else if (row.notes && !meta.byProjectId[id].notes) meta.byProjectId[id].notes = row.notes;
  }
  const md = renderProjectLocationsMarkdown(projects, meta.byProjectId);
  await saveProjectLocationsMarkdown(md, env);
  return { meta: await loadTaskRandomMeta(env), markdown: md };
}

/** Serialize read-modify-write of the shared meta JSON file. */
let metaLock = Promise.resolve();

function withMetaLock(fn) {
  const run = metaLock.then(fn, fn);
  metaLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function patchTaskMeta(taskId, patch, env = process.env) {
  return withMetaLock(() => patchTaskMetaUnlocked(taskId, patch, env));
}

async function patchTaskMetaUnlocked(taskId, patch, env = process.env) {
  const id = String(taskId || '').trim();
  if (!/^\d+$/.test(id)) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }
  const meta = await loadTaskRandomMeta(env);
  const prev = meta.byTaskId[id] || {};
  const next = { ...prev };
  if (patch.difficulty !== undefined) {
    const d = normalizeDifficulty(patch.difficulty);
    if (d) next.difficulty = d;
    else delete next.difficulty;
  }
  if (patch.priority !== undefined) {
    const p = normalizePriority(patch.priority);
    if (p) next.priority = p;
    else delete next.priority;
  }
  if (patch.duration !== undefined) {
    const d = normalizeDuration(patch.duration);
    if (d) next.duration = d;
    else delete next.duration;
  }
  if (patch.inheritLocation === true) {
    delete next.location;
    delete next.locations;
    delete next.locationAny;
  }
  if (patch.locationAny === true) {
    next.locationAny = true;
    delete next.location;
    delete next.locations;
  }
  if (patch.location !== undefined) {
    const loc =
      patch.location == null || patch.location === '' ? null : normalizeLocation(patch.location);
    if (loc) {
      next.location = loc;
      delete next.locationAny;
      delete next.locations;
    } else {
      delete next.location;
    }
  }
  if (patch.locations !== undefined) {
    const locs = normalizeLocations(patch.locations);
    if (locs.length) {
      next.locations = locs;
      delete next.location;
      delete next.locationAny;
    } else {
      delete next.locations;
    }
  }
  if (patch.times !== undefined) {
    const times = normalizeTimes(patch.times);
    if (times.length) {
      next.times = times;
      delete next.timeAny;
    } else {
      delete next.times;
    }
  }
  if (patch.timeAny === true) {
    next.timeAny = true;
    delete next.times;
  }
  if (patch.clearSchedule === true) {
    delete next.scheduledAt;
    delete next.scheduledFor;
  }
  if (patch.scheduledAt !== undefined) {
    if (patch.scheduledAt == null || patch.scheduledAt === '') delete next.scheduledAt;
    else {
      const iso = normalizeIsoDate(patch.scheduledAt);
      if (iso) next.scheduledAt = iso;
    }
  }
  if (patch.scheduledFor !== undefined) {
    if (patch.scheduledFor == null || patch.scheduledFor === '') delete next.scheduledFor;
    else {
      const iso = normalizeIsoDate(patch.scheduledFor);
      if (iso) next.scheduledFor = iso;
    }
  }
  if (patch.waitingOn !== undefined) {
    if (patch.waitingOn === true) next.waitingOn = true;
    else delete next.waitingOn;
  }
  if (patch.waitingNotes !== undefined) {
    const notes = String(patch.waitingNotes || '').trim().slice(0, 400);
    if (notes) next.waitingNotes = notes;
    else delete next.waitingNotes;
  }
  if (Object.keys(next).length) meta.byTaskId[id] = next;
  else delete meta.byTaskId[id];
  await writeTaskRandomMeta(meta, env);
  return meta;
}

export async function patchProjectMeta(projectId, patch, projects = [], env = process.env) {
  return withMetaLock(() => patchProjectMetaUnlocked(projectId, patch, projects, env));
}

async function patchProjectMetaUnlocked(projectId, patch, projects = [], env = process.env) {
  const id = String(projectId);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }
  const meta = await loadTaskRandomMeta(env);
  const prev = meta.byProjectId[id] || {};
  const next = { ...prev };
  if (patch.location !== undefined) {
    const loc = patch.location == null || patch.location === '' ? null : normalizeLocation(patch.location);
    if (loc) next.location = loc;
    else delete next.location;
  }
  if (patch.notes !== undefined) {
    const notes = String(patch.notes || '').trim().slice(0, 200);
    if (notes) next.notes = notes;
    else delete next.notes;
  }
  if (Object.keys(next).length) meta.byProjectId[id] = next;
  else delete meta.byProjectId[id];
  if (projects.length) {
    const md = renderProjectLocationsMarkdown(projects, meta.byProjectId);
    await saveProjectLocationsMarkdown(md, env);
    return loadTaskRandomMeta(env);
  }
  await writeTaskRandomMeta(meta, env);
  return meta;
}
