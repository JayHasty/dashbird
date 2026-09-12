/**
 * Collapse Tasks to a left rail and Notes to a right rail in the shared
 * desktop row. Preference: localStorage (html class applied early in index.html).
 */

const TASKS_KEY = 'dashbird-tasks-pane-collapsed';
const NOTES_KEY = 'dashbird-notes-pane-collapsed';
const TASKS_CLASS = 'tasks-keep-tasks-collapsed';
const NOTES_CLASS = 'tasks-keep-notes-collapsed';

function readCollapsed(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(key, collapsed) {
  try {
    localStorage.setItem(key, collapsed ? '1' : '0');
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * @param {'tasks' | 'notes'} pane
 * @param {boolean} collapsed
 * @param {HTMLButtonElement | null} btn
 */
function applyPane(pane, collapsed, btn) {
  const htmlClass = pane === 'tasks' ? TASKS_CLASS : NOTES_CLASS;
  document.documentElement.classList.toggle(htmlClass, collapsed);
  if (!btn) return;
  const name = pane === 'tasks' ? 'Tasks' : 'Notes';
  const label = collapsed ? `Expand ${name}` : `Collapse ${name}`;
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

export function mountTasksKeepCollapse() {
  const tasksBtn = document.getElementById('tasks-keep-collapse-tasks');
  const notesBtn = document.getElementById('tasks-keep-collapse-notes');
  if (!tasksBtn && !notesBtn) return;

  applyPane('tasks', readCollapsed(TASKS_KEY), /** @type {HTMLButtonElement | null} */ (tasksBtn));
  applyPane('notes', readCollapsed(NOTES_KEY), /** @type {HTMLButtonElement | null} */ (notesBtn));

  tasksBtn?.addEventListener('click', () => {
    const next = !document.documentElement.classList.contains(TASKS_CLASS);
    writeCollapsed(TASKS_KEY, next);
    applyPane('tasks', next, /** @type {HTMLButtonElement} */ (tasksBtn));
  });

  notesBtn?.addEventListener('click', () => {
    const next = !document.documentElement.classList.contains(NOTES_CLASS);
    writeCollapsed(NOTES_KEY, next);
    applyPane('notes', next, /** @type {HTMLButtonElement} */ (notesBtn));
  });
}
