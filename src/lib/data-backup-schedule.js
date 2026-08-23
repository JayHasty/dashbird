/**
 * Scheduled backups:
 * - Daily full data tarball → data/backups/daily-YYYY-MM-DD.tar.gz (default 03:15 local)
 * - Weekly Tool Library + Network → data/backups/tools-contacts-YYYY-MM-DD/ (default Sun 03:00)
 *
 * Daily tarball also includes public bookmarks (personal + work) and notes.md.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { toolLibraryPath, toolLibraryAssetsDir } from './tool-library-store.js';
import { networkDbPath } from './network-db.js';
import { networkAssetsDir } from './network-contacts-store.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

// Every SQLite store that must be captured as a consistent snapshot (VACUUM INTO works
// with WAL). Nested paths (Vikunja) are relative to data/ and preserved inside the tar.
const DAILY_SQLITE_DBS = [
  'network.db',
  'events-finder.db',
  'telegram-intake.db',
  'dev-requests.db',
  'vikunja/db/vikunja.db',
];

const DAILY_PUBLIC_FILES = [
  'public/data/bookmarks-personal.json',
  'public/data/bookmarks-work.json',
  'public/data/notes.md',
];

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dataBackupWeeklyEnabled(env = process.env) {
  return String(env.DATA_BACKUP_WEEKLY ?? '1').trim() !== '0';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dataBackupDailyEnabled(env = process.env) {
  return String(env.DATA_BACKUP_DAILY ?? '1').trim() !== '0';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function dataBackupTz(env = process.env) {
  return (
    String(env.DATA_BACKUP_WEEKLY_TZ || env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles'
  );
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ dow: number, hour: number, minute: number }}
 */
function dataBackupWhen(env = process.env) {
  const dowRaw = Number(env.DATA_BACKUP_WEEKLY_DOW);
  const hourRaw = Number(env.DATA_BACKUP_WEEKLY_HOUR);
  const minuteRaw = Number(env.DATA_BACKUP_WEEKLY_MINUTE);
  return {
    // Default Sunday (0)
    dow: Number.isFinite(dowRaw) && dowRaw >= 0 && dowRaw <= 6 ? Math.round(dowRaw) : 0,
    hour: Number.isFinite(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? Math.round(hourRaw) : 3,
    minute: Number.isFinite(minuteRaw) && minuteRaw >= 0 && minuteRaw <= 59 ? Math.round(minuteRaw) : 0,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dataBackupDir(env = process.env) {
  const override = String(env.DATA_BACKUP_DIR || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data', 'backups');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function dataBackupRetain(env = process.env) {
  const n = Number(env.DATA_BACKUP_RETAIN);
  if (Number.isFinite(n) && n >= 1 && n <= 52) return Math.round(n);
  return 8;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ hour: number, minute: number }}
 */
function dataBackupDailyWhen(env = process.env) {
  const hourRaw = Number(env.DATA_BACKUP_DAILY_HOUR);
  const minuteRaw = Number(env.DATA_BACKUP_DAILY_MINUTE);
  return {
    hour: Number.isFinite(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? Math.round(hourRaw) : 3,
    minute: Number.isFinite(minuteRaw) && minuteRaw >= 0 && minuteRaw <= 59 ? Math.round(minuteRaw) : 15,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function dataBackupDailyRetain(env = process.env) {
  const n = Number(env.DATA_BACKUP_DAILY_RETAIN);
  if (Number.isFinite(n) && n >= 1 && n <= 90) return Math.round(n);
  return 14;
}

/**
 * Local calendar parts in the schedule timezone.
 * @param {Date} [now]
 * @param {string} [timeZone]
 */
export function dataBackupLocalParts(now = new Date(), timeZone = 'America/Los_Angeles') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  /** @type {Record<string, string>} */
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: wd[map.weekday] ?? -1,
    year: map.year,
    month: map.month,
    day: map.day,
    hour: Number(map.hour),
    minute: Number(map.minute),
    ymd: `${map.year}-${map.month}-${map.day}`,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Date} [now]
 */
export function shouldRunDataBackupWeekly(env = process.env, now = new Date()) {
  if (!dataBackupWeeklyEnabled(env)) return false;
  const when = dataBackupWhen(env);
  const local = dataBackupLocalParts(now, dataBackupTz(env));
  if (local.dow !== when.dow) return false;
  if (local.hour !== when.hour) return false;
  if (local.minute < when.minute || local.minute > when.minute + 1) return false;
  return true;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Date} [now]
 */
export function shouldRunDataBackupDaily(env = process.env, now = new Date()) {
  if (!dataBackupDailyEnabled(env)) return false;
  const when = dataBackupDailyWhen(env);
  const local = dataBackupLocalParts(now, dataBackupTz(env));
  if (local.hour !== when.hour) return false;
  if (local.minute < when.minute || local.minute > when.minute + 1) return false;
  return true;
}

/**
 * Escape a path for use inside a single-quoted SQLite string literal.
 * @param {string} p
 */
function sqlQuotePath(p) {
  return `'${String(p).replace(/'/g, "''")}'`;
}

/**
 * @param {string} src
 * @param {string} dest
 */
async function copyIfExists(src, dest) {
  try {
    await fsPromises.access(src);
  } catch {
    return false;
  }
  await fsPromises.mkdir(path.dirname(dest), { recursive: true });
  await fsPromises.cp(src, dest, { recursive: true, force: true, errorOnExist: false });
  return true;
}

/**
 * Consistent SQLite snapshot via VACUUM INTO (works with WAL).
 * @param {string} srcDb
 * @param {string} destDb
 */
function backupSqliteDb(srcDb, destDb) {
  if (!fs.existsSync(srcDb)) return false;
  fs.mkdirSync(path.dirname(destDb), { recursive: true });
  if (fs.existsSync(destDb)) fs.unlinkSync(destDb);
  const db = new DatabaseSync(srcDb);
  try {
    db.exec(`VACUUM INTO ${sqlQuotePath(destDb)}`);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return true;
}

/**
 * @param {string} dir
 * @param {number} retain
 */
async function pruneOldBackups(dir, retain) {
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const folders = entries
    .filter((e) => e.isDirectory() && /^tools-contacts-\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const name of folders.slice(retain)) {
    await fsPromises.rm(path.join(dir, name), { recursive: true, force: true });
  }
}

/**
 * @param {string} dir
 * @param {number} retain
 */
async function pruneOldDailyBackups(dir, retain) {
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = entries
    .filter((e) => e.isFile() && /^daily-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const name of files.slice(retain)) {
    await fsPromises.rm(path.join(dir, name), { force: true });
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} iso
 */
async function writeLastBackupStamp(env, iso) {
  const stampPath = path.join(PKG_ROOT, 'public', 'data', 'last-backup.txt');
  await fsPromises.mkdir(path.dirname(stampPath), { recursive: true });
  await fsPromises.writeFile(stampPath, `${iso}\n`, 'utf8');
  // Keep process.env in sync for /api/config within this process.
  env.LAST_BACKUP_AT = iso;
}

/**
 * Run one tools + contacts backup into data/backups/tools-contacts-YYYY-MM-DD/.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ ymd?: string }} [opts]
 * @returns {Promise<{ ok: boolean, dir?: string, ymd?: string, error?: string, copied?: Record<string, boolean> }>}
 */
export async function runToolsContactsBackup(env = process.env, opts = {}) {
  const tz = dataBackupTz(env);
  const ymd = opts.ymd || dataBackupLocalParts(new Date(), tz).ymd;
  const root = dataBackupDir(env);
  const destDir = path.join(root, `tools-contacts-${ymd}`);
  const staging = `${destDir}.tmp.${process.pid}.${Date.now()}`;

  try {
    await fsPromises.mkdir(staging, { recursive: true });

    const copied = {
      toolLibrary: false,
      toolLibraryAssets: false,
      networkDb: false,
      networkAssets: false,
    };

    copied.toolLibrary = await copyIfExists(
      toolLibraryPath(env),
      path.join(staging, 'tool-library.json'),
    );
    copied.toolLibraryAssets = await copyIfExists(
      toolLibraryAssetsDir(env),
      path.join(staging, 'tool-library-assets'),
    );
    copied.networkDb = backupSqliteDb(networkDbPath(env), path.join(staging, 'network.db'));
    copied.networkAssets = await copyIfExists(
      networkAssetsDir(env),
      path.join(staging, 'network-assets'),
    );

    const iso = new Date().toISOString();
    const manifest = {
      kind: 'tools-contacts',
      ymd,
      createdAt: iso,
      timeZone: tz,
      sources: {
        toolLibrary: toolLibraryPath(env),
        toolLibraryAssets: toolLibraryAssetsDir(env),
        networkDb: networkDbPath(env),
        networkAssets: networkAssetsDir(env),
      },
      copied,
    };
    await fsPromises.writeFile(
      path.join(staging, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    await fsPromises.mkdir(root, { recursive: true });
    await fsPromises.rm(destDir, { recursive: true, force: true });
    await fsPromises.rename(staging, destDir);

    await pruneOldBackups(root, dataBackupRetain(env));
    await writeLastBackupStamp(env, iso);

    return { ok: true, dir: destDir, ymd, copied };
  } catch (e) {
    await fsPromises.rm(staging, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: e?.message || String(e), ymd };
  }
}

/**
 * Full daily tarball of data/ (+ optional public notes/bookmarks).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ ymd?: string }} [opts]
 * @returns {Promise<{ ok: boolean, file?: string, ymd?: string, error?: string, bytes?: number }>}
 */
export async function runDailyDataBackup(env = process.env, opts = {}) {
  const tz = dataBackupTz(env);
  const ymd = opts.ymd || dataBackupLocalParts(new Date(), tz).ymd;
  const root = dataBackupDir(env);
  const outFile = path.join(root, `daily-${ymd}.tar.gz`);
  const tmpFile = `${outFile}.tmp.${process.pid}.${Date.now()}`;
  const snapDir = path.join(root, `.sqlite-snap-${process.pid}-${Date.now()}`);

  try {
    await fsPromises.mkdir(root, { recursive: true });
    await fsPromises.mkdir(snapDir, { recursive: true });

    /** @type {string[]} */
    const snapNames = [];
    for (const db of DAILY_SQLITE_DBS) {
      const src = path.join(PKG_ROOT, 'data', db);
      // Per-DB fault tolerance: a failed VACUUM (e.g. Vikunja locked mid-write) must not
      // abort the whole backup — fall back to tarring the live file for that one DB.
      try {
        if (backupSqliteDb(src, path.join(snapDir, db))) snapNames.push(db);
      } catch (e) {
        console.warn(
          `[data-backup] snapshot failed for ${db}; including live file instead:`,
          e?.message || e,
        );
      }
    }

    /** @type {string[]} */
    const tarArgs = [
      '--warning=no-file-changed',
      '-czf', tmpFile, '-C', PKG_ROOT, '--exclude=data/backups',
    ];
    for (const db of snapNames) {
      tarArgs.push('--exclude', `data/${db}`, '--exclude', `data/${db}-wal`, '--exclude', `data/${db}-shm`);
    }
    tarArgs.push('data');
    for (const rel of DAILY_PUBLIC_FILES) {
      if (fs.existsSync(path.join(PKG_ROOT, rel))) tarArgs.push(rel);
    }
    if (snapNames.length) {
      tarArgs.push('-C', snapDir, '--transform', 's,^,data/,', ...snapNames);
    }

    const result = spawnSync('tar', tarArgs, { encoding: 'utf8' });
    let tarOk = false;
    try {
      const st = await fsPromises.stat(tmpFile);
      tarOk = st.isFile() && st.size > 0;
    } catch {
      tarOk = false;
    }
    if (!tarOk && result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      throw new Error(detail || `tar exited ${result.status}`);
    }

    await fsPromises.rm(outFile, { force: true });
    await fsPromises.rename(tmpFile, outFile);
    await fsPromises.rm(snapDir, { recursive: true, force: true });

    const st = await fsPromises.stat(outFile);
    await pruneOldDailyBackups(root, dataBackupDailyRetain(env));
    await writeLastBackupStamp(env, new Date().toISOString());

    return { ok: true, file: outFile, ymd, bytes: st.size };
  } catch (e) {
    await fsPromises.rm(tmpFile, { force: true });
    await fsPromises.rm(snapDir, { recursive: true, force: true });
    return { ok: false, error: e?.message || String(e), ymd };
  }
}

/** @type {string | null} */
let lastBackupYmd = null;
/** @type {string | null} */
let lastDailyBackupYmd = null;
/** @type {ReturnType<typeof setInterval> | null} */
let backupTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let dailyBackupTimer = null;
let backupInFlight = false;
let dailyBackupInFlight = false;

/**
 * Seed same-day dedupe from an existing backup folder (survives restarts).
 * @param {NodeJS.ProcessEnv} [env]
 */
async function seedLastBackupYmd(env = process.env) {
  const tz = dataBackupTz(env);
  const when = dataBackupWhen(env);
  const nowLocal = dataBackupLocalParts(new Date(), tz);
  const expected = path.join(dataBackupDir(env), `tools-contacts-${nowLocal.ymd}`);
  try {
    const st = await fsPromises.stat(expected);
    if (!st.isDirectory()) return;
    const afterSlot =
      nowLocal.hour > when.hour
      || (nowLocal.hour === when.hour && nowLocal.minute >= when.minute);
    if (nowLocal.dow === when.dow && afterSlot) {
      lastBackupYmd = nowLocal.ymd;
    }
  } catch {
    /* no backup yet today */
  }
}

/**
 * Start weekly tools + contacts backup scheduler.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startToolsContactsBackupScheduler(env = process.env) {
  if (!dataBackupWeeklyEnabled(env)) {
    console.log('[data-backup] weekly tools+contacts backup disabled');
    return;
  }
  if (backupTimer) return;

  const when = dataBackupWhen(env);
  const tz = dataBackupTz(env);
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const whenLabel = `${dowNames[when.dow]} ${String(when.hour).padStart(2, '0')}:${String(when.minute).padStart(2, '0')}`;
  console.log(`[data-backup] weekly tools+contacts: ${whenLabel} ${tz} → ${dataBackupDir(env)}`);

  const tick = async () => {
    if (backupInFlight) return;
    if (!shouldRunDataBackupWeekly(env)) return;
    const ymd = dataBackupLocalParts(new Date(), tz).ymd;
    if (lastBackupYmd === ymd) return;
    backupInFlight = true;
    lastBackupYmd = ymd;
    console.log(`[data-backup] weekly backup starting (${ymd})`);
    try {
      const result = await runToolsContactsBackup(env, { ymd });
      if (result.ok) {
        console.log(`[data-backup] weekly backup done → ${result.dir}`);
      } else {
        console.warn(`[data-backup] weekly backup failed: ${result.error}`);
        lastBackupYmd = null;
      }
    } catch (e) {
      console.warn('[data-backup] weekly backup failed', e?.message || e);
      lastBackupYmd = null;
    } finally {
      backupInFlight = false;
    }
  };

  void seedLastBackupYmd(env).catch(() => {});

  backupTimer = setInterval(() => {
    void tick();
  }, 60_000);
  if (typeof backupTimer.unref === 'function') backupTimer.unref();
  setTimeout(() => {
    void tick();
  }, 20_000);
}

/**
 * Seed same-day dedupe from an existing daily tarball (survives restarts).
 * @param {NodeJS.ProcessEnv} [env]
 */
async function seedLastDailyBackupYmd(env = process.env) {
  const tz = dataBackupTz(env);
  const when = dataBackupDailyWhen(env);
  const nowLocal = dataBackupLocalParts(new Date(), tz);
  const expected = path.join(dataBackupDir(env), `daily-${nowLocal.ymd}.tar.gz`);
  try {
    const st = await fsPromises.stat(expected);
    if (!st.isFile()) return;
    const afterSlot =
      nowLocal.hour > when.hour
      || (nowLocal.hour === when.hour && nowLocal.minute >= when.minute);
    if (afterSlot) lastDailyBackupYmd = nowLocal.ymd;
  } catch {
    /* no daily backup yet today */
  }
}

/**
 * Run one daily backup now, sharing the in-flight/dedupe guards with the scheduler.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} ymd
 * @param {string} reason
 */
async function runDailyBackupGuarded(env, ymd, reason) {
  if (dailyBackupInFlight) return;
  if (lastDailyBackupYmd === ymd) return;
  dailyBackupInFlight = true;
  lastDailyBackupYmd = ymd;
  console.log(`[data-backup] daily backup starting (${ymd}) [${reason}]`);
  try {
    const result = await runDailyDataBackup(env, { ymd });
    if (result.ok) {
      const mb = result.bytes ? (result.bytes / (1024 * 1024)).toFixed(1) : '?';
      console.log(`[data-backup] daily backup done → ${result.file} (${mb} MB)`);
    } else {
      console.warn(`[data-backup] daily backup failed: ${result.error}`);
      lastDailyBackupYmd = null;
    }
  } catch (e) {
    console.warn('[data-backup] daily backup failed', e?.message || e);
    lastDailyBackupYmd = null;
  } finally {
    dailyBackupInFlight = false;
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function dataBackupCatchUpEnabled(env = process.env) {
  return String(env.DATA_BACKUP_CATCHUP ?? '1').trim() !== '0';
}

/**
 * If the process was down at the scheduled minute, the daily backup would be skipped
 * for the whole day (this is how daily-2026-07-18 went missing). On startup, if we are
 * already past today's slot and no tarball exists yet, run one immediately.
 * @param {NodeJS.ProcessEnv} [env]
 */
async function maybeCatchUpDailyBackup(env = process.env) {
  if (!dataBackupCatchUpEnabled(env)) return;
  const tz = dataBackupTz(env);
  const when = dataBackupDailyWhen(env);
  const nowLocal = dataBackupLocalParts(new Date(), tz);
  const pastSlot =
    nowLocal.hour > when.hour
    || (nowLocal.hour === when.hour && nowLocal.minute >= when.minute);
  if (!pastSlot) return;
  if (lastDailyBackupYmd === nowLocal.ymd) return;
  const expected = path.join(dataBackupDir(env), `daily-${nowLocal.ymd}.tar.gz`);
  if (fs.existsSync(expected)) {
    lastDailyBackupYmd = nowLocal.ymd;
    return;
  }
  console.log(`[data-backup] catch-up: no daily backup for ${nowLocal.ymd} and slot has passed`);
  await runDailyBackupGuarded(env, nowLocal.ymd, 'startup catch-up');
}

/**
 * Start daily full-data backup scheduler.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startDailyDataBackupScheduler(env = process.env) {
  if (!dataBackupDailyEnabled(env)) {
    console.log('[data-backup] daily full-data backup disabled');
    return;
  }
  if (dailyBackupTimer) return;

  const when = dataBackupDailyWhen(env);
  const tz = dataBackupTz(env);
  const whenLabel = `${String(when.hour).padStart(2, '0')}:${String(when.minute).padStart(2, '0')}`;
  console.log(`[data-backup] daily full-data: ${whenLabel} ${tz} → ${dataBackupDir(env)}/daily-YYYY-MM-DD.tar.gz`);

  const tick = async () => {
    if (!shouldRunDataBackupDaily(env)) return;
    const ymd = dataBackupLocalParts(new Date(), tz).ymd;
    await runDailyBackupGuarded(env, ymd, 'scheduled');
  };

  void seedLastDailyBackupYmd(env)
    .then(() => maybeCatchUpDailyBackup(env))
    .catch(() => {});

  dailyBackupTimer = setInterval(() => {
    void tick();
  }, 60_000);
  if (typeof dailyBackupTimer.unref === 'function') dailyBackupTimer.unref();
  setTimeout(() => {
    void tick();
  }, 25_000);
}

/** @type {ReturnType<typeof setInterval> | null} */
let stalenessTimer = null;
/** @type {string | null} */
let lastStaleAlertYmd = null;

/**
 * Newest local daily tarball age in hours, or null if none exist.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number | null>}
 */
export async function newestDailyBackupAgeHours(env = process.env) {
  const dir = dataBackupDir(env);
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newestMs = 0;
  for (const e of entries) {
    if (!e.isFile() || !/^daily-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(e.name)) continue;
    try {
      const st = await fsPromises.stat(path.join(dir, e.name));
      if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
    } catch {
      /* ignore */
    }
  }
  if (!newestMs) return null;
  return (Date.now() - newestMs) / (1000 * 60 * 60);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function backupMaxAgeHours(env = process.env) {
  const n = Number(env.DATA_BACKUP_MAX_AGE_HOURS);
  if (Number.isFinite(n) && n >= 1 && n <= 24 * 30) return n;
  return 26;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function backupAlertChatId(env = process.env) {
  const explicit = String(env.DATA_BACKUP_ALERT_CHAT_ID || '').trim();
  if (explicit) return explicit;
  // Fall back to the first Telegram allowlisted chat so alerts land in Jay's DM.
  const allowed = String(env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed[0] || '';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} text
 */
async function sendBackupAlert(env, text) {
  const chatId = backupAlertChatId(env);
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!chatId || !token) {
    console.warn(`[data-backup] ALERT (no Telegram target configured): ${text}`);
    return;
  }
  try {
    const { telegramSendMessage } = await import('./events-finder-telegram.js');
    await telegramSendMessage(chatId, `⚠️ Dashbird backup alert\n${text}`, env);
  } catch (e) {
    console.warn('[data-backup] failed to send backup alert', e?.message || e);
  }
}

/**
 * Periodically verify a recent backup exists; alert once/day if stale. This is what
 * turns a silently-missing backup (down process, full disk, tar failure) into a signal.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startBackupStalenessMonitor(env = process.env) {
  if (String(env.DATA_BACKUP_ALERT_ENABLED ?? '1').trim() === '0') {
    console.log('[data-backup] staleness monitor disabled');
    return;
  }
  if (stalenessTimer) return;
  const maxAge = backupMaxAgeHours(env);
  console.log(`[data-backup] staleness monitor: alert if newest daily backup older than ${maxAge}h`);

  const check = async () => {
    try {
      const ageH = await newestDailyBackupAgeHours(env);
      const tz = dataBackupTz(env);
      const ymd = dataBackupLocalParts(new Date(), tz).ymd;
      if (ageH === null) {
        if (lastStaleAlertYmd !== ymd) {
          lastStaleAlertYmd = ymd;
          await sendBackupAlert(env, `No daily backup found in ${dataBackupDir(env)}.`);
        }
        return;
      }
      if (ageH > maxAge) {
        if (lastStaleAlertYmd !== ymd) {
          lastStaleAlertYmd = ymd;
          await sendBackupAlert(
            env,
            `Newest daily backup is ${ageH.toFixed(1)}h old (limit ${maxAge}h). Check the container and disk.`,
          );
        }
      } else {
        lastStaleAlertYmd = null;
      }
    } catch (e) {
      console.warn('[data-backup] staleness check failed', e?.message || e);
    }
  };

  stalenessTimer = setInterval(() => {
    void check();
  }, 60 * 60 * 1000);
  if (typeof stalenessTimer.unref === 'function') stalenessTimer.unref();
  // First check ~2 min after boot, after the catch-up has had a chance to run.
  setTimeout(() => {
    void check();
  }, 120_000);
}
