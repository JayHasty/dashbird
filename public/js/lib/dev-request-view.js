/**
 * Open dev requests list — shared overlay for desktop sticky + mobile sheet.
 */

/** @typedef {{
 *   id: string,
 *   folder: string,
 *   title: string,
 *   body?: string,
 *   platform: string,
 *   areaLabel: string,
 *   priority: number,
 *   priorityLabel: string,
 *   attachments?: string[],
 * }} DevRequestRow */

let mounted = false;

/** @type {HTMLElement | null} */
let backdrop = null;

/** @type {HTMLElement | null} */
let panel = null;

/** @type {HTMLElement | null} */
let listEl = null;

/** @type {HTMLElement | null} */
let statusEl = null;

function ensureMounted() {
  if (mounted) return;
  mounted = true;

  backdrop = document.createElement('div');
  backdrop.className = 'dev-request-view-backdrop';
  backdrop.hidden = true;

  panel = document.createElement('div');
  panel.className = 'dev-request-view';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Open dev requests');

  const header = document.createElement('div');
  header.className = 'dev-request-view__header';

  const title = document.createElement('h2');
  title.className = 'dev-request-view__title';
  title.textContent = 'Open dev requests';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dev-request-view__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';

  header.append(title, closeBtn);

  statusEl = document.createElement('p');
  statusEl.className = 'dev-request-view__status';
  statusEl.textContent = 'Loading…';

  listEl = document.createElement('div');
  listEl.className = 'dev-request-view__list';

  panel.append(header, statusEl, listEl);
  document.body.append(backdrop, panel);

  closeBtn.addEventListener('click', closeDevRequestsViewer);
  backdrop.addEventListener('click', closeDevRequestsViewer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel && !panel.hidden) closeDevRequestsViewer();
  });
}

export function closeDevRequestsViewer() {
  if (!backdrop || !panel) return;
  backdrop.hidden = true;
  panel.hidden = true;
  document.body.classList.remove('dev-request-view-open');
}

/**
 * @param {DevRequestRow[]} requests
 */
function renderList(requests) {
  if (!listEl || !statusEl) return;
  listEl.replaceChildren();

  if (!requests.length) {
    statusEl.textContent = 'No open dev requests.';
    statusEl.hidden = false;
    return;
  }

  statusEl.hidden = true;

  for (const req of requests) {
    const card = document.createElement('article');
    card.className = 'dev-request-view__card';
    card.dataset.id = req.id;

    const cardHead = document.createElement('div');
    cardHead.className = 'dev-request-view__card-head';

    const badge = document.createElement('span');
    const pri = Number(req.priority) || 2;
    const priShort = pri === 1 ? 'high' : pri === 3 ? 'low' : 'med';
    badge.className = `dev-request-view__priority dev-request-view__priority--${priShort}`;
    badge.textContent = req.priorityLabel || (pri === 1 ? 'High' : pri === 3 ? 'Low' : 'Med');

    const cardTitle = document.createElement('h3');
    cardTitle.className = 'dev-request-view__card-title';
    cardTitle.textContent = req.title;
    attachInlineEdit(cardTitle, req, 'title');

    cardHead.append(cardTitle);

    const meta = document.createElement('p');
    meta.className = 'dev-request-view__meta';
    meta.textContent = `${req.areaLabel} (${req.platform})`;

    card.append(cardHead, meta);

    const body = document.createElement('p');
    body.className = 'dev-request-view__body';
    if (req.body) {
      body.textContent = req.body;
    } else {
      body.textContent = 'No note — double-click or long-press to add.';
      body.classList.add('dev-request-view__body--empty');
    }
    attachInlineEdit(body, req, 'body');
    card.append(body);

    const attachments = Array.isArray(req.attachments) ? req.attachments : [];
    if (attachments.length) {
      const thumbs = document.createElement('div');
      thumbs.className = 'dev-request-view__thumbs';
      for (const name of attachments) {
        const img = document.createElement('img');
        img.className = 'dev-request-view__thumb';
        img.src = `/api/dev-requests/${encodeURIComponent(req.id)}/files/${encodeURIComponent(name)}`;
        img.alt = name;
        img.loading = 'lazy';
        thumbs.append(img);
      }
      card.append(thumbs);
    }

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'dev-request-view__done';
    doneBtn.textContent = 'Mark done';
    doneBtn.addEventListener('click', () => {
      void markDone(req.id, doneBtn);
    });

    const footer = document.createElement('div');
    footer.className = 'dev-request-view__footer';
    footer.append(badge, doneBtn);

    card.append(footer);
    listEl.append(card);
  }
}

/**
 * Double-click (desktop) or long-press (touch) to edit a request field in place.
 * @param {HTMLElement} displayEl
 * @param {DevRequestRow} req
 * @param {'title' | 'body'} field
 */
function attachInlineEdit(displayEl, req, field) {
  const trigger = () => beginEdit(displayEl, req, field);
  displayEl.classList.add('dev-request-view__editable');
  displayEl.title = 'Double-click or long-press to edit';

  displayEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    trigger();
  });

  /** @type {ReturnType<typeof setTimeout> | null} */
  let pressTimer = null;
  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };
  displayEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      trigger();
    }, 500);
  });
  displayEl.addEventListener('pointermove', cancelPress);
  displayEl.addEventListener('pointerup', cancelPress);
  displayEl.addEventListener('pointercancel', cancelPress);
}

/**
 * @param {HTMLElement} displayEl
 * @param {DevRequestRow} req
 * @param {'title' | 'body'} field
 */
function beginEdit(displayEl, req, field) {
  if (displayEl.dataset.editing === '1') return;
  displayEl.dataset.editing = '1';

  const isBody = field === 'body';
  const editor = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (
    document.createElement(isBody ? 'textarea' : 'input')
  );
  editor.className = `dev-request-view__edit dev-request-view__edit--${field}`;
  editor.value = field === 'title' ? req.title : req.body || '';
  if (isBody && editor instanceof HTMLTextAreaElement) editor.rows = 8;

  const actions = document.createElement('div');
  actions.className = 'dev-request-view__edit-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'dev-request-view__edit-save';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'dev-request-view__edit-cancel';
  cancelBtn.textContent = 'Cancel';

  actions.append(saveBtn, cancelBtn);

  const wrap = document.createElement('div');
  wrap.className = 'dev-request-view__edit-wrap';
  wrap.append(editor, actions);

  displayEl.replaceWith(wrap);
  editor.focus();

  const restore = () => {
    wrap.replaceWith(displayEl);
    displayEl.dataset.editing = '';
  };

  cancelBtn.addEventListener('click', restore);
  saveBtn.addEventListener('click', async () => {
    const value = editor.value.trim();
    if (field === 'title' && !value) {
      editor.focus();
      return;
    }
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await patchRequest(req.id, { [field]: value });
      await loadAndRender();
    } catch (err) {
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = 'Save';
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = String(err?.message || err);
        statusEl.classList.add('dev-request-view__status--err');
      }
    }
  });

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      restore();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveBtn.click();
    }
  });
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} patch
 */
async function patchRequest(id, patch) {
  const r = await fetch(`/api/dev-requests/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || 'Update failed');
  return data.request;
}

/**
 * @param {string} id
 * @param {HTMLButtonElement} btn
 */
async function markDone(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const r = await fetch(`/api/dev-requests/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || 'Update failed');
    await loadAndRender();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Mark done';
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = String(err?.message || err);
      statusEl.classList.add('dev-request-view__status--err');
    }
  }
}

async function loadAndRender() {
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.textContent = 'Loading…';
    statusEl.classList.remove('dev-request-view__status--err');
  }
  const r = await fetch('/api/dev-requests?status=open', { cache: 'no-store' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    if (statusEl) {
      statusEl.textContent = data.error || 'Failed to load requests';
      statusEl.classList.add('dev-request-view__status--err');
    }
    if (listEl) listEl.replaceChildren();
    return;
  }
  renderList(/** @type {DevRequestRow[]} */ (data.requests || []));
}

/** Show overlay with open dev requests. */
export function openDevRequestsViewer() {
  ensureMounted();
  if (!backdrop || !panel) return;
  backdrop.hidden = false;
  panel.hidden = false;
  document.body.classList.add('dev-request-view-open');
  void loadAndRender();
}
