/**
 * Server-side Vikunja REST client. Tokens stay in env; never sent to the browser.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  loadRecentArchivedTasks,
  recordRecentArchivedTask,
  removeRecentArchivedTask,
  RECENT_ARCHIVED_LIMIT,
} from './vikunja-recent-archive-store.js';
import { applyTaskListOrder, loadTaskListOrder, saveTaskListOrder } from './task-list-order-store.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TITLE_LEN = 280;

const ARCHIVE_PROJECT_TITLE = 'Archive';

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveVikunjaDbPath(env = process.env) {
  const raw = String(env.VIKUNJA_DB_PATH || 'data/vikunja/db/vikunja.db').trim();
  return join(process.cwd(), raw);
}

/**
 * @param {{ status: number, json?: { message?: string } | null, text?: string }} res
 */
function isDefaultProjectDeleteBlocked(res) {
  if (res.status !== 412) return false;
  const msg = String(res.json?.message || res.text || '').toLowerCase();
  return msg.includes('default project');
}

/**
 * Vikunja blocks deleting a user's default project (412). Re-point defaults locally, then retry delete.
 * @param {number} fromProjectId
 * @param {number} toProjectId
 * @param {NodeJS.ProcessEnv} [env]
 */
function reassignVikunjaDefaultProject(fromProjectId, toProjectId, env = process.env) {
  const dbPath = resolveVikunjaDbPath(env);
  if (!existsSync(dbPath)) {
    const err = new Error('vikunja_db_not_found');
    err.code = 'vikunja_db_not_found';
    err.status = 503;
    throw err;
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('UPDATE users SET default_project_id = ? WHERE default_project_id = ?').run(
      toProjectId,
      fromProjectId,
    );
  } finally {
    db.close();
  }
}

/**
 * @param {number} excludingId
 * @param {NodeJS.ProcessEnv} [env]
 */
async function pickDefaultProjectFallback(excludingId, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  const archiveId = await resolveArchiveProjectId(env);
  const projects = await listPanelProjects(env);
  const candidates = projects.filter((p) => p.id !== excludingId && p.id !== archiveId);
  if (
    cfg.projectId &&
    cfg.projectId !== excludingId &&
    cfg.projectId !== archiveId &&
    candidates.some((p) => p.id === cfg.projectId)
  ) {
    return cfg.projectId;
  }
  return candidates[0]?.id ?? null;
}

/** @type {number | null} */
let cachedArchiveProjectId = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ configured: boolean, baseUrl: string, token: string, projectId: number | null, archiveProjectId: number | null, timeoutMs: number }}
 */
export function resolveVikunjaConfig(env = process.env) {
  const baseRaw = String(env.VIKUNJA_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.VIKUNJA_TOKEN || '').trim();
  const projectRaw = String(env.VIKUNJA_PROJECT_ID || '').trim();
  const projectId = projectRaw && /^\d+$/.test(projectRaw) ? Number(projectRaw) : null;
  const archiveRaw = String(env.VIKUNJA_ARCHIVE_PROJECT_ID || '').trim();
  const archiveProjectId =
    archiveRaw && /^\d+$/.test(archiveRaw) ? Number(archiveRaw) : null;
  const timeoutRaw = Number(env.VIKUNJA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw >= 3000 && timeoutRaw <= 60_000
      ? Math.floor(timeoutRaw)
      : DEFAULT_TIMEOUT_MS;

  if (!baseRaw || !token) {
    return {
      configured: false,
      baseUrl: '',
      token: '',
      projectId,
      archiveProjectId,
      timeoutMs,
    };
  }

  let baseUrl = baseRaw;
  if (!/\/api\/v1$/i.test(baseUrl)) {
    baseUrl = `${baseUrl}/api/v1`;
  }

  return { configured: true, baseUrl, token, projectId, archiveProjectId, timeoutMs };
}

/**
 * @param {unknown} task
 * @returns {string[]}
 */
function vikunjaParentTaskIds(task) {
  if (!task || typeof task !== 'object') return [];
  const parents = task.related_tasks?.parenttask;
  if (!Array.isArray(parents)) return [];
  return parents
    .map((p) => (p && p.id != null ? String(p.id) : ''))
    .filter(Boolean);
}

/**
 * @param {unknown} task
 * @returns {boolean}
 */
export function vikunjaTaskIsSubtask(task) {
  return vikunjaParentTaskIds(task).length > 0;
}

/**
 * @param {unknown} task
 * @returns {{ id: string, text: string, done: boolean, projectId: number | null, isSubtask?: boolean, subtaskCount?: number } | null}
 */
export function mapVikunjaTask(task) {
  if (!task || typeof task !== 'object') return null;
  const id = task.id != null ? String(task.id) : '';
  const text = String(task.title || '').trim();
  if (!id || !text) return null;
  const projectId =
    task.project_id != null && Number.isFinite(Number(task.project_id))
      ? Number(task.project_id)
      : null;
  const subtasks = task.related_tasks?.subtask;
  const subtaskCount = Array.isArray(subtasks) ? subtasks.length : 0;
  const doneAt = String(task.done_at || task.updated || '').trim() || null;
  return {
    id,
    text,
    done: Boolean(task.done),
    projectId,
    position: Number.isFinite(Number(task.position)) ? Number(task.position) : 0,
    isSubtask: vikunjaTaskIsSubtask(task),
    subtaskCount,
    doneAt,
    description: String(task.description || ''),
  };
}

/**
 * List order: Vikunja `position` ascending, then newest id first (legacy default).
 * @param {{ id?: string, position?: number }} a
 * @param {{ id?: string, position?: number }} b
 */
export function comparePanelTodoOrder(a, b) {
  const pa = Number.isFinite(Number(a?.position)) ? Number(a.position) : 0;
  const pb = Number.isFinite(Number(b?.position)) ? Number(b.position) : 0;
  if (pa !== pb) return pa - pb;
  return Number(b?.id) - Number(a?.id);
}

/**
 * @param {string} title
 */
export function normalizeTodoTitle(title) {
  const t = String(title || '').trim();
  if (!t || t.length > MAX_TITLE_LEN) return null;
  return t;
}

/**
 * @param {string} pathAndQuery e.g. "/tasks?per_page=50" or "tasks"
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [opts]
 */
export async function vikunjaFetch(pathAndQuery, opts = {}) {
  const cfg = resolveVikunjaConfig(opts.env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }

  const rel = String(pathAndQuery || '').replace(/^\/+/, '');
  if (!rel || rel.includes('://') || rel.includes('..')) {
    const err = new Error('invalid_path');
    err.code = 'invalid_path';
    err.status = 400;
    throw err;
  }

  const url = `${cfg.baseUrl}/${rel}`;
  const method = String(opts.method || 'GET').toUpperCase();
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/json',
  };

  /** @type {RequestInit} */
  const init = {
    method,
    headers,
    signal: opts.signal ?? AbortSignal.timeout(cfg.timeoutMs),
  };

  if (opts.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let upstream;
  try {
    upstream = await fetch(url, init);
  } catch (e) {
    const err = new Error(String(e?.message || e || 'vikunja_unreachable'));
    err.code = 'vikunja_unreachable';
    err.status = 502;
    throw err;
  }

  const text = await upstream.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return {
    status: upstream.status,
    ok: upstream.ok,
    json,
    text,
    contentType: upstream.headers.get('content-type') || '',
  };
}

/**
 * Display title for Tasks panel: strip leading slashes, capitalize first letter.
 * @param {unknown} title
 * @param {number} [fallbackId]
 */
export function normalizeProjectDisplayTitle(title, fallbackId) {
  let t = String(title || '').trim().replace(/^\/+/, '').trim();
  if (!t) return fallbackId != null ? `Project ${fallbackId}` : 'Project';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (/[A-Za-z]/.test(ch)) {
      return t.slice(0, i) + ch.toUpperCase() + t.slice(i + 1);
    }
  }
  return t;
}

/**
 * @param {unknown} title
 * @returns {string | null}
 */
export function normalizeProjectTitle(title) {
  const t = normalizeProjectDisplayTitle(title);
  if (!t || t === 'Project' || t.length > 120) return null;
  return t;
}

/**
 * Top-level Vikunja projects for the Dashbird Tasks panel (excludes Archive).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{ id: number, title: string }>>}
 */
export async function listPanelProjects(env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }

  const res = await vikunjaFetch('projects?per_page=100', { env });
  if (!res.ok || !Array.isArray(res.json)) {
    const err = new Error(safeUpstreamMessage(res) || 'vikunja_projects_failed');
    err.code = 'vikunja_upstream';
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  return res.json
    .filter((p) => p && Number(p.id) > 0 && !p.parent_project_id)
    .filter((p) => !Boolean(p.is_archived))
    .filter(
      (p) =>
        String(p.title || '').trim().toLowerCase() !== ARCHIVE_PROJECT_TITLE.toLowerCase(),
    )
    .map((p) => ({
      id: Number(p.id),
      title: normalizeProjectDisplayTitle(p.title, Number(p.id)),
      position: Number.isFinite(Number(p.position)) ? Number(p.position) : Number(p.id),
    }))
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
}

/**
 * @param {string} title
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ id: number, title: string }>}
 */
export async function createPanelProject(title, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }
  const name = normalizeProjectTitle(title);
  if (!name) {
    const err = new Error('invalid_title');
    err.code = 'invalid_title';
    err.status = 400;
    throw err;
  }

  const res = await vikunjaFetch('projects', {
    method: 'PUT',
    body: { title: name, parent_project_id: 0 },
    env,
  });
  if (!res.ok || !res.json?.id) {
    const err = new Error(safeUpstreamMessage(res) || 'vikunja_project_create_failed');
    err.code = 'vikunja_upstream';
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }
  return {
    id: Number(res.json.id),
    title: normalizeProjectDisplayTitle(res.json.title, Number(res.json.id)),
    position: Number.isFinite(Number(res.json.position))
      ? Number(res.json.position)
      : Number(res.json.id),
  };
}

/**
 * Update project title and/or position.
 * @param {number} projectId
 * @param {{ title?: string, position?: number }} patch
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ id: number, title: string, position: number }>}
 */
export async function updatePanelProject(projectId, patch, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }
  if (!Number.isFinite(projectId) || projectId <= 0) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }

  const getRes = await vikunjaFetch(`projects/${projectId}`, { env });
  if (getRes.status === 404) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }
  if (!getRes.ok || !getRes.json || typeof getRes.json !== 'object') {
    const err = new Error(safeUpstreamMessage(getRes) || 'vikunja_project_get_failed');
    err.code = 'vikunja_upstream';
    err.status = getRes.status >= 400 && getRes.status < 600 ? getRes.status : 502;
    throw err;
  }

  /** @type {Record<string, unknown>} */
  const body = { ...getRes.json };
  if (patch.title != null) {
    const name = normalizeProjectTitle(patch.title);
    if (!name) {
      const err = new Error('invalid_title');
      err.code = 'invalid_title';
      err.status = 400;
      throw err;
    }
    body.title = name;
  }
  if (patch.position != null && Number.isFinite(Number(patch.position))) {
    body.position = Number(patch.position);
  }

  const postRes = await vikunjaFetch(`projects/${projectId}`, {
    method: 'POST',
    body,
    env,
  });
  if (!postRes.ok) {
    const err = new Error(safeUpstreamMessage(postRes) || 'vikunja_project_update_failed');
    err.code = 'vikunja_upstream';
    err.status = postRes.status >= 400 && postRes.status < 600 ? postRes.status : 502;
    throw err;
  }

  return {
    id: projectId,
    title: normalizeProjectDisplayTitle(postRes.json?.title ?? body.title, projectId),
    position: Number.isFinite(Number(postRes.json?.position ?? body.position))
      ? Number(postRes.json?.position ?? body.position)
      : projectId,
  };
}

/**
 * @param {number} projectId
 * @param {string} title
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ id: number, title: string, position: number }>}
 */
export async function renamePanelProject(projectId, title, env = process.env) {
  return updatePanelProject(projectId, { title }, env);
}

/**
 * Archive a project (hides it from the panel list). Uses the update (POST) scope,
 * so it works even when the API token lacks `projects.delete`.
 * @param {number} projectId
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function archivePanelProject(projectId, env = process.env) {
  const getRes = await vikunjaFetch(`projects/${projectId}`, { env });
  if (getRes.status === 404) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }
  if (!getRes.ok || !getRes.json || typeof getRes.json !== 'object') {
    const err = new Error(safeUpstreamMessage(getRes) || 'vikunja_project_get_failed');
    err.code = 'vikunja_upstream';
    err.status = getRes.status >= 400 && getRes.status < 600 ? getRes.status : 502;
    throw err;
  }
  const body = { ...getRes.json, is_archived: true };
  const postRes = await vikunjaFetch(`projects/${projectId}`, {
    method: 'POST',
    body,
    env,
  });
  if (!postRes.ok) {
    const err = new Error(safeUpstreamMessage(postRes) || 'vikunja_project_archive_failed');
    err.code = 'vikunja_upstream';
    err.status = postRes.status >= 400 && postRes.status < 600 ? postRes.status : 502;
    throw err;
  }
}

/**
 * Delete a panel project (and its tasks upstream).
 * @param {number} projectId
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function deletePanelProject(projectId, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }
  if (!Number.isFinite(projectId) || projectId <= 0) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }

  const archiveId = await resolveArchiveProjectId(env);
  if (projectId === archiveId) {
    const err = new Error('archive_project_protected');
    err.code = 'archive_project_protected';
    err.status = 403;
    throw err;
  }

  const res = await vikunjaFetch(`projects/${projectId}`, {
    method: 'DELETE',
    env,
  });
  if (res.status === 404) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }
  let finalRes = res;
  if (!finalRes.ok && finalRes.status !== 204 && isDefaultProjectDeleteBlocked(finalRes)) {
    const fallbackId = await pickDefaultProjectFallback(projectId, env);
    if (fallbackId == null) {
      const err = new Error('default_project_protected');
      err.code = 'default_project_protected';
      err.status = 409;
      throw err;
    }
    reassignVikunjaDefaultProject(projectId, fallbackId, env);
    finalRes = await vikunjaFetch(`projects/${projectId}`, {
      method: 'DELETE',
      env,
    });
  }
  if (!finalRes.ok && finalRes.status !== 204) {
    // The API token can create/update projects but not delete them (Vikunja
    // returns 401/403 for a missing `projects.delete` scope). Fall back to
    // archiving so the project still leaves the panel list.
    if (finalRes.status === 401 || finalRes.status === 403) {
      await archivePanelProject(projectId, env);
      return;
    }
    const err = new Error(safeUpstreamMessage(finalRes) || 'vikunja_project_delete_failed');
    err.code = 'vikunja_upstream';
    err.status = finalRes.status >= 400 && finalRes.status < 600 ? finalRes.status : 502;
    throw err;
  }
}

/**
 * Persist a custom project order via Vikunja `position` (parallel writes).
 * @param {unknown} idsRaw
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{ id: number, title: string, position: number }>>}
 */
export async function reorderPanelProjects(idsRaw, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }

  const ids = Array.isArray(idsRaw)
    ? idsRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (!ids.length) {
    const err = new Error('invalid_order');
    err.code = 'invalid_order';
    err.status = 400;
    throw err;
  }

  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) {
    const err = new Error('invalid_order');
    err.code = 'invalid_order';
    err.status = 400;
    throw err;
  }

  await Promise.all(
    ids.map((projectId, i) => updatePanelProject(projectId, { position: (i + 1) * 65536 }, env)),
  );

  return listPanelProjects(env);
}

/**
 * Persist a custom task order for a project (Dashbird JSON; Vikunja view positions
 * are unavailable with the panel API token).
 * @param {unknown} idsRaw
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ projectId?: number | null }} [opts]
 * @returns {Promise<Array<{ id: string, position: number }>>}
 */
export async function reorderPanelTodos(idsRaw, env = process.env, opts = {}) {
  const ids = await saveTaskListOrder(opts.projectId, idsRaw, env);
  return ids.map((id, i) => ({ id, position: (i + 1) * 65536 }));
}

/**
 * Move a task to another project (keeps open/done state).
 * @param {string} id
 * @param {number} projectId
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function movePanelTodo(id, projectId, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }
  const taskId = String(id || '').trim();
  if (!/^\d+$/.test(taskId)) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(projectId) || projectId <= 0) {
    const err = new Error('invalid_project');
    err.code = 'invalid_project';
    err.status = 400;
    throw err;
  }

  const getRes = await vikunjaFetch(`tasks/${taskId}`, { env });
  if (getRes.status === 404) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }
  if (!getRes.ok || !getRes.json || typeof getRes.json !== 'object') {
    const err = new Error(safeUpstreamMessage(getRes) || 'vikunja_get_failed');
    err.code = 'vikunja_upstream';
    err.status = getRes.status >= 400 && getRes.status < 600 ? getRes.status : 502;
    throw err;
  }

  const body = { ...getRes.json, project_id: projectId };
  const postRes = await vikunjaFetch(`tasks/${taskId}`, {
    method: 'POST',
    body,
    env,
  });
  if (!postRes.ok) {
    const err = new Error(safeUpstreamMessage(postRes) || 'vikunja_move_failed');
    err.code = 'vikunja_upstream';
    err.status = postRes.status >= 400 && postRes.status < 600 ? postRes.status : 502;
    throw err;
  }

  return mapVikunjaTask(postRes.json) || {
    id: taskId,
    text: String(getRes.json.title || '').trim(),
    done: Boolean(getRes.json.done),
    projectId,
  };
}

/** Vikunja page size for open-task listing. */
const PANEL_TODOS_PER_PAGE = 100;
/** Safety stop so a runaway project cannot loop forever (100 × 100 = 10k tasks). */
const PANEL_TODOS_MAX_PAGES = 100;
/** Default ceiling for cross-project random-picker pool (was 500 and hid later projects). */
const ALL_PANEL_TODOS_DEFAULT_CAP = 10_000;

/**
 * Open tasks for a project. Subtasks are nested under `subtasks` on the parent
 * and omitted from the top-level list.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ projectId?: number | null }} [opts]
 * @returns {Promise<Array<{ id: string, text: string, done: boolean, projectId: number | null, subtasks: Array<{ id: string, text: string, done: boolean, projectId: number | null }> }>>}
 */
export async function listPanelTodos(env = process.env, opts = {}) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }
  const projectId =
    opts.projectId != null && Number.isFinite(Number(opts.projectId))
      ? Number(opts.projectId)
      : cfg.projectId;
  if (projectId == null) {
    const err = new Error('vikunja_project_required');
    err.code = 'vikunja_project_required';
    err.status = 503;
    throw err;
  }

  /** @type {Array<{ id: string, text: string, done: boolean, projectId: number | null, subtasks?: Array<{ id: string, text: string, done: boolean, projectId: number | null }> }>} */
  const all = [];
  /** @type {Map<string, Array<{ id: string, text: string, done: boolean, projectId: number | null }>>} */
  const subtasksByParent = new Map();

  /**
   * @param {string} parentId
   * @param {{ id: string, text: string, done: boolean, projectId: number | null } | null} sub
   */
  const addNestedSubtask = (parentId, sub) => {
    if (!parentId || !sub || sub.done) return;
    if (!subtasksByParent.has(parentId)) subtasksByParent.set(parentId, []);
    const list = subtasksByParent.get(parentId);
    if (list.some((s) => s.id === sub.id)) return;
    list.push({
      id: sub.id,
      text: sub.text,
      done: sub.done,
      projectId: sub.projectId,
      description: sub.description || '',
    });
  };

  for (let page = 1; page <= PANEL_TODOS_MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      per_page: String(PANEL_TODOS_PER_PAGE),
      page: String(page),
      sort_by: 'id',
      order_by: 'desc',
      filter: `done = false && project_id = ${projectId}`,
      expand: 'subtasks',
    });

    const res = await vikunjaFetch(`tasks?${qs}`, { env });
    if (!res.ok) {
      const err = new Error(safeUpstreamMessage(res) || 'vikunja_list_failed');
      err.code = 'vikunja_upstream';
      err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
      throw err;
    }

    const rows = Array.isArray(res.json) ? res.json : [];
    for (const row of rows) {
      const mapped = mapVikunjaTask(row);
      if (!mapped) continue;
      if (vikunjaTaskIsSubtask(row)) {
        for (const pid of vikunjaParentTaskIds(row)) addNestedSubtask(pid, mapped);
      }
      const nested = row.related_tasks?.subtask;
      if (Array.isArray(nested)) {
        const parentId = row.id != null ? String(row.id) : '';
        for (const child of nested) addNestedSubtask(parentId, mapVikunjaTask(child));
      }
    }
    // Hide open subtasks from the top-level project list; they live under the parent.
    const mapped = rows
      .filter((row) => !vikunjaTaskIsSubtask(row))
      .map(mapVikunjaTask)
      .filter(Boolean);
    all.push(...mapped);
    if (rows.length < PANEL_TODOS_PER_PAGE) break;
  }

  const nested = all.map((item) => ({
    ...item,
    subtasks: subtasksByParent.get(item.id) || [],
  }));
  const orderedIds = await loadTaskListOrder(projectId, env);
  return applyTaskListOrder(nested, orderedIds);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Map<number, string>>}
 */
async function projectTitleById(env = process.env) {
  const res = await vikunjaFetch('projects?per_page=100', { env });
  /** @type {Map<number, string>} */
  const map = new Map();
  if (!res.ok || !Array.isArray(res.json)) return map;
  for (const p of res.json) {
    if (!p || Number(p.id) <= 0) continue;
    map.set(Number(p.id), normalizeProjectDisplayTitle(p.title, Number(p.id)));
  }
  return map;
}

/**
 * Last 20 completed tasks (done in place or moved to Archive), newest first.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ id: string, text: string, projectId: number | null, currentProjectId: number | null, projectTitle: string, archivedAt: string | null, movedToArchive: boolean }>>}
 */
export async function listRecentArchivedTodos(env = process.env, opts = {}) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }
  const limit = Math.min(
    RECENT_ARCHIVED_LIMIT,
    Math.max(1, Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : RECENT_ARCHIVED_LIMIT),
  );

  const qs = new URLSearchParams({
    per_page: String(Math.min(50, limit * 2)),
    page: '1',
    sort_by: 'updated',
    order_by: 'desc',
    filter: 'done = true',
  });
  const [res, stored, titles, archiveId] = await Promise.all([
    vikunjaFetch(`tasks?${qs}`, { env }),
    loadRecentArchivedTasks(env).catch(() => []),
    projectTitleById(env),
    resolveArchiveProjectId(env).catch(() => null),
  ]);
  if (!res.ok) {
    const err = new Error(safeUpstreamMessage(res) || 'vikunja_list_failed');
    err.code = 'vikunja_upstream';
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const storedById = new Map((stored || []).map((it) => [it.id, it]));
  const rows = Array.isArray(res.json) ? res.json : [];
  /** @type {Array<{ id: string, text: string, projectId: number | null, currentProjectId: number | null, projectTitle: string, archivedAt: string | null, movedToArchive: boolean }>} */
  const out = [];
  for (const row of rows) {
    if (vikunjaTaskIsSubtask(row)) continue;
    const mapped = mapVikunjaTask(row);
    if (!mapped) continue;
    const remembered = storedById.get(mapped.id);
    const currentProjectId = mapped.projectId;
    const inArchive = archiveId != null && currentProjectId === archiveId;
    const restoreId =
      remembered?.projectId != null
        ? remembered.projectId
        : inArchive
          ? cfg.projectId
          : currentProjectId;
    const titleId = restoreId ?? currentProjectId;
    out.push({
      id: mapped.id,
      text: mapped.text,
      projectId: restoreId ?? null,
      currentProjectId,
      projectTitle: titleId != null ? titles.get(titleId) || 'Project' : 'Project',
      archivedAt: remembered?.archivedAt || mapped.doneAt || null,
      movedToArchive: Boolean(remembered?.movedToArchive || inArchive),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Open tasks across all panel projects (for random task picker).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ id: string, text: string, done: boolean, projectId: number | null, projectTitle: string }>>}
 */
export async function listAllPanelTodos(env = process.env, opts = {}) {
  const cap = Number.isFinite(Number(opts.limit))
    ? Math.max(1, Number(opts.limit))
    : ALL_PANEL_TODOS_DEFAULT_CAP;
  const projects = await listPanelProjects(env);
  /** @type {Array<{ id: string, text: string, done: boolean, projectId: number | null, projectTitle: string }>} */
  const all = [];
  for (const proj of projects) {
    if (all.length >= cap) break;
    const items = await listPanelTodos(env, { projectId: proj.id });
    for (const item of items) {
      if (all.length >= cap) break;
      all.push({
        id: item.id,
        text: item.text,
        done: item.done,
        projectId: proj.id,
        projectTitle: proj.title,
      });
    }
  }
  return all;
}

/**
 * Normalize optional due date for Vikunja (`due_date` RFC3339).
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeTodoDueDate(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * @param {string} title
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ dueDate?: string | null, projectId?: number | null, description?: string | null }} [opts]
 */
export async function createPanelTodo(title, env = process.env, opts = {}) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) {
    const err = new Error('vikunja_not_configured');
    err.code = 'vikunja_not_configured';
    err.status = 503;
    throw err;
  }
  const projectId =
    opts.projectId != null && Number.isFinite(Number(opts.projectId))
      ? Number(opts.projectId)
      : cfg.projectId;
  if (projectId == null) {
    const err = new Error('vikunja_project_required');
    err.code = 'vikunja_project_required';
    err.status = 503;
    throw err;
  }

  const text = normalizeTodoTitle(title);
  if (!text) {
    const err = new Error('invalid_text');
    err.code = 'invalid_text';
    err.status = 400;
    throw err;
  }

  /** @type {{ title: string, due_date?: string, description?: string }} */
  const body = { title: text };
  const dueDate = normalizeTodoDueDate(opts?.dueDate);
  if (dueDate) body.due_date = dueDate;
  const description = String(opts?.description || '').trim();
  if (description) body.description = description.slice(0, 2000);

  const res = await vikunjaFetch(`projects/${projectId}/tasks`, {
    method: 'PUT',
    body,
    env,
  });
  if (!res.ok) {
    const err = new Error(safeUpstreamMessage(res) || 'vikunja_create_failed');
    err.code = 'vikunja_upstream';
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const item = mapVikunjaTask(res.json);
  if (!item) {
    const err = new Error('vikunja_create_failed');
    err.code = 'vikunja_upstream';
    err.status = 502;
    throw err;
  }
  return item;
}

/**
 * Find or create the Archive project used when completing todos.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
export async function resolveArchiveProjectId(env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (cfg.archiveProjectId != null) return cfg.archiveProjectId;
  if (cachedArchiveProjectId != null) return cachedArchiveProjectId;

  const listRes = await vikunjaFetch('projects?per_page=50', { env });
  if (!listRes.ok || !Array.isArray(listRes.json)) {
    const err = new Error(safeUpstreamMessage(listRes) || 'vikunja_projects_failed');
    err.code = 'vikunja_upstream';
    err.status = listRes.status >= 400 && listRes.status < 600 ? listRes.status : 502;
    throw err;
  }

  const existing = listRes.json.find(
    (p) =>
      p &&
      Number(p.id) > 0 &&
      String(p.title || '').trim().toLowerCase() === ARCHIVE_PROJECT_TITLE.toLowerCase(),
  );
  if (existing?.id != null) {
    cachedArchiveProjectId = Number(existing.id);
    return cachedArchiveProjectId;
  }

  const createRes = await vikunjaFetch('projects', {
    method: 'PUT',
    body: {
      title: ARCHIVE_PROJECT_TITLE,
      description: 'Completed tasks from Dashbird Today’s To Do.',
    },
    env,
  });
  if (!createRes.ok || !createRes.json?.id) {
    const err = new Error(safeUpstreamMessage(createRes) || 'vikunja_archive_create_failed');
    err.code = 'vikunja_upstream';
    err.status = createRes.status >= 400 && createRes.status < 600 ? createRes.status : 502;
    throw err;
  }

  cachedArchiveProjectId = Number(createRes.json.id);
  return cachedArchiveProjectId;
}

/**
 * Mark done or undo.
 * Today’s To Do archives on complete; the Tasks panel marks done in place.
 * @param {string} id
 * @param {boolean} done
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ moveToArchive?: boolean, restoreProjectId?: number | null, skipContactApply?: boolean }} [opts]
 */
export async function setPanelTodoDone(id, done, env = process.env, opts = {}) {
  const cfg = resolveVikunjaConfig(env);
  const taskId = String(id || '').trim();
  if (!/^\d+$/.test(taskId)) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }

  const getRes = await vikunjaFetch(`tasks/${taskId}`, { env });
  if (getRes.status === 404) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }
  if (!getRes.ok || !getRes.json || typeof getRes.json !== 'object') {
    const err = new Error(safeUpstreamMessage(getRes) || 'vikunja_get_failed');
    err.code = 'vikunja_upstream';
    err.status = getRes.status >= 400 && getRes.status < 600 ? getRes.status : 502;
    throw err;
  }

  const markDone = Boolean(done);
  const moveToArchive = opts.moveToArchive !== false;
  const originalProjectId =
    getRes.json.project_id != null && Number.isFinite(Number(getRes.json.project_id))
      ? Number(getRes.json.project_id)
      : null;
  /** @type {Record<string, unknown>} */
  const body = {
    ...getRes.json,
    done: markDone,
    percent_done: markDone ? 1 : 0,
  };

  if (markDone && moveToArchive) {
    body.project_id = await resolveArchiveProjectId(env);
  } else if (!markDone) {
    const archiveId = await resolveArchiveProjectId(env).catch(() => null);
    let restoreId =
      opts.restoreProjectId != null && Number.isFinite(Number(opts.restoreProjectId))
        ? Number(opts.restoreProjectId)
        : null;
    if (restoreId == null) {
      const remembered = await loadRecentArchivedTasks(env)
        .then((items) => items.find((it) => it.id === taskId))
        .catch(() => null);
      if (remembered?.projectId != null) restoreId = remembered.projectId;
      else if (archiveId != null && originalProjectId === archiveId) restoreId = cfg.projectId;
      else restoreId = originalProjectId;
    }
    if (restoreId != null) body.project_id = restoreId;
  }

  const postRes = await vikunjaFetch(`tasks/${taskId}`, {
    method: 'POST',
    body,
    env,
  });
  if (!postRes.ok) {
    const err = new Error(safeUpstreamMessage(postRes) || 'vikunja_update_failed');
    err.code = 'vikunja_upstream';
    err.status = postRes.status >= 400 && postRes.status < 600 ? postRes.status : 502;
    throw err;
  }

  const item = mapVikunjaTask(postRes.json) || {
    id: taskId,
    text: String(getRes.json.title || '').trim(),
    done: markDone,
    projectId:
      body.project_id != null
        ? Number(body.project_id)
        : getRes.json.project_id != null
          ? Number(getRes.json.project_id)
          : null,
  };

  try {
    if (markDone) {
      await recordRecentArchivedTask({
        id: taskId,
        text: item.text,
        projectId: originalProjectId,
        archivedAt: new Date().toISOString(),
        movedToArchive,
      }, env);
    } else {
      await removeRecentArchivedTask(taskId, env);
    }
  } catch {
    /* recent-archive ledger is best-effort */
  }

  if (!opts.skipContactApply) {
    try {
      const { applyVikunjaDoneToContact } = await import('./contact-tasks-vikunja-sync.js');
      const contactTask = await applyVikunjaDoneToContact(
        {
          vikunjaId: taskId,
          done: markDone,
          description: getRes.json.description,
          title: item.text,
        },
        env,
      );
      if (contactTask) item.contactTask = contactTask;
    } catch {
      /* contact-card mirror is best-effort */
    }
  }

  return item;
}

/**
 * @param {string} id
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function updatePanelTodoText(id, text, env = process.env) {
  const taskId = String(id || '').trim();
  if (!/^\d+$/.test(taskId)) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }

  const normalized = normalizeTodoTitle(text);
  if (!normalized) {
    const err = new Error('invalid_text');
    err.code = 'invalid_text';
    err.status = 400;
    throw err;
  }

  const getRes = await vikunjaFetch(`tasks/${taskId}`, { env });
  if (getRes.status === 404) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }
  if (!getRes.ok || !getRes.json || typeof getRes.json !== 'object') {
    const err = new Error(safeUpstreamMessage(getRes) || 'vikunja_get_failed');
    err.code = 'vikunja_upstream';
    err.status = getRes.status >= 400 && getRes.status < 600 ? getRes.status : 502;
    throw err;
  }

  const postRes = await vikunjaFetch(`tasks/${taskId}`, {
    method: 'POST',
    body: {
      ...getRes.json,
      title: normalized,
    },
    env,
  });
  if (!postRes.ok) {
    const err = new Error(safeUpstreamMessage(postRes) || 'vikunja_update_failed');
    err.code = 'vikunja_upstream';
    err.status = postRes.status >= 400 && postRes.status < 600 ? postRes.status : 502;
    throw err;
  }

  const item = mapVikunjaTask(postRes.json);
  if (!item) {
    const err = new Error('vikunja_update_failed');
    err.code = 'vikunja_upstream';
    err.status = 502;
    throw err;
  }
  return item;
}

/**
 * Patch title and/or description without changing done state.
 * @param {string} id
 * @param {{ title?: string, description?: string }} fields
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function updatePanelTodoMeta(id, fields, env = process.env) {
  const taskId = String(id || '').trim();
  if (!/^\d+$/.test(taskId)) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }

  const getRes = await vikunjaFetch(`tasks/${taskId}`, { env });
  if (getRes.status === 404) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }
  if (!getRes.ok || !getRes.json || typeof getRes.json !== 'object') {
    const err = new Error(safeUpstreamMessage(getRes) || 'vikunja_get_failed');
    err.code = 'vikunja_upstream';
    err.status = getRes.status >= 400 && getRes.status < 600 ? getRes.status : 502;
    throw err;
  }

  /** @type {Record<string, unknown>} */
  const body = { ...getRes.json };
  if (fields?.title != null) {
    const normalized = normalizeTodoTitle(fields.title);
    if (!normalized) {
      const err = new Error('invalid_text');
      err.code = 'invalid_text';
      err.status = 400;
      throw err;
    }
    body.title = normalized;
  }
  if (fields?.description != null) {
    body.description = String(fields.description).slice(0, 2000);
  }

  const postRes = await vikunjaFetch(`tasks/${taskId}`, {
    method: 'POST',
    body,
    env,
  });
  if (!postRes.ok) {
    const err = new Error(safeUpstreamMessage(postRes) || 'vikunja_update_failed');
    err.code = 'vikunja_upstream';
    err.status = postRes.status >= 400 && postRes.status < 600 ? postRes.status : 502;
    throw err;
  }

  const item = mapVikunjaTask(postRes.json);
  if (!item) {
    const err = new Error('vikunja_update_failed');
    err.code = 'vikunja_upstream';
    err.status = 502;
    throw err;
  }
  return item;
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
async function fetchVikunjaTaskRaw(id, env = process.env) {
  const taskId = String(id || '').trim();
  if (!/^\d+$/.test(taskId)) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }
  const getRes = await vikunjaFetch(`tasks/${taskId}`, { env });
  if (getRes.status === 404) {
    const err = new Error('not_found');
    err.code = 'not_found';
    err.status = 404;
    throw err;
  }
  if (!getRes.ok || !getRes.json || typeof getRes.json !== 'object') {
    const err = new Error(safeUpstreamMessage(getRes) || 'vikunja_get_failed');
    err.code = 'vikunja_upstream';
    err.status = getRes.status >= 400 && getRes.status < 600 ? getRes.status : 502;
    throw err;
  }
  return { taskId, raw: getRes.json };
}

/**
 * List Vikunja subtasks linked to a parent (includes done).
 * @param {string} parentId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{ id: string, text: string, done: boolean, projectId: number | null }>>}
 */
export async function listPanelSubtasks(parentId, env = process.env) {
  const { raw } = await fetchVikunjaTaskRaw(parentId, env);
  const rows = Array.isArray(raw?.related_tasks?.subtask) ? raw.related_tasks.subtask : [];
  return rows.map(mapVikunjaTask).filter(Boolean);
}

/**
 * Scoped API tokens need `tasks_relations` for subtask links. Older Dashbird tokens
 * only had `tasks` — grant create/delete locally when missing (same DB path as default-project fix).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} true if permissions were changed
 */
function ensureVikunjaApiTokenRelationPermissions(env = process.env) {
  const dbPath = resolveVikunjaDbPath(env);
  if (!existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare('SELECT id, permissions FROM api_tokens').all();
    let changed = false;
    const update = db.prepare('UPDATE api_tokens SET permissions = ? WHERE id = ?');
    for (const row of rows) {
      let perms;
      try {
        perms = JSON.parse(String(row.permissions || '{}'));
      } catch {
        continue;
      }
      if (!perms || typeof perms !== 'object') continue;
      const existing = Array.isArray(perms.tasks_relations) ? perms.tasks_relations : [];
      const needCreate = !existing.includes('create');
      const needDelete = !existing.includes('delete');
      if (!needCreate && !needDelete) continue;
      const next = new Set(existing);
      next.add('create');
      next.add('delete');
      perms.tasks_relations = [...next];
      update.run(JSON.stringify(perms), row.id);
      changed = true;
    }
    return changed;
  } finally {
    db.close();
  }
}

/**
 * @param {string} parentTaskId
 * @param {number} childId
 * @param {NodeJS.ProcessEnv} [env]
 */
async function linkPanelSubtaskRelation(parentTaskId, childId, env = process.env) {
  const body = {
    other_task_id: childId,
    relation_kind: 'subtask',
  };
  let relRes = await vikunjaFetch(`tasks/${parentTaskId}/relations`, {
    method: 'PUT',
    body,
    env,
  });
  if (relRes.status === 401 && ensureVikunjaApiTokenRelationPermissions(env)) {
    relRes = await vikunjaFetch(`tasks/${parentTaskId}/relations`, {
      method: 'PUT',
      body,
      env,
    });
  }
  return relRes;
}

/**
 * Link an existing task as a Vikunja subtask of `parentId`.
 * @param {string} parentId
 * @param {string|number} childId
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function linkPanelSubtask(parentId, childId, env = process.env) {
  const parentTaskId = String(parentId || '').trim();
  const child = Number(childId);
  if (!/^\d+$/.test(parentTaskId) || !Number.isFinite(child) || child <= 0) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }
  const relRes = await linkPanelSubtaskRelation(parentTaskId, child, env);
  if (relRes.ok) return;
  const msg = String(relRes.json?.message || relRes.text || '').toLowerCase();
  if (relRes.status === 400 && (msg.includes('already') || msg.includes('exist'))) return;
  const err = new Error(safeUpstreamMessage(relRes) || 'vikunja_relation_failed');
  err.code = 'vikunja_upstream';
  err.status = relRes.status >= 400 && relRes.status < 600 ? relRes.status : 502;
  throw err;
}

/**
 * Create a task in the parent's project and link it as a Vikunja subtask.
 * @param {string} parentId
 * @param {string} title
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ description?: string }} [opts]
 */
export async function createPanelSubtask(parentId, title, env = process.env, opts = {}) {
  const { taskId: parentTaskId, raw: parent } = await fetchVikunjaTaskRaw(parentId, env);
  const projectId =
    parent.project_id != null && Number.isFinite(Number(parent.project_id))
      ? Number(parent.project_id)
      : null;
  if (projectId == null) {
    const err = new Error('vikunja_project_required');
    err.code = 'vikunja_project_required';
    err.status = 503;
    throw err;
  }

  const item = await createPanelTodo(title, env, {
    projectId,
    description: opts?.description,
  });
  const childId = Number(item.id);
  if (!Number.isFinite(childId) || childId <= 0) {
    const err = new Error('vikunja_create_failed');
    err.code = 'vikunja_upstream';
    err.status = 502;
    throw err;
  }

  const relRes = await linkPanelSubtaskRelation(parentTaskId, childId, env);
  if (!relRes.ok) {
    // Avoid orphan open tasks if the relation link fails.
    try {
      await vikunjaFetch(`tasks/${childId}`, { method: 'DELETE', env });
    } catch {
      /* best-effort cleanup */
    }
    const err = new Error(safeUpstreamMessage(relRes) || 'vikunja_relation_failed');
    err.code = 'vikunja_upstream';
    err.status = relRes.status >= 400 && relRes.status < 600 ? relRes.status : 502;
    throw err;
  }

  return item;
}

/**
 * @param {{ status: number, json?: any, text?: string }} res
 */
function safeUpstreamMessage(res) {
  const msg =
    (res.json && (res.json.message || res.json.error || res.json.detail)) ||
    '';
  const s = String(msg || '').trim();
  if (!s) return '';
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}
