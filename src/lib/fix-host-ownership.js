/**
 * When the dashboard container runs as root but data/ is bind-mounted from the host,
 * chown paths to DASHBOARD_HOST_UID so Jay can browse/edit without sudo.
 */
import { chown } from 'node:fs/promises';

/**
 * @param {string | string[]} paths
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function fixHostOwnership(paths, env = process.env) {
  const uid = Number(env.DASHBOARD_HOST_UID);
  if (!Number.isFinite(uid) || uid <= 0 || typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return;
  }
  const list = Array.isArray(paths) ? paths : [paths];
  for (const p of list) {
    if (!p) continue;
    try {
      await chown(p, uid, uid);
    } catch {
      // best effort
    }
  }
}
