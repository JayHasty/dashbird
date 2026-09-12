import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';
import {
  pushMobileNav,
  mobileNavBack,
  isMobileNavApplying,
} from '../lib/mobile-history.js';
import {
  createAttendanceChecks,
  createBigEventsCheck,
  createCityChecks,
  createRangeCalendar,
  normalizeLocalTime,
} from './events-filter-ui.js?v=big-events-filter-1';

const EVENTS_CACHE_KEY = 'events-finder:events';
const EVENTS_CACHE_MAX_MS = 6 * 60 * 60 * 1000;
const CRITERIA_CACHE_KEY = 'events-finder:criteria';
const CRITERIA_CACHE_MAX_MS = 6 * 60 * 60 * 1000;
const SHOW_SKIPPED_KEY = 'dashbird.events.showSkipped';
const TITLE_OVERRIDES_KEY = 'dashbird.events.titleOverrides';

const DEFAULT_GOOGLE_CALENDAR = {
  name: 'Random Events',
  authuser: '',
  src: '',
};

/** @type {Promise<any> | null} */
let leafletPromise = null;

/**
 * @returns {Promise<any>}
 */
function loadLeaflet() {
  if (leafletPromise) return leafletPromise;
  leafletPromise = (async () => {
    if (!document.querySelector('link[data-dashbird-leaflet]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/vendor/leaflet/leaflet.css';
      link.dataset.dashbirdLeaflet = '1';
      document.head.append(link);
    }
    if (/** @type {any} */ (window).L) return /** @type {any} */ (window).L;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/leaflet/leaflet.js';
      s.async = true;
      s.onload = () => resolve(undefined);
      s.onerror = () => reject(new Error('leaflet_load_failed'));
      document.head.append(s);
    });
    const L = /** @type {any} */ (window).L;
    if (!L) throw new Error('leaflet_missing');
    return L;
  })();
  return leafletPromise;
}

/**
 * @returns {Record<string, string>}
 */
function readTitleOverrides() {
  try {
    const raw = JSON.parse(localStorage.getItem(TITLE_OVERRIDES_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, string>} overrides
 */
function writeTitleOverrides(overrides) {
  try {
    localStorage.setItem(TITLE_OVERRIDES_KEY, JSON.stringify(overrides || {}));
  } catch {
    /* ignore */
  }
}

/**
 * Suggest taste lines seeded from an event for the thumbs up/down modal.
 * @param {object} ev
 * @param {'up' | 'down'} vibe
 * @returns {string}
 */
function suggestPreferenceLines(ev, vibe) {
  const title = String(ev.title || '').trim();
  const venue = String(ev.venue || ev.location || '').trim();
  const desc = String(ev.description || ev.raw?.description || '')
    .replace(/\s+/g, ' ')
    .trim();
  const lines = [];
  if (title) {
    const shortTitle = title
      .replace(/\s*[-–—|].*$/, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
      .slice(0, 60);
    if (shortTitle) lines.push(shortTitle);
  }
  const blob = `${title} ${desc}`;
  const hits = blob.match(
    /\b(hack[- ]?a[- ]?thons?|climate|sustainability|immersive|acro|yoga|founder|startup|ai|comedy|circus|burlesque|queer|pride|maker|festival|salon|retreat|nightlife)\b/gi,
  );
  if (hits) {
    for (const h of hits) {
      const n = h.toLowerCase();
      if (!lines.some((l) => l.toLowerCase() === n)) lines.push(n);
      if (lines.length >= 5) break;
    }
  }
  if (vibe === 'down' && venue) {
    const vShort = venue.split(',')[0].trim().slice(0, 40);
    if (vShort && !lines.some((l) => l.toLowerCase() === vShort.toLowerCase())) {
      lines.push(vShort);
    }
  }
  return lines.slice(0, 6).join('\n');
}

/**
 * Append unique lines to a newline-separated taste list.
 * @param {string} existing
 * @param {string} additions
 * @returns {string}
 */
function mergeTasteLines(existing, additions) {
  const seen = new Set();
  const out = [];
  for (const line of String(existing || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  for (const line of String(additions || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join('\n');
}

/**
 * @param {string} block
 * @returns {string[]}
 */
function tasteLinesFromBlock(block) {
  return String(block || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line && !line.startsWith('//'));
}

/**
 * @returns {boolean}
 */
function readShowSkipped() {
  try {
    return localStorage.getItem(SHOW_SKIPPED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * @param {boolean} on
 */
function writeShowSkipped(on) {
  try {
    localStorage.setItem(SHOW_SKIPPED_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * @param {unknown} iso
 * @returns {string}
 */
function formatWhen(iso) {
  if (!iso) return 'Date TBD';
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return 'Date TBD';
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

/**
 * @param {string | Date | null | undefined} start
 * @param {string} [timeZone]
 * @returns {{ day: string, minutes: number } | null}
 */
function eventLocalDayAndMinutes(start, timeZone = 'America/Los_Angeles') {
  if (!start) return null;
  const d = start instanceof Date ? start : new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const get = (/** @type {Intl.DateTimeFormatPartTypes} */ type) =>
      parts.find((p) => p.type === type)?.value;
    const y = get('year');
    const m = get('month');
    const day = get('day');
    const hour = Number(get('hour'));
    const minute = Number(get('minute'));
    if (!y || !m || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { day: `${y}-${m}-${day}`, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

/**
 * @param {object} ev
 * @returns {string}
 */
function eventCityLabel(ev) {
  const raw = [ev?.city, ev?.venueCity, ev?.listingCity]
    .map((c) => String(c || '').trim().replace(/\s+/g, ' '))
    .find(Boolean);
  return raw || 'Unknown';
}

/**
 * @param {object} data
 * @returns {string[]}
 */
function citiesFromPayload(data) {
  if (Array.isArray(data?.availableCities) && data.availableCities.length) {
    return data.availableCities.map(String).filter(Boolean);
  }
  const pool = [
    ...(Array.isArray(data?.events) ? data.events : []),
    ...(Array.isArray(data?.skippedEvents) ? data.skippedEvents : []),
  ];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const ev of pool) {
    const city = eventCityLabel(ev);
    const key = city.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(city);
  }
  return out;
}

/**
 * Tiny thumb URL for mobile list cards (prefer low-res CDN params).
 * @param {string} src
 * @returns {string}
 */
function rewriteEventImageSrcTiny(src) {
  const raw = String(src || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (
      u.hostname === 'firebasestorage.googleapis.com'
      && /getpartiful\.appspot\.com/i.test(u.pathname)
    ) {
      const m = u.pathname.match(/\/o\/(.+)$/);
      if (m) {
        const objectPath = decodeURIComponent(m[1]).replace(/^\/+/, '');
        if (objectPath) {
          return `https://partiful.imgix.net/${objectPath}?fit=crop&w=180&h=220&q=60&auto=format`;
        }
      }
    }
    if (/\.imgix\.net$/i.test(u.hostname) || /imgix\.net$/i.test(u.hostname)) {
      u.searchParams.set('w', '180');
      u.searchParams.set('h', '220');
      u.searchParams.set('q', '60');
      u.searchParams.set('auto', 'format');
      u.searchParams.set('fit', 'crop');
      return u.toString();
    }
    if (/fbcdn\.net$/i.test(u.hostname) || /facebook\.com$/i.test(u.hostname)) {
      if (!u.searchParams.has('stp')) {
        u.searchParams.set('w', '180');
        u.searchParams.set('h', '220');
      }
      return u.toString();
    }
  } catch {
    /* keep */
  }
  return raw;
}

/**
 * @param {object} ev
 * @param {{ name: string, authuser: string, src: string }} calTarget
 * @returns {string}
 */
function googleCalendarAddUrl(ev, calTarget) {
  const title = String(ev.title || 'Event').trim() || 'Event';
  const startMs = Date.parse(String(ev.start || ''));
  const endRaw = Date.parse(String(ev.end || ''));
  /** @param {Date} d */
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const params = new URLSearchParams();
  params.set('action', 'TEMPLATE');
  params.set('text', title);
  if (Number.isFinite(startMs)) {
    const start = new Date(startMs);
    const end =
      Number.isFinite(endRaw) && endRaw > startMs
        ? new Date(endRaw)
        : new Date(startMs + 2 * 60 * 60 * 1000);
    params.set('dates', `${fmt(start)}/${fmt(end)}`);
  }
  const place = String(ev.venue || ev.location || '').trim();
  if (place) params.set('location', place.slice(0, 500));
  const details = [String(ev.description || '').replace(/\s+/g, ' ').trim(), String(ev.url || '').trim()]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 6000);
  if (details) params.set('details', details);
  if (calTarget.src) params.set('src', calTarget.src);
  if (calTarget.authuser) params.set('authuser', calTarget.authuser);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

const SOURCE_LABELS = {
  facebook: 'Facebook',
  gmail: 'Gmail',
  eventbrite: 'Eventbrite',
  meetup: 'Meetup',
  luma: 'Luma',
  partiful: 'Partiful',
  secretparty: 'Secret Party',
  telegram: 'Telegram',
  multiverse: 'Multiverse',
  dorkbotsf: 'dorkbotSF',
  coolstuff: 'Cool Happenings',
  webpage: 'Web page',
  public: 'Web',
};

/**
 * Human label for the feed/platform an event came from.
 * Empty when there is no source to show (do not invent one).
 * @param {object} ev
 * @returns {string}
 */
function eventSourceLabel(ev) {
  const url = String(ev?.url || '').trim();
  if (url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./i, '');
      if (host) {
        if (/facebook\.com$/i.test(host)) return 'Facebook';
        if (/eventbrite\./i.test(host)) return 'Eventbrite';
        if (/meetup\.com$/i.test(host)) return 'Meetup';
        if (/lu\.ma$/i.test(host) || /^luma\./i.test(host)) return 'Luma';
        if (/partiful\.com$/i.test(host)) return 'Partiful';
        if (/secretparty\.io$/i.test(host)) return 'Secret Party';
        if (/themultiverse\.school$/i.test(host)) return 'Multiverse';
        if (/dorkbotsf\.org$/i.test(host)) return 'dorkbotSF';
      }
    } catch {
      /* ignore bad urls */
    }
  }

  const explicit = String(ev?.sourceLabel || '').trim();
  if (explicit) return explicit;

  const raw = String(ev?.source || ev?.platform || ev?.feed || ev?.origin || '')
    .trim()
    .toLowerCase();
  if (!raw || raw === 'unknown') return '';
  if (SOURCE_LABELS[raw]) return SOURCE_LABELS[raw];
  if (raw.startsWith('gmail')) return 'Gmail';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * @param {object} ev
 * @returns {object | null}
 */
function skippedRecordFromEvent(ev) {
  const id = String(ev?.id || '').trim();
  if (!id) return null;
  return {
    id,
    key: null,
    url: String(ev.url || '').trim() || null,
    title: String(ev.title || '').trim() || null,
    start: ev.start != null ? String(ev.start) : null,
    source: ev.source != null ? String(ev.source) : null,
    venue: String(ev.venue || ev.location || '').trim() || null,
    city: ev.city != null ? String(ev.city) : null,
    imageUrl: String(ev.imageUrl || '').trim() || null,
    seriesKey: String(ev?.seriesKey || '').trim() || null,
    skippedAt: new Date().toISOString(),
  };
}

/**
 * @param {unknown} title
 * @returns {string}
 */
function normalizeSkipTitleFuzzyKey(title) {
  const base = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  return base
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/g, ' ')
    .replace(/\bfrom\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+)?to\b/g, 'from-to')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deliberate Telegram intake — only date filters should hide these in the feed.
 * @param {object} ev
 * @returns {boolean}
 */
function isTelegramIntakeEvent(ev) {
  if (String(ev?.source || '').trim().toLowerCase() === 'telegram') return true;
  const id = String(ev?.id || '').trim();
  return id.startsWith('telegram:');
}

/**
 * @param {object} event
 * @param {object[]} skipped
 * @returns {boolean}
 */
function eventMatchesSkippedLocal(event, skipped) {
  const list = Array.isArray(skipped) ? skipped : [];
  if (!list.length || !event) return false;
  const id = String(event.id || '').trim();
  const url = String(event.url || '').trim().toLowerCase();
  const title = String(event.title || '').trim().toLowerCase();
  const day = event.start != null ? String(event.start).slice(0, 10) : '';
  const seriesKey = String(event.seriesKey || '').trim();
  const source = String(event.source || '').trim().toLowerCase();
  const fuzzy = normalizeSkipTitleFuzzyKey(event.title);
  const fuzzyKey = fuzzy.length >= 24 && source ? `${source}|${fuzzy}` : '';
  for (const s of list) {
    if (id && String(s?.id || '') === id) return true;
    const sSeries = String(s?.seriesKey || '').trim();
    if (seriesKey && sSeries && seriesKey === sSeries) return true;
    const sUrl = String(s?.url || '').trim().toLowerCase();
    if (url && sUrl && (url === sUrl || url.includes(sUrl) || sUrl.includes(url))) return true;
    const sTitle = String(s?.title || '').trim().toLowerCase();
    const sDay = s?.start != null ? String(s.start).slice(0, 10) : '';
    if (title && sTitle && title === sTitle && day && sDay && day === sDay) return true;
    if (fuzzyKey) {
      const sSource = String(s?.source || '').trim().toLowerCase();
      const sFuzzy = normalizeSkipTitleFuzzyKey(s?.title);
      if (sSource && sFuzzy.length >= 24 && `${sSource}|${sFuzzy}` === fuzzyKey) return true;
    }
  }
  return false;
}

/**
 * @param {object} ev
 * @param {object} record
 * @returns {boolean}
 */
function eventMatchesSkipRecord(ev, record) {
  if (!ev || !record) return false;
  const id = String(ev?.id || '').trim();
  const recordId = String(record?.id || '').trim();
  if (id && recordId && id === recordId) return true;
  const seriesKey = String(ev?.seriesKey || '').trim();
  const recordSeries = String(record?.seriesKey || '').trim();
  if (seriesKey && recordSeries && seriesKey === recordSeries) return true;
  return eventMatchesSkippedLocal(ev, [record]);
}

/**
 * Slim Events Finder list — filters + tiny icons + skip / heart / add-to-cal.
 * @param {HTMLElement | null} root
 */
export function mountEventsFinderMobile(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('mobile-events');

  const toolbar = document.createElement('div');
  toolbar.className = 'mobile-events__toolbar';

  const filterToggle = document.createElement('button');
  filterToggle.type = 'button';
  filterToggle.className = 'mobile-events__filter-toggle';
  filterToggle.setAttribute('aria-expanded', 'false');
  filterToggle.innerHTML =
    '<span class="mobile-events__filter-toggle-label">Filters</span><span class="mobile-events__filter-toggle-arrow" aria-hidden="true">▾</span>';

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'mobile-events__view-toggle';
  viewBtn.textContent = 'Map';
  viewBtn.setAttribute('aria-pressed', 'false');
  viewBtn.setAttribute('aria-label', 'Open events map');
  viewBtn.title = 'Open events on a map';

  toolbar.append(filterToggle, viewBtn);

  const filterPanel = document.createElement('div');
  filterPanel.className = 'mobile-events__filters';
  filterPanel.hidden = true;

  const areaRow = document.createElement('div');
  areaRow.className = 'mobile-events__filter-row';

  const zipField = document.createElement('label');
  zipField.className = 'mobile-events__filter';
  const zipLabel = document.createElement('span');
  zipLabel.textContent = 'ZIP';
  const zipInput = document.createElement('input');
  zipInput.className = 'mobile-events__filter-input';
  zipInput.type = 'text';
  zipInput.inputMode = 'numeric';
  zipInput.autocomplete = 'postal-code';
  zipInput.maxLength = 5;
  zipInput.placeholder = '94608';
  zipInput.setAttribute('aria-label', 'ZIP');
  zipField.append(zipLabel, zipInput);

  const milesField = document.createElement('label');
  milesField.className = 'mobile-events__filter';
  const milesLabel = document.createElement('span');
  milesLabel.textContent = 'Radius (mi)';
  const milesInput = document.createElement('input');
  milesInput.className = 'mobile-events__filter-input';
  milesInput.type = 'number';
  milesInput.min = '1';
  milesInput.max = '100';
  milesInput.step = '0.5';
  milesInput.placeholder = '25';
  milesInput.setAttribute('aria-label', 'Radius in miles');
  milesField.append(milesLabel, milesInput);

  areaRow.append(zipField, milesField);
  filterPanel.append(areaRow);

  const attendanceField = document.createElement('div');
  attendanceField.className = 'mobile-events__filter mobile-events__filter--block';
  const attendanceLabel = document.createElement('span');
  attendanceLabel.textContent = 'Attendance';
  const attendanceChecks = createAttendanceChecks({
    idPrefix: 'mobile-events-att',
    classPrefix: 'mobile-events',
    attendance: 'any',
  });
  attendanceField.append(attendanceLabel, attendanceChecks.root);
  filterPanel.append(attendanceField);

  const bigEventsField = document.createElement('div');
  bigEventsField.className = 'mobile-events__filter mobile-events__filter--block';
  const bigEventsLabel = document.createElement('span');
  bigEventsLabel.textContent = 'Big events';
  const bigEventsChecks = createBigEventsCheck({
    idPrefix: 'mobile-events-big',
    classPrefix: 'mobile-events',
    showBigEvents: true,
  });
  bigEventsField.append(bigEventsLabel, bigEventsChecks.root);
  filterPanel.append(bigEventsField);

  const citiesField = document.createElement('div');
  citiesField.className = 'mobile-events__filter mobile-events__filter--block';
  const citiesLabel = document.createElement('span');
  citiesLabel.textContent = 'Cities';
  /** @type {string[] | null} */
  let savedCitySelection = null;
  const cityChecks = createCityChecks({
    idPrefix: 'mobile-events-city',
    classPrefix: 'mobile-events',
    cities: [],
    selected: null,
    onChange: () => {
      if (!lastEventsPayload) return;
      const available = citiesFromPayload(lastEventsPayload);
      const selected = cityChecks.getSelected();
      savedCitySelection =
        available.length && selected.length && selected.length < available.length
          ? selected
          : null;
      paint(lastEventsPayload);
      scheduleFilterAutosave();
    },
  });
  const citiesEmpty = document.createElement('p');
  citiesEmpty.className = 'mobile-events__cities-empty';
  citiesEmpty.textContent = 'Cities appear when events load.';
  citiesField.append(citiesLabel, cityChecks.root, citiesEmpty);
  filterPanel.append(citiesField);

  const datesField = document.createElement('div');
  datesField.className = 'mobile-events__filter mobile-events__filter--block';
  const datesLabel = document.createElement('span');
  datesLabel.textContent = 'Dates';
  const calendar = createRangeCalendar({
    idPrefix: 'mobile-events-cal',
    classPrefix: 'events-cal',
    onChange: () => {
      if (lastEventsPayload) paint(lastEventsPayload);
      scheduleFilterAutosave({ reload: true });
    },
  });
  datesField.append(datesLabel, calendar.root);
  filterPanel.append(datesField);

  const timeField = document.createElement('label');
  timeField.className = 'mobile-events__filter mobile-events__filter--block';
  const timeLabel = document.createElement('span');
  timeLabel.textContent = 'Earliest (optional)';
  const timeInput = document.createElement('input');
  timeInput.className = 'mobile-events__filter-input mobile-events__filter-input--time';
  timeInput.type = 'time';
  timeInput.step = '60';
  timeInput.value = '';
  timeInput.setAttribute('aria-label', 'Earliest local start time');
  timeField.append(timeLabel, timeInput);
  filterPanel.append(timeField);

  const conferenceField = document.createElement('div');
  conferenceField.className = 'mobile-events__filter mobile-events__filter--block mobile-events__filter--conferences';

  const conferenceToggle = document.createElement('button');
  conferenceToggle.type = 'button';
  conferenceToggle.className = 'mobile-events__conferences-toggle';
  conferenceToggle.setAttribute('aria-expanded', 'false');
  conferenceToggle.setAttribute('aria-haspopup', 'dialog');
  conferenceToggle.textContent = 'Event sources';
  conferenceToggle.title = 'Websites to scrape for regular events';

  const conferenceInput = document.createElement('textarea');
  conferenceInput.className = 'mobile-events__conferences-input';
  conferenceInput.hidden = true;
  conferenceInput.tabIndex = -1;
  conferenceInput.setAttribute('aria-hidden', 'true');
  conferenceInput.placeholder = 'e.g. open sauce';

  conferenceField.append(conferenceToggle, conferenceInput);
  filterPanel.append(conferenceField);

  /** @type {HTMLElement | null} */
  let conferencePopoutBackdrop = null;
  /** @type {((e: KeyboardEvent) => void) | null} */
  let conferencePopoutKeyHandler = null;
  /** @type {HTMLElement | null} */
  let conferencePopoutStatusList = null;
  /**
   * Slugs pending a soft-delete. Value is the timeout id that will commit the
   * DELETE unless the user hits Undo first.
   * @type {Map<string, ReturnType<typeof setTimeout>>}
   */
  const pendingBigEventDeletes = new Map();
  const BIG_EVENT_DELETE_DELAY_MS = 3000;

  function closeConferencePopout() {
    if (!conferencePopoutBackdrop) return;
    if (conferencePopoutKeyHandler) {
      document.removeEventListener('keydown', conferencePopoutKeyHandler);
      conferencePopoutKeyHandler = null;
    }
    conferencePopoutBackdrop.remove();
    conferencePopoutBackdrop = null;
    conferencePopoutStatusList = null;
    conferenceToggle.setAttribute('aria-expanded', 'false');
    conferenceToggle.classList.remove('mobile-events__conferences-toggle--open');
  }

  /**
   * @param {{ title: string, body: HTMLElement, onClose?: () => void }} opts
   */
  function openConferencePopout(opts) {
    if (conferencePopoutBackdrop) closeConferencePopout();

    const backdrop = document.createElement('div');
    backdrop.className = 'events-finder__conference-popout-backdrop mobile-events__conference-popout-backdrop';
    const shell = document.createElement('div');
    shell.className = 'events-finder__conference-popout mobile-events__conference-popout';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');

    const bar = document.createElement('div');
    bar.className = 'events-finder__conference-popout-bar';
    const title = document.createElement('h2');
    title.className = 'events-finder__conference-popout-title';
    title.textContent = opts.title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'events-finder__conference-popout-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.title = 'Close';
    closeBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';
    bar.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'events-finder__conference-popout-body';
    body.append(opts.body);

    shell.append(bar, body);
    backdrop.append(shell);
    document.body.append(backdrop);
    conferencePopoutBackdrop = backdrop;
    conferenceToggle.setAttribute('aria-expanded', 'true');
    conferenceToggle.classList.add('mobile-events__conferences-toggle--open');

    const finishClose = () => {
      opts.onClose?.();
      closeConferencePopout();
    };
    closeBtn.addEventListener('click', finishClose);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finishClose();
    });
    conferencePopoutKeyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finishClose();
      }
    };
    document.addEventListener('keydown', conferencePopoutKeyHandler);
    closeBtn.focus();
  }

  function syncConferenceToggleLabel() {
    const count = readConferenceWatchlistFromForm().length;
    conferenceToggle.textContent = count > 0 ? `Event sources (${count})` : 'Event sources';
  }

  /**
   * @param {object} item
   * @returns {string}
   */
  function conferenceUrlStatusLabel(item) {
    return item.urlFound ? 'Found' : 'Not found';
  }

  /**
   * @param {object} item
   * @returns {string}
   */
  function conferenceDataStatusLabel(item) {
    switch (item.dataFetched) {
      case 'fetching':
        return 'Fetching…';
      case 'fetched':
        return 'Fetched';
      case 'failed':
        return 'Failed';
      default:
        return 'Pending';
    }
  }

  /**
   * @param {object} item
   * @returns {string}
   */
  function conferenceDisplayStatusLabel(item) {
    return item.displayActive ? 'Active' : 'Inactive';
  }

  function bigEventTicketText(item) {
    if (item.researching) return 'Looking up…';
    if (item.ticketLabel) return String(item.ticketLabel);
    if (item.ticketPrice) return String(item.ticketPrice);
    if (item.dataFetched === 'failed' || item.error) return 'Not found';
    return '—';
  }

  /**
   * @param {object} item
   * @returns {HTMLElement}
   */
  function buildBigEventRow(item) {
    if (pendingBigEventDeletes.has(String(item?.slug || ''))) {
      return buildBigEventRemovingRow(item);
    }
    const row = document.createElement('div');
    row.className = 'events-finder__big-events-row events-finder__big-events-row--mobile';

    const main = document.createElement('div');
    main.className = 'events-finder__big-events-mobile-main';
    const rowUrl = String(item.homepageUrl || item.url || '').trim();
    const rowThumb = item.flierImageUrl || item.flierUrl || item.screenshotUrl;
    if (rowThumb) {
      const thumb = document.createElement('img');
      thumb.className = 'events-finder__big-events-thumb';
      thumb.src = String(rowThumb);
      thumb.alt = '';
      thumb.loading = 'lazy';
      main.append(thumb);
    }
    const textWrap = document.createElement('div');
    textWrap.className = 'events-finder__big-events-mobile-text';
    // Name links straight to the official site — no detail popup.
    const name = document.createElement(rowUrl ? 'a' : 'span');
    name.className = 'events-finder__big-events-name-text';
    name.textContent = String(item.title || item.query || 'Big event');
    if (rowUrl) {
      name.href = rowUrl;
      name.target = '_blank';
      name.rel = 'noopener noreferrer';
      name.title = 'Open official site';
    }
    const when = document.createElement('span');
    when.className = 'events-finder__big-events-mobile-when muted';
    when.textContent = String(item.whenLabel || (item.researching ? 'Looking up…' : 'Dates TBD'));
    const priceLine = document.createElement('span');
    priceLine.className = 'events-finder__big-events-mobile-price';
    const price = document.createElement('span');
    price.textContent = item.priceEstimated && item.ticketPrice
      ? String(item.ticketPrice)
      : bigEventTicketText(item);
    priceLine.append(price);
    if (item.priceEstimated) {
      const badge = document.createElement('span');
      badge.className = 'events-finder__big-events-badge events-finder__big-events-badge--est';
      badge.textContent = 'estimated from last year';
      priceLine.append(badge);
    }
    const statusPill = document.createElement('span');
    statusPill.className = `events-finder__big-events-status events-finder__big-events-status--${item.salesStatusKind || 'unknown'}`;
    statusPill.textContent = String(item.salesStatus || '—');
    priceLine.append(statusPill);
    textWrap.append(name, when, priceLine);
    if (item.earlyBirdNote) {
      const eb = document.createElement('span');
      eb.className = 'events-finder__big-events-earlybird';
      eb.textContent = String(item.earlyBirdNote);
      textWrap.append(eb);
    } else if (item.salesStartLine) {
      const sl = document.createElement('span');
      sl.className = 'events-finder__big-events-earlybird';
      sl.textContent = String(item.salesStartLine);
      textWrap.append(sl);
    }
    const descText = String(item.notes || '').trim();
    if (descText) {
      const desc = document.createElement('span');
      desc.className = 'events-finder__big-events-mobile-desc muted';
      desc.textContent = descText;
      textWrap.append(desc);
    }
    if (item.ticketUrl) {
      const tlink = document.createElement('a');
      tlink.className = 'events-finder__big-events-ticketlink';
      tlink.href = String(item.ticketUrl);
      tlink.target = '_blank';
      tlink.rel = 'noopener noreferrer';
      tlink.textContent = 'Tickets ↗';
      tlink.addEventListener('click', (e) => e.stopPropagation());
      textWrap.append(tlink);
    }
    if (item.manualEdit) {
      const editedTag = document.createElement('span');
      editedTag.className = 'events-finder__big-events-edited-tag';
      editedTag.textContent = 'edited';
      editedTag.title = 'Hand-edited — auto research is paused for this event';
      textWrap.append(editedTag);
    }
    if (item.planningNotes) {
      const logTag = document.createElement('span');
      logTag.className = 'events-finder__big-events-edited-tag';
      logTag.textContent = 'logistics';
      logTag.title = String(item.planningNotes).slice(0, 200);
      textWrap.append(logTag);
    }
    main.append(textWrap);

    const actions = document.createElement('div');
    actions.className = 'events-finder__big-events-mobile-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'events-finder__big-events-edit-btn';
    editBtn.setAttribute('aria-label', `Edit ${item.title || item.query || 'event'}`);
    editBtn.title = 'Edit details';
    editBtn.textContent = 'Edit';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'events-finder__big-events-remove';
    del.setAttribute('aria-label', `Remove ${item.title || item.query || 'event'}`);
    del.title = 'Remove';
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      scheduleBigEventDelete(item);
    });
    actions.append(editBtn, del);

    const editor = buildBigEventEditor(item);
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      editor.hidden = !editor.hidden;
      editBtn.classList.toggle('events-finder__big-events-edit-btn--on', !editor.hidden);
      if (!editor.hidden) {
        const first = editor.querySelector('input, textarea');
        if (first instanceof HTMLElement) first.focus();
      }
    });

    row.append(main, actions, editor);
    return row;
  }

  /**
   * Compact inline editor for one big event's metadata (mobile). Saving
   * hand-edits the record (locks it from auto-research); "Re-research" discards.
   * @param {object} item
   * @returns {HTMLElement}
   */
  function buildBigEventEditor(item) {
    const wrap = document.createElement('div');
    wrap.className = 'events-finder__big-events-edit';
    wrap.hidden = true;

    /**
     * @param {string} label
     * @param {'text'|'url'|'date'|'textarea'} type
     * @param {string} value
     */
    const field = (label, type, value) => {
      const lab = document.createElement('label');
      lab.className = 'events-finder__big-events-edit-field';
      const span = document.createElement('span');
      span.className = 'events-finder__big-events-edit-label';
      span.textContent = label;
      const input =
        type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
      if (input instanceof HTMLInputElement) input.type = type;
      input.className = 'events-finder__big-events-edit-input';
      input.value = value == null ? '' : String(value);
      lab.append(span, input);
      wrap.append(lab);
      return input;
    };

    const startVal = item.eventStart || (item.start ? String(item.start).slice(0, 10) : '');
    const endVal = item.eventEnd || (item.end ? String(item.end).slice(0, 10) : '');

    const nameI = field('Name', 'text', item.title || item.query || '');
    const urlI = field('Official site URL', 'url', item.homepageUrl || item.url || '');
    const ticketI = field('Tickets URL', 'url', item.ticketUrl || '');
    const startI = field('Start date', 'date', startVal);
    const endI = field('End date', 'date', endVal);
    const venueI = field('Venue', 'text', item.venue || '');
    const cityI = field('City', 'text', item.city || '');
    const priceI = field('Ticket price', 'text', item.ticketPrice || '');
    const salesI = field('On-sale date', 'date', item.ticketSalesStart || '');
    const ebPriceI = field('Early bird price', 'text', item.earlyBirdPrice || '');
    const ebStartI = field('Early bird start', 'date', item.earlyBirdStart || '');
    const ebEndI = field('Early bird end', 'date', item.earlyBirdEnd || '');
    const notesI = field('Description', 'textarea', item.notes || '');
    const logisticsI = field(
      'Logistics notes (flights, lodging…)',
      'textarea',
      item.planningNotes || '',
    );
    const logisticsStatus = document.createElement('p');
    logisticsStatus.className = 'events-finder__big-events-msg muted';
    logisticsStatus.hidden = true;
    wrap.append(logisticsStatus);
    if (logisticsI instanceof HTMLTextAreaElement) {
      const slug = String(item.slug || '').trim();
      bindLogisticsAutosave(logisticsI, {
        statusEl: logisticsStatus,
        save: async (text) => {
          if (!slug) throw new Error('missing_slug');
          await saveBigEventPlanningNotes(slug, text);
          item.planningNotes = String(text || '').trim() || null;
        },
        onSaved: () => {
          void refreshBigEventsFromStore();
          void loadEvents();
        },
      });
    }

    const actions = document.createElement('div');
    actions.className = 'events-finder__big-events-edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'events-finder__big-events-confirm';
    saveBtn.textContent = 'Save';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'events-finder__big-events-again';
    cancelBtn.textContent = 'Cancel';
    const researchBtn = document.createElement('button');
    researchBtn.type = 'button';
    researchBtn.className = 'events-finder__big-events-again';
    researchBtn.textContent = 'Enrich';
    researchBtn.title = 'Discard manual edits and re-fetch from the web';
    const editMsg = document.createElement('span');
    editMsg.className = 'events-finder__big-events-edit-msg muted';
    actions.append(saveBtn, cancelBtn, researchBtn, editMsg);
    wrap.append(actions);

    const setMsg = (text, kind) => {
      editMsg.textContent = text || '';
      editMsg.className = `events-finder__big-events-edit-msg${kind === 'error' ? ' events-finder__big-events-edit-msg--error' : ' muted'}`;
    };

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      wrap.hidden = true;
    });

    saveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      setMsg('');
      try {
        const body = {
          name: nameI.value.trim(),
          homepageUrl: urlI.value.trim(),
          ticketUrl: ticketI.value.trim(),
          eventStart: startI.value,
          eventEnd: endI.value,
          venue: venueI.value.trim(),
          city: cityI.value.trim(),
          ticketPrice: priceI.value.trim(),
          ticketSalesStart: salesI.value,
          earlyBirdPrice: ebPriceI.value.trim(),
          earlyBirdStart: ebStartI.value,
          earlyBirdEnd: ebEndI.value,
          notes: notesI.value.trim(),
          planningNotes: logisticsI.value.trim(),
        };
        const res = await fetch(
          `/api/events-finder/big-events/${encodeURIComponent(item.slug)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        wrap.hidden = true; // close editor so the refresh below can repaint
        void refreshBigEventsFromStore();
        reloadBigEventsSoon();
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        setMsg(`Could not save: ${String(err?.message || err)}`, 'error');
      }
    });

    researchBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm('Discard manual edits and re-fetch this event from the web?')) return;
      researchBtn.disabled = true;
      setMsg('Enriching… this can take a moment.');
      try {
        const res = await fetch('/api/events-finder/big-events/research', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: item.query || item.title }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setTimeout(() => {
          wrap.hidden = true; // close editor so the refresh can repaint
          void refreshBigEventsFromStore();
          reloadBigEventsSoon();
        }, 4000);
      } catch (err) {
        researchBtn.disabled = false;
        setMsg(`Could not enrich: ${String(err?.message || err)}`, 'error');
      }
    });

    return wrap;
  }

  /**
   * @param {object[]} items
   * @param {HTMLElement} listEl
   */
  function paintBigEventsTable(items, listEl) {
    listEl.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'events-finder__big-events-empty muted';
      empty.textContent = 'No big events tracked yet — add one above.';
      listEl.append(empty);
      return;
    }
    for (const item of items) listEl.append(buildBigEventRow(item));
  }

  /**
   * @returns {object[]}
   */
  function conferenceWatchItemsFromPayload() {
    const raw = lastEventsPayload?.conferenceWatchlistItems;
    if (Array.isArray(raw)) return raw;
    return [];
  }

  function syncConferenceNamesFromPayload() {
    const names = Array.isArray(lastEventsPayload?.conferenceWatchlist)
      ? lastEventsPayload.conferenceWatchlist.map(String)
      : null;
    if (names) {
      conferenceInput.value = names.join('\n');
      if (taste) taste.conferenceWatchlist = names;
      syncConferenceToggleLabel();
    }
  }

  /**
   * True while the user has a row's edit form open. Background refreshes must
   * not repaint the list then, or they'd collapse the form and wipe edits.
   */
  function isBigEventEditorOpen() {
    return Boolean(
      conferencePopoutStatusList
        && conferencePopoutStatusList.querySelector(
          '.events-finder__big-events-edit:not([hidden])',
        ),
    );
  }

  function refreshConferencePopoutIfOpen() {
    syncConferenceNamesFromPayload();
    if (!conferencePopoutStatusList || isBigEventEditorOpen()) return;
    paintBigEventsTable(conferenceWatchItemsFromPayload(), conferencePopoutStatusList);
  }

  /**
   * Load the tracked Big Events straight from their own persistent store so the
   * list stays visible across refreshes / deploys and even before the main
   * events feed finishes loading (or if it fails).
   */
  async function refreshBigEventsFromStore() {
    try {
      const res = await fetch('/api/events-finder/big-events/', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !Array.isArray(data.items)) return;
      if (lastEventsPayload) lastEventsPayload.conferenceWatchlistItems = data.items;
      // Don't clobber an open edit form; cached data paints once it closes.
      if (conferencePopoutStatusList && !isBigEventEditorOpen()) {
        paintBigEventsTable(data.items, conferencePopoutStatusList);
      }
    } catch {
      /* keep whatever is already painted from cache */
    }
  }

  function reloadBigEventsSoon() {
    void refreshBigEventsFromStore();
    void loadEvents();
    for (const delay of [5000, 12000, 25000, 40000]) {
      setTimeout(() => {
        if (conferencePopoutStatusList) void refreshBigEventsFromStore();
        void loadEvents();
      }, delay);
    }
  }

  /** Repaint the tracked list from the cached payload (instant, no network). */
  function repaintBigEventsTable() {
    if (conferencePopoutStatusList) {
      paintBigEventsTable(conferenceWatchItemsFromPayload(), conferencePopoutStatusList);
    }
  }

  /**
   * "Removing" placeholder row shown for the 3s undo window.
   * @param {object} item
   * @returns {HTMLElement}
   */
  function buildBigEventRemovingRow(item) {
    const row = document.createElement('div');
    row.className =
      'events-finder__big-events-row events-finder__big-events-row--mobile events-finder__big-events-row--removing';
    const label = document.createElement('span');
    label.className = 'events-finder__big-events-removing-label';
    label.textContent = `Removed “${item.title || item.query || 'event'}”`;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'events-finder__big-events-undo';
    undo.textContent = 'Undo';
    undo.addEventListener('click', (e) => {
      e.stopPropagation();
      undoBigEventDelete(item);
    });
    row.append(label, undo);
    return row;
  }

  /** Start a 3s soft-delete for one event (no confirm dialog; Undo available). */
  function scheduleBigEventDelete(item) {
    const slug = String(item?.slug || '').trim();
    if (!slug || pendingBigEventDeletes.has(slug)) return;
    const timer = setTimeout(() => {
      void commitBigEventDelete(item);
    }, BIG_EVENT_DELETE_DELAY_MS);
    pendingBigEventDeletes.set(slug, timer);
    repaintBigEventsTable();
  }

  /** Cancel a pending soft-delete and restore the row. */
  function undoBigEventDelete(item) {
    const slug = String(item?.slug || '').trim();
    const timer = pendingBigEventDeletes.get(slug);
    if (timer) clearTimeout(timer);
    pendingBigEventDeletes.delete(slug);
    repaintBigEventsTable();
  }

  /** Actually delete the event once the undo window elapses. */
  async function commitBigEventDelete(item) {
    const slug = String(item?.slug || '').trim();
    if (!slug) return;
    pendingBigEventDeletes.delete(slug);
    try {
      const res = await fetch(`/api/events-finder/big-events/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      void refreshBigEventsFromStore();
      void loadEvents();
    } catch (e) {
      window.alert(`Could not remove: ${String(e?.message || e)}`);
      void refreshBigEventsFromStore();
    }
  }

  const LOGISTICS_AUTOSAVE_MS = 450;

  /**
   * @param {unknown} notes
   * @returns {boolean}
   */
  function hasLogisticsNotes(notes) {
    return Boolean(String(notes || '').trim());
  }

  /**
   * Warn before skipping an event that has logistics notes.
   * @param {object} item
   * @returns {boolean}
   */
  function confirmSkipDespiteLogistics(item) {
    if (!hasLogisticsNotes(item?.planningNotes)) return true;
    return window.confirm(
      'This event has logistics notes saved (flights, lodging, packing, etc.). Skip it anyway?',
    );
  }

  /**
   * Debounced autosave for logistics textareas (server-backed, phone-synced).
   * @param {HTMLTextAreaElement} ta
   * @param {{
   *   save: (text: string) => Promise<void>,
   *   statusEl?: HTMLElement | null,
   *   onSaved?: (text: string) => void,
   *   debounceMs?: number,
   * }} opts
   */
  function bindLogisticsAutosave(ta, opts) {
    const debounceMs = opts.debounceMs ?? LOGISTICS_AUTOSAVE_MS;
    let timer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
    let inFlight = false;
    let again = false;
    let lastAck = ta.value;
    let destroyed = false;

    function setStatus(text, kind) {
      if (!opts.statusEl) return;
      opts.statusEl.hidden = !text;
      opts.statusEl.textContent = text || '';
      opts.statusEl.className =
        kind === 'error'
          ? 'events-finder__big-events-msg events-finder__big-events-msg--error'
          : 'events-finder__big-events-msg muted';
    }

    async function flush() {
      if (destroyed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const text = ta.value;
      if (text === lastAck) return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      setStatus('Saving…');
      try {
        await opts.save(text);
        lastAck = text;
        opts.onSaved?.(text);
        setStatus('Saved');
      } catch (e) {
        setStatus(String(e?.message || e), 'error');
      } finally {
        inFlight = false;
        if (again) {
          again = false;
          void flush();
        }
      }
    }

    const onInput = () => {
      setStatus('Saving…');
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), debounceMs);
    };
    ta.addEventListener('input', onInput);
    ta.addEventListener('blur', () => void flush());

    return {
      flush,
      destroy() {
        destroyed = true;
        ta.removeEventListener('input', onInput);
        if (timer) clearTimeout(timer);
      },
    };
  }

  /**
   * @param {string} slug
   * @param {string} text
   */
  async function saveBigEventPlanningNotes(slug, text) {
    const res = await fetch(`/api/events-finder/big-events/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planningNotes: String(text || '').trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  }

  /**
   * Logistics notes dialog for a producer / big event (autosaves).
   * @param {object} item
   */
  function openProducerLogisticsDialog(item) {
    const slug = String(item?.slug || '').trim();
    if (!slug) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'events-finder__correct-backdrop';
    const panel = document.createElement('div');
    panel.className = 'events-finder__correct-dialog';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const title = document.createElement('h3');
    title.className = 'events-finder__correct-title';
    title.textContent = 'Logistics notes';
    const hint = document.createElement('p');
    hint.className = 'events-finder__correct-hint muted';
    hint.textContent = `${item.title || item.query || 'Producer'} — accommodations, flights, packing, etc. Autosaves.`;

    const ta = document.createElement('textarea');
    ta.className = 'events-finder__correct-input';
    ta.rows = 8;
    ta.placeholder = 'Flights…\nLodging…\nOther…';
    ta.value = item.planningNotes ? String(item.planningNotes) : '';
    ta.autocomplete = 'off';

    const status = document.createElement('p');
    status.className = 'events-finder__big-events-msg muted';
    status.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'events-finder__correct-actions';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'events-finder__big-events-confirm';
    done.textContent = 'Done';
    actions.append(done);
    panel.append(title, hint, ta, status, actions);
    backdrop.append(panel);
    document.body.append(backdrop);
    ta.focus();

    const autosave = bindLogisticsAutosave(ta, {
      statusEl: status,
      save: async (text) => {
        await saveBigEventPlanningNotes(slug, text);
        item.planningNotes = String(text || '').trim() || null;
      },
    });

    const close = async () => {
      await autosave.flush();
      autosave.destroy();
      backdrop.remove();
      void refreshBigEventsFromStore();
      void loadEvents();
    };
    done.addEventListener('click', () => void close());
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) void close();
    });
  }

  /**
   * POST a big-event feed-card action (snooze / skip / restore), then refresh.
   * @param {object} item
   * @param {'snooze' | 'skip' | 'restore'} action
   */
  async function bigEventCardAction(item, action) {
    const slug = String(item?.slug || '').trim();
    if (!slug) return;
    if (action === 'skip' && !confirmSkipDespiteLogistics(item)) return;
    try {
      const res = await fetch(
        `/api/events-finder/big-events/${encodeURIComponent(slug)}/${action}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      void refreshBigEventsFromStore();
      void loadEvents();
    } catch (e) {
      console.warn('[big-events] action failed:', action, e?.message || e);
    }
  }

  function openConferenceWatchlistPopout() {
    const wrap = document.createElement('div');
    wrap.className = 'events-finder__event-sources';

    const tabs = document.createElement('div');
    tabs.className = 'events-finder__event-sources-tabs';
    const feedsTab = document.createElement('button');
    feedsTab.type = 'button';
    feedsTab.className = 'events-finder__event-sources-tab events-finder__event-sources-tab--active';
    feedsTab.textContent = 'Event feeds';
    const producersTab = document.createElement('button');
    producersTab.type = 'button';
    producersTab.className = 'events-finder__event-sources-tab';
    producersTab.textContent = 'Producers';
    tabs.append(feedsTab, producersTab);

    const feedsPanel = document.createElement('div');
    feedsPanel.className = 'events-finder__event-sources-panel';
    const producersPanel = document.createElement('div');
    producersPanel.className = 'events-finder__event-sources-panel';
    producersPanel.hidden = true;

    const intro = document.createElement('p');
    intro.className = 'muted';
    intro.textContent = 'Platform feeds — scraped often, filtered by location.';
    const list = document.createElement('ul');
    list.className = 'events-finder__event-sources-list';
    const msg = document.createElement('p');
    msg.className = 'events-finder__big-events-msg muted';
    const labelInput = document.createElement('input');
    labelInput.className = 'events-finder__big-events-input';
    labelInput.placeholder = 'Label';
    const urlInput = document.createElement('input');
    urlInput.className = 'events-finder__big-events-input events-finder__big-events-input--url';
    urlInput.placeholder = 'https://…/events';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'events-finder__big-events-confirm';
    addBtn.textContent = 'Add website';
    const rescrapeBtn = document.createElement('button');
    rescrapeBtn.type = 'button';
    rescrapeBtn.className = 'events-finder__big-events-again';
    rescrapeBtn.textContent = 'Re-scrape listings';
    feedsPanel.append(intro, labelInput, urlInput, addBtn, rescrapeBtn, msg, list);

    const prodIntro = document.createElement('p');
    prodIntro.className = 'muted';
    prodIntro.textContent =
      'Paste an official URL (e.g. burningman.org). Not location-filtered. Double-tap Edit to fix details.';
    const prodUrl = document.createElement('input');
    prodUrl.className = 'events-finder__big-events-input events-finder__big-events-input--url';
    prodUrl.placeholder = 'https://burningman.org/';
    const prodAdd = document.createElement('button');
    prodAdd.type = 'button';
    prodAdd.className = 'events-finder__big-events-confirm';
    prodAdd.textContent = 'Add & scrape';
    const prodMsg = document.createElement('p');
    prodMsg.className = 'events-finder__big-events-msg muted';
    const prodList = document.createElement('div');
    prodList.className = 'events-finder__big-events-mobile-list';
    conferencePopoutStatusList = prodList;
    paintBigEventsTable(conferenceWatchItemsFromPayload(), prodList);
    void refreshBigEventsFromStore();
    producersPanel.append(prodIntro, prodUrl, prodAdd, prodMsg, prodList);

    wrap.append(tabs, feedsPanel, producersPanel);

    function showTab(which) {
      const onFeeds = which === 'feeds';
      feedsPanel.hidden = !onFeeds;
      producersPanel.hidden = onFeeds;
      feedsTab.classList.toggle('events-finder__event-sources-tab--active', onFeeds);
      producersTab.classList.toggle('events-finder__event-sources-tab--active', !onFeeds);
      if (!onFeeds) void refreshBigEventsFromStore();
    }
    feedsTab.addEventListener('click', () => showTab('feeds'));
    producersTab.addEventListener('click', () => showTab('producers'));

    function paint(sources) {
      list.replaceChildren();
      const n = sources.length;
      conferenceToggle.dataset.sourceCount = String(n);
      const p = Number(conferenceToggle.dataset.producerCount || 0);
      const total = n + p;
      conferenceToggle.textContent = total > 0 ? `Event sources (${total})` : 'Event sources';
      if (!sources.length) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = 'No scrape websites yet.';
        list.append(li);
        return;
      }
      for (const src of sources) {
        const li = document.createElement('li');
        li.className = 'events-finder__event-sources-item';
        const a = document.createElement('a');
        a.href = String(src.url || '#');
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = String(src.label || src.url || 'Source');
        li.append(a);
        list.append(li);
      }
    }

    addBtn.addEventListener('click', async () => {
      const raw = String(urlInput.value || '').trim();
      const href = /^https?:\/\//i.test(raw) ? raw : raw ? `https://${raw}` : '';
      const label = labelInput.value.trim() || 'Event source';
      if (!href) return;
      try {
        const res = await fetch('/api/events-finder-sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, url: href }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
        labelInput.value = '';
        urlInput.value = '';
        paint(Array.isArray(data.sources) ? data.sources : []);
        msg.textContent = 'Added.';
      } catch (e) {
        msg.textContent = String(e?.message || e);
      }
    });
    rescrapeBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/events-finder-sources/rescrape', { method: 'POST' });
        msg.textContent = 'Cache cleared — refresh the feed.';
      } catch (e) {
        msg.textContent = String(e?.message || e);
      }
    });
    prodAdd.addEventListener('click', async () => {
      const raw = String(prodUrl.value || '').trim();
      const href = /^https?:\/\//i.test(raw) ? raw : raw ? `https://${raw}` : '';
      if (!href) return;
      prodAdd.disabled = true;
      prodMsg.textContent = 'Scraping…';
      try {
        const res = await fetch('/api/events-finder/big-events/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: href }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        prodUrl.value = '';
        prodMsg.textContent = 'Added — researching dates & tickets…';
        void refreshBigEventsFromStore();
        reloadBigEventsSoon();
      } catch (e) {
        prodMsg.textContent = String(e?.message || e);
      } finally {
        prodAdd.disabled = false;
      }
    });

    openConferencePopout({
      title: 'Event sources',
      body: wrap,
      onClose: () => {
        conferencePopoutStatusList = null;
      },
    });
    void fetch('/api/events-finder-sources', { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
        paint(Array.isArray(data.sources) ? data.sources : []);
      })
      .catch((e) => {
        msg.textContent = String(e?.message || e);
      });
    void fetch('/api/events-finder/big-events/', { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.items)) {
          conferenceToggle.dataset.producerCount = String(data.items.length);
          const n = Number(conferenceToggle.dataset.sourceCount || 0);
          const total = n + data.items.length;
          conferenceToggle.textContent = total > 0 ? `Event sources (${total})` : 'Event sources';
        }
      })
      .catch(() => {});
  }

  conferenceToggle.addEventListener('click', () => {
    if (conferencePopoutBackdrop) closeConferencePopout();
    else openConferenceWatchlistPopout();
  });

  /** @type {ReturnType<typeof setTimeout> | null} */
  let conferenceAutosaveTimer = null;
  conferenceInput.addEventListener('input', () => {
    if (!criteriaReady || applyingCriteria) return;
    if (conferenceAutosaveTimer) clearTimeout(conferenceAutosaveTimer);
    conferenceAutosaveTimer = setTimeout(() => {
      conferenceAutosaveTimer = null;
      void autosaveConferenceWatchlist();
    }, 650);
  });

  const filterActions = document.createElement('div');
  filterActions.className = 'mobile-events__filter-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'mobile-events__filter-save';
  saveBtn.textContent = 'Save';

  const showSkippedBtn = document.createElement('button');
  showSkippedBtn.type = 'button';
  showSkippedBtn.className = 'mobile-events__show-skipped';
  showSkippedBtn.textContent = 'Show skipped';
  showSkippedBtn.title = 'Recover events you accidentally skipped';
  showSkippedBtn.setAttribute('aria-pressed', 'false');

  const filterMsg = document.createElement('p');
  filterMsg.className = 'mobile-events__filter-msg';
  filterMsg.hidden = true;
  filterMsg.setAttribute('aria-live', 'polite');

  filterActions.append(saveBtn, showSkippedBtn, filterMsg);
  filterPanel.append(filterActions);

  const status = document.createElement('p');
  status.className = 'mobile-events__status';
  status.textContent = 'Loading events…';

  const list = document.createElement('div');
  list.className = 'mobile-events__list';

  root.append(toolbar, filterPanel, status, list);

  /** @type {{ lookFor: string, skip: string, blacklist: string, scrape?: object, favoriteEventIds: string[], calendarAddedEventIds: string[], conferenceWatchlist: string[], skippedEvents: object[] } | null} */
  let taste = null;
  /** @type {{ name: string, authuser: string, src: string }} */
  let googleCalendarTarget = { ...DEFAULT_GOOGLE_CALENDAR };
  /** @type {object | null} */
  let lastEventsPayload = null;
  let criteriaReady = false;
  let applyingCriteria = false;
  let saveInFlight = false;
  let showSkipped = readShowSkipped();
  /** @type {Record<string, string>} */
  let titleOverrides = readTitleOverrides();
  /** @type {object[]} */
  let lastFilteredEvents = [];
  /** @type {any} */
  let mapInstance = null;
  /** @type {any} */
  let markersLayer = null;
  /** @type {{ lat: number, lng: number, zoom: number } | null} */
  let mapViewBeforePopup = null;
  let mapDidInitialFit = false;
  let mapSyncGen = 0;
  /** @type {HTMLElement | null} */
  let mapBackdrop = null;
  /** @type {HTMLElement | null} */
  let mapNoteEl = null;
  /** @type {HTMLElement | null} */
  let mapMountEl = null;
  /** @type {((e: KeyboardEvent) => void) | null} */
  let mapKeyHandler = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let filterAutosaveTimer = null;
  let filterAutosaveReload = false;

  filterToggle.addEventListener('click', () => {
    const open = filterPanel.hidden;
    filterPanel.hidden = !open;
    filterToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    filterToggle.classList.toggle('mobile-events__filter-toggle--open', open);
    if (open && !isMobileNavApplying()) {
      pushMobileNav({ tab: 'events', pane: 'list', overlay: 'filters' });
    } else if (!open && history.state?.overlay === 'filters') {
      mobileNavBack();
    }
  });

  /**
   * @param {unknown} raw
   */
  function applyGoogleCalendarConfig(raw) {
    if (!raw || typeof raw !== 'object') return;
    const o = /** @type {Record<string, unknown>} */ (raw);
    googleCalendarTarget = {
      name: String(o.name || '').trim() || DEFAULT_GOOGLE_CALENDAR.name,
      authuser: String(o.authuser || '').trim() || DEFAULT_GOOGLE_CALENDAR.authuser,
      src: String(o.src || '').trim(),
    };
  }

  function syncShowSkippedButton() {
    const n = Array.isArray(taste?.skippedEvents)
      ? taste.skippedEvents.length
      : Number(lastEventsPayload?.skippedCount) || 0;
    showSkippedBtn.textContent = showSkipped
      ? `Hide skipped${n ? ` (${n})` : ''}`
      : `Show skipped${n ? ` (${n})` : ''}`;
    showSkippedBtn.setAttribute('aria-pressed', showSkipped ? 'true' : 'false');
    showSkippedBtn.classList.toggle('mobile-events__show-skipped--on', showSkipped);
  }

  /**
   * @returns {string[]}
   */
  function readConferenceWatchlistFromForm() {
    return String(conferenceInput.value || '')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .slice(0, 30);
  }

  /**
   * @returns {Record<string, unknown> | null}
   */
  function readFiltersFromForm() {
    const originZipDigits = String(zipInput.value || '').replace(/\D/g, '').slice(0, 5);
    if (originZipDigits && originZipDigits.length !== 5) return null;
    const milesRaw = milesInput.value.trim();
    const maxMiles = milesRaw === '' ? 25 : Number(milesRaw);
    if (!Number.isFinite(maxMiles) || maxMiles <= 0 || maxMiles > 100) return null;
    const earliestRaw = String(timeInput.value || '').trim();
    if (earliestRaw && !normalizeLocalTime(earliestRaw)) return null;
    const available = lastEventsPayload ? citiesFromPayload(lastEventsPayload) : [];
    const selected = cityChecks.getSelected();
    const cities =
      available.length && selected.length && selected.length < available.length
        ? selected
        : [];
    const range = calendar.getRange();
    return {
      cities,
      maxMiles,
      dates: range.dates || [],
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      earliestLocalTime: normalizeLocalTime(earliestRaw) || null,
      attendance: attendanceChecks.getAttendance(),
      showBigEvents: bigEventsChecks.getShowBigEvents(),
      originZip: originZipDigits || null,
    };
  }

  /**
   * @param {object} data
   */
  function applyFiltersToForm(data) {
    applyingCriteria = true;
    try {
      const filters = data.filters && typeof data.filters === 'object' ? data.filters : {};
      const miles = filters.maxMiles;
      milesInput.value = miles == null || miles === '' ? '25' : String(miles);
      zipInput.value =
        typeof filters.originZip === 'string' && filters.originZip
          ? filters.originZip
          : typeof data.geo?.zip === 'string' && data.geo.zip
            ? data.geo.zip
            : '';
      calendar.setRange(
        filters.dateFrom || null,
        filters.dateTo || null,
        filters.dates || [],
      );
      timeInput.value = normalizeLocalTime(filters.earliestLocalTime) || '';
      attendanceChecks.setAttendance(filters.attendance || 'any');
      bigEventsChecks.setShowBigEvents(filters.showBigEvents !== false);
      if (Array.isArray(filters.cities) && filters.cities.length) {
        savedCitySelection = filters.cities.map(String);
      } else {
        savedCitySelection = null;
      }
    } finally {
      applyingCriteria = false;
    }
  }

  /**
   * @param {object} data
   */
  function applyTaste(data) {
    taste = {
      lookFor: typeof data.lookFor === 'string' ? data.lookFor : '',
      skip: typeof data.skip === 'string' ? data.skip : '',
      blacklist: typeof data.blacklist === 'string' ? data.blacklist : '',
      scrape: data.scrape && typeof data.scrape === 'object' ? data.scrape : undefined,
      favoriteEventIds: Array.isArray(data.favoriteEventIds)
        ? data.favoriteEventIds.map(String)
        : [],
      calendarAddedEventIds: Array.isArray(data.calendarAddedEventIds)
        ? data.calendarAddedEventIds.map(String)
        : [],
      conferenceWatchlist: Array.isArray(data.conferenceWatchlist)
        ? data.conferenceWatchlist.map(String)
        : [],
      skippedEvents: Array.isArray(data.skippedEvents) ? data.skippedEvents : [],
    };
    applyGoogleCalendarConfig(data.googleCalendar);
    applyFiltersToForm(data);
    conferenceInput.value = (taste.conferenceWatchlist || []).join('\n');
    syncConferenceToggleLabel();
    criteriaReady = true;
    syncShowSkippedButton();
  }

  /**
   * @param {{ lookFor?: string, skip?: string, blacklist?: string, skippedEvents?: object[], unskipEventIds?: string[], favoriteEventIds?: string[], calendarAddedEventIds?: string[], conferenceWatchlist?: string[], includeFilters?: boolean, silent?: boolean }} [patch]
   * @returns {Promise<boolean>}
   */
  async function saveCriteria(patch = {}) {
    if (!criteriaReady || !taste) return false;
    if (saveInFlight) {
      const started = Date.now();
      while (saveInFlight && Date.now() - started < 4000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (saveInFlight) return false;
    }
    saveInFlight = true;
    const silent = patch.silent !== false;
    if (!silent) {
      saveBtn.disabled = true;
      filterMsg.hidden = false;
      filterMsg.classList.remove('mobile-events__filter-msg--err');
      filterMsg.textContent = 'Saving…';
    }
    try {
      /** @type {Record<string, unknown>} */
      const body = {
        lookFor: patch.lookFor !== undefined ? patch.lookFor : taste.lookFor,
        skip: patch.skip !== undefined ? patch.skip : taste.skip,
        blacklist: patch.blacklist !== undefined ? patch.blacklist : taste.blacklist,
        scrape: taste.scrape,
      };
      // Only write favorites / calendar-added when this patch intends to change them.
      // Filter autosave must omit these so it cannot clobber a concurrent heart / Cal tap.
      if (patch.favoriteEventIds !== undefined) {
        body.favoriteEventIds = patch.favoriteEventIds;
      }
      if (patch.calendarAddedEventIds !== undefined) {
        body.calendarAddedEventIds = patch.calendarAddedEventIds;
      }
      if (patch.conferenceWatchlist !== undefined) {
        body.conferenceWatchlist = patch.conferenceWatchlist;
      }
      if (patch.includeFilters) {
        const filters = readFiltersFromForm();
        if (!filters) {
          throw new Error('Check ZIP (5 digits), radius (1–100), and earliest time.');
        }
        body.filters = filters;
      }
      if (Array.isArray(patch.unskipEventIds) && patch.unskipEventIds.length) {
        body.unskipEventIds = patch.unskipEventIds.map(String).filter(Boolean);
      }
      if (patch.skippedEvents !== undefined) {
        body.skippedEvents = patch.skippedEvents;
        body.hiddenEventIds = patch.skippedEvents.map((s) => String(s?.id || '')).filter(Boolean);
      }
      const r = await fetch('/api/events-finder-criteria', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      if (typeof data.lookFor === 'string') taste.lookFor = data.lookFor;
      if (typeof data.skip === 'string') taste.skip = data.skip;
      if (typeof data.blacklist === 'string') taste.blacklist = data.blacklist;
      if (data.scrape && typeof data.scrape === 'object') taste.scrape = data.scrape;
      if (Array.isArray(data.favoriteEventIds)) {
        taste.favoriteEventIds = data.favoriteEventIds.map(String);
      } else if (patch.favoriteEventIds) {
        taste.favoriteEventIds = patch.favoriteEventIds.map(String);
      }
      if (Array.isArray(data.calendarAddedEventIds)) {
        taste.calendarAddedEventIds = data.calendarAddedEventIds.map(String);
      } else if (patch.calendarAddedEventIds) {
        taste.calendarAddedEventIds = patch.calendarAddedEventIds.map(String);
      }
      if (Array.isArray(data.conferenceWatchlist)) {
        taste.conferenceWatchlist = data.conferenceWatchlist.map(String);
      } else if (patch.conferenceWatchlist) {
        taste.conferenceWatchlist = patch.conferenceWatchlist.map(String);
      }
      if (Array.isArray(data.skippedEvents)) {
        taste.skippedEvents = data.skippedEvents;
      }
      if (data.filters && typeof data.filters === 'object' && patch.includeFilters) {
        applyFiltersToForm({ ...data, geo: data.geo });
      }
      writePanelCache(CRITERIA_CACHE_KEY, {
        lookFor: taste.lookFor,
        skip: taste.skip,
        blacklist: taste.blacklist,
        scrape: taste.scrape,
        filters: data.filters || body.filters,
        favoriteEventIds: taste.favoriteEventIds,
        calendarAddedEventIds: taste.calendarAddedEventIds,
        conferenceWatchlist: taste.conferenceWatchlist,
        skippedEvents: taste.skippedEvents,
        googleCalendar: googleCalendarTarget,
      });
      if (patch.conferenceWatchlist !== undefined) {
        conferenceInput.value = (taste.conferenceWatchlist || []).join('\n');
    syncConferenceToggleLabel();
      }
      syncShowSkippedButton();
      if (!silent) {
        filterMsg.textContent = 'Saved';
        filterPanel.hidden = true;
        filterToggle.setAttribute('aria-expanded', 'false');
        filterToggle.classList.remove('mobile-events__filter-toggle--open');
        setTimeout(() => {
          if (filterMsg.textContent === 'Saved') filterMsg.hidden = true;
        }, 1500);
      }
      return true;
    } catch (e) {
      if (!silent) {
        filterMsg.hidden = false;
        filterMsg.classList.add('mobile-events__filter-msg--err');
        filterMsg.textContent = e?.message || String(e);
      }
      return false;
    } finally {
      saveInFlight = false;
      if (!silent) saveBtn.disabled = false;
    }
  }

  /**
   * @param {{ reload?: boolean }} [opts]
   */
  function scheduleFilterAutosave(opts = {}) {
    if (applyingCriteria || !criteriaReady) return;
    if (opts.reload) filterAutosaveReload = true;
    if (filterAutosaveTimer) clearTimeout(filterAutosaveTimer);
    filterAutosaveTimer = setTimeout(async () => {
      filterAutosaveTimer = null;
      const shouldReload = filterAutosaveReload;
      filterAutosaveReload = false;
      const ok = await saveCriteria({ includeFilters: true, silent: true });
      if (ok && shouldReload) void loadEvents();
      else if (ok && lastEventsPayload) paint(lastEventsPayload);
    }, 650);
  }

  /**
   * @param {HTMLButtonElement} favBtn
   * @param {boolean} on
   */
  function paintFavButton(favBtn, on) {
    favBtn.classList.toggle('mobile-events__fav--on', on);
    favBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    favBtn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
    favBtn.title = on ? 'Remove favorite' : 'Favorite';
    favBtn.textContent = on ? '♥' : '♡';
  }

  /**
   * @param {HTMLAnchorElement} calBtn
   * @param {boolean} added
   */
  function paintCalButton(calBtn, added) {
    const calName = googleCalendarTarget.name || 'Random Events';
    calBtn.classList.toggle('mobile-events__action--cal-added', added);
    if (added) {
      calBtn.textContent = 'Added to Cal';
      calBtn.setAttribute('aria-label', `Already added to ${calName}`);
      calBtn.title = `Already on ${calName}`;
    } else {
      calBtn.textContent = 'Add to Cal';
      calBtn.setAttribute('aria-label', `Add to ${calName}`);
      calBtn.title = `Add to ${calName}`;
    }
  }

  /**
   * @param {object} ev
   * @param {HTMLButtonElement} favBtn
   */
  async function toggleFavorite(ev, favBtn) {
    const id = String(ev.id || '').trim();
    if (!id || !taste || !criteriaReady) return;
    if (favBtn.dataset.busy === '1') return;
    favBtn.dataset.busy = '1';
    favBtn.disabled = true;

    const prev = [...taste.favoriteEventIds];
    const nextOn = !prev.includes(id);
    const nextFavs = nextOn ? [...prev, id] : prev.filter((x) => x !== id);
    taste.favoriteEventIds = nextFavs;
    paintFavButton(favBtn, nextOn);

    const ok = await saveCriteria({ favoriteEventIds: nextFavs, silent: true });
    if (!ok) {
      taste.favoriteEventIds = prev;
      paintFavButton(favBtn, prev.includes(id));
    }

    favBtn.disabled = false;
    delete favBtn.dataset.busy;
  }

  /**
   * @param {object} ev
   */
  async function hideEvent(ev) {
    const id = String(ev.id || '').trim();
    if (!id || !taste || !criteriaReady) return;
    if (!confirmSkipDespiteLogistics(ev)) return;
    const record = skippedRecordFromEvent(ev);
    if (!record) return;
    /** @type {object[]} */
    const skipBatch = [record];
    const seriesKey = String(record.seriesKey || '').trim();
    if (seriesKey) {
      skipBatch.push({
        id: `series:${seriesKey}`.slice(0, 400),
        key: null,
        url: null,
        title: record.title,
        start: record.start,
        source: record.source,
        venue: record.venue,
        city: record.city,
        imageUrl: record.imageUrl,
        seriesKey,
        skippedAt: record.skippedAt,
      });
    }
    const batchIds = new Set(skipBatch.map((s) => String(s?.id || '')).filter(Boolean));
    const prevSkipped = [...taste.skippedEvents];
    taste.skippedEvents = [
      ...skipBatch,
      ...prevSkipped.filter((s) => !batchIds.has(String(s?.id || ''))),
    ];
    if (lastEventsPayload && Array.isArray(lastEventsPayload.events)) {
      lastEventsPayload = {
        ...lastEventsPayload,
        events: lastEventsPayload.events.filter(
          (e) => !skipBatch.some((rec) => eventMatchesSkipRecord(e, rec)),
        ),
        skippedEvents: [
          { ...ev, skipped: true, skippedAt: record.skippedAt },
          ...(Array.isArray(lastEventsPayload.skippedEvents)
            ? lastEventsPayload.skippedEvents.filter((e) => !batchIds.has(String(e?.id || '')))
            : []),
        ],
        skippedCount: taste.skippedEvents.length,
      };
      paint(lastEventsPayload);
    }
    const ok = await saveCriteria({ skippedEvents: skipBatch, silent: true });
    if (!ok) {
      taste.skippedEvents = prevSkipped;
      void loadEvents();
    } else {
      if (lastEventsPayload) writePanelCache(EVENTS_CACHE_KEY, lastEventsPayload);
      syncShowSkippedButton();
    }
  }

  /**
   * @param {object} ev
   */
  async function unskipEvent(ev) {
    const id = String(ev.id || '').trim();
    if (!id || !taste || !criteriaReady) return;
    const prevSkipped = [...taste.skippedEvents];
    taste.skippedEvents = prevSkipped.filter((s) => String(s?.id || '') !== id);
    if (lastEventsPayload) {
      lastEventsPayload = {
        ...lastEventsPayload,
        skippedEvents: (Array.isArray(lastEventsPayload.skippedEvents)
          ? lastEventsPayload.skippedEvents
          : []
        ).filter((e) => String(e?.id || '') !== id),
        skippedCount: taste.skippedEvents.length,
      };
      paint(lastEventsPayload);
    }
    const ok = await saveCriteria({ unskipEventIds: [id], silent: true });
    if (!ok) {
      taste.skippedEvents = prevSkipped;
    } else if (lastEventsPayload) {
      writePanelCache(EVENTS_CACHE_KEY, lastEventsPayload);
    }
    syncShowSkippedButton();
    void loadEvents();
  }

  /**
   * @param {object} ev
   * @param {HTMLAnchorElement} calBtn
   */
  async function markCalendarAdded(ev, calBtn) {
    const id = String(ev.id || '').trim();
    if (!id || !taste || !criteriaReady) return;
    const prev = [...taste.calendarAddedEventIds];
    if (prev.includes(id)) {
      paintCalButton(calBtn, true);
      if (lastEventsPayload && Array.isArray(lastEventsPayload.events) && !showSkipped) {
        lastEventsPayload = {
          ...lastEventsPayload,
          events: lastEventsPayload.events.filter((e) => String(e?.id || '') !== id),
        };
        paint(lastEventsPayload);
      }
      return;
    }
    const next = [...prev, id];
    taste.calendarAddedEventIds = next;
    paintCalButton(calBtn, true);
    if (lastEventsPayload && Array.isArray(lastEventsPayload.events) && !showSkipped) {
      lastEventsPayload = {
        ...lastEventsPayload,
        events: lastEventsPayload.events.filter((e) => String(e?.id || '') !== id),
      };
      paint(lastEventsPayload);
    }
    const ok = await saveCriteria({ calendarAddedEventIds: next, silent: true });
    if (!ok) {
      taste.calendarAddedEventIds = prev;
      void loadEvents();
    }
  }

  async function autosaveConferenceWatchlist() {
    const ok = await saveCriteria({
      silent: true,
      conferenceWatchlist: readConferenceWatchlistFromForm(),
    });
    if (ok) void loadEvents();
    return ok;
  }

  /**
   * @param {object} item
   */
  function openConferenceDetailPopout(item) {
    const eventUrl = String(item.homepageUrl || item.url || '').trim();
    const ticketHref = String(item.ticketUrl || '').trim();
    const body = document.createElement('div');
    body.className = 'events-finder__conference-detail';

    const title = document.createElement('h3');
    title.className = 'events-finder__conference-detail-title';
    const detailTitleText = String(item.title || item.query || 'Big event');
    if (eventUrl) {
      const titleLink = document.createElement('a');
      titleLink.className = 'events-finder__card-title-link';
      titleLink.href = eventUrl;
      titleLink.target = '_blank';
      titleLink.rel = 'noopener noreferrer';
      titleLink.textContent = detailTitleText;
      title.append(titleLink);
    } else {
      title.textContent = detailTitleText;
    }
    body.append(title);

    const detailImage = item.flierImageUrl || item.flierUrl || item.screenshotUrl;
    if (detailImage) {
      const shot = document.createElement('img');
      shot.className = 'events-finder__conference-detail-shot';
      shot.src = String(detailImage);
      shot.alt = `Flier for ${item.title || item.query}`;
      shot.loading = 'lazy';
      body.append(shot);
    }

    const whenEl = document.createElement('p');
    whenEl.className = 'events-finder__conference-detail-when';
    whenEl.textContent = String(item.whenLabel || 'Dates TBD');
    body.append(whenEl);

    if (item.placeLabel) {
      const placeEl = document.createElement('p');
      placeEl.className = 'events-finder__conference-detail-place';
      placeEl.textContent = String(item.placeLabel);
      body.append(placeEl);
    }

    if (item.salesStatus) {
      const statusWrap = document.createElement('p');
      statusWrap.className = 'events-finder__conference-detail-place';
      const statusPill = document.createElement('span');
      statusPill.className = `events-finder__big-events-status events-finder__big-events-status--${item.salesStatusKind || 'unknown'}`;
      statusPill.textContent = String(item.salesStatus);
      statusWrap.append(statusPill);
      body.append(statusWrap);
    }

    const ticket = document.createElement('p');
    ticket.className = 'mobile-events__conference-ticket';
    if (item.researching) {
      ticket.textContent = 'Looking up dates and tickets…';
      ticket.classList.add('muted');
    } else if (item.ticketLabel) {
      ticket.textContent = String(item.ticketLabel);
    } else if (item.error) {
      ticket.textContent = 'Could not find ticket details yet — will retry.';
      ticket.classList.add('muted');
    } else {
      ticket.textContent = 'Ticket price not found yet.';
      ticket.classList.add('muted');
    }
    body.append(ticket);

    if (item.earlyBirdNote) {
      const ebNote = document.createElement('p');
      ebNote.className = 'mobile-events__conference-ticket events-finder__conference-ticket--active';
      ebNote.textContent = String(item.earlyBirdNote);
      body.append(ebNote);
    } else if (item.earlyBirdLine && item.earlyBirdKind !== 'price') {
      const ebNote = document.createElement('p');
      ebNote.className = 'mobile-events__conference-ticket';
      if (item.earlyBirdKind === 'active') {
        ebNote.classList.add('events-finder__conference-ticket--active');
      }
      ebNote.textContent = String(item.earlyBirdLine);
      body.append(ebNote);
    }

    if (item.salesStartLine) {
      const sl = document.createElement('p');
      sl.className = 'mobile-events__conference-ticket';
      sl.textContent = String(item.salesStartLine);
      body.append(sl);
    }

    if (item.earlyBirdStart || item.earlyBirdEnd) {
      const eb = document.createElement('dl');
      eb.className = 'events-finder__conference-detail-dates';
      if (item.earlyBirdStart) {
        const dt = document.createElement('dt');
        dt.textContent = 'Early bird starts';
        const dd = document.createElement('dd');
        dd.textContent = String(item.earlyBirdStart);
        eb.append(dt, dd);
      }
      if (item.earlyBirdEnd) {
        const dt = document.createElement('dt');
        dt.textContent = 'Early bird ends';
        const dd = document.createElement('dd');
        dd.textContent = String(item.earlyBirdEnd);
        eb.append(dt, dd);
      }
      body.append(eb);
    }

    if (item.notes && !item.researching) {
      const notesEl = document.createElement('p');
      notesEl.className = 'events-finder__conference-detail-notes';
      notesEl.textContent = String(item.notes);
      body.append(notesEl);
    }

    if (eventUrl || ticketHref) {
      const links = document.createElement('div');
      links.className = 'events-finder__conference-detail-links';
      if (eventUrl) {
        const link = document.createElement('a');
        link.className = 'events-finder__conference-detail-link';
        link.href = eventUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Official site';
        links.append(link);
      }
      if (ticketHref && ticketHref !== eventUrl) {
        const tlink = document.createElement('a');
        tlink.className = 'events-finder__conference-detail-link events-finder__conference-detail-link--tickets';
        tlink.href = ticketHref;
        tlink.target = '_blank';
        tlink.rel = 'noopener noreferrer';
        tlink.textContent = 'Tickets ↗';
        links.append(tlink);
      }
      body.append(links);
    }

    if (item.skipped || item.snoozed) {
      const hiddenNote = document.createElement('p');
      hiddenNote.className = 'events-finder__conference-ticket muted';
      hiddenNote.textContent = item.skipped
        ? 'Skipped — hidden from the events feed.'
        : `Snoozed — hidden from the feed until ${formatWhen(item.snoozedUntil) || 'later'}.`;
      body.append(hiddenNote);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'events-finder__conference-detail-link';
      restore.textContent = 'Restore to feed';
      restore.addEventListener('click', () => {
        void bigEventCardAction(item, 'restore');
        closeConferencePopout();
      });
      body.append(restore);
    }

    openConferencePopout({
      title: String(item.title || item.query || 'Conference'),
      body,
    });
  }

  /**
   * Rename an event locally. No cross-device sync until a backend title-override
   * field exists (see summary note); overrides persist in localStorage.
   * @param {string} eventId
   * @param {string} nextTitle
   * @param {string} baseTitle
   */
  function saveTitleOverride(eventId, nextTitle, baseTitle) {
    const trimmed = String(nextTitle || '').trim();
    if (!trimmed || trimmed === baseTitle) {
      delete titleOverrides[eventId];
    } else {
      titleOverrides[eventId] = trimmed;
    }
    writeTitleOverrides(titleOverrides);
  }

  /**
   * Event names are display-only until a double-click (desktop) or long-press
   * (touch) opens an inline editor.
   * @param {HTMLElement} displayEl
   * @param {object} ev
   * @param {HTMLElement} headEl
   */
  function attachTitleEdit(displayEl, ev, headEl) {
    const eventId = String(ev.id || '').trim();
    if (!eventId) return;
    const baseTitle = String(ev.title || '').trim() || 'Untitled event';
    displayEl.classList.add('mobile-events__title--editable');
    displayEl.title = 'Double-click or long-press to rename';

    const beginEdit = () => {
      if (headEl.dataset.editing === '1') return;
      headEl.dataset.editing = '1';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'mobile-events__title-edit';
      input.value = displayEl.textContent || baseTitle;

      const editActions = document.createElement('div');
      editActions.className = 'mobile-events__title-edit-actions';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'mobile-events__title-edit-save';
      saveBtn.textContent = 'Save';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'mobile-events__title-edit-cancel';
      cancelBtn.textContent = 'Cancel';
      editActions.append(saveBtn, cancelBtn);

      const wrap = document.createElement('div');
      wrap.className = 'mobile-events__title-edit-wrap';
      wrap.append(input, editActions);
      wrap.addEventListener('click', (e) => e.stopPropagation());

      displayEl.replaceWith(wrap);
      input.focus();
      input.select();

      const restore = () => {
        wrap.replaceWith(displayEl);
        headEl.dataset.editing = '';
      };
      const commit = () => {
        const value = input.value.trim();
        saveTitleOverride(eventId, value, baseTitle);
        displayEl.textContent = value || baseTitle;
        restore();
      };
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        restore();
      });
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        commit();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          restore();
        }
      });
    };

    const eventUrl = String(ev.url || '').trim();
    let lastPointerType = 'mouse';
    let longPressed = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let openTimer = null;
    const cancelOpen = () => {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
    };

    displayEl.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelOpen();
      beginEdit();
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
      lastPointerType = e.pointerType || 'mouse';
      if (e.pointerType === 'mouse') return;
      longPressed = false;
      cancelPress();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        longPressed = true;
        beginEdit();
      }, 500);
    });
    displayEl.addEventListener('pointermove', cancelPress);
    displayEl.addEventListener('pointerup', cancelPress);
    displayEl.addEventListener('pointercancel', cancelPress);

    displayEl.addEventListener('click', (e) => {
      // Long-press on a link would otherwise navigate on release.
      if (longPressed) {
        e.preventDefault();
        e.stopPropagation();
        longPressed = false;
        return;
      }
      // Mouse: defer opening briefly so a double-click edits instead of opening a tab.
      if (lastPointerType === 'mouse' && eventUrl) {
        e.preventDefault();
        e.stopPropagation();
        cancelOpen();
        openTimer = setTimeout(() => {
          openTimer = null;
          window.open(eventUrl, '_blank', 'noopener,noreferrer');
        }, 220);
      }
    });
  }

  /**
   * Thumbs up/down taste feedback — mirrors the desktop preference modal.
   * @param {object} ev
   * @param {'up' | 'down'} vibe
   */
  function openPreferenceModal(ev, vibe) {
    const wantMore = vibe === 'up';
    const backdrop = document.createElement('div');
    backdrop.className = 'events-finder__modal-backdrop';
    const modal = document.createElement('div');
    modal.className = wantMore
      ? 'events-finder__modal'
      : 'events-finder__modal events-finder__modal--taste-down';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const title = document.createElement('h3');
    title.className = 'events-finder__modal-title';
    title.textContent = wantMore ? 'See more like this?' : 'See less like this?';

    const hint = document.createElement('p');
    hint.className = 'events-finder__modal-hint';
    hint.textContent = wantMore
      ? 'Add ideas to Look for (one per line). These steer discovery toward similar events.'
      : 'This event is skipped. Add grey-list and/or black-list words (one per line). Grey hides only when no Look for word matches; black always hides.';

    const eventLabel = document.createElement('p');
    eventLabel.className = 'events-finder__modal-event';
    eventLabel.textContent = ev.title || 'Untitled event';

    /** @type {HTMLTextAreaElement} */
    let area;
    /** @type {HTMLTextAreaElement | null} */
    let greyArea = null;
    /** @type {HTMLTextAreaElement | null} */
    let blackArea = null;
    /** @type {HTMLElement[]} */
    const fieldNodes = [];

    if (wantMore) {
      area = document.createElement('textarea');
      area.className = 'events-finder__modal-textarea';
      area.rows = 6;
      area.spellcheck = true;
      area.placeholder = 'One idea per line…';
      area.value = suggestPreferenceLines(ev, vibe);
      fieldNodes.push(area);
    } else {
      const suggested = suggestPreferenceLines(ev, vibe);

      const greyLabel = document.createElement('label');
      greyLabel.className = 'events-finder__modal-field-label';
      greyLabel.htmlFor = 'mobile-events-pref-grey';
      greyLabel.textContent = 'Grey list';
      const greyHint = document.createElement('p');
      greyHint.className = 'events-finder__modal-field-hint';
      greyHint.textContent = 'Hide matching events only if no Look for word also matches.';
      greyArea = document.createElement('textarea');
      greyArea.id = 'mobile-events-pref-grey';
      greyArea.className = 'events-finder__modal-textarea events-finder__modal-textarea--compact';
      greyArea.rows = 4;
      greyArea.spellcheck = true;
      greyArea.placeholder = 'One idea per line…';
      greyArea.value = suggested;

      const blackLabel = document.createElement('label');
      blackLabel.className = 'events-finder__modal-field-label';
      blackLabel.htmlFor = 'mobile-events-pref-black';
      blackLabel.textContent = 'Black list';
      const blackHint = document.createElement('p');
      blackHint.className = 'events-finder__modal-field-hint';
      blackHint.textContent = 'Always hide matching events, even if a Look for word matches.';
      blackArea = document.createElement('textarea');
      blackArea.id = 'mobile-events-pref-black';
      blackArea.className = 'events-finder__modal-textarea events-finder__modal-textarea--compact';
      blackArea.rows = 4;
      blackArea.spellcheck = true;
      blackArea.placeholder = 'One idea per line…';
      blackArea.value = '';

      fieldNodes.push(greyLabel, greyHint, greyArea, blackLabel, blackHint, blackArea);
      area = greyArea;
    }

    const msg = document.createElement('p');
    msg.className = 'events-finder__modal-msg';
    msg.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'events-finder__modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'events-finder__modal-btn';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'events-finder__modal-btn events-finder__modal-btn--primary';
    save.textContent = wantMore ? 'Add to Look for' : 'Skip event';

    const close = () => backdrop.remove();
    cancel.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    save.addEventListener('click', async () => {
      if (!criteriaReady || !taste) {
        msg.hidden = false;
        msg.textContent = 'Filters still loading — try again in a moment.';
        return;
      }
      const lookAdditions = wantMore ? area.value : '';
      const greyAdditions = wantMore ? '' : (greyArea?.value || '');
      const blackAdditions = wantMore ? '' : (blackArea?.value || '');
      const hasLook = Boolean(String(lookAdditions).trim());
      const hasGrey = Boolean(String(greyAdditions).trim());
      const hasBlack = Boolean(String(blackAdditions).trim());
      if (wantMore && !hasLook) {
        msg.hidden = false;
        msg.textContent = 'Add at least one preference line.';
        return;
      }
      save.disabled = true;
      msg.hidden = false;
      msg.textContent = 'Saving…';

      const nextLook = wantMore
        ? mergeTasteLines(taste.lookFor ?? '', lookAdditions)
        : taste.lookFor ?? '';
      const nextSkip = wantMore
        ? taste.skip ?? ''
        : hasGrey
          ? mergeTasteLines(taste.skip ?? '', greyAdditions)
          : taste.skip ?? '';
      const nextBlacklist = wantMore
        ? taste.blacklist ?? ''
        : hasBlack
          ? mergeTasteLines(taste.blacklist ?? '', blackAdditions)
          : taste.blacklist ?? '';

      /** @type {{ lookFor: string, skip: string, blacklist: string, skippedEvents?: object[], silent: boolean }} */
      const patch = {
        lookFor: nextLook,
        skip: nextSkip,
        blacklist: nextBlacklist,
        silent: true,
      };

      const prevSkipped = [...taste.skippedEvents];
      // Thumbs-down also skips this event, tagging it with the new grey/black words.
      if (!wantMore) {
        const record = skippedRecordFromEvent(ev);
        if (record) {
          if (hasGrey) record.tasteGrey = tasteLinesFromBlock(greyAdditions);
          if (hasBlack) record.tasteBlack = tasteLinesFromBlock(blackAdditions);
          const skipBatch = [record];
          patch.skippedEvents = skipBatch;
          const batchIds = new Set(skipBatch.map((s) => String(s?.id || '')).filter(Boolean));
          taste.skippedEvents = [
            ...skipBatch,
            ...prevSkipped.filter((s) => !batchIds.has(String(s?.id || ''))),
          ];
          if (lastEventsPayload && Array.isArray(lastEventsPayload.events)) {
            lastEventsPayload = {
              ...lastEventsPayload,
              events: lastEventsPayload.events.filter(
                (e) => !eventMatchesSkipRecord(e, record),
              ),
              skippedCount: taste.skippedEvents.length,
            };
            paint(lastEventsPayload);
          }
        }
      }

      const ok = await saveCriteria(patch);
      if (!ok) {
        taste.skippedEvents = prevSkipped;
        msg.textContent = 'Could not save preferences.';
        save.disabled = false;
        return;
      }
      close();
      void loadEvents();
    });

    actions.append(cancel, save);
    modal.append(title, hint, eventLabel, ...fieldNodes, msg, actions);
    backdrop.append(modal);
    document.body.append(backdrop);
    area.focus();
  }

  /**
   * @param {object} ev
   * @returns {{ lat: number, lon: number } | null}
   */
  function eventCoords(ev) {
    const lat = Number(ev?.lat);
    const lon = Number(ev?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    // Null Island (0,0) = missing geo from APIs — do not pin the map in the Atlantic.
    if (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01) return null;
    return { lat, lon };
  }

  /** Round coords so near-identical venue pins group together (~11 m). */
  function coordGroupKey(lat, lon) {
    return `${lat.toFixed(4)},${lon.toFixed(4)}`;
  }

  /**
   * Fan co-located pins into a small circle so each is tappable.
   * @param {number} lat
   * @param {number} lon
   * @param {number} index
   * @param {number} total
   * @returns {[number, number]}
   */
  function offsetCoLocatedPin(lat, lon, index, total) {
    if (total <= 1) return [lat, lon];
    const radiusM = 28 + Math.max(0, total - 4) * 6;
    const angle = (2 * Math.PI * index) / total - Math.PI / 2;
    const metersPerDegLat = 111320;
    const metersPerDegLon = Math.max(1e-6, 111320 * Math.cos((lat * Math.PI) / 180));
    return [
      lat + (radiusM * Math.sin(angle)) / metersPerDegLat,
      lon + (radiusM * Math.cos(angle)) / metersPerDegLon,
    ];
  }

  /**
   * @param {object} ev
   * @returns {HTMLElement}
   */
  function buildMapPopup(ev) {
    const wrap = document.createElement('div');
    wrap.className = 'events-finder__map-popup';
    wrap.append(buildCard(ev, { mapPopup: true }));
    return wrap;
  }

  /**
   * @param {object[]} events
   * @param {object | null} data
   * @returns {Promise<void>}
   */
  function syncMap(events, data) {
    if (!mapBackdrop || !mapMountEl) return Promise.resolve();
    const gen = ++mapSyncGen;
    const mappable = events.filter((ev) => eventCoords(ev));
    const unmapped = events.length - mappable.length;
    if (mapNoteEl) {
      mapNoteEl.hidden = false;
      if (!events.length) {
        mapNoteEl.textContent = 'No events to show on the map.';
      } else if (!mappable.length) {
        mapNoteEl.textContent = 'No mapped locations for these events (missing coordinates).';
      } else if (unmapped > 0) {
        mapNoteEl.textContent = `${mappable.length} on map · ${unmapped} without coordinates`;
      } else {
        mapNoteEl.textContent = `${mappable.length} event${mappable.length === 1 ? '' : 's'} on map`;
      }
    }
    if (!mappable.length) {
      if (markersLayer) markersLayer.clearLayers();
      return Promise.resolve();
    }

    return loadLeaflet()
      .then((L) => {
        if (gen !== mapSyncGen || !mapBackdrop || !mapMountEl) return;
        if (!mapInstance) {
          mapInstance = L.map(mapMountEl, {
            zoomControl: true,
            attributionControl: false,
          });
          L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            attribution: '',
            subdomains: 'abcd',
            maxZoom: 18,
            minZoom: 3,
          }).addTo(mapInstance);
          markersLayer = L.layerGroup().addTo(mapInstance);
          mapInstance.on('popupclose', () => {
            const saved = mapViewBeforePopup;
            if (!saved) return;
            requestAnimationFrame(() => {
              if (!mapInstance) return;
              if (mapInstance.isPopupOpen()) return;
              mapViewBeforePopup = null;
              mapInstance.setView([saved.lat, saved.lng], saved.zoom, { animate: true });
            });
          });
        }
        markersLayer.clearLayers();
        /** @type {Map<string, { ev: object, c: { lat: number, lon: number } }[]>} */
        const byLocation = new Map();
        for (const ev of mappable) {
          const c = eventCoords(ev);
          if (!c) continue;
          const key = coordGroupKey(c.lat, c.lon);
          let group = byLocation.get(key);
          if (!group) {
            group = [];
            byLocation.set(key, group);
          }
          group.push({ ev, c });
        }
        /** @type {any[]} */
        const latLngs = [];
        for (const group of byLocation.values()) {
          const total = group.length;
          group.forEach(({ ev, c }, index) => {
            const ll = offsetCoLocatedPin(c.lat, c.lon, index, total);
            latLngs.push(ll);
            if (total > 1) {
              L.polyline([[c.lat, c.lon], ll], {
                color: '#6ec8ff',
                weight: 1.5,
                opacity: 0.55,
                interactive: false,
              }).addTo(markersLayer);
            }
            const marker = L.circleMarker(ll, {
              radius: 8,
              color: '#6ec8ff',
              weight: 2,
              fillColor: '#7bffce',
              fillOpacity: 0.85,
            });
            marker.on('click', () => {
              if (!mapInstance || mapViewBeforePopup) return;
              const center = mapInstance.getCenter();
              mapViewBeforePopup = {
                lat: center.lat,
                lng: center.lng,
                zoom: mapInstance.getZoom(),
              };
            });
            marker.bindPopup(buildMapPopup(ev), {
              maxWidth: 320,
              minWidth: 260,
              className: 'events-finder__map-popup-tip',
              autoPanPadding: [24, 24],
            });
            markersLayer.addLayer(marker);
          });
        }
        const homeLat = Number(data?.geo?.lat);
        const homeLon = Number(data?.geo?.lon);
        if (!mapDidInitialFit) {
          const fit = () => {
            if (gen !== mapSyncGen || !mapInstance) return;
            mapInstance.invalidateSize();
            if (latLngs.length === 1) {
              mapInstance.setView(latLngs[0], 13);
            } else if (latLngs.length > 1) {
              mapInstance.fitBounds(L.latLngBounds(latLngs).pad(0.18), { maxZoom: 14 });
            } else if (Number.isFinite(homeLat) && Number.isFinite(homeLon)) {
              mapInstance.setView([homeLat, homeLon], 11);
            }
            mapDidInitialFit = true;
          };
          requestAnimationFrame(() => {
            fit();
            setTimeout(fit, 50);
            setTimeout(fit, 200);
          });
        } else {
          requestAnimationFrame(() => mapInstance?.invalidateSize());
        }
      })
      .catch(() => {
        if (gen !== mapSyncGen || !mapNoteEl) return;
        mapNoteEl.hidden = false;
        mapNoteEl.textContent = 'Could not load map library.';
      });
  }

  function destroyMapInstance() {
    mapSyncGen += 1;
    mapViewBeforePopup = null;
    mapDidInitialFit = false;
    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
    markersLayer = null;
  }

  function closeMapWindow() {
    if (!mapBackdrop) return;
    destroyMapInstance();
    if (mapKeyHandler) {
      document.removeEventListener('keydown', mapKeyHandler);
      mapKeyHandler = null;
    }
    mapBackdrop.remove();
    mapBackdrop = null;
    mapNoteEl = null;
    mapMountEl = null;
    viewBtn.classList.remove('mobile-events__view-toggle--on');
    viewBtn.setAttribute('aria-pressed', 'false');
    viewBtn.setAttribute('aria-label', 'Open events map');
    if (!isMobileNavApplying() && history.state?.overlay === 'map') mobileNavBack();
  }

  function openMapWindow() {
    if (mapBackdrop) {
      void syncMap(lastFilteredEvents, lastEventsPayload);
      return;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'events-finder__map-backdrop';
    const shell = document.createElement('div');
    shell.className = 'events-finder__map-window';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-labelledby', 'mobile-events-map-title');

    const bar = document.createElement('div');
    bar.className = 'events-finder__map-window-bar';
    const title = document.createElement('h2');
    title.id = 'mobile-events-map-title';
    title.className = 'events-finder__map-window-title';
    title.textContent = 'Events map';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'events-finder__map-window-close';
    closeBtn.setAttribute('aria-label', 'Close events map');
    closeBtn.title = 'Close';
    closeBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';
    bar.append(title, closeBtn);

    const note = document.createElement('p');
    note.className = 'events-finder__map-note muted';
    note.textContent = 'Loading map…';

    const mount = document.createElement('div');
    mount.className = 'events-finder__map';
    mount.setAttribute('role', 'img');
    mount.setAttribute('aria-label', 'Events map');

    shell.append(bar, note, mount);
    backdrop.append(shell);
    document.body.append(backdrop);

    mapBackdrop = backdrop;
    mapNoteEl = note;
    mapMountEl = mount;

    viewBtn.classList.add('mobile-events__view-toggle--on');
    viewBtn.setAttribute('aria-pressed', 'true');
    viewBtn.setAttribute('aria-label', 'Close events map');

    closeBtn.addEventListener('click', closeMapWindow);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeMapWindow();
    });
    mapKeyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMapWindow();
      }
    };
    document.addEventListener('keydown', mapKeyHandler);
    if (!isMobileNavApplying()) {
      pushMobileNav({ tab: 'events', pane: 'list', overlay: 'map' });
    }
    void syncMap(lastFilteredEvents, lastEventsPayload);
  }

  /**
   * @param {object} ev
   * @returns {HTMLElement}
   */
  /**
   * A big-event heads-up card for the mobile feed (flier + dates + ticket
   * status). Tapping opens the detail popout.
   * @param {object} item conference-watch heads-up item
   * @returns {HTMLElement}
   */
  function buildBigEventCard(item) {
    const card = document.createElement('article');
    card.className = 'mobile-events__card mobile-events__card--big-event';
    const eventHref = String(item.url || item.homepageUrl || '').trim();
    const ticketHref = String(item.ticketUrl || item.homepageUrl || item.url || '').trim();

    const row = document.createElement('div');
    row.className = 'mobile-events__row';

    const icon = document.createElement('div');
    icon.className = 'mobile-events__icon';
    const flier = item.flierImageUrl || item.flierUrl || item.screenshotUrl;
    if (flier) {
      const img = document.createElement('img');
      img.src = String(flier);
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        icon.replaceChildren();
        icon.classList.add('mobile-events__icon--empty');
        icon.textContent = String(item.title || 'B').slice(0, 1).toUpperCase();
      });
      icon.append(img);
    } else {
      icon.classList.add('mobile-events__icon--empty');
      icon.textContent = String(item.title || 'B').slice(0, 1).toUpperCase();
    }

    const body = document.createElement('div');
    body.className = 'mobile-events__body';

    const head = document.createElement('div');
    head.className = 'mobile-events__head';
    const title = document.createElement('h3');
    title.className = 'mobile-events__title';
    const titleText = String(item.title || item.query || 'Big event');
    const titleUrl = String(item.url || item.homepageUrl || '').trim();
    if (titleUrl) {
      const titleLink = document.createElement('a');
      titleLink.className = 'events-finder__card-title-link';
      titleLink.href = titleUrl;
      titleLink.target = '_blank';
      titleLink.rel = 'noopener noreferrer';
      titleLink.textContent = titleText;
      titleLink.addEventListener('click', (e) => e.stopPropagation());
      title.append(titleLink);
    } else {
      title.textContent = titleText;
    }
    const badge = document.createElement('span');
    badge.className = 'events-finder__card-bigbadge events-finder__card-bigbadge--icon';
    badge.title = 'Producer event';
    badge.setAttribute('aria-label', 'Producer event');
    const badgeImg = document.createElement('img');
    badgeImg.className = 'events-finder__card-bigbadge-img';
    badgeImg.src = '/icons/producer-tent.png';
    badgeImg.srcset = '/icons/producer-tent.png 1x, /icons/producer-tent@2x.png 2x';
    badgeImg.alt = '';
    badgeImg.decoding = 'async';
    badge.append(badgeImg);
    head.append(title, badge);

    const meta = document.createElement('p');
    meta.className = 'mobile-events__meta';
    const bits = [item.whenLabel || 'Dates TBD'];
    if (item.placeLabel) bits.push(String(item.placeLabel));
    meta.textContent = bits.filter(Boolean).join(' · ');

    // Price on its own line, green + bold (consistent across all event cards).
    const priceEl = document.createElement('p');
    priceEl.className = 'events-finder__card-price';
    if (item.ticketLabel) priceEl.textContent = String(item.ticketLabel);
    else priceEl.hidden = true;

    const statusLine = document.createElement('p');
    statusLine.className = 'mobile-events__meta';
    const statusPill = document.createElement(ticketHref ? 'a' : 'span');
    statusPill.className = `events-finder__big-events-status events-finder__big-events-status--${item.salesStatusKind || 'unknown'}`;
    statusPill.textContent = String(item.salesStatus || '—');
    if (ticketHref) {
      statusPill.href = ticketHref;
      statusPill.target = '_blank';
      statusPill.rel = 'noopener noreferrer';
      statusPill.title = 'Open ticket page';
      statusPill.addEventListener('click', (e) => e.stopPropagation());
    }
    statusLine.append(statusPill);
    // Keep genuinely-different early-bird notes, but never repeat the plain
    // price (shown on the price line) nor the on-sale date (shown in the pill).
    const extra =
      item.earlyBirdNote
      || (item.earlyBirdKind !== 'price' ? item.earlyBirdLine : null);
    if (extra) {
      const ex = document.createElement('span');
      ex.className = 'events-finder__big-events-earlybird';
      ex.textContent = String(extra);
      statusLine.append(ex);
    }

    const actions = document.createElement('div');
    actions.className = 'mobile-events__actions';

    const snoozeBtn = document.createElement('button');
    snoozeBtn.type = 'button';
    snoozeBtn.className = 'mobile-events__action mobile-events__action--snooze';
    snoozeBtn.title = 'Snooze — hide for one week';
    snoozeBtn.setAttribute('aria-label', 'Snooze this big event for one week');
    snoozeBtn.textContent = 'Snooze';
    snoozeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void bigEventCardAction(item, 'snooze');
    });

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'mobile-events__action mobile-events__action--skip';
    skipBtn.title = 'Skip — dismiss this big event';
    skipBtn.setAttribute('aria-label', 'Skip this big event');
    skipBtn.textContent = 'Skip';
    skipBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void bigEventCardAction(item, 'skip');
    });

    const calBtn = document.createElement('a');
    calBtn.className = 'mobile-events__action mobile-events__action--cal';
    calBtn.href = googleCalendarAddUrl(item, googleCalendarTarget);
    calBtn.target = '_blank';
    calBtn.rel = 'noopener noreferrer';
    calBtn.title = 'Add to calendar';
    calBtn.setAttribute('aria-label', 'Add this big event to calendar');
    calBtn.textContent = 'Add to cal';
    calBtn.addEventListener('click', (e) => e.stopPropagation());

    const logisticsBtn = document.createElement('button');
    logisticsBtn.type = 'button';
    logisticsBtn.className = 'mobile-events__action mobile-events__action--logistics';
    logisticsBtn.title = 'Logistics notes — flights, lodging, packing';
    logisticsBtn.setAttribute('aria-label', 'Edit logistics notes');
    logisticsBtn.textContent = item.planningNotes ? 'Logistics ✓' : 'Logistics';
    logisticsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openProducerLogisticsDialog(item);
    });

    actions.append(logisticsBtn, snoozeBtn, skipBtn, calBtn);

    body.append(head, meta, priceEl, statusLine, actions);
    row.append(icon, body);
    card.append(row);
    if (eventHref) {
      card.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        window.open(eventHref, '_blank', 'noopener,noreferrer');
      });
    }
    return card;
  }

  /**
   * @param {object} ev
   * @param {{ mapPopup?: boolean }} [opts]
   */
  function buildCard(ev, opts = {}) {
    const card = document.createElement('article');
    card.className = 'mobile-events__card';
    if (opts.mapPopup) card.classList.add('mobile-events__card--map-popup');

    const eventUrl = String(ev.url || '').trim();
    const eventId = String(ev.id || '').trim();
    const imageUrl =
      String(ev.imageUrl || ev.raw?.imageUrl || ev.raw?.coverUrl || '').trim() || '';

    const row = document.createElement('div');
    row.className = 'mobile-events__row';

    const icon = document.createElement('div');
    icon.className = 'mobile-events__icon';
    const resolvedImage = rewriteEventImageSrcTiny(imageUrl);
    if (resolvedImage) {
      const img = document.createElement('img');
      img.src = resolvedImage;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        icon.replaceChildren();
        icon.classList.add('mobile-events__icon--empty');
        icon.textContent = String(ev.source || 'E').slice(0, 1).toUpperCase();
      });
      icon.append(img);
    } else {
      icon.classList.add('mobile-events__icon--empty');
      icon.textContent = String(ev.source || 'E').slice(0, 1).toUpperCase();
    }

    const body = document.createElement('div');
    body.className = 'mobile-events__body';

    const head = document.createElement('div');
    head.className = 'mobile-events__head';

    const baseTitle = String(ev.title || '').trim() || 'Untitled event';
    const displayTitle =
      (eventId && titleOverrides[eventId] ? titleOverrides[eventId] : '') || baseTitle;
    const title = document.createElement(eventUrl ? 'a' : 'h3');
    title.className = 'mobile-events__title';
    title.textContent = displayTitle;
    if (eventUrl && title instanceof HTMLAnchorElement) {
      title.href = eventUrl;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    }
    if (eventId) attachTitleEdit(title, ev, head);

    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'mobile-events__fav';
    const isFav = Boolean(eventId && taste?.favoriteEventIds?.includes(eventId));
    paintFavButton(favBtn, isFav);
    favBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void toggleFavorite(ev, favBtn);
    });

    head.append(title, favBtn);

    const place = String(ev.venue || ev.location || '').trim();

    /** @type {HTMLElement[]} */
    const bodyBits = [head];

    if (opts.mapPopup) {
      // Map pin: title → when → where → city/distance (scan hierarchy).
      const whenEl = document.createElement('p');
      whenEl.className = 'mobile-events__when';
      whenEl.textContent = formatWhen(ev.start);
      bodyBits.push(whenEl);

      const placeEl = document.createElement('p');
      placeEl.className = 'mobile-events__place';
      if (place) placeEl.textContent = place;
      else placeEl.hidden = true;
      bodyBits.push(placeEl);

      const meta = document.createElement('p');
      meta.className = 'mobile-events__meta';
      const bits = [];
      if (ev.online || ev.isOnline) bits.push('Online');
      else if (ev.city) bits.push(String(ev.city));
      if (Number.isFinite(ev.distanceMiles)) bits.push(`${Math.round(ev.distanceMiles)} mi`);
      if (bits.length) meta.textContent = bits.join(' · ');
      else meta.hidden = true;
      bodyBits.push(meta);
    } else {
      const meta = document.createElement('p');
      meta.className = 'mobile-events__meta';
      const bits = [formatWhen(ev.start)];
      if (place) bits.push(place);
      if (ev.online || ev.isOnline) bits.push('Online');
      else if (ev.city) bits.push(String(ev.city));
      if (Number.isFinite(ev.distanceMiles)) bits.push(`${Math.round(ev.distanceMiles)} mi`);
      meta.textContent = bits.filter(Boolean).join(' · ');
      bodyBits.push(meta);
    }

    // Price on its own line, green + bold (consistent across all event cards).
    const priceLabel = String(ev.priceLabel || '').trim();
    const priceEl = document.createElement('p');
    priceEl.className = 'events-finder__card-price';
    if (priceLabel) priceEl.textContent = priceLabel;
    else priceEl.hidden = true;
    bodyBits.push(priceEl);

    const actions = document.createElement('div');
    actions.className = 'mobile-events__actions';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'mobile-events__action mobile-events__action--up';
    upBtn.setAttribute('aria-label', 'See more like this');
    upBtn.title = 'See more like this?';
    upBtn.textContent = '👍';
    upBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPreferenceModal(ev, 'up');
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'mobile-events__action mobile-events__action--down';
    downBtn.setAttribute('aria-label', 'See less like this');
    downBtn.title = 'See less like this?';
    downBtn.textContent = '👎';
    downBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPreferenceModal(ev, 'down');
    });

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    if (showSkipped) {
      hideBtn.className = 'mobile-events__action mobile-events__action--unskip';
      hideBtn.setAttribute('aria-label', 'Restore this event');
      hideBtn.title = 'Unskip — show in feed again';
      hideBtn.textContent = 'Unskip';
      hideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void unskipEvent(ev);
      });
    } else {
      hideBtn.className = 'mobile-events__action mobile-events__action--skip';
      hideBtn.setAttribute('aria-label', 'Skip this event');
      hideBtn.title = 'Not interested — skip';
      hideBtn.textContent = 'Skip';
      hideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void hideEvent(ev);
      });
    }

    const calBtn = document.createElement('a');
    calBtn.className = 'mobile-events__action mobile-events__action--cal';
    calBtn.href = googleCalendarAddUrl(ev, googleCalendarTarget);
    calBtn.target = '_blank';
    calBtn.rel = 'noopener noreferrer';
    const calAdded = Boolean(eventId && taste?.calendarAddedEventIds?.includes(eventId));
    paintCalButton(calBtn, calAdded);
    calBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void markCalendarAdded(ev, calBtn);
    });

    if (showSkipped) actions.append(hideBtn, calBtn);
    else actions.append(upBtn, downBtn, hideBtn, calBtn);
    if (eventUrl) {
      const siteBtn = document.createElement('a');
      siteBtn.className = 'mobile-events__action mobile-events__action--site';
      siteBtn.href = eventUrl;
      siteBtn.target = '_blank';
      siteBtn.rel = 'noopener noreferrer';
      siteBtn.textContent = 'Website';
      siteBtn.title = 'Open event website';
      siteBtn.addEventListener('click', (e) => e.stopPropagation());
      actions.append(siteBtn);
    }
    bodyBits.push(actions);

    if (!opts.mapPopup) {
      const sourceLabel = eventSourceLabel(ev);
      if (sourceLabel) {
        const sourceEl = document.createElement('p');
        sourceEl.className = 'mobile-events__source';
        sourceEl.textContent = sourceLabel;
        bodyBits.push(sourceEl);
      }
    } else if (ev.notable === true) {
      card.classList.add('events-finder__card--notable');
    }

    body.append(...bodyBits);
    row.append(icon, body);
    card.append(row);

    if (eventUrl) {
      card.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('a, button, label, input')) return;
        window.open(eventUrl, '_blank', 'noopener,noreferrer');
      });
    }
    return card;
  }

  /**
   * @param {object} data
   */
  function paint(data) {
    lastEventsPayload = data;
    syncShowSkippedButton();

    const available = citiesFromPayload(data);
    const prevSelected = cityChecks.getSelected();
    const prevAvailable = [...cityChecks.root.querySelectorAll('input[type="checkbox"]')].map(
      (el) => /** @type {HTMLInputElement} */ (el).value,
    );
    /** @type {string[] | null} */
    let selectedForUi = null;
    if (savedCitySelection && savedCitySelection.length) {
      selectedForUi = [...savedCitySelection];
      if (prevAvailable.length) {
        for (const city of available) {
          if (!prevAvailable.includes(city) && !selectedForUi.includes(city)) {
            selectedForUi = [...selectedForUi, city];
          }
        }
      }
    } else if (
      prevAvailable.length
      && prevSelected.length
      && prevSelected.length < prevAvailable.length
    ) {
      selectedForUi = prevSelected;
      for (const city of available) {
        if (!prevAvailable.includes(city)) selectedForUi = [...selectedForUi, city];
      }
    }
    cityChecks.setCities(available, selectedForUi);
    citiesEmpty.hidden = available.length > 0;
    cityChecks.root.hidden = available.length === 0;

    const selected = new Set(cityChecks.getSelected().map((c) => c.toLowerCase()));
    const allChecked = selected.size === 0 || selected.size === available.length;
    const dateRange = calendar.getRange();
    const selectedDates = new Set(
      Array.isArray(dateRange.dates) ? dateRange.dates.map(String) : [],
    );
    const earliest = normalizeLocalTime(timeInput.value);
    const earliestMins = earliest
      ? (() => {
          const [eh, em] = earliest.split(':').map(Number);
          return eh * 60 + em;
        })()
      : null;

    /**
     * @param {object} ev
     * @returns {boolean}
     */
    function passesClientFilters(ev) {
      const telegramIntake = isTelegramIntakeEvent(ev);
      if (!telegramIntake && !allChecked && !selected.has(eventCityLabel(ev).toLowerCase())) return false;
      if (!selectedDates.size && (telegramIntake || earliestMins == null)) return true;
      const local = eventLocalDayAndMinutes(ev?.start);
      if (selectedDates.size) {
        if (!local?.day || !selectedDates.has(local.day)) return false;
      }
      if (!telegramIntake && earliestMins != null) {
        if (local == null || local.minutes < earliestMins) return false;
      }
      return true;
    }

    const mainEvents = (Array.isArray(data?.events) ? data.events : []).filter((ev) => {
      if (isTelegramIntakeEvent(ev)) return true;
      const skippedPool = [
        ...(Array.isArray(data?.skippedEvents) ? data.skippedEvents : []),
        ...(Array.isArray(taste?.skippedEvents) ? taste.skippedEvents : []),
      ];
      return !eventMatchesSkippedLocal(ev, skippedPool);
    });
    const skippedList = Array.isArray(data?.skippedEvents)
      ? data.skippedEvents
      : Array.isArray(taste?.skippedEvents)
        ? taste.skippedEvents
        : [];
    const pool = showSkipped ? skippedList : mainEvents;
    const events = pool.filter(passesClientFilters);

    lastFilteredEvents = events;
    if (mapBackdrop) void syncMap(events, data);

    const activeBigEvents = showSkipped
      ? []
      : bigEventsChecks.getShowBigEvents()
        ? (Array.isArray(data.conferenceWatchlistItems) ? data.conferenceWatchlistItems : [])
            .filter((it) => it && it.displayActive && !it.skipped && !it.snoozed)
        : [];

    list.replaceChildren();
    refreshConferencePopoutIfOpen();
    if (!events.length && !activeBigEvents.length) {
      status.hidden = false;
      status.textContent = showSkipped
        ? 'No skipped events match these filters.'
        : 'No upcoming events match these filters.';
      return;
    }
    status.hidden = true;
    for (const item of activeBigEvents) {
      list.append(buildBigEventCard(item));
    }
    for (const ev of events) {
      list.append(buildCard(ev));
    }
  }

  saveBtn.addEventListener('click', async () => {
    const ok = await saveCriteria({ includeFilters: true, silent: false });
    if (ok) void loadEvents();
  });

  showSkippedBtn.addEventListener('click', () => {
    showSkipped = !showSkipped;
    writeShowSkipped(showSkipped);
    syncShowSkippedButton();
    if (lastEventsPayload) paint(lastEventsPayload);
  });

  viewBtn.addEventListener('click', () => {
    if (mapBackdrop) closeMapWindow();
    else openMapWindow();
  });

  zipInput.addEventListener('change', () => scheduleFilterAutosave({ reload: true }));
  milesInput.addEventListener('change', () => scheduleFilterAutosave({ reload: true }));
  timeInput.addEventListener('change', () => {
    if (lastEventsPayload) paint(lastEventsPayload);
    scheduleFilterAutosave();
  });
  attendanceChecks.root.addEventListener('change', () => {
    if (lastEventsPayload) paint(lastEventsPayload);
    scheduleFilterAutosave({ reload: true });
  });
  bigEventsChecks.root.addEventListener('change', () => {
    if (lastEventsPayload) paint(lastEventsPayload);
    scheduleFilterAutosave();
  });

  const cachedEvents = readPanelCache(EVENTS_CACHE_KEY, EVENTS_CACHE_MAX_MS);
  const cachedCriteria = readPanelCache(CRITERIA_CACHE_KEY, CRITERIA_CACHE_MAX_MS);
  if (cachedCriteria && typeof cachedCriteria === 'object') {
    applyTaste(cachedCriteria);
  }
  if (cachedEvents && typeof cachedEvents === 'object') {
    paint(cachedEvents);
    status.hidden = false;
    status.textContent = 'Refreshing…';
  }

  async function loadCriteria() {
    try {
      const r = await fetch('/api/events-finder-criteria', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      applyTaste(data);
      writePanelCache(CRITERIA_CACHE_KEY, {
        lookFor: taste?.lookFor || '',
        skip: taste?.skip || '',
        blacklist: taste?.blacklist || '',
        scrape: taste?.scrape,
        filters: data.filters,
        geo: data.geo,
        favoriteEventIds: taste?.favoriteEventIds || [],
        calendarAddedEventIds: taste?.calendarAddedEventIds || [],
        conferenceWatchlist: taste?.conferenceWatchlist || [],
        skippedEvents: taste?.skippedEvents || [],
        googleCalendar: googleCalendarTarget,
      });
      if (lastEventsPayload) paint(lastEventsPayload);
    } catch {
      if (!criteriaReady) {
        taste = {
          lookFor: '',
          skip: '',
          blacklist: '',
          favoriteEventIds: [],
          calendarAddedEventIds: [],
          skippedEvents: [],
        };
        criteriaReady = true;
      }
    }
  }

  async function loadEvents() {
    try {
      const r = await fetch('/api/events-finder/events?catalogOnly=1', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      writePanelCache(EVENTS_CACHE_KEY, data);
      paint(data);
    } catch (e) {
      if (!list.childElementCount) {
        status.hidden = false;
        status.textContent = `Could not load events: ${e?.message || e}`;
      } else {
        status.hidden = false;
        status.textContent = 'Showing cached events (refresh failed).';
      }
    }
  }

  void Promise.all([loadCriteria(), loadEvents()]);

  document.addEventListener('dashbird:mobile-nav', (e) => {
    const s = e.detail;
    if (!s || s.tab !== 'events') return;
    if (mapBackdrop && s.overlay !== 'map') closeMapWindow();
    if (s.overlay === 'filters') {
      filterPanel.hidden = true;
      filterToggle.setAttribute('aria-expanded', 'false');
      filterToggle.classList.remove('mobile-events__filter-toggle--open');
      return;
    }
    if (s.pane === 'list') {
      filterPanel.hidden = true;
      filterToggle.setAttribute('aria-expanded', 'false');
      filterToggle.classList.remove('mobile-events__filter-toggle--open');
    }
  });
}
