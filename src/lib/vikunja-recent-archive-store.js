/**
 * Last 20 completed Tasks-panel items, with original project id for unarchive.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
export const RECENT_ARCHIVED_LIMIT = 20;

export function recentArchivePath(env = process.env) {
  const override = String(env.VIKUNJA_RECENT_ARCHIVE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/vikunja-recent-archive.json');
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, text: string, projectId: number | null, archivedAt: string, movedToArchive: boolean } | null}
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const text = String(raw.text || '').trim();
  const pid = raw.projectId != null ? Number(raw.projectId) : null;
  const archivedAt = String(raw.archivedAt || '').trim();
  return {
    id,
    text,
    projectId: Number.isFinite(pid) && pid > 0 ? pid : null,
    archivedAt,
    movedToArchive: Boolean(raw.movedToArchive),
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{ id: string, text: string, projectId: number | null, archivedAt: string, movedToArchive: boolean }>>}
 */
export async function loadRecentArchivedTasks(env = process.env) {
  try {
    const raw = JSON.parse(await fs.readFile(recentArchivePath(env), 'utf8'));
    const items = Array.isArray(raw?.items) ? raw.items : [];
    return items.map(normalizeItem).filter(Boolean).slice(0, RECENT_ARCHIVED_LIMIT);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
    throw e;
  }
}

/**
 * @param {Array<{ id: string, text: string, projectId: number | null, archivedAt: string, movedToArchive: boolean }>} items
 * @param {NodeJS.ProcessEnv} [env]
 */
async function saveRecentArchivedTasks(items, env = process.env) {
  const live = recentArchivePath(env);
  await fs.mkdir(path.dirname(live), { recursive: true });
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ items }, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, live);
}

/**
 * @param {{ id: string, text?: string, projectId?: number | null, archivedAt?: string, movedToArchive?: boolean }} entry
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function recordRecentArchivedTask(entry, env = process.env) {
  const item = normalizeItem({
    ...entry,
    archivedAt: entry.archivedAt || new Date().toISOString(),
  });
  if (!item) return loadRecentArchivedTasks(env);
  const prev = await loadRecentArchivedTasks(env);
  const next = [item, ...prev.filter((it) => it.id !== item.id)].slice(0, RECENT_ARCHIVED_LIMIT);
  await saveRecentArchivedTasks(next, env);
  return next;
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function removeRecentArchivedTask(id, env = process.env) {
  const taskId = String(id || '').trim();
  const prev = await loadRecentArchivedTasks(env);
  const next = prev.filter((it) => it.id !== taskId);
  if (next.length !== prev.length) await saveRecentArchivedTasks(next, env);
  return next;
}
