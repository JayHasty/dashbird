/**
 * Caddy forward_auth + Express fallback for cloud trusted-device cookie gate.
 * Only Jay's allowlisted device IDs (home Linux laptop + phone) get passwordless access.
 */
import { Router } from 'express';
import {
  buildClearDeviceIdSetCookie,
  buildDeviceIdSetCookie,
  buildTrustedDeviceSetCookie,
  isAllowlistedDeviceId,
  isTrustedDeviceAuthEnabled,
  isTrustedDeviceAuthExemptPath,
  isTrustedDeviceShellPath,
  parseDeviceIdFromCookie,
  trustedDeviceAuthRealm,
  verifyBasicAuthCredentials,
  verifyTrustedDeviceCookie,
} from '../lib/trusted-device-auth.js';

const router = Router();

function sendUnauthorized(res) {
  res.setHeader('WWW-Authenticate', `Basic realm="${trustedDeviceAuthRealm()}", charset="UTF-8"`);
  res.status(401).send('Unauthorized');
}

// Simple in-memory rate limiter for the (auth-exempt) device-bind endpoint. Device UUIDs
// live in docs, so binding must not be brute-forceable by anyone who learns/guesses one.
const BIND_WINDOW_MS = 10 * 60 * 1000;
const BIND_MAX_ATTEMPTS = 10;
/** @type {Map<string, { count: number, resetAt: number }>} */
const bindAttempts = new Map();

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || 'unknown';
}

/** @returns {boolean} true when the caller is over the limit */
function bindRateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = bindAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    bindAttempts.set(ip, { count: 1, resetAt: now + BIND_WINDOW_MS });
    if (bindAttempts.size > 5000) {
      for (const [k, v] of bindAttempts) if (now > v.resetAt) bindAttempts.delete(k);
    }
    return false;
  }
  rec.count += 1;
  return rec.count > BIND_MAX_ATTEMPTS;
}

function appendTrustCookies(res, deviceId) {
  res.append('Set-Cookie', buildDeviceIdSetCookie(deviceId));
  res.append('Set-Cookie', buildTrustedDeviceSetCookie(deviceId));
}

/** One-time bookmark: binds an allowlisted device ID and skips future password prompts. */
export async function deviceBindHandler(req, res) {
  if (!isTrustedDeviceAuthEnabled()) {
    res.redirect(302, '/');
    return;
  }
  if (bindRateLimited(req)) {
    res.status(429).type('text/plain').send('Too many device-bind attempts. Try again later.');
    return;
  }
  // Already-trusted devices can re-bind without re-entering the password.
  const alreadyTrusted = verifyTrustedDeviceCookie(req.headers.cookie);
  // Otherwise require one basic-auth challenge before binding. This closes the hole where
  // knowing an allowlisted UUID alone (they live in docs) granted passwordless access.
  if (!alreadyTrusted) {
    const authHeader = req.headers.authorization || req.headers['x-forwarded-authorization'];
    if (!(await verifyBasicAuthCredentials(authHeader))) {
      sendUnauthorized(res);
      return;
    }
  }
  const did = String(req.query.did || parseDeviceIdFromCookie(req.headers.cookie) || '').trim().toLowerCase();
  if (!isAllowlistedDeviceId(did)) {
    res.status(403).type('text/plain').send('Device ID not allowlisted. Set DASHBOARD_TRUSTED_DEVICE_IDS on the server.');
    return;
  }
  appendTrustCookies(res, did);
  res.type('html').send(renderDeviceBindPage(did));
}

function renderDeviceBindPage(deviceId) {
  const safeId = String(deviceId || '').replace(/[<>&"]/g, '');
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>dashbird — device trusted</title>
    <link rel="stylesheet" href="/styles.css?v=dev-link-1" />
  </head>
  <body class="dashy dashy--device-bind">
    <header class="topbar glass" role="banner">
      <div class="topbar__head">
        <span class="brand">dashbird</span>
      </div>
    </header>
    <main class="device-bind-page">
      <p class="device-bind-page__title">This device is trusted</p>
      <p class="device-bind-page__hint">ID <code>${safeId}</code> — no password on later visits.</p>
      <p><a class="device-bind-page__continue" href="/">Open dashboard</a></p>
    </main>
    <script>
      try { localStorage.setItem('dashbird_did', ${JSON.stringify(deviceId)}); } catch (e) {}
    </script>
  </body>
</html>`;
}

function forwardedRequestPath(req) {
  const uri = String(req.headers['x-forwarded-uri'] || '');
  if (uri) return uri.split('?')[0] || '/';
  return String(req.path || '');
}

function forwardedMethod(req) {
  return String(req.headers['x-forwarded-method'] || req.method || 'GET').toUpperCase();
}

function clearJunkDeviceIdCookie(res, deviceId) {
  if (deviceId && !isAllowlistedDeviceId(deviceId)) {
    res.append('Set-Cookie', buildClearDeviceIdSetCookie());
  }
}

/** Caddy forward_auth subrequest — 2xx allows the original request through. */
router.all('/auth', async (req, res) => {
  if (!isTrustedDeviceAuthEnabled()) {
    res.status(200).end();
    return;
  }
  if (verifyTrustedDeviceCookie(req.headers.cookie)) {
    res.status(200).end();
    return;
  }
  const deviceId = parseDeviceIdFromCookie(req.headers.cookie);
  if (isAllowlistedDeviceId(deviceId)) {
    appendTrustCookies(res, deviceId);
    res.status(200).end();
    return;
  }
  const method = forwardedMethod(req);
  if ((method === 'GET' || method === 'HEAD') && isTrustedDeviceShellPath(forwardedRequestPath(req))) {
    clearJunkDeviceIdCookie(res, deviceId);
    res.status(200).end();
    return;
  }
  const authHeader = req.headers.authorization || req.headers['x-forwarded-authorization'];
  if (await verifyBasicAuthCredentials(authHeader)) {
    if (isAllowlistedDeviceId(deviceId)) {
      appendTrustCookies(res, deviceId);
    }
    res.status(200).end();
    return;
  }
  clearJunkDeviceIdCookie(res, deviceId);
  sendUnauthorized(res);
});

export function trustedDeviceGateMiddleware() {
  return async (req, res, next) => {
    if (!isTrustedDeviceAuthEnabled()) {
      next();
      return;
    }
    if (isTrustedDeviceAuthExemptPath(req.path)) {
      const deviceId = parseDeviceIdFromCookie(req.headers.cookie);
      clearJunkDeviceIdCookie(res, deviceId);
      next();
      return;
    }
    if (verifyTrustedDeviceCookie(req.headers.cookie)) {
      next();
      return;
    }
    const deviceId = parseDeviceIdFromCookie(req.headers.cookie);
    if (isAllowlistedDeviceId(deviceId)) {
      appendTrustCookies(res, deviceId);
      next();
      return;
    }
    const authHeader = req.headers.authorization || req.headers['x-forwarded-authorization'];
    if (await verifyBasicAuthCredentials(authHeader)) {
      if (isAllowlistedDeviceId(deviceId)) {
        appendTrustCookies(res, deviceId);
      }
      next();
      return;
    }
    clearJunkDeviceIdCookie(res, deviceId);
    sendUnauthorized(res);
  };
}

export default router;
