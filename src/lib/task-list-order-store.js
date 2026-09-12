/**
 * Custom open-task order per Vikunja project (Dashbird-owned).
 * Vikunja list fetches return position 0 unless requested through a view, and
 * the panel API token cannot call POST /tasks/:id/position.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export function taskListOrderPath(env = process.env) {
  const override = String(env.TASK_LIST_ORDER_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/task-list-order.json');
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string[]>}
 */
function normalizeByProjectId(raw) {
  if (!raw || typeof raw !== 'object') return {};
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!/^\d+$/.test(key)) continue;
    if (!Array.isArray(val)) continue;
    const ids = [...new Set(val.map((id) => String(id || '').trim()).filter((id) => /^\d+$/.test(id)))];
    if (ids.length) out[key] = ids;
  }
  return out;
}

let orderLock = Promise.resolve();

function withOrderLock(fn) {
  const run = orderLock.then(fn, fn);
  orderLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Record<string, string[]>>}
 */
export async function loadTaskListOrderMap(env = process.env) {
  try {
    const raw = JSON.parse(await fs.readFile(taskListOrderPath(env), 'utf8'));
    return normalizeByProjectId(raw?.byProjectId ?? raw);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return {};
    throw e;
  }
}

/**
 * @param {number} projectId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string[]>}
 */
export async function loadTaskListOrder(projectId, env = process.env) {
  const id = Number(projectId);
  if (!Number.isFinite(id) || id <= 0) return [];
  const map = await loadTaskListOrderMap(env);
  return map[String(id)] || [];
}

function compareOpenTodoOrder(a, b) {
  const pa = Number.isFinite(Number(a?.position)) ? Number(a.position) : 0;
  const pb = Number.isFinite(Number(b?.position)) ? Number(b.position) : 0;
  if (pa !== pb) return pa - pb;
  return Number(b?.id) - Number(a?.id);
}

/**
 * Saved ids first in that order; tasks not in the saved list stay newest-first on top.
 * @template {{ id?: string, position?: number }} T
 * @param {T[]} items
 * @param {unknown} orderedIds
 * @returns {T[]}
 */
export function applyTaskListOrder(items, orderedIds) {
  if (!Array.isArray(items) || !items.length) return Array.isArray(items) ? items : [];
  const ids = Array.isArray(orderedIds)
    ? [...new Set(orderedIds.map((id) => String(id || '').trim()).filter((id) => /^\d+$/.test(id)))]
    : [];
  if (!ids.length) return [...items].sort(compareOpenTodoOrder);

  const byId = new Map(items.map((it) => [String(it.id), it]));
  const used = new Set();
  /** @type {T[]} */
  const ordered = [];
  for (const id of ids) {
    const it = byId.get(id);
    if (!it) continue;
    ordered.push(it);
    used.add(id);
  }
  const unknown = items.filter((it) => !used.has(String(it.id))).sort(compareOpenTodoOrder);
  return [...unknown, ...ordered];
}

/**
 * @param {number} projectId
 * @param {unknown} idsRaw
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string[]>}
 */
export async function saveTaskListOrder(projectId, idsRaw, env = process.env) {
  const pid = Number(projectId);
  if (!Number.isFinite(pid) || pid <= 0) {
    const err = new Error('invalid_project');
    err.code = 'invalid_project';
    err.status = 400;
    throw err;
  }
  const ids = [...new Set((Array.isArray(idsRaw) ? idsRaw : []).map((id) => String(id || '').trim()))].filter(
    (id) => /^\d+$/.test(id),
  );
  if (!ids.length) {
    const err = new Error('invalid_order');
    err.code = 'invalid_order';
    err.status = 400;
    throw err;
  }

  return withOrderLock(async () => {
    const map = await loadTaskListOrderMap(env);
    map[String(pid)] = ids;
    const live = taskListOrderPath(env);
    await fs.mkdir(path.dirname(live), { recursive: true });
    const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ byProjectId: map }, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, live);
    return ids;
  });
}
