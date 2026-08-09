import {
  loadSkyCalendar,
  filterActiveEvents,
  filterSupermoonForHeroStrip,
} from './sky-events.js';
import { mergeGeomagneticStormGScale, snapshotGeomagneticLive } from './geomagnetic-storm-merge.js';
import { mergeAuroraWithSwpc, snapshotAuroraLive } from './swpc-aurora.js';
import {
  mergeNakedEyePlanetsWithComputed,
  snapshotNakedEyePlanets,
} from './naked-eye-planets.js';
import { sortSkyStripWithPlanetsFirst } from './sky-strip-order.js';
import {
  buildEarthAndMoonbowEventTypes,
  buildEarthEventTypesSlow,
} from './event-types-earth-status.js';
import { SKY_TYPE_DATA_SOURCES, getEventTypeLiveUrl } from './event-types-manifest.js';
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';
import { SIGHTING_HEADS_UP_TYPES } from './sky-sighting-direction.js';
import { filterSightingHeadsUp, mergeSightingHeadsUp, sightingTypeStatusValue } from './sky-sighting-heads-up.js';
import { NIGHTLY_SIGHTING_TYPES } from './sky-sighting-night.js';
import { mergeAircraftNearby } from './merge-aircraft-nearby.js';
import { snapshotAircraftNearby } from './aircraft-nearby.js';
import { mergeEclipseHeadsUp } from './sky-eclipse-heads-up.js';

const HERO_TZ = 'America/Los_Angeles';

function formatRange(ev, timeZone = HERO_TZ) {
  const opts = {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  const s = new Date(ev.startsAt);
  const e = ev.endsAt != null ? new Date(ev.endsAt) : s;
  if (Number.isNaN(s.getTime())) return ev.title || ev.id || '';
  const a = s.toLocaleString('en-US', opts);
  const b = Number.isNaN(e.getTime()) ? '' : e.toLocaleString('en-US', opts);
  return b && b !== a ? `${a} – ${b}` : a;
}

function calendarValueForType(events, typeId, now, windowMs) {
  const typed = (events || []).filter((e) => e && e.type === typeId);
  const inWindow = filterActiveEvents(typed, now, windowMs);
  if (inWindow.length) {
    return inWindow
      .map((ev) => {
        const range = formatRange(ev);
        return ev.title ? `${ev.title} · ${range}` : range;
      })
      .join('; ');
  }

  const future = typed
    .filter((ev) => {
      const s = new Date(ev.startsAt).getTime();
      return Number.isFinite(s) && s > now.getTime();
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  if (future.length) {
    const ev = future[0];
    return `Next (outside ${windowMs / 3600000}h window): ${ev.title || ev.id} · ${formatRange(ev)}`;
  }

  return `No calendar row in ${windowMs / 3600000}h window`;
}

/**
 * @param {string} id
 * @param {unknown[]} activeRows
 * @param {unknown[]} calendarEvents
 * @param {Date} now
 */
function isSkyStripActiveForType(id, activeRows, calendarEvents, now, geo) {
  if (activeRows.length > 0) return true;
  if (!SIGHTING_HEADS_UP_TYPES.has(id)) return false;
  return filterSightingHeadsUp(calendarEvents, now, undefined, geo).some((e) => e && e.type === id);
}

function supermoonValue(events, now, timeZone) {
  const moons = (events || []).filter((e) => e && e.type === 'supermoon');
  if (!moons.length) return 'No supermoon rows in calendar';

  const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone });
  const noonUtcMs = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12, 0, 0);
  };

  const parts = moons.map((ev) => {
    const listed = ev.listedSupermoon === true;
    let proximity = 'no peakAt';
    if (ev.peakAt) {
      const peak = new Date(ev.peakAt);
      if (!Number.isNaN(peak.getTime())) {
        const days = Math.round(
          Math.abs(noonUtcMs(ymd(peak)) - noonUtcMs(ymd(now))) / 86400000,
        );
        proximity = `${days} day(s) from peak (${ymd(peak)} LA)`;
      }
    }
    const stripOk = filterSupermoonForHeroStrip([ev], now, timeZone).length > 0;
    return `${ev.title || ev.id}: listedSupermoon=${listed ? 'yes' : 'no'} · ${proximity} · strip window=${stripOk ? 'yes' : 'no'}`;
  });

  return parts.join('; ');
}

async function runSkyStripPipeline(now, windowMs) {
  const data = await loadSkyCalendar();
  const { lat, lon, zip } = await resolveDashboardWeatherLatLon();
  const locationLabel = (process.env.DASHBOARD_LOCATION_LABEL || '').trim() || 'Oakland, CA · 94608';
  const geo = { lat, lon, zip, locationLabel };

  let active = filterSupermoonForHeroStrip(
    filterActiveEvents(data.events, now, windowMs),
    now,
    HERO_TZ,
  );
  active = await mergeGeomagneticStormGScale(active, now, windowMs);
  active = await mergeAuroraWithSwpc(active, lat, lon, now, windowMs, HERO_TZ, locationLabel);
  active = mergeNakedEyePlanetsWithComputed(active, lat, lon, now, windowMs, HERO_TZ);
  active = mergeEclipseHeadsUp(active, data.events, now, windowMs);
  active = mergeSightingHeadsUp(active, data.events, now, windowMs, HERO_TZ, geo);
  active = await mergeAircraftNearby(active, now);
  active = sortSkyStripWithPlanetsFirst(active);

  return { data, active, lat, lon, zip, locationLabel };
}

/**
 * @param {object} p
 * @param {{ eventTypes?: unknown[], events?: unknown[] }} p.data
 * @param {unknown[]} p.active
 * @param {number} p.lat
 * @param {number} p.lon
 * @param {Date} p.now
 * @param {number} p.windowMs
 */
async function buildSkyTypeRows({ data, active, lat, lon, zip, locationLabel, now, windowMs }) {
  const geo = { lat, lon, zip, locationLabel };
  /** @type {Map<string, unknown[]>} */
  const activeByType = new Map();
  for (const row of active) {
    if (!row || typeof row.type !== 'string') continue;
    const list = activeByType.get(row.type) || [];
    list.push(row);
    activeByType.set(row.type, list);
  }

  const [geomSnap, auroraSnap, aircraftSnap] = await Promise.all([
    snapshotGeomagneticLive(now, windowMs),
    snapshotAuroraLive(lat, lon),
    snapshotAircraftNearby(now),
  ]);

  const planetSnap = snapshotNakedEyePlanets(lat, lon, now, windowMs, HERO_TZ);

  return (data.eventTypes || [])
    .filter((et) => et.id !== 'rainbow' && et.id !== 'annular_eclipse_world')
    .map((et) => {
      const id = et.id;
      const label = et.label || id;
      const activeRows = activeByType.get(id) || [];
      const stripActive = isSkyStripActiveForType(id, activeRows, data.events || [], now, geo);
      const dataSource = SKY_TYPE_DATA_SOURCES[id] || 'sky-events-calendar.json';

      let value;

      if (stripActive && NIGHTLY_SIGHTING_TYPES.has(id)) {
        value = sightingTypeStatusValue(data.events, id, now, windowMs, HERO_TZ, geo);
      } else if (stripActive && SIGHTING_HEADS_UP_TYPES.has(id)) {
        value = calendarValueForType(data.events, id, now, windowMs);
      } else if (stripActive) {
        value = activeRows
          .map((r) => {
            if (typeof r.detailLine === 'string' && r.detailLine.trim()) {
              const title = typeof r.title === 'string' ? r.title.trim() : '';
              return title ? `${title} — ${r.detailLine}` : r.detailLine;
            }
            if (typeof r.title === 'string' && r.title.trim()) {
              const title = r.title.trim();
              const range = formatRange(r);
              return range ? `${title} · ${range}` : title;
            }
            return formatRange(r);
          })
          .join('; ');
      } else if (id === 'geomagnetic') {
        value = geomSnap.value;
      } else if (id === 'aurora') {
        value = auroraSnap.value;
      } else if (id === 'planet') {
        value = planetSnap.value;
      } else if (id === 'supermoon') {
        value = supermoonValue(data.events, now, HERO_TZ);
      } else if (id === 'aircraft') {
        value = aircraftSnap.value;
      } else {
        value = calendarValueForType(data.events, id, now, windowMs);
      }

      return {
        id,
        label,
        category: 'Sky & space',
        active: stripActive,
        value,
        dataSource,
        liveUrl: getEventTypeLiveUrl(id, data),
        pending: false,
      };
    });
}

/**
 * @param {number} [windowHours]
 */
export async function buildSkyEventTypesStatus(windowHours = 24) {
  const wh = Number.isFinite(windowHours) ? Math.min(168, Math.max(1, windowHours)) : 24;
  const windowMs = wh * 60 * 60 * 1000;
  const now = new Date();
  const { data, active, lat, lon, zip, locationLabel } = await runSkyStripPipeline(now, windowMs);
  const types = await buildSkyTypeRows({
    data,
    active,
    lat,
    lon,
    zip,
    locationLabel,
    now,
    windowMs,
  });
  return {
    ok: true,
    now: now.toISOString(),
    windowHours: wh,
    part: 'sky',
    types,
  };
}

/**
 * @param {number} [windowHours]
 */
export async function buildEventTypesStatus(windowHours = 24) {
  const wh = Number.isFinite(windowHours) ? Math.min(168, Math.max(1, windowHours)) : 24;
  const now = new Date();

  const [skyPayload, earthRows, slowRows] = await Promise.all([
    buildSkyEventTypesStatus(wh),
    buildEarthAndMoonbowEventTypes({ includeSlow: false }),
    buildEarthEventTypesSlow(),
  ]);

  const types = [...skyPayload.types, ...earthRows, ...slowRows];

  return {
    ok: true,
    now: now.toISOString(),
    windowHours: wh,
    groups: ['Sky & space', 'Earth'],
    types,
  };
}
