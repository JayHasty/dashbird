/**
 * Synthesize a Daily Summary digest + action items.
 * Uses OpenRouter when a key is set (unless GMAIL_DAILY_SUMMARY_LLM=0);
 * otherwise heuristic triage + digest. Cadence: bootstrap, then every 30 minutes.
 */
import { loadGmailDailySummaryGuide } from './gmail-daily-summary-guide-store.js';
import {
  classifyGmailDailySummaryMessages,
  heuristicSynthParsed,
  triageMetaFromResult,
} from './gmail-daily-summary-triage.js';
import {
  bumpOpenRouterRateLimit,
  openRouterChatJson,
  openRouterRateLimitUntilMs,
} from './openrouter-chat-json.js';
import {
  fetchWeeklySummaryMail,
  gmailWeeklySummaryDays,
} from './gmail-weekly-summary-fetch.js';
import {
  itemFingerprint,
  keepNewestSourceOnly,
  loadGmailWeeklySummary,
  mergeSynthesizedDigest,
  reconcileDigestClosedTombstones,
  saveGmailWeeklySummary,
  shouldExcludeDailySummaryItem,
} from './gmail-weekly-summary-store.js';

const MAX_MESSAGES_FOR_PROMPT = 48;
const EXCERPT_CAP = 700;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

/** @type {Promise<object> | null} */
let synthInflight = null;

/**
 * Reload persisted digest and reconcile tombstones before writing a scan result.
 * @param {import('./gmail-weekly-summary-store.js').GmailWeeklyDigest} merged
 * @param {NodeJS.ProcessEnv} env
 */
async function saveScanDigest(merged, env) {
  const latest = await loadGmailWeeklySummary(env);
  return saveGmailWeeklySummary(reconcileDigestClosedTombstones(merged, latest), env);
}

/** @type {ReturnType<typeof setInterval> | null} */
let dailyTimer = null;
/** @type {number} */
let lastScanDoneAtMs = 0;
let dailyInFlight = false;
let bootstrapStarted = false;
/** @type {number} */
let lastBootstrapAttemptMs = 0;
/** Longer backoff so free/paid rate limits are not hammered every minute. */
const BOOTSTRAP_RETRY_MS = 2 * 60 * 60 * 1000;

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
function openRouterKey(env = process.env) {
  return String(env.OPENROUTER_API_KEY || '').trim();
}

/**
 * Daily Summary can run without OpenRouter (heuristic triage + digest).
 * Set GMAIL_DAILY_SUMMARY_LLM=0 to never send mail to OpenRouter.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dailySummaryLlmEnabled(env = process.env) {
  const raw = envFirst(env, ['GMAIL_DAILY_SUMMARY_LLM', 'GMAIL_DAILY_SUMMARY_AI']).toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'heuristic') return false;
  return Boolean(openRouterKey(env));
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailWeeklySummaryScheduleEnabled(env = process.env) {
  const raw = envFirst(env, [
    'GMAIL_DAILY_SUMMARY_SCHEDULE',
    'GMAIL_WEEKLY_SUMMARY_SCHEDULE',
  ]);
  if (!raw) return true;
  return raw !== '0';
}

/**
 * Scan interval in ms (default 30 minutes).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailDailySummaryIntervalMs(env = process.env) {
  const raw = Number(
    env.GMAIL_DAILY_SUMMARY_INTERVAL_MS || env.GMAIL_WEEKLY_SUMMARY_INTERVAL_MS,
  );
  if (Number.isFinite(raw) && raw >= 60_000) return Math.floor(raw);
  return DEFAULT_INTERVAL_MS;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function scheduleTz(env = process.env) {
  return (
    envFirst(env, [
      'GMAIL_DAILY_SUMMARY_TZ',
      'GMAIL_WEEKLY_SUMMARY_TZ',
      'WEATHER_TIME_ZONE',
    ]) || 'America/Los_Angeles'
  );
}

/**
 * @param {Date} [now]
 * @param {string} [timeZone]
 */
export function gmailWeeklySummaryLocalParts(now = new Date(), timeZone = 'America/Los_Angeles') {
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
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: Number(map.hour),
    minute: Number(map.minute),
    ymd: `${map.year}-${map.month}-${map.day}`,
  };
}

/**
 * True when enough time has elapsed since the last successful scan.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [nowMs]
 * @param {number} [lastDoneMs]
 */
export function shouldRunGmailWeeklySummaryInterval(
  env = process.env,
  nowMs = Date.now(),
  lastDoneMs = lastScanDoneAtMs,
) {
  if (!gmailWeeklySummaryScheduleEnabled(env)) return false;
  const interval = gmailDailySummaryIntervalMs(env);
  if (!lastDoneMs) return true;
  return nowMs - lastDoneMs >= interval;
}

/** @deprecated Use shouldRunGmailWeeklySummaryInterval */
export function shouldRunGmailWeeklySummaryDaily(env = process.env, now = new Date()) {
  return shouldRunGmailWeeklySummaryInterval(env, now.getTime());
}

/**
 * @param {string} guideMarkdown
 */
/**
 * @param {string} guideMarkdown
 * @param {Array<{ vibe: 'up' | 'down', text: string, company?: string | null }>} [feedbackExamples]
 */
function buildSystemPrompt(guideMarkdown, feedbackExamples = []) {
  const guide = String(guideMarkdown || '').trim() || '(no ingestion guide configured)';
  const exampleLines = (feedbackExamples || []).slice(0, 8).map((ex, i) => {
    const vibe = ex.vibe === 'up' ? 'prefer more' : 'prefer less';
    const co = ex.company ? ` (${ex.company})` : '';
    return `${i + 1}. [${vibe}]${co} ${ex.text}`;
  });
  const feedbackBlock = exampleLines.length
    ? `Learned preference examples:\n${exampleLines.join('\n')}`
    : '';
  return `You are Dashbird's daily inbox synthesizer for Jay.
You do NOT return a filtered list of important emails.
You return a short prose summary of recent mail PLUS durable action items / tasks derived from the mail.
An action item may cite zero, one, or several messages. Prefer thematic tasks ("Confirm insurance paperwork") over quoting a subject line.
Messages were pre-triaged for intent; still apply the rules below (code also hard-filters events/OTP/promo).

Return JSON only:
{
  "summaryText": string,
  "items": [
    {
      "title": string,
      "company": string,
      "detail": string,
      "needsReply": boolean,
      "deadline": string | null,
      "deadlineSource": "extracted" | "response_48h" | "none",
      "sourceRefs": [ { "mailbox": string, "messageId": string } ]
    }
  ]
}

Rules:
- summaryText: optional 1 short sentence of inbox context only. Do NOT restate or discuss the action items (the UI lists those separately). No wrap-up filler like "No other urgent actions are required."
- Omit calendar/event mail entirely from summaryText. Never mention events, RSVPs, invites, workshops, info sessions, or Events Finder — not even as a "handled elsewhere" disclaimer.
- Also omit account verification / magic-link / sign-in / OTP emails from summaryText.
- items: 0-12 concrete next actions. Skip pure FYI.
- NEVER create items for calendar events, RSVPs, info sessions, workshops, meetups, hackathons, parties, or fellowship sessions.
- NEVER create items for account verification, sign-in links, magic links, OTP/security codes, or "verify your email/account" messages.
- company: REQUIRED. Short org/brand making the request (e.g. "PayPal", "Experian", "Google"). Prefer the company over a person's name. Use the From header / body; never leave blank when identifiable.
- detail: 1-2 short sentences. MUST name that company/org (who is asking) so the ask is never anonymous. Example: "PayPal: June statement is ready — log in to review."
- Deduplicate: if the same company/sender sends multiple emails about the same ask, create ONE item and cite only the most recent message in sourceRefs. Do not list repeats. Distinct asks stay separate (e.g. two different workspace deletion reminders).
- Follow the email ingestion guide below when deciding which mail becomes items. Learned preference bullets override generic rules when they conflict.
- Repeated similar 👎 patterns under Prefer less are treated as stronger exclusion; promoted Soft skip / Never show lines in the guide are hard rules.
- Email ingestion guide:
${guide}
${feedbackBlock ? `\n${feedbackBlock}\n` : ''}
- deadline: ISO 8601 when an explicit date/time is clear; else null.
- deadlineSource: "extracted" if you found a deadline; "response_48h" if the only urgency is that Jay needs to reply; else "none".
- needsReply: true when the main ask is a response from Jay.
- sourceRefs must use mailbox + messageId from the provided messages only.
- Do not invent message ids. Prefer fewer strong items over many weak ones.`;
}

/**
 * @param {Array<{
 *   id: string,
 *   threadId: string,
 *   mailbox: string,
 *   subject: string,
 *   from: string,
 *   to: string,
 *   date: string,
 *   snippet: string,
 *   text: string,
 * }>} messages
 */
function buildUserPrompt(messages) {
  const lines = messages.slice(0, MAX_MESSAGES_FOR_PROMPT).map((m, i) => {
    const excerpt = String(m.text || m.snippet || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, EXCERPT_CAP);
    return [
      `#${i + 1}`,
      `mailbox=${m.mailbox}`,
      `messageId=${m.id}`,
      `threadId=${m.threadId || ''}`,
      `date=${m.date || ''}`,
      `from=${m.from || ''}`,
      `to=${m.to || ''}`,
      `subject=${m.subject || ''}`,
      `excerpt=${excerpt}`,
    ].join('\n');
  });
  return `Today (UTC): ${new Date().toISOString()}\nMessages (${lines.length}):\n\n${lines.join('\n\n---\n\n')}`;
}

const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'msn.com',
]);

/**
 * Best-effort company/brand from a From header when the model omits it.
 * @param {string} from
 */
export function guessCompanyFromFrom(from) {
  const s = String(from || '').trim();
  if (!s) return '';
  const emailMatch = s.match(/[\w.+-]+@([\w.-]+)/i);
  const domain = emailMatch ? String(emailMatch[1] || '').toLowerCase() : '';
  const display = (s.match(/^"?([^"<]+)"?\s*</)?.[1] || '').trim().replace(/\s+/g, ' ');
  const looksPersonal =
    Boolean(display)
    && /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}$/.test(display)
    && !/\b(inc|llc|ltd|corp|company|team|support|billing|noreply)\b/i.test(display);
  if (display && !looksPersonal && display.length <= 80) {
    return display.replace(/\s+via\s+.+$/i, '').trim().slice(0, 80);
  }
  if (domain && !CONSUMER_MAIL_DOMAINS.has(domain)) {
    const parts = domain.split('.').filter(Boolean);
    const label =
      parts.length >= 3 && ['co', 'com', 'net', 'org'].includes(parts[parts.length - 2])
        ? parts[parts.length - 3]
        : parts[0];
    if (label && label.length > 1) {
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
  }
  if (display && display.length <= 80) return display.slice(0, 80);
  return '';
}

/**
 * Ensure detail prose names the requesting company.
 * @param {string} detail
 * @param {string} company
 */
export function ensureDetailNamesCompany(detail, company) {
  const org = String(company || '').trim();
  const body = String(detail || '').trim();
  if (!org) return body.slice(0, 400);
  if (!body) return `${org}: follow up on their request.`.slice(0, 400);
  if (body.toLowerCase().includes(org.toLowerCase())) return body.slice(0, 400);
  return `${org}: ${body}`.slice(0, 400);
}

/**
 * @param {object} parsed
 * @param {Array<{ id: string, mailbox: string, threadId?: string, subject?: string, date?: string, from?: string }>} messages
 */
function mapSynthItems(parsed, messages, guideMarkdown = '') {
  const byKey = new Map(
    messages.map((m) => [`${String(m.mailbox || '').toLowerCase()}:${m.id}`, m]),
  );
  const items = [];
  for (const raw of Array.isArray(parsed?.items) ? parsed.items : []) {
    if (!raw || typeof raw !== 'object') continue;
    const title = String(raw.title || '').trim().slice(0, 200);
    if (!title) continue;
    const refs = Array.isArray(raw.sourceRefs) ? raw.sourceRefs : [];
    /** @type {import('./gmail-weekly-summary-store.js').GmailWeeklySource[]} */
    const sources = [];
    const fromHeaders = [];
    for (const ref of refs) {
      const mailbox = String(ref?.mailbox || ref?.email || '')
        .trim()
        .toLowerCase();
      const messageId = String(ref?.messageId || ref?.id || '').trim();
      const msg = byKey.get(`${mailbox}:${messageId}`);
      if (!msg) continue;
      if (msg.from) fromHeaders.push(String(msg.from));
      sources.push({
        email: String(msg.mailbox || mailbox).toLowerCase(),
        messageId: String(msg.id),
        threadId: String(msg.threadId || ''),
        subject: String(msg.subject || '').slice(0, 240),
        date: String(msg.date || ''),
        from: String(msg.from || '').trim().slice(0, 240) || undefined,
        gmailId: msg.gmailId || null,
        rfc822MessageId: msg.rfc822MessageId || null,
      });
    }
    let deadlineSource = String(raw.deadlineSource || 'none').toLowerCase();
    if (!['extracted', 'response_48h', 'none'].includes(deadlineSource)) {
      deadlineSource = 'none';
    }
    const needsReply = Boolean(raw.needsReply) || deadlineSource === 'response_48h';
    let deadline = null;
    const deadlineRaw = String(raw.deadline || '').trim();
    if (deadlineRaw) {
      const ms = Date.parse(deadlineRaw);
      if (Number.isFinite(ms)) deadline = new Date(ms).toISOString();
    }
    if (!deadline && needsReply && sources[0]?.date) {
      const sentMs = Date.parse(sources[0].date);
      if (Number.isFinite(sentMs)) {
        deadline = new Date(sentMs + 48 * 60 * 60 * 1000).toISOString();
        deadlineSource = 'response_48h';
      }
    }
    let company = String(raw.company || '').trim().slice(0, 80);
    if (!company) {
      for (const from of fromHeaders) {
        company = guessCompanyFromFrom(from);
        if (company) break;
      }
    }
    const detail = ensureDetailNamesCompany(String(raw.detail || '').trim(), company);
    const newestSources = keepNewestSourceOnly(sources);
    const item = {
      title,
      company,
      detail,
      needsReply,
      deadline,
      deadlineSource,
      mailboxes: [...new Set(newestSources.map((s) => s.email))],
      sources: newestSources,
    };
    item.fingerprint = itemFingerprint(item);
    const excludeReason = shouldExcludeDailySummaryItem(item, guideMarkdown);
    if (excludeReason) continue;
    items.push(item);
  }
  return items;
}

/**
 * Run a mail fetch + synthesis pass. Merges new items; never resurrects dismissed/tasked.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceMailRefresh?: boolean, reason?: string }} [opts]
 */
export async function runGmailWeeklySummaryScan(env = process.env, opts = {}) {
  if (synthInflight) return synthInflight;

  const reason = String(opts.reason || 'manual');
  const forceMail =
    Boolean(opts.forceMailRefresh)
    || reason === 'interval'
    || reason === 'daily'
    || reason === 'bootstrap';

  synthInflight = (async () => {
    const tz = scheduleTz(env);
    const scanYmd = gmailWeeklySummaryLocalParts(new Date(), tz).ymd;
    const guide = await loadGmailDailySummaryGuide(env);
    const mail = await fetchWeeklySummaryMail(env, { forceRefresh: forceMail });

    if (!mail.ok && !mail.messages?.length) {
      const prev = await loadGmailWeeklySummary(env);
      const digest = await saveScanDigest({
        ...prev,
        lastError: mail.error || (mail.errors || []).join('; ') || 'gmail_fetch_failed',
      }, env);
      return { ok: false, fromCache: false, digest, error: digest.lastError, reason };
    }

    const llm = dailySummaryLlmEnabled(env);

    if (!mail.messages?.length) {
      const prev = await loadGmailWeeklySummary(env);
      const merged = mergeSynthesizedDigest(
        prev,
        {
          summaryText:
            prev.summaryText
            || 'No recent messages from the connected intake inboxes.',
          windowDays: gmailWeeklySummaryDays(env),
          lastScanYmd: scanYmd,
          items: [],
          lastError: null,
          triageMeta: null,
        },
        { guideMarkdown: guide },
      );
      const digest = await saveScanDigest(merged, env);
      return { ok: true, fromCache: false, digest, mailMeta: mail, reason };
    }

    // Intent triage gates noise/events out of the digest prompt (heuristics fill if LLM fails).
    const triage = await classifyGmailDailySummaryMessages(mail.messages, {
      guideMarkdown: guide,
      env,
      ignoreRateLimit: reason === 'manual',
      heuristicOnly: !llm,
    });
    const triageMeta = triageMetaFromResult(triage);
    const digestMessages = Array.isArray(triage.kept) ? triage.kept : mail.messages;
    const feedbackExamples = Array.isArray(triage.examples) ? triage.examples : [];

    if (!digestMessages.length) {
      const prev = await loadGmailWeeklySummary(env);
      const merged = mergeSynthesizedDigest(
        prev,
        {
          summaryText: prev.summaryText || 'No actionable mail in the recent intake window.',
          windowDays: mail.days || gmailWeeklySummaryDays(env),
          lastScanYmd: scanYmd,
          items: [],
          lastError: null,
          triageMeta,
        },
        { guideMarkdown: guide },
      );
      const digest = await saveScanDigest(merged, env);
      return {
        ok: true,
        fromCache: false,
        digest,
        triageModel: triage.model,
        triageVia: triage.via,
        reason,
        mailMeta: {
          messageCount: mail.messages.length,
          triageKept: 0,
          triageDropped: Array.isArray(triage.dropped) ? triage.dropped.length : mail.messages.length,
          fromCache: mail.fromCache,
          stale: mail.stale,
          errors: mail.errors,
        },
        triageMeta,
      };
    }

    let parsed = null;
    let model = null;
    let synthVia = 'heuristic';
    if (llm) {
      const chat = await openRouterChatJson(
        env,
        [
          { role: 'system', content: buildSystemPrompt(guide, feedbackExamples) },
          { role: 'user', content: buildUserPrompt(digestMessages) },
        ],
        {
          ignoreRateLimit: reason === 'manual',
          xTitle: 'dashbird-daily-summary',
        },
      );
      if (chat.ok) {
        parsed = chat.parsed;
        model = chat.model;
        synthVia = 'llm';
      } else {
        console.warn(
          `[daily-summary] OpenRouter synth failed (${chat.error || 'synth_failed'}); using heuristic digest`,
        );
      }
    }
    if (!parsed) {
      parsed = heuristicSynthParsed(digestMessages, triage.byId);
    }

    // mapSynthItems still applies guide-match / event / OTP hard excludes (authoritative).
    const items = mapSynthItems(parsed, mail.messages, guide);
    const prev = await loadGmailWeeklySummary(env);
    const merged = mergeSynthesizedDigest(
      prev,
      {
        summaryText: String(parsed.summaryText || '').trim()
          || prev.summaryText
          || 'Daily inbox digest updated.',
        windowDays: mail.days || gmailWeeklySummaryDays(env),
        lastScanYmd: scanYmd,
        items,
        lastError: null,
        triageMeta,
      },
      { guideMarkdown: guide },
    );
    const digest = await saveScanDigest(merged, env);
    return {
      ok: true,
      fromCache: false,
      digest,
      model,
      synthVia,
      triageModel: triage.model,
      triageVia: triage.via,
      reason,
      mailMeta: {
        messageCount: mail.messages.length,
        triageKept: digestMessages.length,
        triageDropped: Array.isArray(triage.dropped) ? triage.dropped.length : 0,
        fromCache: mail.fromCache,
        stale: mail.stale,
        errors: mail.errors,
      },
      triageMeta,
    };
  })().finally(() => {
    synthInflight = null;
  });

  return synthInflight;
}

/**
 * Read persisted digest only (no scan). Use for panel GET.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function getGmailWeeklySummarySnapshot(env = process.env) {
  const digest = await loadGmailWeeklySummary(env);
  return {
    ok: Boolean(digest.summaryText) || openItemsExist(digest),
    fromCache: true,
    digest,
  };
}

/**
 * @param {import('./gmail-weekly-summary-store.js').GmailWeeklyDigest} digest
 */
function openItemsExist(digest) {
  return Array.isArray(digest?.items) && digest.items.some((it) => it.status === 'open');
}

/**
 * Legacy helper: force scan when requested; otherwise return snapshot.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function ensureGmailWeeklySummary(env = process.env, opts = {}) {
  if (opts.forceRefresh) {
    return runGmailWeeklySummaryScan(env, { forceMailRefresh: true, reason: 'manual' });
  }
  return getGmailWeeklySummarySnapshot(env);
}

/**
 * One-time bootstrap if we have never successfully scanned.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function bootstrapGmailWeeklySummaryIfNeeded(env = process.env) {
  if (bootstrapStarted) return { ok: true, skipped: true, reason: 'already_started' };
  const digest = await loadGmailWeeklySummary(env);
  if (digest.generatedAt && (digest.lastScanAt || digest.lastScanYmd)) {
    const seedMs = Date.parse(String(digest.lastScanAt || digest.generatedAt || ''));
    if (Number.isFinite(seedMs) && seedMs > lastScanDoneAtMs) {
      lastScanDoneAtMs = seedMs;
    }
    return { ok: true, skipped: true, reason: 'already_scanned', digest };
  }
  const now = Date.now();
  if (now < openRouterRateLimitUntilMs()) {
    return { ok: true, skipped: true, reason: 'rate_limited' };
  }
  if (lastBootstrapAttemptMs && now - lastBootstrapAttemptMs < BOOTSTRAP_RETRY_MS) {
    return { ok: true, skipped: true, reason: 'bootstrap_backoff' };
  }
  bootstrapStarted = true;
  lastBootstrapAttemptMs = now;
  console.log('[daily-summary] bootstrap scan starting');
  try {
    const result = await runGmailWeeklySummaryScan(env, {
      forceMailRefresh: true,
      reason: 'bootstrap',
    });
    if (result.ok) {
      lastScanDoneAtMs = Date.now();
    } else {
      // Soft failure (e.g. OpenRouter 429) — retry after long backoff.
      bootstrapStarted = false;
      if (String(result.error || '').includes('429')) {
        bumpOpenRouterRateLimit(Date.now() + BOOTSTRAP_RETRY_MS);
      }
    }
    console.log(
      `[daily-summary] bootstrap done ok=${Boolean(result.ok)}`
        + (result.error ? ` error=${result.error}` : '')
        + ` open=${(result.digest?.items || []).filter((i) => i.status === 'open').length}`,
    );
    return result;
  } catch (e) {
    bootstrapStarted = false;
    console.warn('[daily-summary] bootstrap failed:', e?.message || e);
    throw e;
  }
}

/**
 * Every-30-min scan + one-time bootstrap on startup.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startGmailWeeklySummaryScheduler(env = process.env) {
  if (!gmailWeeklySummaryScheduleEnabled(env)) {
    console.log('[daily-summary] schedule disabled');
    return;
  }
  if (dailyTimer) return;

  const intervalMs = gmailDailySummaryIntervalMs(env);
  const intervalMin = Math.round(intervalMs / 60_000);
  console.log(
    `[daily-summary] schedule: every ${intervalMin} min (+ one-time bootstrap; rolling ${10} day window; pin keeps items)`,
  );

  // Seed last scan time from disk so restart does not immediately re-scan.
  void (async () => {
    try {
      const digest = await loadGmailWeeklySummary(env);
      const seedMs = Date.parse(String(digest.lastScanAt || digest.generatedAt || ''));
      if (Number.isFinite(seedMs) && seedMs > lastScanDoneAtMs) {
        lastScanDoneAtMs = seedMs;
      }
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      void tick();
    }, 20_000);
  })();

  // One-time bootstrap if never completed.
  setTimeout(() => {
    void bootstrapGmailWeeklySummaryIfNeeded(env).catch(() => {});
  }, 8_000);

  const tick = async () => {
    if (dailyInFlight) return;
    if (!shouldRunGmailWeeklySummaryInterval(env)) return;
    dailyInFlight = true;
    if (Date.now() < openRouterRateLimitUntilMs()) {
      console.log(
        `[daily-summary] interval scan deferred (rate-limited until ${new Date(openRouterRateLimitUntilMs()).toISOString()})`,
      );
      dailyInFlight = false;
      return;
    }
    console.log('[daily-summary] interval scan starting');
    try {
      const result = await runGmailWeeklySummaryScan(env, {
        forceMailRefresh: true,
        reason: 'interval',
      });
      if (result.ok) {
        lastScanDoneAtMs = Date.now();
      }
      console.log(
        `[daily-summary] interval scan done ok=${Boolean(result.ok)}`
          + (result.error ? ` error=${result.error}` : '')
          + ` open=${(result.digest?.items || []).filter((i) => i.status === 'open').length}`,
      );
    } catch (e) {
      console.warn('[daily-summary] interval scan failed:', e?.message || e);
    } finally {
      dailyInFlight = false;
    }
  };

  // Poll often; actual scans only fire when the interval has elapsed.
  dailyTimer = setInterval(() => {
    void bootstrapGmailWeeklySummaryIfNeeded(env).catch(() => {});
    void tick();
  }, 60_000);
  if (typeof dailyTimer.unref === 'function') dailyTimer.unref();
}
