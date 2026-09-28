/**
 * Daily Summary API — digest, criteria, dismiss, pin, create-task.
 * Mounted at /api/gmail-daily-summary (and legacy /api/gmail-weekly-summary).
 */
import { Router } from 'express';
import express from 'express';
import path from 'node:path';
import {
  applyGmailDailySummaryGuidePreference,
  gmailDailySummaryGuidePath,
  GUIDE_SECTION_KEYS,
  loadGmailDailySummaryGuide,
  loadGmailWeeklySummaryCriteria,
  saveGmailDailySummaryGuide,
  saveGmailWeeklySummaryCriteria,
} from '../lib/gmail-daily-summary-guide-store.js';
import { suggestGuidePreference } from '../lib/gmail-daily-summary-guide-suggest.js';
import { gmailIntakeStatusSummary } from '../lib/events-finder-gmail.js';
import {
  GMAIL_DAILY_SUMMARY_MAX_AGE_DAYS,
  GMAIL_DAILY_SUMMARY_UNPIN_GRACE_MS,
  gmailReplyUrl,
  loadGmailWeeklySummary,
  openGmailWeeklyItems,
  resolveItemDueDate,
  setGmailWeeklyItemPinned,
  setGmailWeeklyItemStatus,
} from '../lib/gmail-weekly-summary-store.js';
import { enrichSourceFromMailCache } from '../lib/gmail-weekly-summary-fetch.js';
import {
  ensureDetailNamesCompany,
  ensureGmailWeeklySummary,
  gmailDailySummaryIntervalMs,
  getGmailWeeklySummarySnapshot,
  guessCompanyFromFrom,
  runGmailWeeklySummaryScan,
} from '../lib/gmail-weekly-summary-synth.js';
import { createPanelTodo } from '../lib/vikunja-client.js';

const router = Router();
router.use(express.json({ limit: '64kb' }));

/**
 * @param {import('../lib/gmail-weekly-summary-store.js').GmailWeeklyItem} item
 * @param {import('../lib/gmail-weekly-summary-store.js').GmailWeeklySource | null} [primary]
 */
function resolveItemCompany(item, primary = null) {
  const stored = String(item?.company || '').trim();
  if (stored) return stored;
  const sources = Array.isArray(item?.sources) ? item.sources : [];
  const candidates = [primary, ...sources].filter(Boolean);
  for (const src of candidates) {
    const from = String(src?.from || '').trim();
    if (!from) continue;
    const guessed = guessCompanyFromFrom(from);
    if (guessed) return guessed;
  }
  return '';
}

/**
 * @param {import('../lib/gmail-weekly-summary-store.js').GmailWeeklyItem} item
 * @param {import('../lib/gmail-weekly-summary-store.js').GmailWeeklySource | null} [primary]
 */
function publicItem(item, primary = null) {
  const src =
    primary
    || (Array.isArray(item.sources) && item.sources.length ? item.sources[0] : null);
  const company = resolveItemCompany(item, src);
  return {
    id: item.id,
    title: item.title,
    company,
    detail: ensureDetailNamesCompany(item.detail, company),
    deadline: item.deadline,
    deadlineSource: item.deadlineSource,
    needsReply: item.needsReply,
    priority: item.priority || null,
    mailboxes: item.mailboxes,
    sources: item.sources,
    replyUrl: gmailReplyUrl(src),
    sourceCount: Array.isArray(item.sources) ? item.sources.length : 0,
    pinned: Boolean(item.pinned),
    unpinDeleteAt: item.unpinDeleteAt || null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * @param {import('../lib/gmail-weekly-summary-store.js').GmailWeeklyItem[]} items
 */
async function publicItemsWithReply(items) {
  const out = [];
  for (const item of items) {
    const sources = Array.isArray(item.sources) ? [...item.sources] : [];
    const primary = sources.length ? sources[0] : null;
    const enriched = primary ? await enrichSourceFromMailCache(primary) : null;
    if (enriched) sources[0] = enriched;
    out.push({
      ...publicItem(item, enriched),
      sources,
    });
  }
  return out;
}

/**
 * @param {unknown} e
 * @param {import('express').Response} res
 */
function sendErr(e, res) {
  const code = String(e?.code || e?.message || 'gmail_weekly_error');
  const status = Number(e?.status) || (code === 'item_not_found' ? 404 : 500);
  res.status(status).json({
    ok: false,
    error: code,
    detail: e?.detail || (String(e?.message || '') !== code ? String(e?.message || '') : undefined),
  });
}

function scheduleLabel() {
  const mins = Math.round(gmailDailySummaryIntervalMs() / 60_000);
  return (
    `every ${mins} min (+ bootstrap); rolling ${GMAIL_DAILY_SUMMARY_MAX_AGE_DAYS} days;`
    + ` pin keeps longer; unpin grace ${Math.round(GMAIL_DAILY_SUMMARY_UNPIN_GRACE_MS / 1000)}s;`
    + ' newest first'
  );
}

router.get('/', async (req, res) => {
  try {
    // ?refresh=1 remains a manual escape hatch; normal loads read persisted digest only.
    const force = String(req.query.refresh || '') === '1';
    const result = force
      ? await runGmailWeeklySummaryScan(process.env, { forceMailRefresh: true, reason: 'manual' })
      : await getGmailWeeklySummarySnapshot();
    const digest = result.digest || (await loadGmailWeeklySummary());
    const openItems = await publicItemsWithReply(openGmailWeeklyItems(digest));
    let accounts = null;
    try {
      accounts = await gmailIntakeStatusSummary();
    } catch {
      accounts = null;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: Boolean(result.ok) || openItems.length > 0 || Boolean(digest.summaryText),
      fromCache: Boolean(result.fromCache),
      summaryText: digest.summaryText || '',
      generatedAt: digest.generatedAt,
      lastScanYmd: digest.lastScanYmd || null,
      lastScanAt: digest.lastScanAt || null,
      windowDays: digest.windowDays,
      items: openItems,
      lastError: digest.lastError || result.error || null,
      schedule: scheduleLabel(),
      accounts,
      mailMeta: result.mailMeta || null,
    });
  } catch (e) {
    sendErr(e, res);
  }
});

router.post('/refresh', async (_req, res) => {
  try {
    const result = await ensureGmailWeeklySummary(process.env, { forceRefresh: true });
    const digest = result.digest || (await loadGmailWeeklySummary());
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: Boolean(result.ok),
      fromCache: false,
      summaryText: digest.summaryText || '',
      generatedAt: digest.generatedAt,
      lastScanYmd: digest.lastScanYmd || null,
      lastScanAt: digest.lastScanAt || null,
      windowDays: digest.windowDays,
      items: await publicItemsWithReply(openGmailWeeklyItems(digest)),
      lastError: digest.lastError || result.error || null,
      mailMeta: result.mailMeta || null,
      model: result.model || null,
      schedule: scheduleLabel(),
    });
  } catch (e) {
    sendErr(e, res);
  }
});

router.post('/items/:id/dismiss', async (req, res) => {
  try {
    const digest = await setGmailWeeklyItemStatus(req.params.id, 'dismissed');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      items: await publicItemsWithReply(openGmailWeeklyItems(digest)),
    });
  } catch (e) {
    sendErr(e, res);
  }
});

router.post('/items/:id/pin', async (req, res) => {
  try {
    const wantPinned =
      req.body && Object.prototype.hasOwnProperty.call(req.body, 'pinned')
        ? Boolean(
            req.body.pinned === true
            || req.body.pinned === 1
            || req.body.pinned === '1'
            || String(req.body.pinned).toLowerCase() === 'true',
          )
        : true;
    const digest = await setGmailWeeklyItemPinned(req.params.id, wantPinned);
    const item = digest.items.find((it) => it.id === String(req.params.id || ''));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      pinned: Boolean(item?.pinned),
      unpinDeleteAt: item?.unpinDeleteAt || null,
      items: await publicItemsWithReply(openGmailWeeklyItems(digest)),
    });
  } catch (e) {
    sendErr(e, res);
  }
});

router.post('/items/:id/create-task', async (req, res) => {
  try {
    const digest = await loadGmailWeeklySummary();
    const item = digest.items.find((it) => it.id === String(req.params.id || ''));
    if (!item || item.status !== 'open') {
      const err = new Error('item_not_found');
      err.code = 'item_not_found';
      err.status = 404;
      throw err;
    }
    const title =
      String(req.body?.text || req.body?.title || item.title || '')
        .trim()
        .slice(0, 280) || item.title;
    const dueDate = resolveItemDueDate(item);
    const bodyProjectId = Number(req.body?.projectId ?? req.body?.project_id);
    const projectId =
      Number.isFinite(bodyProjectId) && bodyProjectId > 0 ? bodyProjectId : null;
    const todo = await createPanelTodo(title, process.env, { dueDate, projectId });
    const next = await setGmailWeeklyItemStatus(item.id, 'tasked', {
      vikunjaTaskId: todo.id,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({
      ok: true,
      todo,
      dueDate,
      items: await publicItemsWithReply(openGmailWeeklyItems(next)),
    });
  } catch (e) {
    sendErr(e, res);
  }
});

router.get('/guide', async (_req, res) => {
  try {
    const guide = await loadGmailDailySummaryGuide();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      guide,
      path: path.relative(process.cwd(), gmailDailySummaryGuidePath()).replace(/\\/g, '/'),
    });
  } catch (e) {
    sendErr(e, res);
  }
});

router.put('/guide', async (req, res) => {
  try {
    const guide = await saveGmailDailySummaryGuide(req.body?.guide ?? req.body?.markdown ?? '');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, guide });
  } catch (e) {
    sendErr(e, res);
  }
});

router.post('/guide/suggest', async (req, res) => {
  try {
    const vibe = req.body?.vibe === 'down' ? 'down' : 'up';
    const skipLlm = req.body?.skipLlm === true || req.body?.quick === true;
    const result = await suggestGuidePreference(req.body?.item || {}, vibe, process.env, { skipLlm });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      vibe: result.vibe,
      review: result.review,
      section: result.section,
      heading: result.heading,
      proposedLines: result.proposedLines,
      append: result.proposedLines,
      source: result.source,
      llmError: result.llmError || null,
      model: result.model || null,
      sections: GUIDE_SECTION_KEYS,
    });
  } catch (e) {
    sendErr(e, res);
  }
});

router.get('/criteria', async (_req, res) => {
  try {
    const { guide } = await loadGmailWeeklySummaryCriteria();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, criteria: { guide }, guide });
  } catch (e) {
    sendErr(e, res);
  }
});

router.put('/criteria', async (req, res) => {
  try {
    const { guide } = await saveGmailWeeklySummaryCriteria(req.body || {});
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, criteria: { guide }, guide });
  } catch (e) {
    sendErr(e, res);
  }
});

router.post('/preference', async (req, res) => {
  try {
    const vibe = req.body?.vibe === 'down' ? 'down' : 'up';
    const section = String(req.body?.section || '').trim() || undefined;
    const append =
      String(req.body?.append || req.body?.proposedLines || '').trim()
      || [req.body?.lookFor, req.body?.skip, req.body?.blacklist]
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .join('\n');
    const { guide, escalation } = await applyGmailDailySummaryGuidePreference({
      vibe,
      section,
      append,
      item: req.body?.item || null,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, guide, escalation, criteria: { guide } });
  } catch (e) {
    sendErr(e, res);
  }
});

export default router;
