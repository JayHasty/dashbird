import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

const STORAGE_KEY = 'cal-upcoming';
const LOCAL_MAX_MS = 24 * 60 * 60 * 1000;

/** @param {string} dateLabel @param {string} timeLabel */
function joinDateAndTime(dateLabel, timeLabel) {
  return `${dateLabel} · ${timeLabel}`;
}

function formatWhen(ev, timeZone) {
  const tz = timeZone || 'America/Los_Angeles';
  const start = new Date(ev.startMs);
  const end = ev.endMs != null ? new Date(ev.endMs) : null;
  const now = Date.now();
  const ongoing = ev.startMs <= now && (ev.endMs == null || ev.endMs > now);

  if (ev.allDay) {
    const d = start.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: tz,
    });
    return ongoing ? `Today · all day (${d})` : `All day · ${d}`;
  }

  const dateOpts = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  };
  const timeOpts = { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz };
  const d1 = start.toLocaleDateString('en-US', dateOpts);
  const t1 = start.toLocaleTimeString('en-US', timeOpts);
  if (!end || end.getTime() === start.getTime()) {
    return ongoing ? `Now · ${joinDateAndTime(d1, t1)}` : joinDateAndTime(d1, t1);
  }
  const d2 = end.toLocaleDateString('en-CA', { timeZone: tz });
  const d1c = start.toLocaleDateString('en-CA', { timeZone: tz });
  const t2 = end.toLocaleTimeString('en-US', timeOpts);
  if (d1c === d2) return `${joinDateAndTime(d1, t1)} – ${t2}`;
  const d2l = end.toLocaleDateString('en-US', dateOpts);
  return `${joinDateAndTime(d1, t1)} → ${joinDateAndTime(d2l, t2)}`;
}

function readLocalCalendarCache() {
  const j = readPanelCache(STORAGE_KEY, LOCAL_MAX_MS);
  if (!j || typeof j !== 'object' || !Array.isArray(j.events)) return null;
  return j;
}

/** @param {{ events: object[], timeZone?: string }} payload */
function writeLocalCalendarCache(payload) {
  writePanelCache(STORAGE_KEY, {
    events: payload.events,
    timeZone: payload.timeZone,
  });
}

/**
 * @param {HTMLElement} root
 * @param {object} config
 * @param {{ prefetched?: object | null }} [opts]
 */
export function mountCalendarUpcoming(root, config, opts = {}) {
  try {
    sessionStorage.removeItem('dashbird-cal-upcoming-skip');
  } catch {
    /* ignore */
  }
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'cal-upcoming';

  const main = document.createElement('div');
  main.className = 'cal-upcoming__main';

  const label = document.createElement('span');
  label.className = 'cal-upcoming__label';
  label.textContent = 'Next on calendar';

  const title = document.createElement('div');
  title.className = 'cal-upcoming__title';
  title.textContent = '…';

  const when = document.createElement('div');
  when.className = 'cal-upcoming__when';
  when.textContent = '';

  main.append(label, title, when);

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'cal-upcoming__nav cal-upcoming__back';
  backBtn.setAttribute('aria-label', 'Show previous calendar event');
  backBtn.title = 'Previous event';
  backBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M15.41 16.59 10.83 12l4.58-4.59L14 6l-6 6 6 6z"/></svg>';

  const advanceBtn = document.createElement('button');
  advanceBtn.type = 'button';
  advanceBtn.className = 'cal-upcoming__nav cal-upcoming__advance';
  advanceBtn.setAttribute('aria-label', 'Show next calendar event');
  advanceBtn.title = 'Next event';
  advanceBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'cal-upcoming__open';
  openBtn.textContent = 'Go to calendar';
  openBtn.setAttribute('aria-label', 'Go to calendar');
  openBtn.title = 'Open Google Calendar';

  openBtn.addEventListener('click', () => {
    const authuser = String(config.googleCalendarAuthuser || '').trim();
    const url =
      authuser.includes('@')
        ? `https://calendar.google.com/calendar?authuser=${encodeURIComponent(authuser)}`
        : 'https://calendar.google.com/';
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  wrap.append(backBtn, main, openBtn, advanceBtn);
  root.appendChild(wrap);

  let events = [];
  /** Index into `events` (0 = next from now per API sort). Reset on each feed reload. */
  let skip = 0;
  let timeZone = config.weatherTimeZone || 'America/Los_Angeles';

  function render() {
    if (!events.length) {
      title.textContent = 'No upcoming events';
      when.textContent = config.calendarIcalConfigured
        ? 'Nothing on the feed in the next stretch.'
        : 'Add GOOGLE_CALENDAR_ICAL_URL in .env (secret iCal link from Google Calendar).';
      backBtn.disabled = true;
      advanceBtn.disabled = true;
      return;
    }
    if (skip >= events.length) skip = 0;
    const ev = events[skip];
    title.textContent = ev.title;
    const calName = String(ev.calendarName || '').trim();
    const whenBase = formatWhen(ev, timeZone);
    when.textContent =
      calName && !/@/.test(calName) && calName.toLowerCase() !== 'synced'
        ? `${whenBase} · ${calName}`
        : whenBase;
    const loc = (ev.location || '').trim();
    wrap.title = [ev.title, when.textContent, loc].filter(Boolean).join('\n');
    const navDisabled = events.length <= 1;
    backBtn.disabled = navDisabled;
    advanceBtn.disabled = navDisabled;

    main.onclick = null;
    main.style.cursor = '';
  }

  function applyPayload(j, { keepPreviousOnError = false } = {}) {
    if (!j?.ok) {
      if (keepPreviousOnError && events.length) return;
      events = [];
      title.textContent = j?.needsSecretIcal
        ? 'Private calendar'
        : 'Calendar feed unavailable';
      when.textContent =
        j?.hint ||
        'Set GOOGLE_CALENDAR_ICAL_URL to your Google Calendar secret iCal address (Settings → Integrate calendar).';
      backBtn.disabled = true;
      advanceBtn.disabled = true;
      main.onclick = null;
      main.style.cursor = '';
      return;
    }
    events = Array.isArray(j.events) ? j.events : [];
    if (j.timeZone) timeZone = j.timeZone;
    skip = 0;
    writeLocalCalendarCache({ events, timeZone });
    render();
  }

  backBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (events.length <= 1) return;
    skip = (skip - 1 + events.length) % events.length;
    render();
  });

  advanceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (events.length <= 1) return;
    skip = (skip + 1) % events.length;
    render();
  });

  async function refresh() {
    try {
      const r = await fetch('/api/calendar/upcoming', { cache: 'no-store' });
      const j = await r.json();
      applyPayload(j, { keepPreviousOnError: true });
    } catch (err) {
      if (!events.length) {
        title.textContent = 'Could not load calendar';
        when.textContent = String(err?.message || err);
        backBtn.disabled = true;
        advanceBtn.disabled = true;
      }
    }
  }

  const local = readLocalCalendarCache();
  if (local?.events?.length) {
    events = local.events;
    if (local.timeZone) timeZone = local.timeZone;
    render();
  }

  if (opts.prefetched != null) {
    applyPayload(opts.prefetched);
  }

  refresh();
  setInterval(refresh, 5 * 60 * 1000);
}
