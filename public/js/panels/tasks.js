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
import { onTaskCreated } from '../lib/task-bridge.js';
import { TASKS_LABELS } from '../lib/network-labels.js';
import { fillLinkifiedText } from '../lib/linkify-text.js';

/**
 * Main Tasks panel — browse Vikunja projects, add/complete tasks on Dashbird.
 * Projects list + task detail; rename/add projects; drag tasks onto projects.
 * @param {HTMLElement} root
 * @param {{ vikunjaPublicUrl?: string, vikunjaConfigured?: boolean }} [config]
 */
const PROJECT_LS_KEY = 'dashbird-tasks-project-id';
const DONE_HIDE_MS = 3000;
const DND_TASK_MIME = 'application/x-dashbird-task-id';
const DND_PROJECT_MIME = 'application/x-dashbird-project-id';
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;

export function mountTasks(root, config = {}) {
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'tasks-panel';

  const header = document.createElement('div');
  header.className = 'tasks-panel__header';

  const headerActions = document.createElement('div');
  headerActions.className = 'tasks-panel__header-actions';

  const randomBtn = document.createElement('button');
  randomBtn.type = 'button';
  randomBtn.className = 'tasks-panel__header-btn';
  randomBtn.textContent = TASKS_LABELS.random;

  const waitingOnBtn = document.createElement('button');
  waitingOnBtn.type = 'button';
  waitingOnBtn.className = 'tasks-panel__header-btn';
  waitingOnBtn.textContent = TASKS_LABELS.waitingOn;

  headerActions.append(waitingOnBtn, randomBtn);
  header.append(headerActions);

  const vikunjaConfigured = config.vikunjaConfigured !== false;
  if (!vikunjaConfigured) {
    randomBtn.hidden = true;
    waitingOnBtn.hidden = true;
  }

  const split = document.createElement('div');
  split.className = 'tasks-panel__split';

  const projectsPane = document.createElement('nav');
  projectsPane.className = 'tasks-panel__projects';
  projectsPane.setAttribute('aria-label', 'Projects');

  const projectsList = document.createElement('ul');
  projectsList.className = 'tasks-panel__projects-list';
  projectsList.setAttribute('role', 'listbox');
  projectsList.setAttribute('aria-label', 'Projects');

  const addProjectForm = document.createElement('form');
  addProjectForm.className = 'tasks-panel__add-project';
  addProjectForm.setAttribute('aria-label', 'Add a project');

  const addProjectInput = document.createElement('input');
  addProjectInput.type = 'text';
  addProjectInput.className = 'tasks-panel__project-input';
  addProjectInput.placeholder = 'New project…';
  addProjectInput.maxLength = 120;
  addProjectInput.autocomplete = 'off';

  const addProjectBtn = document.createElement('button');
  addProjectBtn.type = 'submit';
  addProjectBtn.className = 'tasks-panel__project-add-btn';
  addProjectBtn.textContent = 'Add';

  addProjectForm.append(addProjectInput, addProjectBtn);

  const locationsBtn = document.createElement('button');
  locationsBtn.type = 'button';
  locationsBtn.className = 'tasks-panel__projects-btn';
  locationsBtn.textContent = 'Locations';
  if (!vikunjaConfigured) locationsBtn.hidden = true;

  projectsPane.append(projectsList, locationsBtn, addProjectForm);

  const detail = document.createElement('div');
  detail.className = 'tasks-panel__detail';

  const detailTitle = document.createElement('h3');
  detailTitle.className = 'tasks-panel__detail-title';
  detailTitle.textContent = 'Select a project';

  const addForm = document.createElement('form');
  addForm.className = 'tasks-panel__add';
  addForm.setAttribute('aria-label', 'Add a task');

  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.className = 'tasks-panel__input';
  addInput.placeholder = 'Add a task…';
  addInput.autocomplete = 'off';
  addInput.maxLength = 280;
  addInput.disabled = true;

  addForm.append(addInput);

  const list = document.createElement('ul');
  list.className = 'tasks-panel__list';
  list.setAttribute('role', 'list');

  const empty = document.createElement('p');
  empty.className = 'tasks-panel__empty muted';
  empty.hidden = true;
  empty.textContent = 'No open tasks in this project.';

  const detailFoot = document.createElement('div');
  detailFoot.className = 'tasks-panel__detail-foot';
  detailFoot.hidden = true;

  const editProjectBtn = document.createElement('button');
  editProjectBtn.type = 'button';
  editProjectBtn.className = 'tasks-panel__project-edit';
  editProjectBtn.textContent = 'Edit';
  editProjectBtn.setAttribute('aria-haspopup', 'menu');
  editProjectBtn.setAttribute('aria-expanded', 'false');

  const projectEditMenu = document.createElement('div');
  projectEditMenu.className = 'tasks-panel__project-menu';
  projectEditMenu.hidden = true;
  projectEditMenu.setAttribute('role', 'menu');

  const renameProjectMenuBtn = document.createElement('button');
  renameProjectMenuBtn.type = 'button';
  renameProjectMenuBtn.className = 'tasks-panel__project-menu-item';
  renameProjectMenuBtn.textContent = 'Rename project…';
  renameProjectMenuBtn.setAttribute('role', 'menuitem');

  const deleteProjectMenuBtn = document.createElement('button');
  deleteProjectMenuBtn.type = 'button';
  deleteProjectMenuBtn.className =
    'tasks-panel__project-menu-item tasks-panel__project-menu-item--danger';
  deleteProjectMenuBtn.textContent = 'Delete project…';
  deleteProjectMenuBtn.setAttribute('role', 'menuitem');

  projectEditMenu.append(renameProjectMenuBtn, deleteProjectMenuBtn);

  const archivedBtn = document.createElement('button');
  archivedBtn.type = 'button';
  archivedBtn.className = 'tasks-panel__archived-btn';
  archivedBtn.textContent = TASKS_LABELS.recentlyArchived;
  if (!vikunjaConfigured) archivedBtn.hidden = true;

  detailFoot.append(editProjectBtn, projectEditMenu, archivedBtn);

  detail.append(detailTitle, addForm, list, empty, detailFoot);
  split.append(projectsPane, detail);

  const status = document.createElement('p');
  status.className = 'tasks-panel__status';
  status.hidden = true;

  wrap.append(header, split, status);
  root.append(wrap);

  const moveOverlay = document.createElement('div');
  moveOverlay.className = 'tasks-panel__move-overlay';
  moveOverlay.hidden = true;
  const moveDialog = document.createElement('div');
  moveDialog.className = 'tasks-panel__move-dialog';
  moveDialog.setAttribute('role', 'dialog');
  moveDialog.setAttribute('aria-modal', 'true');
  moveDialog.setAttribute('aria-label', 'Edit task');
  const moveRenameLabel = document.createElement('label');
  moveRenameLabel.className = 'tasks-panel__move-rename-label';
  const moveRenameText = document.createElement('span');
  moveRenameText.className = 'tasks-panel__move-title';
  moveRenameText.textContent = 'Task name';
  const moveRenameInput = document.createElement('input');
  moveRenameInput.type = 'text';
  moveRenameInput.className = 'tasks-panel__input tasks-panel__move-rename';
  moveRenameInput.maxLength = 280;
  moveRenameInput.autocomplete = 'off';
  moveRenameInput.setAttribute('aria-label', 'Task name');
  moveRenameLabel.append(moveRenameText, moveRenameInput);
  const moveScheduleSlot = document.createElement('div');
  moveScheduleSlot.className = 'tasks-panel__move-schedule';
  const moveWaitingSlot = document.createElement('div');
  moveWaitingSlot.className = 'tasks-panel__move-waiting';

  const moveTagsBtn = document.createElement('button');
  moveTagsBtn.type = 'button';
  moveTagsBtn.className = 'tasks-panel__move-edit-tags';
  moveTagsBtn.textContent = 'Edit tags';

  const moveSubtasks = document.createElement('div');
  moveSubtasks.className = 'tasks-panel__move-subtasks';
  const moveSubtasksTitle = document.createElement('div');
  moveSubtasksTitle.className = 'tasks-panel__move-title';
  moveSubtasksTitle.textContent = 'Subtasks';
  const moveSubtasksList = document.createElement('ul');
  moveSubtasksList.className = 'tasks-panel__move-subtasks-list';
  const moveSubtasksEmpty = document.createElement('p');
  moveSubtasksEmpty.className = 'tasks-panel__move-subtasks-empty muted';
  moveSubtasksEmpty.textContent = 'No subtasks yet.';
  const moveSubtasksForm = document.createElement('form');
  moveSubtasksForm.className = 'tasks-panel__move-subtasks-add';
  moveSubtasksForm.setAttribute('aria-label', 'Add a subtask');
  const moveSubtasksInput = document.createElement('input');
  moveSubtasksInput.type = 'text';
  moveSubtasksInput.className = 'tasks-panel__input tasks-panel__move-subtasks-input';
  moveSubtasksInput.placeholder = 'Add a subtask…';
  moveSubtasksInput.maxLength = 280;
  moveSubtasksInput.autocomplete = 'off';
  moveSubtasksForm.append(moveSubtasksInput);
  moveSubtasks.append(
    moveSubtasksTitle,
    moveSubtasksList,
    moveSubtasksEmpty,
    moveSubtasksForm,
  );

  const moveFooter = document.createElement('div');
  moveFooter.className = 'tasks-panel__move-footer';
  const moveSave = document.createElement('button');
  moveSave.type = 'button';
  moveSave.className = 'tasks-panel__move-save';
  moveSave.textContent = 'Save & close';
  const moveCancel = document.createElement('button');
  moveCancel.type = 'button';
  moveCancel.className = 'tasks-panel__move-cancel';
  moveCancel.textContent = 'cancel';
  moveFooter.append(moveSave, moveCancel);
  moveDialog.append(
    moveRenameLabel,
    moveScheduleSlot,
    moveWaitingSlot,
    moveTagsBtn,
    moveSubtasks,
    moveFooter,
  );
  moveOverlay.append(moveDialog);
  wrap.append(moveOverlay);

  /** @type {Array<{ id: number, title: string, position?: number }>} */
  let projects = [];
  /** @type {Array<{ id: string, text: string, done: boolean }>} */
  let items = [];
  /** @type {Map<number, Array<{ id: string, text: string, done: boolean }>>} */
  const todosCache = new Map();
  /** @type {number | null} */
  let projectId = null;
  /** @type {number} */
  let loadToken = 0;
  let canWrite = false;
  /** @type {number | null} */
  let editingProjectId = null;
  /** @type {number | null} */
  let draggingProjectId = null;
  let projectDragMoved = false;

  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pendingDone = new Map();

  /** @type {{ byTaskId: Record<string, unknown>, byProjectId: Record<string, unknown> }} */
  let taskRandomMeta = { byTaskId: {}, byProjectId: {} };

  async function refreshTaskRandomMeta() {
    taskRandomMeta = await fetchTaskRandomMeta(taskRandomMeta);
    if (projectId != null && items.length) renderList();
  }


  /** @type {string | null} */
  let highlightTaskId = null;
  /** @type {string | null} */
  let movingTaskId = null;
  /** @type {Array<{ id: string, text: string, done: boolean }>} */
  let moveSubtaskItems = [];
  /** @type {number} */
  let moveSubtasksLoadToken = 0;

  /**
   * @param {{ id: string, projectId?: number | null }} task
   */
  function highlightTaskFromRandom(task) {
    highlightTaskId = String(task.id);
    const pid = task.projectId != null ? Number(task.projectId) : projectId;
    if (pid != null && pid !== projectId) {
      selectProject(pid);
    }
    requestAnimationFrame(() => {
      const el = list.querySelector(`.tasks-panel__item[data-id="${CSS.escape(highlightTaskId)}"]`);
      if (el) {
        el.classList.add('tasks-panel__item--random-pick');
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setTimeout(() => el.classList.remove('tasks-panel__item--random-pick'), 4000);
      }
    });
  }

  /**
   * Task created from Daily Summary (or other panels) — show it in the active project list.
   * @param {{ id: string, text?: string, projectId?: number | null }} task
   */
  function ingestExternalTask(task) {
    const id = String(task.id || '').trim();
    const text = String(task.text || '').trim();
    if (!id || !text) return;

    const pid = task.projectId != null ? Number(task.projectId) : projectId;
    const row = { id, text, done: false };

    if (pid != null && pid !== projectId) {
      const cached = todosCache.get(pid) || [];
      if (!cached.some((it) => it.id === id)) {
        todosCache.set(pid, [row, ...cached]);
      }
      selectProject(pid);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => highlightTaskFromRandom({ id, projectId: pid }));
      });
      return;
    }

    if (!items.some((it) => it.id === id)) {
      items.unshift(row);
      if (projectId != null) {
        todosCache.set(projectId, items.map((it) => ({ ...it })));
      }
      renderList();
    }
    highlightTaskFromRandom({ id, projectId: pid ?? projectId });
  }

  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg;
    status.classList.toggle('tasks-panel__status--err', Boolean(isErr));
  }

  function setWritable(on) {
    canWrite = on;
    addInput.disabled = !on;
    addForm.classList.toggle('tasks-panel__add--disabled', !on);
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

  function readSavedProjectId() {
    try {
      const raw = localStorage.getItem(PROJECT_LS_KEY);
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  function saveProjectId(id) {
    try {
      if (id != null) localStorage.setItem(PROJECT_LS_KEY, String(id));
    } catch {
      /* ignore */
    }
  }

  function currentProjectTitle() {
    const p = projects.find((x) => x.id === projectId);
    return p?.title || 'Select a project';
  }

  function closeProjectEditMenu() {
    projectEditMenu.hidden = true;
    editProjectBtn.setAttribute('aria-expanded', 'false');
  }

  function syncProjectEditUi() {
    const title = projectId != null ? currentProjectTitle() : '';
    detailFoot.hidden = projectId == null;
    editProjectBtn.disabled = projectId == null;
    renameProjectMenuBtn.disabled = projectId == null;
    deleteProjectMenuBtn.disabled = projectId == null;
    editProjectBtn.setAttribute('aria-label', title ? `Edit ${title}` : 'Edit project');
    if (projectId == null) closeProjectEditMenu();
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
        '.tasks-panel__project-item--drop, .tasks-panel__project-item--reorder-before, .tasks-panel__project-item--reorder-after',
      )
      .forEach((el) => {
        el.classList.remove(
          'tasks-panel__project-item--drop',
          'tasks-panel__project-item--reorder-before',
          'tasks-panel__project-item--reorder-after',
        );
      });
  }

  /**
   * Midpoint position between neighbors (avoids rewriting every project).
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
   * Persist only the moved project’s position (fast). Full rewrite only if gaps collapse.
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
      // Rare: rewrite all positions in background without blocking UI again.
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
   * @param {number} id
   */
  function selectProject(id) {
    if (projectId === id) return;
    projectId = id;
    saveProjectId(projectId);
    editingProjectId = null;
    renderProjects();
    detailTitle.textContent = currentProjectTitle();
    syncProjectEditUi();

    const cached = todosCache.get(id);
    if (cached) {
      clearAllPending();
      items = cached.map((it) => ({ ...it }));
      setWritable(true);
      renderList();
      showStatus('');
    } else {
      // Keep the panel responsive: clear list but don't block clicks.
      clearAllPending();
      items = [];
      setWritable(false);
      renderList();
      empty.hidden = true;
      detail.classList.add('tasks-panel__detail--loading');
    }

    void loadTodos({ soft: Boolean(cached) }).catch(() => {
      if (!cached) showStatus('Could not load tasks.', true);
    });
  }

  /**
   * @param {number} id
   * @param {string} title
   */
  async function renameProject(id, title) {
    const idx = projects.findIndex((p) => p.id === id);
    const prevTitle = idx >= 0 ? projects[idx].title : '';
    // Optimistic: show the new name immediately.
    if (idx >= 0) projects[idx] = { ...projects[idx], title };
    editingProjectId = null;
    renderProjects();
    if (projectId === id) detailTitle.textContent = currentProjectTitle();

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
      if (projectId === id) detailTitle.textContent = currentProjectTitle();
      showStatus('');
      return true;
    } catch {
      if (idx >= 0) projects[idx] = { ...projects[idx], title: prevTitle };
      renderProjects();
      if (projectId === id) detailTitle.textContent = currentProjectTitle();
      showStatus('Could not rename project.', true);
      return false;
    }
  }

  /**
   * @param {number} id
   */
  async function deleteProject(id) {
    const idx = projects.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const removed = projects[idx];
    const wasSelected = projectId === id;
    const cachedTodos = todosCache.get(id);

    // Remove from the list immediately; revert only if the server delete fails.
    projects = projects.filter((p) => p.id !== id);
    todosCache.delete(id);
    closeProjectEditMenu();
    try {
      if (readSavedProjectId() === id) localStorage.removeItem(PROJECT_LS_KEY);
    } catch {
      /* ignore */
    }

    if (wasSelected) {
      projectId = null;
      items = [];
      clearAllPending();
      setWritable(false);
      detailTitle.textContent = 'Select a project';
      renderList();
      empty.hidden = true;
      const next = projects[0]?.id;
      if (next != null) selectProject(next);
      else syncProjectEditUi();
    }

    renderProjects();
    syncProjectEditUi();
    showStatus('');

    try {
      const r = await fetch(`/api/vikunja/projects/${encodeURIComponent(String(id))}`, {
        method: 'DELETE',
      });
      const j = await r.json().catch(() => ({}));
      // #region agent log
      fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9c9799'},body:JSON.stringify({sessionId:'9c9799',runId:'post-fix',hypothesisId:'A-B-C-E',location:'tasks.js:559',message:'DELETE project response',data:{id,status:r.status,ok:r.ok,jOk:j&&j.ok,jError:j&&j.error,jDetail:j&&j.detail,willRestore:(!r.ok||j.ok===false)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
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
      // #region agent log
      fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9c9799'},body:JSON.stringify({sessionId:'9c9799',runId:'post-fix',hypothesisId:'D',location:'tasks.js:574',message:'DELETE project catch — restoring row',data:{id,errName:e&&e.name,errMsg:String(e&&e.message||e)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      // Restore the row so the list stays in sync with Vikunja.
      projects.push(removed);
      sortProjectsInPlace();
      if (cachedTodos) todosCache.set(id, cachedTodos);
      renderProjects();
      syncProjectEditUi();
      showStatus(`Could not delete project: ${e?.message || e}`, true);
    }
  }

  async function createProject(title) {
    const r = await fetch('/api/vikunja/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
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
    selectProject(j.project.id);
    showStatus('');
  }

  /**
   * @param {string} taskId
   * @param {number} targetProjectId
   */
  async function moveTask(taskId, targetProjectId) {
    if (targetProjectId === projectId) return;
    const prev = items.slice();
    const moved = prev.find((it) => it.id === taskId);
    items = items.filter((it) => it.id !== taskId);
    clearPending(taskId);
    if (projectId != null) todosCache.set(projectId, items.map((it) => ({ ...it })));
    if (moved) {
      const dest = todosCache.get(targetProjectId);
      if (dest) {
        todosCache.set(targetProjectId, [{ ...moved, done: false }, ...dest]);
      } else {
        todosCache.delete(targetProjectId);
      }
    }
    renderList();

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
      if (projectId != null) todosCache.set(projectId, items.map((it) => ({ ...it })));
      todosCache.delete(targetProjectId);
      renderList();
      showStatus('Could not move task.', true);
    }
  }

  function hideMoveOverlay() {
    moveOverlay.hidden = true;
    movingTaskId = null;
    moveSubtaskItems = [];
    moveSubtasksLoadToken += 1;
    moveSubtasksList.replaceChildren();
    moveSubtasksEmpty.hidden = false;
    moveSubtasksInput.value = '';
    wrap.classList.remove('tasks-panel--moving');
  }

  function renderMoveSubtasks() {
    moveSubtasksList.replaceChildren();
    for (const sub of moveSubtaskItems) {
      const li = document.createElement('li');
      li.className = 'tasks-panel__move-subtask';
      li.dataset.id = sub.id;
      if (sub.done) li.classList.add('tasks-panel__move-subtask--done');

      const label = document.createElement('label');
      label.className = 'tasks-panel__move-subtask-label';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'tasks-panel__check';
      cb.checked = sub.done;

      const text = document.createElement('span');
      text.className = 'tasks-panel__move-subtask-text';
      fillLinkifiedText(text, sub.text);

      label.append(cb, text);
      li.append(label);
      moveSubtasksList.append(li);

      cb.addEventListener('change', () => {
        void setSubtaskDone(sub.id, cb.checked);
      });
    }
    moveSubtasksEmpty.hidden = moveSubtaskItems.length > 0;
  }

  /**
   * @param {string} parentId
   */
  async function loadMoveSubtasks(parentId) {
    const token = ++moveSubtasksLoadToken;
    moveSubtaskItems = [];
    renderMoveSubtasks();
    moveSubtasksEmpty.textContent = 'Loading subtasks…';
    moveSubtasksEmpty.hidden = false;
    try {
      const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(parentId)}/subtasks`, {
        cache: 'no-store',
      });
      const j = await r.json().catch(() => ({}));
      if (token !== moveSubtasksLoadToken || movingTaskId !== parentId) return;
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      moveSubtaskItems = Array.isArray(j.items)
        ? j.items
            .map((it) => ({
              id: String(it.id),
              text: String(it.text || '').trim(),
              done: Boolean(it.done),
            }))
            .filter((it) => it.id && it.text)
        : [];
      moveSubtasksEmpty.textContent = 'No subtasks yet.';
      renderMoveSubtasks();
    } catch {
      if (token !== moveSubtasksLoadToken || movingTaskId !== parentId) return;
      moveSubtasksEmpty.textContent = 'Could not load subtasks.';
      moveSubtasksEmpty.hidden = false;
    }
  }

  /**
   * @param {string} parentId
   * @param {string} text
   */
  async function addSubtask(parentId, text) {
    const t = text.trim();
    if (!t || movingTaskId !== parentId) return false;
    try {
      const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(parentId)}/subtasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false || !j.item) throw new Error(j.error || `HTTP ${r.status}`);
      const item = {
        id: String(j.item.id),
        text: String(j.item.text || '').trim(),
        done: Boolean(j.item.done),
      };
      if (!item.id || !item.text) throw new Error('invalid_item');
      // Subtasks are hidden from the project list; drop if create raced into cache.
      removeTaskLocally(item.id, projectId);
      if (movingTaskId === parentId) {
        moveSubtaskItems = [...moveSubtaskItems.filter((s) => s.id !== item.id), item];
        // Keep open subtasks first, then done.
        moveSubtaskItems.sort((a, b) => Number(a.done) - Number(b.done));
        renderMoveSubtasks();
      }
      showStatus('');
      return true;
    } catch {
      showStatus('Could not add subtask.', true);
      return false;
    }
  }

  /**
   * @param {string} subtaskId
   * @param {boolean} done
   */
  async function setSubtaskDone(subtaskId, done) {
    const parentId = movingTaskId;
    const prev = moveSubtaskItems.find((s) => s.id === subtaskId);
    if (!prev || !parentId) return;
    moveSubtaskItems = moveSubtaskItems.map((s) =>
      s.id === subtaskId ? { ...s, done } : s,
    );
    renderMoveSubtasks();
    try {
      const path = done ? 'done' : 'undo';
      const r = await fetch(
        `/api/vikunja/todos/${encodeURIComponent(subtaskId)}/${path}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            done
              ? { archive: false }
              : { projectId: projectId, archive: false },
          ),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      removeTaskLocally(subtaskId, projectId);
      showStatus('');
    } catch {
      if (movingTaskId === parentId) {
        moveSubtaskItems = moveSubtaskItems.map((s) =>
          s.id === subtaskId ? { ...s, done: prev.done } : s,
        );
        renderMoveSubtasks();
      }
      showStatus(done ? 'Could not complete subtask.' : 'Could not reopen subtask.', true);
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

  /**
   * @param {string} taskId
   */
  async function commitMoveOverlayRename(taskId) {
    const next = moveRenameInput.value.trim();
    const prev = items.find((it) => it.id === taskId)?.text || '';
    if (!next || next === prev) return true;
    return renameTask(taskId, next);
  }

  async function saveAndCloseMoveOverlay() {
    const taskId = movingTaskId;
    if (!taskId) {
      hideMoveOverlay();
      return;
    }
    moveSave.disabled = true;
    try {
      const pendingSub = moveSubtasksInput.value.trim();
      if (pendingSub) {
        const added = await addSubtask(taskId, pendingSub);
        if (movingTaskId !== taskId) return;
        if (!added) return;
        moveSubtasksInput.value = '';
      }
      const renamed = await commitMoveOverlayRename(taskId);
      if (movingTaskId !== taskId) return;
      if (!renamed) return;
      hideMoveOverlay();
    } finally {
      moveSave.disabled = false;
    }
  }

  /**
   * @param {string} taskId
   */
  function openEditTagsForTask(taskId) {
    const task = items.find((it) => it.id === taskId);
    const pid = projectId;
    openTaskTagsEditor({
      root: wrap,
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
    movingTaskId = taskId;
    const task = items.find((it) => it.id === taskId);
    moveRenameInput.value = task?.text || '';
    const taskMeta = taskRandomMeta.byTaskId?.[String(taskId)] || null;
    moveScheduleSlot.replaceChildren();
    moveWaitingSlot.replaceChildren();
    const sched = createScheduleControl({
      wrapClass: 'task-schedule tasks-panel__move-schedule-wrap',
      buttonClass: 'tasks-panel__schedule tasks-panel__move-schedule-btn',
      overdueClass: 'task-schedule__overdue',
    });
    sched.sync(taskMeta);
    sched.button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      sched.button.disabled = true;
      try {
        await commitMoveOverlayRename(taskId);
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
      wrapClass: 'tasks-panel__waiting tasks-panel__move-waiting-control',
      checkClass: 'tasks-panel__waiting-check',
      onMetaChange: (meta) => {
        taskRandomMeta = meta;
      },
    });
    moveWaitingSlot.append(waiting.wrap);
    void ensureOverduePriority(taskId, taskMeta).then((res) => {
      if (!res || movingTaskId !== taskId) return;
      taskRandomMeta = res.meta;
      sched.sync(res.row);
    });
    moveTagsBtn.onclick = () => openEditTagsForTask(taskId);
    moveSubtasksInput.value = '';
    moveOverlay.hidden = false;
    wrap.classList.add('tasks-panel--moving');
    void loadMoveSubtasks(taskId);
    queueMicrotask(() => {
      moveRenameInput.focus();
      moveRenameInput.select();
    });
  }

  function renderProjects() {
    projectsList.replaceChildren();
    if (!projects.length) {
      const li = document.createElement('li');
      li.className = 'tasks-panel__project-empty muted';
      li.textContent = 'No projects';
      projectsList.append(li);
      return;
    }

    for (const p of projects) {
      const li = document.createElement('li');
      li.className = 'tasks-panel__project-item';
      li.setAttribute('role', 'option');
      li.dataset.id = String(p.id);
      const selected = p.id === projectId;
      li.classList.toggle('tasks-panel__project-item--active', selected);
      li.setAttribute('aria-selected', selected ? 'true' : 'false');
      // Only the grip handle is draggable so double-click rename on the name still works.
      li.draggable = false;

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
            before
              ? 'tasks-panel__project-item--reorder-before'
              : 'tasks-panel__project-item--reorder-after',
          );
          return;
        }

        li.classList.add('tasks-panel__project-item--drop');
      });
      li.addEventListener('dragleave', () => {
        li.classList.remove(
          'tasks-panel__project-item--drop',
          'tasks-panel__project-item--reorder-before',
          'tasks-panel__project-item--reorder-after',
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
        void moveTask(taskId, p.id);
      });

      if (editingProjectId === p.id) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tasks-panel__project-rename';
        input.value = p.title;
        input.maxLength = 120;
        input.setAttribute('aria-label', `Rename ${p.title}`);

        let committed = false;
        const commit = () => {
          if (committed) return;
          committed = true;
          const next = input.value.trim();
          if (!next || next === p.title) {
            editingProjectId = null;
            renderProjects();
            return;
          }
          void renameProject(p.id, next);
        };

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            committed = true;
            editingProjectId = null;
            renderProjects();
          }
        });
        input.addEventListener('blur', () => commit());

        li.append(input);
        projectsList.append(li);
        queueMicrotask(() => {
          input.focus();
          input.select();
        });
        continue;
      }

      const row = document.createElement('div');
      row.className = 'tasks-panel__project-row';

      const handle = document.createElement('span');
      handle.className = 'tasks-panel__project-drag';
      handle.draggable = true;
      handle.setAttribute('aria-hidden', 'true');
      handle.title = 'Drag to reorder';
      const grip = document.createElement('span');
      grip.className = 'tasks-panel__grip';
      handle.append(grip);
      handle.addEventListener('dragstart', (e) => {
        draggingProjectId = p.id;
        projectDragMoved = false;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DND_PROJECT_MIME, String(p.id));
        e.dataTransfer.setData('text/plain', `project:${p.id}`);
        li.classList.add('tasks-panel__project-item--dragging');
      });
      handle.addEventListener('dragend', () => {
        draggingProjectId = null;
        li.classList.remove('tasks-panel__project-item--dragging');
        clearProjectDropIndicators();
      });

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tasks-panel__project-btn';
      btn.textContent = p.title;
      btn.title = `${p.title} — double-click to rename`;
      btn.draggable = false;
      btn.addEventListener('click', () => {
        if (projectDragMoved) {
          projectDragMoved = false;
          return;
        }
        selectProject(p.id);
      });
      btn.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        editingProjectId = p.id;
        renderProjects();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'tasks-panel__project-delete';
      delBtn.textContent = '×';
      delBtn.setAttribute('aria-label', `Delete ${p.title}`);
      delBtn.title = `Delete ${p.title}`;
      delBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void deleteProject(p.id);
      });

      row.append(handle, btn, delBtn);
      li.append(row);
      projectsList.append(li);
    }
  }

  function syncRowDom(id, done) {
    const li = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!li) return;
    li.classList.toggle('tasks-panel__item--done', done);
    li.classList.toggle('tasks-panel__item--pending-hide', pendingDone.has(id));
    const cb = li.querySelector('.tasks-panel__check');
    if (cb instanceof HTMLInputElement) cb.checked = done;
  }

  function renderList() {
    list.replaceChildren();
    for (const item of items) {
      list.append(renderItem(item));
    }
    empty.hidden = items.length > 0 || !canWrite || projectId == null;
  }

  /**
   * @param {{ id: string, text: string, done: boolean }} item
   */
  function renderItem(item) {
    const li = document.createElement('li');
    li.className = 'tasks-panel__item';
    li.dataset.id = item.id;
    li.draggable = !item.done && !pendingDone.has(item.id);
    if (item.done) li.classList.add('tasks-panel__item--done');
    if (pendingDone.has(item.id)) li.classList.add('tasks-panel__item--pending-hide');

    const row = document.createElement('div');
    row.className = 'tasks-panel__row';

    const handle = document.createElement('span');
    handle.className = 'tasks-panel__drag';
    handle.setAttribute('aria-hidden', 'true');
    handle.title = 'Drag to another project · double-click task text to edit';
    const grip = document.createElement('span');
    grip.className = 'tasks-panel__grip';
    handle.append(grip);

    const label = document.createElement('label');
    label.className = 'tasks-panel__label';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'tasks-panel__check';
    cb.checked = item.done;

    const text = document.createElement('span');
    text.className = 'tasks-panel__text';
    fillLinkifiedText(text, item.text);
    text.title = 'Double-click to edit task';

    label.append(cb, text);

    row.append(handle, label);

    if (!item.done && !pendingDone.has(item.id)) {
      const taskMeta = taskRandomMeta.byTaskId?.[String(item.id)] || null;
      void ensureOverduePriority(item.id, taskMeta).then((res) => {
        if (!res) return;
        taskRandomMeta = res.meta;
      });
    }

    li.append(row);

    cb.addEventListener('change', () => {
      if (cb.checked) scheduleDone(item.id);
      else cancelDone(item.id);
    });

    if (!item.done && !pendingDone.has(item.id)) {
      text.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMoveOverlay(item.id);
      });
    }

    li.addEventListener('dragstart', (e) => {
      if (item.done || pendingDone.has(item.id)) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(DND_TASK_MIME, item.id);
      e.dataTransfer.setData('text/plain', item.id);
      li.classList.add('tasks-panel__item--dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('tasks-panel__item--dragging');
      projectsList
        .querySelectorAll('.tasks-panel__project-item--drop')
        .forEach((el) => el.classList.remove('tasks-panel__project-item--drop'));
    });

    return li;
  }

  /**
   * Keep checked/done visible for 3s, then persist + hide.
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
    syncRowDom(id, true);
    const li = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (li) li.draggable = false;
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
    syncRowDom(id, false);
    const li = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (li) li.draggable = true;
  }

  /**
   * @param {string} id
   * @param {number | null} [taskProjectId]
   */
  function removeTaskLocally(id, taskProjectId = null) {
    const index = items.findIndex((it) => it.id === id);
    if (index >= 0) {
      items = items.filter((it) => it.id !== id);
      if (projectId != null) todosCache.set(projectId, items.map((it) => ({ ...it })));
      renderList();
      return;
    }
    if (taskProjectId != null && todosCache.has(taskProjectId)) {
      todosCache.set(
        taskProjectId,
        todosCache.get(taskProjectId).filter((it) => it.id !== id),
      );
    }
  }

  /**
   * @param {string} id
   * @param {string} text
   * @param {number | null} [taskProjectId]
   */
  function updateTaskTextLocally(id, text, taskProjectId = null) {
    const index = items.findIndex((it) => it.id === id);
    if (index >= 0) {
      items[index] = { ...items[index], text };
      if (projectId != null) todosCache.set(projectId, items.map((it) => ({ ...it })));
      renderList();
      return;
    }
    if (taskProjectId != null && todosCache.has(taskProjectId)) {
      todosCache.set(
        taskProjectId,
        todosCache.get(taskProjectId).map((it) => (it.id === id ? { ...it, text } : it)),
      );
    }
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
      const cleared = await clearTaskSchedule(id);
      if (cleared) taskRandomMeta = cleared;
      items = items.filter((it) => it.id !== id);
      if (projectId != null) todosCache.set(projectId, items.map((it) => ({ ...it })));
      renderList();
      showStatus('');
    } catch {
      clearPending(id);
      const i = items.findIndex((it) => it.id === id);
      if (i >= 0) items[i] = { ...prev, done: false };
      renderList();
      showStatus('Could not mark task done.', true);
    }
  }

  /**
   * @param {{ soft?: boolean }} [opts]
   */
  async function loadTodos(opts = {}) {
    if (projectId == null) {
      items = [];
      clearAllPending();
      setWritable(false);
      detailTitle.textContent = 'Select a project';
      detail.classList.remove('tasks-panel__detail--loading');
      renderList();
      empty.hidden = true;
      syncProjectEditUi();
      return;
    }

    const requestFor = projectId;
    const token = ++loadToken;
    detailTitle.textContent = currentProjectTitle();
    syncProjectEditUi();

    const r = await fetch(`/api/vikunja/todos?projectId=${encodeURIComponent(String(projectId))}`, {
      cache: 'no-store',
    });
    const j = await r.json().catch(() => ({}));
    if (token !== loadToken || projectId !== requestFor) return;

    detail.classList.remove('tasks-panel__detail--loading');

    if (
      r.status === 503 ||
      j.error === 'vikunja_not_configured' ||
      j.error === 'vikunja_project_required'
    ) {
      if (!opts.soft) {
        items = [];
        clearAllPending();
        setWritable(false);
        renderList();
      }
      showStatus(
        j.error === 'vikunja_project_required'
          ? 'Pick a project or set VIKUNJA_PROJECT_ID.'
          : 'Set VIKUNJA_BASE_URL and VIKUNJA_TOKEN in server env.',
        true,
      );
      return;
    }
    if (!r.ok || j.ok === false) throw new Error(j.detail || j.error || `HTTP ${r.status}`);

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
    todosCache.set(requestFor, items.map((it) => ({ ...it })));
    setWritable(true);
    renderList();
    showStatus('');
  }

  async function addItem(text) {
    const t = text.trim();
    if (!t || !canWrite || projectId == null) return;

    const r = await fetch('/api/vikunja/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t, projectId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false || !j.item) {
      showStatus('Could not add task.', true);
      return;
    }
    items.unshift({
      id: String(j.item.id),
      text: String(j.item.text).trim(),
      done: false,
    });
    todosCache.set(projectId, items.map((it) => ({ ...it })));
    renderList();
    showStatus('');
  }

  /**
   * @param {Array<{ id: number, title: string }>} rows
   * @param {number | null} preferredId
   */
  function fillProjects(rows, preferredId) {
    projects = Array.isArray(rows)
      ? rows.map((p) => ({
          id: Number(p.id),
          title: String(p.title || ''),
          position: Number(p.position) || Number(p.id),
        }))
      : [];
    sortProjectsInPlace();
    if (!projects.length) {
      projectId = null;
      renderProjects();
      syncProjectEditUi();
      return;
    }
    const saved = preferredId ?? readSavedProjectId();
    const match = projects.find((p) => p.id === saved) || projects[0];
    projectId = match.id;
    saveProjectId(projectId);
    renderProjects();
    syncProjectEditUi();
  }

  async function bootstrap() {
    const r = await fetch('/api/vikunja/projects', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 503 || j.error === 'vikunja_not_configured') {
      setWritable(false);
      addProjectInput.disabled = true;
      addProjectBtn.disabled = true;
      showStatus('Set VIKUNJA_BASE_URL and VIKUNJA_TOKEN in server env.', true);
      return;
    }
    if (!r.ok || j.ok === false) throw new Error(j.detail || j.error || `HTTP ${r.status}`);

    const preferred =
      readSavedProjectId() ??
      (j.defaultProjectId != null ? Number(j.defaultProjectId) : null);
    fillProjects(j.projects, preferred);
    void refreshTaskRandomMeta();
    await loadTodos();
  }

  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (addInput.disabled) return;
    const t = addInput.value;
    addInput.value = '';
    void addItem(t).then(() => addInput.focus());
  });

  addProjectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = addProjectInput.value;
    addProjectInput.value = '';
    void createProject(t).then(() => addProjectInput.focus());
  });


  editProjectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (projectId == null || editProjectBtn.disabled) return;
    const open = projectEditMenu.hidden;
    closeProjectEditMenu();
    if (open) {
      projectEditMenu.hidden = false;
      editProjectBtn.setAttribute('aria-expanded', 'true');
    }
  });

  renameProjectMenuBtn.addEventListener('click', () => {
    closeProjectEditMenu();
    if (projectId == null) return;
    editingProjectId = projectId;
    renderProjects();
  });

  deleteProjectMenuBtn.addEventListener('click', () => {
    closeProjectEditMenu();
    if (projectId == null) return;
    void deleteProject(projectId);
  });

  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Node) || detailFoot.contains(e.target)) return;
    closeProjectEditMenu();
  });

  waitingOnBtn.addEventListener('click', () => {
    void openWaitingOnList({
      root: wrap,
      onMetaChange: (meta) => {
        taskRandomMeta = meta;
        if (projectId != null && items.length) renderList();
      },
    });
  });

  archivedBtn.addEventListener('click', () => {
    void openRecentlyArchivedTasks({
      root: wrap,
      onUnarchive: (item) => {
        if (!item?.id || !item.text) return;
        ingestExternalTask({
          id: String(item.id),
          text: String(item.text),
          projectId: item.projectId != null ? Number(item.projectId) : projectId,
        });
      },
    });
  });

  randomBtn.addEventListener('click', () => {
    openRandomTaskPicker({
      root: wrap,
      projects,
      onHighlightTask: highlightTaskFromRandom,
      onDone: (id, taskProjectId) => {
        removeTaskLocally(id, taskProjectId ?? null);
      },
      onTextChange: (id, text, taskProjectId) => {
        updateTaskTextLocally(id, text, taskProjectId ?? null);
      },
    });
  });

  locationsBtn.addEventListener('click', () => {
    void openProjectLocationsTable({
      root: wrap,
      projects,
      onMetaChange: (meta) => {
        taskRandomMeta = meta;
      },
    });
  });

  moveRenameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && movingTaskId) {
      e.preventDefault();
      void commitMoveOverlayRename(movingTaskId);
    }
  });

  moveSubtasksForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const parentId = movingTaskId;
    if (!parentId) return;
    const t = moveSubtasksInput.value;
    moveSubtasksInput.value = '';
    void addSubtask(parentId, t).then((ok) => {
      if (ok) moveSubtasksInput.focus();
    });
  });

  moveSave.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void saveAndCloseMoveOverlay();
  });
  moveCancel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideMoveOverlay();
  });
  moveOverlay.addEventListener('click', (e) => {
    if (e.target === moveOverlay) hideMoveOverlay();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !moveOverlay.hidden) hideMoveOverlay();
    if (e.key === 'Escape' && !projectEditMenu.hidden) closeProjectEditMenu();
  });

  onTaskCreated(ingestExternalTask);

  void bootstrap().catch(() => {
    setWritable(false);
    showStatus('Could not load Vikunja projects.', true);
  });
}

/** @deprecated Use mountTasks — kept for older imports. */
export function mountNotes(root, config = {}) {
  mountTasks(root, config);
}
