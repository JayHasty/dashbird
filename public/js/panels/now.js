/**
 * Now tab: a project-manager briefing. One sitting, the full lineup,
 * and one speech bubble when something is missing.
 * @param {HTMLElement | null} root
 */
export function mountNow(root) {
  if (!root) return;
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'now-app';
  const brief = document.createElement('div');
  brief.className = 'now-pm';
  const captureForm = document.createElement('form');
  captureForm.className = 'now-capture';
  const captureInput = document.createElement('input');
  captureInput.className = 'now-capture__input';
  captureInput.type = 'text';
  captureInput.placeholder = 'Tell me what needs doing';
  captureInput.setAttribute('aria-label', 'Capture a note');
  const captureBtn = document.createElement('button');
  captureBtn.type = 'submit';
  captureBtn.className = 'now-btn';
  captureBtn.textContent = 'Add';
  captureForm.append(captureInput, captureBtn);
  const body = document.createElement('div');
  body.className = 'now-body';
  wrap.append(brief, captureForm, body);
  root.append(wrap);

  /** @type {Record<string, unknown> | null} */
  let data = null;
  /** @type {string | null} */
  let openId = null;
  /** @type {string | null} */
  let openGoalId = null;
  /** @type {string} */
  let spokeKey = '';
  /** @type {ReturnType<typeof setTimeout> | null} */
  let poll = null;

  captureForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const note = captureInput.value.trim();
    if (!note) return;
    captureInput.value = '';
    openId = null;
    void post('/api/now/inbox', { note });
  });

  function render() {
    renderBrief();
    body.replaceChildren();
    if (!data) {
      const p = document.createElement('p');
      p.className = 'now-muted';
      p.textContent = 'Loading…';
      body.append(p);
      return;
    }
    body.append(renderBoard());
    body.append(renderGoals());
    schedulePoll();
  }

  function renderBrief() {
    brief.replaceChildren();
    const face = document.createElement('div');
    face.className = 'now-pm__face-wrap';
    face.setAttribute('role', 'img');
    face.setAttribute('aria-label', 'Project manager');
    face.append(pmFace());
    const bubble = document.createElement('div');
    bubble.className = 'now-pm__bubble';
    const say = document.createElement('p');
    say.className = 'now-pm__say';
    if (!data) {
      say.textContent = 'Pulling the board.';
      bubble.append(say);
      brief.append(face, bubble);
      return;
    }
    const ask = nextAsk();
    say.textContent = ask.text;
    bubble.append(say);
    if (ask.kind === 'ask') bubble.append(replyForm(ask));
    if (ask.kind === 'ready') bubble.append(readyActions(ask.item));
    brief.append(face, bubble);
    const key = ask.kind === 'ask' ? String(ask.question.id) : ask.kind;
    if (key !== spokeKey && ask.kind === 'ask') {
      spokeKey = key;
      const input = bubble.querySelector('input');
      if (input && document.activeElement !== captureInput) input.focus();
    } else if (ask.kind !== 'ask') {
      spokeKey = key;
    }
  }

  function renderBoard() {
    const board = document.createElement('section');
    board.className = 'now-board';
    const head = document.createElement('div');
    head.className = 'now-row now-row--head';
    head.append(cell(''), cell('Work'), cell('Who'), cell('When'));
    board.append(head);

    const rank = data.rank || {};
    const focus = rank.now ? parentById(rank.now.parentId) : null;
    const slot = document.createElement('div');
    slot.className = 'now-slot';
    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      slot.classList.add('now-slot--over');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('now-slot--over'));
    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      slot.classList.remove('now-slot--over');
      const commitmentId = e.dataTransfer?.getData('text/plain') || '';
      if (commitmentId) void post('/api/now/pin', { commitmentId });
    });
    if (focus && rank.now) {
      slot.append(sectionLabel('Do this'));
      slot.append(workBlock(focus, { primary: true, reason: rank.now.reason }));
    } else {
      const empty = document.createElement('p');
      empty.className = 'now-muted';
      empty.textContent = 'Nothing nominated yet.';
      slot.append(empty);
    }
    board.append(slot);

    const queue = (rank.queue || [])
      .map((row) => ({ parent: parentById(row.parentId), reason: row.reason }))
      .filter((row) => row.parent);
    if (queue.length) {
      board.append(sectionLabel('Waiting'));
      for (const row of queue) board.append(workBlock(row.parent, { reason: row.reason, draggable: true }));
    }

    const lane = (rank.lane || [])
      .map((row) => parentById(row.parentId))
      .filter(Boolean);
    if (lane.length) {
      board.append(sectionLabel("I'll handle"));
      for (const parent of lane) board.append(workBlock(parent, { lane: true }));
    }

    const proposed = (data.inbox || []).filter((item) => item.draft || item.proposedGoal);
    if (proposed.length) {
      board.append(sectionLabel('Not on the board yet'));
      for (const item of proposed) board.append(proposedBlock(item));
    }
    return board;
  }

  /**
   * @param {Record<string, unknown>} parent
   * @param {{ primary?: boolean, reason?: string, draggable?: boolean, lane?: boolean }} opts
   */
  function workBlock(parent, opts) {
    const block = document.createElement('div');
    block.className = 'now-block';
    block.append(parentRow(parent, opts));
    for (const step of stepsOf(parent)) block.append(stepRow(step));
    if (openId === parent.id) block.append(details(parent));
    return block;
  }

  /**
   * @param {Record<string, unknown>} parent
   * @param {{ primary?: boolean, reason?: string, draggable?: boolean, lane?: boolean, frozen?: boolean }} opts
   */
  function parentRow(parent, opts) {
    const row = document.createElement('div');
    row.className = opts.primary ? 'now-row now-row--focus' : 'now-row';
    if (opts.draggable) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', String(parent.commitment?.id || ''));
      });
    }
    const mark = document.createElement('span');
    mark.className = 'now-mark';
    mark.textContent = opts.primary ? '●' : opts.lane ? '◦' : '';
    const title = document.createElement(opts.frozen ? 'span' : 'button');
    if (!opts.frozen) title.type = 'button';
    title.className = opts.frozen ? 'now-step-title' : 'now-title';
    title.textContent = String(parent.commitment?.title || parentTitle(parent));
    if (!opts.frozen) {
      title.addEventListener('click', () => {
        openId = openId === parent.id ? null : String(parent.id);
        render();
      });
    }
    const who = document.createElement('span');
    who.className = parent.commitment?.owner === 'you' ? 'now-who' : 'now-who now-who--agent';
    who.textContent = whoLabel(parent.commitment?.owner);
    const when = document.createElement('span');
    when.className = 'now-when';
    when.textContent = whenLabel(parent);
    if (opts.primary && parent.commitment?.state !== 'active' && parent.commitment?.owner !== 'agent') {
      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'now-btn now-btn--tiny';
      start.textContent = 'Start';
      start.addEventListener('click', (e) => {
        e.stopPropagation();
        void post('/api/now/start', { parentId: parent.id });
      });
      when.append(document.createTextNode(' '), start);
    }
    row.append(mark, title, who, when);
    if (opts.primary && opts.reason) {
      const why = document.createElement('p');
      why.className = 'now-why';
      why.textContent = String(opts.reason);
      row.append(why);
    }
    return row;
  }

  /**
   * @param {Record<string, unknown>} step
   */
  function stepRow(step) {
    const row = document.createElement('div');
    row.className = 'now-row now-row--step';
    const mark = document.createElement('span');
    mark.className = 'now-mark';
    mark.textContent = step.done ? '✓' : '·';
    const title = document.createElement('span');
    title.className = 'now-step-title';
    title.textContent = String(step.text || '');
    const who = document.createElement('span');
    const agent = step.who === 'agent';
    who.className = agent ? 'now-who now-who--agent' : 'now-who';
    who.textContent = agent ? "I'll do this" : 'You';
    row.append(mark, title, who);
    return row;
  }

  /**
   * @param {Record<string, unknown>} item
   */
  function proposedBlock(item) {
    const block = document.createElement('div');
    block.className = 'now-block now-block--proposed';
    const draft = item.draft;
    if (draft) {
      block.append(parentRow(draft, { frozen: true }));
      for (const step of stepsOf(draft)) block.append(stepRow(step));
    }
    const goal = item.proposedGoal;
    if (goal?.statement) {
      const row = document.createElement('div');
      row.className = 'now-row';
      const mark = document.createElement('span');
      mark.className = 'now-mark';
      const title = document.createElement('span');
      title.className = 'now-step-title';
      title.textContent = String(goal.statement);
      const who = document.createElement('span');
      who.className = 'now-who';
      who.textContent = goal.kind === 'aim' ? 'Aim' : 'Floor';
      const when = document.createElement('span');
      when.className = 'now-when';
      when.textContent = goalWhen(goal);
      row.append(mark, title, who, when);
      block.append(row);
    }
    if (item.status === 'sorting') {
      const wait = document.createElement('p');
      wait.className = 'now-muted';
      wait.textContent = 'Lining this up…';
      block.append(wait);
    }
    return block;
  }

  /**
   * @param {Record<string, unknown>} parent
   */
  function details(parent) {
    const form = document.createElement('form');
    form.className = 'now-details';
    /** @type {Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>} */
    const fields = {};
    const addField = (name, label, value) => {
      const lab = document.createElement('label');
      lab.className = 'now-field';
      lab.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value == null ? '' : String(value);
      lab.append(input);
      form.append(lab);
      fields[name] = input;
    };
    if (parent.type === 'errand') {
      addField('outcome', 'Outcome', parent.outcome);
      addField('deadline', 'Deadline', parent.deadline);
      addField('vikunjaTaskId', 'Task list id', parent.vikunjaTaskId);
    } else if (parent.type === 'venture') {
      addField('thesis', 'Thesis', parent.thesis);
      addField('riskiestAssumption', 'Riskiest assumption', parent.riskiestAssumption);
      addField('killRule', 'Kill rule', parent.killRule);
    } else {
      addField('question', 'Question', parent.question);
      addField('answeredLooksLike', 'Answered looks like', parent.answeredLooksLike);
      addField('sittingBudget', 'Sittings (1 or 2)', parent.sittingBudget);
    }
    addField('commitTitle', 'Sitting', parent.commitment?.title);
    addField('durationMin', 'Minutes', parent.commitment?.durationMin);
    const ownerLab = document.createElement('label');
    ownerLab.className = 'now-field';
    ownerLab.textContent = 'Who';
    const owner = document.createElement('select');
    for (const opt of [
      ['you', 'You'],
      ['agent', "I'll do this"],
      ['agent-then-you', "I'll draft it"],
    ]) {
      const o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      if (parent.commitment?.owner === opt[0]) o.selected = true;
      owner.append(o);
    }
    ownerLab.append(owner);
    form.append(ownerLab);
    fields.owner = owner;

    const actions = document.createElement('div');
    actions.className = 'now-actions';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'now-btn now-btn--tiny';
    save.textContent = 'Save';
    const finish = document.createElement('button');
    finish.type = 'button';
    finish.className = 'now-btn now-btn--tiny now-btn--quiet';
    finish.textContent = 'Finish';
    finish.addEventListener('click', () => void post('/api/now/finish', { parentId: parent.id }));
    actions.append(save, finish);
    if (parent.commitment?.owner === 'agent-then-you' && parent.commitment?.state !== 'needs-review') {
      const review = document.createElement('button');
      review.type = 'button';
      review.className = 'now-btn now-btn--tiny now-btn--quiet';
      review.textContent = 'Needs review';
      review.addEventListener('click', () => void post('/api/now/review', { parentId: parent.id }));
      actions.append(review);
    }
    form.append(actions);
    if (parent.type === 'errand' && parent.vikunjaTaskId) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'now-btn now-btn--tiny now-btn--quiet';
      link.textContent = 'On the task list';
      link.addEventListener('click', () => document.getElementById('page-tab-main')?.click());
      form.append(link);
    }
    if (parent.type === 'inquiry' && (parent.sittingsUsed || 0) >= (parent.sittingBudget || 1)) {
      const note = document.createElement('p');
      note.className = 'now-muted';
      note.textContent = 'Sitting budget is spent.';
      form.append(note);
      for (const [how, label] of [
        ['drop', 'Drop'],
        ['note', 'File the note'],
        ['venture', 'Open a venture'],
      ]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'now-btn now-btn--tiny';
        btn.textContent = label;
        btn.addEventListener('click', () => void closeInquiry(parent, how));
        form.append(btn);
      }
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = { ...parent, commitment: { ...parent.commitment } };
      for (const [key, input] of Object.entries(fields)) {
        if (key === 'commitTitle') next.commitment.title = input.value;
        else if (key === 'durationMin') next.commitment.durationMin = Number(input.value);
        else if (key === 'owner') next.commitment.owner = input.value;
        else if (key === 'sittingBudget') next.sittingBudget = Number(input.value) === 2 ? 2 : 1;
        else next[key] = input.value;
      }
      const parents = (data.parents || []).map((p) => (p.id === parent.id ? next : p));
      void postPut('/api/now', { parents });
    });
    return form;
  }

  function renderGoals() {
    const wrapGoals = document.createElement('section');
    wrapGoals.className = 'now-goals';
    wrapGoals.append(sectionLabel('Floors and aims'));
    const goals = Array.isArray(data.goals) ? data.goals : [];
    if (!goals.length) {
      const empty = document.createElement('p');
      empty.className = 'now-muted';
      empty.textContent = 'No floors or aims yet.';
      wrapGoals.append(empty);
    }
    for (const goal of goals) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'now-row now-goal';
      const mark = document.createElement('span');
      mark.className = 'now-mark';
      const title = document.createElement('span');
      title.className = 'now-step-title';
      title.textContent = String(goal.statement || '');
      const kind = document.createElement('span');
      kind.className = 'now-who';
      kind.textContent = goal.kind === 'aim' ? 'Aim' : 'Floor';
      const when = document.createElement('span');
      when.className = 'now-when';
      when.textContent = goalWhen(goal);
      row.append(mark, title, kind, when);
      row.addEventListener('click', () => {
        openGoalId = openGoalId === goal.id ? null : String(goal.id);
        render();
      });
      wrapGoals.append(row);
      if (openGoalId === goal.id) wrapGoals.append(goalEditor(goal));
    }
    wrapGoals.append(goalAdder(goals));
    return wrapGoals;
  }

  /**
   * @param {Record<string, unknown>} goal
   */
  function goalEditor(goal) {
    const form = document.createElement('form');
    form.className = 'now-details';
    const statement = document.createElement('input');
    statement.type = 'text';
    statement.value = String(goal.statement || '');
    statement.setAttribute('aria-label', 'Statement');
    form.append(statement);
    if (goal.kind === 'floor') {
      const due = document.createElement('input');
      due.type = 'text';
      due.value = String(goal.due || '');
      due.placeholder = 'YYYY-MM-DD';
      due.setAttribute('aria-label', 'Floor date');
      form.append(due);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const next = { ...goal, statement: statement.value.trim() || goal.statement, due: due.value.trim() };
        void postPut('/api/now/goals', { goals: data.goals.map((g) => (g.id === goal.id ? next : g)) });
      });
    } else {
      const signal = document.createElement('input');
      signal.type = 'text';
      signal.value = goal.signal?.label || '';
      signal.placeholder = 'What to count';
      signal.setAttribute('aria-label', 'Signal');
      const log = document.createElement('input');
      log.type = 'number';
      log.step = 'any';
      log.placeholder = 'Log a count';
      log.setAttribute('aria-label', 'Signal count');
      form.append(signal, log);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const next = {
          ...goal,
          statement: statement.value.trim() || goal.statement,
          signal: signal.value.trim()
            ? { label: signal.value.trim(), unit: goal.signal?.unit || 'count', direction: goal.signal?.direction || 'up' }
            : null,
        };
        const saveGoals = postPut('/api/now/goals', { goals: data.goals.map((g) => (g.id === goal.id ? next : g)) });
        if (log.value !== '') void saveGoals.then(() => post('/api/now/signals', { goalId: goal.id, value: Number(log.value) }));
      });
    }
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'now-btn now-btn--tiny';
    save.textContent = 'Save';
    form.append(save);
    return form;
  }

  /**
   * @param {Record<string, unknown>[]} goals
   */
  function goalAdder(goals) {
    const form = document.createElement('form');
    form.className = 'now-capture now-capture--goal';
    const kind = document.createElement('select');
    kind.setAttribute('aria-label', 'Goal kind');
    for (const opt of [
      ['floor', 'Floor'],
      ['aim', 'Aim'],
    ]) {
      const o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      kind.append(o);
    }
    const statement = document.createElement('input');
    statement.type = 'text';
    statement.placeholder = 'Add a floor or aim';
    statement.setAttribute('aria-label', 'Goal statement');
    const add = document.createElement('button');
    add.type = 'submit';
    add.className = 'now-btn now-btn--tiny';
    add.textContent = 'Add';
    form.append(kind, statement, add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = statement.value.trim();
      if (!text) return;
      const row =
        kind.value === 'aim'
          ? { kind: 'aim', statement: text, weight: 1, signal: null, target: null }
          : { kind: 'floor', statement: text, due: '', promise: '', warnDays: 7, stake: null };
      void postPut('/api/now/goals', { goals: [...goals, row] });
    });
    return form;
  }

  /**
   * @param {{ kind: string, question?: Record<string, unknown>, item?: Record<string, unknown>, hole?: boolean, url?: string }} ask
   */
  function replyForm(ask) {
    const form = document.createElement('form');
    form.className = 'now-reply';
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('aria-label', String(ask.question?.prompt || 'Reply'));
    input.placeholder = 'Reply';
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'now-btn now-btn--tiny';
    btn.textContent = 'Reply';
    form.append(input, btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const answer = input.value.trim();
      if (!answer) return;
      const payload = ask.hole ? { answer } : { questionId: ask.question.id, answer };
      void post(ask.url, payload);
    });
    return form;
  }

  /**
   * @param {Record<string, unknown>} item
   */
  function readyActions(item) {
    const actions = document.createElement('div');
    actions.className = 'now-actions';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'now-btn now-btn--tiny';
    accept.textContent = 'Put it on the board';
    accept.addEventListener('click', () => void post(`/api/now/inbox/${encodeURIComponent(item.id)}/accept`, {}));
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'now-btn now-btn--tiny now-btn--quiet';
    dismiss.textContent = 'Discard';
    dismiss.addEventListener('click', () => void send('DELETE', `/api/now/inbox/${encodeURIComponent(item.id)}`));
    actions.append(accept, dismiss);
    return actions;
  }

  function nextAsk() {
    const inbox = Array.isArray(data.inbox) ? data.inbox : [];
    const sorting = inbox.find((item) => item.status === 'sorting');
    if (sorting) return { kind: 'sorting', text: `I'm lining up “${sorting.note}”.` };
    for (const item of inbox) {
      const question = (item.questions || []).find((q) => q.open);
      if (!question) continue;
      return {
        kind: 'ask',
        item,
        question,
        hole: false,
        url: `/api/now/inbox/${encodeURIComponent(item.id)}/answer`,
        text: `On “${item.note}” — ${question.prompt}`,
      };
    }
    for (const hole of data.holes || []) {
      if (!hole.open) continue;
      const about = holeAbout(hole);
      return {
        kind: 'ask',
        question: hole,
        hole: true,
        url: `/api/now/holes/${encodeURIComponent(hole.id)}/answer`,
        text: about ? `On ${about} — ${hole.prompt}` : String(hole.prompt || ''),
      };
    }
    const ready = inbox.find((item) => item.status === 'ready');
    if (ready) return { kind: 'ready', item: ready, text: readyLine(ready) };
    const failed = inbox.find((item) => item.error);
    if (failed) return { kind: 'error', text: `I couldn't finish lining up “${failed.note}”. ${failed.error}` };
    return { kind: 'status', text: statusLine() };
  }

  /**
   * @param {Record<string, unknown>} item
   */
  function readyLine(item) {
    const bits = [];
    const draft = item.draft;
    const goal = item.proposedGoal;
    if (draft) {
      const kind = draft.type === 'venture' ? 'a venture' : draft.type === 'inquiry' ? 'an inquiry' : 'an errand';
      bits.push(`${kind}, ${parentTitle(draft)}`);
      if (draft.deadline) bits.push(`due ${shortDay(draft.deadline)}`);
    }
    if (goal?.kind === 'floor') {
      if (goal.due) bits.push(`floor ${shortDay(goal.due)}`);
      if (goal.stake?.text) bits.push(clipText(goal.stake.text, 90));
    }
    if (goal?.kind === 'aim') {
      bits.push(goal.target ? `an aim, ${goalWhen(goal)}` : 'an aim, still missing a target');
      if (goal.signal?.label) bits.push(`counting ${goal.signal.label}`);
    }
    const steps = stepsOf(draft);
    const mine = steps.filter((step) => step.who === 'agent').length;
    if (steps.length) bits.push(`${steps.length} steps, ${mine} I can do`);
    const detail = bits.length ? ` ${bits.join('; ')}.` : '';
    return `I lined up “${item.note}”.${detail} Put it on the board?`;
  }

  function statusLine() {
    const rank = data.rank || {};
    const now = rank.now ? parentById(rank.now.parentId) : null;
    const queue = Array.isArray(rank.queue) ? rank.queue : [];
    const lane = Array.isArray(rank.lane) ? rank.lane : [];
    const agentSteps = (data.parents || []).flatMap(stepsOf).filter((step) => step.who === 'agent' && !step.done).length;
    if (!now && !queue.length && !lane.length) {
      return 'The board is clear. Tell me what needs doing and I will line up the tasks.';
    }
    const parts = [];
    if (now) {
      const why = plainWhy(rank.now.reason);
      parts.push(`${rowTitle(now)} is the sitting${why ? ` — ${why}` : ''}.`);
    }
    const names = queue.map((row) => parentById(row.parentId)).filter(Boolean).map(rowTitle);
    if (names.length === 1) parts.push(`Also on the board: ${names[0]}.`);
    else if (names.length) parts.push(`${names.length} more on the board: ${names.slice(0, 4).join(', ')}.`);
    if (lane.length === 1) {
      const handled = parentById(lane[0].parentId);
      if (handled) parts.push(`I am handling ${rowTitle(handled)}.`);
    } else if (lane.length) parts.push(`I am handling ${lane.length} items.`);
    if (agentSteps) {
      parts.push(`I can do ${agentSteps} step${agentSteps === 1 ? '' : 's'}. The rest need you.`);
    }
    return parts.join(' ');
  }

  /**
   * @param {string} text
   */
  function sectionLabel(text) {
    const el = document.createElement('h3');
    el.className = 'now-kicker';
    el.textContent = text;
    return el;
  }

  /**
   * @param {string} text
   */
  function cell(text) {
    const el = document.createElement('span');
    el.textContent = text;
    return el;
  }

  /**
   * @param {string} id
   */
  function parentById(id) {
    return (data?.parents || []).find((p) => p.id === id) || null;
  }

  /**
   * @param {Record<string, unknown> | null | undefined} parent
   */
  function stepsOf(parent) {
    if (!parent) return [];
    const list = parent.type === 'errand' ? parent.checklist : parent.steps;
    return Array.isArray(list) ? list : [];
  }

  /**
   * @param {Record<string, unknown>} parent
   */
  function parentTitle(parent) {
    if (parent.type === 'venture') return String(parent.thesis || 'Venture');
    if (parent.type === 'inquiry') return String(parent.question || 'Inquiry');
    return String(parent.outcome || parent.commitment?.title || 'Errand');
  }

  /**
   * @param {Record<string, unknown>} parent
   */
  function rowTitle(parent) {
    return String(parent.commitment?.title || parentTitle(parent));
  }

  /**
   * @param {Record<string, unknown>} parent
   */
  function whenLabel(parent) {
    if (parent.deadline) return shortDay(parent.deadline);
    if (parent.commitment?.durationMin) return `${parent.commitment.durationMin}m`;
    return '';
  }

  /**
   * @param {Record<string, unknown>} goal
   */
  function goalWhen(goal) {
    if (goal.kind === 'aim') {
      if (!goal.target) return goal.signal?.label ? String(goal.signal.label) : '';
      const n = Number(goal.target.value);
      const value = Number.isFinite(n) ? n.toLocaleString('en-US') : String(goal.target.value);
      const unit = goal.target.unit === '$' ? '$' : '';
      const horizon = goal.target.horizon ? ` ${goal.target.horizon}` : '';
      return `${unit}${value}${horizon}`.trim();
    }
    if (goal.due) return shortDay(goal.due);
    if (goal.promise) return String(goal.promise);
    return '';
  }

  /**
   * @param {Record<string, unknown>} hole
   */
  function holeAbout(hole) {
    const parent = parentById(hole.fills?.parentId);
    if (parent) return rowTitle(parent);
    const goal = (data.goals || []).find((g) => g.id === hole.fills?.goalId);
    return goal?.statement ? String(goal.statement) : '';
  }

  /**
   * @param {Record<string, unknown>} parent
   * @param {'drop' | 'note' | 'venture'} how
   */
  async function closeInquiry(parent, how) {
    const parents = (data.parents || []).map((p) => ({ ...p }));
    const row = parents.find((p) => p.id === parent.id);
    if (!row) return;
    row.status = 'closed';
    row.closeAs = how;
    if (how === 'note') row.note = row.note || row.question;
    if (how === 'venture') {
      parents.unshift({
        type: 'venture',
        thesis: row.question,
        stage: 'hunch',
        commitment: {
          title: `Decide: ${row.question || 'Venture'}`.slice(0, 140),
          durationMin: 45,
          mode: 'decide',
          owner: 'you',
          state: 'nominated',
        },
      });
    }
    openId = null;
    await postPut('/api/now', { parents });
  }

  function schedulePoll() {
    if (poll) clearTimeout(poll);
    const sorting = (data?.inbox || []).some((item) => item.status === 'sorting');
    if (!sorting) return;
    poll = setTimeout(() => {
      if (wrap.contains(document.activeElement) && document.activeElement !== document.body) {
        const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
        if (typing) {
          schedulePoll();
          return;
        }
      }
      void load();
    }, 1500);
  }

  async function load() {
    const response = await fetch('/api/now', { cache: 'no-store' });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || 'now_failed');
    data = json;
    render();
  }

  /**
   * @param {string} url
   * @param {Record<string, unknown>} payload
   */
  async function post(url, payload) {
    await send('POST', url, payload);
  }

  /**
   * @param {string} url
   * @param {Record<string, unknown>} payload
   */
  async function postPut(url, payload) {
    await send('PUT', url, payload);
  }

  /**
   * @param {string} method
   * @param {string} url
   * @param {Record<string, unknown>} [payload]
   */
  async function send(method, url, payload) {
    const response = await fetch(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = document.createElement('p');
      err.className = 'now-muted';
      err.textContent = String(json.error || 'Request failed');
      body.prepend(err);
      return;
    }
    data = json;
    render();
  }

  void load().catch((e) => {
    const err = document.createElement('p');
    err.textContent = String(e?.message || e);
    body.append(err);
  });
}

function pmFace() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('class', 'now-pm__face');
  const head = document.createElementNS(ns, 'circle');
  head.setAttribute('cx', '13');
  head.setAttribute('cy', '9');
  head.setAttribute('r', '4');
  const shoulders = document.createElementNS(ns, 'path');
  shoulders.setAttribute('d', 'M4 28c1.4-6.2 4.8-9 9-9s7.6 2.8 9 9');
  const board = document.createElementNS(ns, 'rect');
  board.setAttribute('x', '18.5');
  board.setAttribute('y', '12');
  board.setAttribute('width', '9');
  board.setAttribute('height', '12');
  board.setAttribute('rx', '1.2');
  for (const el of [head, shoulders, board]) el.setAttribute('fill', 'currentColor');
  board.setAttribute('opacity', '0.45');
  svg.append(head, shoulders, board);
  return svg;
}

/**
 * @param {string | undefined} owner
 */
function whoLabel(owner) {
  if (owner === 'agent') return "I'll do this";
  if (owner === 'agent-then-you') return "I'll draft it";
  return 'You';
}

/**
 * @param {unknown} iso
 */
function shortDay(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso || '').replace(/\.$/, '');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[Number(m[2]) - 1] || m[2];
  const year = Number(m[1]) === new Date().getFullYear() ? '' : ` ${m[1]}`;
  return `${month} ${Number(m[3])}${year}`;
}

/**
 * @param {unknown} reason
 */
function plainWhy(reason) {
  const text = String(reason || '');
  if (/moved this ahead/i.test(text)) return 'you moved it ahead of the ranking';
  const floor = text.match(/Floor due (\d{4}-\d{2}-\d{2})/);
  if (floor) return `the floor is ${shortDay(floor[1])}`;
  if (/in progress/i.test(text)) return 'it is in progress';
  return '';
}

/**
 * @param {unknown} text
 * @param {number} max
 */
function clipText(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trim()}…`;
}
