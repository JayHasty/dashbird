/**
 * Extreme-priority Gmail — Anthropic job application only (for now).
 * Recruiter / Greenhouse application mail becomes a Daily Summary item
 * with priority=extreme. Weekly job-alert mail is excluded.
 */
import { fetchWeeklyMailboxMessages } from './gmail-weekly-summary-fetch.js';
import { gmailIntakeAddresses } from './events-finder-gmail.js';
import {
  itemFingerprint,
  loadGmailWeeklySummary,
  mergeSynthesizedDigest,
  reconcileDigestClosedTombstones,
  saveGmailWeeklySummary,
} from './gmail-weekly-summary-store.js';

export const EXTREME_PRIORITY = 'extreme';

const JOB_ALERT_RE = /\bnew jobs at anthropic\b/i;
const OTP_RE =
  /\b(security code|verification code|one[- ]?time (passcode|password|code)|otp|magic link|sign[- ]?in code)\b/i;
const RECRUITING_SUBJECT_RE =
  /\b(thank you for applying|application to anthropic|interview|recruiter|hiring team|phone screen|google meet|next steps)\b/i;
const GREENHOUSE_MAIL_RE = /@(?:[a-z0-9-]+\.)?greenhouse-mail\.io\b/i;
const ANTHROPIC_FROM_RE = /@anthropic\.com\b/i;
const PARTNER_MARKETING_RE = /partner-marketing@anthropic\.com/i;

const EXTREME_QUERY =
  '(from:us.greenhouse-mail.io OR from:anthropic.com) newer_than:3d -subject:"New Jobs at Anthropic"';

/** @type {ReturnType<typeof setInterval> | null} */
let extremeTimer = null;

/**
 * @param {{ from?: string, subject?: string, snippet?: string, text?: string }} msg
 */
export function isJobAlertMail(msg) {
  const blob = `${msg?.from || ''} ${msg?.subject || ''}`;
  return JOB_ALERT_RE.test(blob) || /@us\.greenhouse-jobs\.com\b/i.test(String(msg?.from || ''));
}

/**
 * @param {{ from?: string, subject?: string, snippet?: string, text?: string }} msg
 */
export function isExtremePriorityMail(msg) {
  if (!msg) return false;
  if (isJobAlertMail(msg)) return false;
  const from = String(msg.from || '');
  const subject = String(msg.subject || '');
  const blob = `${subject}\n${msg.snippet || ''}\n${String(msg.text || '').slice(0, 400)}`;
  if (OTP_RE.test(blob) && !RECRUITING_SUBJECT_RE.test(subject)) return false;
  if (PARTNER_MARKETING_RE.test(from)) return false;
  if (GREENHOUSE_MAIL_RE.test(from)) return true;
  if (ANTHROPIC_FROM_RE.test(from) && RECRUITING_SUBJECT_RE.test(blob)) return true;
  if (ANTHROPIC_FROM_RE.test(from) && /\b(talent|recruiting|recruiter)\b/i.test(from)) return true;
  return false;
}

/**
 * @param {object} msg
 */
export function extremePriorityItemFromMessage(msg) {
  const subject = String(msg?.subject || 'Anthropic application mail').trim();
  const mailbox = String(msg?.mailbox || '').trim().toLowerCase();
  const company = 'Anthropic';
  const needsReply = /\b(interview|schedule|availability|google meet|calendly|please reply)\b/i.test(
    `${subject} ${msg?.snippet || ''}`,
  );
  const item = {
    title: subject.slice(0, 200) || 'Anthropic application update',
    company,
    detail: String(msg?.snippet || msg?.text || 'Anthropic / Greenhouse mail about the CS application.')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400),
    needsReply,
    deadline: null,
    deadlineSource: needsReply ? 'response_48h' : 'none',
    priority: EXTREME_PRIORITY,
    mailboxes: mailbox ? [mailbox] : [],
    sources: [
      {
        email: mailbox,
        messageId: String(msg?.id || ''),
        threadId: String(msg?.threadId || ''),
        subject,
        date: String(msg?.date || ''),
        from: String(msg?.from || ''),
        gmailId: msg?.gmailId || null,
        rfc822MessageId: msg?.rfc822MessageId || null,
      },
    ].filter((s) => s.messageId),
  };
  item.fingerprint = itemFingerprint(item);
  return item;
}

/**
 * @param {object} item
 */
export function itemIsExtremePriority(item) {
  if (String(item?.priority || '').toLowerCase() === EXTREME_PRIORITY) return true;
  const sources = Array.isArray(item?.sources) ? item.sources : [];
  return sources.some((s) =>
    isExtremePriorityMail({
      from: s?.from,
      subject: s?.subject,
      snippet: item?.detail,
    }),
  );
}

/**
 * @param {object[]} messages
 * @returns {object[]}
 */
export function extremeItemsFromMessages(messages) {
  const out = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!isExtremePriorityMail(msg)) continue;
    out.push(extremePriorityItemFromMessage(msg));
  }
  return out;
}

/**
 * Lightweight Gmail search (90s) so a recruiter note is not waiting on the 30-min digest.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function runExtremePriorityScan(env = process.env) {
  const addresses = gmailIntakeAddresses(env);
  /** @type {object[]} */
  const messages = [];
  for (const email of addresses) {
    const box = await fetchWeeklyMailboxMessages(email, env, {
      maxMessages: 12,
      days: 3,
      query: EXTREME_QUERY,
    });
    if (Array.isArray(box?.messages)) messages.push(...box.messages);
  }
  const items = extremeItemsFromMessages(messages);
  if (!items.length) {
    return { ok: true, injected: 0, digest: await loadGmailWeeklySummary(env) };
  }
  const prev = await loadGmailWeeklySummary(env);
  const merged = mergeSynthesizedDigest(prev, { items }, { guideMarkdown: '' });
  const digest = await saveGmailWeeklySummary(
    reconcileDigestClosedTombstones(merged, prev),
    env,
  );
  return { ok: true, injected: items.length, digest };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startExtremePriorityPoller(env = process.env) {
  if (extremeTimer) return;
  const raw = Number(env.GMAIL_EXTREME_POLL_MS);
  const intervalMs = Number.isFinite(raw) && raw >= 30_000 ? Math.floor(raw) : 90_000;
  console.log(`[extreme-mail] poll every ${Math.round(intervalMs / 1000)}s`);
  const tick = () => {
    void runExtremePriorityScan(env).catch((e) => {
      console.warn('[extreme-mail] scan failed:', e?.message || e);
    });
  };
  setTimeout(tick, 15_000);
  extremeTimer = setInterval(tick, intervalMs);
  if (typeof extremeTimer.unref === 'function') extremeTimer.unref();
}
