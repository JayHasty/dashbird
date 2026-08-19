/**
 * Rain-alert street address (persisted). Used by aircraft-nearby and legacy clients;
 * hero rain alert prefers live GPS / dashboard WEATHER_ZIP.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SEED_PATH = path.join(PKG_ROOT, 'src/data/rain-alert-address.default.json');

const DEFAULT_ADDRESS = '';

export function rainAlertAddressPath(env = process.env) {
  const override = String(env.RAIN_ALERT_ADDRESS_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/rain-alert-address.json');
}

async function ensureFile() {
  const live = rainAlertAddressPath();
  try {
    await fs.access(live);
    return live;
  } catch {
    await fs.mkdir(path.dirname(live), { recursive: true });
    try {
      await fs.copyFile(SEED_PATH, live);
    } catch {
      const body = `${JSON.stringify({ address: DEFAULT_ADDRESS }, null, 2)}\n`;
      await fs.writeFile(live, body, 'utf8');
    }
    return live;
  }
}

/**
 * @returns {Promise<string>}
 */
export async function loadRainAlertAddress() {
  const fromEnv = String(process.env.RAIN_ALERT_ADDRESS || '').trim();
  if (fromEnv) return fromEnv;
  const live = await ensureFile();
  const j = JSON.parse(await fs.readFile(live, 'utf8'));
  const addr = String(j?.address || '').trim();
  return addr || DEFAULT_ADDRESS;
}

/**
 * @param {string} address
 */
export async function saveRainAlertAddress(address) {
  const addr = String(address || '').trim();
  if (!addr || addr.length > 240) {
    return { ok: false, error: 'invalid_address' };
  }
  const live = await ensureFile();
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ address: addr }, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, live);
  return { ok: true, address: addr };
}
