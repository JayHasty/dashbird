/**
 * Do Random Task picker + project locations table + waiting-on list.
 */
import { TASK_LOCATION_OPTIONS, patchTaskRandomMeta } from './task-location-meta.js';
import { fillLinkifiedText } from './linkify-text.js';
import {
  clearTaskSchedule,
  createScheduleControl,
  ensureOverduePriority,
  scheduleTaskToCalendar,
} from './task-schedule.js';

const DIFFICULTIES = [
  { id: 'low', label: 'Low' },
  { id: 'med', label: 'Med' },
  { id: 'high', label: 'High' },
];
const PRIORITIES = [
  { id: 'low', label: 'Low' },
  { id: 'med', label: 'Med' },
  { id: 'high', label: 'High' },
];
const DURATIONS = [
  { id: 'quick', label: 'quick' },
  { id: '<1hr', label: '<1hr' },
  { id: '1/2day', label: '1/2 day' },
  { id: 'day+', label: 'day+' },
];
const LOCATIONS = [
  { id: '', label: 'Any' },
  { id: 'home', label: 'Home' },
  { id: 'makerfarm', label: 'Maker Farm' },
  { id: 'out', label: 'Out and about' },
  { id: 'laptop', label: 'Laptop only' },
  { id: 'phone', label: 'Phone ok' },
];
const DIFFICULTY_LABELS = Object.fromEntries(DIFFICULTIES.map((d) => [d.id, d.label]));
const DURATION_LABELS = Object.fromEntries(DURATIONS.map((d) => [d.id, d.label]));
const LOCATION_LABELS = Object.fromEntries(LOCATIONS.filter((l) => l.id).map((l) => [l.id, l.label]));
const TIME_OPTIONS = [{ id: 'weekday_9_5', label: 'Weekday 9–5' }];
const TIME_LABELS = Object.fromEntries(TIME_OPTIONS.map((t) => [t.id, t.label]));

const FIELD_LABELS = {
  priority: 'Priority',
  difficulty: 'Effort',
  duration: 'Duration',
  locations: 'Location',
  times: 'When',
};

const ALL_ASSIGN_FIELDS = ['priority', 'difficulty', 'duration', 'locations', 'times'];

/**
 * @param {string} field
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
function fieldOptionsForAssign(field, taskMeta, projectMeta) {
  if (field === 'priority') return PRIORITIES;
  if (field === 'difficulty') return DIFFICULTIES;
  if (field === 'duration') return DURATIONS;
  if (field === 'locations') {
    return [{ id: '__any__', label: 'Any location' }, ...TASK_LOCATION_OPTIONS];
  }
  if (field === 'times') return [{ id: '__any__', label: 'Any time' }, ...TIME_OPTIONS];
  return [];
}

/**
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 * @returns {string | null}
 */
function resolvedLocationAssignValue(taskMeta, _projectMeta) {
  if (taskMeta?.locationAny) return '__any__';
  if (typeof taskMeta?.location === 'string' && taskMeta.location) return taskMeta.location;
  if (Array.isArray(taskMeta?.locations) && taskMeta.locations.length) {
    return String(taskMeta.locations[0]);
  }
  // No project-default inheritance: a task only shows a location it sets itself.
  return null;
}

/**
 * @param {string} field
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 * @returns {string | null}
 */
function currentAssignFieldValue(field, taskMeta, projectMeta) {
  if (field === 'priority') return typeof taskMeta?.priority === 'string' ? taskMeta.priority : null;
  if (field === 'difficulty') return typeof taskMeta?.difficulty === 'string' ? taskMeta.difficulty : null;
  if (field === 'duration') return typeof taskMeta?.duration === 'string' ? taskMeta.duration : null;
  if (field === 'locations') return resolvedLocationAssignValue(taskMeta, projectMeta);
  if (field === 'times') {
    if (taskMeta?.timeAny) return '__any__';
    if (Array.isArray(taskMeta?.times) && taskMeta.times.length) return String(taskMeta.times[0]);
    return null;
  }
  return null;
}

/**
 * @param {string} field
 * @param {string} id
 */
function levelToneClass(field, id) {
  if ((field === 'priority' || field === 'difficulty') && (id === 'low' || id === 'med' || id === 'high')) {
    const tone = field === 'priority' ? 'priority' : 'effort';
    return `tasks-random__chip--${tone}-${id}`;
  }
  return '';
}

/**
 * @param {HTMLElement} el
 * @param {string} field
 * @param {string} id
 */
function applyLevelTone(el, field, id) {
  const cls = levelToneClass(field, id);
  if (cls) el.classList.add(cls);
}

/**
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
function assignSummaryEntries(taskMeta, projectMeta) {
  /** @type {Array<{ field: string, id: string, label: string }>} */
  const out = [];
  for (const field of ALL_ASSIGN_FIELDS) {
    const id = currentAssignFieldValue(field, taskMeta, projectMeta);
    if (id == null) continue;
    let label = id;
    if (field === 'priority') label = PRIORITIES.find((o) => o.id === id)?.label || id;
    else if (field === 'difficulty') label = DIFFICULTIES.find((o) => o.id === id)?.label || id;
    else if (field === 'duration') label = DURATIONS.find((o) => o.id === id)?.label || id;
    else if (field === 'locations') {
      if (id === '__any__') label = 'Any location';
      else label = TASK_LOCATION_OPTIONS.find((o) => o.id === id)?.label || LOCATION_LABELS[id] || id;
    } else if (field === 'times') {
      if (id === '__any__') label = 'Any time';
      else label = TIME_OPTIONS.find((o) => o.id === id)?.label || TIME_LABELS[id] || id;
    }
    out.push({ field, id, label: `${FIELD_LABELS[field]}: ${label}` });
  }
  return out;
}

/**
 * @param {HTMLElement} assignRow
 * @param {string[]} fields
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 * @param {Record<string, unknown>} data
 * @param {{
 *   onAssignSaved?: (row: Record<string, unknown> | null, fullMeta: object) => void | Promise<void>,
 * } & Partial<Parameters<typeof renderTaskCardModal>[0]>} opts
 */
function appendAssignFields(assignRow, fields, taskMeta, projectMeta, data, opts) {
  for (const field of fields) {
    const group = document.createElement('div');
    group.className = `tasks-random__assign-group tasks-random__assign-group--${field}`;
    const fl = document.createElement('span');
    fl.className = 'tasks-random__assign-field';
    fl.textContent = FIELD_LABELS[field] || field;
    const chipContainer = document.createElement('div');
    chipContainer.className = 'tasks-random__assign-chips';
    group.append(fl, chipContainer);
    const selected = currentAssignFieldValue(field, taskMeta, projectMeta);
    for (const opt of fieldOptionsForAssign(field, taskMeta, projectMeta)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tasks-random__chip tasks-random__chip--assign';
      b.textContent = opt.label;
      if (selected != null && opt.id === selected) {
        b.classList.add('tasks-random__chip--on');
        applyLevelTone(b, field, opt.id);
      }
      b.addEventListener('click', async () => {
        /** @type {Record<string, unknown>} */
        const patch = {};
        if (field === 'priority') patch.priority = opt.id;
        else if (field === 'difficulty') patch.difficulty = opt.id;
        else if (field === 'duration') patch.duration = opt.id;
        else if (field === 'locations') {
          if (opt.id === '__any__') Object.assign(patch, { locationAny: true });
          else Object.assign(patch, { location: opt.id });
        }
        else if (field === 'times') {
          if (opt.id === '__any__') patch.timeAny = true;
          else patch.times = [opt.id];
        }
        b.disabled = true;
        try {
          const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(data.task.id)}/meta`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          });
          if (!r.ok) throw new Error('save_failed');
          const j = await r.json();
          const row = Object.hasOwn(j, 'row') ? j.row : taskMeta;
          if (opts.onAssignSaved) {
            await opts.onAssignSaved(row, j.meta || {});
            return;
          }
          await renderTaskCardModal({
            ...opts,
            data: {
              ...data,
              meta: row,
            },
          });
        } catch {
          b.disabled = false;
        }
      });
      chipContainer.append(b);
    }
    assignRow.append(group);
  }
}

/**
 * Edit random-picker tags (priority / effort / duration / location / when) for one task.
 * @param {{
 *   root: HTMLElement,
 *   taskId: string,
 *   taskText?: string,
 *   projectId?: number | null,
 *   taskMeta?: Record<string, unknown> | null,
 *   projectMeta?: Record<string, unknown> | null,
 *   onMetaChange?: (meta: object) => void,
 * }} opts
 */
export function openTaskTagsEditor(opts) {
  const { root, taskId, taskText = '', projectId = null, onMetaChange } = opts;
  let taskMeta = opts.taskMeta || null;
  const projectMeta = opts.projectMeta || null;
  const { body, close } = makeModalShell(root, 'Edit tags');

  const data = {
    matched: true,
    task: { id: taskId, text: taskText, projectId },
    meta: taskMeta,
    projectMeta,
  };

  function paint() {
    body.replaceChildren();
    if (taskText) {
      const name = document.createElement('p');
      name.className = 'tasks-random__tags-task-name';
      fillLinkifiedText(name, taskText);
      body.append(name);
    }
    const assignRow = document.createElement('div');
    assignRow.className = 'tasks-random__assign';
    appendAssignFields(assignRow, ALL_ASSIGN_FIELDS, taskMeta, projectMeta, data, {
      onAssignSaved: async (row, fullMeta) => {
        taskMeta = row;
        data.meta = row;
        if (fullMeta && typeof fullMeta === 'object') onMetaChange?.(fullMeta);
        paint();
      },
    });
    body.append(assignRow);
  }

  paint();
  return { close };
}

/**
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
function hasEffectiveLocation(taskMeta, _projectMeta) {
  if (taskMeta?.locationAny) return true;
  if (typeof taskMeta?.location === 'string' && taskMeta.location) return true;
  if (Array.isArray(taskMeta?.locations) && taskMeta.locations.length) return true;
  // No project-default inheritance: project location no longer satisfies a task.
  return false;
}

function hasEffectiveTime(taskMeta) {
  if (taskMeta?.timeAny) return true;
  if (Array.isArray(taskMeta?.times) && taskMeta.times.length) return true;
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
function missingFieldsForCard(taskMeta, projectMeta) {
  /** @type {string[]} */
  const missing = [];
  if (!taskMeta?.priority) missing.push('priority');
  if (!taskMeta?.difficulty) missing.push('difficulty');
  if (!taskMeta?.duration) missing.push('duration');
  if (!hasEffectiveLocation(taskMeta, projectMeta)) missing.push('locations');
  if (!hasEffectiveTime(taskMeta)) missing.push('times');
  return missing;
}

/**
 * @param {HTMLElement} parent
 * @param {string} title
 * @param {{ hideClose?: boolean }} [opts]
 */
function makeModalShell(parent, title, opts = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'tasks-random__backdrop';
  const modal = document.createElement('div');
  modal.className = 'tasks-random__modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const head = document.createElement('div');
  head.className = 'tasks-random__head';
  if (opts.hideTitle) head.classList.add('tasks-random__head--bare');
  if (!opts.hideTitle) {
    const h2 = document.createElement('h2');
    h2.className = 'tasks-random__title';
    h2.textContent = title;
    head.append(h2);
  }
  if (!opts.hideClose) {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tasks-random__close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close');
    head.append(closeBtn);
    closeBtn.addEventListener('click', () => close());
  }
  const body = document.createElement('div');
  body.className = 'tasks-random__body';
  modal.append(head, body);
  backdrop.append(modal);
  parent.append(backdrop);

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  return { backdrop, modal, body, close };
}

/**
 * @param {HTMLElement} row
 * @param {string} label
 * @param {Array<{ id: string, label: string }>} options
 * @param {() => string[]} getSelected
 * @param {(ids: string[]) => void} onChange
 */
function multiselectChipRow(row, label, options, getSelected, onChange) {
  const lab = document.createElement('p');
  lab.className = 'tasks-random__row-label';
  lab.textContent = label;
  row.append(lab);
  const chips = document.createElement('div');
  chips.className = 'tasks-random__chips';
  function syncChips() {
    const selected = new Set(getSelected());
    for (const c of chips.querySelectorAll('.tasks-random__chip')) {
      const on = selected.has(c.dataset.id || '');
      c.classList.toggle('tasks-random__chip--on', on);
      if (c.dataset.field && c.dataset.id) {
        c.classList.remove(
          'tasks-random__chip--priority-low',
          'tasks-random__chip--priority-med',
          'tasks-random__chip--priority-high',
          'tasks-random__chip--effort-low',
          'tasks-random__chip--effort-med',
          'tasks-random__chip--effort-high',
        );
        if (on) applyLevelTone(c, c.dataset.field, c.dataset.id);
      }
    }
  }
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tasks-random__chip';
    btn.textContent = opt.label;
    btn.dataset.id = opt.id;
    if (opt.field) btn.dataset.field = opt.field;
    btn.addEventListener('click', () => {
      const selected = new Set(getSelected());
      if (selected.has(opt.id)) selected.delete(opt.id);
      else selected.add(opt.id);
      onChange([...selected]);
      syncChips();
    });
    chips.append(btn);
  }
  syncChips();
  row.append(chips);
}

/**
 * @param {string} id
 */
async function archiveRandomTaskDone(id) {
  const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(id)}/done`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archive: true }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  await clearTaskSchedule(id);
}

/**
 * @param {HTMLElement} titleEl
 * @param {string} initial
 * @param {(next: string) => void | Promise<void>} onCommit
 */
function beginRandomTaskTitleEdit(titleEl, initial, onCommit) {
  if (titleEl.querySelector('input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tasks-random__card-title-input';
  input.value = initial;
  input.setAttribute('aria-label', 'Edit task text');
  titleEl.replaceChildren(input);
  input.focus();
  input.select();

  let closed = false;
  async function finish(save) {
    if (closed) return;
    closed = true;
    const next = input.value.trim();
    if (!save || !next) {
      fillLinkifiedText(titleEl, initial);
      return;
    }
    if (next === initial) {
      fillLinkifiedText(titleEl, initial);
      return;
    }
    fillLinkifiedText(titleEl, next);
    titleEl.classList.add('tasks-random__card-title--saving');
    try {
      await onCommit(next);
      titleEl.classList.remove('tasks-random__card-title--saving');
    } catch {
      fillLinkifiedText(titleEl, initial);
      titleEl.classList.remove('tasks-random__card-title--saving');
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void finish(false);
    }
  });
  input.addEventListener('blur', () => {
    void finish(true);
  });
}

/**
 * @param {string} taskId
 * @param {string} text
 */
async function saveRandomTaskText(taskId, text) {
  const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    throw new Error(j.detail || j.error || `HTTP ${r.status}`);
  }
  return j.item || { id: taskId, text };
}

/**
 * @param {{
 *   body: HTMLElement,
 *   data: Record<string, unknown>,
 *   onHighlightTask?: (task: object) => void,
 *   onMarkDone?: (id: string) => void | Promise<void>,
 *   onTextChange?: (id: string, text: string, projectId?: number | null) => void,
 *   onSkip: () => void,
 *   onSkipProject: () => void,
 *   closeCard: () => void,
 * }} opts
 */
async function renderTaskCardModal(opts) {
  const { body, data, onMarkDone, onTextChange, onSkip, onSkipProject, closeCard } = opts;
  body.replaceChildren();

  if (!data?.matched || !data.task) {
    const empty = document.createElement('p');
    empty.className = 'tasks-random__empty muted';
    empty.textContent = data?.message || 'No tasks match — try relaxing filters or tag more tasks.';
    const actions = document.createElement('div');
    actions.className = 'tasks-random__actions';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tasks-random__secondary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeCard);
    actions.append(closeBtn);
    body.append(empty, actions);
    return;
  }

  const taskMeta = data.meta || null;
  const projectMeta = data.projectMeta || null;
  const missingFields = missingFieldsForCard(taskMeta, projectMeta);

  const card = document.createElement('div');
  card.className = 'tasks-random__card';

  const title = document.createElement('h3');
  title.className = 'tasks-random__card-title';
  fillLinkifiedText(title, data.task.text);
  title.title = 'Double-click to edit';

  const proj = document.createElement('p');
  proj.className = 'tasks-random__card-project-head';
  const projEm = document.createElement('em');
  projEm.textContent = data.task.projectTitle || 'Project';
  proj.append(projEm);

  card.append(title, proj);

  title.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const taskId = String(data.task.id);
    const current = String(data.task.text || '');
    beginRandomTaskTitleEdit(title, current, async (next) => {
      await saveRandomTaskText(taskId, next);
      data.task.text = next;
      onTextChange?.(
        taskId,
        next,
        data.task.projectId != null ? Number(data.task.projectId) : null,
      );
    });
  });

  const assignWrap = document.createElement('details');
  assignWrap.className = 'tasks-random__assign-details';
  assignWrap.open = missingFields.length > 0;
  const assignSummary = document.createElement('summary');
  assignSummary.className = 'tasks-random__assign-summary';

  if (missingFields.length) {
    assignSummary.textContent = 'Set task attributes';
  } else {
    const summaryChips = document.createElement('span');
    summaryChips.className = 'tasks-random__assign-summary-chips';
    for (const entry of assignSummaryEntries(taskMeta, projectMeta)) {
      const chip = document.createElement('span');
      chip.className = 'tasks-random__summary-chip';
      chip.textContent = entry.label;
      applyLevelTone(chip, entry.field, entry.id);
      summaryChips.append(chip);
    }
    assignSummary.append(summaryChips);
  }

  const chevron = document.createElement('span');
  chevron.className = 'tasks-random__assign-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▾';
  assignSummary.append(chevron);

  const assignRow = document.createElement('div');
  assignRow.className = 'tasks-random__assign';
  appendAssignFields(assignRow, ALL_ASSIGN_FIELDS, taskMeta, projectMeta, data, opts);
  assignWrap.append(assignSummary, assignRow);
  card.append(assignWrap);

  // Bottom matches task edit overlays: full-width Schedule + Waiting on, then actions.
  const bottom = document.createElement('div');
  bottom.className = 'tasks-random__bottom';

  const scheduleSlot = document.createElement('div');
  scheduleSlot.className = 'tasks-random__schedule-slot';
  const sched = createScheduleControl({
    wrapClass: 'task-schedule tasks-random__schedule-wrap tasks-random__bottom-schedule-wrap',
    buttonClass: 'tasks-random__secondary tasks-random__schedule tasks-random__bottom-schedule',
    overdueClass: 'task-schedule__overdue',
  });
  sched.sync(taskMeta);
  scheduleSlot.append(sched.wrap);

  const waitingSlot = document.createElement('div');
  waitingSlot.className = 'tasks-random__waiting';
  const waiting = createWaitingOnControl({
    taskId: String(data.task.id),
    waitingOn: taskMeta?.waitingOn === true,
    wrapClass: 'tasks-panel__waiting tasks-random__waiting-control',
    checkClass: 'tasks-panel__waiting-check',
    onMetaChange: (fullMeta) => {
      const row = fullMeta?.byTaskId?.[String(data.task.id)] || null;
      data.meta = row;
      opts.onMetaChange?.(fullMeta);
    },
  });
  waitingSlot.append(waiting.wrap);

  const actions = document.createElement('div');
  actions.className = 'tasks-random__actions';
  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'tasks-random__secondary';
  skipBtn.textContent = 'Skip';
  const skipProjectBtn = document.createElement('button');
  skipProjectBtn.type = 'button';
  skipProjectBtn.className = 'tasks-random__secondary';
  skipProjectBtn.textContent = 'Skip project';
  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'tasks-random__secondary';
  doneBtn.textContent = 'Mark done';
  actions.append(skipBtn, skipProjectBtn, doneBtn);

  bottom.append(scheduleSlot, waitingSlot, actions);
  card.append(bottom);
  body.append(card);

  skipBtn.addEventListener('click', onSkip);
  skipProjectBtn.addEventListener('click', onSkipProject);
  sched.button.addEventListener('click', async () => {
    sched.button.disabled = true;
    try {
      const { row } = await scheduleTaskToCalendar(
        String(data.task.id),
        String(data.task.text || ''),
        taskMeta,
      );
      await renderTaskCardModal({
        ...opts,
        data: {
          ...data,
          meta: row,
        },
      });
    } catch {
      sched.button.disabled = false;
    }
  });
  doneBtn.addEventListener('click', async () => {
    doneBtn.disabled = true;
    try {
      await onMarkDone?.(String(data.task.id));
    } catch {
      doneBtn.disabled = false;
    }
  });

  void ensureOverduePriority(String(data.task.id), taskMeta).then((res) => {
    if (!res) return;
    void renderTaskCardModal({
      ...opts,
      data: {
        ...data,
        meta: res.row,
      },
    });
  });
}

/**
 * @param {{ root: HTMLElement, projects: Array<{ id: number, title: string }>, onHighlightTask?: (task: { id: string, projectId?: number | null }) => void, onDone?: (id: string, projectId?: number | null) => void, onTextChange?: (id: string, text: string, projectId?: number | null) => void }} opts
 */
export function openRandomTaskPicker(opts) {
  const { root, onDone, onTextChange } = opts;

  /** @type {string[]} */
  let priorities = [];
  /** @type {string[]} */
  let difficulties = [];
  /** @type {string[]} */
  let durations = [];
  /** @type {string[]} */
  let locations = [];
  /** @type {string[]} */
  let times = [];

  const filterShell = makeModalShell(root, 'Random Task Options');

  const filterWrap = document.createElement('div');
  filterWrap.className = 'tasks-random__filters';

  const hint = document.createElement('p');
  hint.className = 'tasks-random__hint muted';
  hint.textContent = 'Pick any combination below. Leave a row empty to allow all values for that attribute.';

  const priorityRow = document.createElement('div');
  priorityRow.className = 'tasks-random__filter-row';
  multiselectChipRow(
    priorityRow,
    'Priority',
    PRIORITIES.map((o) => ({ ...o, field: 'priority' })),
    () => priorities,
    (ids) => {
      priorities = ids;
    },
  );

  const diffRow = document.createElement('div');
  diffRow.className = 'tasks-random__filter-row';
  multiselectChipRow(
    diffRow,
    'Effort',
    DIFFICULTIES.map((o) => ({ ...o, field: 'difficulty' })),
    () => difficulties,
    (ids) => {
      difficulties = ids;
    },
  );

  const durRow = document.createElement('div');
  durRow.className = 'tasks-random__filter-row';
  multiselectChipRow(durRow, 'Duration', DURATIONS, () => durations, (ids) => {
    durations = ids;
  });

  const locRow = document.createElement('div');
  locRow.className = 'tasks-random__filter-row';
  multiselectChipRow(locRow, 'Location', TASK_LOCATION_OPTIONS, () => locations, (ids) => {
    locations = ids;
  });

  const timeRow = document.createElement('div');
  timeRow.className = 'tasks-random__filter-row';
  multiselectChipRow(timeRow, 'When', TIME_OPTIONS, () => times, (ids) => {
    times = ids;
  });

  filterWrap.append(hint, priorityRow, diffRow, durRow, locRow, timeRow);

  const filterActions = document.createElement('div');
  filterActions.className = 'tasks-random__filter-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'tasks-random__secondary';
  cancelBtn.textContent = 'Cancel';
  const goBtn = document.createElement('button');
  goBtn.type = 'button';
  goBtn.className = 'tasks-random__primary';
  goBtn.textContent = 'Go';
  filterActions.append(cancelBtn, goBtn);

  filterShell.body.append(filterWrap, filterActions);

  cancelBtn.addEventListener('click', () => filterShell.close());

  goBtn.addEventListener('click', () => {
    filterShell.close();
    openTaskCardModal();
  });

  /** @type {string[]} */
  const excludeIds = [];
  /** @type {string[]} */
  const excludeProjectIds = [];

  async function fetchRandomTask() {
    /** @type {Record<string, unknown>} */
    const bodyObj = {
      excludeIds,
      excludeProjectIds,
    };
    if (priorities.length) bodyObj.priorities = priorities;
    if (difficulties.length) bodyObj.difficulties = difficulties;
    if (durations.length) bodyObj.durations = durations;
    if (locations.length) bodyObj.locations = locations;
    if (times.length) bodyObj.times = times;
    const r = await fetch('/api/vikunja/random-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || j.error || 'pick_failed');
    return j;
  }

  function openTaskCardModal() {
    const cardShell = makeModalShell(root, '', { hideTitle: true });
    /** @type {string | null} */
    let currentTaskId = null;
    /** @type {number | null} */
    let currentProjectId = null;

    async function pickAndShow() {
      const loading = document.createElement('p');
      loading.className = 'tasks-random__status muted';
      loading.textContent = 'Picking a task…';
      cardShell.body.replaceChildren(loading);
      try {
        const j = await fetchRandomTask();
        currentTaskId = j.task?.id != null ? String(j.task.id) : null;
        currentProjectId =
          j.task?.projectId != null && Number.isFinite(Number(j.task.projectId))
            ? Number(j.task.projectId)
            : null;
        await renderTaskCardModal({
          body: cardShell.body,
          data: j,
          closeCard: cardShell.close,
          onTextChange,
          onSkip: () => {
            if (currentTaskId) excludeIds.push(currentTaskId);
            void pickAndShow();
          },
          onSkipProject: () => {
            if (currentProjectId != null) excludeProjectIds.push(String(currentProjectId));
            void pickAndShow();
          },
          onMarkDone: async (id) => {
            if (id) excludeIds.push(id);
            await archiveRandomTaskDone(id);
            onDone?.(id, currentProjectId);
            await pickAndShow();
          },
        });
      } catch (e) {
        cardShell.body.replaceChildren();
        const err = document.createElement('p');
        err.className = 'tasks-random__status tasks-random__status--err';
        err.textContent = String(e?.message || e || 'Could not pick a task.');
        const actions = document.createElement('div');
        actions.className = 'tasks-random__actions';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'tasks-random__secondary';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', cardShell.close);
        actions.append(closeBtn);
        cardShell.body.append(err, actions);
      }
    }

    void pickAndShow();
  }
}

/**
 * @param {{ root: HTMLElement, projects: Array<{ id: number, title: string }>, onMetaChange?: (meta: object) => void }} opts
 */
export async function openProjectLocationsTable(opts) {
  const { root, projects, onMetaChange } = opts;
  const { body, close } = makeModalShell(root, 'Project locations');

  const hint = document.createElement('p');
  hint.className = 'tasks-random__hint muted';
  hint.innerHTML =
    'Default location for tasks in each project (override per task in the list). Also editable in <code>data/task-project-locations.md</code>.';

  const docLink = document.createElement('a');
  docLink.className = 'tasks-random__doc-link';
  docLink.href = '/api/vikunja/project-locations-md';
  docLink.target = '_blank';
  docLink.rel = 'noopener noreferrer';
  docLink.textContent = 'Open markdown document';

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'tasks-random__secondary';
  syncBtn.textContent = 'Sync from Vikunja';

  const toolbar = document.createElement('div');
  toolbar.className = 'tasks-random__toolbar';
  toolbar.append(docLink, syncBtn);

  const scroll = document.createElement('div');
  scroll.className = 'tasks-random__table-scroll';

  const table = document.createElement('table');
  table.className = 'tasks-random__table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Project</th><th>Location</th></tr>';
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  scroll.append(table);

  const status = document.createElement('p');
  status.className = 'tasks-random__status';
  status.hidden = true;

  body.append(hint, toolbar, scroll, status);

  let meta = { byProjectId: {} };
  try {
    const r = await fetch('/api/vikunja/task-meta', { cache: 'no-store' });
    if (r.ok) meta = await r.json();
  } catch {
    /* ignore */
  }

  function renderRows() {
    tbody.replaceChildren();
    for (const p of projects) {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = p.title;
      const tdLoc = document.createElement('td');
      const sel = document.createElement('select');
      sel.className = 'tasks-random__select';
      for (const loc of LOCATIONS) {
        const opt = document.createElement('option');
        opt.value = loc.id;
        opt.textContent = loc.label;
        sel.append(opt);
      }
      const rowMeta = meta.byProjectId?.[String(p.id)] || {};
      sel.value = rowMeta.location || '';
      sel.addEventListener('change', async () => {
        tr.classList.add('tasks-random__row--saving');
        try {
          const r = await fetch(`/api/vikunja/projects/${encodeURIComponent(String(p.id))}/meta`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: sel.value || null }),
          });
          if (!r.ok) throw new Error('save_failed');
          const j = await r.json();
          meta = j.meta || meta;
          onMetaChange?.(meta);
          tr.classList.remove('tasks-random__row--saving');
          tr.classList.add('tasks-random__row--saved');
          setTimeout(() => tr.classList.remove('tasks-random__row--saved'), 800);
        } catch {
          tr.classList.remove('tasks-random__row--saving');
          status.hidden = false;
          status.textContent = `Could not save location for ${p.title}.`;
          status.classList.add('tasks-random__status--err');
        }
      });
      tdLoc.append(sel);
      tr.append(tdName, tdLoc);
      tbody.append(tr);
    }
  }

  renderRows();

  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      const r = await fetch('/api/vikunja/project-locations/sync', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'sync_failed');
      meta = j.meta || meta;
      onMetaChange?.(meta);
      renderRows();
      status.hidden = false;
      status.textContent = 'Synced project list to markdown.';
      status.classList.remove('tasks-random__status--err');
    } catch {
      status.hidden = false;
      status.textContent = 'Sync failed.';
      status.classList.add('tasks-random__status--err');
    } finally {
      syncBtn.disabled = false;
    }
  });
}

/**
 * "Waiting on" checkbox (task detail popup).
 * @param {{
 *   taskId: string,
 *   waitingOn?: boolean,
 *   wrapClass?: string,
 *   checkClass?: string,
 *   onMetaChange?: (meta: object) => void,
 * }} opts
 */
export function createWaitingOnControl(opts) {
  const {
    taskId,
    waitingOn = false,
    wrapClass = 'tasks-panel__waiting',
    checkClass = 'tasks-panel__waiting-check',
    onMetaChange,
  } = opts;

  const wrap = document.createElement('label');
  wrap.className = wrapClass;
  wrap.classList.toggle('is-waiting-on', !!waitingOn);
  wrap.title = 'Mark as waiting on something';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = checkClass;
  cb.checked = !!waitingOn;
  cb.setAttribute('aria-label', 'Waiting on');

  const text = document.createElement('span');
  text.className = 'tasks-waiting-label';
  text.textContent = 'Waiting on';

  wrap.append(cb, text);

  wrap.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  cb.addEventListener('change', () => {
    const next = cb.checked;
    cb.disabled = true;
    void patchTaskRandomMeta(taskId, { waitingOn: next })
      .then((meta) => {
        wrap.classList.toggle('is-waiting-on', next);
        onMetaChange?.(meta);
      })
      .catch(() => {
        cb.checked = !next;
      })
      .finally(() => {
        cb.disabled = false;
      });
  });

  return { wrap, checkbox: cb };
}

/**
 * @param {{
 *   item: { id: string, text: string, waitingNotes?: string },
 *   onMetaChange?: (meta: object) => void,
 *   onCleared?: () => void,
 * }} opts
 */
function renderWaitingOnItem(opts) {
  const { item, onMetaChange, onCleared } = opts;
  const row = document.createElement('div');
  row.className = 'tasks-waiting__item';

  const top = document.createElement('div');
  top.className = 'tasks-waiting__item-top';

  const title = document.createElement('p');
  title.className = 'tasks-waiting__item-title';
  fillLinkifiedText(title, item.text);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'tasks-random__secondary tasks-waiting__clear';
  clearBtn.textContent = 'Clear';
  clearBtn.title = 'Remove Waiting on';
  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      const meta = await patchTaskRandomMeta(item.id, { waitingOn: false });
      onMetaChange?.(meta);
      onCleared?.();
    } catch {
      clearBtn.disabled = false;
    }
  });

  top.append(title, clearBtn);

  const notes = document.createElement('textarea');
  notes.className = 'tasks-waiting__notes';
  notes.placeholder = 'What is this waiting on?';
  notes.rows = 2;
  notes.maxLength = 400;
  notes.value = item.waitingNotes || '';
  notes.setAttribute('aria-label', `Waiting notes for ${item.text}`);

  /** @type {ReturnType<typeof setTimeout> | null} */
  let saveTimer = null;
  notes.addEventListener('input', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void patchTaskRandomMeta(item.id, { waitingNotes: notes.value })
        .then((meta) => {
          onMetaChange?.(meta);
          row.classList.add('tasks-waiting__item--saved');
          setTimeout(() => row.classList.remove('tasks-waiting__item--saved'), 700);
        })
        .catch(() => {
          /* keep typed text; retry on next edit */
        });
    }, 400);
  });

  row.append(top, notes);
  return row;
}

/**
 * Pop-out of all tasks marked Waiting on, grouped by project, with notes.
 * @param {{ root: HTMLElement, onMetaChange?: (meta: object) => void }} opts
 */
export async function openWaitingOnList(opts) {
  const { root, onMetaChange } = opts;
  const shell = makeModalShell(root, 'Waiting on');
  shell.modal.classList.add('tasks-random__modal--waiting');

  const hint = document.createElement('p');
  hint.className = 'tasks-random__hint muted';
  hint.textContent =
    'Tasks marked Waiting on, grouped by project. Add a note for what each is blocked on.';

  const list = document.createElement('div');
  list.className = 'tasks-waiting__list';

  const status = document.createElement('p');
  status.className = 'tasks-random__status';
  status.hidden = true;

  shell.body.append(hint, list, status);

  async function load() {
    list.replaceChildren();
    status.hidden = false;
    status.classList.remove('tasks-random__status--err');
    status.textContent = 'Loading…';
    try {
      const r = await fetch('/api/vikunja/todos/waiting', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || j.error || 'load_failed');
      status.hidden = true;
      const groups = Array.isArray(j.groups) ? j.groups : [];
      if (!groups.length) {
        const empty = document.createElement('p');
        empty.className = 'tasks-random__hint muted';
        empty.textContent = 'No tasks marked Waiting on.';
        list.append(empty);
        return;
      }
      for (const group of groups) {
        const section = document.createElement('section');
        section.className = 'tasks-waiting__group';
        const h = document.createElement('h3');
        h.className = 'tasks-waiting__group-title';
        h.textContent = group.projectTitle || 'Other';
        section.append(h);
        for (const item of group.items || []) {
          section.append(
            renderWaitingOnItem({
              item,
              onMetaChange,
              onCleared: () => {
                void load();
              },
            }),
          );
        }
        list.append(section);
      }
    } catch (e) {
      status.hidden = false;
      status.classList.add('tasks-random__status--err');
      status.textContent = String(e?.message || e || 'Could not load waiting list.');
    }
  }

  await load();
}

/**
 * @param {string | null | undefined} iso
 */
function formatArchivedWhen(iso) {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const delta = Date.now() - ms;
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.max(1, Math.round(delta / 3_600_000))}h ago`;
  const days = Math.max(1, Math.round(delta / 86_400_000));
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/**
 * Last 20 completed tasks, with Unarchive to restore them to their project.
 * @param {{
 *   root: HTMLElement,
 *   onUnarchive?: (item: { id: string, text: string, projectId: number | null }) => void,
 * }} opts
 */
export async function openRecentlyArchivedTasks(opts) {
  const { root, onUnarchive } = opts;
  const shell = makeModalShell(root, 'Recently archived tasks');
  shell.modal.classList.add('tasks-random__modal--waiting');

  const hint = document.createElement('p');
  hint.className = 'tasks-random__hint muted';
  hint.textContent = 'Last 20 completed tasks. Unarchive restores a task to its project.';

  const list = document.createElement('div');
  list.className = 'tasks-archived__list';

  const status = document.createElement('p');
  status.className = 'tasks-random__status';
  status.hidden = true;

  shell.body.append(hint, list, status);

  /**
   * @param {{ id: string, text: string, projectId: number | null, projectTitle?: string, archivedAt?: string | null }} item
   */
  function renderItem(item) {
    const row = document.createElement('div');
    row.className = 'tasks-archived__item';

    const main = document.createElement('div');
    main.className = 'tasks-archived__main';
    const title = document.createElement('div');
    title.className = 'tasks-archived__title';
    fillLinkifiedText(title, item.text);
    const meta = document.createElement('div');
    meta.className = 'tasks-archived__meta muted';
    const when = formatArchivedWhen(item.archivedAt);
    meta.textContent = [item.projectTitle, when].filter(Boolean).join(' · ');
    main.append(title, meta);

    const unarchive = document.createElement('button');
    unarchive.type = 'button';
    unarchive.className = 'tasks-archived__unarchive';
    unarchive.textContent = 'Unarchive';
    unarchive.addEventListener('click', async () => {
      unarchive.disabled = true;
      try {
        const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(item.id)}/undo`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            item.projectId != null ? { projectId: item.projectId } : {},
          ),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error(j.detail || j.error || 'unarchive_failed');
        onUnarchive?.(j.item || item);
        row.remove();
        if (!list.querySelector('.tasks-archived__item')) {
          const empty = document.createElement('p');
          empty.className = 'tasks-random__hint muted';
          empty.textContent = 'No recently archived tasks.';
          list.replaceChildren(empty);
        }
      } catch {
        unarchive.disabled = false;
        status.hidden = false;
        status.classList.add('tasks-random__status--err');
        status.textContent = 'Could not unarchive task.';
      }
    });

    row.append(main, unarchive);
    return row;
  }

  async function load() {
    list.replaceChildren();
    status.hidden = false;
    status.classList.remove('tasks-random__status--err');
    status.textContent = 'Loading…';
    try {
      const r = await fetch('/api/vikunja/todos/archived', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.detail || j.error || 'load_failed');
      status.hidden = true;
      const items = Array.isArray(j.items) ? j.items : [];
      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'tasks-random__hint muted';
        empty.textContent = 'No recently archived tasks.';
        list.append(empty);
        return;
      }
      for (const item of items) {
        list.append(renderItem(item));
      }
    } catch (e) {
      status.hidden = false;
      status.classList.add('tasks-random__status--err');
      status.textContent = String(e?.message || e || 'Could not load archived tasks.');
    }
  }

  await load();
}

export { DIFFICULTY_LABELS, DURATION_LABELS, LOCATION_LABELS, TIME_LABELS };
