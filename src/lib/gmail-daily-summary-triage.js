/**
 * Daily Summary — LLM intent triage before digest synthesis.
 * Classifies each intake message (action / waiting / money / scheduling / fyi / event / noise)
 * and gates what enters the digest prompt. Heuristic fallback when OpenRouter fails.
 */
import { openRouterChatJson } from './openrouter-chat-json.js';
import { parseGuideSections } from './gmail-daily-summary-guide-match.js';
import { loadRecentThumbsDownExamples } from './gmail-daily-summary-guide-feedback.js';

/** @typedef {'action' | 'waiting' | 'money_docs' | 'scheduling' | 'fyi' | 'event' | 'noise'} TriageCategory */

export const TRIAGE_CATEGORIES = /** @type {const} */ ([
  'action',
  'waiting',
  'money_docs',
  'scheduling',
  'fyi',
  'event',
  'noise',
]);

/** Categories that always enter the digest LLM. */
export const TRIAGE_KEEP_CATEGORIES = new Set([
  'action',
  'waiting',
  'money_docs',
  'scheduling',
]);

/** High-importance FYI may enter the digest; below this is dropped. */
export const TRIAGE_FYI_IMPORTANCE_MIN = 0.7;

const EXCERPT_CAP = 500;
const BATCH_SIZE = 18;
const FEEDBACK_EXAMPLE_CAP = 8;

const EVENT_RE =
  /\b(rsvp|you[''\u2019]re invited|you are invited|calendar invite|add to calendar|meetup|hackathon|workshop|info session|party|parties|festival|gathering|screening|concert|ticket|tickets|eventbrite|partiful|secret\s*party|lu\.ma|luma\.com)\b/i;
const OTP_RE =
  /\b(verification code|verify your (email|account)|magic link|sign[- ]?in (code|link)|one[- ]?time (passcode|password|code)|security code|otp)\b/i;
const SHIPPING_RE =
  /\b(shipped|out for delivery|tracking number|package (has )?arrived|delivery update)\b/i;
const PROMO_RE =
  /\b(unsubscribe|% off|limited time|flash sale|newsletter|marketing)\b/i;
const MONEY_RE =
  /\b(invoice|payment due|statement|receipt|refund|wire|ach|tax|w-?9|contract|nda|billing)\b/i;
const SCHEDULING_RE =
  /\b(reschedule|availability|can you meet|book a (time|call)|zoom\.us|calendly|when works|propose (a )?time)\b/i;
const WAITING_RE =
  /\b(waiting (on|for)|following up|gentle reminder|still need|haven[''\u2019]?t heard|pending your)\b/i;
const ACTION_RE =
  /\b(please (reply|confirm|review|sign|complete|submit)|action required|needs? your|respond by|due by)\b/i;

/** Sender domains that must never enter the Daily Summary digest. */
const BLOCKED_SENDER_DOMAIN_RE = /@westernp\.com\b/i;

/**
 * @param {{ from?: string }} msg
 */
export function isBlockedSenderDomain(msg) {
  return BLOCKED_SENDER_DOMAIN_RE.test(String(msg?.from || ''));
}

/**
 * @param {unknown} raw
 * @returns {TriageCategory}
 */
export function normalizeTriageCategory(raw) {
  const c = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (c === 'money' || c === 'docs' || c === 'money_doc') return 'money_docs';
  if (c === 'schedule' || c === 'meeting') return 'scheduling';
  if (TRIAGE_CATEGORIES.includes(/** @type {TriageCategory} */ (c))) {
    return /** @type {TriageCategory} */ (c);
  }
  return 'fyi';
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizeImportance(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
}

/**
 * @param {{ category?: string, importance?: number }} triage
 * @returns {boolean}
 */
export function messageShouldEnterDigest(triage) {
  if (!triage) return true;
  const category = normalizeTriageCategory(triage.category);
  if (TRIAGE_KEEP_CATEGORIES.has(category)) return true;
  if (category === 'fyi' && normalizeImportance(triage.importance) >= TRIAGE_FYI_IMPORTANCE_MIN) {
    return true;
  }
  return false;
}

/**
 * Offline / fallback classify when OpenRouter is unavailable.
 * Conservative: pass-through as action unless clear noise/event.
 * @param {{ subject?: string, from?: string, snippet?: string, text?: string }} msg
 */
export function heuristicTriageMessage(msg) {
  if (isBlockedSenderDomain(msg)) {
    return {
      category: /** @type {TriageCategory} */ ('noise'),
      importance: 0.05,
      why: 'blocked sender domain (@westernp.com)',
    };
  }

  const blob = [
    msg?.subject,
    msg?.from,
    msg?.snippet,
    String(msg?.text || '').slice(0, EXCERPT_CAP),
  ]
    .filter(Boolean)
    .join('\n');

  if (OTP_RE.test(blob)) {
    return { category: /** @type {TriageCategory} */ ('noise'), importance: 0.05, why: 'verification / OTP' };
  }
  if (SHIPPING_RE.test(blob)) {
    return { category: /** @type {TriageCategory} */ ('noise'), importance: 0.1, why: 'shipping update' };
  }
  if (EVENT_RE.test(blob)) {
    return { category: /** @type {TriageCategory} */ ('event'), importance: 0.2, why: 'event / invite mail' };
  }
  if (PROMO_RE.test(blob) && !MONEY_RE.test(blob) && !ACTION_RE.test(blob)) {
    return { category: /** @type {TriageCategory} */ ('noise'), importance: 0.15, why: 'promo / newsletter' };
  }
  // Action / scheduling / waiting before money — "sign the NDA" is an ask, not a bill.
  if (ACTION_RE.test(blob)) {
    return { category: /** @type {TriageCategory} */ ('action'), importance: 0.8, why: 'action required cue' };
  }
  if (SCHEDULING_RE.test(blob)) {
    return { category: /** @type {TriageCategory} */ ('scheduling'), importance: 0.75, why: 'scheduling cue' };
  }
  if (WAITING_RE.test(blob)) {
    return { category: /** @type {TriageCategory} */ ('waiting'), importance: 0.7, why: 'waiting / follow-up' };
  }
  if (MONEY_RE.test(blob)) {
    return { category: /** @type {TriageCategory} */ ('money_docs'), importance: 0.85, why: 'money / docs cue' };
  }
  return { category: /** @type {TriageCategory} */ ('fyi'), importance: 0.45, why: 'no strong action cue' };
}

/**
 * @param {string} guideMarkdown
 * @param {Array<{ vibe: 'up' | 'down', text: string, company?: string | null }>} [examples]
 */
export function buildTriageSystemPrompt(guideMarkdown, examples = []) {
  const guide = String(guideMarkdown || '').trim() || '(no ingestion guide configured)';
  const exampleLines = (examples || [])
    .slice(0, FEEDBACK_EXAMPLE_CAP)
    .map((ex, i) => {
      const vibe = ex.vibe === 'up' ? 'prefer more' : 'prefer less';
      const co = ex.company ? ` (${ex.company})` : '';
      return `${i + 1}. [${vibe}]${co} ${ex.text}`;
    });
  const feedbackBlock = exampleLines.length
    ? `Learned preference examples (few-shot):\n${exampleLines.join('\n')}`
    : 'Learned preference examples: (none yet)';

  return `You classify personal inbox messages for Jay's Daily Summary triage.
Return JSON only:
{
  "messages": [
    {
      "id": string,
      "category": "action" | "waiting" | "money_docs" | "scheduling" | "fyi" | "event" | "noise",
      "importance": number,
      "why": string
    }
  ]
}

Category meanings:
- action: Jay must do something (reply, confirm, submit, decide).
- waiting: Jay is waiting on someone else, or a gentle follow-up on an open ask.
- money_docs: invoices, payments, statements, contracts, tax, legal docs.
- scheduling: meeting time / availability / reschedule asks.
- fyi: informative; only high importance (>= ${TRIAGE_FYI_IMPORTANCE_MIN}) may surface.
- event: calendar invites, RSVPs, parties, workshops, meetups (Events Finder handles these — mark event).
- noise: promo, newsletters, OTP/magic links, shipping chatter, Slack unread digests.

Rules:
- Classify EVERY provided message; use the given id exactly (mailbox:messageId).
- importance: 0-1 honest score for Daily Summary relevance.
- why: <=12 words.
- Prefer event/noise over fyi when cues are clear.
- Follow the email ingestion guide. Prefer-more examples raise importance; prefer-less / never-show lower it toward noise.
- Do not invent ids.

Email ingestion guide:
${guide}

${feedbackBlock}`;
}

/**
 * @param {Array<{
 *   id: string,
 *   mailbox?: string,
 *   subject?: string,
 *   from?: string,
 *   date?: string,
 *   snippet?: string,
 *   text?: string,
 * }>} messages
 */
export function buildTriageUserPrompt(messages) {
  const lines = (messages || []).map((m, i) => {
    const id = triageMessageKey(m);
    const excerpt = String(m.text || m.snippet || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, EXCERPT_CAP);
    return [
      `#${i + 1}`,
      `id=${id}`,
      `date=${m.date || ''}`,
      `from=${m.from || ''}`,
      `subject=${m.subject || ''}`,
      `excerpt=${excerpt}`,
    ].join('\n');
  });
  return `Classify these ${lines.length} messages.\n\n${lines.join('\n\n---\n\n')}`;
}

/**
 * Stable id used in triage JSON (mailbox:messageId).
 * @param {{ id?: string, mailbox?: string }} msg
 */
export function triageMessageKey(msg) {
  const mailbox = String(msg?.mailbox || '').trim().toLowerCase();
  const id = String(msg?.id || '').trim();
  return mailbox ? `${mailbox}:${id}` : id;
}

/**
 * Build a digest JSON object from triaged mail without calling OpenRouter.
 * `mapSynthItems` still fills company and drops events/OTP.
 * @param {Array<object>} messages
 * @param {Map<string, { category?: string, importance?: number, why?: string }>} [byId]
 */
export function heuristicSynthParsed(messages, byId = new Map()) {
  const items = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    const subject = String(msg?.subject || '')
      .replace(/^(re|fwd|fw):\s*/gi, '')
      .trim();
    const title = (subject || 'Follow up').slice(0, 200);
    const excerpt = String(msg?.text || msg?.snippet || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    const row = byId.get(triageMessageKey(msg));
    const category = String(row?.category || '');
    const needsReply = category === 'action' || category === 'scheduling';
    items.push({
      title,
      company: '',
      detail: excerpt || title,
      needsReply,
      deadline: null,
      deadlineSource: needsReply ? 'response_48h' : 'none',
      sourceRefs: [{ mailbox: msg.mailbox, messageId: msg.id }],
    });
  }
  const n = items.length;
  return {
    summaryText: n
      ? `Inbox scan without an LLM: ${n} possible follow-up${n === 1 ? '' : 's'}.`
      : 'Inbox scan without an LLM: no action-looking mail in the window.',
    items,
  };
}

/**
 * @param {unknown} parsed
 * @param {Array<{ id?: string, mailbox?: string }>} messages
 * @returns {Map<string, { category: TriageCategory, importance: number, why: string }>}
 */
export function mapTriageParsedToById(parsed, messages) {
  /** @type {Map<string, { category: TriageCategory, importance: number, why: string }>} */
  const byId = new Map();
  const rows = Array.isArray(parsed?.messages)
    ? parsed.messages
    : Array.isArray(parsed)
      ? parsed
      : [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    if (!id) continue;
    byId.set(id, {
      category: normalizeTriageCategory(raw.category),
      importance: normalizeImportance(raw.importance),
      why: String(raw.why || '').trim().slice(0, 120),
    });
  }
  // Fill gaps with heuristics so every message has a row.
  for (const msg of messages || []) {
    const key = triageMessageKey(msg);
    if (!key || byId.has(key)) continue;
    const h = heuristicTriageMessage(msg);
    byId.set(key, { ...h, why: `${h.why} (heuristic fill)` });
  }
  return byId;
}

/**
 * @param {Array<object>} messages
 * @param {Map<string, { category: TriageCategory, importance: number, why: string }>} byId
 */
export function filterMessagesForDigest(messages, byId) {
  return (messages || []).filter((m) => {
    if (isBlockedSenderDomain(m)) return false;
    const key = triageMessageKey(m);
    const triage = byId.get(key);
    return messageShouldEnterDigest(triage || { category: 'action', importance: 0.5 });
  });
}

/**
 * Guide prefer_more bullets + recent 👎 log → few-shot examples.
 * @param {string} guideMarkdown
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadTriageFeedbackExamples(guideMarkdown, env = process.env) {
  const sections = parseGuideSections(guideMarkdown);
  /** @type {Array<{ vibe: 'up' | 'down', text: string, company?: string | null }>} */
  const examples = [];
  for (const text of sections.prefer_more.slice(-4)) {
    examples.push({ vibe: 'up', text: String(text).slice(0, 160) });
  }
  const downs = await loadRecentThumbsDownExamples(env, { limit: 4 });
  examples.push(...downs);
  // Also surface prefer_less bullets when log is thin.
  if (downs.length < 2) {
    for (const text of sections.prefer_less.slice(-4)) {
      examples.push({ vibe: 'down', text: String(text).slice(0, 160) });
    }
  }
  return examples.slice(0, FEEDBACK_EXAMPLE_CAP);
}

/**
 * @param {Array<object>} messages
 * @param {{
 *   guideMarkdown?: string,
 *   env?: NodeJS.ProcessEnv,
 *   ignoreRateLimit?: boolean,
 *   heuristicOnly?: boolean,
 * }} [opts]
 */
export async function classifyGmailDailySummaryMessages(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const env = opts.env || process.env;
  const guideMarkdown = String(opts.guideMarkdown || '');
  const examples = await loadTriageFeedbackExamples(guideMarkdown, env);

  if (!list.length) {
    return {
      ok: true,
      via: 'empty',
      byId: new Map(),
      kept: [],
      dropped: [],
      model: null,
      error: null,
    };
  }

  if (opts.heuristicOnly) {
    /** @type {Map<string, { category: TriageCategory, importance: number, why: string }>} */
    const byId = new Map();
    for (const msg of list) {
      const key = triageMessageKey(msg);
      const h = heuristicTriageMessage(msg);
      byId.set(key, h);
    }
    const kept = filterMessagesForDigest(list, byId);
    return {
      ok: true,
      via: 'heuristic',
      byId,
      kept,
      dropped: list.filter((m) => !kept.includes(m)),
      model: null,
      error: null,
      examples,
    };
  }

  /** @type {Map<string, { category: TriageCategory, importance: number, why: string }>} */
  const byId = new Map();
  /** @type {string[]} */
  const modelsUsed = [];
  let lastError = null;
  let anyOk = false;

  for (let start = 0; start < list.length; start += BATCH_SIZE) {
    const batch = list.slice(start, start + BATCH_SIZE);
    const chat = await openRouterChatJson(
      env,
      [
        { role: 'system', content: buildTriageSystemPrompt(guideMarkdown, examples) },
        { role: 'user', content: buildTriageUserPrompt(batch) },
      ],
      {
        ignoreRateLimit: opts.ignoreRateLimit === true,
        xTitle: 'dashbird-daily-summary-triage',
        maxTokens: 3500,
        timeoutMs: 90_000,
      },
    );
    if (!chat.ok) {
      lastError = chat.error || 'triage_failed';
      for (const msg of batch) {
        const key = triageMessageKey(msg);
        if (!byId.has(key)) {
          const h = heuristicTriageMessage(msg);
          byId.set(key, { ...h, why: `${h.why} (triage fallback)` });
        }
      }
      continue;
    }
    anyOk = true;
    if (chat.model) modelsUsed.push(chat.model);
    const mapped = mapTriageParsedToById(chat.parsed, batch);
    for (const [k, v] of mapped) byId.set(k, v);
  }

  // Ensure every message classified.
  for (const msg of list) {
    const key = triageMessageKey(msg);
    if (!byId.has(key)) {
      const h = heuristicTriageMessage(msg);
      byId.set(key, { ...h, why: `${h.why} (missing fill)` });
    }
  }

  const kept = filterMessagesForDigest(list, byId);
  return {
    ok: anyOk || Boolean(lastError),
    via: anyOk ? (lastError ? 'mixed' : 'llm') : 'heuristic',
    byId,
    kept,
    dropped: list.filter((m) => !kept.includes(m)),
    model: modelsUsed[0] || null,
    models: [...new Set(modelsUsed)],
    error: anyOk ? null : lastError,
    examples,
  };
}

/**
 * Compact debug meta for the digest snapshot.
 * @param {Awaited<ReturnType<typeof classifyGmailDailySummaryMessages>>} triage
 */
export function triageMetaFromResult(triage) {
  if (!triage) return null;
  /** @type {Array<{ id: string, category: string, importance: number, why: string, kept: boolean }>} */
  const rows = [];
  for (const [id, row] of triage.byId || []) {
    rows.push({
      id,
      category: row.category,
      importance: row.importance,
      why: row.why,
      kept: messageShouldEnterDigest(row),
    });
  }
  rows.sort((a, b) => b.importance - a.importance);
  return {
    at: new Date().toISOString(),
    via: triage.via || null,
    model: triage.model || null,
    keptCount: Array.isArray(triage.kept) ? triage.kept.length : 0,
    droppedCount: Array.isArray(triage.dropped) ? triage.dropped.length : 0,
    error: triage.error || null,
    sample: rows.slice(0, 24),
  };
}
