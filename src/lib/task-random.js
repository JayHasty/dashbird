/**
 * Random task picker: user-chosen attribute filters + weighted pick.
 */
import {
  DIFFICULTY_LABELS,
  DURATION_LABELS,
  DURATION_TIER,
  LOCATION_LABELS,
  TIME_LABELS,
  normalizeDifficulty,
  normalizeDuration,
  normalizeLocation,
  normalizePriority,
  normalizeTime,
  PRIORITY_WEIGHT,
} from './task-random-enums.js';

export function effectiveTaskLocations(taskMeta, _projectMeta) {
  if (taskMeta?.locationAny) return [];
  if (taskMeta?.location) return [taskMeta.location];
  if (taskMeta?.locations?.length) return taskMeta.locations;
  // No project-default inheritance: a task only has a location if it sets one.
  return [];
}

export function effectiveTaskTimes(taskMeta) {
  if (taskMeta?.timeAny) return [];
  return taskMeta?.times?.length ? taskMeta.times : [];
}

function overlaps(have, allowed) {
  if (!have.length) return true;
  return have.some((x) => allowed.includes(x));
}

/**
 * @param {unknown} raw
 * @param {(value: unknown) => string | null} [normalizer]
 * @returns {string[]}
 */
export function normalizeFilterArray(raw, normalizer) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const value = normalizer ? normalizer(item) : String(item || '').trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} body
 */
export function parseRandomTaskFilters(body = {}) {
  const priorities = normalizeFilterArray(body.priorities, normalizePriority);
  const difficulties = normalizeFilterArray(body.difficulties, normalizeDifficulty);
  const durations = normalizeFilterArray(body.durations, normalizeDuration);
  const locations = normalizeFilterArray(body.locations, normalizeLocation);
  const times = normalizeFilterArray(body.times, normalizeTime);

  if (!difficulties.length && body.difficulty != null) {
    const one = normalizeDifficulty(body.difficulty);
    if (one) difficulties.push(one);
  }
  if (!durations.length && body.duration != null) {
    const one = normalizeDuration(body.duration);
    if (one) durations.push(one);
  }

  return {
    priorities,
    difficulties,
    durations,
    locations,
    times,
    excludeIds: Array.isArray(body.excludeIds) ? body.excludeIds.map(String) : [],
    excludeProjectIds: Array.isArray(body.excludeProjectIds)
      ? body.excludeProjectIds.map(String)
      : [],
  };
}

/**
 * Tasks with scheduledFor in the future are out of the random pool.
 * Overdue (scheduledFor <= now) and unscheduled tasks stay eligible.
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {number} [nowMs]
 */
export function isScheduledInFuture(taskMeta, nowMs = Date.now()) {
  const raw = taskMeta?.scheduledFor;
  if (typeof raw !== 'string' || !raw) return false;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > nowMs;
}

export function taskMatchesRandomFilters(taskMeta, projectMeta, filters) {
  // Always exclude future-scheduled tasks; overdue + unscheduled remain eligible.
  if (isScheduledInFuture(taskMeta)) return false;
  // Waiting-on tasks are blocked — keep them out of the random pool.
  if (taskMeta?.waitingOn === true) return false;
  if (filters.priorities?.length) {
    if (taskMeta?.priority && !filters.priorities.includes(taskMeta.priority)) return false;
  }
  if (filters.difficulties?.length) {
    if (taskMeta?.difficulty && !filters.difficulties.includes(taskMeta.difficulty)) return false;
  }
  if (filters.durations?.length) {
    if (taskMeta?.duration) {
      const taskTier = DURATION_TIER[taskMeta.duration];
      if (Number.isFinite(taskTier)) {
        const fitsBudget = filters.durations.some((d) => {
          const budgetTier = DURATION_TIER[d];
          return Number.isFinite(budgetTier) && taskTier <= budgetTier;
        });
        if (!fitsBudget) return false;
      }
    }
  }
  const locs = effectiveTaskLocations(taskMeta, projectMeta);
  if (filters.locations?.length && locs.length && !overlaps(locs, filters.locations)) return false;
  const times = effectiveTaskTimes(taskMeta);
  if (filters.times?.length && times.length && !overlaps(times, filters.times)) return false;
  return true;
}

export function missingTaskMetaFields(taskMeta, projectMeta) {
  const missing = [];
  if (!taskMeta?.priority) missing.push('priority');
  if (!taskMeta?.difficulty) missing.push('difficulty');
  if (!taskMeta?.duration) missing.push('duration');
  // locationAny counts as set (same as the card UI).
  if (!taskMeta?.locationAny && !effectiveTaskLocations(taskMeta, projectMeta).length) {
    missing.push('locations');
  }
  if (!taskMeta?.timeAny && !effectiveTaskTimes(taskMeta).length) missing.push('times');
  return missing;
}

/**
 * @param {Array<{ id: string }>} pool
 * @param {import('./task-random-meta-store.js').TaskRandomMeta['byTaskId']} byTaskId
 */
function pickWeightedTask(pool, byTaskId) {
  if (pool.length === 1) return pool[0];
  let total = 0;
  const weights = pool.map((t) => {
    const pri = byTaskId[String(t.id)]?.priority;
    const w = pri && PRIORITY_WEIGHT[pri] ? PRIORITY_WEIGHT[pri] : 1;
    total += w;
    return w;
  });
  let roll = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

export function pickRandomTask(tasks, meta, filters) {
  const exclude = new Set((filters.excludeIds || []).map((x) => String(x)));
  const excludeProjects = new Set((filters.excludeProjectIds || []).map((x) => String(x)));
  const pool = tasks.filter((t) => {
    if (exclude.has(String(t.id))) return false;
    if (t.projectId != null && excludeProjects.has(String(t.projectId))) return false;
    const taskMeta = meta.byTaskId[String(t.id)] || null;
    const projectMeta = t.projectId != null ? meta.byProjectId[String(t.projectId)] || null : null;
    return taskMatchesRandomFilters(taskMeta, projectMeta, filters);
  });
  if (!pool.length) return { task: null, poolSize: 0, totalOpen: tasks.length };

  // Prefer incomplete tags first so Random surfaces tasks that still need attributes.
  /** @type {typeof pool} */
  const incomplete = [];
  /** @type {typeof pool} */
  const complete = [];
  for (const t of pool) {
    const taskMeta = meta.byTaskId[String(t.id)] || null;
    const projectMeta = t.projectId != null ? meta.byProjectId[String(t.projectId)] || null : null;
    if (missingTaskMetaFields(taskMeta, projectMeta).length) incomplete.push(t);
    else complete.push(t);
  }
  const active = incomplete.length ? incomplete : complete;
  const task = pickWeightedTask(active, meta.byTaskId);
  const taskMeta = meta.byTaskId[String(task.id)] || null;
  const projectMeta = task.projectId != null ? meta.byProjectId[String(task.projectId)] || null : null;
  return {
    task,
    poolSize: pool.length,
    incompletePoolSize: incomplete.length,
    completePoolSize: complete.length,
    pickPhase: incomplete.length ? 'incomplete' : 'complete',
    totalOpen: tasks.length,
    meta: taskMeta,
    projectMeta,
    missingFields: missingTaskMetaFields(taskMeta, projectMeta),
    effectiveLocations: effectiveTaskLocations(taskMeta, projectMeta),
  };
}

export { DIFFICULTY_LABELS, DURATION_LABELS, LOCATION_LABELS, TIME_LABELS };
