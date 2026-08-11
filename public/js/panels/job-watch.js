import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';
import { locationRegion, locationRegions } from '../lib/job-location-region.js';

const REFRESH_MS = 5 * 60 * 1000;
const CACHE_KEY = 'job-watch';
const CACHE_MAX_MS = 30 * 60 * 1000;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Solid grey crystal — target not posted.
 * @returns {SVGSVGElement}
 */
function iconGrey() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('class', 'job-watch__icon job-watch__icon--closed');
  svg.setAttribute('aria-hidden', 'true');

  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M5 1.8h6l3 4.4-6 8.1-6-8.1 3-4.4z');
  body.setAttribute('class', 'job-watch__crystal-body');
  svg.append(body);

  const facets = document.createElementNS(SVG_NS, 'path');
  facets.setAttribute('d', 'M2 6.2h12M5 1.8l1.6 4.4L8 14.3l1.4-8.1L11 1.8');
  facets.setAttribute('class', 'job-watch__crystal-facet');
  svg.append(facets);

  return svg;
}

/**
 * Green dopamine-style sparkle star — target is open.
 * @returns {HTMLElement}
 */
function iconGreenStar() {
  const wrap = document.createElement('span');
  wrap.className = 'job-watch__star job-watch__star--green';
  wrap.setAttribute('aria-hidden', 'true');

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('class', 'job-watch__star-svg');

  const star = document.createElementNS(SVG_NS, 'path');
  star.setAttribute(
    'd',
    'M12 2.6l2.4 5.3 5.8.6-4.4 3.8 1.3 5.7L12 15.2 6.9 18l1.3-5.7L3.8 8.5l5.8-.6L12 2.6z',
  );
  star.setAttribute('class', 'job-watch__star-path');
  svg.append(star);

  // Sparkle ticks
  for (const [x, y] of [
    [3, 4],
    [20, 5],
    [19, 18],
  ]) {
    const tick = document.createElementNS(SVG_NS, 'path');
    tick.setAttribute('d', `M${x} ${y - 1.4} V${y + 1.4} M${x - 1.4} ${y} H${x + 1.4}`);
    tick.setAttribute('class', 'job-watch__star-spark');
    tick.setAttribute('stroke-width', '1.2');
    tick.setAttribute('stroke-linecap', 'round');
    svg.append(tick);
  }

  wrap.append(svg);
  return wrap;
}

/**
 * Yellow review dot — unreviewed candidate.
 * @returns {HTMLElement}
 */
function iconYellowDot() {
  const span = document.createElement('span');
  span.className = 'job-watch__dot job-watch__dot--yellow';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

/**
 * @param {object | null} compensation
 * @returns {string | null}
 */
function amountText(compensation) {
  const display = compensation?.display;
  return typeof display === 'string' && display.trim() ? display.trim() : null;
}

/**
 * 1–3 star match rating — only filled stars, no empty outlines.
 * @param {{ stars?: number, kind?: string }} opts
 * @returns {HTMLElement}
 */
function matchStarsNode({ stars = 0, kind = 'live' } = {}) {
  const n = Math.max(0, Math.min(3, Math.round(Number(stars) || 0)));
  const wrap = document.createElement('span');
  wrap.className = `job-watch__match-stars job-watch__match-stars--${kind === 'expected' ? 'expected' : 'live'}`;
  wrap.setAttribute('aria-label', `${n} of 3 match stars${kind === 'expected' ? ' expected' : ''}`);
  wrap.title =
    kind === 'expected'
      ? `Expected fit when posted: ${n}/3`
      : `Match rating: ${n}/3`;

  for (let i = 0; i < n; i += 1) {
    const s = document.createElement('span');
    s.className = 'job-watch__match-star job-watch__match-star--on';
    s.textContent = '★';
    s.setAttribute('aria-hidden', 'true');
    wrap.append(s);
  }
  return wrap;
}

/**
 * Title that opens the posting when there is a live URL to open.
 * @param {{ url?: string, label: string }} opts
 * @returns {HTMLElement}
 */
function titleNode({ url, label }) {
  const node = document.createElement(url ? 'a' : 'span');
  node.className = 'job-watch__label';
  node.textContent = label;
  if (url) {
    /** @type {HTMLAnchorElement} */ (node).href = url;
    /** @type {HTMLAnchorElement} */ (node).target = '_blank';
    /** @type {HTMLAnchorElement} */ (node).rel = 'noopener noreferrer';
  }
  return node;
}

/**
 * @param {object} assessment
 */
function fitLabel(assessment) {
  const close = assessment?.closeFit || 'none';
  const verdict = assessment?.verdict || 'pass';
  if (verdict === 'burn' && close === 'strong') return 'Strong fit — consider applying';
  if (verdict === 'canary') return 'Canary / leadership signal — do not apply yet';
  if (verdict === 'maybe') return 'Partial fit — review JD before burning cooldown';
  if (verdict === 'pass') return 'Not a fit — pass';
  return 'Needs review';
}

/**
 * @param {object} candidate
 * @param {() => void} onDone
 */
function openFitModal(candidate, onDone) {
  const a = candidate.assessment || {};
  const backdrop = document.createElement('div');
  backdrop.className = 'events-finder__modal-backdrop job-watch__modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'events-finder__modal job-watch__modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Opportunity fit recommendation');

  const title = document.createElement('h3');
  title.className = 'events-finder__modal-title';
  title.textContent = candidate.title || 'Role';

  const meta = document.createElement('p');
  meta.className = 'events-finder__modal-hint';
  const bits = [];
  if (candidate.type) bits.push(candidate.type);
  const amount = amountText(candidate.compensation);
  if (amount) bits.push(amount);
  if (candidate.location) bits.push(candidate.location);
  const stars = Number(candidate.matchStars ?? 0);
  if (stars > 0) bits.push(`${stars}/3 stars`);
  if (a.verdict) bits.push(`verdict: ${a.verdict}`);
  if (Number.isFinite(a.score)) bits.push(`score ${a.score}/10`);
  if (a.closeFit) bits.push(`close-fit: ${a.closeFit}`);
  meta.textContent = bits.join(' · ') || 'Fit assessment';

  const verdict = document.createElement('p');
  verdict.className = 'job-watch__modal-verdict';
  verdict.textContent = fitLabel(a);

  const starLine = document.createElement('p');
  starLine.className = 'job-watch__modal-stars';
  if (stars > 0) starLine.append(matchStarsNode({ stars, kind: 'live' }));

  const body = document.createElement('p');
  body.className = 'job-watch__modal-body';
  body.textContent = a.recommendation || 'No recommendation text yet.';

  const head = [title, meta, verdict];
  if (stars > 0) head.push(starLine);
  head.push(body);

  if (Array.isArray(a.reasons) && a.reasons.length) {
    const ul = document.createElement('ul');
    ul.className = 'job-watch__modal-reasons';
    for (const r of a.reasons) {
      const li = document.createElement('li');
      li.textContent = r;
      ul.append(li);
    }
    modal.append(...head, ul);
  } else {
    modal.append(...head);
  }

  const actions = document.createElement('div');
  actions.className = 'events-finder__modal-actions';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'events-finder__modal-btn';
  closeBtn.textContent = 'Close';

  const link = document.createElement('a');
  link.className = 'events-finder__modal-btn job-watch__modal-link';
  link.href = candidate.url || '#';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Open posting';

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'events-finder__modal-btn';
  dismissBtn.textContent = 'Dismiss';

  actions.append(closeBtn, link, dismissBtn);
  modal.append(actions);
  backdrop.append(modal);
  document.body.append(backdrop);

  const cleanup = () => {
    backdrop.remove();
    onDone?.();
  };

  closeBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/job-watch/candidates/${encodeURIComponent(candidate.id)}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
      /* ignore */
    }
    cleanup();
  });

  dismissBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/job-watch/candidates/${encodeURIComponent(candidate.id)}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
      /* ignore */
    }
    cleanup();
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeBtn.click();
  });
}

/**
 * @param {unknown} priority
 * @returns {string}
 */
function priorityLabel(priority) {
  if (priority === 1 || priority === '1') return 'P1';
  if (priority === 2 || priority === '2') return 'P2';
  if (priority === 'queued') return 'Queued';
  return 'Watch';
}

const FILTER_STORAGE_KEY = 'job-watch-filters-v4';

/** Reset on every Dashbird page load — only show NYC + Bay Area postings. */
const DEFAULT_LOCATION_REGIONS = Object.freeze(['Bay Area', 'NYC Area']);

/** Work-mode labels must not live in the geography checkbox list. */
function isRemoteModeLabel(value) {
  const s = String(value || '');
  return /^(in-house only|remote TBD|\d{1,3}% remote|100% remote)$/i.test(s);
}

/**
 * @returns {{
 *   sources: Set<string> | null,
 *   status: 'all' | 'open' | 'closed',
 *   minStars: 0 | 1 | 2 | 3,
 *   locations: Set<string> | null,
 *   remoteModes: Set<string> | null,
 * }}
 */
function loadFilters() {
  const defaults = {
    sources: /** @type {Set<string> | null} */ (null),
    status: /** @type {'all' | 'open' | 'closed'} */ ('all'),
    minStars: /** @type {0 | 1 | 2 | 3} */ (0),
    locations: new Set(DEFAULT_LOCATION_REGIONS),
    remoteModes: /** @type {Set<string> | null} */ (null),
  };
  try {
    const legacyV2 = localStorage.getItem('job-watch-filters-v2');
    const legacyV1 = localStorage.getItem('job-watch-source-filters');
    const raw =
      localStorage.getItem(FILTER_STORAGE_KEY)
      || legacyV2
      || (legacyV1 ? JSON.stringify({ sources: JSON.parse(legacyV1) }) : '');
    if (!raw) return defaults;
    const o = JSON.parse(raw);
    const sources = Array.isArray(o.sources) && o.sources.length ? new Set(o.sources.map(String)) : null;
    const fromLocRemote = Array.isArray(o.locations)
      ? o.locations.map(String).filter((x) => isRemoteModeLabel(x))
      : [];
    const rawRemote = Array.isArray(o.remoteModes) ? o.remoteModes.map(String) : fromLocRemote;
    const remoteModes = rawRemote.length ? new Set(rawRemote) : null;
    const status = o.status === 'open' || o.status === 'closed' ? o.status : 'all';
    const minStars = [0, 1, 2, 3].includes(Number(o.minStars)) ? /** @type {0|1|2|3} */ (Number(o.minStars)) : 0;
    // Region always resets to Bay Area + NYC on reload (ignore saved locations).
    return { sources, status, minStars, locations: new Set(DEFAULT_LOCATION_REGIONS), remoteModes };
  } catch {
    return defaults;
  }
}

/**
 * @param {ReturnType<typeof loadFilters>} filters
 */
function saveFilters(filters) {
  try {
    const payload = {
      sources: filters.sources ? [...filters.sources] : null,
      status: filters.status,
      minStars: filters.minStars,
      locations: filters.locations ? [...filters.locations] : null,
      remoteModes: filters.remoteModes ? [...filters.remoteModes] : null,
    };
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(payload));
    localStorage.removeItem('job-watch-filters-v2');
    localStorage.removeItem('job-watch-source-filters');
  } catch {
    /* ignore */
  }
}

/**
 * @param {HTMLElement | null} root
 */
export function mountJobWatch(root) {
  if (!root) return;

  const shell = document.createElement('div');
  shell.className = 'job-watch';

  const toolbar = document.createElement('div');
  toolbar.className = 'job-watch__toolbar';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'job-watch__toggle';
  toggleBtn.setAttribute('aria-controls', 'job-watch-filters');
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.setAttribute('aria-label', 'Browse filters');
  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'job-watch__toggle-label';
  toggleLabel.textContent = 'Filters';
  const toggleArrow = document.createElement('span');
  toggleArrow.className = 'job-watch__toggle-arrow';
  toggleArrow.setAttribute('aria-hidden', 'true');
  toggleBtn.append(toggleLabel, toggleArrow);
  toolbar.append(toggleBtn);

  const filterPanel = document.createElement('div');
  filterPanel.id = 'job-watch-filters';
  filterPanel.className = 'job-watch__filters';
  filterPanel.hidden = true;

  const scanMeta = document.createElement('p');
  scanMeta.className = 'muted job-watch__scan-meta';
  scanMeta.textContent = 'Loading…';

  const companiesLabel = document.createElement('p');
  companiesLabel.className = 'job-watch__filter-label';
  companiesLabel.textContent = 'Companies';
  const companyChecks = document.createElement('div');
  companyChecks.className = 'job-watch__checkboxes';

  const statusLabel = document.createElement('p');
  statusLabel.className = 'job-watch__filter-label';
  statusLabel.textContent = 'Posted';
  const statusRow = document.createElement('div');
  statusRow.className = 'job-watch__checkboxes job-watch__checkboxes--radio';

  const starsLabel = document.createElement('p');
  starsLabel.className = 'job-watch__filter-label';
  starsLabel.textContent = 'Match stars';
  const starsRow = document.createElement('div');
  starsRow.className = 'job-watch__checkboxes job-watch__checkboxes--radio';

  const locationsLabel = document.createElement('p');
  locationsLabel.className = 'job-watch__filter-label';
  locationsLabel.textContent = 'Region';
  const locationChecks = document.createElement('div');
  locationChecks.className = 'job-watch__checkboxes job-watch__checkboxes--locations';

  const remoteLabel = document.createElement('p');
  remoteLabel.className = 'job-watch__filter-label';
  remoteLabel.textContent = 'Remote style';
  const remoteChecks = document.createElement('div');
  remoteChecks.className = 'job-watch__checkboxes';

  filterPanel.append(
    scanMeta,
    companiesLabel,
    companyChecks,
    statusLabel,
    statusRow,
    starsLabel,
    starsRow,
    locationsLabel,
    locationChecks,
    remoteLabel,
    remoteChecks,
  );

  const list = document.createElement('ul');
  list.className = 'job-watch__list';

  const candLabel = document.createElement('p');
  candLabel.className = 'job-watch__section-label';
  candLabel.textContent = 'New / possible fits';
  candLabel.hidden = true;

  const candList = document.createElement('ul');
  candList.className = 'job-watch__list job-watch__list--candidates';

  // Hidden scan trigger — header icon (#job-watch-scan) clicks this.
  const scanBtn = document.createElement('button');
  scanBtn.type = 'button';
  scanBtn.className = 'job-watch__scan-btn';
  scanBtn.hidden = true;
  scanBtn.setAttribute('aria-hidden', 'true');
  scanBtn.textContent = 'Scan now';

  shell.append(toolbar, filterPanel, list, candLabel, candList, scanBtn);
  root.replaceChildren(shell);

  /** @type {object | null} */
  let latest = null;
  let filters = loadFilters();
  let busy = false;
  let timer = null;
  /** @type {string} */
  let companyFilterSig = '';
  /** @type {string} */
  let locationFilterSig = '';
  /** @type {string} */
  let remoteFilterSig = '';
  let staticFiltersReady = false;

  toggleBtn.addEventListener('click', () => {
    const open = filterPanel.hidden;
    filterPanel.hidden = !open;
    toggleBtn.classList.toggle('job-watch__toggle--open', open);
    toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  function persistAndRepaint() {
    saveFilters(filters);
    if (latest) paint(latest);
  }

  /**
   * @param {HTMLElement} row
   * @param {Array<{ value: string, label: string }>} options
   * @param {string} name
   * @param {string} current
   * @param {(value: string) => void} onChange
   */
  function paintRadioRow(row, options, name, current, onChange) {
    row.replaceChildren();
    for (const opt of options) {
      const label = document.createElement('label');
      label.className = 'job-watch__check';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.value = opt.value;
      input.checked = current === opt.value;
      input.addEventListener('change', () => {
        if (input.checked) onChange(opt.value);
      });
      const text = document.createElement('span');
      text.textContent = opt.label;
      label.append(input, text);
      row.append(label);
    }
  }

  function ensureStaticFilters() {
    if (staticFiltersReady) return;
    staticFiltersReady = true;
    paintRadioRow(
      statusRow,
      [
        { value: 'all', label: 'All' },
        { value: 'open', label: 'Posted' },
        { value: 'closed', label: 'Not posted' },
      ],
      'job-watch-status',
      filters.status,
      (value) => {
        filters.status = /** @type {'all'|'open'|'closed'} */ (value);
        persistAndRepaint();
      },
    );
    paintRadioRow(
      starsRow,
      [
        { value: '0', label: 'Any' },
        { value: '3', label: '★★★' },
        { value: '2', label: '★★+' },
        { value: '1', label: '★+' },
      ],
      'job-watch-stars',
      String(filters.minStars),
      (value) => {
        filters.minStars = /** @type {0|1|2|3} */ (Number(value));
        persistAndRepaint();
      },
    );
  }

  /**
   * @param {object[]} sources
   */
  function paintCompanyFilters(sources) {
    const allIds = sources.map((s) => String(s.id));
    const sig = allIds.join('|');
    if (filters.sources) {
      filters.sources = new Set([...filters.sources].filter((id) => allIds.includes(id)));
      // Empty set means match nothing — do not coerce back to "all".
      if (filters.sources.size === allIds.length) filters.sources = null;
    }
    if (sig === companyFilterSig && companyChecks.childElementCount) {
      for (const input of companyChecks.querySelectorAll('input[type="checkbox"]')) {
        if (!(input instanceof HTMLInputElement)) continue;
        input.checked = !filters.sources || filters.sources.has(input.value);
      }
      return;
    }
    companyFilterSig = sig;
    companyChecks.replaceChildren();
    for (const src of sources) {
      const id = String(src.id);
      const label = document.createElement('label');
      label.className = 'job-watch__check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = id;
      input.checked = !filters.sources || filters.sources.has(id);
      input.addEventListener('change', () => {
        const checked = [...companyChecks.querySelectorAll('input[type="checkbox"]')]
          .filter((el) => el instanceof HTMLInputElement && el.checked)
          .map((el) => /** @type {HTMLInputElement} */ (el).value);
        filters.sources = checked.length === allIds.length ? null : new Set(checked);
        persistAndRepaint();
      });
      const text = document.createElement('span');
      text.textContent = src.label || id;
      label.append(input, text);
      companyChecks.append(label);
    }
  }

  /**
   * @param {HTMLElement} rootEl
   * @param {string[]} options
   * @param {Set<string> | null} selected
   * @param {string} sigRefKey
   * @param {(next: Set<string> | null) => void} onChange
   * @param {string} emptyText
   */
  function paintCheckboxGroup(rootEl, options, selected, sigRefKey, onChange, emptyText) {
    const all = [...options].sort((a, b) => a.localeCompare(b));
    const sig = all.join('|');
    let nextSelected = selected;
    if (nextSelected) {
      nextSelected = new Set([...nextSelected].filter((id) => all.includes(id)));
      // Location: never collapse "all checked" to null — that would unfilter
      // DC/Denver/etc. the moment a new metro appears. Remote/other groups
      // still treat a full selection as "no filter".
      if (sigRefKey !== 'location' && nextSelected.size === all.length) nextSelected = null;
    }
    if (sigRefKey === 'location') {
      filters.locations = nextSelected;
      if (sig === locationFilterSig && rootEl.childElementCount) {
        for (const input of rootEl.querySelectorAll('input[type="checkbox"]')) {
          if (!(input instanceof HTMLInputElement)) continue;
          input.checked = !filters.locations || filters.locations.has(input.value);
        }
        return;
      }
      locationFilterSig = sig;
    } else {
      filters.remoteModes = nextSelected;
      if (sig === remoteFilterSig && rootEl.childElementCount) {
        for (const input of rootEl.querySelectorAll('input[type="checkbox"]')) {
          if (!(input instanceof HTMLInputElement)) continue;
          input.checked = !filters.remoteModes || filters.remoteModes.has(input.value);
        }
        return;
      }
      remoteFilterSig = sig;
    }

    rootEl.replaceChildren();
    if (!all.length) {
      const empty = document.createElement('span');
      empty.className = 'muted job-watch__sub';
      empty.textContent = emptyText;
      rootEl.append(empty);
      return;
    }
    for (const opt of all) {
      const label = document.createElement('label');
      label.className = 'job-watch__check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = opt;
      const active = sigRefKey === 'location' ? filters.locations : filters.remoteModes;
      input.checked = !active || active.has(opt);
      input.addEventListener('change', () => {
        const checked = [...rootEl.querySelectorAll('input[type="checkbox"]')]
          .filter((el) => el instanceof HTMLInputElement && el.checked)
          .map((el) => /** @type {HTMLInputElement} */ (el).value);
        const allChecked = checked.length === all.length;
        onChange(
          allChecked && sigRefKey !== 'location'
            ? null
            : new Set(checked),
        );
      });
      const text = document.createElement('span');
      text.textContent = opt;
      label.append(input, text);
      rootEl.append(label);
    }
  }

  /**
   * @param {string[]} locations
   */
  function paintLocationFilters(locations) {
    const geo = [
      ...DEFAULT_LOCATION_REGIONS,
      ...locations.filter((x) => !isRemoteModeLabel(x)),
    ];
    paintCheckboxGroup(
      locationChecks,
      geo,
      filters.locations,
      'location',
      (next) => {
        filters.locations = next;
        persistAndRepaint();
      },
      'No locations yet — scan open roles',
    );
  }

  /**
   * @param {string[]} modes
   */
  function paintRemoteFilters(modes) {
    paintCheckboxGroup(
      remoteChecks,
      modes,
      filters.remoteModes,
      'remote',
      (next) => {
        filters.remoteModes = next;
        persistAndRepaint();
      },
      'No remote styles yet',
    );
  }

  /**
   * @param {{ source?: string, sourceId?: string, status?: string, matchStars?: number, locations?: string[], workMode?: { label?: string } | null }} item
   * @param {'target' | 'candidate'} kind
   */
  function passesFilters(item, kind) {
    const sourceId = String(item.source || item.sourceId || 'anthropic');
    if (filters.sources && !filters.sources.has(sourceId)) return false;

    const open = kind === 'candidate' || item.status === 'open';
    if (filters.status === 'open' && !open) return false;
    if (filters.status === 'closed' && open) return false;

    const stars = Number(item.matchStars || 0);
    if (stars < filters.minStars) return false;

    // Geography and remote style are separate AND groups.
    if (filters.locations) {
      const regions = locationRegions(
        Array.isArray(item.locations) ? item.locations : [],
        isRemoteModeLabel,
      );
      const hit = [...filters.locations].some((want) =>
        regions.some((have) => have.toLowerCase() === String(want).toLowerCase()),
      );
      if (!hit) return false;
    }
    if (filters.remoteModes) {
      const modeLabel = String(item.workMode?.label || '');
      const hit = [...filters.remoteModes].some(
        (want) => modeLabel.toLowerCase() === String(want).toLowerCase(),
      );
      if (!hit) return false;
    }
    return true;
  }

  /**
   * @param {object} item
   * @returns {string}
   */
  function workModeText(item) {
    return item?.workMode?.label || '';
  }

  /**
   * @param {object} data
   */
  function paint(data) {
    latest = data;
    list.replaceChildren();
    candList.replaceChildren();
    ensureStaticFilters();

    const sources = Array.isArray(data?.sources) ? data.sources : [];
    if (sources.length) paintCompanyFilters(sources);

    const when = data?.lastScanAt ? new Date(data.lastScanAt) : null;
    const whenTxt =
      when && !Number.isNaN(when.getTime())
        ? when.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        : '—';
    const sourceNames = sources.map((s) => s.label || s.id).filter(Boolean);
    const who = sourceNames.length ? sourceNames.join(' · ') : 'Anthropic';
    scanMeta.textContent = data?.lastScanError
      ? `${who} · scanned ${whenTxt} · ${data.lastScanError}`
      : `${who} · scanned ${whenTxt}`;

    const targets = Array.isArray(data?.targets) ? [...data.targets] : [];
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];

    /** @type {Set<string>} */
    const locationUniverse = new Set();
    /** @type {Set<string>} */
    const remoteUniverse = new Set();
    for (const t of targets) {
      for (const loc of t.locations || []) {
        if (isRemoteModeLabel(loc)) remoteUniverse.add(loc);
        else {
          const region = locationRegion(loc);
          if (region) locationUniverse.add(region);
        }
      }
      if (t.workMode?.label) remoteUniverse.add(t.workMode.label);
    }
    for (const c of candidates) {
      for (const loc of c.locations || []) {
        if (isRemoteModeLabel(loc)) remoteUniverse.add(loc);
        else {
          const region = locationRegion(loc);
          if (region) locationUniverse.add(region);
        }
      }
      if (c.workMode?.label) remoteUniverse.add(c.workMode.label);
    }
    paintLocationFilters([...locationUniverse]);
    paintRemoteFilters([...remoteUniverse]);

    targets.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      return 0;
    });

    for (const t of targets) {
      if (!passesFilters(t, 'target')) continue;

      const open = t.status === 'open' && t.job;
      const li = document.createElement('li');
      li.className = 'job-watch__card';
      if (open) li.classList.add('job-watch__card--open');

      const head = document.createElement('div');
      head.className = 'job-watch__card-head';
      head.append(open ? iconGreenStar() : iconGrey());

      const company = document.createElement('span');
      company.className = 'job-watch__company';
      company.textContent = t.sourceLabel || t.source || '—';
      head.append(company);
      head.append(
        matchStarsNode({
          stars: t.matchStars,
          kind: t.matchStarsKind || (open ? 'live' : 'expected'),
        }),
      );

      const titleRow = document.createElement('div');
      titleRow.className = 'job-watch__title-row';
      titleRow.append(titleNode({ url: open ? t.job.url : '', label: t.label }));

      const sub = document.createElement('span');
      sub.className = 'muted job-watch__sub';
      sub.textContent = [priorityLabel(t.priority), t.type, workModeText(t)]
        .filter(Boolean)
        .join(' · ');

      li.append(head, titleRow, sub);

      if (open) {
        const detail = document.createElement('span');
        detail.className = 'job-watch__sub job-watch__detail';
        const amount = amountText(t.compensation);
        if (amount) {
          const money = document.createElement('span');
          money.className = 'job-watch__amount';
          money.textContent = amount;
          detail.append(money);
        } else {
          const none = document.createElement('span');
          none.className = 'muted';
          none.textContent = 'No published range';
          detail.append(none);
        }
        const place = (t.locations || []).filter((l) => !/area$/i.test(l) && !/^remote$/i.test(l));
        const placeTxt = place.length ? place.join(' · ') : t.job.location;
        if (placeTxt) {
          const where = document.createElement('span');
          where.className = 'muted';
          where.textContent = ` · ${placeTxt}`;
          detail.append(where);
        }
        li.append(detail);
      }

      list.append(li);
    }

    const showCands = candidates.filter(
      (c) =>
        passesFilters({ ...c, status: 'open' }, 'candidate')
        && (c.needsReview || c.assessment?.verdict === 'canary'),
    );
    candLabel.hidden = showCands.length === 0;

    for (const c of showCands) {
      const li = document.createElement('li');
      li.className = 'job-watch__card job-watch__card--candidate';
      if (c.needsReview) li.classList.add('job-watch__card--needs-review');

      const head = document.createElement('div');
      head.className = 'job-watch__card-head';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'job-watch__cand-btn';
      btn.setAttribute('aria-label', `Fit recommendation for ${c.title}`);
      btn.title = 'Show fit recommendation';
      btn.append(iconYellowDot());
      btn.addEventListener('click', () => {
        openFitModal(c, () => {
          void refresh({ force: true });
        });
      });
      head.append(btn);

      const company = document.createElement('span');
      company.className = 'job-watch__company';
      company.textContent = c.sourceLabel || c.sourceId || '—';
      head.append(company);
      head.append(matchStarsNode({ stars: c.matchStars, kind: 'live' }));

      const titleRow = document.createElement('div');
      titleRow.className = 'job-watch__title-row';
      titleRow.append(titleNode({ url: c.url, label: c.title }));

      const fit = c.assessment?.closeFit || 'partial';
      const sub = document.createElement('span');
      sub.className = 'muted job-watch__sub';
      sub.textContent = [c.type, workModeText(c), `${fit} fit — tap dot for recommendation`]
        .filter(Boolean)
        .join(' · ');

      const detail = document.createElement('span');
      detail.className = 'job-watch__sub job-watch__detail';
      const amount = amountText(c.compensation);
      if (amount) {
        const money = document.createElement('span');
        money.className = 'job-watch__amount';
        money.textContent = amount;
        detail.append(money);
      }
      const place = (c.locations || []).filter((l) => !/area$/i.test(l) && !/^remote$/i.test(l));
      const placeTxt = place.length ? place.join(' · ') : c.location || 'Location n/a';
      const where = document.createElement('span');
      where.className = 'muted';
      where.textContent = amount ? ` · ${placeTxt}` : placeTxt;
      detail.append(where);

      li.append(head, titleRow, sub, detail);
      candList.append(li);
    }
  }

  /**
   * @param {{ force?: boolean }} [opts]
   */
  async function refresh(opts = {}) {
    if (busy) return;
    busy = true;
    try {
      if (!opts.force) {
        const cached = readPanelCache(CACHE_KEY, CACHE_MAX_MS);
        if (cached?.data) paint(cached.data);
      }
      const res = await fetch('/api/job-watch', { headers: { accept: 'application/json' } });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        scanMeta.textContent = data?.error || `HTTP ${res.status}`;
        return;
      }
      if (data.disabled) {
        scanMeta.textContent = 'Opportunity Watch disabled';
        list.replaceChildren();
        return;
      }
      writePanelCache(CACHE_KEY, data);
      paint(data);
    } catch (e) {
      scanMeta.textContent = e?.message || 'Could not load Opportunity Watch';
    } finally {
      busy = false;
    }
  }

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    scanMeta.textContent = 'Scanning…';
    try {
      const res = await fetch('/api/job-watch/scan', { method: 'POST' });
      const data = await res.json();
      if (data?.ok !== false) {
        writePanelCache(CACHE_KEY, data);
        paint(data);
      } else {
        scanMeta.textContent = data?.error || 'Scan failed';
      }
    } catch (e) {
      scanMeta.textContent = e?.message || 'Scan failed';
    } finally {
      scanBtn.disabled = false;
    }
  });

  void refresh();
  timer = setInterval(() => void refresh(), REFRESH_MS);

  return () => {
    if (timer) clearInterval(timer);
  };
}
