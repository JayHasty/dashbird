/**
 * Cloud-only trusted-device bypass: signed httpOnly cookie for allowlisted
 * device IDs only (Jay's home Linux laptop + phone). Disabled when
 * DASHBOARD_TRUSTED_DEVICE_SECRET is unset (LAN).
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const TRUSTED_DEVICE_COOKIE = 'dashbird_trusted';
export const DEVICE_ID_COOKIE = 'dashbird_did';
const COOKIE_VERSION = 'v1';
const DEFAULT_MAX_AGE_DAYS = 365;

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

/** True when cloud trusted-device gate should run (never on default LAN compose). */
export function isTrustedDeviceAuthEnabled() {
  const secret = readEnv('DASHBOARD_TRUSTED_DEVICE_SECRET');
  const user = readEnv('DASHBOARD_BASIC_AUTH_USER');
  const hash = readEnv('DASHBOARD_BASIC_AUTH_HASH');
  return Boolean(secret && user && hash);
}

function trustedDeviceSecret() {
  return readEnv('DASHBOARD_TRUSTED_DEVICE_SECRET');
}

/** @returns {Set<string>} */
export function trustedDeviceIdAllowlist() {
  const raw = readEnv('DASHBOARD_TRUSTED_DEVICE_IDS');
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowlistedDeviceId(deviceId) {
  const id = String(deviceId || '').trim().toLowerCase();
  if (!id) return false;
  const list = trustedDeviceIdAllowlist();
  return list.size > 0 && list.has(id);
}

function maxAgeSec() {
  const days = Number(process.env.DASHBOARD_TRUSTED_DEVICE_DAYS);
  const d = Number.isFinite(days) && days > 0 ? days : DEFAULT_MAX_AGE_DAYS;
  return Math.floor(d * 24 * 60 * 60);
}

function signPayload(expSec, deviceId) {
  const secret = trustedDeviceSecret();
  const id = String(deviceId || '').trim().toLowerCase();
  const payload = `${COOKIE_VERSION}.${expSec}.${id}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function parseBasicAuth(header) {
  const raw = String(header || '').trim();
  if (!raw.toLowerCase().startsWith('basic ')) return null;
  try {
    const decoded = Buffer.from(raw.slice(6).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) return null;
    return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

function readCookieValue(cookieHeader, name) {
  const raw = String(cookieHeader || '');
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1].trim());
  } catch {
    return '';
  }
}

export function parseDeviceIdFromCookie(cookieHeader) {
  return readCookieValue(cookieHeader, DEVICE_ID_COOKIE);
}

export function verifyTrustedDeviceCookie(cookieHeader) {
  if (!isTrustedDeviceAuthEnabled()) return false;
  const value = readCookieValue(cookieHeader, TRUSTED_DEVICE_COOKIE);
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  const [version, expRaw, deviceId, sig] = parts;
  if (version !== COOKIE_VERSION) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  if (!isAllowlistedDeviceId(deviceId)) return false;
  const expected = signPayload(exp, deviceId);
  const expectedSig = expected.split('.').pop();
  try {
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expectedSig, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Avoid bcrypt.compare stampedes when Firefox retries many assets with Basic auth. */
const BASIC_AUTH_OK_TTL_MS = 60_000;
/** @type {Map<string, number>} */
const basicAuthOkUntil = new Map();

function basicAuthCacheKey(authHeader) {
  return crypto.createHash('sha256').update(String(authHeader || '')).digest('hex');
}

export async function verifyBasicAuthCredentials(authHeader) {
  if (!isTrustedDeviceAuthEnabled()) return false;
  const cacheKey = basicAuthCacheKey(authHeader);
  const cachedUntil = basicAuthOkUntil.get(cacheKey) || 0;
  if (cachedUntil > Date.now()) return true;
  const creds = parseBasicAuth(authHeader);
  if (!creds) return false;
  const expectedUser = readEnv('DASHBOARD_BASIC_AUTH_USER');
  const hash = readEnv('DASHBOARD_BASIC_AUTH_HASH');
  if (creds.user !== expectedUser) return false;
  try {
    const ok = await bcrypt.compare(creds.pass, hash);
    if (ok) {
      basicAuthOkUntil.set(cacheKey, Date.now() + BASIC_AUTH_OK_TTL_MS);
      if (basicAuthOkUntil.size > 32) {
        const now = Date.now();
        for (const [k, exp] of basicAuthOkUntil) {
          if (exp <= now) basicAuthOkUntil.delete(k);
        }
      }
    }
    return ok;
  } catch {
    return false;
  }
}

export function buildTrustedDeviceSetCookie(deviceId) {
  const id = String(deviceId || '').trim().toLowerCase();
  const exp = Math.floor(Date.now() / 1000) + maxAgeSec();
  const value = signPayload(exp, id);
  const parts = [
    `${TRUSTED_DEVICE_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec()}`,
  ];
  return parts.join('; ');
}

export function buildDeviceIdSetCookie(deviceId) {
  const id = String(deviceId || '').trim().toLowerCase();
  const parts = [
    `${DEVICE_ID_COOKIE}=${encodeURIComponent(id)}`,
    'Path=/',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec()}`,
  ];
  return parts.join('; ');
}

/** Drop a non-allowlisted did so the HTML shell can self-heal on the next paint. */
export function buildClearDeviceIdSetCookie() {
  return `${DEVICE_ID_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;
}

export function trustedDeviceAuthRealm() {
  return readEnv('DASHBOARD_BASIC_AUTH_REALM') || 'Dashbird';
}

/**
 * Document shell only — JS/CSS/API still gated. Needed so phones with a junk
 * `dashbird_did` can load index.html and rewrite the cookie before asset fetches.
 */
export function isTrustedDeviceShellPath(path) {
  const p = String(path || '').split('?')[0] || '';
  return p === '/' || p === '/index.html';
}

export function isTrustedDeviceAuthExemptPath(path) {
  const p = String(path || '');
  return (
    p === '/api/trusted-device/auth' ||
    p === '/auth/device-bind' ||
    isTrustedDeviceShellPath(p)
  );
}
