/**
 * Pure shapes for the Now tab: parents, goals, holes, and field fills.
 * Ranking and signal logging must not call the goal writer. Fills never change a goal statement.
 */
import { randomUUID } from 'node:crypto';

const MONTHS = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

export function newId() {
  return randomUUID();
}

/**
 * @param {unknown} raw
 */
export function clampDuration(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.min(90, Math.max(15, Math.round(n)));
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeDay(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const iso = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = s.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),\s+(20\d{2})\b/i,
  );
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const day = String(named[2]).padStart(2, '0');
    return `${named[3]}-${month}-${day}`;
  }
  return s.slice(0, 48);
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function datesInText(raw) {
  const text = String(raw || '');
  const named =
    text.match(
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}\b/gi,
    ) || [];
  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || [];
  return [...new Set([...named, ...iso])];
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
export function dollarInText(raw) {
  const m = String(raw || '').match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} raw
 */
export function clip(raw, max) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * @param {unknown} raw
 */
export function normalizeSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '').trim();
  if (kind !== 'mail' && kind !== 'web' && kind !== 'you') return null;
  const source = { kind };
  const ref = clip(raw.ref, 180);
  const title = clip(raw.title, 180);
  if (ref) source.ref = ref;
  if (title) source.title = title;
  return source;
}

/**
 * @param {unknown} raw
 * @param {import('./now-model.js').Source | null} [source]
 */
export function normalizeStake(raw, source) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    const text = clip(raw, 400);
    if (!text) return null;
    const stake = { text };
    const amount = dollarInText(text);
    if (amount != null) stake.amount = amount;
    const src = source || null;
    if (src) stake.source = src;
    return stake;
  }
  if (typeof raw !== 'object') return null;
  const text = clip(raw.text || raw.answer || '', 400);
  if (!text && raw.amount == null) return null;
  /** @type {{ text: string, amount?: number, by?: string, source?: object }} */
  const stake = { text };
  const amount = Number(raw.amount);
  if (Number.isFinite(amount)) stake.amount = amount;
  else {
    const found = dollarInText(text);
    if (found != null) stake.amount = found;
  }
  const by = normalizeDay(raw.by);
  if (by) stake.by = by;
  const src = normalizeSource(raw.source) || source;
  if (src) stake.source = src;
  return stake;
}

/**
 * @param {unknown} raw
 */
export function normalizeTarget(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const text = clip(raw, 160);
    if (!text) return null;
    const value = Number(String(text).replace(/[$,]/g, ''));
    return {
      value: Number.isFinite(value) ? value : text,
      unit: '$',
      horizon: 'this year',
    };
  }
  if (typeof raw !== 'object') return null;
  const valueRaw = raw.value != null ? raw.value : raw.answer;
  const asNum = Number(String(valueRaw ?? '').replace(/[$,]/g, ''));
  const value = Number.isFinite(asNum) && String(valueRaw ?? '').trim() !== '' ? asNum : clip(valueRaw, 80);
  if (value === '' || value == null) return null;
  return {
    value,
    unit: clip(raw.unit, 24) || '$',
    horizon: clip(raw.horizon, 40) || 'this year',
  };
}

/**
 * @param {unknown} raw
 */
export function normalizeSignal(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    const label = clip(raw, 80);
    if (!label) return null;
    return { label, unit: 'count', direction: 'up' };
  }
  if (typeof raw !== 'object') return null;
  const label = clip(raw.label || raw.answer, 80);
  if (!label) return null;
  const direction = raw.direction === 'down' ? 'down' : 'up';
  return { label, unit: clip(raw.unit, 24) || 'count', direction };
}

/**
 * Apply a hole fill onto a goal. Statement text is left as it was.
 * @param {Record<string, unknown>} goal
 * @param {string} field
 * @param {unknown} value
 * @param {object | null} [source]
 */
export function applyGoalField(goal, field, value, source) {
  const statement = goal.statement;
  if (field === 'date' || field === 'due' || field === 'deadline') {
    const day = normalizeDay(value);
    if (day) goal.due = day;
  } else if (field === 'stake') {
    const stake = normalizeStake(value, source);
    if (stake) goal.stake = stake;
  } else if (field === 'target') {
    const target = normalizeTarget(value);
    if (target) goal.target = target;
  } else if (field === 'signal') {
    const signal = normalizeSignal(value);
    if (signal) goal.signal = signal;
  }
  goal.statement = statement;
}

/**
 * @param {Record<string, unknown>} goal
 * @param {Record<string, unknown>} patch
 */
export function fillGoal(goal, patch) {
  const statement = goal.statement;
  if (!patch || typeof patch !== 'object') {
    goal.statement = statement;
    return goal;
  }
  for (const field of ['due', 'date', 'stake', 'target', 'signal']) {
    if (patch[field] !== undefined) applyGoalField(goal, field === 'date' ? 'due' : field, patch[field], null);
  }
  if (patch.promise !== undefined) goal.promise = clip(patch.promise, 200);
  if (patch.promiseDue !== undefined) goal.promiseDue = patch.promiseDue === true;
  if (patch.warnDays !== undefined) {
    const n = Number(patch.warnDays);
    if (Number.isFinite(n) && n >= 0 && n <= 365) goal.warnDays = Math.round(n);
  }
  if (patch.weight !== undefined) {
    const n = Number(patch.weight);
    if (Number.isFinite(n) && n >= 0) goal.weight = n;
  }
  goal.statement = statement;
  return goal;
}

/**
 * @param {Record<string, unknown>} parent
 * @param {string} field
 * @param {unknown} value
 * @param {object | null} [source]
 */
export function applyParentField(parent, field, value, source) {
  if (field === 'deadline' || field === 'date' || field === 'due') {
    const day = normalizeDay(value);
    if (day) parent.deadline = day;
    return;
  }
  if (field === 'checklist' || field === 'step') {
    const text = clip(value, 240);
    if (!text) return;
    const listKey = parent.type === 'errand' ? 'checklist' : 'steps';
    const list = Array.isArray(parent[listKey]) ? parent[listKey] : [];
    const src = source || { kind: 'you', title: 'You' };
    if (src.kind === 'mail' && src.ref && list.some((row) => row?.source?.ref === src.ref)) return;
    const who = src.who === 'agent' || src.who === 'you' ? src.who : inferStepWho(text, src);
    list.push({
      id: newId(),
      text,
      done: false,
      who,
      source: { kind: src.kind, ...(src.ref ? { ref: src.ref } : {}), ...(src.title ? { title: src.title } : {}) },
    });
    parent[listKey] = list;
  }
}

/**
 * A parent with no steps is not a lineup. Add the smallest split:
 * one step the agent can do, and the part that needs the person.
 * @param {Record<string, unknown>} parent
 */
export function ensureParentSteps(parent) {
  if (!parent || parent.status === 'closed') return false;
  const listKey = parent.type === 'errand' ? 'checklist' : 'steps';
  const list = parent[listKey];
  if (Array.isArray(list) && list.length) return false;
  const title = clip(parent.outcome || parent.thesis || parent.question || parent.commitment?.title, 80);
  const steps = defaultSteps(parent.type, title);
  for (const step of steps) {
    applyParentField(parent, 'checklist', step.text, { kind: 'you', title: 'Project manager', who: step.who });
  }
  return steps.length > 0;
}

/**
 * @param {string} type
 * @param {string} title
 */
function defaultSteps(type, title) {
  const name = title || 'this';
  if (type === 'venture') {
    return [
      { text: `Gather evidence on “${name}”`, who: 'agent' },
      { text: 'Decide whether it survives the kill rule', who: 'you' },
    ];
  }
  if (type === 'inquiry') {
    return [
      { text: `Look for an answer to “${name}”`, who: 'agent' },
      { text: 'Judge whether that answers it', who: 'you' },
    ];
  }
  if (/\b(call|phone|text|email|book)\b/i.test(name)) {
    return [
      { text: 'Find the number or address', who: 'agent' },
      { text: name, who: 'you' },
    ];
  }
  if (/\b(tax|taxes|irs)\b/i.test(name)) {
    return [
      { text: 'Pull the filing date and what a late return costs', who: 'agent' },
      { text: 'File the return', who: 'you' },
    ];
  }
  return [
    { text: `Look up what “${name}” needs`, who: 'agent' },
    { text: name, who: 'you' },
  ];
}

/**
 * @param {unknown} raw
 */
/**
 * Mail, public pages, and lookup language are work the agent can do.
 * A stored who wins, so a later edit is not overwritten.
 * @param {string} text
 * @param {{ kind?: string } | null | undefined} source
 */
export function inferStepWho(text, source) {
  if (source?.kind === 'mail' || source?.kind === 'web') return 'agent';
  if (
    /\b(look\s*up|lookup|search|draft|summar|research|compare|gather|compile|check (my |the )?(mail|email|inbox)|find the|pull the|list the|write (a |the )?(note|draft|email))\b/i.test(
      text,
    )
  ) {
    return 'agent';
  }
  return 'you';
}

export function normalizeStep(raw) {
  if (!raw || typeof raw !== 'object') {
    const text = clip(raw, 240);
    if (!text) return null;
    return { id: newId(), text, done: false, who: inferStepWho(text, null), source: { kind: 'you', title: 'You' } };
  }
  const text = clip(raw.text, 240);
  if (!text) return null;
  const source = normalizeSource(raw.source);
  const who = raw.who === 'agent' || raw.who === 'you' ? raw.who : inferStepWho(text, source);
  return {
    id: clip(raw.id, 80) || newId(),
    text,
    done: raw.done === true,
    who,
    source,
  };
}

/**
 * @param {unknown} raw
 */
export function normalizeCommitment(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const mode = ['do', 'decide', 'research'].includes(c.mode) ? c.mode : 'do';
  const owner = ['you', 'agent', 'agent-then-you'].includes(c.owner) ? c.owner : 'you';
  const state = ['nominated', 'active', 'paused', 'done', 'needs-review'].includes(c.state)
    ? c.state
    : 'nominated';
  return {
    id: clip(c.id, 80) || newId(),
    title: clip(c.title, 140) || 'Sitting',
    durationMin: clampDuration(c.durationMin),
    mode,
    owner,
    state,
  };
}

/**
 * @param {unknown} raw
 */
export function normalizeParent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = ['errand', 'venture', 'inquiry'].includes(raw.type) ? raw.type : 'errand';
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).map(normalizeStep).filter(Boolean).slice(0, 24);
  const checklist = (Array.isArray(raw.checklist) ? raw.checklist : [])
    .map(normalizeStep)
    .filter(Boolean)
    .slice(0, 40);
  /** @type {Record<string, unknown>} */
  const parent = {
    id: clip(raw.id, 80) || newId(),
    type,
    status: raw.status === 'closed' ? 'closed' : 'open',
    goalId: clip(raw.goalId, 80),
    goalReason: clip(raw.goalReason, 240),
    commitment: normalizeCommitment(raw.commitment),
    steps,
    createdAt: clip(raw.createdAt, 40) || new Date().toISOString(),
  };
  if (type === 'errand') {
    parent.outcome = clip(raw.outcome, 400);
    parent.deadline = normalizeDay(raw.deadline);
    parent.checklist = checklist;
    const taskId = String(raw.vikunjaTaskId || '').trim();
    parent.vikunjaTaskId = /^\d+$/.test(taskId) ? taskId : '';
  } else if (type === 'venture') {
    parent.thesis = clip(raw.thesis, 400);
    parent.stage = ['hunch', 'probe', 'decide'].includes(raw.stage) ? raw.stage : 'hunch';
    parent.riskiestAssumption = clip(raw.riskiestAssumption, 400);
    parent.evidence = clip(raw.evidence, 800);
    parent.killRule = clip(raw.killRule, 400);
  } else {
    parent.question = clip(raw.question, 400);
    parent.answeredLooksLike = clip(raw.answeredLooksLike, 400);
    const budget = Number(raw.sittingBudget);
    parent.sittingBudget = budget === 2 ? 2 : 1;
    const used = Number(raw.sittingsUsed);
    parent.sittingsUsed = Number.isFinite(used) && used > 0 ? Math.min(9, Math.round(used)) : 0;
    parent.closeAs = ['drop', 'note', 'venture'].includes(raw.closeAs) ? raw.closeAs : '';
    parent.note = clip(raw.note, 800);
  }
  if (clip(raw.attachToParentId, 80)) parent.attachToParentId = clip(raw.attachToParentId, 80);
  return parent;
}

/**
 * @param {unknown} raw
 */
export function normalizeGoal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const statement = clip(raw.statement, 400);
  if (!statement) return null;
  const kind = raw.kind === 'aim' ? 'aim' : 'floor';
  /** @type {Record<string, unknown>} */
  const goal = {
    id: clip(raw.id, 80) || newId(),
    kind,
    statement,
  };
  if (kind === 'floor') {
    goal.due = normalizeDay(raw.due);
    goal.promise = clip(raw.promise, 200);
    goal.promiseDue = raw.promiseDue === true;
    const warn = Number(raw.warnDays);
    goal.warnDays = Number.isFinite(warn) && warn >= 0 ? Math.min(365, Math.round(warn)) : 7;
    goal.stake = normalizeStake(raw.stake, null);
  } else {
    const weight = Number(raw.weight);
    goal.weight = Number.isFinite(weight) && weight >= 0 ? weight : 1;
    goal.signal = normalizeSignal(raw.signal);
    goal.target = normalizeTarget(raw.target);
  }
  return goal;
}

/**
 * @param {unknown} raw
 */
export function normalizeHole(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = clip(raw.prompt, 300);
  if (!prompt) return null;
  const fills = raw.fills && typeof raw.fills === 'object' ? raw.fills : {};
  const field = clip(fills.field, 40);
  if (!field) return null;
  const record = fills.record === 'goal' ? 'goal' : 'parent';
  return {
    id: clip(raw.id, 80) || newId(),
    prompt,
    answer: clip(raw.answer, 400),
    open: raw.open !== false && !clip(raw.answer, 8),
    fills: {
      record,
      field,
      parentId: clip(fills.parentId, 80),
      goalId: clip(fills.goalId, 80),
      goalKind: fills.goalKind === 'floor' || fills.goalKind === 'aim' ? fills.goalKind : '',
    },
    source: normalizeSource(raw.source),
  };
}

/**
 * @param {string} note
 */
export function noteWantsTaxLookup(note) {
  return /\b(tax|taxes|irs|lien)\b/i.test(note);
}

/**
 * @param {string} note
 */
export function noteWantsMoneyTarget(note) {
  return /\b(make money|earn|income|revenue)\b/i.test(note) && !noteWantsTaxLookup(note);
}

/**
 * @param {string} field
 * @param {string} record
 */
export function holeKey(field, record) {
  return `${record}:${field}`;
}

/**
 * Build the first draft from the words alone. Lookups and the model enrich this later.
 * @param {string} note
 * @param {Record<string, unknown>[]} parents
 */
export function heuristicDraft(note, parents) {
  const text = clip(note, 2000);
  const lower = text.toLowerCase();
  /** @type {ReturnType<typeof normalizeHole>[]} */
  const questions = [];
  /** @type {Record<string, unknown> | null} */
  let proposedGoal = null;
  /** @type {Record<string, unknown> | null} */
  let draft = null;
  let mailQuery = '';
  let webTopic = '';

  const openVentures = (Array.isArray(parents) ? parents : []).filter(
    (p) => p && p.type === 'venture' && p.status !== 'closed' && p.thesis,
  );
  if (/\b(research|look into|learn about)\b/i.test(text)) {
    const hit = openVentures.find((p) => lower.includes(String(p.thesis).toLowerCase().slice(0, 24)));
    if (hit) {
      draft = normalizeParent({
        type: 'venture',
        thesis: hit.thesis,
        stage: hit.stage,
        attachToParentId: hit.id,
        goalId: hit.goalId,
        commitment: {
          title: `Research: ${text}`.slice(0, 140),
          durationMin: 45,
          mode: 'research',
          owner: 'you',
          state: 'nominated',
        },
      });
      return { draft, proposedGoal, questions, mailQuery, webTopic };
    }
  }

  if (noteWantsMoneyTarget(text)) {
    proposedGoal = normalizeGoal({
      kind: 'aim',
      statement: text,
      weight: 1,
    });
    questions.push(
      normalizeHole({
        prompt: 'How much do you want to make this year?',
        fills: { record: 'goal', field: 'target', goalKind: 'aim' },
      }),
    );
    questions.push(
      normalizeHole({
        prompt: 'What should we count for this aim?',
        fills: { record: 'goal', field: 'signal', goalKind: 'aim' },
      }),
    );
    return { draft, proposedGoal, questions, mailQuery, webTopic };
  }

  const foundDates = datesInText(text);
  draft = normalizeParent({
    type: 'errand',
    outcome: text,
    deadline: foundDates.length === 1 ? foundDates[0] : '',
    commitment: {
      title: text.slice(0, 140) || 'Sitting',
      durationMin: noteWantsTaxLookup(text) ? 60 : 30,
      mode: 'do',
      owner: 'you',
      state: 'nominated',
    },
  });

  if (noteWantsTaxLookup(text)) {
    proposedGoal = normalizeGoal({
      kind: 'floor',
      statement: 'File taxes before a late bill becomes a lien',
      warnDays: 14,
    });
    mailQuery = 'tax OR IRS OR "tax return" newer_than:18m';
    webTopic = 'tax';
    questions.push(
      normalizeHole({
        prompt: 'What date does this need to be done?',
        fills: { record: 'parent', field: 'deadline' },
      }),
    );
    questions.push(
      normalizeHole({
        prompt: 'What do you lose if this is late?',
        fills: { record: 'goal', field: 'stake', goalKind: 'floor' },
      }),
    );
  } else if (!draft.deadline) {
    questions.push(
      normalizeHole({
        prompt: 'What date does this need to be done?',
        fills: { record: 'parent', field: 'deadline' },
      }),
    );
  }

  return { draft, proposedGoal, questions, mailQuery, webTopic };
}

/**
 * @param {Record<string, unknown>} parent
 * @param {ReturnType<typeof normalizeHole>[]} holes
 */
export function missingParentHoles(parent, holes) {
  /** @type {ReturnType<typeof normalizeHole>[]} */
  const add = [];
  if (!parent || parent.status === 'closed' || parent.type !== 'errand') return add;
  if (parent.deadline) return add;
  const exists = holes.some(
    (h) => h.open && h.fills.record === 'parent' && h.fills.parentId === parent.id && h.fills.field === 'deadline',
  );
  if (exists) return add;
  add.push(
    normalizeHole({
      prompt: 'What date does this need to be done?',
      fills: { record: 'parent', field: 'deadline', parentId: parent.id },
    }),
  );
  return add;
}

/**
 * @param {Record<string, unknown>} goal
 * @param {ReturnType<typeof normalizeHole>[]} holes
 */
export function missingGoalHoles(goal, holes) {
  /** @type {ReturnType<typeof normalizeHole>[]} */
  const add = [];
  if (!goal) return add;
  const has = (field) =>
    holes.some((h) => h.open && h.fills.record === 'goal' && h.fills.goalId === goal.id && h.fills.field === field);

  if (goal.kind === 'floor') {
    if (!goal.due && !goal.promise && !has('date')) {
      add.push(
        normalizeHole({
          prompt: 'What date or promise does this floor rest on?',
          fills: { record: 'goal', field: 'date', goalId: goal.id, goalKind: 'floor' },
        }),
      );
    }
    if (!goal.stake && noteWantsTaxLookup(String(goal.statement || '')) && !has('stake')) {
      add.push(
        normalizeHole({
          prompt: 'What do you lose if this is late?',
          fills: { record: 'goal', field: 'stake', goalId: goal.id, goalKind: 'floor' },
        }),
      );
    }
  }
  if (goal.kind === 'aim') {
    if (!goal.target && noteWantsMoneyTarget(String(goal.statement || '')) && !has('target')) {
      add.push(
        normalizeHole({
          prompt: 'How much do you want to make this year?',
          fills: { record: 'goal', field: 'target', goalId: goal.id, goalKind: 'aim' },
        }),
      );
    }
    if (!goal.signal && !has('signal')) {
      add.push(
        normalizeHole({
          prompt: 'What should we count for this aim?',
          fills: { record: 'goal', field: 'signal', goalId: goal.id, goalKind: 'aim' },
        }),
      );
    }
  }
  return add;
}

/**
 * @param {ReturnType<typeof normalizeHole>} hole
 * @param {string} answer
 * @param {{ parent?: Record<string, unknown> | null, goal?: Record<string, unknown> | null }} targets
 */
export function applyHoleAnswer(hole, answer, targets) {
  const text = clip(answer, 400);
  hole.answer = text;
  hole.open = !text;
  hole.source = { kind: 'you', title: 'You' };
  if (!text) return;
  const field = hole.fills.field;
  if (hole.fills.record === 'goal' && targets.goal) {
    applyGoalField(targets.goal, field, text, hole.source);
  } else if (targets.parent) {
    applyParentField(targets.parent, field, text, hole.source);
  }
}
