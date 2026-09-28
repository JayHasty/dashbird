/**
 * Fetch last-N-days general mail from intake inboxes for Daily Summary synthesis.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectMimeParts,
  getGmailAccessTokenFor,
  gmailAppPasswordFor,
  gmailGet,
  gmailIntakeAddresses,
  headerValue,
  normalizeGmailAddress,
  stripHtml,
} from './events-finder-gmail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

/** Rolling catch-up window (matches Daily Summary retention). */
const DEFAULT_DAYS = 10;
const DEFAULT_MAX_PER_MAILBOX = 40;
const DEFAULT_CACHE_MS = 30 * 60 * 1000;
const TEXT_CAP = 2_500;

/** @type {Promise<object> | null} */
let weeklyMailInflight = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} keys
 */
function envFirst(env, keys) {
  for (const key of keys) {
    const v = String(env[key] || '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailWeeklySummaryCachePath(env = process.env) {
  const override = envFirst(env, [
    'GMAIL_DAILY_SUMMARY_CACHE_PATH',
    'GMAIL_WEEKLY_SUMMARY_CACHE_PATH',
  ]);
  if (override) {
    return path.isAbsolute(override) ? override : path.join(root, override);
  }
  return path.join(root, 'data', 'gmail-weekly-summary-mail-cache.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function cacheTtlMs(env = process.env) {
  const raw = Number(
    env.GMAIL_DAILY_SUMMARY_CACHE_MS || env.GMAIL_WEEKLY_SUMMARY_CACHE_MS,
  );
  if (Number.isFinite(raw) && raw >= 60_000) return raw;
  return DEFAULT_CACHE_MS;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailWeeklySummaryQuery(env = process.env) {
  const override = envFirst(env, [
    'GMAIL_DAILY_SUMMARY_QUERY',
    'GMAIL_WEEKLY_SUMMARY_QUERY',
  ]);
  if (override) return override;
  const days = gmailWeeklySummaryDays(env);
  return `newer_than:${days}d`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailWeeklySummaryDays(env = process.env) {
  const raw = Number(env.GMAIL_DAILY_SUMMARY_DAYS || env.GMAIL_WEEKLY_SUMMARY_DAYS);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 21) return Math.floor(raw);
  return DEFAULT_DAYS;
}

/**
 * @param {any} full
 * @param {string} mailbox
 */
function normalizeMessage(full, mailbox) {
  const id = String(full?.id || '');
  const headers = full?.payload?.headers || [];
  const subject = headerValue(headers, 'Subject') || '(no subject)';
  const from = headerValue(headers, 'From');
  const to = headerValue(headers, 'To');
  const date = headerValue(headers, 'Date');
  /** @type {{ texts: string[], htmls: string[], ics: string[] }} */
  const bag = { texts: [], htmls: [], ics: [] };
  collectMimeParts(full?.payload, bag);
  const text = [...bag.texts, ...bag.htmls.map(stripHtml)]
    .join('\n')
    .replace(/\s+\n/g, '\n')
    .trim()
    .slice(0, TEXT_CAP);
  const rfc822MessageId = String(headerValue(headers, 'Message-ID') || '')
    .trim()
    .replace(/^<|>$/g, '') || null;
  // Gmail API message ids are already the hex web-UI ids.
  const gmailId = id && /^[0-9a-f]+$/i.test(id) && !/^\d+$/.test(id) ? id.toLowerCase() : null;
  return {
    id,
    threadId: String(full?.threadId || ''),
    mailbox: normalizeGmailAddress(mailbox),
    subject,
    from,
    to,
    date,
    snippet: String(full?.snippet || '')
      .trim()
      .slice(0, 280),
    text: text || String(full?.snippet || '').trim(),
    gmailId,
    rfc822MessageId,
  };
}

/**
 * @param {string} email
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ maxMessages?: number, days?: number, query?: string }} [opts]
 */
export async function fetchWeeklyMailboxMessages(email, env = process.env, opts = {}) {
  const address = normalizeGmailAddress(email);
  const maxMessages = Math.min(
    Math.max(Number(opts.maxMessages) || DEFAULT_MAX_PER_MAILBOX, 1),
    80,
  );
  const days = Math.min(Math.max(Number(opts.days) || gmailWeeklySummaryDays(env), 1), 180);
  const query = String(opts.query || gmailWeeklySummaryQuery(env)).trim() || `newer_than:${days}d`;

  const appPassword = gmailAppPasswordFor(address, env);
  if (appPassword) {
    const { fetchGmailWeeklyMessagesViaImap } = await import('./events-finder-gmail-imap.js');
    return fetchGmailWeeklyMessagesViaImap(address, appPassword, env, {
      maxMessages,
      days,
      query,
    });
  }

  const auth = await getGmailAccessTokenFor(address, env);
  if (!auth?.ok || !auth.accessToken) {
    return {
      ok: false,
      email: address,
      via: 'oauth',
      query,
      scanned: 0,
      messages: [],
      error: auth?.error || auth?.code || 'oauth_not_connected',
    };
  }

  const list = await gmailGet(
    auth.accessToken,
    `/users/me/messages?maxResults=${maxMessages}&q=${encodeURIComponent(query)}`,
  );
  const ids = Array.isArray(list?.messages)
    ? list.messages.map((m) => String(m.id || '')).filter(Boolean)
    : [];

  /** @type {ReturnType<typeof normalizeMessage>[]} */
  const messages = [];
  for (const mid of ids.slice(0, maxMessages)) {
    const full = await gmailGet(
      auth.accessToken,
      `/users/me/messages/${encodeURIComponent(mid)}?format=full`,
    );
    messages.push(normalizeMessage(full, address));
  }

  return {
    ok: true,
    email: address,
    via: 'oauth',
    query,
    scanned: ids.length,
    messages,
  };
}

/**
 * @param {string[]} addresses
 * @param {string} query
 * @param {number} days
 */
function cacheFingerprint(addresses, query, days) {
  return JSON.stringify({
    addresses: [...addresses].map((a) => String(a || '').toLowerCase()).sort(),
    query: String(query || ''),
    days,
  });
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function readCache(env = process.env) {
  try {
    const raw = await readFile(gmailWeeklySummaryCachePath(env), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Enrich a digest source with gmailId / rfc822MessageId from the mail cache
 * (helps Reply links for items created before IMAP X-GM-MSGID capture).
 * @param {{
 *   email?: string,
 *   messageId?: string,
 *   subject?: string,
 *   gmailId?: string | null,
 *   rfc822MessageId?: string | null,
 * } | null | undefined} source
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function enrichSourceFromMailCache(source, env = process.env) {
  if (!source?.email) return source || null;
  if (source.gmailId || source.rfc822MessageId) return source;
  const cache = await readCache(env);
  const messages = Array.isArray(cache?.messages) ? cache.messages : [];
  if (!messages.length) return source;
  const email = String(source.email).toLowerCase();
  const mid = String(source.messageId || '');
  const subject = String(source.subject || '').trim().toLowerCase();
  const hit =
    messages.find(
      (m) =>
        String(m?.mailbox || '').toLowerCase() === email
        && String(m?.id || '') === mid,
    )
    || (subject
      ? messages.find(
          (m) =>
            String(m?.mailbox || '').toLowerCase() === email
            && String(m?.subject || '').trim().toLowerCase() === subject,
        )
      : null);
  if (!hit) return source;
  return {
    ...source,
    gmailId: hit.gmailId || source.gmailId || null,
    rfc822MessageId: hit.rfc822MessageId || source.rfc822MessageId || null,
    threadId: hit.threadId || source.threadId || '',
    from: String(hit.from || source.from || '').trim() || source.from,
  };
}

/**
 * @param {object} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeCache(payload, env = process.env) {
  const p = gmailWeeklySummaryCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * @param {object | null} cache
 * @param {string} fingerprint
 * @param {NodeJS.ProcessEnv} [env]
 */
function cacheFresh(cache, fingerprint, env = process.env) {
  if (!cache || cache.fingerprint !== fingerprint) return false;
  const cachedAt = Date.parse(String(cache.cachedAt || ''));
  if (!Number.isFinite(cachedAt)) return false;
  return Date.now() - cachedAt < cacheTtlMs(env);
}

/**
 * Fetch messages from all intake inboxes for the weekly window.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean, maxMessages?: number }} [opts]
 */
export async function fetchWeeklySummaryMail(env = process.env, opts = {}) {
  const addresses = gmailIntakeAddresses(env);
  const days = gmailWeeklySummaryDays(env);
  const query = gmailWeeklySummaryQuery(env);
  const fingerprint = cacheFingerprint(addresses, query, days);

  if (!opts.forceRefresh) {
    const cache = await readCache(env);
    if (cacheFresh(cache, fingerprint, env)) {
      return {
        ok: true,
        fromCache: true,
        stale: false,
        days,
        query,
        addresses,
        messages: cache.messages,
        errors: Array.isArray(cache.errors) ? cache.errors : [],
        cachedAt: cache.cachedAt,
      };
    }
  }

  if (weeklyMailInflight) return weeklyMailInflight;

  weeklyMailInflight = (async () => {
    /** @type {ReturnType<typeof normalizeMessage>[]} */
    const messages = [];
    /** @type {string[]} */
    const errors = [];
    const maxMessages = Math.min(
      Math.max(Number(opts.maxMessages) || DEFAULT_MAX_PER_MAILBOX, 1),
      80,
    );

    const results = await Promise.all(
      addresses.map(async (address) => {
        try {
          return await fetchWeeklyMailboxMessages(address, env, {
            maxMessages,
            days,
            query,
          });
        } catch (e) {
          return {
            ok: false,
            email: address,
            messages: [],
            error: String(e?.message || e),
          };
        }
      }),
    );

    for (const result of results) {
      if (!result?.ok) {
        errors.push(`${result?.email || '?'}: ${result?.error || 'fetch_failed'}`);
        continue;
      }
      for (const m of result.messages || []) {
        if (!m?.id) continue;
        const key = `${m.mailbox}:${m.id}`;
        if (messages.some((x) => `${x.mailbox}:${x.id}` === key)) continue;
        messages.push(m);
      }
    }

    messages.sort((a, b) => (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0));

    if (!messages.length && errors.length) {
      const stale = await readCache(env);
      if (stale?.messages?.length) {
        return {
          ok: true,
          fromCache: true,
          stale: true,
          days,
          query,
          addresses,
          messages: stale.messages,
          errors,
          cachedAt: stale.cachedAt,
        };
      }
      return {
        ok: false,
        fromCache: false,
        stale: false,
        days,
        query,
        addresses,
        messages: [],
        errors,
        error: 'gmail_weekly_fetch_failed',
      };
    }

    const payload = {
      cachedAt: new Date().toISOString(),
      fingerprint,
      days,
      query,
      addresses,
      messages,
      errors,
    };
    try {
      await writeCache(payload, env);
    } catch {
      /* ignore cache write */
    }

    return {
      ok: true,
      fromCache: false,
      stale: false,
      days,
      query,
      addresses,
      messages,
      errors,
      cachedAt: payload.cachedAt,
    };
  })().finally(() => {
    weeklyMailInflight = null;
  });

  return weeklyMailInflight;
}
