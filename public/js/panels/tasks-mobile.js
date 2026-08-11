import {
  openRandomTaskPicker,
  openProjectLocationsTable,
  openTaskTagsEditor,
  openWaitingOnList,
  openRecentlyArchivedTasks,
  createWaitingOnControl,
} from '../lib/task-random-ui.js';
import { fetchTaskRandomMeta } from '../lib/task-location-meta.js';
import {
  clearTaskSchedule,
  createScheduleControl,
  ensureOverduePriority,
  scheduleTaskToCalendar,
} from '../lib/task-schedule.js';
import {
  CONTACT_TASKS_PROJECT_TITLE,
  notifyContactTaskDone,
  onContactTasksChanged,
} from '../lib/task-bridge.js';
import {
  pushMobileNav,
  mobileNavBack,
  isMobileNavApplying,
} from '../lib/mobile-history.js';

/**
 * Mobile Vikunja Tasks: project list → task detail (add / complete).
 * @param {HTMLElement | null} root
 * @param {{ vikunjaPublicUrl?: string, vikunjaConfigured?: boolean }} [config]
 */
import { fillLinkifiedText } from '../lib/linkify-text.js';
import { TASKS_LABELS } from '../lib/network-labels.js';

const PROJECT_LS_KEY = 'dashbird-tasks-project-id';
const DONE_HIDE_MS = 3000;
const PTR_THRESHOLD = 70;
const PTR_MAX = 100;
const DND_PROJECT_MIME = 'application/x-dashbird-project-id';
const DND_TASK_MIME = 'application/x-dashbird-task-id';
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;

/**
 * @param {string} className
 * @param {string} title
 */
function makeDragHandle(className, title) {
  const handle = document.createElement('span');
  handle.className = className;
  handle.setAttribute('aria-hidden', 'true');
  handle.title = title;
  const grip = document.createElement('span');
  grip.className = 'tasks-panel__grip';
  handle.append(grip);
  return handle;
}

/**
 * Long-press on a task row opens rename + move-to-project picker.
 * @param {HTMLElement} el
 * @param {string} taskId
 * @param {() => void} onLongPress
 */
function attachTaskLongPress(el, taskId, onLongPress) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let startX = 0;
  let startY = 0;
  let triggered = false;

  const clearTimer = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    el.classList.remove('mobile-tasks__task--press-hold');
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.mobile-tasks__task-drag')) return;
    if (e.target.closest('.mobile-tasks__check')) return;
    triggered = false;
    startX = e.clientX;
    startY = e.clientY;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      triggered = true;
      el.classList.add('mobile-tasks__task--press-hold');
      if (typeof navigator.vibrate === 'function') navigator.vibrate(20);
      onLongPress();
    }, LONG_PRESS_MS);
  });

  el.addEventListener('pointermove', (e) => {
    if (timer == null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_PX) clearTimer();
  });

  el.addEventListener('pointerup', clearTimer);
  el.addEventListener('pointercancel', clearTimer);
  el.addEventListener('lostpointercapture', clearTimer);

  el.addEventListener(
    'click',
    (e) => {
      if (!triggered) return;
      triggered = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}

/**
 * Midpoint position between neighbors (same as desktop Tasks panel).
 * @param {number | null | undefined} before
 * @param {number | null | undefined} after
 */
function positionBetween(before, after) {
  if (before == null && after == null) return 65536;
  if (before == null) return Math.max(1, Number(after) / 2);
  if (after == null) return Number(before) + 65536;
  const b = Number(before);
  const a = Number(after);
  if (a - b > 2) return (a + b) / 2;
  return b + 1;
}

/**
 * Touch pull-to-refresh on a scroll container.
 * @param {HTMLElement} scrollEl
 * @param {() => Promise<void>} onRefresh
 */
function attachPullToRefresh(scrollEl, onRefresh) {
  let startY = 0;
  let pullPx = 0;
  let tracking = false;
  let refreshing = false;

  const ptr = document.createElement('div');
  ptr.className = 'mobile-tasks__ptr';
  ptr.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'mobile-tasks__ptr-label';
  label.textContent = 'Pull to refresh';
  ptr.append(label);
  scrollEl.insertBefore(ptr, scrollEl.firstChild);

  function atTop() {
    return scrollEl.scrollTop <= 1;
  }

  function applyHeight(h) {
    pullPx = Math.min(Math.max(h, 0), PTR_MAX);
    ptr.style.height = `${pullPx}px`;
    ptr.classList.toggle('mobile-tasks__ptr--ready', pullPx >= PTR_THRESHOLD);
    ptr.classList.toggle('mobile-tasks__ptr--pulling', pullPx > 0);
  }

  function reset() {
    tracking = false;
    pullPx = 0;
    ptr.style.height = '';
    ptr.classList.remove(
      'mobile-tasks__ptr--ready',
      'mobile-tasks__ptr--pulling',
      'mobile-tasks__ptr--loading',
    );
  }

  scrollEl.addEventListener(
    'touchstart',
    (e) => {
      if (refreshing || e.touches.length !== 1) return;
      if (!atTop()) return;
      startY = e.touches[0].clientY;
      tracking = true;
    },
    { passive: true },
  );

  scrollEl.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking || refreshing) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 0 && atTop()) {
        applyHeight(dy * 0.5);
        if (pullPx > 8) e.preventDefault();
      } else {
        tracking = false;
        applyHeight(0);
      }
    },
    { passive: false },
  );

  const end = async () => {
    if (refreshing) return;
    const shouldRefresh = tracking && pullPx >= PTR_THRESHOLD;
    tracking = false;
    if (!shouldRefresh) {
      reset();
      return;
    }
    refreshing = true;
    ptr.classList.add('mobile-tasks__ptr--loading');
    ptr.classList.remove('mobile-tasks__ptr--ready');
    label.textContent = 'Refreshing…';
    applyHeight(PTR_THRESHOLD * 0.85);
    try {
      await onRefresh();
    } finally {
      refreshing = false;
      label.textContent = 'Pull to refresh';
      reset();
    }
  };

  scrollEl.addEventListener('touchend', () => void end(), { passive: true });
  scrollEl.addEventListener(
    'touchcancel',
    () => {
      if (!refreshing) reset();
    },
    { passive: true },
  );
}

/**
 * @returns {number | null}
 */
function readSavedProjectId() {
  try {
    const n = Number(localStorage.getItem(PROJECT_LS_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * @param {number | null} id
 */
function saveProjectId(id) {
  try {
    if (id != null) localStorage.setItem(PROJECT_LS_KEY, String(id));
  } catch {
    /* ignore */
  }
}

/**
 * @param {HTMLElement | null} root
 * @param {{ vikunjaPublicUrl?: string, vikunjaConfigured?: boolean }} [config]
 */
export function mountTasksMobile(root, config = {}) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('mobile-tasks');

  const listPane = document.createElement('div');
  listPane.className = 'mobile-tasks__list-pane';

  const listHead = document.createElement('div');
  listHead.className = 'mobile-tasks__list-head';
  const listTitle = document.createElement('h2');
  listTitle.className = 'mobile-tasks__title';
  listTitle.textContent = 'Projects';
  const listHeadActions = document.createElement('div');
  listHeadActions.className = 'mobile-tasks__head-actions';
  const randomBtn = document.createElement('button');
  randomBtn.type = 'button';
  randomBtn.className = 'mobile-tasks__header-btn';
  randomBtn.textContent = TASKS_LABELS.random;

  const waitingOnBtn = document.createElement('button');
  waitingOnBtn.type = 'button';
  waitingOnBtn.className = 'mobile-tasks__header-btn';
  waitingOnBtn.textContent = TASKS_LABELS.waitingOn;

  listHeadActions.append(waitingOnBtn, randomBtn);

  const vikunjaConfigured = config.vikunjaConfigured !== false;
  if (!vikunjaConfigured) {
    randomBtn.hidden = true;
    waitingOnBtn.hidden = true;
  }
  listHead.append(listTitle, listHeadActions);

  const projectsList = document.createElement('ul');
  projectsList.className = 'mobile-tasks__projects';
  projectsList.setAttribute('role', 'list');

  const addProjectForm = document.createElement('form');
  addProjectForm.className = 'mobile-tasks__add';
  addProjectForm.setAttribute('aria-label', 'Add a project');
  const addProjectInput = document.createElement('input');
  addProjectInput.type = 'text';
  addProjectInput.className = 'mobile-tasks__input';
  addProjectInput.placeholder = 'New project…';
  addProjectInput.maxLength = 120;
  addProjectInput.autocomplete = 'off';
  const addProjectBtn = document.createElement('button');
  addProjectBtn.type = 'submit';
  addProjectBtn.className = 'mobile-tasks__add-btn';
  addProjectBtn.textContent = 'Add';
  addProjectForm.append(addProjectInput, addProjectBtn);

  const locationsBtn = document.createElement('button');
  locationsBtn.type = 'button';
  locationsBtn.className = 'mobile-tasks__list-locations';
  locationsBtn.textContent = 'Locations';
  if (!vikunjaConfigured) locationsBtn.hidden = true;

  const archivedBtn = document.createElement('button');
  archivedBtn.type = 'button';
  archivedBtn.className = 'mobile-tasks__archived-btn';
  archivedBtn.textContent = TASKS_LABELS.recentlyArchived;
  if (!vikunjaConfigured) archivedBtn.hidden = true;

  listPane.append(listHead, projectsList, locationsBtn, addProjectForm, archivedBtn);

  const detailPane = document.createElement('div');
  detailPane.className = 'mobile-tasks__detail-pane';
  detailPane.hidden = true;

  const status = document.createElement('p');
  status.className = 'mobile-tasks__status';
  status.textContent = 'Loading…';

  root.append(status, listPane, detailPane);

  const moveOverlay = document.createElement('div');
  moveOverlay.className = 'mobile-tasks__move-overlay';
  moveOverlay.hidden = true;
  const moveRenameLabel = document.createElement('label');
  moveRenameLabel.className = 'mobile-tasks__move-rename-label';
  const moveRenameText = document.createElement('span');
  moveRenameText.className = 'mobile-tasks__move-title';
  moveRenameText.textContent = 'Task name';
  const moveRenameInput = document.createElement('input');
  moveRenameInput.type = 'text';
  moveRenameInput.className = 'mobile-tasks__input mobile-tasks__move-rename';
  moveRenameInput.maxLength = 280;
  moveRenameInput.autocomplete = 'off';
  moveRenameInput.enterKeyHint = 'done';
  moveRenameInput.setAttribute('aria-label', 'Task name');
  moveRenameLabel.append(moveRenameText, moveRenameInput);

  const moveProjectLabel = document.createElement('label');
  moveProjectLabel.className = 'mobile-tasks__move-rename-label';
  const moveProjectText = document.createElement('span');
  moveProjectText.className = 'mobile-tasks__move-title';
  moveProjectText.textContent = 'Project';
  const moveProjectSelect = document.createElement('select');
  moveProjectSelect.className = 'mobile-tasks__input mobile-tasks__move-select';
  moveProjectSelect.setAttribute('aria-label', 'Move to project');
  moveProjectLabel.append(moveProjectText, moveProjectSelect);

  const moveTagsChips = document.createElement('div');
  const moveTagInput = document.createElement('input');
  moveTagInput.type = 'text';
  const moveTagList = document.createElement('datalist');
  moveTagList.id = 'mobile-tasks-tag-options';
  const moveTagAddBtn = document.createElement('button');
  moveTagAddBtn.type = 'button';

  const moveScheduleSlot = document.createElement('div');
  moveScheduleSlot.className = 'mobile-tasks__move-schedule';
  const moveWaitingSlot = document.createElement('div');
  moveWaitingSlot.className = 'mobile-tasks__move-waiting';

  const moveEditTagsBtn = document.createElement('button');
  moveEditTagsBtn.type = 'button';
  moveEditTagsBtn.className = 'mobile-tasks__move-edit-tags';
  moveEditTagsBtn.textContent = 'Edit labels';

  const moveActions = document.createElement('div');
  moveActions.className = 'mobile-tasks__move-actions';
  const moveSave = document.createElement('button');
  moveSave.type = 'button';
  moveSave.className = 'mobile-tasks__add-btn mobile-tasks__move-save';
  moveSave.textContent = 'Save';
  const moveCancel = document.createElement('button');
  moveCancel.type = 'button';
  moveCancel.className = 'mobile-tasks__move-cancel';
  moveCancel.textContent = 'Cancel';
  moveActions.append(moveSave, moveCancel);

  moveOverlay.append(
    moveRenameLabel,
    moveProjectLabel,
    moveScheduleSlot,
    moveWaitingSlot,
    moveEditTagsBtn,
    moveActions,
  );
  root.append(moveOverlay);

  /** @type {Array<{ id: number, title: string, position?: number }>} */
  let projects = [];
  /** @type {Array<{ id: string, text: string, done: boolean }>} */
  let items = [];
  /** @type {number | null} */
  let projectId = null;
  let canWrite = false;
  /** @type {'list' | 'detail'} */
  let view = 'list';
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pendingDone = new Map();
  /** @type {{ byTaskId: Record<string, unknown>, byProjectId: Record<string, unknown> }} */
  let taskRandomMeta = { byTaskId: {}, byProjectId: {} };

  async function refreshTaskRandomMeta() {
    taskRandomMeta = await fetchTaskRandomMeta(taskRandomMeta);
    if (view === 'detail' && projectId != null && items.length) renderDetailShell();
  }

  let listRefreshing = false;
  let detailRefreshing = false;
  /** @type {number | null} */
  let draggingProjectId = null;
  let projectDragMoved = false;
  /** @type {number | null} */
  let projectPointerId = null;
  /** @type {string | null} */
  let editTaskId = null;
  /** @type {Array<{ id: number, title: string }>} */
  let allLabels = [];
  let allLabelsLoaded = false;
  /** @type {Array<{ id: number, title: string }>} */
  let editLabels = [];
  /** @type {Array<{ id: number, title: string }>} */
  let editLabelsOriginal = [];


  function highlightTaskFromRandom(task) {
    const pid = task.projectId != null ? Number(task.projectId) : projectId;
    const go = async () => {
      const listEl = detailPane.querySelector('.mobile-tasks__list');
      const el = listEl?.querySelector(`.mobile-tasks__item[data-id="${CSS.escape(String(task.id))}"]`);
      if (el) {
        el.classList.add('mobile-tasks__item--random-pick');
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setTimeout(() => el.classList.remove('mobile-tasks__item--random-pick'), 4000);
      }
    };
    if (pid != null && pid !== projectId) {
      void openProject(pid).then(go);
    } else {
      void go();
    }
  }

  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg;
    status.classList.toggle('mobile-tasks__status--err', Boolean(isErr));
  }

  function clearPending(id) {
    const t = pendingDone.get(id);
    if (t != null) {
      clearTimeout(t);
      pendingDone.delete(id);
    }
  }

  function clearAllPending() {
    for (const t of pendingDone.values()) clearTimeout(t);
    pendingDone.clear();
  }

  function projectTitle(id) {
    return projects.find((p) => p.id === id)?.title || 'Project';
  }

  function sortProjectsInPlace() {
    projects.sort(
      (a, b) =>
        (a.position ?? a.id) - (b.position ?? b.id) ||
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
    );
  }

  function clearProjectDropIndicators() {
    projectsList
      .querySelectorAll(
        '.mobile-tasks__project--reorder-before, .mobile-tasks__project--reorder-after, .mobile-tasks__project--drop',
      )
      .forEach((el) => {
        el.classList.remove(
          'mobile-tasks__project--reorder-before',
          'mobile-tasks__project--reorder-after',
          'mobile-tasks__project--drop',
        );
      });
  }

  /**
   * @param {number} movedId
   */
  async function persistMovedProject(movedId) {
    const idx = projects.findIndex((p) => p.id === movedId);
    if (idx < 0) return;
    const before = idx > 0 ? projects[idx - 1].position : null;
    const after = idx < projects.length - 1 ? projects[idx + 1].position : null;
    const needsRebalance =
      before != null && after != null && Number(after) - Number(before) <= 2;

    if (needsRebalance) {
      projects = projects.map((p, i) => ({ ...p, position: (i + 1) * 65536 }));
      void fetch('/api/vikunja/projects/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: projects.map((p) => p.id) }),
      }).catch(() => {});
      return;
    }

    const position = positionBetween(before, after);
    projects[idx] = { ...projects[idx], position };
    try {
      const r = await fetch(`/api/vikunja/projects/${encodeURIComponent(String(movedId))}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      showStatus('Could not save project order.', true);
    }
  }

  /**
   * @param {number} fromId
   * @param {number} toId
   * @param {'before' | 'after'} place
   */
  function reorderProjectLocal(fromId, toId, place) {
    if (fromId === toId) return;
    const fromIdx = projects.findIndex((p) => p.id === fromId);
    const toIdx = projects.findIndex((p) => p.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = projects.slice();
    const [moved] = next.splice(fromIdx, 1);
    let insertAt = next.findIndex((p) => p.id === toId);
    if (insertAt < 0) return;
    if (place === 'after') insertAt += 1;
    next.splice(insertAt, 0, moved);
    projects = next;
    renderProjects();
    void persistMovedProject(fromId);
  }

  /**
   * @param {string} taskId
   * @param {number} targetProjectId
   */
  async function moveTask(taskId, targetProjectId) {
    if (targetProjectId === projectId) return;
    const prev = items.slice();
    items = items.filter((it) => it.id !== taskId);
    clearPending(taskId);
    renderDetailShell();

    try {
      const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(taskId)}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: targetProjectId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      showStatus('');
    } catch {
      items = prev;
      renderDetailShell();
      showStatus('Could not move task.', true);
    }
  }

  /**
   * @param {string} taskId
   * @param {string} text
   */
  async function renameTask(taskId, text) {
    const next = text.trim();
    if (!next) return false;
    const prev = items.find((it) => it.id === taskId)?.text;
    if (prev === next) return true;
    updateTaskTextLocally(taskId, next);
    try {
      const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      showStatus('');
      return true;
    } catch {
      if (prev != null) updateTaskTextLocally(taskId, prev);
      showStatus('Could not rename task.', true);
      return false;
    }
  }

  async function loadAllLabels() {
    if (allLabelsLoaded) {
      renderTagOptions();
      return;
    }
    try {
      const r = await fetch('/api/vikunja/labels?per_page=100', { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!Array.isArray(j)) return;
      allLabels = j
        .map((l) => ({ id: Number(l?.id), title: String(l?.title || '').trim() }))
        .filter((l) => Number.isFinite(l.id) && l.id > 0 && l.title);
      allLabelsLoaded = true;
      renderTagOptions();
    } catch {
      /* ignore */
    }
  }

  function renderTagOptions() {
    moveTagList.replaceChildren();
    for (const l of allLabels) {
      const opt = document.createElement('option');
      opt.value = l.title;
      moveTagList.append(opt);
    }
  }

  /**
   * @param {string} taskId
   */
  async function loadTaskLabels(taskId) {
    try {
      const r = await fetch(`/api/vikunja/tasks/${encodeURIComponent(taskId)}`, {
        cache: 'no-store',
      });
      const j = await r.json().catch(() => null);
      if (editTaskId !== taskId) return;
      const labels = Array.isArray(j?.labels) ? j.labels : [];
      editLabels = labels
        .map((l) => ({ id: Number(l?.id), title: String(l?.title || '').trim() }))
        .filter((l) => Number.isFinite(l.id) && l.id > 0 && l.title);
      editLabelsOriginal = editLabels.slice();
      renderMoveTagChips();
    } catch {
      /* ignore */
    }
  }

  function renderMoveTagChips() {
    moveTagsChips.replaceChildren();
    if (!editLabels.length) {
      const empty = document.createElement('span');
      empty.className = 'mobile-tasks__move-empty muted';
      empty.textContent = 'No labels.';
      moveTagsChips.append(empty);
      return;
    }
    for (const l of editLabels) {
      const chip = document.createElement('span');
      chip.className = 'mobile-tasks__tag-chip';
      chip.style.cssText =
        'display:inline-flex;align-items:center;gap:0.3rem;padding:0.25rem 0.5rem;border-radius:999px;border:1px solid rgba(120,150,200,0.35);background:rgba(110,181,255,0.12);font-size:0.85em;';
      const name = document.createElement('span');
      name.className = 'mobile-tasks__tag-chip-text';
      name.textContent = l.title;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mobile-tasks__tag-chip-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${l.title}`);
      remove.style.cssText =
        'font:inherit;line-height:1;padding:0;border:0;background:none;color:inherit;cursor:pointer;';
      remove.addEventListener('click', () => {
        editLabels = editLabels.filter((x) => x.id !== l.id);
        renderMoveTagChips();
      });
      chip.append(name, remove);
      moveTagsChips.append(chip);
    }
  }

  function addTagFromInput() {
    const raw = moveTagInput.value.trim();
    if (!raw) return;
    const existing = allLabels.find((l) => l.title.toLowerCase() === raw.toLowerCase());
    if (existing) {
      if (!editLabels.some((l) => l.id === existing.id)) editLabels = [...editLabels, existing];
    } else if (!editLabels.some((l) => l.title.toLowerCase() === raw.toLowerCase())) {
      editLabels = [...editLabels, { id: -Date.now(), title: raw }];
    }
    moveTagInput.value = '';
    renderMoveTagChips();
  }

  /**
   * @param {string} title
   * @returns {Promise<{ id: number, title: string } | null>}
   */
  async function createLabel(title) {
    try {
      const r = await fetch('/api/vikunja/labels', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.id) return null;
      const created = { id: Number(j.id), title: String(j.title || title).trim() };
      allLabels = [...allLabels, created];
      renderTagOptions();
      return created;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} taskId
   */
  async function syncTaskLabels(taskId) {
    const toRemove = editLabelsOriginal.filter((o) => !editLabels.some((e) => e.id === o.id));
    const toAdd = editLabels.filter((e) => !editLabelsOriginal.some((o) => o.id === e.id));
    for (const l of toRemove) {
      await fetch(`/api/vikunja/tasks/${encodeURIComponent(taskId)}/labels/${l.id}`, {
        method: 'DELETE',
      });
    }
    for (const l of toAdd) {
      let labelId = l.id;
      if (labelId < 0) {
        const created = await createLabel(l.title);
        if (!created) continue;
        labelId = created.id;
      }
      await fetch(`/api/vikunja/tasks/${encodeURIComponent(taskId)}/labels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label_id: labelId }),
      });
    }
    editLabelsOriginal = editLabels.slice();
  }

  async function saveTaskEdits() {
    const taskId = editTaskId;
    if (!taskId) return;
    const targetProjectId = Number(moveProjectSelect.value);

    const nextText = moveRenameInput.value.trim();
    const prevText = items.find((it) => it.id === taskId)?.text || '';
    if (nextText && nextText !== prevText) {
      if (!(await renameTask(taskId, nextText))) return;
    }

    try {
      await syncTaskLabels(taskId);
    } catch {
      showStatus('Could not update labels.', true);
    }

    if (
      Number.isFinite(targetProjectId) &&
      targetProjectId > 0 &&
      targetProjectId !== projectId
    ) {
      hideMoveOverlay();
      void moveTask(taskId, targetProjectId);
      return;
    }
    hideMoveOverlay();
  }

  /**
   * @param {string} taskId
   */
  function openEditTagsForTask(taskId) {
    const task = items.find((it) => it.id === taskId);
    const pid = projectId;
    openTaskTagsEditor({
      root,
      taskId,
      taskText: task?.text || '',
      projectId: pid,
      taskMeta: taskRandomMeta.byTaskId?.[String(taskId)] || null,
      projectMeta: pid != null ? taskRandomMeta.byProjectId?.[String(pid)] || null : null,
      onMetaChange: (meta) => {
        taskRandomMeta = meta;
      },
    });
  }

  /**
   * @param {string} taskId
   */
  function showMoveOverlay(taskId) {
    const task = items.find((it) => it.id === taskId);
    editTaskId = taskId;
    moveRenameInput.value = task?.text || '';

    moveProjectSelect.replaceChildren();
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.title;
      if (p.id === projectId) opt.selected = true;
      moveProjectSelect.append(opt);
    }

    editLabels = [];
    editLabelsOriginal = [];
    moveTagInput.value = '';
    renderMoveTagChips();
    void loadAllLabels();
    void loadTaskLabels(taskId);

    moveEditTagsBtn.onclick = () => openEditTagsForTask(taskId);

    const taskMeta = taskRandomMeta.byTaskId?.[String(taskId)] || null;
    moveScheduleSlot.replaceChildren();
    moveWaitingSlot.replaceChildren();
    const sched = createScheduleControl({
      wrapClass: 'task-schedule mobile-tasks__move-schedule-wrap',
      buttonClass: 'mobile-tasks__schedule mobile-tasks__move-schedule-btn',
      overdueClass: 'task-schedule__overdue',
    });
    sched.sync(taskMeta);
    sched.button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      sched.button.disabled = true;
      try {
        const title =
          moveRenameInput.value.trim() ||
          items.find((it) => it.id === taskId)?.text ||
          '';
        const currentMeta = taskRandomMeta.byTaskId?.[String(taskId)] || null;
        const { meta, row: nextMeta } = await scheduleTaskToCalendar(
          taskId,
          title,
          currentMeta,
        );
        taskRandomMeta = meta;
        sched.sync(nextMeta);
      } catch {
        showStatus('Could not save schedule.', true);
      } finally {
        sched.button.disabled = false;
      }
    });
    moveScheduleSlot.append(sched.wrap);
    const waiting = createWaitingOnControl({
      taskId,
      waitingOn: taskMeta?.waitingOn === true,
      wrapClass: 'mobile-tasks__waiting mobile-tasks__move-waiting-control',
      checkClass: 'mobile-tasks__waiting-check',
      onMetaChange: (meta) => {
        taskRandomMeta = meta;
      },
    });
    moveWaitingSlot.append(waiting.wrap);
    void ensureOverduePriority(taskId, taskMeta).then((res) => {
      if (!res || editTaskId !== taskId) return;
      taskRandomMeta = res.meta;
      sched.sync(res.row);
    });

    moveOverlay.hidden = false;
    root.classList.add('mobile-tasks--moving');
    if (!isMobileNavApplying() && projectId != null) {
      pushMobileNav({
        tab: 'tasks',
        pane: 'project',
        projectId,
        overlay: 'task-move',
      });
    }
    queueMicrotask(() => {
      moveRenameInput.focus();
      moveRenameInput.select();
    });
  }

  function hideMoveOverlay(fromPop = false) {
    moveOverlay.hidden = true;
    editTaskId = null;
    root.classList.remove('mobile-tasks--moving');
    if (!fromPop && history.state?.overlay === 'task-move') mobileNavBack();
  }

  function showList() {
    view = 'list';
    projectId = null;
    clearAllPending();
    items = [];
    hideMoveOverlay();
    detailPane.hidden = true;
    detailPane.replaceChildren();
    listPane.hidden = false;
    renderProjects();
  }

  /**
   * @param {number} id
   * @param {{ fromHistory?: boolean }} [opts]
   */
  async function openProject(id, opts = {}) {
    view = 'detail';
    projectId = id;
    saveProjectId(id);
    listPane.hidden = true;
    detailPane.hidden = false;
    clearAllPending();
    items = [];
    canWrite = false;
    renderDetailShell('Loading…');
    showStatus('');
    if (!opts.fromHistory && !isMobileNavApplying()) {
      pushMobileNav({ tab: 'tasks', pane: 'project', projectId: id });
    }
    await loadTodos();
  }

  async function deleteProject(id) {
    const idx = projects.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const removed = projects[idx];
    const wasSelected = projectId === id;

    // Remove from the list immediately; revert only if the server delete fails.
    projects = projects.filter((p) => p.id !== id);
    try {
      if (readSavedProjectId() === id) localStorage.removeItem(PROJECT_LS_KEY);
    } catch {
      /* ignore */
    }
    if (wasSelected) {
      showList();
    } else {
      renderProjects();
    }
    if (
      history.state?.dashbirdMobile &&
      history.state.tab === 'tasks' &&
      history.state.pane === 'project' &&
      history.state.projectId === id
    ) {
      history.replaceState(
        /** @type {import('../lib/mobile-history.js').MobileNavState} */ ({
          dashbirdMobile: true,
          tab: 'tasks',
          pane: 'list',
        }),
        '',
      );
    }
    showStatus('');

    try {
      const r = await fetch(`/api/vikunja/projects/${encodeURIComponent(String(id))}`, {
        method: 'DELETE',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) {
        const err =
          j.error === 'archive_project_protected'
            ? 'The Archive project cannot be deleted.'
            : j.error === 'default_project_protected'
              ? 'This is your Vikunja default project and there is no other project to switch to.'
              : j.error === 'not_found'
                ? 'Project not found.'
                : j.error === 'vikunja_upstream' &&
                    /invalid token provided/i.test(String(j.detail || ''))
                  ? 'Vikunja API token cannot delete projects — add projects.delete to the token in Vikunja settings.'
                  : j.detail || j.error || `HTTP ${r.status}`;
        throw new Error(err);
      }
    } catch (e) {
      // Restore the row so the list stays in sync with Vikunja.
      projects.push(removed);
      sortProjectsInPlace();
      renderProjects();
      showStatus(`Could not delete project: ${e?.message || e}`, true);
    }
  }

  /**
   * @param {number} id
   * @param {string} title
   */
  async function renameProject(id, title) {
    const idx = projects.findIndex((p) => p.id === id);
    const prevTitle = idx >= 0 ? projects[idx].title : '';
    if (idx >= 0) projects[idx] = { ...projects[idx], title };
    renderProjects();
    const head = detailPane.querySelector('.mobile-tasks__detail-title');
    if (projectId === id && head) head.textContent = title;

    try {
      const r = await fetch(`/api/vikunja/projects/${encodeURIComponent(String(id))}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false || !j.project) throw new Error(j.error || `HTTP ${r.status}`);
      const i = projects.findIndex((p) => p.id === id);
      if (i >= 0) {
        projects[i] = {
          id: j.project.id,
          title: j.project.title,
          position: Number(j.project.position) || projects[i].position || id,
        };
      }
      renderProjects();
      const nextHead = detailPane.querySelector('.mobile-tasks__detail-title');
      if (projectId === id && nextHead) nextHead.textContent = projectTitle(id);
      showStatus('');
      return true;
    } catch {
      if (idx >= 0) projects[idx] = { ...projects[idx], title: prevTitle };
      renderProjects();
      const revertHead = detailPane.querySelector('.mobile-tasks__detail-title');
      if (projectId === id && revertHead) revertHead.textContent = prevTitle;
      showStatus('Could not rename project.', true);
      return false;
    }
  }

  function beginMobileProjectRename() {
    if (projectId == null) return;
    const head = detailPane.querySelector('.mobile-tasks__detail-title');
    if (!(head instanceof HTMLElement)) return;
    const id = projectId;
    const prev = projectTitle(id);

    const form = document.createElement('form');
    form.className = 'mobile-tasks__rename-form';
    form.setAttribute('aria-label', 'Rename project');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mobile-tasks__input mobile-tasks__detail-rename';
    input.value = prev;
    input.maxLength = 120;
    input.autocomplete = 'off';
    input.enterKeyHint = 'done';
    input.setAttribute('aria-label', 'Project name');

    form.append(input);
    head.replaceWith(form);
    input.focus();
    input.select();

    let committed = false;
    const finish = (save) => {
      if (committed) return;
      committed = true;
      const next = input.value.trim();
      const restore = (title) => {
        const h2 = document.createElement('h2');
        h2.className = 'mobile-tasks__detail-title';
        h2.textContent = title;
        if (form.isConnected) form.replaceWith(h2);
      };
      if (save && next && next !== prev) {
        void renameProject(id, next).then((ok) => {
          restore(ok ? next : prev);
        });
      } else {
        restore(prev);
      }
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(true);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function deleteCurrentProject() {
    if (projectId == null) return;
    await deleteProject(projectId);
  }

  /**
   * @param {string} [emptyMsg]
   */
  function renderDetailShell(emptyMsg) {
    detailPane.replaceChildren();

    const detailHead = document.createElement('div');
    detailHead.className = 'mobile-tasks__detail-head';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mobile-tasks__back';
    back.textContent = '← Projects';
    back.addEventListener('click', () => {
      if (!moveOverlay.hidden) {
        hideMoveOverlay();
        return;
      }
      mobileNavBack();
    });

    detailHead.append(back);

    const head = document.createElement('h2');
    head.className = 'mobile-tasks__detail-title';
    head.textContent = projectId != null ? projectTitle(projectId) : 'Project';

    const addForm = document.createElement('form');
    addForm.className = 'mobile-tasks__add';
    addForm.setAttribute('aria-label', 'Add a task');
    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.className = 'mobile-tasks__input';
    addInput.placeholder = 'Add a task…';
    addInput.maxLength = 280;
    addInput.autocomplete = 'off';
    addInput.disabled = !canWrite;
    addForm.classList.toggle('mobile-tasks__add--disabled', !canWrite);
    addForm.append(addInput);
    addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = addInput.value.trim();
      if (!t) return;
      addInput.value = '';
      void addItem(t);
    });

    const list = document.createElement('ul');
    list.className = 'mobile-tasks__tasks';
    list.setAttribute('role', 'list');

    const empty = document.createElement('p');
    empty.className = 'mobile-tasks__empty';
    empty.hidden = true;

    const detailFoot = document.createElement('div');
    detailFoot.className = 'mobile-tasks__detail-foot';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'mobile-tasks__project-edit';
    editBtn.textContent = 'Edit';
    editBtn.setAttribute('aria-haspopup', 'menu');
    editBtn.setAttribute('aria-expanded', 'false');
    editBtn.setAttribute(
      'aria-label',
      projectId != null ? `Edit ${projectTitle(projectId)}` : 'Edit project',
    );

    const editMenu = document.createElement('div');
    editMenu.className = 'mobile-tasks__project-menu';
    editMenu.hidden = true;
    editMenu.setAttribute('role', 'menu');

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'mobile-tasks__project-menu-item';
    renameBtn.textContent = 'Rename project…';
    renameBtn.setAttribute('role', 'menuitem');

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'mobile-tasks__project-menu-item mobile-tasks__project-menu-item--danger';
    deleteBtn.textContent = 'Delete project…';
    deleteBtn.setAttribute('role', 'menuitem');

    editMenu.append(renameBtn, deleteBtn);

    const detailArchivedBtn = document.createElement('button');
    detailArchivedBtn.type = 'button';
    detailArchivedBtn.className = 'mobile-tasks__archived-btn';
    detailArchivedBtn.textContent = TASKS_LABELS.recentlyArchived;
    if (!vikunjaConfigured) detailArchivedBtn.hidden = true;
    detailArchivedBtn.addEventListener('click', () => openArchivedModal());

    const closeEditMenu = () => {
      editMenu.hidden = true;
      editBtn.setAttribute('aria-expanded', 'false');
    };

    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = editMenu.hidden;
      closeEditMenu();
      if (open) {
        editMenu.hidden = false;
        editBtn.setAttribute('aria-expanded', 'true');
      }
    });

    renameBtn.addEventListener('click', () => {
      closeEditMenu();
      beginMobileProjectRename();
    });

    deleteBtn.addEventListener('click', () => {
      closeEditMenu();
      void deleteCurrentProject();
    });

    detailFoot.append(editBtn, editMenu, detailArchivedBtn);

    detailPane.append(detailHead, head, addForm, list, empty, detailFoot);

    if (!items.length) {
      empty.hidden = false;
      empty.textContent = emptyMsg || (canWrite ? 'No open tasks.' : 'Loading…');
      return;
    }

    for (const item of items) {
      list.append(renderTask(item));
    }
  }

  /**
   * @param {{ id: string, text: string, done: boolean }} item
   */
  function renderTask(item) {
    const li = document.createElement('li');
    li.className = 'mobile-tasks__task';
    li.dataset.id = item.id;
    if (item.done) li.classList.add('mobile-tasks__task--done');
    if (pendingDone.has(item.id)) li.classList.add('mobile-tasks__task--pending');

    const row = document.createElement('div');
    row.className = 'mobile-tasks__task-row';

    const canDrag = !item.done && !pendingDone.has(item.id);
    if (canDrag) {
      const handle = makeDragHandle('mobile-tasks__task-drag', 'Edit task');
      handle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMoveOverlay(item.id);
      });
      row.append(handle);
    }

    const label = document.createElement('label');
    label.className = 'mobile-tasks__task-label';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'mobile-tasks__check';
    cb.checked = item.done;

    const text = document.createElement('span');
    text.className = 'mobile-tasks__task-text';
    fillLinkifiedText(text, item.text);
    text.title = 'Long-press to edit task';

    label.append(cb, text);
    row.append(label);

    if (canDrag) {
      attachTaskLongPress(li, item.id, () => showMoveOverlay(item.id));
    }

    cb.addEventListener('change', () => {
      if (cb.checked) scheduleDone(item.id);
      else cancelDone(item.id);
    });

    li.append(row);
    return li;
  }

  function syncTaskDom(id, done) {
    const li = detailPane.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!li) return;
    li.classList.toggle('mobile-tasks__task--done', done);
    li.classList.toggle('mobile-tasks__task--pending', pendingDone.has(id));
    const cb = li.querySelector('.mobile-tasks__check');
    if (cb instanceof HTMLInputElement) cb.checked = done;
  }

  /**
   * @param {string} id
   */
  function scheduleDone(id) {
    const index = items.findIndex((it) => it.id === id);
    if (index < 0 || pendingDone.has(id)) return;
    items[index] = { ...items[index], done: true };
    const timer = setTimeout(() => {
      pendingDone.delete(id);
      void commitDone(id);
    }, DONE_HIDE_MS);
    pendingDone.set(id, timer);
    syncTaskDom(id, true);
  }

  /**
   * @param {string} id
   */
  function cancelDone(id) {
    if (!pendingDone.has(id)) return;
    clearPending(id);
    const index = items.findIndex((it) => it.id === id);
    if (index < 0) return;
    items[index] = { ...items[index], done: false };
    syncTaskDom(id, false);
  }

  /**
   * @param {string} id
   */
  function removeTaskLocally(id) {
    const index = items.findIndex((it) => it.id === id);
    if (index < 0) return;
    items = items.filter((it) => it.id !== id);
    renderDetailShell();
  }

  /**
   * @param {string} id
   * @param {string} text
   */
  function updateTaskTextLocally(id, text) {
    const index = items.findIndex((it) => it.id === id);
    if (index < 0) return;
    items[index] = { ...items[index], text };
    renderDetailShell();
  }

  /**
   * @param {string} id
   */
  async function commitDone(id) {
    const index = items.findIndex((it) => it.id === id);
    if (index < 0) return;
    const prev = items[index];
    try {
      const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(id)}/done`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive: false }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      notifyContactTaskDone(j.contactTask || j.item?.contactTask);
      const cleared = await clearTaskSchedule(id);
      if (cleared) taskRandomMeta = cleared;
      items = items.filter((it) => it.id !== id);
      renderDetailShell();
      showStatus('');
    } catch {
      clearPending(id);
      const i = items.findIndex((it) => it.id === id);
      if (i >= 0) items[i] = { ...prev, done: false };
      renderDetailShell();
      showStatus('Could not mark task done.', true);
    }
  }

  async function loadTodos() {
    if (projectId == null) return;
    const requestFor = projectId;
    const r = await fetch(
      `/api/vikunja/todos?projectId=${encodeURIComponent(String(projectId))}`,
      { cache: 'no-store' },
    );
    const j = await r.json().catch(() => ({}));
    if (view !== 'detail' || projectId !== requestFor) return;

    if (
      r.status === 503 ||
      j.error === 'vikunja_not_configured' ||
      j.error === 'vikunja_project_required'
    ) {
      canWrite = false;
      items = [];
      renderDetailShell(
        j.error === 'vikunja_project_required'
          ? 'Pick a project or set VIKUNJA_PROJECT_ID.'
          : 'Vikunja is not configured.',
      );
      showStatus(
        j.error === 'vikunja_project_required'
          ? 'Pick a project or set VIKUNJA_PROJECT_ID.'
          : 'Set VIKUNJA_BASE_URL and VIKUNJA_TOKEN in server env.',
        true,
      );
      return;
    }
    if (!r.ok || j.ok === false) {
      canWrite = false;
      items = [];
      renderDetailShell('Could not load tasks.');
      showStatus(j.detail || j.error || `HTTP ${r.status}`, true);
      return;
    }

    clearAllPending();
    items = Array.isArray(j.items)
      ? j.items
          .map((it) => ({
            id: String(it.id),
            text: String(it.text || '').trim(),
            done: Boolean(it.done),
          }))
          .filter((it) => it.id && it.text)
      : [];
    canWrite = true;
    renderDetailShell();
    showStatus('');
  }

  /**
   * @param {string} text
   */
  async function addItem(text) {
    const t = text.trim();
    if (!t || !canWrite || projectId == null) return;
    try {
      const r = await fetch('/api/vikunja/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t, projectId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false || !j.item) throw new Error(j.error || `HTTP ${r.status}`);
      items.unshift({
        id: String(j.item.id),
        text: String(j.item.text).trim(),
        done: false,
      });
      renderDetailShell();
      showStatus('');
    } catch {
      showStatus('Could not add task.', true);
    }
  }

  function renderProjects() {
    projectsList.replaceChildren();
    if (!projects.length) {
      const empty = document.createElement('li');
      empty.className = 'mobile-tasks__empty-row';
      empty.textContent = 'No projects yet.';
      projectsList.append(empty);
      return;
    }
    for (const p of projects) {
      const li = document.createElement('li');
      li.className = 'mobile-tasks__project';
      li.dataset.id = String(p.id);

      const handle = makeDragHandle('mobile-tasks__project-drag', 'Drag to reorder');
      handle.draggable = true;
      handle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      handle.addEventListener('dragstart', (e) => {
        draggingProjectId = p.id;
        projectDragMoved = false;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DND_PROJECT_MIME, String(p.id));
        e.dataTransfer.setData('text/plain', `project:${p.id}`);
        li.classList.add('mobile-tasks__project--dragging');
      });
      handle.addEventListener('dragend', () => {
        draggingProjectId = null;
        li.classList.remove('mobile-tasks__project--dragging');
        clearProjectDropIndicators();
      });

      const name = document.createElement('div');
      name.className = 'mobile-tasks__project-name';
      name.textContent = p.title;

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'mobile-tasks__project-delete';
      delBtn.textContent = '×';
      delBtn.setAttribute('aria-label', `Delete ${p.title}`);
      delBtn.title = `Delete ${p.title}`;
      delBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void deleteProject(p.id);
      });

      li.append(handle, name, delBtn);
      li.addEventListener('click', () => {
        if (projectDragMoved) {
          projectDragMoved = false;
          return;
        }
        void openProject(p.id);
      });

      li.addEventListener('dragover', (e) => {
        const types = [...e.dataTransfer.types];
        const isProject = types.includes(DND_PROJECT_MIME);
        const isTask = types.includes(DND_TASK_MIME);
        if (!isProject && !isTask && !types.includes('text/plain')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearProjectDropIndicators();
        if (isProject || (draggingProjectId != null && !isTask)) {
          if (draggingProjectId === p.id) return;
          const rect = li.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          li.classList.add(
            before ? 'mobile-tasks__project--reorder-before' : 'mobile-tasks__project--reorder-after',
          );
          return;
        }
        li.classList.add('mobile-tasks__project--drop');
      });
      li.addEventListener('dragleave', () => {
        li.classList.remove(
          'mobile-tasks__project--drop',
          'mobile-tasks__project--reorder-before',
          'mobile-tasks__project--reorder-after',
        );
      });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const projectRaw = e.dataTransfer.getData(DND_PROJECT_MIME);
        const taskRaw = e.dataTransfer.getData(DND_TASK_MIME);
        const plain = e.dataTransfer.getData('text/plain');
        clearProjectDropIndicators();

        if (projectRaw || (plain && plain.startsWith('project:'))) {
          const fromId = Number(projectRaw || plain.replace(/^project:/, ''));
          if (!Number.isFinite(fromId) || fromId <= 0 || fromId === p.id) return;
          const rect = li.getBoundingClientRect();
          const place = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          projectDragMoved = true;
          reorderProjectLocal(fromId, p.id, place);
          return;
        }

        const taskId = String(taskRaw || plain || '').trim();
        if (!/^\d+$/.test(taskId)) return;
        hideMoveOverlay();
        void moveTask(taskId, p.id);
      });

      projectsList.append(li);
    }
  }

  /**
   * @param {string} title
   */
  async function createProject(title) {
    const t = title.trim();
    if (!t) return;
    try {
      const r = await fetch('/api/vikunja/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false || !j.project) {
        showStatus(
          j.error === 'invalid_title' ? 'Enter a valid project name.' : 'Could not add project.',
          true,
        );
        return;
      }
      const maxPos = projects.reduce((m, p) => Math.max(m, p.position || 0), 0);
      projects.push({
        id: j.project.id,
        title: j.project.title,
        position: Number(j.project.position) || maxPos + 65536,
      });
      projects.sort(
        (a, b) =>
          (a.position ?? a.id) - (b.position ?? b.id) ||
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      );
      showStatus('');
      void openProject(j.project.id);
    } catch {
      showStatus('Could not add project.', true);
    }
  }

  addProjectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = addProjectInput.value.trim();
    if (!t) return;
    addProjectInput.value = '';
    void createProject(t);
  });

  async function refreshProjects() {
    if (listRefreshing) return;
    listRefreshing = true;
    showStatus('Refreshing…');
    try {
      await loadProjects();
    } finally {
      listRefreshing = false;
    }
  }

  async function refreshTodos() {
    if (detailRefreshing || projectId == null || view !== 'detail') return;
    detailRefreshing = true;
    showStatus('Refreshing…');
    try {
      await loadProjects();
      if (view === 'detail' && projectId != null) await loadTodos();
    } finally {
      detailRefreshing = false;
    }
  }

  async function loadProjects() {
    try {
      const r = await fetch('/api/vikunja/projects', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (
        r.status === 503 ||
        j.error === 'vikunja_not_configured'
      ) {
        showStatus('Set VIKUNJA_BASE_URL and VIKUNJA_TOKEN in server env.', true);
        projects = [];
        renderProjects();
        return;
      }
      if (!r.ok || j.ok === false) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      projects = Array.isArray(j.projects)
        ? j.projects
            .map((p) => ({
              id: Number(p.id),
              title: String(p.title || '').trim() || `Project ${p.id}`,
              position: Number(p.position) || Number(p.id) || 0,
            }))
            .filter((p) => Number.isFinite(p.id) && p.id > 0)
        : [];
      projects.sort(
        (a, b) =>
          (a.position ?? a.id) - (b.position ?? b.id) ||
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      );
      showStatus('');
      renderProjects();
      void refreshTaskRandomMeta();
      const s = history.state;
      if (s?.dashbirdMobile && s.tab === 'tasks' && s.pane === 'project' && s.projectId != null) {
        document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: s }));
      }

      const preferred = readSavedProjectId();
      if (preferred && projects.some((p) => p.id === preferred)) {
        // Stay on list — last project is remembered when they open one.
      }
    } catch (e) {
      showStatus(`Could not load projects: ${e?.message || e}`, true);
      projects = [];
      renderProjects();
    }
  }

  attachPullToRefresh(root, async () => {
    if (draggingProjectId != null || !moveOverlay.hidden) {
      return;
    }
    if (view === 'detail') await refreshTodos();
    else await refreshProjects();
  });

  projectsList.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.mobile-tasks__project-drag');
    if (!handle) return;
    const li = handle.closest('.mobile-tasks__project');
    if (!li) return;
    draggingProjectId = Number(li.dataset.id);
    projectDragMoved = false;
    projectPointerId = e.pointerId;
    li.classList.add('mobile-tasks__project--dragging');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  projectsList.addEventListener('pointermove', (e) => {
    if (draggingProjectId == null || e.pointerId !== projectPointerId) return;
    projectDragMoved = true;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mobile-tasks__project');
    clearProjectDropIndicators();
    if (target instanceof HTMLElement && Number(target.dataset.id) !== draggingProjectId) {
      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      target.classList.add(
        before ? 'mobile-tasks__project--reorder-before' : 'mobile-tasks__project--reorder-after',
      );
    }
  });

  function finishProjectPointerDrag(e) {
    if (draggingProjectId == null || e.pointerId !== projectPointerId) return;
    const fromId = draggingProjectId;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mobile-tasks__project');
    clearProjectDropIndicators();
    projectsList
      .querySelectorAll('.mobile-tasks__project--dragging')
      .forEach((el) => el.classList.remove('mobile-tasks__project--dragging'));
    draggingProjectId = null;
    projectPointerId = null;
    if (target instanceof HTMLElement) {
      const toId = Number(target.dataset.id);
      if (Number.isFinite(toId) && toId > 0 && toId !== fromId) {
        const rect = target.getBoundingClientRect();
        const place = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        reorderProjectLocal(fromId, toId, place);
      }
    }
  }

  projectsList.addEventListener('pointerup', finishProjectPointerDrag);
  projectsList.addEventListener('pointercancel', finishProjectPointerDrag);

  function openArchivedModal() {
    void openRecentlyArchivedTasks({
      root,
      onUnarchive: (item) => {
        if (!item?.id || !item.text) return;
        const pid =
          item.projectId != null && Number.isFinite(Number(item.projectId))
            ? Number(item.projectId)
            : projectId;
        const row = { id: String(item.id), text: String(item.text), done: false };
        if (pid != null && pid === projectId && view === 'detail') {
          if (!items.some((it) => it.id === row.id)) {
            items = [row, ...items];
            renderDetailShell();
          }
          return;
        }
        if (pid != null) void openProject(pid);
      },
    });
  }

  archivedBtn.addEventListener('click', () => openArchivedModal());

  waitingOnBtn.addEventListener('click', () => {
    void openWaitingOnList({
      root,
      onMetaChange: (meta) => {
        taskRandomMeta = meta;
        if (view === 'detail' && projectId != null && items.length) renderDetailShell();
      },
    });
  });

  randomBtn.addEventListener('click', () => {
    openRandomTaskPicker({
      root,
      projects,
      onHighlightTask: highlightTaskFromRandom,
      onDone: (id) => {
        removeTaskLocally(id);
      },
      onTextChange: (id, text) => {
        updateTaskTextLocally(id, text);
      },
    });
  });

  locationsBtn.addEventListener('click', () => {
    void openProjectLocationsTable({
      root,
      projects,
      onMetaChange: (meta) => {
        taskRandomMeta = meta;
      },
    });
  });

  moveRenameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && editTaskId) {
      e.preventDefault();
      void saveTaskEdits();
    }
  });

  moveTagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTagFromInput();
    }
  });

  moveTagAddBtn.addEventListener('click', (e) => {
    e.preventDefault();
    addTagFromInput();
  });

  moveSave.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void saveTaskEdits();
  });

  moveCancel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideMoveOverlay();
  });

  void loadProjects();

  onContactTasksChanged(() => {
    void (async () => {
      const wasProject = view === 'detail' && projectId != null;
      const prevId = projectId;
      await loadProjects();
      const contactProj = projects.find(
        (p) =>
          String(p.title || '').trim().toLowerCase() === CONTACT_TASKS_PROJECT_TITLE.toLowerCase(),
      );
      if (wasProject && contactProj && prevId === contactProj.id && view === 'detail') {
        await loadTodos();
      }
    })();
  });

  document.addEventListener('dashbird:mobile-nav', (e) => {
    const s = e.detail;
    if (!s || s.tab !== 'tasks') return;
    if (s.overlay === 'task-move') {
      hideMoveOverlay(true);
      return;
    }
    if (s.pane === 'list') {
      showList();
      showStatus('');
      void refreshProjects();
      return;
    }
    if (s.pane === 'project' && s.projectId != null) {
      const id = Number(s.projectId);
      if (Number.isFinite(id) && id > 0) void openProject(id, { fromHistory: true });
      else showList();
    }
  });
}
