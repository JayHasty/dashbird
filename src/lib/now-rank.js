/**
 * Rank nominated sittings. Reads goals and the signal log. Does not write either.
 */

const DAY = 86400000;
const WEEK = 7 * DAY;

/**
 * @param {unknown} due
 * @returns {number | null}
 */
function dueMs(due) {
  const s = String(due || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T12:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {Record<string, unknown>} goal
 * @param {Date} now
 */
export function floorInDanger(goal, now) {
  if (!goal || goal.kind !== 'floor') return false;
  if (goal.promise && goal.promiseDue) return true;
  const due = dueMs(goal.due);
  if (due == null) return false;
  const warn = Number.isFinite(Number(goal.warnDays)) ? Number(goal.warnDays) : 7;
  return now.getTime() >= due - warn * DAY;
}

/**
 * Days the countable signal has been getting worse, walking week by week.
 * @param {Record<string, unknown>} goal
 * @param {Array<{ goalId?: string, at?: string, value?: number }>} entries
 * @param {Date} now
 */
export function slipStreakDays(goal, entries, now) {
  if (!goal?.signal) return 0;
  const higherBetter = goal.signal.direction !== 'down';
  const mine = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.goalId === goal.id && Number.isFinite(Number(e.value)))
    .map((e) => ({ at: Date.parse(String(e.at || '')), value: Number(e.value) }))
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);
  if (mine.length < 2) return 0;
  const end = now.getTime();
  /** @type {{ start: number, value: number }[]} */
  const weeks = [];
  let cursor = end;
  const first = mine[0].at;
  while (cursor > first - WEEK && weeks.length < 52) {
    const start = cursor - WEEK;
    const inWeek = mine.filter((e) => e.at > start && e.at <= cursor);
    if (inWeek.length) {
      weeks.push({ start, value: inWeek.reduce((sum, e) => sum + e.value, 0) });
    }
    cursor = start;
  }
  if (weeks.length < 2) return 0;
  let streakStart = null;
  for (let i = 0; i < weeks.length - 1; i += 1) {
    const recent = weeks[i].value;
    const prior = weeks[i + 1].value;
    const worse = higherBetter ? recent < prior : recent > prior;
    if (!worse) break;
    streakStart = weeks[i + 1].start;
  }
  if (streakStart == null) return 0;
  return Math.max(1, Math.round((end - streakStart) / DAY));
}

/**
 * @param {Record<string, unknown>} goal
 * @param {Array<{ goalId?: string, at?: string, value?: number }>} entries
 * @param {Date} now
 * @returns {'slipping' | 'holding' | 'improving' | 'unknown'}
 */
export function signalTrend(goal, entries, now) {
  if (!goal?.signal) return 'unknown';
  if (slipStreakDays(goal, entries, now) > 0) return 'slipping';
  const end = now.getTime();
  const mine = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.goalId === goal.id && Number.isFinite(Number(e.value)))
    .map((e) => ({ at: Date.parse(String(e.at || '')), value: Number(e.value) }))
    .filter((e) => Number.isFinite(e.at));
  const sumBetween = (from, to) =>
    mine.filter((e) => e.at > from && e.at <= to).reduce((sum, e) => sum + e.value, 0);
  const recent = sumBetween(end - 14 * DAY, end);
  const prior = sumBetween(end - 28 * DAY, end - 14 * DAY);
  const recentN = mine.filter((e) => e.at > end - 14 * DAY && e.at <= end).length;
  const priorN = mine.filter((e) => e.at > end - 28 * DAY && e.at <= end - 14 * DAY).length;
  if (!recentN || !priorN) return 'unknown';
  const higherBetter = goal.signal.direction !== 'down';
  if (recent === prior) return 'holding';
  const better = higherBetter ? recent > prior : recent < prior;
  return better ? 'improving' : 'holding';
}

/**
 * @param {Record<string, unknown>} parent
 */
function needsYou(parent) {
  const c = parent?.commitment;
  if (!c || c.state === 'done' || parent.status === 'closed') return false;
  if (c.owner === 'agent') return false;
  if (c.owner === 'agent-then-you') return c.state === 'needs-review';
  return true;
}

/**
 * @param {Record<string, unknown>} parent
 */
function inLane(parent) {
  const c = parent?.commitment;
  if (!c || c.state === 'done' || parent.status === 'closed') return false;
  if (c.owner === 'agent') return true;
  if (c.owner === 'agent-then-you' && c.state !== 'needs-review') return true;
  return false;
}

/**
 * @param {{
 *   parents?: Record<string, unknown>[],
 *   goals?: Record<string, unknown>[],
 *   signals?: Array<{ goalId?: string, at?: string, value?: number }>,
 *   pin?: { commitmentId?: string } | null,
 *   now?: Date | string | number,
 * }} input
 */
export function rankNow(input) {
  const goals = Array.isArray(input?.goals) ? input.goals : [];
  const parents = Array.isArray(input?.parents) ? input.parents : [];
  const signals = Array.isArray(input?.signals) ? input.signals : [];
  const now = input?.now instanceof Date ? input.now : new Date(input?.now || Date.now());
  const pinId = String(input?.pin?.commitmentId || '');
  const goalById = new Map(goals.map((g) => [g.id, g]));

  const you = parents.filter(needsYou);
  const lane = parents.filter(inLane).map((p) => ({
    parentId: p.id,
    commitmentId: p.commitment.id,
    reason: 'Agent lane.',
  }));

  const rankable = you.filter((p) => {
    const goal = goalById.get(p.goalId);
    if (goal && goal.kind === 'aim' && !goal.signal) return false;
    return true;
  });

  /**
   * @param {Record<string, unknown>} parent
   * @returns {number | null}
   */
  function floorScore(parent) {
    const goal = goalById.get(parent.goalId);
    if (!goal || !floorInDanger(goal, now)) return null;
    if (goal.promise && goal.promiseDue && dueMs(goal.due) == null) return 0;
    const due = dueMs(goal.due);
    return due == null ? null : due;
  }

  const anyFloor = rankable.some((p) => floorScore(p) != null);

  /**
   * @param {Record<string, unknown>} parent
   */
  function aimScore(parent) {
    const goal = goalById.get(parent.goalId);
    if (!goal || goal.kind !== 'aim' || !goal.signal) return { weight: 0, slip: 0 };
    return {
      weight: Number(goal.weight) || 0,
      slip: slipStreakDays(goal, signals, now),
    };
  }

  const orderedParents = [...rankable].sort((a, b) => {
    if (anyFloor) {
      const fa = floorScore(a);
      const fb = floorScore(b);
      if ((fa == null) !== (fb == null)) return fa == null ? 1 : -1;
      if (fa != null && fb != null && fa !== fb) return fa - fb;
    }
    const aa = aimScore(a);
    const bb = aimScore(b);
    if (bb.weight !== aa.weight) return bb.weight - aa.weight;
    if (bb.slip !== aa.slip) return bb.slip - aa.slip;
    return 0;
  });

  let pinned = false;
  if (pinId) {
    const idx = orderedParents.findIndex((p) => p.commitment?.id === pinId);
    if (idx >= 0) {
      const [item] = orderedParents.splice(idx, 1);
      orderedParents.unshift(item);
      pinned = true;
    }
  }

  const activeIdx = orderedParents.findIndex((p) => p.commitment?.state === 'active');
  if (activeIdx > 0) {
    const [item] = orderedParents.splice(activeIdx, 1);
    orderedParents.unshift(item);
  }

  const ordered = orderedParents.map((p, index) => {
    const goal = goalById.get(p.goalId);
    let reason = 'Nominated sitting.';
    if (index === 0 && p.commitment?.state === 'active') reason = 'In progress.';
    else if (index === 0 && pinned && p.commitment?.id === pinId) reason = 'You moved this ahead of the ranking.';
    else if (goal && goal.kind === 'floor' && floorInDanger(goal, now)) {
      reason = goal.due ? `Floor due ${goal.due}.` : 'Floor is due.';
    } else if (goal && goal.kind === 'aim') {
      const slip = slipStreakDays(goal, signals, now);
      reason = slip > 0 ? `${goal.statement} is slipping.` : `Aim: ${goal.statement}`;
    }
    return { parentId: p.id, commitmentId: p.commitment.id, reason };
  });

  return {
    now: ordered[0] || null,
    queue: ordered.slice(1),
    lane,
    ordered,
  };
}
