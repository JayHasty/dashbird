/**
 * Producer announcement mail → Big Events watchlist bridge.
 * Scans Gmail for known festival producers and auto-adds/updates conference
 * watchlist entries from their Mailchimp blasts (Take 3 Presents, etc.).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gmailIntakeAddresses,
  gmailAppPasswordFor,
  getGmailAccessTokenFor,
  gmailGet,
  headerValue,
  collectMimeParts,
  stripHtml,
  parseEventDateRange,
  guessEventStartIso,
  extractPlatformUrls,
  pickBestPlatformUrl,
} from './events-finder-gmail.js';
import { fetchGmailWeeklyMessagesViaImap } from './events-finder-gmail-imap.js';
import {
  loadEventsFinderCriteria,
  saveEventsFinderCriteria,
} from './events-finder-criteria-store.js';
import {
  slugFromQuery,
  upsertConferenceWatchlistRecords,
  loadConferenceWatchlistStore,
} from './events-finder-conference-watchlist-store.js';
import {
  normalizeConferenceWatchlist,
  researchConferenceQuery,
} from './events-finder-conference-watchlist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const SEEN_CAP = 600;

/**
 * @typedef {{
 *   id: string,
 *   gmailQuery: string,
 *   homepageUrl: string,
 *   sitePassword?: string,
 *   eventMatchers: Array<{ pattern: RegExp, name: string }>,
 * }} ProducerRule
 */

/** @type {ProducerRule[]} */
export const PRODUCER_RULES = [
  {
    id: 'take3',
    gmailQuery: 'newer_than:120d from:take3presents.com',
    homepageUrl: 'https://www.take3presents.com/',
    // Published on take3presents.com waiver; unlocks Squarespace gate for research.
    sitePassword: 'sasquatch',
    eventMatchers: [
      { pattern: /\broom\s+service\b/i, name: 'Room Service' },
      { pattern: /\bbig\s+stick(?:\s+shindig)?\b/i, name: 'Big Stick Shindig' },
    ],
  },
];

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function producerMailSeenPath(env = process.env) {
  const override = String(env.EVENTS_FINDER_PRODUCER_MAIL_SEEN_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(root, override);
  }
  return path.join(root, 'data', 'events-finder-producer-mail-seen.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function loadProducerMailSeen(env = process.env) {
  try {
    const raw = await readFile(producerMailSeenPath(env), 'utf8');
    const data = JSON.parse(raw);
    const seen = data?.seen && typeof data.seen === 'object' ? data.seen : {};
    return { seen: /** @type {Record<string, string>} */ (seen) };
  } catch {
    return { seen: {} };
  }
}

/**
 * @param {Record<string, string>} seen
 * @param {NodeJS.ProcessEnv} [env]
 */
async function saveProducerMailSeen(seen, env = process.env) {
  const entries = Object.entries(seen)
    .sort((a, b) => Date.parse(b[1] || '') - Date.parse(a[1] || ''))
    .slice(0, SEEN_CAP);
  const target = producerMailSeenPath(env);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({ seen: Object.fromEntries(entries) }, null, 2), 'utf8');
}

/**
 * @param {string} subject
 * @param {string} body
 * @param {ProducerRule} rule
 * @returns {string | null}
 */
export function matchProducerEventName(subject, body, rule) {
  const subj = String(subject || '');
  const lead =
    String(body || '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || '';
  for (const matcher of rule.eventMatchers) {
    // Producer blasts name the event in the subject or opening title line.
    if (matcher.pattern.test(subj)) return matcher.name;
    if (matcher.pattern.test(lead)) return matcher.name;
  }
  return null;
}

/**
 * @param {string} baseName
 * @param {string} subject
 * @param {string} body
 * @returns {string}
 */
export function producerWatchlistQuery(baseName, subject, body) {
  if (/\b20\d{2}\b/.test(baseName)) return baseName.trim();
  const subjectYear = String(subject || '').match(/\b(20\d{2})\b/);
  if (subjectYear?.[1]) return `${baseName.trim()} ${subjectYear[1]}`;
  const yearMatch = `${subject}\n${body}`.match(/\b(20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear());
  return `${baseName.trim()} ${year}`.trim();
}

/**
 * @param {string} body
 * @returns {string | null}
 */
export function guessProducerCity(body) {
  const text = String(body || '');
  const inCity = text.match(/\bin\s+([A-Z][A-Za-z.'\-\s]{2,60}?)(?:,|\s+and\s|\.\s|$)/);
  if (inCity?.[1]) {
    const city = inCity[1].trim().replace(/\s+/g, ' ');
    if (city.length >= 3 && city.length <= 60) return city;
  }
  return null;
}

/**
 * @param {string} mailbox
 * @param {string} query
 * @param {NodeJS.ProcessEnv} env
 * @param {{ maxMessages?: number }} [opts]
 */
async function fetchProducerMailboxMessages(mailbox, query, env, opts = {}) {
  const maxMessages = Math.min(Math.max(Number(opts.maxMessages) || 20, 1), 50);
  const appPassword = gmailAppPasswordFor(mailbox, env);
  if (appPassword) {
    return fetchGmailWeeklyMessagesViaImap(mailbox, appPassword, env, {
      maxMessages,
      query,
      days: 3650,
    });
  }
  const auth = await getGmailAccessTokenFor(mailbox, env);
  if (!auth?.ok || !auth.accessToken) {
    return { ok: false, error: auth?.error || auth?.code || 'not_connected', messages: [] };
  }
  const list = await gmailGet(
    auth.accessToken,
    `/users/me/messages?maxResults=${maxMessages}&q=${encodeURIComponent(query)}`,
  );
  const ids = (list?.messages || []).map((m) => String(m.id || '')).filter(Boolean);
  /** @type {Array<{ id: string, mailbox: string, subject: string, from: string, date: string, text: string, rfc822MessageId?: string | null }>} */
  const messages = [];
  for (const id of ids) {
    const full = await gmailGet(
      auth.accessToken,
      `/users/me/messages/${encodeURIComponent(id)}?format=full`,
    );
    const headers = full?.payload?.headers || [];
    const subject = headerValue(headers, 'Subject') || '(no subject)';
    const from = headerValue(headers, 'From');
    const date = headerValue(headers, 'Date');
    const rfc822MessageId = headerValue(headers, 'Message-ID').replace(/^<|>$/g, '') || null;
    /** @type {{ texts: string[], htmls: string[], ics: string[] }} */
    const bag = { texts: [], htmls: [], ics: [] };
    collectMimeParts(full?.payload, bag);
    const text = [...bag.texts, ...bag.htmls.map(stripHtml)]
      .join('\n')
      .replace(/\s+\n/g, '\n')
      .trim()
      .slice(0, 12_000);
    messages.push({
      id,
      mailbox,
      subject,
      from,
      date,
      text,
      rfc822MessageId,
    });
  }
  return { ok: true, messages };
}

/**
 * @param {{
 *   id: string,
 *   mailbox: string,
 *   subject: string,
 *   from: string,
 *   date: string,
 *   text: string,
 *   rfc822MessageId?: string | null,
 * }} message
 * @param {ProducerRule} rule
 */
export function extractProducerAnnouncement(message, rule) {
  const subject = String(message.subject || '').trim();
  const body = String(message.text || '').trim();
  const baseName = matchProducerEventName(subject, body, rule);
  if (!baseName) return null;

  const query = producerWatchlistQuery(baseName, subject, body);
  const slug = slugFromQuery(query);
  if (!slug) return null;

  const blob = `${subject}\n${body}`;
  const range = parseEventDateRange(blob);
  const startIso = guessEventStartIso(blob);
  const eventStart = range?.eventStart
    || (startIso ? startIso.slice(0, 10) : null);
  const eventEnd = range?.eventEnd || null;
  const city = guessProducerCity(body);
  const urls = extractPlatformUrls(body);
  const homepageUrl = pickBestPlatformUrl(
    urls.filter((u) => /take3presents\.com/i.test(u)),
    rule.homepageUrl,
  );
  const seenKey = message.rfc822MessageId
    ? `msg:${message.rfc822MessageId}`
    : `gmail:${message.mailbox}:${message.id}`;

  return {
    slug,
    query,
    name: query,
    homepageUrl: homepageUrl || rule.homepageUrl,
    url: homepageUrl || rule.homepageUrl,
    eventStart,
    eventEnd,
    city,
    notes: `Auto-added from producer mail (${rule.id}): ${subject}`.slice(0, 500),
    seenKey,
    subject,
    date: message.date || null,
  };
}

/**
 * Run producer-mail scan and promote matched announcements to Big Events.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ force?: boolean }} [opts]
 */
export async function processProducerMailForBigEvents(env = process.env, opts = {}) {
  /** @type {Array<{ slug: string, query: string, action: 'added' | 'updated' | 'skipped' }>} */
  const actions = [];
  const seenStore = await loadProducerMailSeen(env);
  const seen = { ...seenStore.seen };
  const nowIso = new Date().toISOString();

  /** @type {Map<string, ReturnType<typeof extractProducerAnnouncement> & { messageDateMs: number }>} */
  const bySlug = new Map();
  /** @type {string[]} */
  const newlySeenKeys = [];

  for (const rule of PRODUCER_RULES) {
    for (const mailbox of gmailIntakeAddresses(env)) {
      let fetched;
      try {
        fetched = await fetchProducerMailboxMessages(mailbox, rule.gmailQuery, env);
      } catch {
        continue;
      }
      if (!fetched.ok || !Array.isArray(fetched.messages)) continue;

      for (const message of fetched.messages) {
        const extracted = extractProducerAnnouncement(message, rule);
        if (!extracted) continue;
        if (!opts.force && seen[extracted.seenKey]) continue;

        newlySeenKeys.push(extracted.seenKey);
        const messageDateMs = Date.parse(String(message.date || '')) || 0;
        const prev = bySlug.get(extracted.slug);
        if (!prev || messageDateMs >= prev.messageDateMs) {
          bySlug.set(extracted.slug, { ...extracted, messageDateMs });
        }
      }
    }
  }

  if (!bySlug.size) {
    return { ok: true, promoted: 0, actions };
  }

  const criteria = await loadEventsFinderCriteria();
  const names = normalizeConferenceWatchlist([
    ...(Array.isArray(criteria.conferenceWatchlist) ? criteria.conferenceWatchlist : []),
    ...[...bySlug.values()].map((x) => x.query),
  ]);
  await saveEventsFinderCriteria({
    lookFor: criteria.lookFor,
    skip: criteria.skip,
    blacklist: criteria.blacklist,
    conferenceWatchlist: names,
  });

  const store = await loadConferenceWatchlistStore(env);

  for (const extracted of bySlug.values()) {
    const prior = store.bySlug[extracted.slug] || {};
    const manualEdit = prior.manualEdit === true;
    const existed = Boolean(prior.slug);

    /** @type {Record<string, unknown>} */
    const patch = {
      slug: extracted.slug,
      query: extracted.query,
      name: extracted.name,
      url: extracted.url,
      homepageUrl: extracted.homepageUrl,
      researching: !manualEdit,
      researchedAt: nowIso,
    };
    if (!manualEdit) {
      if (extracted.eventStart) patch.eventStart = extracted.eventStart;
      if (extracted.eventEnd) patch.eventEnd = extracted.eventEnd;
      if (extracted.city) patch.city = extracted.city;
      patch.notes = extracted.notes;
    }

    await upsertConferenceWatchlistRecords({ [extracted.slug]: { ...prior, ...patch } }, env);

    if (!manualEdit) {
      setImmediate(() => {
        void researchConferenceQuery(extracted.query, env, {
          url: extracted.url,
          homepageUrl: extracted.homepageUrl,
        }).catch((err) => {
          console.warn(
            '[producer-watchlist] research failed:',
            extracted.slug,
            String(err?.message || err).slice(0, 120),
          );
        });
      });
    }

    seen[extracted.seenKey] = nowIso;
    actions.push({
      slug: extracted.slug,
      query: extracted.query,
      action: existed ? 'updated' : 'added',
    });
  }

  for (const key of newlySeenKeys) {
    seen[key] = nowIso;
  }

  await saveProducerMailSeen(seen, env);

  const promoted = actions.filter((a) => a.action === 'added' || a.action === 'updated').length;
  return {
    ok: true,
    promoted,
    actions,
  };
}
