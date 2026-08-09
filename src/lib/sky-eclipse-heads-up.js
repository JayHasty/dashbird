const ECLIPSE_HEADS_UP_MS = 92 * 24 * 60 * 60 * 1000;

/**
 * Only total solar/lunar eclipses are shown on the sky strip / Settings Active.
 * Annular (and partial) rows are excluded.
 *
 * @param {unknown} ev
 * @returns {boolean}
 */
export function isTotalEclipseEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  const type = /** @type {{ type?: unknown }} */ (ev).type;
  if (type === 'annular_eclipse_world') return false;
  if (type !== 'solar_eclipse' && type !== 'lunar_eclipse') return false;
  const row = /** @type {{ id?: unknown, title?: unknown, detailLine?: unknown }} */ (ev);
  const blob = `${row.id || ''} ${row.title || ''} ${row.detailLine || ''}`.toLowerCase();
  if (/\bannular\b/.test(blob)) return false;
  return /\btotal\b/.test(blob);
}

/**
 * Drop annular eclipse rows and non-total solar/lunar eclipse calendar rows.
 *
 * @param {unknown[]} events
 * @returns {unknown[]}
 */
export function filterTotalEclipseStripEvents(events) {
  return (Array.isArray(events) ? events : []).filter((ev) => {
    if (!ev || typeof ev !== 'object') return false;
    const type = /** @type {{ type?: unknown }} */ (ev).type;
    if (type === 'annular_eclipse_world') return false;
    if (type === 'solar_eclipse' || type === 'lunar_eclipse') {
      return isTotalEclipseEvent(ev);
    }
    return true;
  });
}

/**
 * Append upcoming total-eclipse rows when they are outside the normal hero window.
 * This keeps major total eclipses visible ahead of event day.
 *
 * @param {unknown[]} active
 * @param {unknown[]} calendarEvents
 * @param {Date} [now]
 * @param {number} [windowMs]
 * @returns {unknown[]}
 */
export function mergeEclipseHeadsUp(
  active,
  calendarEvents,
  now = new Date(),
  windowMs = 24 * 60 * 60 * 1000,
) {
  const list = filterTotalEclipseStripEvents(Array.isArray(active) ? [...active] : []);
  const events = Array.isArray(calendarEvents) ? calendarEvents : [];
  const ids = new Set(list.map((ev) => ev?.id).filter(Boolean));
  const t0 = now.getTime();
  const windowEnd = t0 + windowMs;
  const headEnd = t0 + ECLIPSE_HEADS_UP_MS;

  const extras = events
    .filter((ev) => {
      if (!isTotalEclipseEvent(ev)) return false;
      if (!ev.id || ids.has(ev.id)) return false;
      const s = new Date(ev.startsAt).getTime();
      if (!Number.isFinite(s)) return false;
      return s > windowEnd && s <= headEnd;
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
    .map((ev) => {
      const start = new Date(ev.startsAt);
      const when = start.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'America/Los_Angeles',
      });
      return {
        ...ev,
        headsUp: true,
        detailLine:
          typeof ev.detailLine === 'string' && ev.detailLine.trim() !== ''
            ? ev.detailLine.trim()
            : `Heads-up: ${when}`,
      };
    });

  return [...list, ...extras].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
}
