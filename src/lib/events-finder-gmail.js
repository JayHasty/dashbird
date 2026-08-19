/**
 * Events finder — Gmail intake (multi-account).
 * Inbox list from GMAIL_INTAKE_ADDRESSES (comma-separated). No personal defaults in-repo.
 * OAuth2 refresh tokens on disk; Gmail API list + parse (.ics / RSVP links / heuristics).
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIcsEvents } from './ical-parse.js';
import {
  eventsIngestWindowDays,
  filterEventsToIngestWindow,
} from './events-finder-window.js';
import { loadEventsFinderCriteria } from './events-finder-criteria-store.js';
import {
  isWhitelistedEventPlatformHost,
  sourceKeyForEmailPlatform,
} from './events-finder-email-platforms.js';
import {
  extractFollowableUrls,
  enrichEventsByFollowingLinks,
} from './events-finder-email-link-follow.js';
import {
  expandRecurringAndRelativeDates,
} from './events-finder-recurring-dates.js';
import {
  noteSeriesPromoFromEvents,
  expandActiveSeriesWatchesToEvents,
  huntStaleSeriesWatches,
} from './events-finder-series-renewal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

export const GMAIL_INTAKE_DEFAULT_ADDRESSES = [];
/** @deprecated use GMAIL_INTAKE_DEFAULT_ADDRESSES[0] */
export const GMAIL_INTAKE_DEFAULT_ADDRESS = '';
export const GMAIL_EVENTS_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

/** @type {Promise<object> | null} */
let gmailEventsInflight = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function gmailEventsCachePath(env = process.env) {
  const override = String(env.GMAIL_EVENTS_CACHE_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(root, override);
  }
  return path.join(root, 'data', 'gmail-events-cache.json');
}

/**
 * Disk TTL for intake parse results. IMAP is ~10–20s; do not re-hit on every sidebar open.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function gmailEventsCacheTtlMs(env = process.env) {
  const raw = Number(env.GMAIL_EVENTS_CACHE_MS);
  if (Number.isFinite(raw) && raw >= 60_000) return raw;
  return 30 * 60 * 1000;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function readGmailEventsCache(env = process.env) {
  try {
    const raw = await readFile(gmailEventsCachePath(env), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * @param {object} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeGmailEventsCache(payload, env = process.env) {
  const p = gmailEventsCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * @param {string[]} addresses
 * @param {string} query
 * @param {{ pastDays?: number, futureDays?: number, windowWeeks?: number } | null | undefined} windowDays
 */
function gmailCacheFingerprint(addresses, query, windowDays) {
  return JSON.stringify({
    addresses: [...addresses].map((a) => String(a || '').toLowerCase()).sort(),
    query: String(query || ''),
    pastDays: windowDays?.pastDays ?? null,
    futureDays: windowDays?.futureDays ?? null,
    windowWeeks: windowDays?.windowWeeks ?? null,
    // Bump when intake URL resolve / page-enrich behavior changes.
    enrich: 'link-follow-v4',
  });
}

/**
 * @param {object | null} cache
 * @param {string} fingerprint
 * @param {NodeJS.ProcessEnv} [env]
 */
function gmailCacheFresh(cache, fingerprint, env = process.env) {
  if (!cache?.cachedAt || cache.fingerprint !== fingerprint) return false;
  const age = Date.now() - Date.parse(cache.cachedAt);
  return Number.isFinite(age) && age >= 0 && age < gmailEventsCacheTtlMs(env);
}

// Wider net so we don't miss events that arrive from marketing senders (no invite
// keyword, sender not a platform domain) but carry a platform link in the body.
// Downstream parsing + enrichment still gate what becomes an event; far-future
// dated invites are kept (scrape-ahead no longer drops months-out mail).
//
// Gmail X-GM-RAW does NOT stem party→parties (confirmed). Keep explicit plurals.
const PRODUCER_GMAIL_QUERY_FRAGMENT =
  ' OR from:(take3presents.com OR take3presents.us12.list-manage.com) OR subject:("room service" OR shindig OR "request for proposals" OR "on sale")';

/** Subject tokens for DEFAULT_QUERY — exported so validations can assert coverage. */
export const GMAIL_EVENTS_SUBJECT_TERMS = [
  'invite',
  'invitation',
  'RSVP',
  'event',
  'events',
  'meetup',
  'party',
  'parties',
  'gathering',
  'gatherings',
  'celebration',
  'celebrations',
  'workshop',
  'workshops',
  'screening',
  'screenings',
  'festival',
  'festivals',
  'dates',
  'recap',
  'calendar',
  '"fall dates"',
  '"you\'re invited"',
  '"join us"',
  '"join me"',
  '"you\'re going"',
  'going',
  'attend',
  'attendance',
  'hosting',
  'ticket',
  'tickets',
  '"get tickets"',
  'register',
  'registration',
  '"save the date"',
  '"add to calendar"',
  '"mark your calendar"',
  '"reserve your spot"',
  '"happening"',
  '"request for proposals"',
  'announcement',
  '"on sale"',
  '"early bird"',
  '"pool party"',
  '"pool parties"',
  'potluck',
  'potlucks',
  'wedding',
  'weddings',
  '"want to come"',
  '"this thursday"',
  '"this friday"',
  '"this saturday"',
  '"this sunday"',
  '"this coming"',
];

/** from: hosts for DEFAULT_QUERY. */
export const GMAIL_EVENTS_FROM_HOSTS = [
  'partiful.com',
  'secretparty.io',
  'lu.ma',
  'eventbrite.com',
  'meetup.com',
  'facebookmail.com',
  'metamail.com',
  'facebook.com',
  'posh.vip',
  'dice.fm',
  'ra.co',
  'withfriends.co',
  'ticketleap.com',
  'splashthat.com',
  'take3presents.com',
  'take3presents.us12.list-manage.com',
  'bonobonetwork.com',
  'bonobonetwork.us11.list-manage.com',
  'plra.io',
  'withjoy.com',
  'fuckupnights.com',
  'mail.withjoy.com',
];

/** Body free-text terms for DEFAULT_QUERY (quoted hostnames). */
export const GMAIL_EVENTS_BODY_TERMS = [
  '"luma.com"',
  '"lu.ma"',
  '"eventbrite.com"',
  '"partiful.com"',
  '"secretparty.io"',
  '"meetup.com"',
  '"bonobonetwork.com"',
  '"plra.io"',
  '"wannaketchup.com"',
  '"withjoy.com"',
  '"fuckupnights.com"',
];

/**
 * @returns {string}
 */
export function buildDefaultGmailEventsQuery() {
  const subject = GMAIL_EVENTS_SUBJECT_TERMS.join(' OR ');
  const from = GMAIL_EVENTS_FROM_HOSTS.join(' OR ');
  const body = GMAIL_EVENTS_BODY_TERMS.join(' OR ');
  return `newer_than:60d (filename:ics OR subject:(${subject}) OR from:(${from}) OR ${body})${PRODUCER_GMAIL_QUERY_FRAGMENT}`;
}

const DEFAULT_QUERY = buildDefaultGmailEventsQuery();

/** Subject/body cues that a mail is announcing a dated gathering (not only RSVP platforms). */
const INVITEISH_RE =
  /\b(invite|invitation|rsvp|you[''\u2019]re invited|you are invited|join us|meetup|event|events|party|parties|festival|festivals|gathering|gatherings|dates|recap|calendar|request for proposals|on sale|announcement|early bird|save the date|mark your calendar|add to calendar|tickets|pool part(?:y|ies)|potluck|potlucks|wedding|weddings)\b/i;

/** Looser personal-invite wording (friends texting dates without platform jargon). */
const PERSONAL_INVITEISH_RE =
  /\b(want to come|wanna come|you free|are you free|free (?:on|this)|this coming|this (?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|next (?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|come through|hang out|join me|you(?:[''\u2019]d| would) love|should come|hope you can (?:make|come)|every (?:other )?(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth)?\s*(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

const PERSONAL_MAIL_HOSTS = new Set([
  'gmail.com',
  'googlemail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'proton.me',
  'protonmail.com',
]);

/**
 * Public event / invite links. Facebook: /events/{id}, page hosted tabs, group events.
 * Secret Party events are usually https://<slug>.secretparty.io/ (subdomain), not path URLs.
 * Eventbrite: include clicks.* / www.* subdomains (ESP trackers + listing hosts).
 * Bonobo / Plura / WannaKetchup: community + ticket hosts that land in Intake Gmail.
 */
const PLATFORM_HOST_RE =
  /(?:https?:\/\/)?(?:(?:[a-z0-9-]+)\.)?secretparty\.io(?:\/[^\s"'<>)\]]*)?|(?:https?:\/\/)?(?:(?:[a-z0-9-]+)\.)?(?:partiful\.com|lu\.ma|luma\.com|eventbrite\.com|meetup\.com|withjoy\.com|fuckupnights\.com)(?:\/[^\s"'<>)\]]*)?|(?:https?:\/\/)?(?:www\.)?facebook\.com\/(?:events\/[^\s"'<>)\]]+|[^/\s"'<>)\]]+\/(?:upcoming_hosted_events|past_hosted_events|events)|groups\/[^/\s"'<>)\]]+\/events)[^\s"'<>)\]]*|(?:https?:\/\/)?(?:www\.)?take3presents\.com(?:\/[^\s"'<>)\]]*)?|(?:https?:\/\/)?mailchi\.mp\/(?:take3presents|bonobonetwork|fuckupnights)(?:\/[^\s"'<>)\]]*)?|(?:https?:\/\/)?(?:(?:www|community|en)\.)?(?:bonobonetwork|fuckupnights)\.com(?:\/[^\s"'<>)\]]*)?|(?:https?:\/\/)?(?:(?:[a-z0-9-]+)\.)?plra\.io(?:\/[^\s"'<>)\]]*)?|(?:https?:\/\/)?(?:www\.)?wannaketchup\.com(?:\/[^\s"'<>)\]]*)?/gi;

const GMAIL_FETCH_UA =
  'Mozilla/5.0 (compatible; DashbirdEvents/1.0; +https://github.com/local/dashbird)';

/**
 * @param {string} email
 */
export function normalizeGmailAddress(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Configured intake mailboxes (order preserved, deduped).
 * Env: GMAIL_INTAKE_ADDRESSES=a@x.com,b@y.com
 * Legacy: GMAIL_INTAKE_ADDRESS alone still works (single or first of list).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function gmailIntakeAddresses(env = process.env) {
  const multi = String(env.GMAIL_INTAKE_ADDRESSES || '').trim();
  const single = String(env.GMAIL_INTAKE_ADDRESS || '').trim();
  /** @type {string[]} */
  let list = [];
  if (multi) {
    list = multi.split(/[,;\s]+/).map(normalizeGmailAddress).filter(Boolean);
  } else if (single) {
    list = single.split(/[,;\s]+/).map(normalizeGmailAddress).filter(Boolean);
  } else {
    list = [...GMAIL_INTAKE_DEFAULT_ADDRESSES];
  }
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const e of list) {
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out.length ? out : [...GMAIL_INTAKE_DEFAULT_ADDRESSES];
}

/**
 * Primary / first intake address (backward compatible).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailIntakeAddress(env = process.env) {
  return gmailIntakeAddresses(env)[0] || GMAIL_INTAKE_DEFAULT_ADDRESS;
}

/**
 * App password for IMAP fallback (avoids Google OAuth consent UI).
 * Prefer GMAIL_INTAKE_APP_PASSWORD_<SLUG> or GMAIL_INTAKE_APP_PASSWORD for primary.
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailAppPasswordFor(email, env = process.env) {
  const addr = normalizeGmailAddress(email);
  if (!addr) return '';
  const slug = gmailTokenFileSlug(addr)
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
  const specific = String(env[`GMAIL_INTAKE_APP_PASSWORD_${slug}`] || '').trim();
  if (specific) return specific.replace(/\s+/g, '');
  const primary = String(env.GMAIL_INTAKE_APP_PASSWORD || '').trim().replace(/\s+/g, '');
  if (!primary) return '';
  const addresses = gmailIntakeAddresses(env);
  if (addresses[0] === addr || addresses.length === 1) return primary;
  return '';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailEventsQuery(env = process.env) {
  const q = String(env.GMAIL_EVENTS_QUERY || '').trim();
  return q || DEFAULT_QUERY;
}

/**
 * Legacy single-token path (migrated into per-account files when present).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailLegacyTokenPath(env = process.env) {
  const override = String(env.GMAIL_INTAKE_TOKEN_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'gmail-intake-token.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function gmailTokensDir(env = process.env) {
  const override = String(env.GMAIL_INTAKE_TOKENS_DIR || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'gmail-intake-tokens');
}

/**
 * Safe filename for an email address.
 * @param {string} email
 */
export function gmailTokenFileSlug(email) {
  return normalizeGmailAddress(email).replace(/[^a-z0-9._+-]+/gi, '_');
}

/**
 * Per-account token path.
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailTokenPathFor(email, env = process.env) {
  const addr = normalizeGmailAddress(email);
  return path.join(gmailTokensDir(env), `${gmailTokenFileSlug(addr)}.json`);
}

/** @deprecated use gmailTokenPathFor / gmailLegacyTokenPath */
export function gmailTokenPath(env = process.env) {
  return gmailLegacyTokenPath(env);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ clientId: string, clientSecret: string } | null}
 */
export function gmailOAuthClient(env = process.env) {
  const clientId = String(
    env.GMAIL_INTAKE_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID || '',
  ).trim();
  const clientSecret = String(
    env.GMAIL_INTAKE_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  ).trim();
  if (!clientId || !clientSecret || clientId.startsWith('REPLACE') || clientSecret.startsWith('REPLACE')) {
    return null;
  }
  return { clientId, clientSecret };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailOAuthRedirectUri(env = process.env) {
  const explicit = String(env.GMAIL_OAUTH_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const origin = String(env.DASHBOARD_LAN_ORIGIN || '').trim().replace(/\/$/, '');
  if (origin) return `${origin}/api/events-finder-gmail/oauth/callback`;
  const port = String(env.HOST_PORT || '8787').trim() || '8787';
  return `http://127.0.0.1:${port}/api/events-finder-gmail/oauth/callback`;
}

/**
 * @typedef {{
 *   access_token?: string,
 *   refresh_token?: string,
 *   expiry_date?: number,
 *   token_type?: string,
 *   scope?: string,
 *   email?: string,
 * }} GmailTokenFile
 */

/**
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<GmailTokenFile | null>}
 */
export async function loadGmailTokenFor(email, env = process.env) {
  const addr = normalizeGmailAddress(email);
  if (!addr) return null;
  try {
    const raw = await readFile(gmailTokenPathFor(addr, env), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return { ...data, email: normalizeGmailAddress(data.email) || addr };
  } catch {
    /* try legacy migrate below */
  }

  // One-time: legacy single file → primary account path
  try {
    const legacyRaw = await readFile(gmailLegacyTokenPath(env), 'utf8');
    const data = JSON.parse(legacyRaw);
    if (!data || typeof data !== 'object') return null;
    const legacyEmail = normalizeGmailAddress(data.email) || gmailIntakeAddress(env);
    if (legacyEmail !== addr) return null;
    const migrated = { ...data, email: legacyEmail };
    await saveGmailTokenFor(migrated, legacyEmail, env);
    return migrated;
  } catch {
    return null;
  }
}

/**
 * @param {GmailTokenFile} token
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveGmailTokenFor(token, email, env = process.env) {
  const addr = normalizeGmailAddress(email || token.email);
  if (!addr) throw new Error('Gmail token save requires email');
  const p = gmailTokenPathFor(addr, env);
  await mkdir(path.dirname(p), { recursive: true });
  const payload = { ...token, email: addr };
  await writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
}

/** @deprecated prefer loadGmailTokenFor */
export async function loadGmailToken(env = process.env) {
  return loadGmailTokenFor(gmailIntakeAddress(env), env);
}

/** @deprecated prefer saveGmailTokenFor */
export async function saveGmailToken(token, env = process.env) {
  const email = normalizeGmailAddress(token?.email) || gmailIntakeAddress(env);
  return saveGmailTokenFor(token, email, env);
}

/**
 * Resolve which configured address an OAuth start should target.
 * @param {string | null | undefined} requested
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveGmailOAuthTarget(requested, env = process.env) {
  const addresses = gmailIntakeAddresses(env);
  const want = normalizeGmailAddress(requested);
  if (want && addresses.includes(want)) return want;
  if (want) return want; // allow connecting an extra mailbox; still saved under its profile email
  return addresses[0];
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ email?: string }} [opts]
 */
export function buildGmailOAuthAuthUrl(env = process.env, opts = {}) {
  const client = gmailOAuthClient(env);
  if (!client) {
    const err = new Error(
      'Gmail OAuth not configured — set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (or GMAIL_INTAKE_*).',
    );
    err.code = 'oauth_not_configured';
    throw err;
  }
  const loginHint = resolveGmailOAuthTarget(opts.email, env);
  const redirectUri = gmailOAuthRedirectUri(env);
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_EVENTS_SCOPE,
    access_type: 'offline',
    // Keep the auth URL minimal — extra prompt/login_hint/include_granted_scopes
    // values often break Google's Testing "Continue" interstitial.
    prompt: 'consent',
    state: loginHint,
  });
  return `${AUTH_URI}?${params}`;
}

/**
 * @param {string} code
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ intendedEmail?: string }} [opts]
 */
export async function exchangeGmailOAuthCode(code, env = process.env, opts = {}) {
  const client = gmailOAuthClient(env);
  if (!client) {
    const err = new Error('Gmail OAuth client not configured');
    err.code = 'oauth_not_configured';
    throw err;
  }
  const redirectUri = gmailOAuthRedirectUri(env);
  const body = new URLSearchParams({
    code: String(code || '').trim(),
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const r = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    const err = new Error(json.error_description || json.error || `token exchange HTTP ${r.status}`);
    err.code = 'oauth_exchange_failed';
    throw err;
  }

  let profileEmail = '';
  try {
    const profile = await gmailGet(json.access_token, '/users/me/profile');
    profileEmail = normalizeGmailAddress(profile?.emailAddress);
  } catch {
    /* fall through */
  }

  const intended = normalizeGmailAddress(opts.intendedEmail);
  const email =
    profileEmail
    || intended
    || gmailIntakeAddress(env);

  /** @type {GmailTokenFile} */
  const token = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type || 'Bearer',
    scope: json.scope || GMAIL_EVENTS_SCOPE,
    expiry_date: Date.now() + Number(json.expires_in || 3600) * 1000,
    email,
  };
  const existing = await loadGmailTokenFor(email, env);
  if (!token.refresh_token && existing?.refresh_token) {
    token.refresh_token = existing.refresh_token;
  }
  await saveGmailTokenFor(token, email, env);
  return {
    ...token,
    intendedEmail: intended || null,
    emailMatched: !intended || intended === email,
  };
}

/**
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ ok: boolean, accessToken?: string, email?: string | null, error?: string, code?: string }>}
 */
export async function getGmailAccessTokenFor(email, env = process.env) {
  const addr = normalizeGmailAddress(email);
  const client = gmailOAuthClient(env);
  if (!client) {
    return {
      ok: false,
      code: 'oauth_not_configured',
      error:
        'Set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (or GMAIL_INTAKE_*) in .env',
    };
  }
  const stored = await loadGmailTokenFor(addr, env);
  if (!stored?.refresh_token && !stored?.access_token) {
    return {
      ok: false,
      code: 'oauth_not_connected',
      error: `Connect ${addr} via Settings → Events sources → Connect Gmail`,
    };
  }

  const skewMs = 60_000;
  if (
    stored.access_token &&
    Number(stored.expiry_date) > Date.now() + skewMs
  ) {
    return { ok: true, accessToken: stored.access_token, email: stored.email || addr };
  }

  if (!stored.refresh_token) {
    return {
      ok: false,
      code: 'oauth_not_connected',
      error: 'Gmail token missing refresh_token — reconnect OAuth',
    };
  }

  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: stored.refresh_token,
    grant_type: 'refresh_token',
  });
  const r = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    return {
      ok: false,
      code: 'oauth_refresh_failed',
      error: json.error_description || json.error || `refresh HTTP ${r.status}`,
    };
  }
  const next = {
    ...stored,
    access_token: json.access_token,
    token_type: json.token_type || stored.token_type || 'Bearer',
    scope: json.scope || stored.scope || GMAIL_EVENTS_SCOPE,
    expiry_date: Date.now() + Number(json.expires_in || 3600) * 1000,
    email: stored.email || addr,
  };
  if (json.refresh_token) next.refresh_token = json.refresh_token;
  await saveGmailTokenFor(next, addr, env);
  return { ok: true, accessToken: next.access_token, email: next.email || addr };
}

/** @deprecated prefer getGmailAccessTokenFor */
export async function getGmailAccessToken(env = process.env) {
  return getGmailAccessTokenFor(gmailIntakeAddress(env), env);
}

/**
 * @param {string} s
 */
function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * @param {any} part
 * @param {{ texts: string[], htmls: string[], ics: string[] }} bag
 */
export function collectMimeParts(part, bag) {
  if (!part || typeof part !== 'object') return;
  const mime = String(part.mimeType || '').toLowerCase();
  const filename = String(part.filename || '').toLowerCase();
  const data = part.body?.data ? String(part.body.data) : '';

  if (data && (mime === 'text/calendar' || filename.endsWith('.ics'))) {
    bag.ics.push(b64urlDecode(data));
  } else if (data && mime === 'text/plain') {
    bag.texts.push(b64urlDecode(data));
  } else if (data && mime === 'text/html') {
    bag.htmls.push(b64urlDecode(data));
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) collectMimeParts(child, bag);
  }
}

/**
 * @param {string} href
 * @returns {boolean}
 */
export function isEventbriteHost(href) {
  try {
    const host = new URL(href).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'eventbrite.com' || host.endsWith('.eventbrite.com');
  } catch {
    return false;
  }
}

/**
 * @param {string} href
 * @returns {boolean}
 */
export function isEventbriteEventUrl(href) {
  try {
    const u = new URL(href);
    if (!isEventbriteHost(u.href)) return false;
    return /\/e\/[a-z0-9-]+-\d+/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Prefer deep event pages over ESP trackers / bare marketing hosts.
 * @param {string} href
 * @returns {number}
 */
export function platformUrlScore(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname || '/';
    if (host === 'eventbrite.com' || host.endsWith('.eventbrite.com')) {
      if (/\/e\/[a-z0-9-]+-\d+/i.test(path)) return 100;
      if (host.startsWith('clicks.')) return 60;
      if (path === '/' || path === '') return 1;
      return 25;
    }
    if (host === 'partiful.com' || host.endsWith('.partiful.com')) {
      return /\/e\//i.test(path) ? 90 : 20;
    }
    if (host === 'lu.ma' || host === 'luma.com' || host.endsWith('.luma.com')) {
      return path.length > 1 ? 90 : 20;
    }
    if (host.endsWith('secretparty.io') && host !== 'track.secretparty.io') {
      return 90;
    }
    if (host === 'meetup.com' || host.endsWith('.meetup.com')) {
      return /\/events\//i.test(path) ? 90 : 20;
    }
    if (host === 'facebook.com' || host.endsWith('.facebook.com')) {
      return /\/events\//i.test(path) ? 90 : 20;
    }
    if (host === 'take3presents.com' || host.endsWith('.take3presents.com')) {
      return path.length > 1 ? 85 : 70;
    }
    if (host === 'mailchi.mp' && /\/(?:take3presents|bonobonetwork)\//i.test(path)) {
      return 75;
    }
    if (host === 'plra.io' || host.endsWith('.plra.io')) {
      return path.length > 1 ? 95 : 40;
    }
    if (host === 'wannaketchup.com' || host.endsWith('.wannaketchup.com')) {
      return path.length > 1 ? 90 : 30;
    }
    if (host === 'bonobonetwork.com' || host.endsWith('.bonobonetwork.com')) {
      if (path === '/' || path === '' || path === '/apply') return 15;
      if (path.startsWith('/events')) return 55;
      return 40;
    }
    if (host === 'withjoy.com' || host.endsWith('.withjoy.com')) {
      if (/\/assets\/|\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|svg|css|js)(?:$|\?)/i.test(path)) {
        return 0;
      }
      // Couple site: /handle or /handle/...
      if (/^\/[a-z0-9][a-z0-9-]{1,80}(?:\/|$)/i.test(path)) return 95;
      return path.length > 1 ? 70 : 40;
    }
    if (host.includes('fuckupnights')) {
      if (/\/at-work|\/about|\/blog|\/stories/i.test(path)) return 5;
      if (/\/[a-z0-9-]+/i.test(path) && path.length > 1) return 85;
      return 40;
    }
    if (isWhitelistedEventPlatformHost(host)) {
      return path.length > 1 ? 70 : 35;
    }
    return 10;
  } catch {
    return 0;
  }
}

/**
 * @param {string[]} urls
 * @param {string} [fallback]
 * @returns {string}
 */
export function pickBestPlatformUrl(urls, fallback = '') {
  const list = (urls || []).filter(Boolean);
  if (!list.length) return fallback;
  return [...list].sort((a, b) => platformUrlScore(b) - platformUrlScore(a))[0] || fallback;
}

/**
 * @param {string} htmlOrText
 * @returns {string[]}
 */
export function extractPlatformUrls(htmlOrText) {
  const raw = String(htmlOrText || '');
  const found = raw.match(PLATFORM_HOST_RE) || [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (let u of found) {
    u = u.replace(/[.,;:!?)]+$/, '');
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try {
      const parsed = new URL(u);
      // Prefer the real event subdomain inside Secret Party click-trackers.
      const unwrapped = unwrapSecretPartyTrackingUrl(parsed.href);
      const finalUrl = unwrapped || parsed.href;
      const host = new URL(finalUrl).hostname.replace(/^www\./, '').toLowerCase();
      const path = new URL(finalUrl).pathname || '/';
      if (host === 'track.secretparty.io') continue;
      // Skip static assets mistaken for event pages (WithJoy font CSS, etc.).
      if (/\/assets\/|\/fonts\/|\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|svg|css|js)(?:$|\?)/i.test(path)) {
        continue;
      }
      const key = finalUrl.split('#')[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(finalUrl.split('#')[0]);
    } catch {
      /* ignore */
    }
  }
  // Drop bare Eventbrite homepage when a deeper / tracker URL exists.
  const hasDeepEb = out.some((href) => platformUrlScore(href) >= 60);
  if (hasDeepEb) {
    return out.filter((href) => {
      try {
        if (!isEventbriteHost(href)) return true;
        const path = new URL(href).pathname || '/';
        return !(path === '/' || path === '');
      } catch {
        return true;
      }
    });
  }
  return out;
}

/**
 * Follow Eventbrite ESP click trackers to a canonical /e/{slug}-{id} URL.
 * @param {string} href
 * @param {number} [timeoutMs]
 * @returns {Promise<string | null>}
 */
export async function resolveEventbriteTrackingUrl(href, timeoutMs = 8000) {
  const start = String(href || '').trim();
  if (!start) return null;
  try {
    if (isEventbriteEventUrl(start)) {
      return new URL(start).href.split(/[?#]/)[0];
    }
    if (!isEventbriteHost(start)) return null;
    const host = new URL(start).hostname.replace(/^www\./, '').toLowerCase();
    // Bare www.eventbrite.com/ is not resolvable to a single event.
    if (host === 'eventbrite.com') {
      const path = new URL(start).pathname || '/';
      if (path === '/' || path === '') return null;
    }

    let current = start;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      for (let hop = 0; hop < 6; hop += 1) {
        if (isEventbriteEventUrl(current)) {
          return new URL(current).href.split(/[?#]/)[0];
        }
        const r = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
          signal: ac.signal,
          headers: {
            'user-agent': GMAIL_FETCH_UA,
            accept: 'text/html,application/xhtml+xml',
          },
        });
        try {
          r.body?.cancel?.();
        } catch {
          /* ignore */
        }
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers.get('location');
          if (!loc) break;
          current = new URL(loc, current).href;
          continue;
        }
        // Some trackers land with redirect:follow semantics on the final hop.
        if (isEventbriteEventUrl(current)) {
          return new URL(current).href.split(/[?#]/)[0];
        }
        break;
      }
    } finally {
      clearTimeout(t);
    }

    // One follow-all attempt when manual hops did not yield /e/.
    const followed = await fetch(start, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': GMAIL_FETCH_UA,
        accept: 'text/html,application/xhtml+xml',
      },
    }).catch(() => null);
    if (followed) {
      try {
        followed.body?.cancel?.();
      } catch {
        /* ignore */
      }
      const finalUrl = followed.url || '';
      if (isEventbriteEventUrl(finalUrl)) {
        return new URL(finalUrl).href.split(/[?#]/)[0];
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Decode Secret Party ESP click trackers → https://<slug>.secretparty.io/...
 * @param {string} href
 * @returns {string | null}
 */
function unwrapSecretPartyTrackingUrl(href) {
  try {
    const u = new URL(href);
    if (u.hostname.replace(/^www\./, '').toLowerCase() !== 'track.secretparty.io') return null;
    const p = u.searchParams.get('p');
    if (!p) return null;
    // Payload is URL-safe base64 JSON: { p: "<stringified json with url>" } or nested.
    const padded = p.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const json = Buffer.from(padded + pad, 'base64').toString('utf8');
    const outer = JSON.parse(json);
    let inner = outer;
    if (typeof outer?.p === 'string') {
      try {
        inner = JSON.parse(outer.p);
      } catch {
        inner = outer;
      }
    }
    const target = String(inner?.url || inner?.u || '').trim();
    if (!target) return null;
    const dest = new URL(target);
    const host = dest.hostname.replace(/^www\./, '').toLowerCase();
    if (!host.endsWith('secretparty.io') || host === 'track.secretparty.io') return null;
    return dest.href.split('#')[0];
  } catch {
    return null;
  }
}

/**
 * Prefer a platform source key when the message links to a known host.
 * @param {string[]} urls
 * @param {string} [fallback='gmail']
 * @returns {string}
 */
export function sourceFromPlatformUrls(urls, fallback = 'gmail') {
  for (const href of urls || []) {
    try {
      const host = new URL(href).hostname.replace(/^www\./, '').toLowerCase();
      if (host === 'secretparty.io' || host.endsWith('.secretparty.io')) return 'secretparty';
      if (host === 'partiful.com' || host.endsWith('.partiful.com')) return 'partiful';
      if (host === 'lu.ma' || host === 'luma.com' || host.endsWith('.luma.com')) return 'luma';
      if (host === 'eventbrite.com' || host.endsWith('.eventbrite.com')) return 'eventbrite';
      if (host === 'meetup.com' || host.endsWith('.meetup.com')) return 'meetup';
      if (host === 'facebook.com' || host.endsWith('.facebook.com')) return 'facebook';
      if (host === 'take3presents.com' || host.endsWith('.take3presents.com')) return 'take3presents';
      if (host === 'mailchi.mp' && /\/take3presents\//i.test(href)) return 'take3presents';
      if (host === 'mailchi.mp' && /\/bonobonetwork\//i.test(href)) return 'bonobo';
      if (host === 'mailchi.mp' && /\/fuckupnights\//i.test(href)) return 'fuckupnights';
      if (host === 'bonobonetwork.com' || host.endsWith('.bonobonetwork.com')) return 'bonobo';
      if (host === 'plra.io' || host.endsWith('.plra.io')) return 'plura';
      if (host === 'wannaketchup.com' || host.endsWith('.wannaketchup.com')) return 'wannaketchup';
      if (host === 'withjoy.com' || host.endsWith('.withjoy.com')) return 'withjoy';
      if (host.includes('fuckupnights')) return 'fuckupnights';
      const keyed = sourceKeyForEmailPlatform(href);
      if (keyed) return keyed;
    } catch {
      /* ignore */
    }
  }
  return fallback;
}

/**
 * Personal inbox invite (friend / 1:1) vs bulk ESP — looser wording allowed.
 * @param {string} from
 * @param {string} [textBlob]
 * @returns {boolean}
 */
export function looksLikePersonalInviteMail(from, textBlob = '') {
  const fromStr = String(from || '');
  const addr = fromStr.match(/[\w.+-]+@([\w.-]+)/i)?.[1]?.toLowerCase() || '';
  const blob = String(textBlob || '');
  if (/list-unsubscribe|mailchimp|sendgrid|constantcontact|substack\.com|noreply@|no-reply@/i.test(blob + fromStr)) {
    return false;
  }
  if (addr && PERSONAL_MAIL_HOSTS.has(addr)) return true;
  // First-name From without ESP footprint still counts as personal-ish.
  if (/^[^@<\s]{2,40}\s*</.test(fromStr) && !/@/.test(fromStr.split('<')[0])) return true;
  return PERSONAL_INVITEISH_RE.test(blob) && !/\bunsubscribe\b/i.test(blob);
}

/**
 * Human title from Secret Party subdomain slug when the page/subject is generic.
 * @param {string} href
 * @returns {string | null}
 */
export function secretPartyTitleFromUrl(href) {
  try {
    const host = new URL(href).hostname.replace(/^www\./, '').toLowerCase();
    const m = host.match(/^([a-z0-9-]+)\.secretparty\.io$/);
    if (!m || !m[1] || m[1] === 'www' || m[1] === 'api') return null;
    return m[1]
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .slice(0, 180);
  } catch {
    return null;
  }
}

const MONTH_NAME_TO_INDEX = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

/**
 * @param {string} monthName
 * @returns {number | null}
 */
function monthIndexFromName(monthName) {
  const key = String(monthName || '').trim().toLowerCase().replace(/\./g, '');
  return Object.prototype.hasOwnProperty.call(MONTH_NAME_TO_INDEX, key)
    ? MONTH_NAME_TO_INDEX[key]
    : null;
}

/**
 * @param {number} year
 * @param {number} monthIndex
 * @param {number} day
 * @returns {string | null}
 */
function ymdFromParts(year, monthIndex, day) {
  if (!Number.isFinite(year) || monthIndex == null || !Number.isFinite(day)) return null;
  const y = String(Math.trunc(year));
  const m = String(monthIndex + 1).padStart(2, '0');
  const d = String(Math.trunc(day)).padStart(2, '0');
  const iso = `${y}-${m}-${d}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && Number.isFinite(Date.parse(`${iso}T12:00:00Z`))
    ? iso
    : null;
}

/**
 * YYYY-MM-DD at 12:00 in `timeZone` → UTC ISO (avoids UTC-noon looking like 5am PT).
 * @param {string} ymd
 * @param {string} [timeZone]
 * @returns {string | null}
 */
export function ymdAtLocalNoonIso(ymd, timeZone = 'America/Los_Angeles') {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  let ms = Date.UTC(y, mo - 1, d, 19, 0, 0);
  for (let i = 0; i < 48; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const got = Object.fromEntries(
      parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
    );
    if (
      got.year === y
      && got.month === mo
      && got.day === d
      && got.hour === 12
      && got.minute === 0
    ) {
      return new Date(ms).toISOString();
    }
    const dayDelta =
      Date.UTC(y, mo - 1, d) - Date.UTC(got.year, got.month - 1, got.day);
    const minuteDelta =
      12 * 60 - (got.hour * 60 + got.minute) + dayDelta / 60000;
    if (!Number.isFinite(minuteDelta) || minuteDelta === 0) break;
    ms += minuteDelta * 60 * 1000;
  }
  const fallback = Date.parse(`${ymd}T19:00:00.000Z`);
  return Number.isFinite(fallback) ? new Date(fallback).toISOString() : null;
}

/**
 * YYYY-MM-DD + local clock → UTC ISO (iterative Intl resolve, same as noon helper).
 * @param {string} ymd
 * @param {number} hours
 * @param {number} minutes
 * @param {string} [timeZone]
 * @returns {string | null}
 */
export function ymdAtLocalTimeIso(ymd, hours, minutes, timeZone = 'America/Los_Angeles') {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Math.min(23, Math.max(0, Math.trunc(Number(hours) || 0)));
  const mm = Math.min(59, Math.max(0, Math.trunc(Number(minutes) || 0)));
  let ms = Date.UTC(y, mo - 1, d, hh + 7, mm, 0);
  for (let i = 0; i < 48; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const got = Object.fromEntries(
      parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
    );
    if (
      got.year === y
      && got.month === mo
      && got.day === d
      && got.hour === hh
      && got.minute === mm
    ) {
      return new Date(ms).toISOString();
    }
    const dayDelta =
      Date.UTC(y, mo - 1, d) - Date.UTC(got.year, got.month - 1, got.day);
    const minuteDelta =
      hh * 60 + mm - (got.hour * 60 + got.minute) + dayDelta / 60000;
    if (!Number.isFinite(minuteDelta) || minuteDelta === 0) break;
    ms += minuteDelta * 60 * 1000;
  }
  return ymdAtLocalNoonIso(ymd, timeZone);
}

/**
 * @param {string} raw
 * @returns {{ hours: number, minutes: number } | null}
 */
export function parseClockToken(raw) {
  const m = String(raw || '')
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2] || 0);
  const ap = m[3].toLowerCase();
  if (!Number.isFinite(hours) || hours < 1 || hours > 12 || minutes > 59) return null;
  if (ap === 'pm' && hours < 12) hours += 12;
  if (ap === 'am' && hours === 12) hours = 0;
  return { hours, minutes };
}

const WEEKDAY_NAME_RE =
  '(?:Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:rs(?:day)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)';

/**
 * Guess event title for a dated block from preceding newsletter lines.
 * @param {string} before
 * @returns {string | null}
 */
function guessDatedBlockTitle(before) {
  const lines = String(before || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let line = lines[i];
    if (/^-{3,}$/.test(line)) continue;
    if (/^\*+$/.test(line)) continue;
    line = line.replace(/^\*\*\s*/, '').replace(/\s*\*\*$/, '').trim();
    if (!line) continue;
    if (/^you[''\u2019]?re invited!?$/i.test(line)) continue;
    if (/^slide down/i.test(line)) continue;
    if (/flyer template/i.test(line)) continue;
    if (/event calendar/i.test(line)) continue;
    if (/^https?:\/\//i.test(line)) continue;
    if (
      new RegExp(`^(?:${WEEKDAY_NAME_RE},\\s+)?${MONTH_NAME_RE}`, 'i').test(line)
      && /\d/.test(line)
    ) {
      continue;
    }
    if (line.length < 3 || line.length > 180) continue;
    return line;
  }
  return null;
}

/**
 * Newsletter digests often list several titled parties with their own date lines,
 * e.g. "** Afternoon Delight…\\n** Saturday, August 8, 12pm-8pm | Oakland".
 * @param {string} text
 * @param {Date | number} [now]
 * @param {string} [timeZone]
 * @returns {Array<{
 *   title: string | null,
 *   start: string | null,
 *   end: string | null,
 *   city: string | null,
 *   venue: string | null,
 *   index: number,
 *   matchStart: number,
 *   matchEnd: number,
 * }>}
 */
export function extractDatedInviteBlocks(
  text,
  now = Date.now(),
  timeZone = 'America/Los_Angeles',
) {
  const raw = String(text || '');
  const dateLineRe = new RegExp(
    `(?:^|\\n)\\s*(?:\\*\\*\\s*)?(?:${WEEKDAY_NAME_RE},\\s+)?(${MONTH_NAME_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*(20\\d{2}))?,\\s*(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))(?:\\s*[-–]\\s*(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)))?(?:\\s*[|·]\\s*([^\\n*]{2,80}))?`,
    'gi',
  );
  /** @type {ReturnType<typeof extractDatedInviteBlocks>} */
  const blocks = [];
  let m = dateLineRe.exec(raw);
  while (m) {
    const monthIndex = monthIndexFromName(m[1]);
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : upcomingYearForMonthDay(monthIndex, day, now);
    const startClock = parseClockToken(m[4]);
    const endClock = m[5] ? parseClockToken(m[5]) : null;
    const place = m[6] ? String(m[6]).replace(/\s+/g, ' ').trim() : '';
    if (monthIndex == null || !Number.isFinite(year) || !startClock) {
      m = dateLineRe.exec(raw);
      continue;
    }
    const ymd = ymdFromParts(year, monthIndex, day);
    if (!ymd) {
      m = dateLineRe.exec(raw);
      continue;
    }
    const start = ymdAtLocalTimeIso(ymd, startClock.hours, startClock.minutes, timeZone);
    const end = endClock
      ? ymdAtLocalTimeIso(ymd, endClock.hours, endClock.minutes, timeZone)
      : null;
    let city = null;
    let venue = null;
    if (place) {
      const parts = place
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length >= 2) {
        city = parts[parts.length - 1];
        venue = parts.slice(0, -1).join(', ');
      } else {
        city = parts[0];
      }
    }
    blocks.push({
      title: guessDatedBlockTitle(raw.slice(0, m.index)),
      start,
      end,
      city,
      venue,
      index: blocks.length,
      matchStart: m.index,
      matchEnd: m.index + m[0].length,
    });
    m = dateLineRe.exec(raw);
  }
  return blocks;
}

/**
 * Thin marketing homepages that must not collapse distinct multi-event rows on dedupe.
 * @param {string} href
 * @returns {boolean}
 */
export function isThinMarketingEventUrl(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname || '/';
    if (host === 'bonobonetwork.com' || host.endsWith('.bonobonetwork.com')) {
      return path === '/' || path === '' || path === '/apply' || path === '/events';
    }
    if (host === 'mailchi.mp') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * When mail says "October 22" with no year, pick the next upcoming occurrence
 * (today or later this calendar year, else next year) in America/Los_Angeles.
 * @param {number} monthIndex 0–11
 * @param {number} day
 * @param {Date | number} [now]
 * @returns {number | null} full year
 */
export function upcomingYearForMonthDay(monthIndex, day, now = Date.now()) {
  if (monthIndex == null || !Number.isFinite(day) || day < 1 || day > 31) return null;
  const ms = typeof now === 'number' ? now : now.getTime();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const yNow = Number(parts.find((p) => p.type === 'year')?.value);
  const mNow = Number(parts.find((p) => p.type === 'month')?.value);
  const dNow = Number(parts.find((p) => p.type === 'day')?.value);
  if (![yNow, mNow, dNow].every(Number.isFinite)) return null;
  const thisYear = ymdFromParts(yNow, monthIndex, day);
  if (!thisYear) return null;
  const month = monthIndex + 1;
  const stillUpcoming =
    month > mNow || (month === mNow && day >= dNow);
  return stillUpcoming ? yNow : yNow + 1;
}

const MONTH_NAME_RE =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

/**
 * Parse a month/day range like "November 13-16, 2026" or yearless "October 22-26"
 * (year deduced as the next upcoming occurrence).
 * @param {string} blob
 * @param {Date | number} [now]
 * @returns {{ eventStart: string, eventEnd: string } | null}
 */
export function parseEventDateRange(blob, now = Date.now()) {
  const text = String(blob || '');
  const range = text.match(
    new RegExp(
      `\\b(${MONTH_NAME_RE})\\.?\\s+(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})(?:,?\\s+(20\\d{2}))?\\b`,
      'i',
    ),
  );
  if (range) {
    const monthIndex = monthIndexFromName(range[1]);
    const startDay = Number(range[2]);
    const endDay = Number(range[3]);
    const year = range[4]
      ? Number(range[4])
      : upcomingYearForMonthDay(monthIndex, startDay, now);
    if (!Number.isFinite(year)) return null;
    const eventStart = ymdFromParts(year, monthIndex, startDay);
    const eventEnd = ymdFromParts(year, monthIndex, endDay);
    if (eventStart && eventEnd) return { eventStart, eventEnd };
  }
  return null;
}

/**
 * Best-effort start ISO from subject/body when no .ics.
 * @param {string} blob
 * @param {Date | number} [now]
 * @returns {string | null}
 */
export function guessEventStartIso(blob, now = Date.now()) {
  const range = parseEventDateRange(blob, now);
  if (range?.eventStart) {
    return ymdAtLocalNoonIso(range.eventStart);
  }
  const text = String(blob || '');
  // ISO-ish
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/);
  if (iso) {
    if (!iso[2]) return ymdAtLocalNoonIso(iso[1]);
    const t = iso[2] || '12:00';
    const [hhRaw, mmRaw = '00'] = t.split(':');
    const hh = String(Math.min(23, Math.max(0, Number(hhRaw) || 0))).padStart(2, '0');
    const mm = String(Math.min(59, Math.max(0, Number(mmRaw) || 0))).padStart(2, '0');
    const ms = Date.parse(`${iso[1]}T${hh}:${mm}:00`);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  // Month Day, Year (+ optional "at 6pm" / "6:30pm")
  const mdy = text.match(
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2})(?:\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)))?/i,
  );
  if (mdy) {
    const monthIndex = monthIndexFromName(mdy[1].match(/^[A-Za-z]+/)?.[0] || '');
    const dayMatch = mdy[1].match(/(\d{1,2})/);
    const yearMatch = mdy[1].match(/(20\d{2})/);
    const ymdLocal =
      monthIndex != null && dayMatch && yearMatch
        ? ymdFromParts(Number(yearMatch[1]), monthIndex, Number(dayMatch[1]))
        : null;
    if (ymdLocal) {
      const clock = mdy[2] ? parseClockToken(mdy[2]) : null;
      if (clock) return ymdAtLocalTimeIso(ymdLocal, clock.hours, clock.minutes);
      return ymdAtLocalNoonIso(ymdLocal);
    }
  }
  // Yearless "October 22" / "Oct 22nd" / "August 8, 12pm" → next upcoming
  const md = text.match(
    new RegExp(
      `\\b(${MONTH_NAME_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*[-–]\\s*\\d)(?!,?\\s*20\\d{2})(?:,\\s*|\\s+(?:at\\s+)?)?(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))?`,
      'i',
    ),
  );
  if (md) {
    const monthIndex = monthIndexFromName(md[1]);
    const day = Number(md[2]);
    const year = upcomingYearForMonthDay(monthIndex, day, now);
    const ymd = year != null ? ymdFromParts(year, monthIndex, day) : null;
    if (ymd) {
      const clock = md[3] ? parseClockToken(md[3]) : null;
      if (clock) return ymdAtLocalTimeIso(ymd, clock.hours, clock.minutes);
      return ymdAtLocalNoonIso(ymd);
    }
  }
  return null;
}

/**
 * @param {string} accessToken
 * @param {string} pathAndQuery
 */
export async function gmailGet(accessToken, pathAndQuery) {
  const r = await fetch(`${GMAIL_API}${pathAndQuery}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(json?.error?.message || `Gmail API HTTP ${r.status}`);
    err.code = 'gmail_api_error';
    err.status = r.status;
    throw err;
  }
  return json;
}

/**
 * Header helpers.
 * @param {Array<{ name?: string, value?: string }>} headers
 * @param {string} name
 */
export function headerValue(headers, name) {
  const want = name.toLowerCase();
  const h = (headers || []).find((x) => String(x?.name || '').toLowerCase() === want);
  return h ? String(h.value || '').trim() : '';
}

/**
 * Normalize one Gmail message into zero or more Events finder events.
 * @param {any} message
 * @param {string} [defaultTz]
 * @param {{ mailbox?: string }} [opts]
 */
export function eventsFromGmailMessage(message, defaultTz = 'America/Los_Angeles', opts = {}) {
  const id = String(message?.id || '');
  const mailbox = normalizeGmailAddress(opts.mailbox) || '';
  const idPrefix = mailbox ? `gmail:${mailbox}:${id}` : `gmail:${id}`;
  const headers = message?.payload?.headers || [];
  const subject = headerValue(headers, 'Subject') || '(no subject)';
  const from = headerValue(headers, 'From');
  const dateHdr = headerValue(headers, 'Date');
  const threadId = String(message?.threadId || '');

  /** @type {{ texts: string[], htmls: string[], ics: string[] }} */
  const bag = { texts: [], htmls: [], ics: [] };
  collectMimeParts(message?.payload, bag);

  const htmlAndText = [...bag.texts, ...bag.htmls].join('\n');
  const textBlob = [...bag.texts, ...bag.htmls.map(stripHtml)].join('\n');
  const platformUrls = extractPlatformUrls(htmlAndText);
  const followUrls = extractFollowableUrls(htmlAndText);
  const urls = [...new Set([
    ...platformUrls,
    ...followUrls.filter((u) => isWhitelistedEventPlatformHost(u) || /withjoy|fuckupnights/i.test(u)),
  ])];
  const personal = looksLikePersonalInviteMail(from, `${subject}\n${textBlob}`);

  /** @type {Array<{
   *   id: string,
   *   title: string,
   *   start: string | null,
   *   end?: string | null,
   *   venue?: string | null,
   *   city?: string | null,
   *   lat?: number | null,
   *   lon?: number | null,
   *   url: string,
   *   source: string,
   *   location?: string | null,
   *   raw: object,
   * }>} */
  const events = [];

  for (let i = 0; i < bag.ics.length; i += 1) {
    const parsed = parseIcsEvents(bag.ics[i], defaultTz);
    for (const ev of parsed) {
      const startIso = Number.isFinite(ev.startMs) ? new Date(ev.startMs).toISOString() : null;
      const endIso = Number.isFinite(ev.endMs) ? new Date(ev.endMs).toISOString() : null;
      const url =
        pickBestPlatformUrl(urls, `https://mail.google.com/mail/u/0/#inbox/${id}`);
      const platformSource = sourceFromPlatformUrls(urls.length ? urls : [url]);
      const slugTitle = platformSource === 'secretparty' ? secretPartyTitleFromUrl(url) : null;
      events.push({
        id: `${idPrefix}:ics:${ev.id}`,
        title: ev.title || slugTitle || subject,
        start: startIso,
        end: endIso,
        venue: ev.location || null,
        location: ev.location || null,
        city: null,
        url,
        source: platformSource === 'gmail' ? 'gmail' : platformSource,
        raw: {
          messageId: id,
          threadId,
          subject,
          from,
          date: dateHdr,
          mailbox: mailbox || null,
          via: 'ics',
          platform: platformSource,
          urls,
          followUrls,
          personal,
        },
      });
    }
  }

  if (!events.length) {
    const blob = `${subject}\n${textBlob}`;
    const blocks = extractDatedInviteBlocks(blob, Date.now(), defaultTz);
    const range = parseEventDateRange(blob);
    const start = guessEventStartIso(blob) || null;
    const startOk = start && Number.isFinite(Date.parse(start)) ? start : null;
    const endOk = range?.eventEnd
      ? ymdAtLocalNoonIso(range.eventEnd)
      : null;
    const recurring = expandRecurringAndRelativeDates(blob, {
      now: Date.now(),
      monthsAhead: 3,
      timeZone: defaultTz,
    });
    // Platform link, invite-ish subject/body, dated blocks, personal wording, or a parseable date.
    const inviteish =
      urls.length > 0
      || followUrls.some((u) => isWhitelistedEventPlatformHost(u))
      || INVITEISH_RE.test(subject)
      || INVITEISH_RE.test(textBlob)
      || (personal && PERSONAL_INVITEISH_RE.test(`${subject}\n${textBlob}`))
      || Boolean(startOk)
      || blocks.length > 0
      || recurring.some((ex) => (ex.days || []).length > 0);
    if (inviteish && blocks.length >= 1) {
      const cleanedSubject = subject.replace(/^(re|fwd):\s*/i, '').trim() || subject;
      const inboxFallback = `https://mail.google.com/mail/u/0/#inbox/${id}`;
      for (const block of blocks) {
        const nextStart = blocks[block.index + 1]?.matchStart;
        const sliceEnd =
          typeof nextStart === 'number' ? nextStart : Math.min(textBlob.length, block.matchEnd + 1200);
        const nearUrls = extractPlatformUrls(
          textBlob.slice(Math.max(0, block.matchStart), sliceEnd),
        );
        const blockUrls = nearUrls.length ? nearUrls : urls;
        let url = pickBestPlatformUrl(blockUrls, inboxFallback);
        if (isThinMarketingEventUrl(url) && blocks.length > 1) {
          url = `${inboxFallback}#block-${block.index}`;
        }
        const platformSource = sourceFromPlatformUrls(
          blockUrls.length ? blockUrls : [url],
          urls.length ? sourceFromPlatformUrls(urls) : 'gmail',
        );
        const slugTitle = platformSource === 'secretparty' ? secretPartyTitleFromUrl(url) : null;
        events.push({
          id: blocks.length > 1 ? `${idPrefix}:block:${block.index}` : idPrefix,
          title:
            slugTitle && /^secret party$/i.test(cleanedSubject)
              ? slugTitle
              : (block.title || cleanedSubject),
          start: block.start || startOk,
          end: block.end || endOk,
          venue: block.venue,
          location: block.venue,
          city: block.city,
          url,
          source: platformSource === 'gmail' ? 'gmail' : platformSource,
          raw: {
            messageId: id,
            threadId,
            subject,
            from,
            date: dateHdr,
            mailbox: mailbox || null,
            via: blocks.length > 1 ? 'dated_blocks' : (urls.length ? 'platform_link' : 'subject_heuristic'),
            platform: platformSource,
            urls: blockUrls.length ? blockUrls : urls,
            followUrls,
            personal,
            snippet: String(message?.snippet || '').slice(0, 240),
            blockIndex: block.index,
          },
        });
      }
    } else if (inviteish) {
      const urlCandidates = urls.length ? urls : followUrls;
      const url =
        pickBestPlatformUrl(urlCandidates, `https://mail.google.com/mail/u/0/#inbox/${id}`);
      const platformSource = sourceFromPlatformUrls(
        urlCandidates.length ? urlCandidates : [url],
      );
      const slugTitle = platformSource === 'secretparty' ? secretPartyTitleFromUrl(url) : null;
      const cleanedSubject = subject.replace(/^(re|fwd):\s*/i, '').trim() || subject;
      const named =
        textBlob.match(/\b((?:Cowotey|Room Service|Big Stick Shindig)\s*[IVX0-9]*)\b/i)?.[1]
        || null;
      const placeHay = (() => {
        const idx = textBlob.search(
          /mark your calendar|next event|Cowotey\b|Room Service\b|Big Stick Shindig\b/i,
        );
        return idx >= 0 ? textBlob.slice(idx) : textBlob;
      })().replace(/\s+/g, ' ');
      // Require a capitalised place name — avoids "at all of our upcoming gatherings".
      const atPlace = placeHay.match(
        /\bat\s+([A-Z][^.]{3,120}?)(?:\.|This will be|,?\s*where we)/,
      );
      let venue = null;
      let city = null;
      if (atPlace) {
        const parts = String(atPlace[1])
          .split(',')
          .map((p) => p.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        if (parts.length >= 2) {
          city = parts[parts.length - 1];
          venue = parts.slice(0, -1).join(', ');
        } else if (parts.length === 1) {
          venue = parts[0];
        }
      }

      /** @type {Array<{ ymd: string, hours: number | null, minutes: number | null, label?: string }>} */
      const seriesDays = [];
      // Recurring expansion: nth/every weekday always; relative weekday only for personal mail
      // (avoids newsletter digests inventing "this Thursday" cards).
      for (const ex of recurring) {
        if (ex.kind === 'relative_weekday' && !personal) continue;
        if (
          (ex.kind === 'every_weekday' || ex.kind === 'every_other_weekday')
          && startOk
          && !/\bevery\b/i.test(blob)
        ) {
          continue;
        }
        for (const day of ex.days || []) {
          seriesDays.push({ ...day, label: ex.label });
        }
      }
      // One card per series occurrence; fall back to a single heuristic row.
      const dayRows =
        seriesDays.length > 0
          ? seriesDays
          : [{ ymd: null, hours: null, minutes: null, label: null }];

      for (let di = 0; di < dayRows.length; di += 1) {
        const day = dayRows[di];
        let rowStart = startOk;
        if (day.ymd) {
          rowStart =
            day.hours != null && day.minutes != null
              ? ymdAtLocalTimeIso(day.ymd, day.hours, day.minutes, defaultTz)
              : ymdAtLocalNoonIso(day.ymd, defaultTz);
        }
        const multi = dayRows.length > 1 && day.ymd;
        events.push({
          id: multi ? `${idPrefix}:series:${day.ymd}` : idPrefix,
          title:
            slugTitle && /^secret party$/i.test(cleanedSubject)
              ? slugTitle
              : (named || cleanedSubject),
          start: rowStart,
          end: multi ? null : endOk,
          venue,
          location: venue,
          city,
          url,
          source: platformSource === 'gmail' ? 'gmail' : platformSource,
          raw: {
            messageId: id,
            threadId,
            subject,
            from,
            date: dateHdr,
            mailbox: mailbox || null,
            via: multi
              ? 'recurring_series'
              : (urlCandidates.length ? 'platform_link' : 'subject_heuristic'),
            platform: platformSource,
            urls: urlCandidates,
            followUrls,
            personal,
            patternLabel: day.label || null,
            snippet: String(message?.snippet || '').slice(0, 240),
          },
        });
      }
    }
  }

  return events;
}

/** Platforms whose public event pages expose JSON-LD / title+time we can enrich from. */
const ENRICHABLE_SOURCES = new Set([
  'eventbrite',
  'luma',
  'partiful',
  'meetup',
  'withjoy',
  'fuckupnights',
  'secretparty',
]);

/**
 * Whether a Gmail-derived event can be improved by fetching its platform page
 * (fills a missing start/venue/city, or resolves a thin Eventbrite tracker URL).
 * @param {object} event
 * @returns {boolean}
 */
function gmailEventNeedsPageEnrich(event) {
  if (!event) return false;
  const url = String(event.url || '');
  const rawUrls = Array.isArray(event.raw?.urls) ? event.raw.urls : [];
  const candidates = [url, ...rawUrls].filter(Boolean);
  const source = sourceFromPlatformUrls(candidates, String(event.source || '').toLowerCase());
  if (!ENRICHABLE_SOURCES.has(source)) return false;
  const missingStart = !event.start;
  const missingPlace = !event.venue || !event.city;
  const weakStart =
    event.start
    && /T00:00:00\.000Z$/.test(String(event.start))
    && !event.end;
  const thinEbUrl = source === 'eventbrite' && !candidates.some((u) => isEventbriteEventUrl(u));
  return missingStart || missingPlace || weakStart || thinEbUrl;
}

/**
 * Fill missing start/venue/city (and canonical URL) from a platform's public page.
 * Handles Eventbrite (incl. clicks.* tracker → /e/… resolution) plus Luma, Partiful,
 * and Meetup event pages. Keeps Gmail event ids stable for upsert.
 * @param {object[]} events
 * @param {{ concurrency?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function enrichGmailEventsFromPublicPages(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return list;
  const concurrency = Math.min(Math.max(Number(opts.concurrency) || 3, 1), 6);
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 10000, 2000), 20000);
  const { fetchNormalizedEventFromUrl } = await import('./events-finder-public-pages.js');

  /** @type {Map<string, string | null>} */
  const resolvedCache = new Map();
  /** @type {Map<string, object | null>} */
  const pageCache = new Map();

  /**
   * @param {string} href
   * @returns {Promise<string | null>}
   */
  async function resolveEb(href) {
    const key = String(href || '').split('#')[0].toLowerCase();
    if (!key) return null;
    if (resolvedCache.has(key)) return resolvedCache.get(key) ?? null;
    if (isEventbriteEventUrl(href)) {
      const clean = new URL(href).href.split(/[?#]/)[0];
      resolvedCache.set(key, clean);
      return clean;
    }
    const resolved = await resolveEventbriteTrackingUrl(href, timeoutMs);
    resolvedCache.set(key, resolved);
    return resolved;
  }

  /**
   * @param {string} eventUrl
   * @param {string} source
   * @returns {Promise<object | null>}
   */
  async function loadPage(eventUrl, source) {
    const key = `${source}|${String(eventUrl || '').split('#')[0].toLowerCase()}`;
    if (pageCache.has(key)) return pageCache.get(key) ?? null;
    const page = await fetchNormalizedEventFromUrl(eventUrl, source, timeoutMs);
    pageCache.set(key, page);
    return page;
  }

  const indexes = list
    .map((ev, i) => (gmailEventNeedsPageEnrich(ev) ? i : -1))
    .filter((i) => i >= 0);
  if (!indexes.length) return list;

  const out = list.map((ev) => ev);
  for (let i = 0; i < indexes.length; i += concurrency) {
    const batch = indexes.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (idx) => {
        const ev = out[idx];
        const rawUrls = Array.isArray(ev.raw?.urls) ? ev.raw.urls : [];
        const candidates = [...new Set([ev.url, ...rawUrls].filter(Boolean))];
        const source = sourceFromPlatformUrls(candidates, String(ev.source || '').toLowerCase());
        if (!ENRICHABLE_SOURCES.has(source)) return;

        // Only pages on this platform's real host (drops CDN / redirect trackers).
        const platformCandidates = candidates
          .filter((u) => sourceFromPlatformUrls([u], '') === source)
          .sort((a, b) => platformUrlScore(b) - platformUrlScore(a));
        if (!platformCandidates.length) return;

        let eventUrl = null;
        if (source === 'eventbrite') {
          eventUrl = platformCandidates.find((u) => isEventbriteEventUrl(u)) || null;
          if (!eventUrl) {
            for (const c of platformCandidates) {
              const resolved = await resolveEb(c);
              if (resolved) {
                eventUrl = resolved;
                break;
              }
            }
          }
        } else {
          eventUrl = platformCandidates[0] || null;
        }
        if (!eventUrl) return;

        const page = await loadPage(eventUrl, source);
        if (!page) {
          // Eventbrite: still upgrade to the resolved deep link even if the page failed.
          if (source === 'eventbrite' && eventUrl && eventUrl !== ev.url) {
            out[idx] = {
              ...ev,
              url: eventUrl,
              source: 'eventbrite',
              raw: {
                ...(ev.raw || {}),
                resolvedUrl: eventUrl,
                enrich: 'eventbrite_url_only',
              },
            };
          }
          return;
        }

        const subjectish = String(ev.title || '');
        // Non-Eventbrite marketing emails rarely carry the real event name in the
        // subject, so trust the page title. Eventbrite subjects often embed it.
        const pageTitleNorm = String(page.title || '')
          .replace(/&#x27;|&apos;|&#39;/gi, "'")
          .replace(/&amp;/g, '&')
          .trim();
        const pageTitleGeneric =
          /^(you.?ve got a card|secret party|home|welcome|joy)\b/i.test(pageTitleNorm);
        const preferPageTitle =
          source === 'eventbrite'
            ? !subjectish
              || /^(just added!|new event|you're invited|you are invited)\b/i.test(subjectish)
              || /📅/.test(subjectish)
              || subjectish.length < 8
            : Boolean(page.title) && !pageTitleGeneric;

        const canonicalUrl =
          source === 'eventbrite'
            ? (isEventbriteEventUrl(page.url) ? page.url : eventUrl)
            : (page.url || eventUrl);

        out[idx] = {
          ...ev,
          title: preferPageTitle && pageTitleNorm ? pageTitleNorm : ev.title,
          start: page.start || ev.start,
          end: page.end || ev.end || null,
          venue: page.venue || ev.venue || null,
          location: page.venue || page.location || ev.location || null,
          city: page.city || ev.city || null,
          lat: page.lat ?? ev.lat ?? null,
          lon: page.lon ?? ev.lon ?? null,
          url: canonicalUrl,
          source,
          description: page.description || ev.description || null,
          imageUrl: page.imageUrl || ev.imageUrl || null,
          // Carry ticket price parsed from the detail page's JSON-LD offers.
          // Thin invite mail rarely lists a price; the public event page does.
          ticketPrice: page.ticketPrice ?? ev.ticketPrice ?? null,
          price: page.price ?? page.ticketPrice ?? ev.price ?? null,
          priceMax: page.priceMax ?? ev.priceMax ?? null,
          raw: {
            ...(ev.raw || {}),
            // Preserve the page's schema so withEventPrice() can re-read offers.
            schema: page.raw?.schema ?? ev.raw?.schema ?? null,
            resolvedUrl: eventUrl,
            enrich: `${source}_page`,
            pageTitle: page.title || null,
          },
        };
      }),
    );
  }
  return out;
}

/**
 * @param {string} html
 */
export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Probe one mailbox.
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function probeGmailMailbox(email, env = process.env, opts = {}) {
  const address = normalizeGmailAddress(email);
  const quick = Boolean(opts.quick);
  const timeoutMs = Math.max(500, Number(opts.timeoutMs) || (quick ? 2500 : 20_000));

  // Settings: filesystem-only — never block on Google token refresh / message list.
  if (quick) {
    const client = gmailOAuthClient(env);
    if (!client) {
      return {
        ok: false,
        ingestOk: null,
        active: false,
        connected: false,
        value: 'OAuth app not configured',
        output: 'Set GOOGLE_OAUTH_CLIENT_ID / SECRET in .env',
        ingestTest: 'Not wired — set GOOGLE_OAUTH_CLIENT_ID / SECRET in .env',
        email: address,
        messageCount: 0,
      };
    }
    const appPassword = gmailAppPasswordFor(address, env);
    if (appPassword) {
      return {
        ok: true,
        ingestOk: true,
        active: true,
        connected: true,
        value: `App Password configured (${address})`,
        output: 'IMAP credentials on disk (skipped live IMAP for speed)',
        ingestTest: 'Pass — App Password present',
        email: address,
        messageCount: 0,
      };
    }
    const stored = await loadGmailTokenFor(address, env);
    if (!stored?.refresh_token && !stored?.access_token) {
      return {
        ok: false,
        ingestOk: null,
        active: false,
        connected: false,
        value: 'Gmail not connected',
        output: `Connect ${address} via Settings → Events sources`,
        ingestTest: `Not wired — connect ${address} (OAuth or App Password)`,
        email: address,
        messageCount: 0,
      };
    }
    const expiry = Number(stored.expiry_date) || 0;
    const freshAccess = Boolean(stored.access_token && expiry > Date.now() + 60_000);
    const emailOnFile = normalizeGmailAddress(stored.email) || address;
    return {
      ok: true,
      ingestOk: true,
      active: true,
      connected: true,
      value: freshAccess
        ? `Connected (${emailOnFile}) · token fresh`
        : `Connected (${emailOnFile}) · refresh on file`,
      output: freshAccess
        ? 'OAuth access token still valid on disk'
        : 'Refresh token on disk (live API check skipped for Settings speed)',
      ingestTest: 'Pass — Gmail OAuth credentials on disk',
      email: emailOnFile,
      messageCount: 0,
    };
  }

  const run = async () => {
    const appPassword = gmailAppPasswordFor(address, env);
    if (appPassword) {
      const { probeGmailMailboxViaImap } = await import('./events-finder-gmail-imap.js');
      return probeGmailMailboxViaImap(address, appPassword, env);
    }
    const auth = await getGmailAccessTokenFor(address, env);
    if (!auth.ok) {
      return {
        ok: false,
        ingestOk: null,
        active: false,
        connected: false,
        value: auth.code === 'oauth_not_configured'
          ? 'OAuth app not configured'
          : 'Gmail not connected',
        output: auth.error || 'Connect Gmail intake OAuth',
        ingestTest:
          auth.code === 'oauth_not_configured'
            ? 'Not wired — set GOOGLE_OAUTH_CLIENT_ID / SECRET in .env'
            : `Not wired — connect ${address} (OAuth or App Password)`,
        email: address,
        messageCount: 0,
      };
    }

    try {
      const q = encodeURIComponent(gmailEventsQuery(env));
      const list = await gmailGet(
        auth.accessToken,
        `/users/me/messages?maxResults=40&q=${q}`,
      );
      const profile = await gmailGet(auth.accessToken, '/users/me/profile');
      const profileEmail = String(profile?.emailAddress || auth.email || address).toLowerCase();
      const count = Array.isArray(list?.messages) ? list.messages.length : 0;
      const resultSize = Number(list?.resultSizeEstimate || count) || count;

      if (profileEmail && profileEmail !== address) {
        return {
          ok: true,
          ingestOk: false,
          active: true,
          connected: true,
          value: `Connected as ${profileEmail} (expected ${address})`,
          output: `Wrong mailbox — re-auth with login_hint ${address}`,
          ingestTest: `Fail — token is ${profileEmail}, want ${address}`,
          email: profileEmail,
          messageCount: count,
        };
      }

      return {
        ok: true,
        ingestOk: true,
        active: true,
        connected: true,
        value: `Connected (${profileEmail}) · API ok`,
        output: `${resultSize} candidate message(s) in query window`,
        ingestTest: `Pass — ${count} recent message(s) matched event query`,
        email: profileEmail,
        messageCount: count,
      };
    } catch (e) {
      return {
        ok: false,
        ingestOk: false,
        active: false,
        connected: true,
        value: 'Gmail API error',
        output: String(e?.message || e).slice(0, 120),
        ingestTest: `Fail — ${String(e?.message || e).slice(0, 100)}`,
        email: address,
        messageCount: 0,
      };
    }
  };

  try {
    return await Promise.race([
      run(),
      new Promise((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error('gmail_probe_timeout'), { code: 'timeout' })), timeoutMs);
      }),
    ]);
  } catch (e) {
    if (e?.code === 'timeout' || String(e?.message || e).includes('gmail_probe_timeout')) {
      return {
        ok: false,
        ingestOk: null,
        active: true,
        connected: true,
        value: 'Gmail probe timed out',
        output: `Still connected — status check exceeded ${timeoutMs}ms`,
        ingestTest: `Slow — Gmail status check timed out (${timeoutMs}ms)`,
        email: address,
        messageCount: 0,
      };
    }
    throw e;
  }
}

/**
 * Probe all configured intake mailboxes (aggregate for Settings).
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function probeGmailEventsIntake(env = process.env) {
  const addresses = gmailIntakeAddresses(env);
  const accounts = [];
  for (const addr of addresses) {
    accounts.push(await probeGmailMailbox(addr, env));
  }

  const connected = accounts.filter((a) => a.connected);
  const passing = accounts.filter((a) => a.ingestOk === true);
  const anyConfigured = accounts.some((a) => a.value !== 'OAuth app not configured');

  if (!anyConfigured || accounts.every((a) => a.value === 'OAuth app not configured')) {
    return {
      ok: false,
      ingestOk: null,
      active: false,
      value: 'OAuth app not configured',
      output: accounts[0]?.output || 'Connect Gmail intake OAuth',
      ingestTest: 'Not wired — set GOOGLE_OAUTH_CLIENT_ID / SECRET in .env',
      email: addresses.join(', '),
      emails: addresses,
      accounts,
      messageCount: 0,
    };
  }

  if (!connected.length) {
    return {
      ok: false,
      ingestOk: null,
      active: false,
      value: 'Gmail not connected',
      output: `Connect ${addresses.join(' + ')} via Settings → Events sources`,
      ingestTest: `Not wired — connect ${addresses.join(' / ')} (OAuth)`,
      email: addresses.join(', '),
      emails: addresses,
      accounts,
      messageCount: 0,
    };
  }

  const msgTotal = accounts.reduce((n, a) => n + (a.messageCount || 0), 0);
  const labels = accounts.map((a) => {
    if (a.ingestOk) return `${a.email} ✓`;
    if (a.connected) return `${a.email} !`;
    return `${a.email} ✗`;
  });

  if (passing.length === addresses.length) {
    return {
      ok: true,
      ingestOk: true,
      active: true,
      value: `Connected (${passing.length}/${addresses.length}) · API ok`,
      output: accounts.map((a) => a.output).join(' · '),
      ingestTest: `Pass — ${msgTotal} recent message(s) across ${passing.length} inbox(es)`,
      email: passing.map((a) => a.email).join(', '),
      emails: addresses,
      accounts,
      messageCount: msgTotal,
    };
  }

  if (passing.length > 0) {
    return {
      ok: true,
      ingestOk: true,
      active: true,
      value: `Partial (${passing.length}/${addresses.length}): ${labels.join(', ')}`,
      output: accounts.map((a) => `${a.email}: ${a.output}`).join(' · '),
      ingestTest: `Partial — ${passing.length}/${addresses.length} inbox(es) ok · ${msgTotal} message(s)`,
      email: passing.map((a) => a.email).join(', '),
      emails: addresses,
      accounts,
      messageCount: msgTotal,
    };
  }

  const firstFail = connected[0] || accounts[0];
  return {
    ok: false,
    ingestOk: false,
    active: Boolean(connected.length),
    value: firstFail?.value || 'Gmail API error',
    output: accounts.map((a) => `${a.email}: ${a.output}`).join(' · '),
    ingestTest: firstFail?.ingestTest || 'Fail — no inbox passed',
    email: addresses.join(', '),
    emails: addresses,
    accounts,
    messageCount: msgTotal,
  };
}

/**
 * Fetch + parse one mailbox.
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ maxMessages?: number }} [opts]
 */
export async function fetchGmailEventAnnouncementsFor(email, env = process.env, opts = {}) {
  const envMax = Number(env.GMAIL_EVENTS_MAX_MESSAGES);
  const maxMessages = Math.min(
    Math.max(Number(opts.maxMessages) || (Number.isFinite(envMax) ? envMax : 100), 1),
    200,
  );
  const address = normalizeGmailAddress(email);
  const appPassword = gmailAppPasswordFor(address, env);
  if (appPassword) {
    try {
      const { fetchGmailEventsViaImap } = await import('./events-finder-gmail-imap.js');
      return await fetchGmailEventsViaImap(address, appPassword, env, {
        maxMessages,
        windowDays: opts.windowDays,
        scrape: opts.scrape,
        windowWeeks: opts.windowWeeks,
        deferWindowFilter: opts.deferWindowFilter === true,
      });
    } catch (e) {
      return {
        ok: false,
        error: e?.code || 'gmail_imap',
        hint: String(e?.message || e),
        email: address,
        scanned: 0,
        events: [],
      };
    }
  }
  const auth = await getGmailAccessTokenFor(address, env);
  if (!auth.ok) {
    return {
      ok: false,
      error: auth.code || 'gmail_auth',
      hint: auth.error,
      email: address,
      scanned: 0,
      events: [],
    };
  }

  try {
    const q = encodeURIComponent(gmailEventsQuery(env));
    const list = await gmailGet(
      auth.accessToken,
      `/users/me/messages?maxResults=${maxMessages}&q=${q}`,
    );
    const ids = (list?.messages || []).map((m) => m.id).filter(Boolean);
    const profile = await gmailGet(auth.accessToken, '/users/me/profile');
    const mailbox = String(profile?.emailAddress || auth.email || address).toLowerCase();

    /** @type {Awaited<ReturnType<typeof eventsFromGmailMessage>>} */
    const events = [];
    for (const mid of ids) {
      const msg = await gmailGet(
        auth.accessToken,
        `/users/me/messages/${encodeURIComponent(mid)}?format=full`,
      );
      events.push(...eventsFromGmailMessage(msg, 'America/Los_Angeles', { mailbox }));
    }

    const windowDays =
      opts.windowDays
      || eventsIngestWindowDays(env, {
        scrape: opts.scrape,
        windowWeeks: opts.windowWeeks,
      });
    // Deferred filtering lets enrichment fill missing start dates first.
    const filtered = opts.deferWindowFilter
      ? events
      : filterEventsToIngestWindow(events, {
          pastDays: windowDays.pastDays,
        });

    return {
      ok: true,
      email: mailbox,
      query: gmailEventsQuery(env),
      scanned: ids.length,
      events: filtered,
      windowDays,
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.code || 'gmail_fetch',
      hint: String(e?.message || e),
      email: address,
      scanned: 0,
      events: [],
    };
  }
}

/**
 * Fetch + parse event announcements from all configured intake inboxes.
 * Horizon follows Scrape ahead (criteria.scrape.windowWeeks) unless opts override.
 * Disk cache + single-flight avoid ~10–20s IMAP on every Events sidebar load.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{
 *   maxMessages?: number,
 *   forceRefresh?: boolean,
 *   scrape?: { windowWeeks?: number } | null,
 *   windowWeeks?: number,
 *   windowDays?: { pastDays: number, futureDays: number, windowWeeks?: number },
 * }} [opts]
 */
export async function fetchGmailEventAnnouncements(env = process.env, opts = {}) {
  let scrape = opts.scrape;
  if (!opts.windowDays && scrape == null && opts.windowWeeks == null) {
    try {
      const criteria = await loadEventsFinderCriteria();
      scrape = criteria?.scrape || null;
    } catch {
      scrape = null;
    }
  }
  const windowDays =
    opts.windowDays || eventsIngestWindowDays(env, { scrape, windowWeeks: opts.windowWeeks });
  // Defer the per-mailbox window filter so enrichment can fill missing start dates
  // (e.g. Luma marketing emails) before we drop dateless events here.
  const fetchOpts = { ...opts, scrape, windowDays, deferWindowFilter: true };
  const force = opts.forceRefresh === true;

  const addresses = gmailIntakeAddresses(env);
  const query = gmailEventsQuery(env);
  const fingerprint = gmailCacheFingerprint(addresses, query, windowDays);

  if (!force) {
    const cache = await readGmailEventsCache(env);
    if (gmailCacheFresh(cache, fingerprint, env)) {
      return {
        ...cache,
        ok: true,
        fromCache: true,
        stale: false,
        cachedAt: cache.cachedAt || null,
        events: Array.isArray(cache.events) ? cache.events : [],
        windowDays: cache.windowDays || windowDays,
      };
    }
  }

  if (!force && gmailEventsInflight) {
    return gmailEventsInflight;
  }

  const run = (async () => {
    const results = await Promise.all(
      addresses.map((addr) => fetchGmailEventAnnouncementsFor(addr, env, fetchOpts)),
    );

    /** @type {Awaited<ReturnType<typeof eventsFromGmailMessage>>} */
    const events = [];
    /** @type {string[]} */
    const emailsOk = [];
    /** @type {string[]} */
    const hints = [];
    let scanned = 0;
    let anyOk = false;

    for (const r of results) {
      scanned += r.scanned || 0;
      if (r.ok) {
        anyOk = true;
        if (r.email) emailsOk.push(r.email);
        events.push(...(r.events || []));
      } else if (r.hint) {
        hints.push(`${r.email}: ${r.hint}`);
      }
    }

    let enriched = events;
    try {
      enriched = await enrichGmailEventsFromPublicPages(events);
    } catch (e) {
      console.warn('[events-finder] gmail public-page enrich failed:', e?.message || e);
      enriched = events;
    }
    try {
      enriched = await enrichEventsByFollowingLinks(enriched, {
        guessStartIso: guessEventStartIso,
      });
    } catch (e) {
      console.warn('[events-finder] gmail link-follow enrich failed:', e?.message || e);
    }

    try {
      noteSeriesPromoFromEvents(enriched);
      const watchCards = expandActiveSeriesWatchesToEvents({
        ymdAtLocalNoonIso,
        ymdAtLocalTimeIso,
      });
      if (watchCards.length) enriched = [...enriched, ...watchCards];
    } catch (e) {
      console.warn('[events-finder] series watch expand failed:', e?.message || e);
    }
    // Fire-and-forget renewal hunt (does not block feed).
    huntStaleSeriesWatches().catch((e) => {
      console.warn('[events-finder] series renewal hunt failed:', e?.message || e);
    });

    // Keep past-floor only. Far-future dated invites (months out) are recorded —
    // scrape-ahead no longer truncates the catalog. Dateless events still need a
    // platform / whitelist link / .ics anchor so subject-only noise stays out.
    const nowMs = Date.now();
    const pastMs = windowDays.pastDays * 24 * 60 * 60 * 1000;
    const windowed = enriched.filter((ev) => {
      const ms = ev?.start ? Date.parse(ev.start) : Number.NaN;
      if (Number.isFinite(ms)) {
        return ms >= nowMs - pastMs;
      }
      const via = String(ev?.raw?.via || '');
      const linkPool = [
        ...(Array.isArray(ev?.raw?.urls) ? ev.raw.urls : []),
        ...(Array.isArray(ev?.raw?.followUrls) ? ev.raw.followUrls : []),
        ev?.url,
      ].filter(Boolean);
      const hasPlatformLink = linkPool.some(
        (u) => isWhitelistedEventPlatformHost(u) || platformUrlScore(u) >= 40,
      );
      // Personal invites without a recoverable date still need a followable link.
      if (ev?.raw?.personal && linkPool.some((u) => !String(u).includes('mail.google.com'))) {
        return true;
      }
      return via === 'ics' || hasPlatformLink;
    });

    // Dedupe by platform URL when present, else by id.
    // Multi-event digests (via dated_blocks / recurring_series) and thin marketing
    // homepages keep id keys so distinct parties in one email are not collapsed.
    const seen = new Set();
    /** @type {typeof events} */
    const deduped = [];
    for (const ev of windowed) {
      const via = String(ev?.raw?.via || '');
      const href = String(ev.url || '');
      const useUrlKey =
        href
        && !href.includes('mail.google.com')
        && via !== 'dated_blocks'
        && via !== 'recurring_series'
        && via !== 'link_follow_series'
        && via !== 'series_watch'
        && !isThinMarketingEventUrl(href);
      const urlKey = useUrlKey
        ? `url:${href.split('#')[0].toLowerCase()}`
        : `id:${ev.id}`;
      if (seen.has(urlKey)) continue;
      seen.add(urlKey);
      deduped.push(ev);
    }

    deduped.sort((a, b) => {
      const am = a.start ? Date.parse(a.start) : Number.POSITIVE_INFINITY;
      const bm = b.start ? Date.parse(b.start) : Number.POSITIVE_INFINITY;
      return am - bm;
    });

    if (!anyOk) {
      const failed = {
        ok: false,
        fromCache: false,
        stale: false,
        cachedAt: null,
        error: results[0]?.error || 'gmail_auth',
        hint: hints.join(' · ') || results[0]?.hint || 'Connect Gmail intake',
        email: addresses.join(', '),
        emails: addresses,
        accounts: results.map((r) => ({
          email: r.email,
          ok: r.ok,
          error: r.error || null,
          hint: r.hint || null,
          scanned: r.scanned || 0,
          count: Array.isArray(r.events) ? r.events.length : 0,
        })),
        scanned,
        events: [],
        windowDays,
      };
      // Prefer stale cache over empty failure (sidebar still paints prior intake).
      const stale = await readGmailEventsCache(env);
      if (stale && Array.isArray(stale.events) && stale.events.length) {
        return {
          ...stale,
          ok: true,
          fromCache: true,
          stale: true,
          error: failed.error,
          hint: failed.hint || 'Using stale Gmail cache',
          events: stale.events,
          windowDays: stale.windowDays || windowDays,
        };
      }
      return failed;
    }

    const payload = {
      ok: true,
      fromCache: false,
      stale: false,
      cachedAt: new Date().toISOString(),
      fingerprint,
      email: emailsOk.join(', '),
      emails: emailsOk,
      accounts: results.map((r) => ({
        email: r.email,
        ok: r.ok,
        error: r.error || null,
        hint: r.hint || null,
        scanned: r.scanned || 0,
        count: Array.isArray(r.events) ? r.events.length : 0,
      })),
      query,
      scanned,
      events: deduped,
      windowDays,
      hint: hints.length ? hints.join(' · ') : null,
      error: null,
    };
    try {
      await writeGmailEventsCache(payload, env);
    } catch (e) {
      console.warn('[events-finder] gmail cache write failed:', e?.message || e);
    }
    return payload;
  })();

  gmailEventsInflight = run;
  run.finally(() => {
    if (gmailEventsInflight === run) gmailEventsInflight = null;
  });
  return run;
}

/**
 * Config snapshot for Settings / API (no secrets).
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function gmailIntakeStatusSummary(env = process.env) {
  const client = gmailOAuthClient(env);
  const addresses = gmailIntakeAddresses(env);
  const accounts = [];
  for (const email of addresses) {
    const token = await loadGmailTokenFor(email, env);
    const appPassword = Boolean(gmailAppPasswordFor(email, env));
    accounts.push({
      email,
      tokenOnDisk: Boolean(token?.refresh_token || token?.access_token),
      appPasswordConfigured: appPassword,
      oauthStartPath: `/api/events-finder-gmail/oauth/start?email=${encodeURIComponent(email)}`,
    });
  }
  return {
    address: addresses[0],
    addresses,
    accounts,
    oauthConfigured: Boolean(client),
    tokenOnDisk: accounts.some((a) => a.tokenOnDisk),
    appPasswordConfigured: accounts.some((a) => a.appPasswordConfigured),
    redirectUri: gmailOAuthRedirectUri(env),
    query: gmailEventsQuery(env),
  };
}

/**
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function gmailTokenExists(email, env = process.env) {
  try {
    await access(gmailTokenPathFor(email, env));
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the contact email appears exactly in From / To / Cc (not name-only matches).
 * @param {{ from?: string, to?: string, cc?: string } | null | undefined} message
 * @param {string} email
 */
export function messageInvolvesExactEmail(message, email) {
  const want = normalizeGmailAddress(email);
  if (!want) return false;
  const blob = [message?.from, message?.to, message?.cc].map((s) => String(s || '')).join(' ');
  const found =
    blob.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || [];
  return found.some((addr) => normalizeGmailAddress(addr) === want);
}

/**
 * Deep link that opens one specific Gmail message (never a subject search).
 * @param {{
 *   mailbox?: string,
 *   gmailId?: string | null,
 *   rfc822MessageId?: string | null,
 *   id?: string,
 * }} message
 */
export function gmailExactMessageUrl(message) {
  const mailbox = normalizeGmailAddress(message?.mailbox || '');
  if (!mailbox) return null;
  const auth = encodeURIComponent(mailbox);
  const rfc = String(message?.rfc822MessageId || '')
    .trim()
    .replace(/^<|>$/g, '');
  if (rfc) {
    return `https://mail.google.com/mail/u/?authuser=${auth}#search/${encodeURIComponent(`rfc822msgid:${rfc}`)}`;
  }
  const gmailId = String(message?.gmailId || '').trim().toLowerCase();
  if (gmailId && /^[0-9a-f]+$/.test(gmailId) && !/^\d+$/.test(gmailId)) {
    return `https://mail.google.com/mail/u/?authuser=${auth}#all/${gmailId}`;
  }
  const id = String(message?.id || '').trim();
  // Gmail API ids are hex; bare IMAP UIDs are decimal — those must not use #all/.
  if (id && /^[0-9a-f]+$/i.test(id) && !/^\d+$/.test(id)) {
    return `https://mail.google.com/mail/u/?authuser=${auth}#all/${id.toLowerCase()}`;
  }
  return null;
}

/**
 * Google/Outlook calendar bot notifications (invites, RSVPs, reminders, updates).
 * Used to hide noise from the shared-email list; keep them for relationship summary.
 * @param {{ from?: string, subject?: string, snippet?: string } | null | undefined} message
 */
export function isCalendarNotificationEmail(message) {
  const from = String(message?.from || '').toLowerCase();
  const subject = String(message?.subject || '').trim();
  if (
    /calendar-notification@google\.com/i.test(from)
    || /calendar\.google\.com/i.test(from)
    || /noreply@google\.com/i.test(from) && /\bgoogle calendar\b/i.test(from)
    || /\bgoogle calendar\b/i.test(from)
    || /calendar-notification@.*\.outlook\.com/i.test(from)
    || /noreply@.*\.calendar\.office365\.com/i.test(from)
  ) {
    return true;
  }
  // Gmail often labels these with a stable subject prefix even when From is odd.
  if (
    /^(invitation|accepted|declined|tentatively accepted|updated invitation|canceled event|cancelled event|notification|reminder|proposed new time)\s*:/i.test(
      subject,
    )
    && (/calendar/i.test(from) || /google\.com/i.test(from) || /outlook\.com/i.test(from))
  ) {
    return true;
  }
  return false;
}

/**
 * Find emails across Gmail intake mailboxes that involve this person
 * (from/to/cc their email, or their name in the message).
 *
 * @param {{
 *   email?: string | null,
 *   displayName?: string | null,
 *   aliases?: string[],
 * }} contact
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ maxMessages?: number, mode?: 'list' | 'full', headersOnly?: boolean }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   detail?: string,
 *   query?: string,
 *   messages?: Array<{
 *     id: string,
 *     mailbox: string,
 *     subject: string,
 *     from: string,
 *     to: string,
 *     date: string,
 *     snippet: string,
 *     text: string,
 *   }>,
 *   combinedText?: string,
 * }>}
 */
export async function fetchSharedEmailsWithContact(contact, env = process.env, opts = {}) {
  const maxMessages = Math.min(Math.max(Number(opts.maxMessages) || 24, 1), 100);
  const listMode = opts.mode === 'list' || opts.headersOnly === true;
  const email = normalizeGmailAddress(contact?.email || '');
  // Exact address only — name/alias text matches pull in unrelated mail.
  if (!email) {
    return { ok: false, error: 'no_email_or_name' };
  }
  const query = `(from:${email} OR to:${email} OR cc:${email})`;

  const mailboxes = gmailIntakeAddresses(env);
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} mailbox
   * @returns {Promise<Array<{
   *   id: string,
   *   mailbox: string,
   *   subject: string,
   *   from: string,
   *   to: string,
   *   date: string,
   *   snippet: string,
   *   text: string,
   *   gmailId?: string | null,
   *   rfc822MessageId?: string | null,
   * }>>}
   */
  async function fetchMailbox(mailbox) {
    const appPassword = gmailAppPasswordFor(mailbox, env);
    if (appPassword) {
      const imap = await import('./events-finder-gmail-imap.js');
      const found = listMode
        ? await imap.fetchGmailMessageListViaImap(mailbox, appPassword, env, {
            maxMessages,
            query,
            days: 3650,
          })
        : await imap.fetchGmailWeeklyMessagesViaImap(mailbox, appPassword, env, {
            maxMessages,
            query,
            days: 3650,
          });
      if (!found.ok) {
        errors.push(`${mailbox}: ${found.error || 'gmail_imap'}`);
        return [];
      }
      return (found.messages || [])
        .map((m) => ({
          id: String(m.id || ''),
          mailbox,
          subject: String(m.subject || '(no subject)'),
          from: String(m.from || ''),
          to: String(m.to || ''),
          cc: String(m.cc || ''),
          date: String(m.date || ''),
          snippet: String(m.snippet || '').trim().slice(0, 280),
          text: listMode ? '' : String(m.text || m.snippet || '').trim().slice(0, 8_000),
          gmailId: m.gmailId || null,
          rfc822MessageId: m.rfc822MessageId || null,
        }))
        .filter((m) => messageInvolvesExactEmail(m, email));
    }

    const auth = await getGmailAccessTokenFor(mailbox, env);
    if (!auth?.ok || !auth.accessToken) {
      errors.push(`${mailbox}: ${auth?.error || auth?.code || 'not_connected'}`);
      return [];
    }

    const list = await gmailGet(
      auth.accessToken,
      `/users/me/messages?maxResults=${maxMessages}&q=${encodeURIComponent(query)}`,
    );
    const ids = Array.isArray(list?.messages)
      ? list.messages.map((m) => String(m.id || '')).filter(Boolean)
      : [];
    /** @type {Array<{
     *   id: string,
     *   mailbox: string,
     *   subject: string,
     *   from: string,
     *   to: string,
     *   date: string,
     *   snippet: string,
     *   text: string,
     *   gmailId?: string | null,
     *   rfc822MessageId?: string | null,
     * }>} */
    const out = [];
    for (const id of ids.slice(0, maxMessages)) {
      const path = listMode
        ? `/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date&metadataHeaders=Message-ID`
        : `/users/me/messages/${encodeURIComponent(id)}?format=full`;
      const full = await gmailGet(auth.accessToken, path);
      const headers = full?.payload?.headers || [];
      const subject = headerValue(headers, 'Subject') || '(no subject)';
      const from = headerValue(headers, 'From');
      const to = headerValue(headers, 'To');
      const cc = headerValue(headers, 'Cc');
      const date = headerValue(headers, 'Date');
      const rfc822MessageId = headerValue(headers, 'Message-ID').replace(/^<|>$/g, '') || null;
      let text = '';
      if (!listMode) {
        /** @type {{ texts: string[], htmls: string[], ics: string[] }} */
        const bag = { texts: [], htmls: [], ics: [] };
        collectMimeParts(full?.payload, bag);
        text = [...bag.texts, ...bag.htmls.map(stripHtml)]
          .join('\n')
          .replace(/\s+\n/g, '\n')
          .trim()
          .slice(0, 8_000);
      }
      const row = {
        id,
        mailbox,
        subject,
        from,
        to,
        cc,
        date,
        snippet: String(full?.snippet || '').trim().slice(0, 280),
        text: text || (listMode ? '' : String(full?.snippet || '').trim()),
        gmailId: /^[0-9a-f]+$/i.test(id) ? id.toLowerCase() : null,
        rfc822MessageId,
      };
      if (!messageInvolvesExactEmail(row, email)) continue;
      out.push(row);
    }
    return out;
  }

  const batches = await Promise.all(
    mailboxes.map(async (mailbox) => {
      try {
        return await fetchMailbox(mailbox);
      } catch (e) {
        errors.push(`${mailbox}: ${e?.message || e}`);
        return [];
      }
    }),
  );

  /** @type {Array<{
   *   id: string,
   *   mailbox: string,
   *   subject: string,
   *   from: string,
   *   to: string,
   *   date: string,
   *   snippet: string,
   *   text: string,
   *   gmailId?: string | null,
   *   rfc822MessageId?: string | null,
   * }>} */
  const messages = [];
  for (const batch of batches) {
    for (const m of batch) {
      if (messages.some((x) => x.id === m.id && x.mailbox === m.mailbox)) continue;
      messages.push(m);
    }
  }

  if (!messages.length) {
    return {
      ok: false,
      error: errors.length ? 'gmail_search_failed' : 'no_shared_emails',
      detail: errors.slice(0, 4).join('; ') || undefined,
    };
  }

  messages.sort((a, b) => (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0));
  const trimmed = messages.slice(0, maxMessages);

  const combinedText = listMode
    ? ''
    : trimmed
        .map(
          (m) =>
            `Email (${m.mailbox})\nFrom: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.text || m.snippet}`,
        )
        .join('\n\n==========\n\n')
        .slice(0, 28_000);

  return {
    ok: true,
    query,
    messages: trimmed.map((m) => ({
      ...m,
      text: listMode ? '' : String(m.text || '').slice(0, 500),
    })),
    combinedText,
  };
}
