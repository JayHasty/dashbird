/** Vikunja project that mirrors Network contact-card tasks. */
export const CONTACT_TASKS_PROJECT_TITLE = 'Contact Tasks';

const TITLE_MAX = 280;
const MARKER_RE = /dashbird:contact-task:([^:\s]+):([^:\s]+)/;

/**
 * @param {unknown} contact
 * @param {unknown} taskText
 * @returns {string}
 */
export function formatContactTaskTitle(contact, taskText) {
  const name = String(contact?.displayName || '').replace(/\s+/g, ' ').trim() || 'Contact';
  const nick = String(contact?.nickname || '').replace(/\s+/g, ' ').trim();
  const nickPart =
    nick && nick.toLowerCase() !== name.toLowerCase() ? ` (${nick})` : '';
  const task = String(taskText || '').replace(/\s+/g, ' ').trim();
  const prefix = `${name}${nickPart} — `;
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
 * Strip the "Name (Nick) — " prefix when the user renames a mirrored Vikunja task.
 * @param {unknown} title
 * @returns {string}
 */
export function contactTaskTextFromVikunjaTitle(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  const idx = raw.indexOf(' — ');
  if (idx < 0) return raw;
  return raw.slice(idx + 3).trim() || raw;
}
