/**
 * Countable signal log. Appending here does not open the goal file.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from './now-model.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export function nowSignalsPath(env = process.env) {
  const override = String(env.NOW_SIGNALS_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/now-signals.json');
}

/**
 * @param {unknown} raw
 */
export function normalizeSignalsFile(raw) {
  const list = Array.isArray(raw?.entries) ? raw.entries : [];
  const entries = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const goalId = String(row.goalId || '').trim();
    const value = Number(row.value);
    if (!goalId || !Number.isFinite(value)) continue;
    entries.push({
      id: String(row.id || '').trim() || newId(),
      goalId,
      at: String(row.at || '').trim() || new Date().toISOString(),
      value,
    });
  }
  return { entries: entries.slice(-2000) };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadNowSignals(env = process.env) {
  try {
    const raw = JSON.parse(await readFile(nowSignalsPath(env), 'utf8'));
    return normalizeSignalsFile(raw);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { entries: [] };
    throw e;
  }
}

/**
 * @param {string} goalId
 * @param {number} value
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function appendNowSignal(goalId, value, env = process.env) {
  const file = await loadNowSignals(env);
  file.entries.push({
    id: newId(),
    goalId: String(goalId || '').trim(),
    at: new Date().toISOString(),
    value: Number(value),
  });
  const dest = nowSignalsPath(env);
  await mkdir(path.dirname(dest), { recursive: true });
  const next = normalizeSignalsFile(file);
  await writeFile(dest, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
