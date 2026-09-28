/**
 * Operational Now state: parents, inbox, holes, pin. Not the goal list.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, normalizeGoal, normalizeHole, normalizeParent, normalizeSource } from './now-model.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export function nowStatePath(env = process.env) {
  const override = String(env.NOW_STATE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/now.json');
}

function emptyState() {
  return { parents: [], inbox: [], holes: [], pin: null };
}

/**
 * @param {unknown} raw
 */
export function normalizeNowState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  base.parents = (Array.isArray(raw.parents) ? raw.parents : []).map(normalizeParent).filter(Boolean);
  base.inbox = (Array.isArray(raw.inbox) ? raw.inbox : []).map(normalizeInbox).filter(Boolean);
  base.holes = (Array.isArray(raw.holes) ? raw.holes : []).map(normalizeHole).filter(Boolean);
  const pinId = String(raw.pin?.commitmentId || '').trim();
  base.pin = pinId ? { commitmentId: pinId, setAt: String(raw.pin?.setAt || '') } : null;
  return base;
}

/**
 * @param {unknown} raw
 */
function normalizeInbox(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const note = String(raw.note || '').trim();
  if (!note) return null;
  const status = ['sorting', 'questions', 'ready', 'error'].includes(raw.status) ? raw.status : 'sorting';
  const found = (Array.isArray(raw.found) ? raw.found : [])
    .map((row) => {
      const source = normalizeSource(row);
      if (!source) return null;
      return source;
    })
    .filter(Boolean)
    .slice(0, 12);
  return {
    id: String(raw.id || '').trim() || newId(),
    note: note.slice(0, 2000),
    status,
    error: String(raw.error || '').slice(0, 240),
    draft: normalizeParent(raw.draft),
    proposedGoal: normalizeGoal(raw.proposedGoal),
    goalReason: String(raw.goalReason || '').slice(0, 240),
    questions: (Array.isArray(raw.questions) ? raw.questions : []).map(normalizeHole).filter(Boolean),
    found,
    createdAt: String(raw.createdAt || ''),
    updatedAt: String(raw.updatedAt || ''),
  };
}

let lock = Promise.resolve();

export function withNowLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadNowState(env = process.env) {
  try {
    const raw = JSON.parse(await readFile(nowStatePath(env), 'utf8'));
    return normalizeNowState(raw);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return emptyState();
    throw e;
  }
}

/**
 * @param {ReturnType<typeof normalizeNowState>} state
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveNowState(state, env = process.env) {
  const file = nowStatePath(env);
  await mkdir(path.dirname(file), { recursive: true });
  const next = normalizeNowState(state);
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
