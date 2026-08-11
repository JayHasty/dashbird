/**
 * Mirror Network contact-card tasks into the Vikunja "Contact Tasks" project.
 * Contact cards are the source of truth for text; done state syncs both ways.
 */

import {
  createPanelProject,
  createPanelTodo,
  listPanelProjects,
  listPanelTodos,
  resolveVikunjaConfig,
  setPanelTodoDone,
  updatePanelTodoMeta,
} from './vikunja-client.js';
import {
  CONTACT_TASKS_PROJECT_TITLE,
  contactTaskDescription,
  formatContactTaskTitle,
  parseContactTaskDescription,
} from './contact-task-title.js';
import { getContactById, loadNetworkContacts, updateContact } from './network-contacts-store.js';

/** @type {number | null} */
let cachedProjectId = null;

/** @type {Map<string, Promise<unknown>>} */
const contactLocks = new Map();

/**
 * @param {string} contactId
 * @param {() => Promise<unknown>} fn
 */
async function withContactLock(contactId, fn) {
  const key = String(contactId || '');
  const prev = contactLocks.get(key) || Promise.resolve();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const next = prev.then(() => gate);
  contactLocks.set(key, next);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (contactLocks.get(key) === next) contactLocks.delete(key);
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number | null>}
 */
export async function resolveContactTasksProjectId(env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) return null;
  if (cachedProjectId != null) return cachedProjectId;

  const projects = await listPanelProjects(env);
  const existing = projects.find(
    (p) =>
      String(p.title || '').trim().toLowerCase() === CONTACT_TASKS_PROJECT_TITLE.toLowerCase(),
  );
  if (existing?.id) {
    cachedProjectId = Number(existing.id);
    return cachedProjectId;
  }

  const created = await createPanelProject(CONTACT_TASKS_PROJECT_TITLE, env);
  cachedProjectId = Number(created.id);
  return cachedProjectId;
}

/**
 * @param {{ id?: string, text?: string, done?: boolean, vikunjaTaskId?: string }[]} tasks
 * @returns {{ id: string, text: string, done: boolean, vikunjaTaskId?: string }[]}
 */
function cloneTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map((t) => {
    /** @type {{ id: string, text: string, done: boolean, vikunjaTaskId?: string }} */
    const row = {
      id: String(t.id || ''),
      text: String(t.text || '').trim(),
      done: Boolean(t.done),
    };
    if (t.vikunjaTaskId) row.vikunjaTaskId = String(t.vikunjaTaskId);
    return row;
  });
}

/**
 * @param {object} prev
 * @param {object} saved
 */
export function contactNeedsVikunjaTaskSync(prev, saved) {
  const tasks = Array.isArray(saved?.tasks) ? saved.tasks : [];
  if (tasks.some((t) => t && !t.done && String(t.text || '').trim() && !t.vikunjaTaskId)) {
    return true;
  }
  const key = (c) => {
    const rows = Array.isArray(c?.tasks) ? c.tasks : [];
    const taskPart = rows
      .map((t) => `${t.id}\t${t.done ? 1 : 0}\t${String(t.text || '').trim()}`)
      .join('\n');
    return `${c?.displayName || ''}\n${c?.nickname || ''}\n${taskPart}`;
  };
  return key(prev) !== key(saved);
}

/**
 * @param {object} contact
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function syncContactTasksToVikunja(contact, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured || !contact?.id) return contact;
  return withContactLock(String(contact.id), () => syncContactTasksToVikunjaUnlocked(contact, env));
}

/**
 * @param {object} contact
 * @param {NodeJS.ProcessEnv} [env]
 */
async function syncContactTasksToVikunjaUnlocked(contact, env) {
  const projectId = await resolveContactTasksProjectId(env);
  if (projectId == null) return contact;

  const openVikunja = await listPanelTodos(env, { projectId });
  /** @type {Map<string, (typeof openVikunja)[0]>} */
  const byId = new Map(openVikunja.map((t) => [String(t.id), t]));
  /** @type {Map<string, (typeof openVikunja)[0]>} */
  const byLink = new Map();
  for (const vt of openVikunja) {
    const link = parseContactTaskDescription(vt.description);
    if (link) byLink.set(`${link.contactId}:${link.taskId}`, vt);
  }

  const nextTasks = cloneTasks(contact.tasks);
  let changed = false;
  /** @type {Set<string>} */
  const keepVikunjaIds = new Set();

  for (const task of nextTasks) {
    if (!task.id || !task.text) continue;
    const title = formatContactTaskTitle(contact, task.text);
    const description = contactTaskDescription(contact.id, task.id);
    const linkKey = `${contact.id}:${task.id}`;

    if (task.done) {
      const vid = task.vikunjaTaskId ? String(task.vikunjaTaskId) : byLink.get(linkKey)?.id;
      if (vid && byId.has(String(vid))) {
        await setPanelTodoDone(vid, true, env, { moveToArchive: false, skipContactApply: true });
        byId.delete(String(vid));
      }
      if (vid && task.vikunjaTaskId !== vid) {
        task.vikunjaTaskId = vid;
        changed = true;
      }
      continue;
    }

    let vt =
      (task.vikunjaTaskId && byId.get(String(task.vikunjaTaskId))) ||
      byLink.get(linkKey) ||
      null;
    if (!vt && task.vikunjaTaskId) {
      vt = openVikunja.find((row) => String(row.id) === String(task.vikunjaTaskId)) || null;
    }
    if (!vt) {
      vt =
        openVikunja.find(
          (row) =>
            !keepVikunjaIds.has(String(row.id)) &&
            String(row.text || '') === title &&
            (!parseContactTaskDescription(row.description) ||
              parseContactTaskDescription(row.description)?.contactId === String(contact.id)),
        ) || null;
    }

    if (!vt) {
      const created = await createPanelTodo(title, env, { projectId, description });
      task.vikunjaTaskId = String(created.id);
      changed = true;
      keepVikunjaIds.add(String(created.id));
      continue;
    }

    keepVikunjaIds.add(String(vt.id));
    if (task.vikunjaTaskId !== String(vt.id)) {
      task.vikunjaTaskId = String(vt.id);
      changed = true;
    }
    const needsTitle = String(vt.text || '') !== title;
    const needsDesc = parseContactTaskDescription(vt.description)?.taskId !== task.id;
    if (needsTitle || needsDesc) {
      await updatePanelTodoMeta(String(vt.id), { title, description }, env);
    }
    byId.delete(String(vt.id));
    byLink.delete(linkKey);
  }

  for (const vt of openVikunja) {
    const link = parseContactTaskDescription(vt.description);
    if (!link || link.contactId !== String(contact.id)) continue;
    if (keepVikunjaIds.has(String(vt.id))) continue;
    await setPanelTodoDone(String(vt.id), true, env, {
      moveToArchive: false,
      skipContactApply: true,
    });
  }

  if (!changed) return { ...contact, tasks: nextTasks };
  const saved = await updateContact(contact.id, { tasks: nextTasks }, env, {
    skipContactTaskSync: true,
    skipGroupSync: true,
  });
  return saved || { ...contact, tasks: nextTasks };
}

/**
 * Mark the linked contact-card task when a Vikunja todo is completed or reopened.
 * @param {{ vikunjaId: string, done: boolean, description?: unknown, title?: unknown }} payload
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ contactId: string, taskId: string, done: boolean } | null>}
 */
export async function applyVikunjaDoneToContact(payload, env = process.env) {
  const vikunjaId = String(payload?.vikunjaId || '').trim();
  if (!vikunjaId) return null;
  const done = Boolean(payload.done);

  let link = parseContactTaskDescription(payload?.description);
  let contact = link ? await getContactById(link.contactId, env) : null;
  if (!contact) {
    const found = await findContactByVikunjaTaskId(vikunjaId, env);
    if (found) {
      contact = found.contact;
      link = { contactId: found.contact.id, taskId: found.task.id };
    }
  }
  if (!contact || !link) return null;

  const tasks = cloneTasks(contact.tasks);
  const idx = tasks.findIndex((t) => t.id === link.taskId);
  if (idx < 0) return null;
  if (Boolean(tasks[idx].done) === done && tasks[idx].vikunjaTaskId === vikunjaId) {
    return { contactId: contact.id, taskId: link.taskId, done };
  }
  tasks[idx] = { ...tasks[idx], done, vikunjaTaskId: vikunjaId };
  await updateContact(contact.id, { tasks }, env, {
    skipContactTaskSync: true,
    skipGroupSync: true,
  });
  return { contactId: contact.id, taskId: link.taskId, done };
}

/**
 * @param {string} vikunjaId
 * @param {NodeJS.ProcessEnv} [env]
 */
async function findContactByVikunjaTaskId(vikunjaId, env) {
  const { contacts } = await loadNetworkContacts(env);
  for (const contact of contacts) {
    const task = (contact.tasks || []).find((t) => String(t.vikunjaTaskId || '') === vikunjaId);
    if (task) return { contact, task };
  }
  return null;
}

/**
 * Complete mirrored Vikunja tasks after a contact is deleted.
 * @param {object} contact
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function removeContactTasksFromVikunja(contact, env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured || !contact?.id) return;
  const tasks = Array.isArray(contact.tasks) ? contact.tasks : [];
  for (const task of tasks) {
    const vid = String(task?.vikunjaTaskId || '').trim();
    if (!vid) continue;
    try {
      await setPanelTodoDone(vid, true, env, { moveToArchive: false, skipContactApply: true });
    } catch {
      /* already gone / vikunja down */
    }
  }
}

/**
 * Backfill existing contact-card tasks into Vikunja (startup, best-effort).
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function syncAllContactTasksToVikunja(env = process.env) {
  const cfg = resolveVikunjaConfig(env);
  if (!cfg.configured) return { ok: false, reason: 'vikunja_not_configured' };
  const { contacts } = await loadNetworkContacts(env);
  const withTasks = contacts.filter((c) =>
    (c.tasks || []).some((t) => t && String(t.text || '').trim()),
  );
  if (!withTasks.length) return { ok: true, contacts: 0 };
  await resolveContactTasksProjectId(env);
  let n = 0;
  for (const contact of withTasks) {
    try {
      await syncContactTasksToVikunja(contact, env);
      n += 1;
    } catch (e) {
      console.warn('[contact-tasks]', contact.id, e?.message || e);
    }
  }
  return { ok: true, contacts: n };
}
