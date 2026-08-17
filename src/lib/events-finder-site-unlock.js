/**
 * Unlock password-gated event sites (Squarespace visitor auth) for research scrapes.
 */
import { sitePasswordForUrl } from './events-finder-site-passwords.js';

/**
 * @param {Headers} headers
 * @returns {string[]}
 */
function setCookieLines(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

/**
 * @param {string[]} lines
 * @param {Map<string, string>} jar
 */
function absorbSetCookies(lines, jar) {
  for (const line of lines) {
    const pair = String(line || '').split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

/**
 * @param {Map<string, string>} jar
 * @returns {string}
 */
function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Detect Squarespace (or similar) lock-screen HTML.
 * @param {string} html
 * @returns {boolean}
 */
export function looksLikePasswordGate(html) {
  const h = String(html || '');
  if (!h) return false;
  if (/class=["'][^"']*password-form/i.test(h) && /type=["']password["']/i.test(h)) return true;
  if (/<title>[^<]*Secure[^<]*<\/title>/i.test(h) && /password-input/i.test(h)) return true;
  return false;
}

/**
 * Squarespace: GET site → POST /api/auth/visitor/site → Locked cookie.
 * @param {string} pageUrl
 * @param {string} password
 * @param {string} ua
 * @returns {Promise<string | null>} Cookie header for subsequent fetches, or null
 */
export async function unlockSquarespaceWithPassword(pageUrl, password, ua) {
  const pw = String(password || '').trim();
  if (!pw) return null;
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return null;
  }

  /** @type {Map<string, string>} */
  const jar = new Map();
  try {
    const gate = await fetch(`${origin}/`, {
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'User-Agent': ua,
      },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    absorbSetCookies(setCookieLines(gate.headers), jar);
    // Drain body so the connection can close cleanly.
    await gate.text().catch(() => '');

    const crumb = jar.get('crumb');
    /** @type {Record<string, string>} */
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': ua,
      Cookie: cookieHeader(jar),
    };
    if (crumb) headers['x-csrf-token'] = crumb;

    const auth = await fetch(`${origin}/api/auth/visitor/site`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password: pw }),
      signal: AbortSignal.timeout(12_000),
      redirect: 'manual',
    });
    absorbSetCookies(setCookieLines(auth.headers), jar);
    await auth.text().catch(() => '');

    if (!jar.has('Locked')) return null;
    return cookieHeader(jar);
  } catch {
    return null;
  }
}

/**
 * If the URL's host has a known site password, unlock and return Cookie header.
 * @param {string} pageUrl
 * @param {string} ua
 * @param {string | null | undefined} passwordOverride record-level password
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string | null>}
 */
export async function cookieJarForPasswordSite(pageUrl, ua, passwordOverride, env = process.env) {
  const pw =
    String(passwordOverride || '').trim()
    || (await sitePasswordForUrl(pageUrl, env))
    || '';
  if (!pw) return null;
  return unlockSquarespaceWithPassword(pageUrl, pw, ua);
}
