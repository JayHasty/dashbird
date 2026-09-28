/**
 * Goal list. The ranker and the signal log do not write this file.
 * Hole fills and the Goals editor do. Fills leave statement text alone.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillGoal, normalizeGoal } from './now-model.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export function nowGoalsPath(env = process.env) {
  const override = String(env.NOW_GOALS_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/now-goals.json');
}

/**
 * @param {unknown} raw
 */
export function normalizeGoalsFile(raw) {
  const list = Array.isArray(raw?.goals) ? raw.goals : Array.isArray(raw) ? raw : [];
  return { goals: list.map(normalizeGoal).filter(Boolean) };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadNowGoals(env = process.env) {
  try {
    const raw = JSON.parse(await readFile(nowGoalsPath(env), 'utf8'));
    return normalizeGoalsFile(raw);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { goals: [] };
    throw e;
  }
}

/**
 * @param {{ goals: Record<string, unknown>[] }} file
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveNowGoals(file, env = process.env) {
  const dest = nowGoalsPath(env);
  await mkdir(path.dirname(dest), { recursive: true });
  const next = normalizeGoalsFile(file);
  await writeFile(dest, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export { fillGoal };
