/**
 * Turn a captured note into a draft parent, a goal fill, and any questions still open.
 * Public pages and mail are read only to fill a hole. Nothing here writes Vikunja.
 */
import { assertPublicHttpUrl } from './public-http-url.js';
import { openRouterChatJson } from './openrouter-chat-json.js';
import { getGmailAccessToken, gmailGet, headerValue } from './events-finder-gmail.js';
import { loadNowGoals } from './now-goals-store.js';
import { loadNowState, saveNowState } from './now-store.js';
import {
  applyHoleAnswer,
  applyParentField,
  ensureParentSteps,
  clip,
  datesInText,
  dollarInText,
  fillGoal,
  heuristicDraft,
  missingGoalHoles,
  missingParentHoles,
  newId,
  normalizeCommitment,
  normalizeDay,
  normalizeParent,
} from './now-model.js';

const TAX_URLS = [
  'https://www.irs.gov/filing/individuals/when-to-file',
  'https://www.irs.gov/payments/failure-to-file-penalty',
  'https://www.irs.gov/payments/failure-to-pay-penalty',
];

/**
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>[]} goals
 */
export function refreshHoles(state, goals) {
  const add = [];
  const pool = () => [...state.holes, ...add];
  for (const parent of state.parents || []) {
    add.push(...missingParentHoles(parent, pool()));
  }
  for (const goal of goals || []) {
    add.push(...missingGoalHoles(goal, pool()));
  }
  if (add.length) state.holes.push(...add);
  return add;
}

/**
 * @param {string} html
 */
function htmlToText(html) {
  const raw = String(html || '');
  const main = raw.match(/<main\b[\s\S]*?<\/main>/i);
  return (main ? main[0] : raw)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text
 */
function penaltySentence(text) {
  const parts = String(text || '').split(/(?<=\.)\s+/);
  return parts.find((s) => /penalty/i.test(s) && /(\$|\d+\s*percent|%)/i.test(s) && s.length < 320) || '';
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
async function fetchTaxPages(env) {
  const chunks = [];
  for (const url of TAX_URLS) {
    try {
      const safe = await assertPublicHttpUrl(url);
      const response = await fetch(safe, {
        signal: AbortSignal.timeout(12_000),
        headers: { Accept: 'text/html', 'User-Agent': 'dashbird-now' },
      });
      if (!response.ok) continue;
      chunks.push(htmlToText(await response.text()).slice(0, 3500));
    } catch (e) {
      console.warn('[now] tax page skipped', String(e?.message || e).slice(0, 120));
    }
  }
  return chunks.join('\n').slice(0, 8000);
}

/**
 * @param {string} query
 * @param {NodeJS.ProcessEnv} env
 */
async function searchMail(query, env) {
  try {
    const token = await getGmailAccessToken(env);
    if (!token?.ok || !token.accessToken) return [];
    const q = String(query || '').slice(0, 160);
    const list = await gmailGet(
      token.accessToken,
      `/users/me/messages?maxResults=5&q=${encodeURIComponent(q)}`,
    );
    const ids = (Array.isArray(list?.messages) ? list.messages : [])
      .map((m) => String(m?.id || '').trim())
      .filter(Boolean)
      .slice(0, 5);
    /** @type {{ id: string, subject: string, snippet: string }[]} */
    const hits = [];
    for (const id of ids) {
      const msg = await gmailGet(
        token.accessToken,
        `/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`,
      );
      hits.push({
        id,
        subject: headerValue(msg?.payload?.headers, 'Subject').slice(0, 180),
        snippet: String(msg?.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      });
    }
    return hits;
  } catch (e) {
    console.warn('[now] mail lookup skipped', String(e?.message || e).slice(0, 160));
    return [];
  }
}

/**
 * @param {Record<string, unknown> | null} draft
 * @param {Record<string, unknown> | null} goal
 * @param {{ field?: string }} fills
 */
function fieldFilled(draft, goal, fills) {
  const field = fills?.field;
  if (field === 'deadline') return Boolean(draft?.deadline);
  if (field === 'date' || field === 'due') return Boolean(goal?.due || goal?.promise);
  if (field === 'stake') return Boolean(goal?.stake);
  if (field === 'target') return Boolean(goal?.target);
  if (field === 'signal') return Boolean(goal?.signal);
  return false;
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function sortInboxItem(id, env = process.env) {
  const state = await loadNowState(env);
  const item = state.inbox.find((row) => row.id === id);
  if (!item) return null;
  const goalsFile = await loadNowGoals(env);
  const base = heuristicDraft(item.note, state.parents);
  const draft = item.draft || base.draft;
  const proposedGoal = item.proposedGoal || base.proposedGoal;
  const previous = new Map(
    (item.questions || []).filter((q) => q.answer).map((q) => [`${q.fills.record}:${q.fills.field}`, q]),
  );

  let questions = (base.questions || []).map((q) => {
    const prev = previous.get(`${q.fills.record}:${q.fills.field}`);
    if (!prev) return q;
    return { ...q, id: prev.id, answer: prev.answer, open: false, source: prev.source };
  });

  /** @type {{ kind: string, title?: string, ref?: string }[]} */
  const found = [];
  let webText = '';
  /** @type {{ id: string, subject: string, snippet: string }[]} */
  let mailHits = [];

  try {
    if (base.webTopic === 'tax') {
      webText = await fetchTaxPages(env);
      if (webText) found.push({ kind: 'web', title: 'IRS filing and penalty pages', ref: TAX_URLS[0] });
    }
    if (base.mailQuery) {
      mailHits = await searchMail(base.mailQuery, env);
      for (const hit of mailHits) {
        found.push({ kind: 'mail', title: hit.subject || 'Mail', ref: hit.id });
      }
    }
    const corpus = [item.note, webText, ...mailHits.map((h) => `${h.subject} ${h.snippet}`)].join('\n');
    const model = await openRouterChatJson(
      env,
      [
        {
          role: 'system',
          content:
            'You are the project manager for one personal note in Dashbird Now. Reply with JSON only. Break the work into steps: an array of {text, who}. who is "agent" for lookups, drafts, mail, web, and writing you can do, and "you" for anything that needs the person to go, call, decide, or use their hands. Return 2 to 6 steps. Do not invent dates, dollar amounts, or penalty figures that are not in the note or the excerpts. If a fact is missing, add a question instead of guessing. Research on a venture that already exists sets attachToParentId and commitment.mode to research. Do not rewrite goal statements.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            note: item.note,
            parents: (state.parents || []).slice(0, 20).map((p) => ({
              id: p.id,
              type: p.type,
              outcome: p.outcome,
              thesis: p.thesis,
              question: p.question,
            })),
            goals: (goalsFile.goals || []).slice(0, 20).map((g) => ({
              id: g.id,
              kind: g.kind,
              statement: g.statement,
            })),
            excerpts: corpus.slice(0, 5000),
          }),
        },
      ],
      { xTitle: 'dashbird-now', maxTokens: 1600, timeoutMs: 45_000 },
    );
    if (model.ok && model.parsed) applyModel(draft, proposedGoal, model.parsed, corpus, state.parents);
  } catch (e) {
    item.error = String(e?.message || e).slice(0, 200);
  }

  applyLookups(draft, proposedGoal, webText, mailHits);
  if (draft) ensureParentSteps(draft);
  for (const q of questions) {
    if (!q.answer) continue;
    applyHoleAnswer(q, q.answer, { parent: draft, goal: proposedGoal });
  }
  questions = questions.filter((q) => !fieldFilled(draft, proposedGoal, q.fills));

  if (draft && !draft.deadline && !questions.some((q) => q.fills.field === 'deadline') && noteWantsTaxLookup(item.note)) {
    const dates = datesInText(webText);
    questions.unshift({
      id: newId(),
      prompt: dates.length > 1 ? `Which date applies? ${dates.slice(0, 4).join('; ')}` : 'What date does this need to be done?',
      answer: '',
      open: true,
      fills: { record: 'parent', field: 'deadline', parentId: '', goalId: '', goalKind: '' },
      source: null,
    });
  }

  item.draft = draft ? normalizeParent(draft) : null;
  item.proposedGoal = proposedGoal;
  item.questions = questions;
  item.found = found;
  item.status = questions.some((q) => q.open) ? 'questions' : 'ready';
  item.updatedAt = new Date().toISOString();
  if (!item.createdAt) item.createdAt = item.updatedAt;
  await saveNowState(state, env);
  return item;
}

/**
 * @param {Record<string, unknown> | null} draft
 * @param {Record<string, unknown> | null} goal
 * @param {Record<string, unknown>} parsed
 * @param {string} corpus
 * @param {Record<string, unknown>[]} parents
 */
function applyModel(draft, goal, parsed, corpus, parents) {
  if (!parsed || typeof parsed !== 'object') return;
  const lowerCorpus = corpus.toLowerCase();
  if (draft && !noteWantsMoneyTarget(String(draft.outcome || corpus))) {
    const attach = String(parsed.attachToParentId || '').trim();
    const host = parents.find((p) => p.id === attach && p.type === 'venture' && p.status !== 'closed');
    if (host && (parsed.commitment?.mode === 'research' || /\bresearch\b/i.test(corpus))) {
      draft.attachToParentId = host.id;
      draft.type = 'venture';
      draft.thesis = host.thesis;
    } else if (!noteWantsTaxLookup(corpus)) {
      const type = ['errand', 'venture', 'inquiry'].includes(parsed.type) ? parsed.type : draft.type;
      draft.type = type;
      if (parsed.outcome) draft.outcome = clip(parsed.outcome, 400);
      if (parsed.thesis) draft.thesis = clip(parsed.thesis, 400);
      if (parsed.question) draft.question = clip(parsed.question, 400);
      if (parsed.answeredLooksLike) draft.answeredLooksLike = clip(parsed.answeredLooksLike, 400);
      if (['hunch', 'probe', 'decide'].includes(parsed.stage)) draft.stage = parsed.stage;
    }
    if (parsed.commitment && typeof parsed.commitment === 'object') {
      draft.commitment = normalizeCommitment({
        ...draft.commitment,
        ...parsed.commitment,
        id: draft.commitment?.id,
        state: draft.commitment?.state || 'nominated',
      });
    }
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    for (const step of steps.slice(0, 8)) {
      const text = clip(typeof step === 'string' ? step : step?.text, 240);
      if (!text) continue;
      const list = draft.type === 'errand' ? draft.checklist : draft.steps;
      const rows = Array.isArray(list) ? list : [];
      if (rows.some((row) => row.text === text)) continue;
      const who = step && typeof step === 'object' && (step.who === 'agent' || step.who === 'you') ? step.who : undefined;
      applyParentField(draft, 'checklist', text, { kind: 'you', title: 'Draft', ...(who ? { who } : {}) });
    }
    const deadline = normalizeDay(parsed.deadline);
    const deadlineRaw = String(parsed.deadline || '').trim().toLowerCase();
    if (deadline && deadlineRaw && lowerCorpus.includes(deadlineRaw.slice(0, 12)) && !draft.deadline) {
      draft.deadline = deadline;
    }
  }
  const stakeText = clip(parsed.stakeText, 320);
  if (goal && goal.kind === 'floor' && stakeText && lowerCorpus.includes(stakeText.toLowerCase().slice(0, 40)) && !goal.stake) {
    const amount = dollarInText(stakeText);
    goal.stake = {
      text: stakeText,
      ...(amount != null ? { amount } : {}),
      source: { kind: 'web', title: 'Excerpt' },
    };
  }
}

/**
 * @param {Record<string, unknown> | null} draft
 * @param {Record<string, unknown> | null} goal
 * @param {string} webText
 * @param {{ id: string, subject: string, snippet: string }[]} mailHits
 */
function applyLookups(draft, goal, webText, mailHits) {
  const dates = datesInText(webText);
  if (draft && !draft.deadline && dates.length === 1) {
    draft.deadline = normalizeDay(dates[0]);
    if (goal && goal.kind === 'floor' && !goal.due) {
      const statement = goal.statement;
      goal.due = draft.deadline;
      goal.statement = statement;
    }
  }
  const penalty = penaltySentence(webText);
  if (goal && goal.kind === 'floor' && !goal.stake && penalty) {
    const statement = goal.statement;
    const amount = dollarInText(penalty);
    goal.stake = {
      text: penalty,
      ...(amount != null ? { amount } : {}),
      source: { kind: 'web', title: 'IRS', ref: TAX_URLS[1] },
    };
    goal.statement = statement;
  }
  for (const hit of mailHits) {
    if (!draft) break;
    const text = hit.subject || hit.snippet;
    if (!text) continue;
    applyParentField(draft, 'checklist', text, { kind: 'mail', ref: hit.id, title: hit.subject || 'Mail' });
    const amount = dollarInText(hit.snippet);
    if (goal && goal.kind === 'floor' && amount != null && !goal.stake?.amount) {
      const statement = goal.statement;
      goal.stake = {
        text: hit.snippet || hit.subject,
        amount,
        source: { kind: 'mail', ref: hit.id, title: hit.subject || 'Mail' },
      };
      goal.statement = statement;
    }
  }
}

export { fillGoal };
