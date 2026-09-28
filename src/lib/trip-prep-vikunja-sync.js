/**
 * Mirror "things to do before leaving" into a Vikunja project (Tasks category).
 * The logistics textarea is the source of truth on save; open tasks win on load.
 */

import {
  createPanelProject,
  createPanelTodo,
  listPanelProjects,
  listPanelTodos,
  resolveVikunjaConfig,
  setPanelTodoDone,
  updatePanelTodoText,
} from './vikunja-client.js';

/** @type {Map<string, Promise<unknown>>} */
const locks = new Map();

/**
 * @param {string} key
 * @param {() => Promise<unknown>} fn
 */
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const next = prev.then(() => gate);
  locks.set(key, next);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === next) locks.delete(key);
  }
}

/**
 * @param {unknown} title
 * @returns {string}
 */
export function tripPrepProjectTitle(title) {
  const t = String(title || 'Trip').replace(/\s+/g, ' ').trim().slice(0, 70) || 'Trip';
  return `Trip · ${t}`.slice(0, 120);
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseBeforeTripLines(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').replace(/^\[[ xX✓]\]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 80);
}

/**
 * @param {import('./events-finder-travel-logistics.js').TripPlanning} tp
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function hydrateTripPrepFromVikunja(tp, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  const projectId = tp?.vikunjaProjectId;
  if (!cfg.configured || !projectId) return tp;
  try {
    const todos = await listPanelTodos(env, { projectId });
    const open = (Array.isArray(todos) ? todos : []).filter((t) => t && !t.done && t.text);
    if (!open.length && String(tp.beforeTrip || '').trim()) return tp;
    const byId = new Map(open.map((t) => [String(t.id), t]));
    /** @type {typeof open} */
    const ordered = [];
    const seen = new Set();
    for (const row of Array.isArray(tp.beforeTripTasks) ? tp.beforeTripTasks : []) {
      const hit = byId.get(String(row.vikunjaTaskId || ''));
      if (!hit || seen.has(String(hit.id))) continue;
      ordered.push(hit);
      seen.add(String(hit.id));
    }
    for (const t of open) {
      if (seen.has(String(t.id))) continue;
      ordered.push(t);
    }
    return {
      ...tp,
      beforeTrip: ordered.map((t) => String(t.text).trim()).join('\n') || null,
      beforeTripTasks: ordered.map((t) => ({
        text: String(t.text).trim(),
        vikunjaTaskId: String(t.id),
      })),
    };
  } catch {
    return tp;
  }
}

/**
 * Create/update the trip project and sync one-line tasks.
 * Empty box does not delete the project.
 * @param {import('./events-finder-travel-logistics.js').TripPlanning} tp
 * @param {{ title?: string | null, start?: string | null, lockKey?: string }} [meta]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function syncTripPrepToVikunja(tp, meta = {}, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) return tp;

  const lines = parseBeforeTripLines(tp?.beforeTrip);
  if (!lines.length && !tp?.vikunjaProjectId) return tp;

  const lockKey = String(meta.lockKey || tp?.vikunjaProjectId || meta.title || 'trip-prep');
  return withLock(lockKey, async () => {
    let projectId = tp.vikunjaProjectId;
    if (projectId == null) {
      const want = tripPrepProjectTitle(meta.title);
      const projects = await listPanelProjects(env);
      const existing = projects.find(
        (p) => String(p.title || '').trim().toLowerCase() === want.toLowerCase(),
      );
      if (existing?.id) {
        projectId = Number(existing.id);
      } else {
        const created = await createPanelProject(want, env);
        projectId = Number(created.id);
      }
    }

    const prev = Array.isArray(tp.beforeTripTasks) ? tp.beforeTripTasks : [];
    /** @type {{ text: string, vikunjaTaskId: string }[]} */
    const next = [];
    const dueDate = String(meta.start || '').trim() || null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prior = prev[i];
      if (prior?.vikunjaTaskId && prior.text === line) {
        next.push(prior);
        continue;
      }
      if (prior?.vikunjaTaskId && prior.text !== line) {
        try {
          await updatePanelTodoText(prior.vikunjaTaskId, line, env);
          next.push({ text: line, vikunjaTaskId: prior.vikunjaTaskId });
          continue;
        } catch {
          /* create fresh */
        }
      }
      const created = await createPanelTodo(line, env, {
        projectId,
        dueDate,
        description: `trip-prep:${lockKey}`,
      });
      next.push({ text: line, vikunjaTaskId: String(created.id) });
    }

    for (const leftover of prev.slice(lines.length)) {
      if (!leftover?.vikunjaTaskId) continue;
      try {
        await setPanelTodoDone(leftover.vikunjaTaskId, true, env);
      } catch {
        /* ignore */
      }
    }

    return {
      ...tp,
      vikunjaProjectId: projectId,
      beforeTripTasks: next,
    };
  });
}
