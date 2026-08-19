import { normalizeLocalTime } from './events-filter-ui.js';

const WINDOW_HOURS = 24;
const GROUPS = ['Sky & space', 'Earth', 'Market & weather'];

/**
 * Collapsible settings section (collapsed by default).
 * @param {{ title: string, headingId: string, className?: string, open?: boolean }} opts
 * @returns {{ details: HTMLDetailsElement, body: HTMLDivElement, summary: HTMLElement }}
 */
function createCollapsibleSection({ title, headingId, className = '', open = false }) {
  const details = document.createElement('details');
  details.className = `settings-page__config-block panel panel--glass settings-page__section${
    className ? ` ${className}` : ''
  }`;
  details.open = open === true;

  const summary = document.createElement('summary');
  summary.className = 'settings-page__block-title settings-page__section-summary';
  summary.id = headingId;
  summary.textContent = title;
  details.append(summary);

  const body = document.createElement('div');
  body.className = 'settings-page__config-block-inner settings-page__section-body';
  details.append(body);

  return { details, body, summary };
}

/**
 * @param {number} n
 * @param {string} [currency]
 */
function formatCostUsd(n, currency = 'USD') {
  const v = Number(n);
  const amount = Number.isFinite(v) ? v : 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

const COST_PIE_COLORS = [
  '#7ec8ff',
  '#ffc46e',
  '#7dcea0',
  '#d7a0ff',
  '#ff8c8c',
  '#9ad0c2',
  '#f0b27a',
  '#85c1e9',
  '#f5b7b1',
  '#a9dfbf',
];

/**
 * @param {object} item
 */
function costsItemShowsUsageMeter(item) {
  const cadence = String(item?.cadence || '');
  return cadence === 'usage' || Boolean(item?.measuredSource);
}

/**
 * @param {{ label: string, pct: number }[]} slices
 * @param {number} [size]
 * @returns {SVGSVGElement}
 */
function buildCostsPieSvg(slices, size = 112) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('settings-page__costs-pie');

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 2;
  const list = Array.isArray(slices) ? slices.filter((s) => Number(s.pct) > 0) : [];

  if (!list.length) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', String(r));
    circle.setAttribute('fill', 'rgba(255,255,255,0.08)');
    svg.append(circle);
    return svg;
  }

  if (list.length === 1 || list[0].pct >= 99.5) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', String(r));
    circle.setAttribute('fill', COST_PIE_COLORS[0]);
    svg.append(circle);
    return svg;
  }

  let angle = -Math.PI / 2;
  list.forEach((slice, i) => {
    const sweep = (Math.max(0, Number(slice.pct) || 0) / 100) * Math.PI * 2;
    const start = angle;
    const end = angle + sweep;
    angle = end;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const large = sweep > Math.PI ? 1 : 0;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`,
    );
    path.setAttribute('fill', COST_PIE_COLORS[i % COST_PIE_COLORS.length]);
    svg.append(path);
  });
  return svg;
}

/**
 * Paid services that keep Dashbird up (simple list + hover breakdown).
 * @param {HTMLElement} root
 */
function buildCostsBlock(root) {
  const { details: block, body } = createCollapsibleSection({
    title: 'Costs',
    headingId: 'settings-costs-heading',
    className: 'settings-page__costs-block',
    open: true,
  });

  const intro = document.createElement('p');
  intro.className = 'settings-page__intro';
  intro.textContent = 'Hover a service for what it powers and where the spend goes.';
  body.append(intro);

  const totalEl = document.createElement('p');
  totalEl.className = 'settings-page__costs-total';
  totalEl.hidden = true;
  body.append(totalEl);

  const loadStatus = document.createElement('p');
  loadStatus.className = 'settings-page__load-status';
  loadStatus.setAttribute('aria-live', 'polite');
  loadStatus.textContent = 'Loading costs…';
  body.append(loadStatus);

  const list = document.createElement('div');
  list.className = 'settings-page__costs-list';
  list.hidden = true;
  body.append(list);

  const popover = document.createElement('div');
  popover.className = 'settings-page__costs-popover';
  popover.hidden = true;
  popover.setAttribute('role', 'tooltip');
  document.body.append(popover);

  /** @type {ReturnType<typeof setTimeout> | null} */
  let hideTimer = null;
  /** @type {HTMLElement | null} */
  let activeRow = null;

  const firstEvents = root.querySelector('.settings-page__events-sources-block, .settings-page__events-block');
  if (firstEvents) root.insertBefore(block, firstEvents);
  else root.append(block);

  function clearHideTimer() {
    if (hideTimer != null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function hidePopover() {
    clearHideTimer();
    popover.hidden = true;
    popover.replaceChildren();
    if (activeRow) {
      activeRow.classList.remove('settings-page__costs-row--hot');
      activeRow = null;
    }
  }

  /**
   * @param {HTMLElement} anchor
   * @param {object} item
   * @param {string} currency
   */
  function showPopover(anchor, item, currency) {
    clearHideTimer();
    if (activeRow && activeRow !== anchor) {
      activeRow.classList.remove('settings-page__costs-row--hot');
    }
    activeRow = anchor;
    anchor.classList.add('settings-page__costs-row--hot');

    const uses = Array.isArray(item.uses) ? item.uses : [];
    const slices = Array.isArray(item.breakdown?.slices) ? item.breakdown.slices : [];

    popover.replaceChildren();
    const title = document.createElement('p');
    title.className = 'settings-page__costs-popover-title';
    title.textContent = item.label || item.id;
    popover.append(title);

    const layout = document.createElement('div');
    layout.className = 'settings-page__costs-popover-layout';

    const usesCol = document.createElement('div');
    usesCol.className = 'settings-page__costs-popover-uses';
    const usesLabel = document.createElement('p');
    usesLabel.className = 'settings-page__costs-section-label';
    usesLabel.textContent = 'Used for';
    usesCol.append(usesLabel);
    const ul = document.createElement('ul');
    ul.className = 'settings-page__costs-uses-list';
    if (!uses.length) {
      const li = document.createElement('li');
      li.textContent = item.usedFor || item.notes || '—';
      ul.append(li);
    } else {
      for (const use of uses) {
        const li = document.createElement('li');
        const name = document.createElement('strong');
        name.textContent = use.label || '—';
        li.append(name);
        if (use.detail) {
          const detail = document.createElement('span');
          detail.textContent = use.detail;
          li.append(detail);
        }
        ul.append(li);
      }
    }
    usesCol.append(ul);

    const pieCol = document.createElement('div');
    pieCol.className = 'settings-page__costs-popover-pie';
    const pieLabel = document.createElement('p');
    pieLabel.className = 'settings-page__costs-section-label';
    pieLabel.textContent = item.breakdown?.estimated ? 'Activity mix (est.)' : 'Where it goes';
    pieCol.append(pieLabel);
    pieCol.append(buildCostsPieSvg(slices));

    const legend = document.createElement('ul');
    legend.className = 'settings-page__costs-pie-legend';
    for (let i = 0; i < slices.length; i += 1) {
      const s = slices[i];
      const li = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'settings-page__costs-pie-swatch';
      swatch.style.background = COST_PIE_COLORS[i % COST_PIE_COLORS.length];
      const text = document.createElement('span');
      text.textContent = `${s.label} · ${s.pct}%`;
      li.append(swatch, text);
      legend.append(li);
    }
    pieCol.append(legend);

    if (item.breakdown?.note) {
      const note = document.createElement('p');
      note.className = 'settings-page__costs-popover-note';
      note.textContent = item.breakdown.note;
      pieCol.append(note);
    }

    layout.append(usesCol, pieCol);
    popover.append(layout);

    const used =
      item.measuredMonthlyUsd != null && Number.isFinite(Number(item.measuredMonthlyUsd))
        ? Number(item.measuredMonthlyUsd)
        : null;
    if (used != null && costsItemShowsUsageMeter(item)) {
      const spend = document.createElement('p');
      spend.className = 'settings-page__costs-popover-spend';
      const lim =
        item.monthlyCreditsUsd != null
          ? Number(item.monthlyCreditsUsd)
          : item.monthlyBudgetUsd != null
            ? Number(item.monthlyBudgetUsd)
            : null;
      spend.textContent =
        lim != null
          ? `This month: ${formatCostUsd(used, currency)} of ${formatCostUsd(lim, currency)}`
          : `This month: ${formatCostUsd(used, currency)}`;
      popover.append(spend);
    }

    popover.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const popW = Math.min(420, Math.max(280, popover.offsetWidth || 360));
    let left = rect.left + window.scrollX;
    let top = rect.bottom + window.scrollY + 8;
    if (left + popW > window.scrollX + window.innerWidth - 12) {
      left = window.scrollX + window.innerWidth - popW - 12;
    }
    if (left < window.scrollX + 8) left = window.scrollX + 8;
    const popH = popover.offsetHeight || 220;
    if (rect.bottom + popH + 16 > window.innerHeight && rect.top > popH + 16) {
      top = rect.top + window.scrollY - popH - 8;
    }
    popover.style.width = `${popW}px`;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  /**
   * @param {object} item
   * @param {string} currency
   */
  function buildRow(item, currency) {
    const row = document.createElement('div');
    row.className = 'settings-page__costs-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute(
      'aria-label',
      `${item.label || item.id}. Hover or focus for usage breakdown.`,
    );

    const name = document.createElement('span');
    name.className = 'settings-page__costs-row-name';
    name.textContent = item.label || item.id;

    const right = document.createElement('div');
    right.className = 'settings-page__costs-row-right';

    const isUsage = costsItemShowsUsageMeter(item);
    const monthly =
      item.monthlyFixedUsd != null
        ? Number(item.monthlyFixedUsd)
        : item.displayMonthlyUsd != null
          ? Number(item.displayMonthlyUsd)
          : item.monthlyBudgetUsd != null
            ? Number(item.monthlyBudgetUsd)
            : Math.round((Number(item.weeklyUsd) || 0) * 4.33 * 100) / 100;

    if (isUsage) {
      const used =
        item.measuredMonthlyUsd != null && Number.isFinite(Number(item.measuredMonthlyUsd))
          ? Number(item.measuredMonthlyUsd)
          : 0;
      const lim =
        item.monthlyCreditsUsd != null
          ? Number(item.monthlyCreditsUsd)
          : item.monthlyBudgetUsd != null
            ? Number(item.monthlyBudgetUsd)
            : monthly || 1;
      const pct = lim > 0 ? Math.min(100, Math.round((used / lim) * 100)) : 0;

      const amt = document.createElement('span');
      amt.className = 'settings-page__costs-row-amt';
      amt.textContent = `${formatCostUsd(used, currency)} / ${formatCostUsd(lim, currency)}`;
      right.append(amt);

      const meter = document.createElement('div');
      meter.className = 'settings-page__costs-meter settings-page__costs-meter--row';
      meter.setAttribute('role', 'progressbar');
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', String(lim));
      meter.setAttribute('aria-valuenow', String(used));
      const fill = document.createElement('div');
      fill.className = 'settings-page__costs-meter-fill';
      if (pct >= 90) fill.classList.add('settings-page__costs-meter-fill--hot');
      else if (pct >= 70) fill.classList.add('settings-page__costs-meter-fill--warn');
      fill.style.width = `${pct}%`;
      meter.append(fill);
      right.append(meter);
    } else {
      const amt = document.createElement('span');
      amt.className = 'settings-page__costs-row-amt';
      amt.textContent = formatCostUsd(monthly, currency);
      right.append(amt);
    }

    row.append(name, right);

    const open = () => showPopover(row, item, currency);
    const scheduleHide = () => {
      clearHideTimer();
      hideTimer = setTimeout(() => {
        if (!popover.matches(':hover') && document.activeElement !== row) hidePopover();
      }, 160);
    };

    row.addEventListener('pointerenter', open);
    row.addEventListener('pointerleave', scheduleHide);
    row.addEventListener('focus', open);
    row.addEventListener('blur', scheduleHide);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hidePopover();
    });

    return row;
  }

  /**
   * @param {object} data
   */
  function applyPayload(data) {
    const currency = data.currency || 'USD';
    const items = (Array.isArray(data.items) ? data.items : []).filter((i) => i.active !== false);
    const projected =
      data.summary?.projectedMonthlyUsd ??
      data.summary?.effectiveMonthlyUsd ??
      0;

    totalEl.hidden = false;
    totalEl.textContent = `About ${formatCostUsd(projected, currency)} / month`;

    list.replaceChildren();
    for (const item of items) list.append(buildRow(item, currency));
    list.hidden = false;
    loadStatus.hidden = true;
    loadStatus.textContent = '';
  }

  function reload() {
    hidePopover();
    loadStatus.hidden = false;
    loadStatus.className = 'settings-page__load-status';
    loadStatus.textContent = 'Loading costs…';
    fetch('/api/dashboard-costs', { cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
        applyPayload(data);
      })
      .catch((e) => {
        loadStatus.className = 'settings-page__err';
        loadStatus.textContent =
          e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      });
  }

  popover.addEventListener('pointerenter', clearHideTimer);
  popover.addEventListener('pointerleave', () => {
    hideTimer = setTimeout(hidePopover, 120);
  });
  window.addEventListener('scroll', hidePopover, { passive: true });
  window.addEventListener('resize', hidePopover);

  reload();
}


/**
 * Away base: preview destination dashboard before a trip; auto when GPS is near.
 * @param {HTMLElement} root
 */
function buildAwayBaseBlock(root) {
  const { details: block, body } = createCollapsibleSection({
    title: 'Away base',
    headingId: 'settings-away-heading',
    className: 'settings-page__away-block',
  });

  const blurb = document.createElement('p');
  blurb.className = 'settings-page__secondary-blurb';
  blurb.textContent =
    'Travel destination for weather, Earth, and Events. Use View Away base before you leave; when your phone GPS is within the radius, Dashbird switches to Away-only automatically.';
  body.append(blurb);

  const statusRow = document.createElement('p');
  statusRow.className = 'settings-page__secondary-current';
  const statusLabel = document.createElement('span');
  statusLabel.textContent = 'Mode: ';
  const statusValue = document.createElement('strong');
  statusValue.className = 'settings-page__away-mode';
  statusValue.textContent = '…';
  statusRow.append(statusLabel, statusValue);
  body.append(statusRow);

  const currentRow = document.createElement('p');
  currentRow.className = 'settings-page__secondary-current';
  const currentLabel = document.createElement('span');
  currentLabel.textContent = 'Active profile: ';
  const currentValue = document.createElement('strong');
  currentValue.className = 'settings-page__away-profile';
  currentValue.textContent = '…';
  currentRow.append(currentLabel, currentValue);
  body.append(currentRow);

  const labelField = document.createElement('label');
  labelField.className = 'settings-page__rain-label';
  labelField.htmlFor = 'settings-away-zip';
  labelField.textContent = 'Away ZIP';
  body.append(labelField);

  const input = document.createElement('input');
  input.id = 'settings-away-zip';
  input.className = 'settings-page__secondary-zip-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.maxLength = 10;
  input.spellcheck = false;
  input.autocomplete = 'postal-code';
  body.append(input);

  const radiusLabel = document.createElement('label');
  radiusLabel.className = 'settings-page__rain-label';
  radiusLabel.htmlFor = 'settings-away-radius';
  radiusLabel.textContent = 'Auto radius (miles)';
  body.append(radiusLabel);

  const radiusInput = document.createElement('input');
  radiusInput.id = 'settings-away-radius';
  radiusInput.className = 'settings-page__secondary-zip-input';
  radiusInput.type = 'number';
  radiusInput.min = '5';
  radiusInput.max = '200';
  radiusInput.step = '1';
  body.append(radiusInput);

  const actions = document.createElement('div');
  actions.className = 'settings-page__rain-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-page__rain-save';
  saveBtn.textContent = 'Save Away base';

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'settings-page__rain-save';
  previewBtn.textContent = 'View Away base';

  const exitBtn = document.createElement('button');
  exitBtn.type = 'button';
  exitBtn.className = 'settings-page__secondary-cancel';
  exitBtn.textContent = 'Exit preview / Away';

  const msg = document.createElement('p');
  msg.className = 'settings-page__rain-msg';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  actions.append(saveBtn, previewBtn, exitBtn, msg);
  body.append(actions);

  const firstSection = root.querySelector('.settings-page__section');
  if (firstSection) root.insertBefore(block, firstSection);
  else root.append(block);

  function paint(data) {
    const mode = String(data?.locationMode || 'home');
    statusValue.textContent =
      mode === 'preview'
        ? 'Preview Away'
        : mode === 'away'
          ? 'Away (auto)'
          : 'Home';
    const p = data?.activeProfile;
    if (p) {
      currentValue.textContent = `${p.label || p.zip} · ${p.zip}`;
      input.value = p.zip || '';
      radiusInput.value = String(p.radiusMi || 40);
    } else {
      currentValue.textContent = '—';
    }
    previewBtn.disabled = mode === 'preview' || mode === 'away';
    exitBtn.disabled = mode === 'home';
  }

  function showMsg(text, isErr) {
    msg.hidden = false;
    msg.textContent = text;
    msg.classList.toggle('settings-page__err', !!isErr);
  }

  async function reloadAfter() {
    showMsg('Reloading dashboard…', false);
    window.location.reload();
  }

  fetch('/api/away-base', { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => paint(data))
    .catch(() => {
      statusValue.textContent = 'unavailable';
    });

  saveBtn.addEventListener('click', () => {
    const zip = String(input.value || '').replace(/\D/g, '');
    const radiusMi = Number(radiusInput.value);
    if (zip.length !== 5) {
      showMsg('Enter a 5-digit US ZIP.', true);
      return;
    }
    saveBtn.disabled = true;
    fetch('/api/away-base', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        zip,
        radiusMi: Number.isFinite(radiusMi) && radiusMi > 0 ? radiusMi : 40,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data?.ok === false) throw new Error(data.error || 'save failed');
        paint(data);
        showMsg('Saved.', false);
      })
      .catch((e) => showMsg(String(e.message || e), true))
      .finally(() => {
        saveBtn.disabled = false;
      });
  });

  previewBtn.addEventListener('click', () => {
    previewBtn.disabled = true;
    fetch('/api/away-base', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview: true, autoAway: false }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data?.ok === false) throw new Error(data.error || 'preview failed');
        return reloadAfter();
      })
      .catch((e) => {
        showMsg(String(e.message || e), true);
        previewBtn.disabled = false;
      });
  });

  exitBtn.addEventListener('click', () => {
    exitBtn.disabled = true;
    fetch('/api/away-base', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview: false, autoAway: false }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data?.ok === false) throw new Error(data.error || 'exit failed');
        return reloadAfter();
      })
      .catch((e) => {
        showMsg(String(e.message || e), true);
        exitBtn.disabled = false;
      });
  });
}

/**
 * Secondary ZIP: second hero weather tile + lightning bugs (fall foliage watches ZIP 24066).
 * Shows the stored ZIP; “Change secondary ZIP” reveals the editor.
 * @param {HTMLElement} root
 */
function buildSecondaryWatchBlock(root) {
  const { details: block, body } = createCollapsibleSection({
    title: 'Secondary ZIP',
    headingId: 'settings-secondary-heading',
    className: 'settings-page__secondary-block',
  });

  const blurb = document.createElement('p');
  blurb.className = 'settings-page__secondary-blurb';
  blurb.textContent =
    'Drives the second hero weather city and firefly season. Fall foliage watches ZIP 24066. Reload the dashboard after saving.';
  body.append(blurb);

  const currentRow = document.createElement('p');
  currentRow.className = 'settings-page__secondary-current';
  const currentLabel = document.createElement('span');
  currentLabel.className = 'settings-page__secondary-current-label';
  currentLabel.textContent = 'Stored ZIP: ';
  const currentValue = document.createElement('strong');
  currentValue.className = 'settings-page__secondary-current-value';
  currentValue.textContent = '…';
  currentRow.append(currentLabel, currentValue);
  body.append(currentRow);

  const changeBtn = document.createElement('button');
  changeBtn.type = 'button';
  changeBtn.className = 'settings-page__rain-save settings-page__secondary-change';
  changeBtn.textContent = 'Change secondary ZIP';
  body.append(changeBtn);

  const editor = document.createElement('div');
  editor.className = 'settings-page__secondary-editor';
  editor.hidden = true;

  const label = document.createElement('label');
  label.className = 'settings-page__rain-label';
  label.htmlFor = 'settings-secondary-zip';
  label.textContent = 'US ZIP code';
  editor.append(label);

  const input = document.createElement('input');
  input.id = 'settings-secondary-zip';
  input.className = 'settings-page__secondary-zip-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.maxLength = 10;
  input.spellcheck = false;
  input.autocomplete = 'postal-code';
  editor.append(input);

  const actions = document.createElement('div');
  actions.className = 'settings-page__rain-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-page__rain-save';
  saveBtn.textContent = 'Save ZIP';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'settings-page__secondary-cancel';
  cancelBtn.textContent = 'Cancel';

  const msg = document.createElement('p');
  msg.className = 'settings-page__rain-msg';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  actions.append(saveBtn, cancelBtn, msg);
  editor.append(actions);
  body.append(editor);

  const firstSection = root.querySelector('.settings-page__section');
  if (firstSection) root.insertBefore(block, firstSection);
  else root.append(block);

  /** @type {string} */
  let storedZip = '';

  function showEditor(open) {
    editor.hidden = !open;
    changeBtn.hidden = open;
    if (open) {
      input.value = storedZip;
      input.focus();
      input.select();
    }
    msg.hidden = true;
    msg.textContent = '';
  }

  changeBtn.addEventListener('click', () => showEditor(true));
  cancelBtn.addEventListener('click', () => showEditor(false));

  /**
   * @param {string} zip
   * @param {string} [place]
   */
  function paintStored(zip, place) {
    storedZip = zip;
    const p = typeof place === 'string' ? place.trim() : '';
    currentValue.textContent = zip ? (p ? `${zip} · ${p}` : zip) : '—';
    if (zip) input.value = zip;
  }

  fetch('/api/secondary-watch/zip', { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => {
      if (data?.zip) {
        paintStored(String(data.zip), data.place);
      } else {
        currentValue.textContent = '—';
      }
    })
    .catch(() => {
      currentValue.textContent = '—';
    });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    msg.hidden = false;
    msg.classList.remove('settings-page__rain-msg--err');
    msg.textContent = 'Saving…';
    try {
      const r = await fetch('/api/secondary-watch/zip', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zip: input.value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      const z = String(data.zip || input.value).replace(/\D/g, '').slice(0, 5);
      paintStored(z, data.place);
      msg.textContent = data.place
        ? `Saved · hero secondary city: ${data.place}. Reload dashboard to refresh.`
        : 'Saved. Reload dashboard to refresh the secondary weather tile.';
      showEditor(false);
    } catch (e) {
      msg.classList.add('settings-page__rain-msg--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not save.';
    } finally {
      saveBtn.disabled = false;
    }
  });
}

/**
 * @param {string} group
 * @returns {string}
 */
function groupHeadingId(group) {
  return `settings-events-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * @param {HTMLElement} root
 * @param {number} _windowHours
 */
function buildSettingsShell(root, _windowHours) {
  root.replaceChildren();
  root.className = 'settings-page__body settings-page__inner';

  const status = document.createElement('p');
  status.className = 'settings-page__load-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Loading event types…';
  root.append(status);

  /** @type {Map<string, HTMLTableSectionElement>} */
  const tbodyByGroup = new Map();

  for (const group of GROUPS) {
    const { details, body } = createCollapsibleSection({
      title: group,
      headingId: groupHeadingId(group),
      className: 'settings-page__events-block',
    });

    const table = document.createElement('table');
    table.className = 'settings-page__table settings-page__table--events';
    table.setAttribute('aria-labelledby', groupHeadingId(group));

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['Event type', 'Value', 'Active', 'Data source', 'Live feed']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);

    const tbody = document.createElement('tbody');
    table.append(tbody);
    body.append(table);
    root.append(details);
    tbodyByGroup.set(group, tbody);
  }

  return { tbodyByGroup, status };
}

/**
 * @param {string | null | undefined} url
 * @returns {HTMLTableCellElement}
 */
function buildLiveFeedCell(url) {
  const td = document.createElement('td');
  td.className = 'settings-page__live';
  const raw = typeof url === 'string' ? url.trim() : '';
  if (raw && /^https?:\/\//i.test(raw)) {
    const a = document.createElement('a');
    a.href = raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    try {
      a.textContent = new URL(raw).hostname.replace(/^www\./, '');
    } catch {
      a.textContent = 'Open';
    }
    a.title = raw;
    td.append(a);
  } else {
    td.textContent = '—';
  }
  return td;
}

/**
 * Site-column links for a Gmail intake row (App Password preferred; OAuth optional).
 * @param {string} email
 * @returns {HTMLTableCellElement}
 */
function buildGmailConnectCell(email) {
  const td = document.createElement('td');
  td.className = 'settings-page__live settings-page__live--gmail';

  const wrap = document.createElement('div');
  wrap.className = 'settings-page__gmail-row-links';

  const appPw = document.createElement('a');
  appPw.href =
    `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(email)}`
    + `&continue=${encodeURIComponent('https://myaccount.google.com/apppasswords')}`;
  appPw.target = '_blank';
  appPw.rel = 'noopener noreferrer';
  appPw.textContent = 'App Password';
  appPw.title =
    `Create a Google App Password while signed in as ${email}, then set GMAIL_INTAKE_APP_PASSWORD_* in .env`;

  const oauth = document.createElement('a');
  oauth.href = `/api/events-finder-gmail/oauth/start?email=${encodeURIComponent(email)}`;
  oauth.textContent = 'OAuth';
  oauth.title = `OAuth connect ${email} (Gmail API)`;

  wrap.append(appPw, oauth);
  td.append(wrap);
  return td;
}

/**
 * @param {Map<string, HTMLTableSectionElement>} tbodyByGroup
 * @param {Array<{ id: string, label: string, category?: string, dataSource?: string, liveUrl?: string | null }>} types
 */
function populatePendingRows(tbodyByGroup, types) {
  /** @type {Map<string, HTMLTableRowElement>} */
  const rowById = new Map();

  for (const group of GROUPS) {
    const tbody = tbodyByGroup.get(group);
    if (!tbody) continue;
    tbody.replaceChildren();
    const rows = types.filter((t) => (t.category || '') === group);
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.className = 'settings-page__row--pending';
      tr.dataset.eventId = row.id;
      tr.dataset.category = group;

      const tdType = document.createElement('td');
      tdType.className = 'settings-page__type-label';
      tdType.textContent = row.label || row.id;

      const tdVal = document.createElement('td');
      tdVal.className = 'settings-page__value settings-page__value--loading';
      tdVal.textContent = 'Loading…';

      const tdActive = document.createElement('td');
      tdActive.className = 'settings-page__active settings-page__value--loading';
      tdActive.textContent = '…';

      const tdSrc = document.createElement('td');
      tdSrc.className = 'settings-page__source';
      tdSrc.textContent = row.dataSource || '—';

      const tdLive = buildLiveFeedCell(row.liveUrl);

      tr.append(tdType, tdVal, tdActive, tdSrc, tdLive);
      tbody.append(tr);
      rowById.set(row.id, tr);
    }
  }

  return rowById;
}

/**
 * @param {HTMLTableRowElement} tr
 * @param {{ active?: boolean | null, value?: string | null, pending?: boolean }} row
 */
function updateEventRow(tr, row) {
  const pending = row.pending === true;
  tr.classList.remove('settings-page__row--pending', 'settings-page__row--active', 'settings-page__row--inactive');
  if (pending) {
    tr.classList.add('settings-page__row--pending');
  } else if (row.active) {
    tr.classList.add('settings-page__row--active');
  } else {
    tr.classList.add('settings-page__row--inactive');
  }

  const tdVal = tr.querySelector('.settings-page__value');
  const tdActive = tr.querySelector('.settings-page__active');
  if (tdVal instanceof HTMLElement) {
    tdVal.classList.toggle('settings-page__value--loading', pending);
    tdVal.textContent = pending ? 'Loading…' : row.value || '—';
  }
  if (tdActive instanceof HTMLElement) {
    tdActive.classList.toggle('settings-page__value--loading', pending);
    tdActive.classList.remove('settings-page__active--yes', 'settings-page__active--no');
    if (pending) {
      tdActive.textContent = '…';
    } else {
      tdActive.textContent = row.active ? 'Yes' : 'No';
      tdActive.classList.add(row.active ? 'settings-page__active--yes' : 'settings-page__active--no');
    }
  }
}

/**
 * @param {Map<string, HTMLTableRowElement>} rowById
 * @param {Array<{ id: string, active?: boolean, value?: string, pending?: boolean, liveUrl?: string | null }>} types
 */
function applyTypeUpdates(rowById, types) {
  for (const row of types) {
    const tr = rowById.get(row.id);
    if (!tr) continue;
    updateEventRow(tr, row);
    const tdLive = tr.querySelector('.settings-page__live');
    if (tdLive instanceof HTMLTableCellElement) {
      const fresh = buildLiveFeedCell(row.liveUrl);
      tdLive.replaceWith(fresh);
    }
  }
}

async function fetchEventTypesPart(part, windowHours) {
  const q = new URLSearchParams({ part, windowHours: String(windowHours) });
  const r = await fetch(`/api/event-types-status?${q}`, { cache: 'no-store' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return data;
}

/**
 * Modal to edit taste, where/when filters, and Facebook scrape settings.
 */
function openEventsFilterCriteriaModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'settings-page__modal-backdrop';
  backdrop.setAttribute('role', 'presentation');

  const modal = document.createElement('div');
  modal.className = 'settings-page__modal settings-page__modal--criteria';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'settings-events-criteria-title');

  const header = document.createElement('div');
  header.className = 'settings-page__modal-header';

  const title = document.createElement('h3');
  title.id = 'settings-events-criteria-title';
  title.className = 'settings-page__modal-title';
  title.textContent = 'Events criteria (ingestion)';

  const hint = document.createElement('p');
  hint.className = 'settings-page__modal-hint';
  hint.textContent =
    'Controls what gets scraped into the catalog: keyword lists and Facebook discovery. This is separate from the Events sidebar Filters, which only sort/hide events already in the database.';

  header.append(title, hint);

  const body = document.createElement('div');
  body.className = 'settings-page__modal-scroll';

  /** @type {{ city?: string | null, place?: string | null, zip?: string | null } | null} */
  let geoState = null;
  /** @type {Array<{ url: string, name: string, avgEventsPerMonth: number | null, avgComputedAt?: string | null }>} */
  let pinnedHosts = [];
  /** @type {object | null} */
  let facebookBilling = null;

  const tasteHeading = document.createElement('h4');
  tasteHeading.className = 'settings-page__modal-subheading';
  tasteHeading.textContent = '1. Taste keywords (catalog ranking)';

  const lookLabelRow = document.createElement('div');
  lookLabelRow.className = 'settings-page__modal-label-row';
  const lookLabel = document.createElement('label');
  lookLabel.className = 'settings-page__modal-field-label';
  lookLabel.htmlFor = 'settings-events-criteria-look';
  lookLabel.textContent = 'Look for (whitelist)';
  const lookCount = document.createElement('span');
  lookCount.className = 'settings-page__modal-count';
  lookCount.textContent = '';
  lookLabelRow.append(lookLabel, lookCount);

  const lookHint = document.createElement('p');
  lookHint.className = 'settings-page__modal-field-hint';
  lookHint.textContent =
    'One idea per line. Ranks and keeps events already in the catalog (all sources). Does not buy Facebook Apify searches — edit those under Facebook discovery below.';

  const lookArea = document.createElement('textarea');
  lookArea.id = 'settings-events-criteria-look';
  lookArea.className = 'settings-page__modal-textarea settings-page__modal-textarea--look';
  lookArea.rows = 10;
  lookArea.spellcheck = true;
  lookArea.placeholder = 'Loading…';

  const skipLabelRow = document.createElement('div');
  skipLabelRow.className = 'settings-page__modal-label-row';
  const skipLabel = document.createElement('label');
  skipLabel.className = 'settings-page__modal-field-label';
  skipLabel.htmlFor = 'settings-events-criteria-skip';
  skipLabel.textContent = 'Grey list';
  const skipCount = document.createElement('span');
  skipCount.className = 'settings-page__modal-count';
  skipCount.textContent = '';
  skipLabelRow.append(skipLabel, skipCount);

  const skipHint = document.createElement('p');
  skipHint.className = 'settings-page__modal-field-hint';
  skipHint.textContent =
    'Hide matching catalog events only when no Look for (whitelist) line also matches. Feed-only — does not change what Apify scrapes or what you pay.';

  const skipArea = document.createElement('textarea');
  skipArea.id = 'settings-events-criteria-skip';
  skipArea.className = 'settings-page__modal-textarea';
  skipArea.rows = 5;
  skipArea.spellcheck = true;
  skipArea.placeholder = 'Loading…';

  const blackLabelRow = document.createElement('div');
  blackLabelRow.className = 'settings-page__modal-label-row';
  const blackLabel = document.createElement('label');
  blackLabel.className = 'settings-page__modal-field-label';
  blackLabel.htmlFor = 'settings-events-criteria-blacklist';
  blackLabel.textContent = 'Black list';
  const blackCount = document.createElement('span');
  blackCount.className = 'settings-page__modal-count';
  blackCount.textContent = '';
  blackLabelRow.append(blackLabel, blackCount);

  const blackHint = document.createElement('p');
  blackHint.className = 'settings-page__modal-field-hint';
  blackHint.textContent =
    'Always hide matching catalog events, even if a Look for (whitelist) line also matches. Feed-only.';

  const blackArea = document.createElement('textarea');
  blackArea.id = 'settings-events-criteria-blacklist';
  blackArea.className = 'settings-page__modal-textarea';
  blackArea.rows = 5;
  blackArea.spellcheck = true;
  blackArea.placeholder = 'Loading…';

  const ingestHeading = document.createElement('h4');
  ingestHeading.className = 'settings-page__modal-subheading';
  ingestHeading.textContent = '2. Ingestion window';

  const ingestHint = document.createElement('p');
  ingestHint.className = 'settings-page__modal-field-hint';
  ingestHint.textContent =
    'Scrape ahead shapes how far paid/bulk scrapers look and the Events sidebar date chips. Dated invites from Gmail (and Telegram) are kept even when months out — the horizon no longer drops far-future records.';

  const weeksLabel = document.createElement('label');
  weeksLabel.className = 'settings-page__modal-field-label';
  weeksLabel.htmlFor = 'settings-events-criteria-weeks';
  weeksLabel.textContent = 'Scrape ahead';

  const weeksSelect = document.createElement('select');
  weeksSelect.id = 'settings-events-criteria-weeks';
  weeksSelect.className = 'settings-page__modal-input settings-page__modal-input--select';

  /**
   * @param {number} [selected]
   */
  function renderWeeksOptions(selected = 4) {
    weeksSelect.replaceChildren();
    for (const w of [1, 2, 3, 4, 5]) {
      const opt = document.createElement('option');
      opt.value = String(w);
      const days = w * 7;
      opt.textContent = `Rolling ${w} week${w === 1 ? '' : 's'} (~${days} days)`;
      weeksSelect.append(opt);
    }
    weeksSelect.value = String(selected);
  }
  renderWeeksOptions(4);

  const weeksLiveHint = document.createElement('p');
  weeksLiveHint.className = 'settings-page__modal-field-hint';
  weeksLiveHint.id = 'settings-events-criteria-weeks-hint';

  /**
   * @param {number} [weeks]
   * @param {{ futureDays?: number } | null} [ingestWindow]
   */
  function updateWeeksLiveHint(weeks, ingestWindow = null) {
    const w = Number(weeks) || Number(weeksSelect.value) || 4;
    const days = ingestWindow?.futureDays || w * 7;
    weeksLiveHint.textContent = `Scrapers / date chips look ~${days} days ahead (rolling ${w} week${w === 1 ? '' : 's'}). Far-future dated invites are still recorded when found.`;
  }
  updateWeeksLiveHint(4);
  weeksSelect.addEventListener('change', () => {
    updateWeeksLiveHint(Number(weeksSelect.value));
  });

  const earliestEnable = document.createElement('label');
  earliestEnable.className = 'settings-page__modal-check';
  const earliestCheck = document.createElement('input');
  earliestCheck.type = 'checkbox';
  earliestCheck.id = 'settings-events-criteria-earliest-on';
  const earliestEnableText = document.createElement('span');
  earliestEnableText.textContent = 'Require earliest start time (optional)';
  earliestEnable.append(earliestCheck, earliestEnableText);

  const earliestHint = document.createElement('p');
  earliestHint.className = 'settings-page__modal-field-hint';
  earliestHint.textContent =
    'When enabled, drop ingested events that start before this local time. Independent of the sidebar Filters earliest time.';

  const timeInput = document.createElement('input');
  timeInput.id = 'settings-events-criteria-earliest';
  timeInput.className = 'settings-page__modal-input settings-page__modal-input--time';
  timeInput.type = 'time';
  timeInput.step = '60';
  timeInput.value = '11:00';
  timeInput.disabled = true;

  earliestCheck.addEventListener('change', () => {
    timeInput.disabled = !earliestCheck.checked;
  });

  const scrapeDetails = document.createElement('details');
  scrapeDetails.className = 'settings-page__modal-details';
  scrapeDetails.open = true;

  const scrapeSummary = document.createElement('summary');
  scrapeSummary.className = 'settings-page__modal-details-summary';
  scrapeSummary.textContent = '3. Facebook discovery (Apify) — paid';

  const scrapeBody = document.createElement('div');
  scrapeBody.className = 'settings-page__modal-details-body';

  const scrapeHint = document.createElement('p');
  scrapeHint.className = 'settings-page__modal-field-hint';
  scrapeHint.textContent =
    'Gmail invites are free and separate. Paid Apify discovery = keyword searches below + pinned hosts. Taste keywords above only rank the catalog.';

  const billingRow = document.createElement('p');
  billingRow.className = 'settings-page__modal-billing';
  billingRow.textContent = 'Billing month: …';

  /** @type {string[]} */
  let searchQueries = [];

  const fbSearchLabelRow = document.createElement('div');
  fbSearchLabelRow.className = 'settings-page__modal-label-row';
  const fbSearchLabel = document.createElement('p');
  fbSearchLabel.className = 'settings-page__modal-field-label';
  fbSearchLabel.textContent = 'Facebook keyword searches (paid)';
  const fbSearchCount = document.createElement('span');
  fbSearchCount.className = 'settings-page__modal-count';
  fbSearchCount.textContent = '';
  fbSearchLabelRow.append(fbSearchLabel, fbSearchCount);

  const fbSearchHint = document.createElement('p');
  fbSearchHint.className = 'settings-page__modal-field-hint';
  fbSearchHint.textContent =
    'Paid Apify keyword searches. Include a city in the query when you want one; otherwise the dashboard city is appended. Max search queries below caps how many run.';

  const fbSearchToolbar = document.createElement('div');
  fbSearchToolbar.className = 'settings-page__modal-pinned-toolbar';
  const addSearchBtn = document.createElement('button');
  addSearchBtn.type = 'button';
  addSearchBtn.className = 'settings-page__secondary-cancel';
  addSearchBtn.textContent = 'Add query';
  const seedSearchBtn = document.createElement('button');
  seedSearchBtn.type = 'button';
  seedSearchBtn.className = 'settings-page__secondary-cancel';
  seedSearchBtn.textContent = 'Seed from Look for';
  seedSearchBtn.title = 'Copy the first N Look for lines into this list (does not change Look for)';
  fbSearchToolbar.append(addSearchBtn, seedSearchBtn);

  const fbSearchList = document.createElement('div');
  fbSearchList.className = 'settings-page__modal-fb-searches';

  const budgetRow = document.createElement('div');
  budgetRow.className = 'settings-page__modal-budget-row';

  function makeNumField(id, labelText, hintText, min, max, value) {
    const wrap = document.createElement('div');
    wrap.className = 'settings-page__modal-budget-field';
    const lab = document.createElement('label');
    lab.className = 'settings-page__modal-field-label';
    lab.htmlFor = id;
    lab.textContent = labelText;
    const hintEl = document.createElement('p');
    hintEl.className = 'settings-page__modal-field-hint';
    hintEl.textContent = hintText;
    const input = document.createElement('input');
    input.id = id;
    input.className = 'settings-page__modal-input';
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(value);
    wrap.append(lab, hintEl, input);
    return { wrap, input };
  }

  const maxQueries = makeNumField(
    'settings-events-scrape-max-queries',
    'Max search queries',
    'Run at most this many queries from the list above (1–24).',
    1,
    24,
    6,
  );
  const maxPer = makeNumField(
    'settings-events-scrape-max-per',
    'Max events / query',
    'Apify bills per result (1–200).',
    1,
    200,
    30,
  );
  const cacheHours = makeNumField(
    'settings-events-scrape-cache-hours',
    'Cache hours',
    'Reuse results while fresh (1–168).',
    1,
    168,
    6,
  );
  budgetRow.append(maxQueries.wrap, maxPer.wrap, cacheHours.wrap);

  const pinnedLabelRow = document.createElement('div');
  pinnedLabelRow.className = 'settings-page__modal-label-row';
  const pinnedLabel = document.createElement('p');
  pinnedLabel.className = 'settings-page__modal-field-label';
  pinnedLabel.textContent = 'Pinned Facebook hosts';
  const pinnedCount = document.createElement('span');
  pinnedCount.className = 'settings-page__modal-count';
  pinnedCount.textContent = '';
  pinnedLabelRow.append(pinnedLabel, pinnedCount);

  const pinnedHint = document.createElement('p');
  pinnedHint.className = 'settings-page__modal-field-hint';
  pinnedHint.textContent =
    'Groups/pages always scraped. Avg/mo is read-only: events seen on that host over the last 6 months ÷ 6 (via Apify, including past hosted events). Updates after Facebook scrapes.';

  const pinnedToolbar = document.createElement('div');
  pinnedToolbar.className = 'settings-page__modal-pinned-toolbar';

  const bulkAddBtn = document.createElement('button');
  bulkAddBtn.type = 'button';
  bulkAddBtn.className = 'settings-page__secondary-cancel';
  bulkAddBtn.textContent = 'Bulk add';

  const bulkDeleteBtn = document.createElement('button');
  bulkDeleteBtn.type = 'button';
  bulkDeleteBtn.className = 'settings-page__secondary-cancel';
  bulkDeleteBtn.textContent = 'Delete selected';

  const addRowBtn = document.createElement('button');
  addRowBtn.type = 'button';
  addRowBtn.className = 'settings-page__secondary-cancel';
  addRowBtn.textContent = 'Add row';

  pinnedToolbar.append(addRowBtn, bulkAddBtn, bulkDeleteBtn);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'settings-page__modal-pinned-wrap';

  const table = document.createElement('table');
  table.className = 'settings-page__modal-pinned-table';
  table.innerHTML =
    '<thead><tr>'
    + '<th scope="col" class="settings-page__modal-pinned-check"><input type="checkbox" id="settings-pinned-select-all" title="Select all" aria-label="Select all hosts"></th>'
    + '<th scope="col">Name</th>'
    + '<th scope="col">URL</th>'
    + '<th scope="col" class="settings-page__modal-pinned-avg" title="Events in last 6 months ÷ 6">Avg/mo</th>'
    + '</tr></thead>';
  const tbody = document.createElement('tbody');
  table.append(tbody);
  tableWrap.append(table);

  const selectAll = table.querySelector('#settings-pinned-select-all');

  const bulkAddPanel = document.createElement('div');
  bulkAddPanel.className = 'settings-page__modal-bulk-add';
  bulkAddPanel.hidden = true;
  const bulkAddHint = document.createElement('p');
  bulkAddHint.className = 'settings-page__modal-field-hint';
  bulkAddHint.textContent =
    'One host per line: URL, or Name | URL. Blank lines and # comments ignored.';
  const bulkAddArea = document.createElement('textarea');
  bulkAddArea.className = 'settings-page__modal-textarea settings-page__modal-textarea--pinned';
  bulkAddArea.rows = 6;
  bulkAddArea.placeholder =
    'SFBay AcroYoga | https://www.facebook.com/groups/sfbayacro/\ngroups/noisebridge';
  const bulkAddActions = document.createElement('div');
  bulkAddActions.className = 'settings-page__modal-pinned-toolbar';
  const bulkAddConfirm = document.createElement('button');
  bulkAddConfirm.type = 'button';
  bulkAddConfirm.className = 'settings-page__rain-save';
  bulkAddConfirm.textContent = 'Add lines';
  const bulkAddCancel = document.createElement('button');
  bulkAddCancel.type = 'button';
  bulkAddCancel.className = 'settings-page__secondary-cancel';
  bulkAddCancel.textContent = 'Close';
  bulkAddActions.append(bulkAddConfirm, bulkAddCancel);
  bulkAddPanel.append(bulkAddHint, bulkAddArea, bulkAddActions);

  scrapeBody.append(
    scrapeHint,
    billingRow,
    fbSearchLabelRow,
    fbSearchHint,
    fbSearchToolbar,
    fbSearchList,
    budgetRow,
    pinnedLabelRow,
    pinnedHint,
    pinnedToolbar,
    tableWrap,
    bulkAddPanel,
  );
  scrapeDetails.append(scrapeSummary, scrapeBody);

  body.append(
    tasteHeading,
    lookLabelRow,
    lookHint,
    lookArea,
    skipLabelRow,
    skipHint,
    skipArea,
    blackLabelRow,
    blackHint,
    blackArea,
    ingestHeading,
    ingestHint,
    weeksLabel,
    weeksSelect,
    weeksLiveHint,
    earliestEnable,
    earliestHint,
    timeInput,
    scrapeDetails,
  );

  const footer = document.createElement('div');
  footer.className = 'settings-page__modal-footer';

  const msg = document.createElement('p');
  msg.className = 'settings-page__rain-msg';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  const actions = document.createElement('div');
  actions.className = 'settings-page__modal-actions settings-page__modal-actions--footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'settings-page__secondary-cancel';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-page__rain-save';
  saveBtn.textContent = 'Save';

  actions.append(cancelBtn, saveBtn);
  footer.append(msg, actions);

  modal.append(header, body, footer);
  backdrop.append(modal);
  document.body.append(backdrop);

  /**
   * @param {string} block
   * @returns {string[]}
   */
  function nonEmptyLines(block) {
    return String(block || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * @param {HTMLElement} el
   * @param {number} n
   * @param {string} unit
   */
  function setCount(el, n, unit) {
    el.textContent = n ? `${n} ${unit}${n === 1 ? '' : 's'}` : '';
  }

  function readPinnedFromTable() {
    /** @type {Array<{ url: string, name: string, avgEventsPerMonth: number | null, avgComputedAt?: string | null }>} */
    const rows = [];
    const priorByUrl = new Map(
      pinnedHosts.map((h) => [String(h.url || '').trim().toLowerCase(), h]),
    );
    for (const tr of tbody.querySelectorAll('tr')) {
      const nameInput = /** @type {HTMLInputElement | null} */ (tr.querySelector('[data-field="name"]'));
      const urlInput = /** @type {HTMLInputElement | null} */ (tr.querySelector('[data-field="url"]'));
      const url = String(urlInput?.value || '').trim();
      if (!url) continue;
      const prior = priorByUrl.get(url.toLowerCase());
      rows.push({
        name: String(nameInput?.value || '').trim() || 'Facebook host',
        url,
        avgEventsPerMonth: prior?.avgEventsPerMonth ?? null,
        avgComputedAt: prior?.avgComputedAt ?? null,
      });
    }
    pinnedHosts = rows;
    return rows;
  }

  function renderPinnedTable() {
    tbody.replaceChildren();
    for (const host of pinnedHosts) {
      const tr = document.createElement('tr');
      const tdCheck = document.createElement('td');
      tdCheck.className = 'settings-page__modal-pinned-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'settings-page__modal-pinned-row-check';
      cb.setAttribute('aria-label', `Select ${host.name || host.url}`);
      tdCheck.append(cb);

      const tdName = document.createElement('td');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'settings-page__modal-pinned-input';
      nameInput.dataset.field = 'name';
      nameInput.value = host.name || '';
      nameInput.placeholder = 'Group name';
      tdName.append(nameInput);

      const tdUrl = document.createElement('td');
      const urlInput = document.createElement('input');
      urlInput.type = 'url';
      urlInput.className = 'settings-page__modal-pinned-input settings-page__modal-pinned-input--url';
      urlInput.dataset.field = 'url';
      urlInput.value = host.url || '';
      urlInput.placeholder = 'https://www.facebook.com/groups/…';
      tdUrl.append(urlInput);

      const tdAvg = document.createElement('td');
      tdAvg.className = 'settings-page__modal-pinned-avg';
      const avgEl = document.createElement('span');
      avgEl.className = 'settings-page__modal-pinned-avg-value';
      avgEl.dataset.field = 'avg';
      if (host.avgEventsPerMonth == null || host.avgEventsPerMonth === '') {
        avgEl.textContent = '—';
        avgEl.title = 'Computed after the next Facebook scrape from the last 6 months of events on this host';
      } else {
        avgEl.textContent = String(host.avgEventsPerMonth);
        avgEl.title = host.avgComputedAt
          ? `Last 6 months ÷ 6 (updated ${new Date(host.avgComputedAt).toLocaleDateString()})`
          : 'Last 6 months ÷ 6 (from Apify host pages)';
      }
      tdAvg.append(avgEl);

      tr.append(tdCheck, tdName, tdUrl, tdAvg);
      tbody.append(tr);
    }
    if (selectAll instanceof HTMLInputElement) selectAll.checked = false;
    setCount(pinnedCount, pinnedHosts.length, 'host');
    updateScrapeSummary();
  }

  function renderBilling() {
    if (!facebookBilling || typeof facebookBilling !== 'object') {
      billingRow.textContent = 'Billing month: no runs logged yet.';
      return;
    }
    const month = facebookBilling.month || 'this month';
    const total = Number(facebookBilling.totalUsd) || 0;
    const credits = Number(facebookBilling.monthlyCreditsUsd) || 5;
    const remaining = Number(facebookBilling.remainingCreditsUsd);
    const runs = Number(facebookBilling.runCount) || 0;
    const est = Number(facebookBilling.estimatedRunCount) || 0;
    const remLabel = Number.isFinite(remaining)
      ? ` · $${remaining.toFixed(2)} of $${credits.toFixed(0)} credits left`
      : '';
    const estLabel = est ? ` (${est} estimated)` : '';
    billingRow.textContent =
      `${month}: $${total.toFixed(2)} across ${runs} run${runs === 1 ? '' : 's'}${estLabel}${remLabel}`;
  }

  function updateScrapeSummary() {
    const q = Math.min(
      Math.max(Number(maxQueries.input.value) || 6, 1),
      24,
      Math.max(searchQueries.filter(Boolean).length, 1),
    );
    const per = Number(maxPer.input.value) || 30;
    const hrs = Number(cacheHours.input.value) || 6;
    const pins = pinnedHosts.length;
    scrapeSummary.textContent = `3. Facebook discovery (Apify) — ${q} searches × ${per} events, ${hrs}h cache${
      pins ? `, ${pins} pinned` : ''
    }`;
  }

  function updateTasteCounts() {
    setCount(lookCount, nonEmptyLines(lookArea.value).length, 'line');
    setCount(skipCount, nonEmptyLines(skipArea.value).length, 'line');
    setCount(blackCount, nonEmptyLines(blackArea.value).length, 'line');
  }

  function placeShort() {
    const place =
      (geoState && (geoState.city || geoState.place)) ||
      'San Francisco';
    return String(place).split(',')[0].trim() || 'San Francisco';
  }

  /**
   * @param {string} line
   */
  function resolveFbQuery(line) {
    const s = String(line || '').trim();
    if (!s) return '';
    const lower = s.toLowerCase();
    if (
      lower.includes('san francisco') ||
      lower.includes('oakland') ||
      lower.includes('berkeley') ||
      lower.includes('emeryville') ||
      lower.includes('bay area')
    ) {
      return s;
    }
    return `${s} ${placeShort()}`;
  }

  function readSearchQueriesFromUi() {
    searchQueries = [...fbSearchList.querySelectorAll('[data-field="fb-query"]')]
      .map((el) => (el instanceof HTMLInputElement ? el.value.trim() : ''))
      .filter(Boolean)
      .slice(0, 24);
    return searchQueries;
  }

  function renderFbSearchList() {
    fbSearchList.replaceChildren();
    const n = Math.min(Math.max(Number(maxQueries.input.value) || 6, 1), 24);
    const rows = searchQueries.length ? [...searchQueries] : [''];
    rows.forEach((query, index) => {
      const wrap = document.createElement('div');
      wrap.className = 'settings-page__modal-fb-search-item';
      if (index >= n) wrap.classList.add('settings-page__modal-fb-search-item--capped');

      const row = document.createElement('div');
      row.className = 'settings-page__modal-fb-search-row';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'settings-page__modal-pinned-input';
      input.dataset.field = 'fb-query';
      input.value = query;
      input.placeholder = 'e.g. hackathon Oakland';
      input.addEventListener('input', () => refreshFbSearchMeta());

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'settings-page__secondary-cancel';
      upBtn.textContent = '↑';
      upBtn.title = 'Move up';
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', () => {
        const cur = [...fbSearchList.querySelectorAll('[data-field="fb-query"]')].map((el) =>
          el instanceof HTMLInputElement ? el.value : '',
        );
        if (index <= 0) return;
        [cur[index - 1], cur[index]] = [cur[index], cur[index - 1]];
        searchQueries = cur;
        renderFbSearchList();
      });

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'settings-page__secondary-cancel';
      downBtn.textContent = '↓';
      downBtn.title = 'Move down';
      downBtn.disabled = index >= rows.length - 1;
      downBtn.addEventListener('click', () => {
        const cur = [...fbSearchList.querySelectorAll('[data-field="fb-query"]')].map((el) =>
          el instanceof HTMLInputElement ? el.value : '',
        );
        if (index >= cur.length - 1) return;
        [cur[index + 1], cur[index]] = [cur[index], cur[index + 1]];
        searchQueries = cur;
        renderFbSearchList();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'settings-page__secondary-cancel';
      delBtn.textContent = '×';
      delBtn.title = 'Remove';
      delBtn.addEventListener('click', () => {
        const cur = [...fbSearchList.querySelectorAll('[data-field="fb-query"]')].map((el) =>
          el instanceof HTMLInputElement ? el.value : '',
        );
        cur.splice(index, 1);
        searchQueries = cur.map((s) => String(s || '').trim()).filter(Boolean);
        renderFbSearchList();
      });

      row.append(input, upBtn, downBtn, delBtn);
      wrap.append(row);

      const resolved = resolveFbQuery(query);
      if (query.trim() && resolved !== query.trim()) {
        const note = document.createElement('p');
        note.className = 'settings-page__modal-fb-search-note';
        note.textContent = `→ ${resolved}`;
        wrap.append(note);
      } else if (index >= n && query.trim()) {
        const note = document.createElement('p');
        note.className = 'settings-page__modal-fb-search-note';
        note.textContent = 'Over max — not run until raised or moved up';
        wrap.append(note);
      }

      fbSearchList.append(wrap);
    });
    refreshFbSearchMeta();
  }

  function refreshFbSearchMeta() {
    readSearchQueriesFromUi();
    const n = Math.min(Math.max(Number(maxQueries.input.value) || 6, 1), 24);
    const active = Math.min(searchQueries.length, n);
    fbSearchCount.textContent = searchQueries.length
      ? active < searchQueries.length
        ? `${active} of ${searchQueries.length} run`
        : `${searchQueries.length} quer${searchQueries.length === 1 ? 'y' : 'ies'}`
      : '';
    updateScrapeSummary();
    updateTasteCounts();

    // Refresh capped styling + place notes without full re-render when typing.
    const items = [...fbSearchList.querySelectorAll('.settings-page__modal-fb-search-item')];
    items.forEach((item, index) => {
      item.classList.toggle('settings-page__modal-fb-search-item--capped', index >= n);
      const input = item.querySelector('[data-field="fb-query"]');
      const value = input instanceof HTMLInputElement ? input.value.trim() : '';
      let note = item.querySelector('.settings-page__modal-fb-search-note');
      const resolved = resolveFbQuery(value);
      let noteText = '';
      if (value && resolved !== value) noteText = `→ ${resolved}`;
      else if (index >= n && value) noteText = 'Over max — not run until raised or moved up';
      if (noteText) {
        if (!note) {
          note = document.createElement('p');
          note.className = 'settings-page__modal-fb-search-note';
          item.append(note);
        }
        note.textContent = noteText;
      } else if (note) {
        note.remove();
      }
    });
  }

  /**
   * @param {{
   *   city?: string | null,
   *   place?: string | null,
   *   zip?: string | null,
   * } | null | undefined} geo
   */
  function renderGeo(geo) {
    geoState = geo && typeof geo === 'object' ? geo : null;
  }

  /**
   * @param {string} block
   */
  function parseBulkHosts(block) {
    /** @type {Array<{ url: string, name: string, avgEventsPerMonth: number | null }>} */
    const out = [];
    for (const line of String(block || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('|').map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const last = parts[parts.length - 1];
        const first = parts[0];
        if (/facebook\.com|groups\//i.test(last)) {
          out.push({ name: parts.slice(0, -1).join(' | '), url: last, avgEventsPerMonth: null });
        } else if (/facebook\.com|groups\//i.test(first)) {
          out.push({ name: parts.slice(1).join(' | '), url: first, avgEventsPerMonth: null });
        } else {
          out.push({ name: parts.slice(0, -1).join(' | '), url: last, avgEventsPerMonth: null });
        }
      } else {
        out.push({ name: '', url: trimmed, avgEventsPerMonth: null });
      }
    }
    return out;
  }

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  lookArea.addEventListener('input', updateTasteCounts);
  skipArea.addEventListener('input', updateTasteCounts);
  blackArea.addEventListener('input', updateTasteCounts);
  maxQueries.input.addEventListener('input', () => {
    renderFbSearchList();
  });
  maxPer.input.addEventListener('input', updateScrapeSummary);
  cacheHours.input.addEventListener('input', updateScrapeSummary);

  addSearchBtn.addEventListener('click', () => {
    readSearchQueriesFromUi();
    if (searchQueries.length >= 12) return;
    searchQueries = [...searchQueries, ''];
    renderFbSearchList();
    const last = fbSearchList.querySelector('.settings-page__modal-fb-search-row:last-child [data-field="fb-query"]');
    if (last instanceof HTMLInputElement) last.focus();
  });

  seedSearchBtn.addEventListener('click', () => {
    const n = Math.min(Math.max(Number(maxQueries.input.value) || 6, 1), 24);
    const seeded = nonEmptyLines(lookArea.value).slice(0, n);
    if (!seeded.length) return;
    searchQueries = seeded;
    renderFbSearchList();
  });

  addRowBtn.addEventListener('click', () => {
    readPinnedFromTable();
    pinnedHosts.push({ name: '', url: '', avgEventsPerMonth: null });
    renderPinnedTable();
    const last = tbody.querySelector('tr:last-child [data-field="url"]');
    if (last instanceof HTMLInputElement) last.focus();
  });

  bulkAddBtn.addEventListener('click', () => {
    bulkAddPanel.hidden = !bulkAddPanel.hidden;
    if (!bulkAddPanel.hidden) bulkAddArea.focus();
  });
  bulkAddCancel.addEventListener('click', () => {
    bulkAddPanel.hidden = true;
  });
  bulkAddConfirm.addEventListener('click', () => {
    readPinnedFromTable();
    const added = parseBulkHosts(bulkAddArea.value);
    if (!added.length) return;
    const seen = new Set(
      pinnedHosts.map((h) => String(h.url || '').trim().toLowerCase()).filter(Boolean),
    );
    for (const host of added) {
      const key = String(host.url || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      pinnedHosts.push(host);
    }
    renderPinnedTable();
    bulkAddArea.value = '';
    bulkAddPanel.hidden = true;
  });

  bulkDeleteBtn.addEventListener('click', () => {
    const next = [];
    const priorByUrl = new Map(
      pinnedHosts.map((h) => [String(h.url || '').trim().toLowerCase(), h]),
    );
    for (const tr of tbody.querySelectorAll('tr')) {
      const cb = tr.querySelector('.settings-page__modal-pinned-row-check');
      if (cb instanceof HTMLInputElement && cb.checked) continue;
      const nameInput = /** @type {HTMLInputElement | null} */ (tr.querySelector('[data-field="name"]'));
      const urlInput = /** @type {HTMLInputElement | null} */ (tr.querySelector('[data-field="url"]'));
      const url = String(urlInput?.value || '').trim();
      if (!url && !String(nameInput?.value || '').trim()) continue;
      const prior = priorByUrl.get(url.toLowerCase());
      next.push({
        name: String(nameInput?.value || '').trim() || 'Facebook host',
        url,
        avgEventsPerMonth: prior?.avgEventsPerMonth ?? null,
        avgComputedAt: prior?.avgComputedAt ?? null,
      });
    }
    pinnedHosts = next;
    renderPinnedTable();
  });

  if (selectAll instanceof HTMLInputElement) {
    selectAll.addEventListener('change', () => {
      for (const cb of tbody.querySelectorAll('.settings-page__modal-pinned-row-check')) {
        if (cb instanceof HTMLInputElement) cb.checked = selectAll.checked;
      }
    });
  }

  const filterControls = [
    lookArea,
    skipArea,
    blackArea,
    weeksSelect,
    earliestCheck,
    timeInput,
    maxQueries.input,
    maxPer.input,
    cacheHours.input,
    addSearchBtn,
    seedSearchBtn,
    addRowBtn,
    bulkAddBtn,
    bulkDeleteBtn,
  ];
  for (const el of filterControls) el.disabled = true;
  saveBtn.disabled = true;
  msg.hidden = false;
  msg.textContent = 'Loading…';

  fetch('/api/events-finder-criteria', { cache: 'no-store' })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      lookArea.value = typeof data.lookFor === 'string' ? data.lookFor : '';
      lookArea.placeholder = 'One idea per line…';
      skipArea.value = typeof data.skip === 'string' ? data.skip : '';
      skipArea.placeholder = 'One idea per line…';
      blackArea.value = typeof data.blacklist === 'string' ? data.blacklist : '';
      blackArea.placeholder = 'One idea per line…';
      renderGeo(data.geo);
      facebookBilling = data.facebookBilling || null;
      renderBilling();

      const scrape = data.scrape && typeof data.scrape === 'object' ? data.scrape : {};
      maxQueries.input.value = String(scrape.maxQueries ?? 6);
      maxPer.input.value = String(scrape.maxEventsPerQuery ?? 30);
      cacheHours.input.value = String(scrape.cacheHours ?? 6);
      weeksSelect.value = String(scrape.windowWeeks ?? 4);
      renderWeeksOptions(Number(scrape.windowWeeks) || 4);
      updateWeeksLiveHint(
        Number(scrape.windowWeeks) || 4,
        data.ingestWindow && typeof data.ingestWindow === 'object' ? data.ingestWindow : null,
      );
      const ingestEarliest = normalizeLocalTime(scrape.earliestLocalTime);
      if (ingestEarliest) {
        earliestCheck.checked = true;
        timeInput.disabled = false;
        timeInput.value = ingestEarliest;
      } else {
        earliestCheck.checked = false;
        timeInput.disabled = true;
        timeInput.value = '11:00';
      }
      pinnedHosts = Array.isArray(scrape.pinnedHosts)
        ? scrape.pinnedHosts.map((h) => ({
            url: String(h?.url || ''),
            name: String(h?.name || ''),
            avgEventsPerMonth:
              h?.avgEventsPerMonth == null || h?.avgEventsPerMonth === ''
                ? null
                : Number(h.avgEventsPerMonth),
            avgComputedAt: h?.avgComputedAt ? String(h.avgComputedAt) : null,
          }))
        : typeof scrape.pinnedHosts === 'string'
          ? parseBulkHosts(scrape.pinnedHosts)
          : [];
      searchQueries = Array.isArray(scrape.searchQueries)
        ? scrape.searchQueries.map((s) => String(s || '').trim()).filter(Boolean)
        : typeof scrape.searchQueries === 'string'
          ? nonEmptyLines(scrape.searchQueries)
          : [];
      renderPinnedTable();
      renderFbSearchList();

      for (const el of filterControls) el.disabled = false;
      timeInput.disabled = !earliestCheck.checked;
      saveBtn.disabled = false;
      msg.hidden = true;
      msg.textContent = '';
      updateTasteCounts();
      lookArea.focus();
    })
    .catch((e) => {
      msg.classList.add('settings-page__rain-msg--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load.';
      cancelBtn.focus();
    });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    msg.hidden = false;
    msg.classList.remove('settings-page__rain-msg--err');
    msg.textContent = 'Saving…';
    try {
      const earliestRaw = earliestCheck.checked ? String(timeInput.value || '').trim() : '';
      const earliest = normalizeLocalTime(earliestRaw);
      if (earliestRaw && !earliest) {
        throw new Error('Earliest time must look like 11:00.');
      }
      const q = Number(maxQueries.input.value);
      const per = Number(maxPer.input.value);
      const hrs = Number(cacheHours.input.value);
      const weeks = Number(weeksSelect.value);
      if (!Number.isFinite(q) || q < 1 || q > 24) {
        throw new Error('Max search queries must be 1–24.');
      }
      if (!Number.isFinite(per) || per < 1 || per > 200) {
        throw new Error('Max events per query must be 1–200.');
      }
      if (!Number.isFinite(hrs) || hrs < 1 || hrs > 168) {
        throw new Error('Cache hours must be 1–168.');
      }
      if (![1, 2, 3, 4, 5].includes(weeks)) {
        throw new Error('Scrape ahead must be 1–5 weeks.');
      }
      const hosts = readPinnedFromTable();
      const queries = readSearchQueriesFromUi();
      const r = await fetch('/api/events-finder-criteria', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lookFor: lookArea.value,
          skip: skipArea.value,
          blacklist: blackArea.value,
          scrape: {
            maxQueries: q,
            maxEventsPerQuery: per,
            cacheHours: hrs,
            windowWeeks: weeks,
            earliestLocalTime: earliest || null,
            searchQueries: queries,
            pinnedHosts: hosts,
          },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      updateWeeksLiveHint(
        Number(data.scrape?.windowWeeks) || weeks,
        data.ingestWindow && typeof data.ingestWindow === 'object' ? data.ingestWindow : null,
      );
      close();
    } catch (e) {
      msg.classList.add('settings-page__rain-msg--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not save.';
      saveBtn.disabled = false;
    }
  });
}



/**
 * Prompt + POST a new Events source bookmark.
 * @returns {Promise<boolean>} true if a source was added
 */
async function openAddEventSourceDialog() {
  const label = window.prompt('Source name (e.g. Prescott Market)');
  if (label == null) return false;
  const trimmedLabel = String(label).trim();
  if (!trimmedLabel) {
    window.alert('Name is required.');
    return false;
  }
  const url = window.prompt(
    'Events page URL (https://…)\n\nPaste a public page that lists events (venue calendar, Squarespace /events, Google Calendar embed page). Platform hubs (Partiful, Luma, Meetup…) already have dedicated ingest.',
  );
  if (url == null) return false;
  const trimmedUrl = String(url).trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    window.alert('URL must start with http:// or https://');
    return false;
  }
  try {
    const r = await fetch('/api/events-finder-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: trimmedLabel, url: trimmedUrl }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${r.status}`);
    }
    if (data.webpageListing) {
      window.alert(
        `Added “${trimmedLabel}”. Events from that page will appear after the next Events ingest refresh.`,
      );
    }
    return true;
  } catch (e) {
    window.alert(e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));
    return false;
  }
}

/**
 * Events finder sources from Personal bookmarks “Events” — one row per site,
 * with strategy / status / output (strategies differ by host).
 * @param {HTMLElement} root
 */
function buildEventsFinderSourcesBlock(root) {
  const { details: block, body } = createCollapsibleSection({
    title: 'Events sources',
    headingId: 'settings-events-sources-heading',
    className: 'settings-page__events-sources-block',
  });

  const toolbar = document.createElement('div');
  toolbar.className = 'settings-page__events-toolbar';

  const criteriaBtn = document.createElement('button');
  criteriaBtn.type = 'button';
  criteriaBtn.className = 'settings-page__rain-save';
  criteriaBtn.textContent = 'Edit criteria';
  criteriaBtn.title =
    'Ingestion settings: keywords, scrape window, and Facebook discovery (not browse filters)';
  criteriaBtn.addEventListener('click', () => openEventsFilterCriteriaModal());
  toolbar.append(criteriaBtn);

  const addSourceBtn = document.createElement('button');
  addSourceBtn.type = 'button';
  addSourceBtn.className = 'settings-page__rain-save';
  addSourceBtn.textContent = '+ Event source';
  addSourceBtn.title = 'Add a site to Personal bookmarks → Events (shows up in this list)';
  addSourceBtn.addEventListener('click', () => {
    void openAddEventSourceDialog().then((added) => {
      if (added) reloadSources();
    });
  });
  toolbar.append(addSourceBtn);
  body.append(toolbar);

  const intro = document.createElement('p');
  intro.className = 'settings-page__intro';
  intro.textContent =
    'From Personal bookmarks → Events. Each site has its own ingest strategy, development status, and known coverage gaps. Use Edit criteria for taste keywords, scrape window, Facebook keyword searches, and pinned hosts. Browse ZIP/dates live in the Events sidebar Filters. Gmail intake rows link App Password or OAuth in the Site column.';
  body.append(intro);

  const loadStatus = document.createElement('p');
  loadStatus.className = 'settings-page__load-status';
  loadStatus.setAttribute('aria-live', 'polite');
  loadStatus.textContent = 'Loading Events sources…';
  body.append(loadStatus);

  const table = document.createElement('table');
  table.className = 'settings-page__table settings-page__table--events-sources';
  table.setAttribute('aria-labelledby', 'settings-events-sources-heading');

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of [
    'Source',
    'Strategy',
    'Dev status',
    'Status',
    'Output',
    'Missing / gaps',
    'Ingestion test',
    'Site',
  ]) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);

  const tbody = document.createElement('tbody');
  table.append(tbody);
  body.append(table);

  const firstEventsGroup = root.querySelector('.settings-page__events-block');
  if (firstEventsGroup) root.insertBefore(block, firstEventsGroup);
  else root.append(block);

  /** @type {Map<string, HTMLTableRowElement>} */
  const rowById = new Map();

  /**
   * @param {Array<{
   *   id: string,
   *   label: string,
   *   url: string,
   *   gmailEmail?: string | null,
   *   strategyLabel?: string,
   *   strategyDetail?: string,
   *   strategy?: string,
   *   devStatus?: string,
   *   devStatusKind?: string,
   *   missingEvents?: string,
   *   pending?: boolean,
   *   active?: boolean | null,
   *   value?: string | null,
   *   output?: string | null,
   *   ingestOk?: boolean | null,
   *   ingestTest?: string | null,
   * }>} sources
   */
  function populateRows(sources) {
    tbody.replaceChildren();
    rowById.clear();
    for (const src of sources) {
      const tr = document.createElement('tr');
      tr.className = 'settings-page__row--pending';
      tr.dataset.sourceId = src.id;

      const tdName = document.createElement('td');
      tdName.className = 'settings-page__type-label';
      tdName.textContent = src.label || src.id;

      const tdStrat = document.createElement('td');
      tdStrat.className = 'settings-page__strategy';
      const stratLabel = document.createElement('div');
      stratLabel.className = 'settings-page__strategy-label';
      stratLabel.textContent = src.strategyLabel || src.strategy || '—';
      tdStrat.append(stratLabel);
      if (src.strategyDetail) {
        const detail = document.createElement('p');
        detail.className = 'settings-page__strategy-detail';
        detail.textContent = src.strategyDetail;
        tdStrat.append(detail);
      }

      const tdDev = document.createElement('td');
      tdDev.className = 'settings-page__source-dev-status';
      const kind = String(src.devStatusKind || 'unspecified').toLowerCase();
      tdDev.classList.add(`settings-page__dev-status--${kind}`);
      tdDev.textContent = src.devStatus || '—';

      const tdStatus = document.createElement('td');
      tdStatus.className = 'settings-page__value settings-page__value--loading settings-page__source-status';
      tdStatus.textContent = 'Loading…';

      const tdOut = document.createElement('td');
      tdOut.className = 'settings-page__value settings-page__value--loading settings-page__source-output';
      tdOut.textContent = '…';

      const tdMissing = document.createElement('td');
      tdMissing.className = 'settings-page__source-missing';
      tdMissing.textContent = src.missingEvents || '—';

      const tdIngest = document.createElement('td');
      tdIngest.className =
        'settings-page__value settings-page__value--loading settings-page__source-ingest';
      tdIngest.textContent = '…';

      const tdLive = src.gmailEmail
        ? buildGmailConnectCell(src.gmailEmail)
        : buildLiveFeedCell(src.url);

      tr.append(tdName, tdStrat, tdDev, tdStatus, tdOut, tdMissing, tdIngest, tdLive);
      tbody.append(tr);
      rowById.set(src.id, tr);
    }
  }

  /**
   * @param {HTMLTableRowElement} tr
   * @param {{
   *   pending?: boolean,
   *   active?: boolean | null,
   *   value?: string | null,
   *   output?: string | null,
   *   ingestOk?: boolean | null,
   *   ingestTest?: string | null,
   * }} row
   */
  function updateSourceRow(tr, row) {
    const pending = row.pending === true;
    tr.classList.remove(
      'settings-page__row--pending',
      'settings-page__row--active',
      'settings-page__row--inactive',
    );
    if (pending) tr.classList.add('settings-page__row--pending');
    else if (row.active) tr.classList.add('settings-page__row--active');
    else tr.classList.add('settings-page__row--inactive');

    const tdStatus = tr.querySelector('.settings-page__source-status');
    const tdOut = tr.querySelector('.settings-page__source-output');
    const tdIngest = tr.querySelector('.settings-page__source-ingest');
    if (tdStatus instanceof HTMLElement) {
      tdStatus.classList.toggle('settings-page__value--loading', pending);
      tdStatus.classList.remove('settings-page__active--yes', 'settings-page__active--no');
      if (pending) {
        tdStatus.textContent = 'Loading…';
      } else {
        tdStatus.textContent = row.value || '—';
        tdStatus.classList.add(row.active ? 'settings-page__active--yes' : 'settings-page__active--no');
      }
    }
    if (tdOut instanceof HTMLElement) {
      tdOut.classList.toggle('settings-page__value--loading', pending);
      tdOut.textContent = pending ? '…' : row.output || '—';
    }
    if (tdIngest instanceof HTMLElement) {
      tdIngest.classList.toggle('settings-page__value--loading', pending);
      tdIngest.classList.remove(
        'settings-page__active--yes',
        'settings-page__active--no',
        'settings-page__ingest--na',
      );
      if (pending) {
        tdIngest.textContent = '…';
      } else {
        tdIngest.textContent = row.ingestTest || '—';
        if (row.ingestOk === true) tdIngest.classList.add('settings-page__active--yes');
        else if (row.ingestOk === false) tdIngest.classList.add('settings-page__active--no');
        else tdIngest.classList.add('settings-page__ingest--na');
      }
    }
  }

  fetch('/api/events-finder-status?manifest=1', { cache: 'no-store' })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false || !Array.isArray(data.sources)) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      if (!data.sources.length) {
        loadStatus.textContent = 'No Events bookmarks found in Personal bookmarks.';
        return;
      }
      populateRows(data.sources);
      loadStatus.textContent = 'Checking sources…';
      return fetch('/api/events-finder-status', { cache: 'no-store' });
    })
    .then(async (r) => {
      if (!r) return;
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false || !Array.isArray(data.sources)) {
        throw new Error(data.error || `Live HTTP ${r.status}`);
      }
      for (const src of data.sources) {
        const tr = rowById.get(src.id);
        if (tr) updateSourceRow(tr, src);
      }
      loadStatus.textContent = '';
      loadStatus.hidden = true;
    })
    .catch((e) => {
      loadStatus.className = 'settings-page__err';
      loadStatus.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    });

  function reloadSources() {
    loadStatus.hidden = false;
    loadStatus.className = 'settings-page__load-status';
    loadStatus.textContent = 'Reloading Events sources…';
    tbody.replaceChildren();
    rowById.clear();
    fetch('/api/events-finder-status?manifest=1', { cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.ok === false || !Array.isArray(data.sources)) {
          throw new Error(data.error || `HTTP ${r.status}`);
        }
        populateRows(data.sources);
        loadStatus.textContent = 'Checking sources…';
        return fetch('/api/events-finder-status?fresh=1', { cache: 'no-store' });
      })
      .then(async (r) => {
        if (!r) return;
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.ok === false || !Array.isArray(data.sources)) {
          throw new Error(data.error || `Live HTTP ${r.status}`);
        }
        for (const src of data.sources) {
          const tr = rowById.get(src.id);
          if (tr) updateSourceRow(tr, src);
        }
        loadStatus.textContent = '';
        loadStatus.hidden = true;
      })
      .catch((e) => {
        loadStatus.className = 'settings-page__err';
        loadStatus.textContent =
          e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      });
  }
}

/**
 * Focused editor modal for the Gmail Daily Summary markdown filter.
 * Same guide as the inline Daily Summary editor, in a larger dedicated surface.
 */
function openGmailFilterGuideModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'settings-page__modal-backdrop';
  backdrop.setAttribute('role', 'presentation');

  const modal = document.createElement('div');
  modal.className = 'settings-page__modal settings-page__modal--gmail-filter';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'settings-gmail-filter-title');

  const header = document.createElement('div');
  header.className = 'settings-page__modal-header';
  const title = document.createElement('h3');
  title.id = 'settings-gmail-filter-title';
  title.className = 'settings-page__modal-title';
  title.textContent = 'Gmail email filter (markdown)';
  const hint = document.createElement('p');
  hint.className = 'settings-page__modal-hint';
  hint.textContent =
    'Markdown guide that decides which intake mail becomes Daily Summary action items. Same guide as data/gmail-daily-summary-guide.md.';
  header.append(title, hint);

  const body = document.createElement('div');
  body.className = 'settings-page__modal-scroll';

  const guideArea = document.createElement('textarea');
  guideArea.className = 'settings-page__modal-textarea settings-page__modal-textarea--guide';
  guideArea.rows = 24;
  guideArea.spellcheck = true;
  guideArea.placeholder = 'Loading…';
  guideArea.disabled = true;
  body.append(guideArea);

  const footer = document.createElement('div');
  footer.className = 'settings-page__modal-footer';
  const msg = document.createElement('p');
  msg.className = 'settings-page__rain-msg';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');
  const actions = document.createElement('div');
  actions.className = 'settings-page__modal-actions settings-page__modal-actions--footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'settings-page__secondary-cancel';
  cancelBtn.textContent = 'Close';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-page__rain-save';
  saveBtn.textContent = 'Save filter';
  saveBtn.disabled = true;
  actions.append(cancelBtn, saveBtn);
  footer.append(msg, actions);

  modal.append(header, body, footer);
  backdrop.append(modal);
  document.body.append(backdrop);

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  fetch('/api/gmail-daily-summary/guide', { cache: 'no-store' })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      guideArea.value = String(j.guide || '');
      guideArea.disabled = false;
      guideArea.placeholder = '';
      saveBtn.disabled = false;
      guideArea.focus();
    })
    .catch((e) => {
      msg.hidden = false;
      msg.classList.add('settings-page__rain-msg--err');
      msg.textContent = String(e?.message || e);
    });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    msg.hidden = false;
    msg.classList.remove('settings-page__rain-msg--err');
    msg.textContent = 'Saving…';
    try {
      const r = await fetch('/api/gmail-daily-summary/guide', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guide: guideArea.value }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      guideArea.value = String(j.guide || guideArea.value);
      close();
    } catch (e) {
      msg.classList.add('settings-page__rain-msg--err');
      msg.textContent = String(e?.message || e);
      saveBtn.disabled = false;
    }
  });
}

/**
 * Daily Summary email ingestion guide (markdown).
 * @param {HTMLElement} root
 */
function buildGmailWeeklySummaryBlock(root) {
  const { details: block, body } = createCollapsibleSection({
    title: 'Daily Summary',
    headingId: 'settings-daily-summary-heading',
    className: 'settings-page__daily-summary-block',
  });

  const intro = document.createElement('p');
  intro.className = 'settings-page__intro';
  intro.textContent =
    'Markdown guide for what intake mail becomes action items (intake + your-gmail). Scans every 30 minutes. Rolling 10-day window — older items delete unless pinned. 👍 appends to Prefer more; 👎 always Prefer less (3× similar → Soft skip, 5× → Never show). Never show / Soft skip / Prefer less are also enforced in code (not LLM-only). Template: docs/gmail-daily-summary-guide.md · live: data/gmail-daily-summary-guide.md';
  body.append(intro);

  const guideLabel = document.createElement('label');
  guideLabel.className = 'settings-page__modal-field-label';
  guideLabel.htmlFor = 'settings-daily-summary-guide';
  guideLabel.textContent = 'Ingestion guide (markdown)';
  const guideArea = document.createElement('textarea');
  guideArea.id = 'settings-daily-summary-guide';
  guideArea.className = 'settings-page__modal-textarea settings-page__modal-textarea--guide';
  guideArea.rows = 22;
  guideArea.spellcheck = true;

  const actions = document.createElement('div');
  actions.className = 'settings-page__events-toolbar';
  const openFilterBtn = document.createElement('button');
  openFilterBtn.type = 'button';
  openFilterBtn.className = 'settings-page__rain-save';
  openFilterBtn.textContent = 'Open email filter';
  openFilterBtn.title = 'Open the Gmail markdown filter in a focused editor';
  openFilterBtn.addEventListener('click', () => openGmailFilterGuideModal());
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-page__rain-save';
  saveBtn.textContent = 'Save guide';
  const status = document.createElement('p');
  status.className = 'settings-page__load-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Loading…';

  actions.append(openFilterBtn, saveBtn);
  body.append(guideLabel, guideArea, actions, status);
  root.append(block);

  async function load() {
    status.className = 'settings-page__load-status';
    status.textContent = 'Loading…';
    try {
      const r = await fetch('/api/gmail-daily-summary/guide', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      guideArea.value = String(j.guide || '');
      status.textContent = '';
      status.hidden = true;
    } catch (e) {
      status.hidden = false;
      status.className = 'settings-page__err';
      status.textContent = String(e?.message || e);
    }
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    status.hidden = false;
    status.className = 'settings-page__load-status';
    status.textContent = 'Saving…';
    try {
      const r = await fetch('/api/gmail-daily-summary/guide', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guide: guideArea.value }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      guideArea.value = String(j.guide || guideArea.value);
      status.className = 'settings-page__load-status';
      status.textContent = 'Saved.';
    } catch (e) {
      status.className = 'settings-page__err';
      status.textContent = String(e?.message || e);
    } finally {
      saveBtn.disabled = false;
    }
  });

  void load();
}

const NOTABLE_LEAD_WEEK_OPTIONS = [
  { value: '2', label: '2 weeks before' },
  { value: '3', label: '3 weeks before' },
  { value: '4', label: '4 weeks before (default)' },
  { value: '6', label: '6 weeks before' },
  { value: '8', label: '8 weeks before' },
  { value: '12', label: '12 weeks before' },
];

/**
 * Per-notable-event reminder lead time — how far ahead a flagged event stays
 * pinned near the top of the Events feed.
 * @param {HTMLElement} root
 */
function buildBigEventsRemindersBlock(root) {
  const { details: block, body } = createCollapsibleSection({
    title: 'Notable event reminders',
    headingId: 'settings-notable-events-heading',
    className: 'settings-page__big-events-block',
  });

  const intro = document.createElement('p');
  intro.className = 'settings-page__intro';
  intro.textContent =
    'Events you mark Notable in the Events feed. Choose how many weeks ahead each one should stay highlighted. Edit early bird / travel details on the event card.';
  body.append(intro);

  const loadStatus = document.createElement('p');
  loadStatus.className = 'settings-page__load-status';
  loadStatus.setAttribute('aria-live', 'polite');
  loadStatus.textContent = 'Loading notable events…';
  body.append(loadStatus);

  const table = document.createElement('table');
  table.className = 'settings-page__table settings-page__table--big-events';
  table.setAttribute('aria-labelledby', 'settings-notable-events-heading');
  table.hidden = true;

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of ['Event', 'When', 'Remind ahead']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);
  const tbody = document.createElement('tbody');
  table.append(tbody);
  body.append(table);

  root.append(block);

  /**
   * @param {HTMLSelectElement} select
   * @param {number | null} leadWeeks
   */
  function fillLeadOptions(select, leadWeeks) {
    select.replaceChildren();
    const value = leadWeeks == null ? '4' : String(leadWeeks);
    const known = NOTABLE_LEAD_WEEK_OPTIONS.some((o) => o.value === value);
    const options = known
      ? NOTABLE_LEAD_WEEK_OPTIONS
      : [...NOTABLE_LEAD_WEEK_OPTIONS, { value, label: `${leadWeeks} weeks before` }];
    for (const opt of options) {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      if (opt.value === value) el.selected = true;
      select.append(el);
    }
  }

  /**
   * @param {Array<object>} items
   */
  function populate(items) {
    tbody.replaceChildren();
    for (const item of items) {
      const eventId = String(item.eventId || '').trim();
      if (!eventId) continue;
      const ev = item.event || {};
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.className = 'settings-page__type-label';
      tdName.textContent = String(ev.title || eventId);

      const tdWhen = document.createElement('td');
      tdWhen.className = 'settings-page__value';
      tdWhen.textContent = ev.start
        ? new Date(ev.start).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })
        : 'Date TBD';

      const tdLead = document.createElement('td');
      tdLead.className = 'settings-page__big-events-lead';
      const select = document.createElement('select');
      select.className = 'settings-page__costs-select';
      select.setAttribute('aria-label', `Reminder lead time for ${ev.title || eventId}`);
      fillLeadOptions(
        select,
        item.reminderLeadWeeks == null ? 4 : Number(item.reminderLeadWeeks),
      );
      const savedNote = document.createElement('span');
      savedNote.className = 'settings-page__big-events-saved';
      savedNote.hidden = true;
      savedNote.setAttribute('aria-live', 'polite');

      select.addEventListener('change', async () => {
        const reminderLeadWeeks = Number(select.value) || 4;
        select.disabled = true;
        savedNote.hidden = false;
        savedNote.classList.remove('settings-page__err');
        savedNote.textContent = 'Saving…';
        try {
          const r = await fetch(
            `/api/events-finder/notable/${encodeURIComponent(eventId)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ notable: true, reminderLeadWeeks }),
            },
          );
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
          const next =
            j.item?.reminderLeadWeeks == null ? 4 : Number(j.item.reminderLeadWeeks);
          fillLeadOptions(select, next);
          savedNote.textContent = 'Saved';
          setTimeout(() => {
            if (savedNote.textContent === 'Saved') savedNote.hidden = true;
          }, 1800);
        } catch (e) {
          savedNote.classList.add('settings-page__err');
          savedNote.textContent = String(e?.message || e);
        } finally {
          select.disabled = false;
        }
      });

      tdLead.append(select, savedNote);
      tr.append(tdName, tdWhen, tdLead);
      tbody.append(tr);
    }
  }

  fetch('/api/events-finder/notable', { cache: 'no-store' })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false || !Array.isArray(data.items)) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      if (!data.items.length) {
        loadStatus.textContent =
          'No notable events yet — check “Notable event” on a card in the Events panel.';
        return;
      }
      populate(data.items);
      table.hidden = false;
      loadStatus.hidden = true;
      loadStatus.textContent = '';
    })
    .catch((e) => {
      loadStatus.className = 'settings-page__err';
      loadStatus.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    });
}

/**
 * @param {HTMLElement | null} mount
 */
export async function mountSettingsPage(mount) {
  if (!mount) return;

  const { tbodyByGroup, status } = buildSettingsShell(mount, WINDOW_HOURS);
  buildAwayBaseBlock(mount);
  buildSecondaryWatchBlock(mount);
  buildEventsFinderSourcesBlock(mount);
  buildGmailWeeklySummaryBlock(mount);
  buildBigEventsRemindersBlock(mount);
  buildCostsBlock(mount);
  mount.setAttribute('aria-busy', 'true');

  /** @type {Map<string, HTMLTableRowElement>} */
  let rowById = new Map();
  let pendingParts = 4;
  let failedParts = 0;

  function refreshStatus() {
    if (pendingParts > 0) {
      status.textContent = `Loading live values (${4 - pendingParts}/4 ready)…`;
    } else if (failedParts > 0) {
      status.textContent = `Finished with ${failedParts} source(s) failed.`;
    } else {
      status.textContent = '';
      status.hidden = true;
    }
  }

  function partDone() {
    pendingParts -= 1;
    refreshStatus();
    if (pendingParts <= 0) {
      mount.removeAttribute('aria-busy');
    }
  }

  function markPartFailed(ids) {
    failedParts += 1;
    for (const id of ids) {
      const tr = rowById.get(id);
      if (!tr) continue;
      updateEventRow(tr, {
        active: false,
        value: 'Could not load',
        pending: false,
      });
    }
  }

  function startLiveFetches(rowMap) {
    const skyIds = [...rowMap.keys()].filter((id) => rowMap.get(id)?.dataset.category === 'Sky & space');
    const earthCoreIds = [
      'yosemite_moonbow',
      'usa_npn_spring',
      'monarch_spring',
      'monarch_fall',
      'diablo_tarantula',
      'oakland_salamander',
      'wild_edible',
      'salmon_run',
      'nasturtium_bloom',
      'firefly_season',
      'fall_foliage_season',
    ];
    const slowIds = ['usgs_quake_week', 'goes_glm_lightning', 'goes_glm_sprite'];
    const serviceIds = ['fear_greed_index', 'weather_radar'];

    fetchEventTypesPart('sky', WINDOW_HOURS)
      .then((data) => applyTypeUpdates(rowMap, data.types))
      .catch(() => markPartFailed(skyIds))
      .finally(partDone);

    fetchEventTypesPart('earth', WINDOW_HOURS)
      .then((data) => applyTypeUpdates(rowMap, data.types))
      .catch(() => markPartFailed(earthCoreIds))
      .finally(partDone);

    fetchEventTypesPart('slow', WINDOW_HOURS)
      .then((data) => applyTypeUpdates(rowMap, data.types))
      .catch(() => markPartFailed(slowIds))
      .finally(partDone);

    fetchEventTypesPart('services', WINDOW_HOURS)
      .then((data) => applyTypeUpdates(rowMap, data.types))
      .catch(() => markPartFailed(serviceIds))
      .finally(partDone);
  }

  fetch('/api/event-types-status?manifest=1', { cache: 'no-store' })
    .then(async (manifestR) => {
      const manifest = await manifestR.json().catch(() => ({}));
      if (!manifestR.ok || manifest.ok === false || !Array.isArray(manifest.types)) {
        throw new Error(manifest.error || `Manifest HTTP ${manifestR.status}`);
      }
      rowById = populatePendingRows(tbodyByGroup, manifest.types);
      refreshStatus();
      startLiveFetches(rowById);
    })
    .catch((e) => {
      mount.removeAttribute('aria-busy');
      status.className = 'settings-page__err';
      status.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    });
}
