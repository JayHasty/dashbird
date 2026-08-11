/** @typedef {{ id: string, text?: string, projectId?: number | null, dueDate?: string | null }} TaskBridgePayload */

const PROJECT_LS_KEY = 'dashbird-tasks-project-id';
const TASK_CREATED_EVENT = 'dashbird:task-created';
const CONTACT_TASK_DONE_EVENT = 'dashbird:contact-task-done';
const CONTACT_TASKS_CHANGED_EVENT = 'dashbird:contact-tasks-changed';

export const CONTACT_TASKS_PROJECT_TITLE = 'Contact Tasks';

/**
 * Last-selected Vikunja project from the Tasks panel (desktop + mobile share key).
 * @returns {number | null}
 */
export function readTasksProjectId() {
  try {
    const raw = localStorage.getItem(PROJECT_LS_KEY);
    if (raw == null || raw === '') return null;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Broadcast that a task was created elsewhere (Daily Summary, etc.).
 * @param {TaskBridgePayload} task
 */
export function notifyTaskCreated(task) {
  if (!task?.id) return;
  document.dispatchEvent(new CustomEvent(TASK_CREATED_EVENT, { detail: task }));
}

/**
 * Scroll the desktop Tasks panel into view after creating a task.
 */
export function focusTasksPanel() {
  const section = document.getElementById('mount-tasks')?.closest('section');
  section?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * @param {(task: TaskBridgePayload) => void} handler
 * @returns {() => void}
 */
export function onTaskCreated(handler) {
  /** @param {Event} e */
  const listener = (e) => {
    const detail = /** @type {CustomEvent<TaskBridgePayload>} */ (e).detail;
    if (detail?.id) handler(detail);
  };
  document.addEventListener(TASK_CREATED_EVENT, listener);
  return () => document.removeEventListener(TASK_CREATED_EVENT, listener);
}

/**
 * @param {{ contactId?: string, taskId?: string, done?: boolean } | null | undefined} payload
 */
export function notifyContactTaskDone(payload) {
  if (!payload?.contactId || !payload?.taskId) return;
  document.dispatchEvent(new CustomEvent(CONTACT_TASK_DONE_EVENT, { detail: payload }));
}

/**
 * Contact-card tasks changed — Tasks panel should refresh the Contact Tasks project.
 */
export function notifyContactTasksChanged() {
  document.dispatchEvent(new CustomEvent(CONTACT_TASKS_CHANGED_EVENT));
}

/**
 * @param {(payload: { contactId: string, taskId: string, done: boolean }) => void} handler
 * @returns {() => void}
 */
export function onContactTaskDone(handler) {
  /** @param {Event} e */
  const listener = (e) => {
    const detail = /** @type {CustomEvent<{ contactId: string, taskId: string, done: boolean }>} */ (e).detail;
    if (detail?.contactId && detail?.taskId) handler(detail);
  };
  document.addEventListener(CONTACT_TASK_DONE_EVENT, listener);
  return () => document.removeEventListener(CONTACT_TASK_DONE_EVENT, listener);
}

/**
 * @param {() => void} handler
 * @returns {() => void}
 */
export function onContactTasksChanged(handler) {
  const listener = () => handler();
  document.addEventListener(CONTACT_TASKS_CHANGED_EVENT, listener);
  return () => document.removeEventListener(CONTACT_TASKS_CHANGED_EVENT, listener);
}
