/**
 * Host → site-password map for Big Events research (Squarespace gates, etc.).
 * Take 3 publishes the password on their waiver; we store it so scrapes can unlock.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

/** Built-in seeds (public site gates we already know). Host without www. */
const BUILTIN_SITE_PASSWORDS = {
  'take3presents.com': 'sasquatch',
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function sitePasswordsPath(env = process.env) {
  const override = String(env.EVENTS_FINDER_SITE_PASSWORDS_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(root, override);
  }
  return path.join(root, 'data', 'events-finder-site-passwords.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Record<string, string>>}
 */
export async function loadSitePasswords(env = process.env) {
  /** @type {Record<string, string>} */
  const merged = { ...BUILTIN_SITE_PASSWORDS };
  try {
    const raw = await readFile(sitePasswordsPath(env), 'utf8');
    const data = JSON.parse(raw);
    const byHost = data?.byHost && typeof data.byHost === 'object' ? data.byHost : {};
    for (const [host, pw] of Object.entries(byHost)) {
      const h = String(host || '')
        .trim()
        .replace(/^www\./, '')
        .toLowerCase();
      const p = String(pw || '').trim();
      if (h && p) merged[h] = p;
    }
  } catch {
    /* missing file → builtins only */
  }
  return merged;
}

/**
 * Persist / update a host password (e.g. after Jay pastes one for a gated site).
 * @param {string} hostOrUrl
 * @param {string} password
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function upsertSitePassword(hostOrUrl, password, env = process.env) {
  const pw = String(password || '').trim().slice(0, 120);
  if (!pw) return { ok: false, error: 'missing_password' };
  let host = String(hostOrUrl || '').trim();
  try {
    if (/^https?:\/\//i.test(host)) host = new URL(host).hostname;
  } catch {
    return { ok: false, error: 'invalid_host' };
  }
  host = host.replace(/^www\./, '').toLowerCase().slice(0, 200);
  if (!host) return { ok: false, error: 'invalid_host' };

  const byHost = await loadSitePasswords(env);
  byHost[host] = pw;
  const target = sitePasswordsPath(env);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ byHost }, null, 2)}\n`, 'utf8');
  return { ok: true, host };
}

/**
 * @param {string} urlOrHost
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string | null>}
 */
export async function sitePasswordForUrl(urlOrHost, env = process.env) {
  let host = String(urlOrHost || '').trim();
  if (!host) return null;
  try {
    if (/^https?:\/\//i.test(host) || host.includes('/')) {
      host = new URL(host.startsWith('http') ? host : `https://${host}`).hostname;
    }
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').toLowerCase();
  if (!host) return null;
  const map = await loadSitePasswords(env);
  return map[host] || null;
}
