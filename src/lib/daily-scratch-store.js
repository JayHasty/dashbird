/**
 * Persist the floating SCRATCH pad to disk so notes survive reload, devices, and day rollover.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CONTENT_MAX = 20_000;

export function dailyScratchPath(env = process.env) {
  const override = String(env.DAILY_SCRATCH_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/daily-scratch.json');
}

/**
 * @returns {{ content: string, updatedAt: string }}
 */
function emptyState() {
  return { content: '', updatedAt: '' };
}

/**
 * @param {unknown} raw
 * @returns {{ content: string, updatedAt: string }}
 */
function normalize(raw) {
  const content = String(raw?.content ?? '').slice(0, CONTENT_MAX);
  const updatedAt = String(raw?.updatedAt || '');
  return { content, updatedAt };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ content: string, updatedAt: string }>}
 */
export async function loadDailyScratchFile(env = process.env) {
  const live = dailyScratchPath(env);
  try {
    const raw = JSON.parse(await fs.readFile(live, 'utf8'));
    return normalize(raw);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return emptyState();
    throw e;
  }
}

/**
 * @param {string} content
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ content: string, updatedAt: string }>}
 */
export async function saveDailyScratchFile(content, env = process.env) {
  const live = dailyScratchPath(env);
  const record = {
    content: String(content ?? '').slice(0, CONTENT_MAX),
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(live), { recursive: true });
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, live);
  return record;
}

export const DAILY_SCRATCH_CONTENT_MAX = CONTENT_MAX;
