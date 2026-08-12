/**
 * Mirror Network contact-card tasks into the Vikunja "Friend Tasks" project.
 * Each person is a parent task (their name); checklist items are subtasks.
 * Contact cards are the source of truth for text; done state syncs both ways.
 * When the last open subtask is done, the name-only parent is completed too.
 */

import {
  createPanelProject,
  createPanelSubtask,
  createPanelTodo,
  linkPanelSubtask,
  listPanelProjects,
  listPanelTodos,
  resolveVikunjaConfig,
  setPanelTodoDone,
  updatePanelProject,
  updatePanelTodoMeta,
} from './vikunja-client.js';
import {
  CONTACT_TASKS_PROJECT_TITLE,
  LEGACY_CONTACT_TASKS_PROJECT_TITLE,
  contactParentDescription,
  contactTaskDescription,
  contactTaskTextFromVikunjaTitle,
  formatContactParentTitle,
  formatContactSubtaskTitle,
  formatContactTaskTitle,
  parseContactParentDescription,
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
  const friend = projects.find(
    (p) =>
      String(p.title || '').trim().toLowerCase() === CONTACT_TASKS_PROJECT_TITLE.toLowerCase(),
  );
  if (friend?.id) {
    cachedProjectId = Number(friend.id);
    return cachedProjectId;
  }

  const legacy = projects.find(
    (p) =>
      String(p.title || '').trim().toLowerCase() ===
      LEGACY_CONTACT_TASKS_PROJECT_TITLE.toLowerCase(),
  );
  if (legacy?.id) {
    try {
      await updatePanelProject(Number(legacy.id), { title: CONTACT_TASKS_PROJECT_TITLE }, env);
    } catch {
      /* keep using the old title if rename fails */
    }
    cachedProjectId = Number(legacy.id);
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
 * @param {Array<{ id?: string, text?: string, description?: string, subtasks?: unknown[] }>} openVikunja
 */
function flattenOpenTodos(openVikunja) {
  /** @type {Array<{ id: string, text: string, description: string, parentId: string | null }>} */
  const flat = [];
  for (const t of Array.isArray(openVikunja) ? openVikunja : []) {
    const id = String(t?.id || '');
    if (!id) continue;
    flat.push({
      id,
      text: String(t.text || ''),
      description: String(t.description || ''),
      parentId: null,
    });
    for (const s of Array.isArray(t.subtasks) ? t.subtasks : []) {
      const sid = String(s?.id || '');
      if (!sid) continue;
      flat.push({
        id: sid,
        text: String(s.text || ''),
        description: String(s.description || ''),
        parentId: id,
      });
    }
  }
  return flat;
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
  if (
    tasks.some((t) => t && !t.done && String(t.text || '').trim()) &&
    !String(saved?.vikunjaParentTaskId || '').trim()
  ) {
    return true;
  }
  const key = (c) => {
    const rows = Array.isArray(c?.tasks) ? c.tasks : [];
    const taskPart = rows
      .map((t) => `${t.id}\t${t.done ? 1 : 0}\t${String(t.text || '').trim()}`)
      .join('\n');
    return `${c?.displayName || ''}\n${c?.nickname || ''}\n${c?.vikunjaParentTaskId || ''}\n${taskPart}`;
  };
  return key(prev) !== key(saved);
}

/**
 * @param {object} contact
 * @param {Array<{ id: string, text: string, description: string, parentId: string | null }>} flat
 */
function findParentCandidates(contact, flat) {
  const contactId = String(contact.id);
  const wantTitle = formatContactParentTitle(contact);
  const storedId = String(contact.vikunjaParentTaskId || '').trim();
  /** @type {typeof flat} */
  const byMarker = [];
  /** @type {typeof flat} */
  const byStored = [];
  /** @type {typeof flat} */
  const byTitle = [];
  for (const row of flat) {
    if (row.parentId) continue;
    const link = parseContactParentDescription(row.description);
    if (link?.contactId === contactId) {
      byMarker.push(row);
      continue;
    }
    if (storedId && row.id === storedId) {
      byStored.push(row);
      continue;
    }
    if (String(row.text || '') === wantTitle && !parseContactTaskDescription(row.description)) {
      byTitle.push(row);
    }
  }
  return [...byMarker, ...byStored, ...byTitle];
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} env
 * @param {number} projectId
 */
async function tryReopenTodo(id, env, projectId) {
  try {
    /** @type {{ moveToArchive: false, skipContactApply: true, restoreProjectId?: number }} */
    const opts = { moveToArchive: false, skipContactApply: true };
    if (projectId != null && Number.isFinite(Number(projectId)) && Number(projectId) > 0) {
      opts.restoreProjectId = Number(projectId);
    }
    const item = await setPanelTodoDone(String(id), false, env, opts);
    if (!item?.id) return null;
    return {
      id: String(item.id),
      text: String(item.text || ''),
      description: String(item.description || ''),
      parentId: null,
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} env
 */
async function completeTodoQuiet(id, env) {
  try {
    await setPanelTodoDone(String(id), true, env, {
      moveToArchive: false,
      skipContactApply: true,
    });
  } catch {
    /* already gone / vikunja down */
  }
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
  let flat = flattenOpenTodos(openVikunja);
  /** @type {Map<string, (typeof flat)[0]>} */
  const byId = new Map(flat.map((t) => [t.id, t]));
  /** @type {Map<string, (typeof flat)[0]>} */
  const byLink = new Map();
  for (const vt of flat) {
    const link = parseContactTaskDescription(vt.description);
    if (link) byLink.set(`${link.contactId}:${link.taskId}`, vt);
  }

  const nextTasks = cloneTasks(contact.tasks);
  let changed = false;
  let parentId = String(contact.vikunjaParentTaskId || '').trim();
  /** @type {Set<string>} */
  const keepVikunjaIds = new Set();

  const openTasks = nextTasks.filter((t) => t.id && t.text && !t.done);

  const parents = findParentCandidates(contact, flat);
  let parent = parents[0] || null;
  for (const extra of parents.slice(1)) {
    if (extra.id === parent?.id) continue;
    await completeTodoQuiet(extra.id, env);
  }
  if (parent) {
    parentId = parent.id;
    if (String(contact.vikunjaParentTaskId || '') !== parentId) changed = true;
  }

  if (!openTasks.length) {
    for (const task of nextTasks) {
      const vid = task.vikunjaTaskId ? String(task.vikunjaTaskId) : byLink.get(`${contact.id}:${task.id}`)?.id;
      if (vid && byId.has(String(vid))) {
        await completeTodoQuiet(vid, env);
        byId.delete(String(vid));
      }
      if (vid && task.vikunjaTaskId !== vid) {
        task.vikunjaTaskId = vid;
        changed = true;
      }
    }
    for (const vt of flat) {
      const link = parseContactTaskDescription(vt.description);
      if (!link || link.contactId !== String(contact.id)) continue;
      await completeTodoQuiet(vt.id, env);
    }
    if (parentId) await completeTodoQuiet(parentId, env);
    if (!changed && String(contact.vikunjaParentTaskId || '') === parentId) {
      return { ...contact, tasks: nextTasks, ...(parentId ? { vikunjaParentTaskId: parentId } : {}) };
    }
    const saved = await updateContact(
      contact.id,
      { tasks: nextTasks, ...(parentId ? { vikunjaParentTaskId: parentId } : {}) },
      env,
      { skipContactTaskSync: true, skipGroupSync: true },
    );
    return saved || { ...contact, tasks: nextTasks, ...(parentId ? { vikunjaParentTaskId: parentId } : {}) };
  }

  const parentTitle = formatContactParentTitle(contact);
  const parentDesc = contactParentDescription(contact.id);

  if (!parent && parentId) {
    parent = await tryReopenTodo(parentId, env, projectId);
  }
  if (!parent) {
    const created = await createPanelTodo(parentTitle, env, { projectId, description: parentDesc });
    parent = {
      id: String(created.id),
      text: String(created.text || parentTitle),
      description: parentDesc,
      parentId: null,
    };
    parentId = parent.id;
    changed = true;
  } else {
    parentId = parent.id;
    const needsTitle = String(parent.text || '') !== parentTitle;
    const needsDesc = parseContactParentDescription(parent.description)?.contactId !== String(contact.id);
    if (needsTitle || needsDesc) {
      await updatePanelTodoMeta(parent.id, { title: parentTitle, description: parentDesc }, env);
    }
  }
  keepVikunjaIds.add(parentId);
  if (String(contact.vikunjaParentTaskId || '') !== parentId) changed = true;

  for (const task of nextTasks) {
    if (!task.id || !task.text) continue;
    const title = formatContactSubtaskTitle(task.text);
    const legacyTitle = formatContactTaskTitle(contact, task.text);
    const description = contactTaskDescription(contact.id, task.id);
    const linkKey = `${contact.id}:${task.id}`;

    if (task.done) {
      const vid = task.vikunjaTaskId ? String(task.vikunjaTaskId) : byLink.get(linkKey)?.id;
      if (vid && byId.has(String(vid))) {
        await completeTodoQuiet(vid, env);
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
      vt = await tryReopenTodo(String(task.vikunjaTaskId), env, projectId);
    }
    if (!vt) {
      vt =
        flat.find(
          (row) =>
            !keepVikunjaIds.has(row.id) &&
            row.id !== parentId &&
            (String(row.text || '') === title || String(row.text || '') === legacyTitle) &&
            (!parseContactTaskDescription(row.description) ||
              parseContactTaskDescription(row.description)?.contactId === String(contact.id)),
        ) || null;
    }

    if (!vt) {
      const created = await createPanelSubtask(parentId, title, env, { description });
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
    if (vt.parentId !== parentId) {
      try {
        await linkPanelSubtask(parentId, vt.id, env);
      } catch {
        /* relation may already exist */
      }
    }
    const wantText = title || contactTaskTextFromVikunjaTitle(vt.text);
    const needsTitle = String(vt.text || '') !== wantText;
    const needsDesc = parseContactTaskDescription(vt.description)?.taskId !== task.id;
    if (needsTitle || needsDesc) {
      await updatePanelTodoMeta(String(vt.id), { title: wantText, description }, env);
    }
    byId.delete(String(vt.id));
    byLink.delete(linkKey);
  }

  for (const vt of flat) {
    const link = parseContactTaskDescription(vt.description);
    if (!link || link.contactId !== String(contact.id)) continue;
    if (keepVikunjaIds.has(String(vt.id))) continue;
    await completeTodoQuiet(String(vt.id), env);
  }

  if (!changed) {
    return { ...contact, tasks: nextTasks, vikunjaParentTaskId: parentId };
  }
  const saved = await updateContact(
    contact.id,
    { tasks: nextTasks, vikunjaParentTaskId: parentId },
    env,
    { skipContactTaskSync: true, skipGroupSync: true },
  );
  return saved || { ...contact, tasks: nextTasks, vikunjaParentTaskId: parentId };
}

/**
 * @param {string} contactId
 * @param {string} parentVikunjaId
 * @param {boolean} done
 * @param {NodeJS.ProcessEnv} env
 */
async function applyParentDoneToContact(contactId, parentVikunjaId, done, env) {
  const contact = await getContactById(contactId, env);
  if (!contact) return null;
  if (!done) {
    return { contactId, taskId: '', done: false };
  }
  const tasks = cloneTasks(contact.tasks);
  let changed = false;
  for (const t of tasks) {
    if (!t.done) {
      t.done = true;
      changed = true;
    }
    const vid = String(t.vikunjaTaskId || '').trim();
    if (vid && vid !== parentVikunjaId) await completeTodoQuiet(vid, env);
  }
  if (changed || String(contact.vikunjaParentTaskId || '') !== parentVikunjaId) {
    await updateContact(
      contact.id,
      { tasks, vikunjaParentTaskId: parentVikunjaId },
      env,
      { skipContactTaskSync: true, skipGroupSync: true },
    );
  }
  return {
    contactId: contact.id,
    taskId: tasks.find((t) => t.id)?.id || '',
    done: true,
    removedParentId: parentVikunjaId,
  };
}

/**
 * Mark the linked contact-card task when a Vikunja todo is completed or reopened.
 * Completing the last Friend Tasks subtask also completes the name-only parent.
 * @param {{ vikunjaId: string, done: boolean, description?: unknown, title?: unknown }} payload
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ contactId: string, taskId: string, done: boolean, removedParentId?: string } | null>}
 */
export async function applyVikunjaDoneToContact(payload, env = process.env) {
  const vikunjaId = String(payload?.vikunjaId || '').trim();
  if (!vikunjaId) return null;
  const done = Boolean(payload.done);

  const parentLink = parseContactParentDescription(payload?.description);
  if (parentLink) {
    return applyParentDoneToContact(parentLink.contactId, vikunjaId, done, env);
  }

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
  const already =
    Boolean(tasks[idx].done) === done && tasks[idx].vikunjaTaskId === vikunjaId;
  if (!already) {
    tasks[idx] = { ...tasks[idx], done, vikunjaTaskId: vikunjaId };
    await updateContact(contact.id, { tasks }, env, {
      skipContactTaskSync: true,
      skipGroupSync: true,
    });
  }

  let parentId = String(contact.vikunjaParentTaskId || '').trim();
  if (!done) {
    if (parentId && parentId !== vikunjaId) await tryReopenTodo(parentId, env);
    return { contactId: contact.id, taskId: link.taskId, done };
  }

  const stillOpen = tasks.some((t) => t && !t.done && String(t.text || '').trim());
  if (stillOpen) return { contactId: contact.id, taskId: link.taskId, done };

  if (!parentId || parentId === vikunjaId) {
    parentId = (await findOpenFriendParentId(contact, vikunjaId, env)) || '';
  }
  if (!parentId || parentId === vikunjaId) {
    return { contactId: contact.id, taskId: link.taskId, done };
  }
  await completeTodoQuiet(parentId, env);
  return { contactId: contact.id, taskId: link.taskId, done, removedParentId: parentId };
}

/**
 * When the last subtask is completed it drops out of the open list; the name-only
 * parent may still be open with zero subtasks.
 * @param {object} contact
 * @param {string} completedId
 * @param {NodeJS.ProcessEnv} env
 */
async function findOpenFriendParentId(contact, completedId, env) {
  try {
    const projectId = await resolveContactTasksProjectId(env);
    if (projectId == null) return '';
    const open = await listPanelTodos(env, { projectId });
    const wantTitle = formatContactParentTitle(contact);
    const host =
      open.find((t) => (t.subtasks || []).some((s) => String(s.id) === completedId)) ||
      open.find(
        (t) =>
          String(t.id) !== completedId &&
          !(t.subtasks || []).length &&
          parseContactParentDescription(t.description)?.contactId === String(contact.id),
      ) ||
      open.find(
        (t) =>
          String(t.id) !== completedId &&
          !(t.subtasks || []).length &&
          String(t.text || '') === wantTitle,
      );
    return host?.id ? String(host.id) : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} vikunjaId
 * @param {NodeJS.ProcessEnv} env
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
    await completeTodoQuiet(vid, env);
  }
  const parentId = String(contact.vikunjaParentTaskId || '').trim();
  if (parentId) await completeTodoQuiet(parentId, env);
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
