/**
 * Persisted Daily Summary digest (summary prose + durable action items).
 * Rolling 10-day window: unpinned open items older than that are deleted.
 * Dismissed/tasked tombstones are kept so rescans do not resurrect them.
 * Pinned items stay until unpinned (then 30s grace if past the window).
 * List order is always chronological (newest first); pin does not reorder.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guideExcludeReason } from './gmail-daily-summary-guide-match.js';
import { loadGmailDailySummaryGuide } from './gmail-daily-summary-guide-store.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Unpinned items / summary prose outside this rolling window are deleted. */
export const GMAIL_DAILY_SUMMARY_MAX_AGE_DAYS = 10;
const MAX_AGE_MS = GMAIL_DAILY_SUMMARY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** After unpin, expired items stay visible this long before hard-delete. */
export const GMAIL_DAILY_SUMMARY_UNPIN_GRACE_MS = 30_000;

/**
 * Items Events Finder owns (invites / RSVPs / workshops) — never Daily Summary tasks.
 * @param {string} blob
 */
export function looksLikeEventSummaryItem(blob) {
  const t = String(blob || '').toLowerCase();
  return /\b(rsvp|info session|meetup|eventbrite|partiful|secret party|\bluma\b|hackathon|masterclass|workshop|concert|festival|fellowship info|you're invited|you are invited|attend(ing)?\b|calendar invite|ics)\b/.test(
    t,
  );
}

/**
 * Prose that name-checks events / Events Finder (even as a "we skip these" disclaimer).
 * @param {string} blob
 */
export function looksLikeEventSummaryProse(blob) {
  const t = String(blob || '').toLowerCase();
  if (looksLikeEventSummaryItem(t)) return true;
  return /\b(events?\s+finder|upcoming\s+events?|event\s+invites?|calendar\s+events?|handled by events)\b/.test(
    t,
  );
}

/**
 * Drop sentences that mention events / Events Finder, or empty reassurance filler.
 * @param {string} text
 */
export function scrubEventMentionsFromSummary(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const parts = raw.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const kept = parts.filter(
    (sentence) => !looksLikeEventSummaryProse(sentence) && !looksLikeSummaryFiller(sentence),
  );
  return kept.join(' ').trim();
}

/**
 * Empty wrap-up lines the model likes to tack on.
 * @param {string} blob
 */
export function looksLikeSummaryFiller(blob) {
  const t = String(blob || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return /\b(no other (urgent )?actions? (are|is) required|nothing else (requires|needs) (your )?attention|no (other|further) action (is|needed)|that'?s all for now|no other urgent (items|tasks))\b/.test(
    t,
  );
}

/**
 * Account verification / magic-link / OTP noise — never Daily Summary tasks.
 * @param {string} blob
 */
export function looksLikeVerificationSummaryItem(blob) {
  const t = String(blob || '').toLowerCase();
  return /\b(verify (your )?(email|account|sign[- ]?in|login)|sign[- ]?in (link|verification)|magic link|one[- ]time (pass)?code|otp\b|security code|confirmation code|authenticate|2fa|two[- ]factor|login code|verification (link|code|email)|confirm your (email|account)|finish signing in|complete sign[- ]?in)\b/.test(
    t,
  );
}

/**
 * @param {{
 *   title?: string,
 *   company?: string,
 *   detail?: string,
 *   sources?: Array<{ subject?: string, from?: string }>,
 * }} item
 * @param {string} [guideMarkdown] live ingestion guide — Never show / Soft skip enforced in code
 */
/**
 * Authoritative post-synth / post-triage hard exclude.
 * LLM triage gates the digest prompt; this still drops events, OTP, and guide Never-show.
 */
export function shouldExcludeDailySummaryItem(item, guideMarkdown = '') {
  const blob = [
    item?.company,
    item?.title,
    item?.detail,
    ...(Array.isArray(item?.sources)
      ? item.sources.flatMap((s) => [s?.subject, s?.from])
      : []),
  ]
    .filter(Boolean)
    .join(' ');
  if (looksLikeEventSummaryItem(blob)) return 'event';
  if (looksLikeVerificationSummaryItem(blob)) return 'verification';
  return guideExcludeReason(item, guideMarkdown);
}

/**
 * @typedef {{
 *   email: string,
 *   messageId: string,
 *   threadId: string,
 *   subject: string,
 *   date: string,
 *   from?: string,
 *   gmailId?: string | null,
 *   rfc822MessageId?: string | null,
 * }} GmailWeeklySource
 */

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   company: string,
 *   detail: string,
 *   deadline: string | null,
 *   deadlineSource: 'extracted' | 'response_48h' | 'none',
 *   needsReply: boolean,
 *   mailboxes: string[],
 *   sources: GmailWeeklySource[],
 *   status: 'open' | 'dismissed' | 'tasked',
 *   pinned: boolean,
 *   unpinDeleteAt: string | null,
 *   createdAt: string,
 *   updatedAt: string,
 *   fingerprint: string,
 *   vikunjaTaskId?: string | null,
 * }} GmailWeeklyItem
 */

/**
 * @typedef {{
 *   summaryText: string,
 *   generatedAt: string | null,
 *   lastScanYmd: string | null,
 *   lastScanAt: string | null,
 *   windowDays: number,
 *   items: GmailWeeklyItem[],
 *   lastError: string | null,
 *   triageMeta?: object | null,
 * }} GmailWeeklyDigest
 */

const EMPTY_DIGEST = /** @type {GmailWeeklyDigest} */ ({
  summaryText: '',
  generatedAt: null,
  lastScanYmd: null,
  lastScanAt: null,
  windowDays: GMAIL_DAILY_SUMMARY_MAX_AGE_DAYS,
  items: [],
  lastError: null,
  triageMeta: null,
});

/**
 * Chronological anchor for sort + rolling-window age (newest source date, else createdAt).
 * @param {GmailWeeklyItem | { sources?: GmailWeeklySource[], createdAt?: string, updatedAt?: string }} item
 */
export function itemChronoMs(item) {
  const sources = Array.isArray(item?.sources) ? item.sources : [];
  let best = 0;
  for (const s of sources) {
    const ms = Date.parse(String(s?.date || ''));
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  if (best) return best;
  return Date.parse(String(item?.createdAt || '')) || Date.parse(String(item?.updatedAt || '')) || 0;
}

/**
 * @param {GmailWeeklyItem[]} items
 */
export function sortItemsChronological(items) {
  return [...items].sort((a, b) => itemChronoMs(b) - itemChronoMs(a));
}

/**
 * True when the item is outside the rolling retention window.
 * @param {GmailWeeklyItem} item
 * @param {number} [nowMs]
 */
export function isPastDailySummaryRetention(item, nowMs = Date.now()) {
  const chrono = itemChronoMs(item);
  if (!Number.isFinite(chrono) || chrono <= 0) return false;
  return nowMs - chrono > MAX_AGE_MS;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} keys
 */
function envPathOverride(env, keys) {
  for (const key of keys) {
    const override = String(env[key] || '').trim();
    if (override) {
      return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
    }
  }
  return null;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailWeeklySummaryStorePath(env = process.env) {
  return (
    envPathOverride(env, ['GMAIL_DAILY_SUMMARY_PATH', 'GMAIL_WEEKLY_SUMMARY_PATH'])
    || path.join(PKG_ROOT, 'data', 'gmail-weekly-summary.json')
  );
}

/**
 * @param {unknown} value
 */
function asIsoOrNull(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * @param {unknown} raw
 * @returns {GmailWeeklySource | null}
 */
function normalizeSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const messageId = String(raw.messageId || raw.id || '').trim();
  const email = String(raw.email || raw.mailbox || '').trim().toLowerCase();
  if (!messageId || !email) return null;
  const gmailId = String(raw.gmailId || '').trim().toLowerCase() || null;
  const rfc822MessageId = String(raw.rfc822MessageId || '').trim() || null;
  const from = String(raw.from || '').trim().slice(0, 240);
  return {
    email,
    messageId,
    threadId: String(raw.threadId || '').trim(),
    subject: String(raw.subject || '').trim().slice(0, 240),
    date: String(raw.date || '').trim(),
    ...(from ? { from } : {}),
    gmailId: gmailId && /^[0-9a-f]+$/.test(gmailId) ? gmailId : null,
    rfc822MessageId,
  };
}

/** Words that hide the real ask when comparing titles/subjects. */
const THEME_STOPWORDS = new Set([
  'your',
  'the',
  'a',
  'an',
  'my',
  'our',
  'check',
  'review',
  'update',
  'confirm',
  'secure',
  'reactivate',
  'follow',
  'up',
  'on',
  'for',
  'to',
  'and',
  'or',
  'of',
  'in',
  'with',
  'please',
  'action',
  'required',
  'new',
  'julia',
  'julias',
  'jay',
  'jays',
]);

/**
 * Normalize title/subject/company text for same-ask matching.
 * @param {unknown} value
 */
export function normalizeDailySummaryThemeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w.length > 1 && !THEME_STOPWORDS.has(w))
    .join(' ')
    .trim();
}

/**
 * @param {unknown} value
 */
function themeTokens(value) {
  const n = normalizeDailySummaryThemeText(value);
  return n ? n.split(' ') : [];
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function tokenOverlapRatio(a, b) {
  const ta = new Set(themeTokens(a));
  const tb = new Set(themeTokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter += 1;
  }
  return inter / Math.min(ta.size, tb.size);
}

/**
 * @param {GmailWeeklySource | null | undefined} source
 */
export function sourceChronoMs(source) {
  return Date.parse(String(source?.date || '')) || 0;
}

/**
 * Keep only the newest source message (repeated emails of the same ask).
 * @param {GmailWeeklySource[] | null | undefined} sources
 */
export function keepNewestSourceOnly(sources) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (list.length <= 1) return list;
  let best = list[0];
  let bestMs = sourceChronoMs(best);
  for (let i = 1; i < list.length; i++) {
    const ms = sourceChronoMs(list[i]);
    if (ms >= bestMs) {
      best = list[i];
      bestMs = ms;
    }
  }
  return [best];
}

/**
 * Quoted identifiers in a subject (e.g. workspace names).
 * @param {unknown} subject
 */
function quotedSubjectBits(subject) {
  return [...String(subject || '').matchAll(/["“']([^"”']+)["”']/g)]
    .map((m) => normalizeDailySummaryThemeText(m[1]))
    .filter(Boolean);
}

/**
 * True when two open items are the same company/ask (repeating emails).
 * Distinct concrete subjects (different quoted names, etc.) stay separate.
 * @param {{ title?: string, company?: string, sources?: GmailWeeklySource[] }} a
 * @param {{ title?: string, company?: string, sources?: GmailWeeklySource[] }} b
 */
export function dailySummaryItemsAreSameAsk(a, b) {
  const rawSubA = String(a?.sources?.[0]?.subject || '');
  const rawSubB = String(b?.sources?.[0]?.subject || '');
  const subA = normalizeDailySummaryThemeText(rawSubA);
  const subB = normalizeDailySummaryThemeText(rawSubB);
  if (subA && subB) {
    const quotesA = quotedSubjectBits(rawSubA);
    const quotesB = quotedSubjectBits(rawSubB);
    if (quotesA.length && quotesB.length && !quotesA.some((q) => quotesB.includes(q))) {
      return false;
    }
    if (subA === subB || tokenOverlapRatio(subA, subB) >= 0.75) {
      return true;
    }
  }
  const companyA = normalizeDailySummaryThemeText(a?.company || '');
  const companyB = normalizeDailySummaryThemeText(b?.company || '');
  const titleA = normalizeDailySummaryThemeText(a?.title || '');
  const titleB = normalizeDailySummaryThemeText(b?.title || '');
  if (companyA && companyB && companyA === companyB) {
    if (titleA && titleB && (titleA === titleB || tokenOverlapRatio(titleA, titleB) >= 0.6)) {
      return true;
    }
  }
  if (titleA && titleB && (titleA === titleB || tokenOverlapRatio(titleA, titleB) >= 0.75)) {
    return true;
  }
  return false;
}

/**
 * @param {GmailWeeklyItem} item
 */
function withNewestSourceOnly(item) {
  const sources = keepNewestSourceOnly(item?.sources);
  const mailboxes = sources.length
    ? [...new Set(sources.map((s) => String(s.email || '').toLowerCase()).filter(Boolean))]
    : item.mailboxes;
  return { ...item, sources, mailboxes };
}

/**
 * Collapse repeating open items to the newest; each survivor keeps only its newest source.
 * Closed items are left alone.
 * @param {GmailWeeklyItem[]} items
 */
export function collapseDuplicateDailySummaryItems(items) {
  const list = Array.isArray(items) ? items : [];
  const closed = list.filter((it) => it.status !== 'open');
  const open = sortItemsChronological(list.filter((it) => it.status === 'open')).map(
    withNewestSourceOnly,
  );
  /** @type {GmailWeeklyItem[]} */
  const kept = [];
  for (const item of open) {
    if (kept.some((k) => dailySummaryItemsAreSameAsk(k, item))) continue;
    kept.push(item);
  }
  return [...kept, ...closed];
}

/**
 * Stable key so dismissed/tasked items are not resurrected.
 * Prefer thematic identity (company + title) so repeat emails of the same ask
 * share a fingerprint; fall back to title + sources for legacy rows.
 * @param {{ title?: string, company?: string, sources?: GmailWeeklySource[] }} item
 */
export function itemFingerprint(item) {
  const company = normalizeDailySummaryThemeText(item?.company || '');
  const title = normalizeDailySummaryThemeText(item?.title || '');
  if (company || title) {
    return createHash('sha1').update(`theme::${company}::${title}`).digest('hex').slice(0, 16);
  }
  const sources = Array.isArray(item?.sources) ? item.sources : [];
  const sourceKey = sources
    .map((s) => `${String(s.email || '').toLowerCase()}:${String(s.messageId || '')}`)
    .filter((x) => !x.endsWith(':'))
    .sort()
    .join('|');
  const rawTitle = String(item?.title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return createHash('sha1').update(`${rawTitle}::${sourceKey}`).digest('hex').slice(0, 16);
}

/**
 * Stable keys for a source message so dismiss survives LLM title rephrases.
 * @param {{ email?: string, messageId?: string, gmailId?: string | null, rfc822MessageId?: string | null } | null | undefined} source
 * @returns {string[]}
 */
export function dailySummarySourceKeys(source) {
  if (!source || typeof source !== 'object') return [];
  const email = String(source.email || '').trim().toLowerCase();
  /** @type {string[]} */
  const keys = [];
  const messageId = String(source.messageId || '').trim();
  if (email && messageId) keys.push(`mid:${email}:${messageId}`);
  const gmailId = String(source.gmailId || '').trim().toLowerCase();
  if (email && gmailId && /^[0-9a-f]+$/.test(gmailId)) keys.push(`gid:${email}:${gmailId}`);
  const rfc = String(source.rfc822MessageId || '').trim().toLowerCase();
  if (rfc) keys.push(`rfc:${rfc}`);
  return keys;
}

/**
 * All source keys for an item.
 * @param {{ sources?: GmailWeeklySource[] } | null | undefined} item
 */
export function itemSourceKeys(item) {
  const sources = Array.isArray(item?.sources) ? item.sources : [];
  /** @type {string[]} */
  const keys = [];
  for (const s of sources) keys.push(...dailySummarySourceKeys(s));
  return keys;
}

/**
 * True when a candidate matches a dismissed/tasked tombstone (fingerprint,
 * same underlying message, or same company/ask).
 * @param {{ title?: string, company?: string, fingerprint?: string, sources?: GmailWeeklySource[] }} candidate
 * @param {Array<{ title?: string, company?: string, fingerprint?: string, sources?: GmailWeeklySource[] }>} closedItems
 * @param {Set<string>} [closedFingerprints]
 * @param {Set<string>} [closedSourceKeys]
 */
export function matchesClosedDailySummaryItem(
  candidate,
  closedItems,
  closedFingerprints,
  closedSourceKeys,
) {
  const fps =
    closedFingerprints
    || new Set(
      (closedItems || [])
        .map((it) => String(it?.fingerprint || '').trim())
        .filter(Boolean),
    );
  const fp = String(candidate?.fingerprint || '').trim();
  if (fp && fps.has(fp)) return true;

  const srcKeys =
    closedSourceKeys
    || new Set((closedItems || []).flatMap((it) => itemSourceKeys(it)));
  if (itemSourceKeys(candidate).some((k) => srcKeys.has(k))) return true;

  const closed = Array.isArray(closedItems) ? closedItems : [];
  return closed.some((it) => dailySummaryItemsAreSameAsk(it, candidate));
}

/**
 * Drop open items that resurrect a dismissed/tasked ask (heal after rephrase).
 * @param {GmailWeeklyItem[]} items
 */
export function dropOpenItemsMatchingClosed(items) {
  const list = Array.isArray(items) ? items : [];
  const closed = list.filter((it) => it.status === 'dismissed' || it.status === 'tasked');
  if (!closed.length) return list;
  const closedFingerprints = new Set(closed.map((it) => it.fingerprint).filter(Boolean));
  const closedSourceKeys = new Set(closed.flatMap((it) => itemSourceKeys(it)));
  const open = list.filter((it) => it.status === 'open');
  const other = list.filter(
    (it) => it.status !== 'open' && it.status !== 'dismissed' && it.status !== 'tasked',
  );
  const keptOpen = open.filter(
    (it) =>
      !matchesClosedDailySummaryItem(it, closed, closedFingerprints, closedSourceKeys),
  );
  return [...keptOpen, ...closed, ...other];
}

/**
 * @param {unknown} raw
 * @returns {GmailWeeklyItem | null}
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim().slice(0, 200);
  if (!title) return null;
  const sources = Array.isArray(raw.sources)
    ? raw.sources.map(normalizeSource).filter(Boolean)
    : [];
  const statusRaw = String(raw.status || 'open').toLowerCase();
  const status =
    statusRaw === 'dismissed' || statusRaw === 'tasked' ? statusRaw : 'open';
  const deadlineSourceRaw = String(raw.deadlineSource || 'none').toLowerCase();
  const deadlineSource =
    deadlineSourceRaw === 'extracted' || deadlineSourceRaw === 'response_48h'
      ? deadlineSourceRaw
      : 'none';
  const mailboxes = Array.isArray(raw.mailboxes)
    ? [...new Set(raw.mailboxes.map((m) => String(m || '').trim().toLowerCase()).filter(Boolean))]
    : [...new Set(sources.map((s) => s.email))];
  const createdAt = asIsoOrNull(raw.createdAt) || new Date().toISOString();
  const updatedAt = asIsoOrNull(raw.updatedAt) || createdAt;
  const company = String(raw.company || '').trim().slice(0, 80);
  const fingerprint =
    String(raw.fingerprint || '').trim()
    || itemFingerprint({ title, company, sources });
  const pinned = Boolean(raw.pinned);
  const unpinDeleteAt = pinned ? null : asIsoOrNull(raw.unpinDeleteAt);
  return {
    id: String(raw.id || '').trim() || randomUUID(),
    title,
    company,
    detail: String(raw.detail || '').trim().slice(0, 400),
    deadline: asIsoOrNull(raw.deadline),
    deadlineSource,
    needsReply: Boolean(raw.needsReply),
    mailboxes,
    sources,
    status,
    pinned,
    unpinDeleteAt,
    createdAt,
    updatedAt,
    fingerprint,
    vikunjaTaskId: raw.vikunjaTaskId != null ? String(raw.vikunjaTaskId) : null,
  };
}

/**
 * @param {unknown} raw
 * @returns {GmailWeeklyDigest}
 */
function normalizeDigest(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(src.items)
    ? src.items.map(normalizeItem).filter(Boolean)
    : [];
  const lastScanYmd = String(src.lastScanYmd || '').trim();
  const triageMeta =
    src.triageMeta && typeof src.triageMeta === 'object' ? src.triageMeta : null;
  return {
    summaryText: String(src.summaryText || '').trim().slice(0, 2_000),
    generatedAt: asIsoOrNull(src.generatedAt),
    lastScanYmd: /^\d{4}-\d{2}-\d{2}$/.test(lastScanYmd) ? lastScanYmd : null,
    lastScanAt: asIsoOrNull(src.lastScanAt) || asIsoOrNull(src.generatedAt),
    windowDays:
      Number(src.windowDays) > 0
        ? Math.floor(Number(src.windowDays))
        : GMAIL_DAILY_SUMMARY_MAX_AGE_DAYS,
    items,
    lastError: src.lastError != null ? String(src.lastError).slice(0, 400) : null,
    triageMeta,
  };
}

/**
 * Hard-delete items outside the rolling 10-day window (unless pinned).
 * Unpinned expired items with unpinDeleteAt wait until that timestamp.
 * Event/verification/guide-noise is dismissed (tombstone) so it is not resurrected.
 * @param {GmailWeeklyDigest} digest
 * @param {number} [nowMs]
 * @param {{ guideMarkdown?: string }} [opts]
 * @returns {{ digest: GmailWeeklyDigest, changed: boolean }}
 */
export function pruneExpiredGmailDailySummary(digest, nowMs = Date.now(), opts = {}) {
  const guideMarkdown = String(opts?.guideMarkdown || '');
  const base = normalizeDigest(digest);
  const nowIso = new Date(nowMs).toISOString();
  let changed = false;
  /** @type {GmailWeeklyItem[]} */
  const items = [];

  for (const it of base.items) {
    const excludeReason = shouldExcludeDailySummaryItem(it, guideMarkdown);
    if (it.status === 'open' && excludeReason) {
      changed = true;
      items.push({
        ...it,
        status: 'dismissed',
        pinned: false,
        unpinDeleteAt: null,
        updatedAt: nowIso,
      });
      continue;
    }

    const pastRetention = isPastDailySummaryRetention(it, nowMs);
    if (pastRetention && it.pinned && it.status === 'open') {
      // Pinned open items survive past the rolling window.
      if (it.unpinDeleteAt) {
        changed = true;
        items.push({ ...it, unpinDeleteAt: null });
      } else {
        items.push(it);
      }
      continue;
    }

    if (pastRetention && it.status === 'open' && it.unpinDeleteAt) {
      const deleteAtMs = Date.parse(it.unpinDeleteAt);
      if (Number.isFinite(deleteAtMs) && nowMs < deleteAtMs) {
        items.push(it);
        continue;
      }
      // Grace elapsed — hard-delete.
      changed = true;
      continue;
    }

    if (pastRetention) {
      // Dismissed/tasked tombstones survive past the rolling window.
      if (it.status === 'dismissed' || it.status === 'tasked') {
        items.push(it);
        continue;
      }
      // Unpinned open past window — hard-delete.
      changed = true;
      continue;
    }

    items.push(it);
  }

  let summaryText = base.summaryText;
  let generatedAt = base.generatedAt;
  const genMs = Date.parse(String(base.generatedAt || ''));
  if (Number.isFinite(genMs) && nowMs - genMs > MAX_AGE_MS) {
    if (summaryText) changed = true;
    summaryText = '';
    generatedAt = null;
  }
  // Strip event / Events Finder disclaimers; wipe verification-centric prose.
  if (summaryText) {
    const scrubbed = scrubEventMentionsFromSummary(summaryText);
    if (scrubbed !== summaryText) {
      changed = true;
      summaryText = scrubbed;
    }
    if (summaryText && looksLikeVerificationSummaryItem(summaryText)) {
      changed = true;
      summaryText = '';
    }
  }

  return {
    digest: {
      ...base,
      items,
      summaryText,
      generatedAt,
    },
    changed,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadGmailWeeklySummary(env = process.env) {
  try {
    const raw = await fs.readFile(gmailWeeklySummaryStorePath(env), 'utf8');
    const loaded = normalizeDigest(JSON.parse(raw));
    let guideMarkdown = '';
    try {
      guideMarkdown = await loadGmailDailySummaryGuide(env);
    } catch {
      /* guide optional for prune */
    }
    const { digest, changed } = pruneExpiredGmailDailySummary(loaded, Date.now(), {
      guideMarkdown,
    });
    const collapsedItems = collapseDuplicateDailySummaryItems(digest.items);
    const healedItems = dropOpenItemsMatchingClosed(collapsedItems);
    const itemsChanged =
      JSON.stringify(digest.items) !== JSON.stringify(healedItems);
    const next = itemsChanged ? { ...digest, items: healedItems } : digest;
    if (changed || itemsChanged) {
      try {
        await saveGmailWeeklySummary(next, env);
      } catch {
        /* ignore persist failure on prune/collapse */
      }
    }
    return next;
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      return { ...EMPTY_DIGEST, items: [] };
    }
    throw e;
  }
}

/**
 * @param {GmailWeeklyDigest} digest
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveGmailWeeklySummary(digest, env = process.env) {
  let guideMarkdown = '';
  try {
    guideMarkdown = await loadGmailDailySummaryGuide(env);
  } catch {
    /* guide optional */
  }
  const { digest: pruned } = pruneExpiredGmailDailySummary(
    normalizeDigest(digest),
    Date.now(),
    { guideMarkdown },
  );
  const items = dropOpenItemsMatchingClosed(
    collapseDuplicateDailySummaryItems(pruned.items),
  );
  const next = { ...pruned, items };
  const p = gmailWeeklySummaryStorePath(env);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Merge closed tombstones from the latest on-disk digest into a candidate save.
 * Heals races where dismiss/task happened while a scan was in flight.
 * @param {GmailWeeklyDigest} merged
 * @param {GmailWeeklyDigest} latest
 */
export function reconcileDigestClosedTombstones(merged, latest) {
  const mergedNorm = normalizeDigest(merged);
  const latestNorm = normalizeDigest(latest);
  /** @type {Map<string, GmailWeeklyItem>} */
  const closedById = new Map();
  for (const it of [...mergedNorm.items, ...latestNorm.items]) {
    if (it.status !== 'dismissed' && it.status !== 'tasked') continue;
    const prev = closedById.get(it.id);
    const prevMs = prev ? Date.parse(String(prev.updatedAt || '')) : 0;
    const nextMs = Date.parse(String(it.updatedAt || ''));
    if (!prev || (Number.isFinite(nextMs) && nextMs >= prevMs)) {
      closedById.set(it.id, it);
    }
  }
  const closed = [...closedById.values()];
  if (!closed.length) return mergedNorm;
  const closedFingerprints = new Set(closed.map((it) => it.fingerprint).filter(Boolean));
  const closedSourceKeys = new Set(closed.flatMap((it) => itemSourceKeys(it)));
  const open = mergedNorm.items
    .filter((it) => it.status === 'open')
    .filter(
      (it) =>
        !matchesClosedDailySummaryItem(it, closed, closedFingerprints, closedSourceKeys),
    );
  const items = dropOpenItemsMatchingClosed(
    collapseDuplicateDailySummaryItems([...open, ...closed]),
  );
  return { ...mergedNorm, items };
}

/**
 * Merge newly synthesized items into the persisted digest.
 * Never resurrects dismissed/tasked items (fingerprint, source message, or same ask).
 * @param {GmailWeeklyDigest} prev
 * @param {{
 *   summaryText?: string,
 *   windowDays?: number,
 *   lastScanYmd?: string | null,
 *   items?: Array<Partial<GmailWeeklyItem> & { title: string }>,
 *   lastError?: string | null,
 * }} synth
 * @param {{ guideMarkdown?: string }} [opts]
 */
export function mergeSynthesizedDigest(prev, synth, opts = {}) {
  const guideMarkdown = String(opts?.guideMarkdown || '');
  const now = new Date().toISOString();
  const base = normalizeDigest(prev);
  const closed = base.items.filter(
    (it) => it.status === 'dismissed' || it.status === 'tasked',
  );
  const closedFingerprints = new Set(closed.map((it) => it.fingerprint).filter(Boolean));
  const closedSourceKeys = new Set(closed.flatMap((it) => itemSourceKeys(it)));
  const openByFp = new Map(
    base.items
      .filter((it) => it.status === 'open')
      .filter(
        (it) =>
          !matchesClosedDailySummaryItem(it, closed, closedFingerprints, closedSourceKeys),
      )
      .map((it) => [it.fingerprint, withNewestSourceOnly(it)]),
  );

  /**
   * @param {GmailWeeklyItem} existing
   * @param {GmailWeeklyItem} candidate
   */
  function mergeOpenItem(existing, candidate) {
    const sources = keepNewestSourceOnly(
      candidate.sources.length ? candidate.sources : existing.sources,
    );
    return {
      ...existing,
      title: candidate.title || existing.title,
      company: candidate.company || existing.company || '',
      detail: candidate.detail || existing.detail,
      deadline: candidate.deadline || existing.deadline,
      deadlineSource:
        candidate.deadlineSource !== 'none' ? candidate.deadlineSource : existing.deadlineSource,
      needsReply: candidate.needsReply || existing.needsReply,
      mailboxes: sources.length
        ? [...new Set(sources.map((s) => String(s.email || '').toLowerCase()).filter(Boolean))]
        : [...new Set([...(existing.mailboxes || []), ...(candidate.mailboxes || [])])],
      sources,
      // Keep pin / chrono identity; do not bump sort via updatedAt.
      pinned: existing.pinned,
      unpinDeleteAt: existing.unpinDeleteAt,
      updatedAt: now,
    };
  }

  for (const raw of Array.isArray(synth.items) ? synth.items : []) {
    const normalized = normalizeItem({
      ...raw,
      status: 'open',
      pinned: false,
      unpinDeleteAt: null,
      createdAt: now,
      updatedAt: now,
    });
    if (!normalized) continue;
    const candidate = withNewestSourceOnly(normalized);
    if (shouldExcludeDailySummaryItem(candidate, guideMarkdown)) continue;
    if (
      matchesClosedDailySummaryItem(
        candidate,
        closed,
        closedFingerprints,
        closedSourceKeys,
      )
    ) {
      continue;
    }
    if (openByFp.has(candidate.fingerprint)) {
      const existing = openByFp.get(candidate.fingerprint);
      openByFp.set(candidate.fingerprint, mergeOpenItem(existing, candidate));
      continue;
    }
    const themeMatch = [...openByFp.values()].find((it) =>
      dailySummaryItemsAreSameAsk(it, candidate),
    );
    if (themeMatch) {
      openByFp.delete(themeMatch.fingerprint);
      // Keep the newer chrono identity (candidate) when it is fresher.
      const newerFirst =
        itemChronoMs(candidate) >= itemChronoMs(themeMatch) ? candidate : themeMatch;
      const older = newerFirst === candidate ? themeMatch : candidate;
      const mergedItem = {
        ...mergeOpenItem(older, newerFirst),
        id: newerFirst.id || older.id,
        fingerprint: newerFirst.fingerprint || older.fingerprint,
        createdAt: older.createdAt,
        pinned: themeMatch.pinned,
        unpinDeleteAt: themeMatch.unpinDeleteAt,
      };
      openByFp.set(mergedItem.fingerprint, mergedItem);
      continue;
    }
    openByFp.set(candidate.fingerprint, candidate);
  }

  // Newest first — pin never floats an item. Collapse any remaining repeats.
  const open = dropOpenItemsMatchingClosed(
    collapseDuplicateDailySummaryItems(sortItemsChronological([...openByFp.values()])),
  ).filter((it) => it.status === 'open');

  const triageMeta =
    synth.triageMeta !== undefined
      ? (synth.triageMeta && typeof synth.triageMeta === 'object' ? synth.triageMeta : null)
      : base.triageMeta || null;
  const merged = {
    summaryText:
      synth.summaryText != null
        ? scrubEventMentionsFromSummary(String(synth.summaryText)).slice(0, 2_000)
        : base.summaryText,
    generatedAt: now,
    lastScanYmd:
      synth.lastScanYmd != null
        ? String(synth.lastScanYmd).trim() || base.lastScanYmd
        : base.lastScanYmd,
    lastScanAt: now,
    windowDays:
      Number(synth.windowDays) > 0
        ? Math.floor(Number(synth.windowDays))
        : base.windowDays || GMAIL_DAILY_SUMMARY_MAX_AGE_DAYS,
    items: [...open, ...closed],
    lastError: synth.lastError === undefined ? null : synth.lastError,
    triageMeta,
  };
  return pruneExpiredGmailDailySummary(merged, Date.now(), { guideMarkdown }).digest;
}

/**
 * @param {string} id
 * @param {'dismissed' | 'tasked'} status
 * @param {{ vikunjaTaskId?: string | null }} [extra]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function setGmailWeeklyItemStatus(id, status, extra = {}, env = process.env) {
  const digest = await loadGmailWeeklySummary(env);
  const want = String(id || '').trim();
  let found = false;
  const items = digest.items.map((it) => {
    if (it.id !== want) return it;
    found = true;
    return {
      ...it,
      status,
      pinned: false,
      unpinDeleteAt: null,
      updatedAt: new Date().toISOString(),
      vikunjaTaskId:
        extra.vikunjaTaskId !== undefined ? extra.vikunjaTaskId : it.vikunjaTaskId,
    };
  });
  if (!found) {
    const err = new Error('item_not_found');
    err.code = 'item_not_found';
    err.status = 404;
    throw err;
  }
  return saveGmailWeeklySummary({ ...digest, items }, env);
}

/**
 * Pin / unpin an open item. Unpinning an expired item schedules hard-delete after 30s.
 * Pin does not change list order.
 * @param {string} id
 * @param {boolean} pinned
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function setGmailWeeklyItemPinned(id, pinned, env = process.env) {
  const digest = await loadGmailWeeklySummary(env);
  const want = String(id || '').trim();
  const idx = digest.items.findIndex((it) => it.id === want);
  if (idx < 0) {
    const err = new Error('item_not_found');
    err.code = 'item_not_found';
    err.status = 404;
    throw err;
  }
  const target = digest.items[idx];
  if (target.status !== 'open') {
    const err = new Error('item_not_open');
    err.code = 'item_not_open';
    err.status = 409;
    throw err;
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  /** @type {string | null} */
  let scheduledDeleteAt = null;
  let nextItem;
  if (pinned) {
    nextItem = {
      ...target,
      pinned: true,
      unpinDeleteAt: null,
      updatedAt: nowIso,
    };
  } else {
    const past = isPastDailySummaryRetention(target, nowMs);
    scheduledDeleteAt = past
      ? new Date(nowMs + GMAIL_DAILY_SUMMARY_UNPIN_GRACE_MS).toISOString()
      : null;
    nextItem = {
      ...target,
      pinned: false,
      unpinDeleteAt: scheduledDeleteAt,
      updatedAt: nowIso,
    };
  }

  const items = digest.items.slice();
  items[idx] = nextItem;
  const saved = await saveGmailWeeklySummary({ ...digest, items }, env);
  if (scheduledDeleteAt) {
    const delay = Math.max(0, Date.parse(scheduledDeleteAt) - Date.now()) + 50;
    setTimeout(() => {
      void loadGmailWeeklySummary(env).catch(() => {});
    }, delay);
  }
  return saved;
}

/**
 * @param {GmailWeeklyDigest} digest
 */
export function openGmailWeeklyItems(digest) {
  return sortItemsChronological((digest?.items || []).filter((it) => it.status === 'open'));
}

/**
 * Resolve due date for Create Task.
 * @param {GmailWeeklyItem} item
 */
export function resolveItemDueDate(item) {
  if (item?.deadline) return item.deadline;
  if (item?.needsReply || item?.deadlineSource === 'response_48h') {
    const primary = Array.isArray(item.sources) ? item.sources[0] : null;
    const sentMs = Date.parse(String(primary?.date || ''));
    if (Number.isFinite(sentMs)) {
      return new Date(sentMs + 48 * 60 * 60 * 1000).toISOString();
    }
    return new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  }
  return null;
}

/**
 * Gmail web UI deep link for a source message (desktop / API replyUrl).
 *
 * Routed through accounts.google.com/AccountChooser: a bare
 * `mail.google.com/mail/u/?authuser=…#…` link loses its #fragment when Google
 * bounces through account selection, landing on the inbox instead of the
 * thread. Encoding the full target (fragment included) into `continue`
 * survives that bounce. Prefers `#all/{threadId}`, then rfc822msgid search,
 * then a distinct hex message id — IMAP decimal UIDs never resolve in the UI.
 * @param {GmailWeeklySource | null | undefined} source
 */
export function gmailReplyUrl(source) {
  if (!source?.email) return null;
  const email = String(source.email).trim().toLowerCase();
  const hexId = (v) => {
    const s = String(v || '').trim();
    return /^[0-9a-f]+$/i.test(s) && !/^\d+$/.test(s) ? s.toLowerCase() : '';
  };

  let hash = '';
  const threadId = hexId(source.threadId);
  const rfc = String(source.rfc822MessageId || '')
    .trim()
    .replace(/^<|>$/g, '');
  const gmailId = hexId(source.gmailId);
  const apiId = hexId(source.messageId);
  const subject = String(source.subject || '').trim();
  if (threadId) hash = `all/${threadId}`;
  else if (rfc) hash = `search/${encodeURIComponent(`rfc822msgid:${rfc}`)}`;
  else if (gmailId && gmailId !== threadId) hash = `all/${gmailId}`;
  else if (apiId && apiId !== threadId) hash = `all/${apiId}`;
  else if (subject) hash = `search/${encodeURIComponent(`subject:${subject}`)}`;
  else if (String(source.messageId || '').trim()) {
    hash = `search/${encodeURIComponent(String(source.messageId).trim())}`;
  }
  if (!hash) return null;

  const target = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#${hash}`;
  return (
    'https://accounts.google.com/AccountChooser'
    + `?Email=${encodeURIComponent(email)}`
    + `&continue=${encodeURIComponent(target)}`
  );
}
