/** Vikunja project that mirrors Network contact-card tasks. */
export const CONTACT_TASKS_PROJECT_TITLE = 'Friend Tasks';
/** Pre-rename project title; resolved and renamed on sync. */
export const LEGACY_CONTACT_TASKS_PROJECT_TITLE = 'Contact Tasks';

const TITLE_MAX = 280;
const MARKER_RE = /dashbird:contact-task:([^:\s]+):([^:\s]+)/;
const PARENT_MARKER_RE = /dashbird:contact-parent:([^\s:]+)/;

/**
 * @param {unknown} title
 * @returns {boolean}
 */
export function isFriendTasksProjectTitle(title) {
  const t = String(title || '').trim().toLowerCase();
  return (
    t === CONTACT_TASKS_PROJECT_TITLE.toLowerCase() ||
    t === LEGACY_CONTACT_TASKS_PROJECT_TITLE.toLowerCase()
  );
}

/**
 * Person-name parent task in Friend Tasks.
 * @param {unknown} contact
 * @returns {string}
 */
export function formatContactParentTitle(contact) {
  const name = String(contact?.displayName || '').replace(/\s+/g, ' ').trim() || 'Contact';
  const nick = String(contact?.nickname || '').replace(/\s+/g, ' ').trim();
  const nickPart =
    nick && nick.toLowerCase() !== name.toLowerCase() ? ` (${nick})` : '';
  return `${name}${nickPart}`.slice(0, TITLE_MAX);
}

/**
 * Subtask title is just the checklist text (no name prefix).
 * @param {unknown} taskText
 * @returns {string}
 */
export function formatContactSubtaskTitle(taskText) {
  const task = String(taskText || '').replace(/\s+/g, ' ').trim();
  if (!task) return '';
  return task.length > TITLE_MAX ? `${task.slice(0, TITLE_MAX - 1)}…` : task;
}

/**
 * Legacy flat title: "Name (Nick) — task". Used to match pre-grouping Vikunja rows.
 * @param {unknown} contact
 * @param {unknown} taskText
 * @returns {string}
 */
export function formatContactTaskTitle(contact, taskText) {
  const prefix = `${formatContactParentTitle(contact)} — `;
  const task = String(taskText || '').replace(/\s+/g, ' ').trim();
  const budget = TITLE_MAX - prefix.length;
  if (budget <= 1) return prefix.slice(0, TITLE_MAX);
  const clipped =
    task.length > budget ? `${task.slice(0, Math.max(0, budget - 1))}…` : task;
  return `${prefix}${clipped}`.slice(0, TITLE_MAX);
}

/**
 * @param {string} contactId
 * @param {string} taskId
 * @returns {string}
 */
export function contactTaskDescription(contactId, taskId) {
  return `dashbird:contact-task:${String(contactId || '').trim()}:${String(taskId || '').trim()}`;
}

/**
 * @param {string} contactId
 * @returns {string}
 */
export function contactParentDescription(contactId) {
  return `dashbird:contact-parent:${String(contactId || '').trim()}`;
}

/**
 * @param {unknown} description
 * @returns {{ contactId: string, taskId: string } | null}
 */
export function parseContactTaskDescription(description) {
  const m = String(description || '').match(MARKER_RE);
  if (!m) return null;
  const contactId = String(m[1] || '').trim();
  const taskId = String(m[2] || '').trim();
  if (!contactId || !taskId) return null;
  return { contactId, taskId };
}

/**
 * @param {unknown} description
 * @returns {{ contactId: string } | null}
 */
export function parseContactParentDescription(description) {
  const m = String(description || '').match(PARENT_MARKER_RE);
  if (!m) return null;
  const contactId = String(m[1] || '').trim();
  if (!contactId) return null;
  return { contactId };
}

/**
 * Strip the "Name (Nick) — " prefix when migrating or renaming a mirrored Vikunja task.
 * @param {unknown} title
 * @returns {string}
 */
export function contactTaskTextFromVikunjaTitle(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  const idx = raw.indexOf(' — ');
  if (idx < 0) return raw;
  return raw.slice(idx + 3).trim() || raw;
}
