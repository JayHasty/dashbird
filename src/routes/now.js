/**
 * Now tab API. Inbox sort is the only route here that spends model credits.
 * Ranking reads the goal file. Signal logging does not open it for writing.
 */
import { Router } from 'express';
import express from 'express';
import { loadNowGoals, saveNowGoals } from '../lib/now-goals-store.js';
import { refreshHoles, sortInboxItem } from '../lib/now-ingest.js';
import { applyHoleAnswer, ensureParentSteps, newId, normalizeParent } from '../lib/now-model.js';
import { rankNow, signalTrend } from '../lib/now-rank.js';
import { appendNowSignal, loadNowSignals } from '../lib/now-signals-store.js';
import { loadNowState, saveNowState, withNowLock } from '../lib/now-store.js';

const router = Router();
router.use(express.json({ limit: '256kb' }));

/**
 * @param {import('express').Response} res
 * @param {unknown} body
 */
function send(res, body) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(body);
}

async function snapshot() {
  const state = await loadNowState();
  const goalsFile = await loadNowGoals();
  const signals = await loadNowSignals();
  const now = new Date();
  const rank = rankNow({
    parents: state.parents,
    goals: goalsFile.goals,
    signals: signals.entries,
    pin: state.pin,
    now,
  });
  /** @type {Record<string, string>} */
  const trends = {};
  for (const goal of goalsFile.goals) {
    if (goal.kind === 'aim') trends[goal.id] = signalTrend(goal, signals.entries, now);
  }
  return {
    ok: true,
    parents: state.parents,
    inbox: state.inbox,
    holes: state.holes,
    pin: state.pin,
    goals: goalsFile.goals,
    signals: signals.entries,
    trends,
    rank,
  };
}

router.get('/', async (_req, res) => {
  try {
    await withNowLock(async () => {
      const state = await loadNowState();
      let changed = false;
      for (const parent of state.parents) {
        if (ensureParentSteps(parent)) changed = true;
      }
      for (const item of state.inbox) {
        if (item.draft && ensureParentSteps(item.draft)) changed = true;
      }
      if (changed) await saveNowState(state);
    });
    send(res, await snapshot());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/', async (req, res) => {
  try {
    await withNowLock(async () => {
      const state = await loadNowState();
      if (Array.isArray(req.body?.parents)) {
        state.parents = req.body.parents.map((row) => normalizeParent(row)).filter(Boolean);
      }
      if (req.body?.pin === null) state.pin = null;
      else if (req.body?.pin && typeof req.body.pin === 'object') {
        const commitmentId = String(req.body.pin.commitmentId || '').trim();
        state.pin = commitmentId ? { commitmentId, setAt: new Date().toISOString() } : null;
      }
      const goalsFile = await loadNowGoals();
      refreshHoles(state, goalsFile.goals);
      await saveNowState(state);
    });
    send(res, await snapshot());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/inbox', async (req, res) => {
  try {
    const note = String(req.body?.note || '').trim();
    if (!note) {
      res.status(400).json({ ok: false, error: 'note_required' });
      return;
    }
    const item = await withNowLock(async () => {
      const state = await loadNowState();
      const created = {
        id: newId(),
        note: note.slice(0, 2000),
        status: 'sorting',
        error: '',
        draft: null,
        proposedGoal: null,
        goalReason: '',
        questions: [],
        found: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.inbox.unshift(created);
      await saveNowState(state);
      return created;
    });
    send(res, await snapshot());
    void withNowLock(() => sortInboxItem(item.id)).catch((e) => {
      console.warn('[now] sort failed', String(e?.message || e).slice(0, 160));
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/inbox/:id/answer', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const questionId = String(req.body?.questionId || '');
    const answer = String(req.body?.answer || '');
    const found = await withNowLock(async () => {
      const state = await loadNowState();
      const item = state.inbox.find((row) => row.id === id);
      if (!item) return null;
      const question = item.questions.find((q) => q.id === questionId);
      if (!question) return false;
      if (!item.proposedGoal && question.fills.record === 'goal') {
        item.proposedGoal = {
          id: newId(),
          kind: question.fills.goalKind === 'floor' ? 'floor' : 'aim',
          statement: item.note,
          warnDays: 7,
          weight: 1,
        };
      }
      applyHoleAnswer(question, answer, { parent: item.draft, goal: item.proposedGoal });
      item.status = 'sorting';
      item.updatedAt = new Date().toISOString();
      await saveNowState(state);
      return true;
    });
    if (found == null) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    if (found === false) {
      res.status(404).json({ ok: false, error: 'question_not_found' });
      return;
    }
    send(res, await snapshot());
    void withNowLock(() => sortInboxItem(id)).catch((e) => {
      console.warn('[now] re-sort failed', String(e?.message || e).slice(0, 160));
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/inbox/:id/accept', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const result = await withNowLock(async () => {
      const state = await loadNowState();
      const item = state.inbox.find((row) => row.id === id);
      if (!item) return { error: 'not_found', status: 404 };
      if (item.questions.some((q) => q.open)) return { error: 'questions_open', status: 409 };
      const goalsFile = await loadNowGoals();
      let goalId = '';
      if (item.proposedGoal?.statement) {
        const existing = goalsFile.goals.find((g) => g.id === item.proposedGoal.id);
        if (existing) {
          const statement = existing.statement;
          existing.due = item.proposedGoal.due || existing.due;
          existing.stake = item.proposedGoal.stake || existing.stake;
          existing.target = item.proposedGoal.target || existing.target;
          existing.signal = item.proposedGoal.signal || existing.signal;
          existing.statement = statement;
          goalId = existing.id;
        } else {
          goalsFile.goals.push(item.proposedGoal);
          goalId = item.proposedGoal.id;
        }
        await saveNowGoals(goalsFile);
      }
      if (item.draft) {
        if (goalId) item.draft.goalId = item.draft.goalId || goalId;
        const hostId = item.draft.attachToParentId;
        const host = hostId ? state.parents.find((p) => p.id === hostId) : null;
        if (host) {
          host.commitment = item.draft.commitment;
          host.goalId = host.goalId || item.draft.goalId;
          const extra = item.draft.type === 'errand' ? item.draft.checklist : item.draft.steps;
          host.steps = [...(host.steps || []), ...(extra || [])].slice(0, 24);
        } else {
          const parent = normalizeParent(item.draft);
          if (parent) state.parents.unshift(parent);
        }
      }
      state.inbox = state.inbox.filter((row) => row.id !== id);
      refreshHoles(state, (await loadNowGoals()).goals);
      await saveNowState(state);
      return { error: '', status: 200 };
    });
    if (result.error) {
      res.status(result.status).json({ ok: false, error: result.error });
      return;
    }
    send(res, await snapshot());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.delete('/inbox/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    await withNowLock(async () => {
      const state = await loadNowState();
      state.inbox = state.inbox.filter((row) => row.id !== id);
      await saveNowState(state);
    });
    send(res, await snapshot());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/holes/:id/answer', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const answer = String(req.body?.answer || '');
    const found = await withNowLock(async () => {
      const state = await loadNowState();
      const hole = state.holes.find((row) => row.id === id);
      if (!hole) return false;
      const parent = state.parents.find((p) => p.id === hole.fills.parentId) || null;
      const goalsFile = await loadNowGoals();
      const goal = goalsFile.goals.find((g) => g.id === hole.fills.goalId) || null;
      applyHoleAnswer(hole, answer, { parent, goal });
      if (goal && hole.fills.record === 'goal') await saveNowGoals(goalsFile);
      state.holes = state.holes.filter((row) => row.open);
      const goalsAgain = await loadNowGoals();
      refreshHoles(state, goalsAgain.goals);
      await saveNowState(state);
      return true;
    });
    if (!found) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    send(res, await snapshot());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/start', async (req, res) => {
  try {
    const parentId = String(req.body?.parentId || '');
    await withNowLock(async () => {
      const state = await loadNowState();
      for (const parent of state.parents) {
        const commitment = parent.commitment;
        if (!commitment || commitment.state === 'done') continue;
        if (parent.id === parentId) commitment.state = 'active';
        else if (commitment.state === 'active' || commitment.state === 'nominated' || commitment.state === 'needs-review') {
          if (commitment.owner === 'you' || commitment.owner === 'agent-then-you') commitment.state = 'paused';
        }
      }
      await saveNowState(state);
    });
    send(res, await snapshot());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/pin', async (req, res) => {
  try {
    const commitmentId = String(req.body?.commitmentId || '').trim();
    await withNowLock(async () => {
      const state = await loadNowState();
      state.pin = commitmentId ? { commitmentId, setAt: new Date().toISOString() } : null;
      await saveNowState(state);
    });
    send(res, await snapshot());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/finish', async (req, res) => {
  try {
    const parentId = String(req.body?.parentId || '');
    await withNowLock(async () => {
      const state = await loadNowState();
      const parent = state.parents.find((p) => p.id === parentId);
      if (parent?.commitment) {
        if (state.pin?.commitmentId === parent.commitment.id) state.pin = null;
        parent.commitment.state = 'done';
        if (parent.type === 'inquiry') parent.sittingsUsed = Math.min(9, (parent.sittingsUsed || 0) + 1);
      }
      await saveNowState(state);
    });
    send(res, await snapshot());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/review', async (req, res) => {
  try {
    const parentId = String(req.body?.parentId || '');
    await withNowLock(async () => {
      const state = await loadNowState();
      const parent = state.parents.find((p) => p.id === parentId);
      if (parent?.commitment?.owner === 'agent-then-you') parent.commitment.state = 'needs-review';
      await saveNowState(state);
    });
    send(res, await snapshot());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/goals', async (_req, res) => {
  try {
    const goalsFile = await loadNowGoals();
    send(res, { ok: true, goals: goalsFile.goals });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/goals', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.goals)) {
      res.status(400).json({ ok: false, error: 'goals_required' });
      return;
    }
    await withNowLock(async () => {
      const saved = await saveNowGoals({ goals: req.body.goals });
      const state = await loadNowState();
      refreshHoles(state, saved.goals);
      await saveNowState(state);
    });
    send(res, await snapshot());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/signals', async (req, res) => {
  try {
    const goalId = String(req.body?.goalId || '').trim();
    const value = Number(req.body?.value);
    if (!goalId || !Number.isFinite(value)) {
      res.status(400).json({ ok: false, error: 'signal_required' });
      return;
    }
    await appendNowSignal(goalId, value);
    send(res, await snapshot());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
