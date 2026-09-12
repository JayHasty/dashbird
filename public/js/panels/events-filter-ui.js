/**
 * Shared Events filter widgets: date calendar (click/drag day paint) + attendance + big events.
 */

/**
 * @param {string | null | undefined} ymd
 * @returns {Date | null}
 */
function parseYmd(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * @param {Date} d
 * @returns {string}
 */
function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeDateList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const s = String(item || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  out.sort();
  return out;
}

/**
 * Normalize a typed local time to HH:MM (24h). Accepts "11", "11:0", "9:30", "11am".
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeLocalTime(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  if (!s) return null;

  let ampm = null;
  let core = s;
  const ampmMatch = core.match(/^(.+?)(a\.?m\.?|p\.?m\.?)$/i);
  if (ampmMatch) {
    core = ampmMatch[1];
    ampm = ampmMatch[2].startsWith('p') ? 'pm' : 'am';
  }

  const m = core.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  let h = Number(m[1]);
  let min = m[2] == null || m[2] === '' ? 0 : Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || min < 0 || min > 59) return null;

  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) {
    return null;
  }

  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Expand an inclusive YYYY-MM-DD range into discrete day strings.
 * @param {string | null | undefined} from
 * @param {string | null | undefined} to
 * @returns {string[]}
 */
function expandDateRange(from, to) {
  const start = parseYmd(from);
  const end = parseYmd(to || from);
  if (!start || !end) return [];
  let a = start;
  let b = end;
  if (a.getTime() > b.getTime()) {
    a = end;
    b = start;
  }
  const out = [];
  const cur = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const stop = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  while (cur <= stop) {
    out.push(formatYmd(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/**
 * @param {string | null | undefined} attendance
 * @returns {{ inPerson: boolean, online: boolean }}
 */
export function attendanceToChecks(attendance) {
  const a = String(attendance || 'any')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (a === 'online') return { inPerson: false, online: true };
  if (a === 'in_person') return { inPerson: true, online: false };
  return { inPerson: true, online: true };
}

/**
 * @param {{ inPerson: boolean, online: boolean }} checks
 * @returns {'any' | 'in_person' | 'online'}
 */
export function checksToAttendance(checks) {
  if (checks.inPerson && checks.online) return 'any';
  if (checks.online && !checks.inPerson) return 'online';
  if (checks.inPerson && !checks.online) return 'in_person';
  return 'any';
}

/**
 * Clickable month calendar — toggle individual days (multi-select); click-drag paints select/deselect.
 * @param {{
 *   idPrefix?: string,
 *   classPrefix?: string,
 *   dateFrom?: string | null,
 *   dateTo?: string | null,
 *   dates?: string[] | null,
 *   onChange?: () => void,
 * }} [opts]
 * @returns {{
 *   root: HTMLElement,
 *   getRange: () => { dateFrom: string | null, dateTo: string | null, dates: string[] },
 *   setRange: (from: string | null, to: string | null, dates?: string[] | null) => void,
 *   setDisabled: (disabled: boolean) => void,
 * }}
 */
export function createRangeCalendar(opts = {}) {
  const prefix = opts.classPrefix || 'events-cal';
  const idPrefix = opts.idPrefix || 'events-cal';
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;

  const root = document.createElement('div');
  root.className = prefix;
  root.id = `${idPrefix}-root`;

  const head = document.createElement('div');
  head.className = `${prefix}__head`;

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = `${prefix}__nav`;
  prevBtn.setAttribute('aria-label', 'Previous month');
  prevBtn.textContent = '‹';

  const title = document.createElement('p');
  title.className = `${prefix}__title`;
  title.setAttribute('aria-live', 'polite');

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = `${prefix}__nav`;
  nextBtn.setAttribute('aria-label', 'Next month');
  nextBtn.textContent = '›';

  head.append(prevBtn, title, nextBtn);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = `${prefix}__clear`;
  clearBtn.textContent = 'Clear dates';

  const dow = document.createElement('div');
  dow.className = `${prefix}__dow`;
  for (const d of ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']) {
    const cell = document.createElement('span');
    cell.textContent = d;
    dow.append(cell);
  }

  const grid = document.createElement('div');
  grid.className = `${prefix}__grid`;
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', 'Select dates; click to toggle, drag to paint');

  root.append(head, clearBtn, dow, grid);

  const now = new Date();
  let viewYear = now.getFullYear();
  let viewMonth = now.getMonth();
  const initialDates = normalizeDateList(opts.dates);
  /** @type {Set<string>} */
  let selectedDays = new Set(
    initialDates.length ? initialDates : expandDateRange(opts.dateFrom, opts.dateTo),
  );
  let disabled = false;
  /** @type {'add' | 'remove' | null} */
  let dragMode = null;
  /** @type {number | null} */
  let dragPointerId = null;
  /** True when the current drag actually changed selection. */
  let dragDirty = false;

  function emitChange() {
    if (onChange) onChange();
  }

  /**
   * @param {string} ymd
   * @param {HTMLElement} btn
   * @param {'add' | 'remove'} mode
   * @returns {boolean} whether selection changed
   */
  function applyDay(ymd, btn, mode) {
    if (mode === 'add') {
      if (selectedDays.has(ymd)) return false;
      selectedDays.add(ymd);
      btn.classList.add(`${prefix}__day--selected`);
      btn.setAttribute('aria-pressed', 'true');
      return true;
    }
    if (!selectedDays.has(ymd)) return false;
    selectedDays.delete(ymd);
    btn.classList.remove(`${prefix}__day--selected`);
    btn.setAttribute('aria-pressed', 'false');
    return true;
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {EventTarget | null} [fallbackTarget]
   * @returns {HTMLElement | null}
   */
  function dayButtonAt(clientX, clientY, fallbackTarget = null) {
    const el = document.elementFromPoint(clientX, clientY) || fallbackTarget;
    if (!el || typeof /** @type {Element} */ (el).closest !== 'function') return null;
    const btn = /** @type {Element} */ (el).closest(`.${prefix}__day`);
    if (!btn || !(btn instanceof HTMLElement) || !grid.contains(btn)) return null;
    if (!btn.dataset.ymd || btn.classList.contains(`${prefix}__day--empty`)) return null;
    return btn;
  }

  function endDrag() {
    if (!dragMode) return;
    const dirty = dragDirty;
    dragMode = null;
    dragPointerId = null;
    dragDirty = false;
    root.classList.remove(`${prefix}--dragging`);
    if (dirty) emitChange();
  }

  function paint() {
    endDrag();
    title.textContent = new Date(viewYear, viewMonth, 1).toLocaleString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    grid.replaceChildren();

    const first = new Date(viewYear, viewMonth, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

    for (let i = 0; i < startPad; i += 1) {
      const empty = document.createElement('span');
      empty.className = `${prefix}__day ${prefix}__day--empty`;
      empty.setAttribute('aria-hidden', 'true');
      grid.append(empty);
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const ymd = formatYmd(new Date(viewYear, viewMonth, day));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `${prefix}__day`;
      btn.textContent = String(day);
      btn.dataset.ymd = ymd;
      btn.disabled = disabled;
      btn.tabIndex = disabled ? -1 : 0;

      if (selectedDays.has(ymd)) {
        btn.classList.add(`${prefix}__day--selected`);
        btn.setAttribute('aria-pressed', 'true');
      } else {
        btn.setAttribute('aria-pressed', 'false');
      }
      if (ymd === formatYmd(now)) btn.classList.add(`${prefix}__day--today`);

      grid.append(btn);
    }
  }

  grid.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0) return;
    const btn = dayButtonAt(e.clientX, e.clientY, e.target);
    if (!btn || !btn.dataset.ymd) return;
    e.preventDefault();
    const ymd = btn.dataset.ymd;
    // Toggle the day; drag continues in the same add/remove mode for multi-select.
    dragMode = selectedDays.has(ymd) ? 'remove' : 'add';
    dragPointerId = e.pointerId;
    dragDirty = false;
    root.classList.add(`${prefix}--dragging`);
    if (applyDay(ymd, btn, dragMode)) dragDirty = true;
    try {
      grid.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });

  grid.addEventListener('pointermove', (e) => {
    if (!dragMode || (dragPointerId != null && e.pointerId !== dragPointerId)) return;
    const btn = dayButtonAt(e.clientX, e.clientY, e.target);
    if (!btn || !btn.dataset.ymd) return;
    if (applyDay(btn.dataset.ymd, btn, dragMode)) dragDirty = true;
  });

  grid.addEventListener('pointerup', endDrag);
  grid.addEventListener('pointercancel', endDrag);
  grid.addEventListener('lostpointercapture', endDrag);

  // Keyboard: Space/Enter toggles the focused day (multi-select).
  grid.addEventListener('keydown', (e) => {
    if (disabled) return;
    if (e.key !== ' ' && e.key !== 'Enter') return;
    const btn = e.target;
    if (!(btn instanceof HTMLElement) || !btn.dataset.ymd) return;
    e.preventDefault();
    const ymd = btn.dataset.ymd;
    const mode = selectedDays.has(ymd) ? 'remove' : 'add';
    if (applyDay(ymd, btn, mode)) emitChange();
  });

  prevBtn.addEventListener('click', () => {
    if (disabled) return;
    viewMonth -= 1;
    if (viewMonth < 0) {
      viewMonth = 11;
      viewYear -= 1;
    }
    paint();
  });

  nextBtn.addEventListener('click', () => {
    if (disabled) return;
    viewMonth += 1;
    if (viewMonth > 11) {
      viewMonth = 0;
      viewYear += 1;
    }
    paint();
  });

  clearBtn.addEventListener('click', () => {
    if (disabled) return;
    if (!selectedDays.size) return;
    selectedDays = new Set();
    paint();
    emitChange();
  });

  paint();

  return {
    root,
    getRange() {
      const dates = [...selectedDays].sort();
      return {
        dates,
        dateFrom: null,
        dateTo: null,
      };
    },
    setRange(from, to, dates) {
      const list = normalizeDateList(dates);
      selectedDays = new Set(list.length ? list : expandDateRange(from, to));
      const first = [...selectedDays].sort()[0];
      if (first) {
        const d = parseYmd(first);
        if (d) {
          viewYear = d.getFullYear();
          viewMonth = d.getMonth();
        }
      }
      paint();
    },
    setDisabled(next) {
      disabled = Boolean(next);
      prevBtn.disabled = disabled;
      nextBtn.disabled = disabled;
      clearBtn.disabled = disabled;
      paint();
    },
  };
}

/**
 * Attendance as In person / Online checkboxes.
 * @param {{
 *   idPrefix?: string,
 *   classPrefix?: string,
 *   attendance?: string | null,
 * }} [opts]
 * @returns {{
 *   root: HTMLElement,
 *   getAttendance: () => 'any' | 'in_person' | 'online',
 *   setAttendance: (attendance: string | null | undefined) => void,
 *   setDisabled: (disabled: boolean) => void,
 * }}
 */
export function createAttendanceChecks(opts = {}) {
  const prefix = opts.classPrefix || 'events-finder';
  const idPrefix = opts.idPrefix || 'events-finder-att';

  const root = document.createElement('div');
  root.className = `${prefix}__checkboxes ${prefix}__checkboxes--attendance`;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Attendance');

  const checks = attendanceToChecks(opts.attendance);

  /**
   * @param {string} value
   * @param {string} labelText
   * @param {boolean} checked
   */
  function makeCheck(value, labelText, checked) {
    const id = `${idPrefix}-${value}`;
    const row = document.createElement('label');
    row.className = `${prefix}__check`;
    row.htmlFor = id;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.value = value;
    input.checked = checked;
    const span = document.createElement('span');
    span.textContent = labelText;
    row.append(input, span);
    root.append(row);
    return input;
  }

  const inPerson = makeCheck('in_person', 'In person', checks.inPerson);
  const online = makeCheck('online', 'Online', checks.online);

  return {
    root,
    getAttendance() {
      return checksToAttendance({
        inPerson: inPerson.checked,
        online: online.checked,
      });
    },
    setAttendance(attendance) {
      const next = attendanceToChecks(attendance);
      inPerson.checked = next.inPerson;
      online.checked = next.online;
    },
    setDisabled(disabled) {
      inPerson.disabled = disabled;
      online.disabled = disabled;
    },
  };
}

/**
 * Show / hide producer festival cards (Burning Man, Climate Week, …).
 * @param {{
 *   idPrefix?: string,
 *   classPrefix?: string,
 *   showBigEvents?: boolean | null,
 * }} [opts]
 * @returns {{
 *   root: HTMLElement,
 *   getShowBigEvents: () => boolean,
 *   setShowBigEvents: (on: boolean | null | undefined) => void,
 *   setDisabled: (disabled: boolean) => void,
 * }}
 */
export function createBigEventsCheck(opts = {}) {
  const prefix = opts.classPrefix || 'events-finder';
  const idPrefix = opts.idPrefix || 'events-finder-big';
  const id = `${idPrefix}-show`;

  const root = document.createElement('div');
  root.className = `${prefix}__checkboxes ${prefix}__checkboxes--big-events`;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Big events');

  const row = document.createElement('label');
  row.className = `${prefix}__check`;
  row.htmlFor = id;
  row.title =
    'Festivals and once-a-year events such as Burning Man or Climate Week. Uncheck to hide them from the feed.';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = opts.showBigEvents !== false;

  const span = document.createElement('span');
  span.textContent = 'Show in feed';
  row.append(input, span);
  root.append(row);

  return {
    root,
    getShowBigEvents() {
      return input.checked;
    },
    setShowBigEvents(on) {
      input.checked = on !== false;
    },
    setDisabled(disabled) {
      input.disabled = Boolean(disabled);
    },
  };
}

/**
 * Cities pinned to the front of Events filter checklists.
 * Match is case-insensitive; remaining cities stay A–Z (Unknown last).
 */
const PRIORITY_CITIES = ['oakland', 'san francisco', 'emeryville', 'alameda'];

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareCityLabels(a, b) {
  if (a === 'Unknown') return 1;
  if (b === 'Unknown') return -1;
  const ai = PRIORITY_CITIES.indexOf(a.toLowerCase());
  const bi = PRIORITY_CITIES.indexOf(b.toLowerCase());
  if (ai !== bi) {
    if (ai < 0) return 1;
    if (bi < 0) return -1;
    return ai - bi;
  }
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

/**
 * Dynamic city checkboxes from the current feed.
 * @param {{
 *   idPrefix?: string,
 *   classPrefix?: string,
 *   cities?: string[],
 *   selected?: string[] | null,
 *   onChange?: () => void,
 * }} [opts]
 * @returns {{
 *   root: HTMLElement,
 *   getSelected: () => string[],
 *   setCities: (cities: string[], selected?: string[] | null) => void,
 *   setDisabled: (disabled: boolean) => void,
 * }}
 */
export function createCityChecks(opts = {}) {
  const prefix = opts.classPrefix || 'events-finder';
  const idPrefix = opts.idPrefix || 'events-finder-city';

  const root = document.createElement('div');
  root.className = `${prefix}__checkboxes ${prefix}__checkboxes--cities`;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Cities');

  /** @type {HTMLInputElement[]} */
  let inputs = [];
  let disabled = false;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;

  /**
   * @param {string[]} cities
   * @param {string[] | null | undefined} selected
   *   null/undefined = all checked; array = only those checked
   */
  function setCities(cities, selected) {
    const list = Array.isArray(cities)
      ? [...new Set(cities.map((c) => String(c || '').trim()).filter(Boolean))]
      : [];
    list.sort(compareCityLabels);

    /** @type {Set<string> | null} */
    let selectedSet = null;
    if (Array.isArray(selected) && selected.length) {
      selectedSet = new Set(
        selected.map((c) => String(c || '').trim().toLowerCase()).filter(Boolean),
      );
    }

    root.replaceChildren();
    inputs = [];
    for (const city of list) {
      const id = `${idPrefix}-${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const row = document.createElement('label');
      row.className = `${prefix}__check`;
      row.htmlFor = id;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.value = city;
      input.disabled = disabled;
      input.checked = selectedSet == null ? true : selectedSet.has(city.toLowerCase());
      input.addEventListener('change', () => {
        if (onChange) onChange();
      });
      const span = document.createElement('span');
      span.textContent = city;
      row.append(input, span);
      root.append(row);
      inputs.push(input);
    }
  }

  setCities(opts.cities || [], opts.selected);

  return {
    root,
    getSelected() {
      return inputs.filter((i) => i.checked).map((i) => i.value);
    },
    setCities,
    setDisabled(next) {
      disabled = Boolean(next);
      for (const input of inputs) input.disabled = disabled;
    },
  };
}
