import { createPolygonWeatherIcon } from './weather-polygon.js';
import { createMoonPhaseGlyph } from '../lib/moon-phase.js';
import { describeWeather, fetchCurrentWeather } from './weather-data.js';
import { detailLineWithSkyHarvestLicenseHint } from '../lib/resource-license-hint.js';
import { standaloneWarnExclamationSvgHtml } from '../lib/standalone-warn-exclamation.js';
import {
  getDevicePlace,
  rainAlertQueryString,
  subscribeDevicePlace,
} from '../lib/device-location.js';
import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

const FALLBACK_TZ = 'America/Los_Angeles';
/** Matches server adsb.fi cache (src/lib/aircraft-nearby.js CACHE_MS). */
const SKY_STRIP_POLL_MS = 90_000;
const HERO_CACHE_MAX_MS = 45 * 60 * 1000;
const SKY_CACHE_MAX_MS = 20 * 60 * 1000;
/** Re-fetch hero weather/astro when the device moves at least this far. */
const HERO_PLACE_MOVE_M = 800;

const HERO_SUNSET_SRC = '/icons/weather/sunset-glyph.png';
const YOSEMITE_MOONBOW_STRIP_SRC = '/assets/earth-moonbow-strip.png';

function buildYosemiteMoonbowSkyGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-moonbow-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = YOSEMITE_MOONBOW_STRIP_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

/** Moon disc from SunCalc phase + `/assets/sky/moon/phase-*.png` icons. */
function buildHeroMoonGlyph(date) {
  const wrap = createMoonPhaseGlyph(date);
  wrap.classList.add(
    'hero-astro-glyph--img',
    'hero-round-astro-icon',
    'hero-moon-phases-icon',
  );
  return wrap;
}

function buildHeroSunsetGlyph() {
  const wrap = document.createElement('span');
  wrap.className =
    'hero-astro-glyph hero-astro-glyph--img hero-round-astro-icon hero-sunset-glyph';
  const img = document.createElement('img');
  img.src = HERO_SUNSET_SRC;
  img.alt = 'Sunset';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

function formatTime12h(d, timeZone) {
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : FALLBACK_TZ;
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  });
}

function formatDateLong(d, timeZone) {
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : FALLBACK_TZ;
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  });
}

/** Next moon line: month + day, no weekday or year (e.g. `May 17`). */
function formatCaptionDateNoYear(d, timeZone) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : FALLBACK_TZ;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Next-precip line: raindrop icon + caption (empty `line` clears the node). */
function fillHeroPrecipLine(container, line) {
  const s = String(line ?? '').trim();
  container.replaceChildren();
  if (!s) return;
  const drop = document.createElement('span');
  drop.className = 'hero-date-precip__drop';
  drop.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z');
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  drop.appendChild(svg);
  const cap = document.createElement('span');
  cap.className = 'hero-date-precip__text';
  cap.textContent = s;
  container.append(drop, cap);
}

function hasFiveDigitWeatherZip(config) {
  const z = String(config?.weatherZip ?? '')
    .trim()
    .replace(/\D/g, '');
  return z.length === 5;
}

/** UV under sunset time: one small line, e.g. "UV 2 · Low" (ZIP-gated in mountHero). */
function buildSunUvWrap(uvIndex) {
  const n = Math.round(Number(uvIndex));
  const lab = uvBandLabel(uvIndex);
  const wrap = document.createElement('div');
  wrap.className = 'hero-sun-uv-wrap';
  wrap.textContent = lab ? `UV ${n} · ${lab}` : `UV ${n}`;
  return wrap;
}

/** Open-Meteo / WHO-style UV index band label. */
function uvBandLabel(uv) {
  const x = Number(uv);
  if (!Number.isFinite(x)) return '';
  if (x < 3) return 'Low';
  if (x < 6) return 'Moderate';
  if (x < 8) return 'High';
  if (x < 11) return 'Very high';
  return 'Extreme';
}

function formatLaTime12h(d, timeZone) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '—';
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : FALLBACK_TZ;
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  });
}

/** Next moonrise: local time only (no weekday). `when` = epoch ms or ISO string. */
function formatMoonriseLabel(when, timeZone) {
  if (when == null) return '—';
  const d = typeof when === 'number' ? new Date(when) : new Date(String(when));
  if (Number.isNaN(d.getTime())) return '—';
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : FALLBACK_TZ;
  const timeStr = (
    d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz,
    }) || ''
  ).trim();
  return timeStr || '—';
}

function windTowardDeg(fromDeg) {
  if (typeof fromDeg !== 'number' || Number.isNaN(fromDeg)) return null;
  return ((fromDeg + 180) % 360 + 360) % 360;
}

function cardinalFromDeg(fromDeg) {
  if (typeof fromDeg !== 'number' || Number.isNaN(fromDeg)) return '';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const i = Math.round(fromDeg / 45) % 8;
  return dirs[i];
}

/**
 * EPA US AQI warning tiers for glyph color (matches Open-Meteo US AQI).
 * @returns {{ key: string, label: string } | null} null when good — no caution icon.
 */
function aqiWarnBand(aqi) {
  const n = Math.round(Number(aqi));
  if (!Number.isFinite(n) || n <= 50) return null;
  if (n <= 100) return { key: 'yellow', label: 'Air quality caution: moderate' };
  if (n <= 150) return { key: 'orange', label: 'Air quality caution: unhealthy for sensitive groups' };
  if (n <= 200) return { key: 'red', label: 'Air quality caution: unhealthy' };
  if (n <= 300) return { key: 'purple', label: 'Air quality caution: very unhealthy' };
  return { key: 'purple', label: 'Air quality caution: hazardous' };
}

/** Exclamation glyph after `AQI ##` matching severity (yellow → orange → red → purple). */
function buildAqiWarnGlyph(aqi) {
  const band = aqiWarnBand(aqi);
  if (!band) return null;
  const holder = document.createElement('span');
  holder.className = `hero-city-aqi-warn hero-city-aqi-warn--${band.key}`;
  holder.setAttribute('role', 'img');
  holder.setAttribute('aria-label', band.label);
  holder.innerHTML = standaloneWarnExclamationSvgHtml({ width: 12, height: 12 });
  return holder;
}

function createWindDisplay(towardDeg, windMph, fromDeg) {
  const wrap = document.createElement('span');
  wrap.className = 'hero-wind-wrap';

  const mph = windMph != null ? Math.round(windMph) : null;
  const fromCard = cardinalFromDeg(fromDeg);
  const titleParts = [];
  if (mph != null) titleParts.push(`${mph} mph`);
  if (fromCard) titleParts.push(`from ${fromCard}`);
  if (titleParts.length) {
    const t = titleParts.join(' · ');
    wrap.title = t;
    wrap.setAttribute('aria-label', `Wind, ${t}`);
  }

  if (towardDeg != null) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'hero-wind-arrow');
    svg.setAttribute('viewBox', '-12 -12 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.transform = `rotate(${towardDeg}deg)`;
    svg.style.transformOrigin = 'center';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M 0,-8 L 5.5,7 L 0,3 L -5.5,7 Z');
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    wrap.appendChild(svg);
  }

  if (mph != null) {
    const mphEl = document.createElement('span');
    mphEl.className = 'hero-wind-mph';
    mphEl.textContent = `${mph} mph`;
    wrap.appendChild(mphEl);
  }

  return wrap;
}

function buildCityBlock(cityLabel) {
  const col = document.createElement('div');
  col.className = 'hero-city';

  const lab = document.createElement('div');
  lab.className = 'hero-city-label';
  lab.textContent = cityLabel;

  const body = document.createElement('div');
  body.className = 'hero-city-body';

  const row = document.createElement('div');
  row.className = 'hero-temp-row';

  const tempEl = document.createElement('div');
  tempEl.className = 'hero-temp';
  tempEl.textContent = '—';

  const iconSlot = document.createElement('div');
  iconSlot.className = 'hero-icon-slot';

  row.append(tempEl, iconSlot);

  const descEl = document.createElement('div');
  descEl.className = 'hero-weather-desc';

  const metaEl = document.createElement('div');
  metaEl.className = 'hero-weather-meta';

  body.append(row, descEl, metaEl);
  col.append(lab, body);

  return { col, lab, tempEl, iconSlot, descEl, metaEl };
}

/**
 * City label for the primary hero tile (live GPS place, else server default).
 * @param {object} config
 * @param {{ shortLabel?: string, source?: string } | null} [place]
 */
function primaryPlaceLabel(config, place) {
  const fromPlace = typeof place?.shortLabel === 'string' ? place.shortLabel.trim() : '';
  if (fromPlace && fromPlace !== 'Locating…' && fromPlace !== 'Location unavailable') {
    return fromPlace;
  }
  // Live fix arrived but reverse-geocode is still pending — don't keep the home ZIP name.
  if (place?.source === 'device') return fromPlace === 'Location unavailable' ? 'Here' : 'Locating…';
  const fromConfig =
    (typeof config?.weatherPlace === 'string' && config.weatherPlace.trim()) ||
    (typeof config?.locationLabel === 'string'
      ? String(config.locationLabel).split('·')[0].trim()
      : '');
  return fromConfig || 'Here';
}

/**
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 */
function heroPlaceDistanceM(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * @param {{ tempEl: HTMLElement, iconSlot: HTMLElement, descEl: HTMLElement, metaEl: HTMLElement }} cityEls
 * @param {any} w
 * @param {string} idSuffix
 * @param {{ heatAdvisory?: boolean }} [iconOptions]
 */
function fillCityWeather({ tempEl, iconSlot, descEl, metaEl }, w, idSuffix, iconOptions = {}) {
  const t = Math.round(w.tempF);
  tempEl.textContent = `${t}°`;
  const feel = w.apparentF != null ? Math.round(w.apparentF) : t;
  const label = describeWeather(w.code);
  descEl.textContent = `${label} · feels like ${feel}°`;

  metaEl.replaceChildren();
  const toward = windTowardDeg(w.windDirectionFromDeg);
  const hasWind = toward != null || w.windMph != null;
  if (hasWind) {
    metaEl.appendChild(createWindDisplay(toward, w.windMph, w.windDirectionFromDeg));
  }
  const aqi = w.usAqi != null && Number.isFinite(Number(w.usAqi)) ? Math.round(Number(w.usAqi)) : null;
  if (aqi != null) {
    if (hasWind) {
      const sep = document.createElement('span');
      sep.className = 'hero-weather-meta-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '·';
      metaEl.appendChild(sep);
    }
    const aqiWrap = document.createElement('span');
    aqiWrap.className = 'hero-city-aqi-wrap';
    const numEl = document.createElement('span');
    numEl.className = 'hero-city-aqi';
    numEl.textContent = `AQI ${aqi}`;
    aqiWrap.appendChild(numEl);
    const warn = buildAqiWarnGlyph(aqi);
    if (warn) aqiWrap.appendChild(warn);
    metaEl.appendChild(aqiWrap);
  }

  iconSlot.replaceChildren(createPolygonWeatherIcon(w.code, idSuffix, iconOptions));
}

/**
 * Weather authority memo check (NWS active alerts for point).
 * @returns {Promise<{ heatAdvisory: boolean }>}
 */
async function fetchWeatherAuthorityMemo(lat, lon, zip) {
  const qs = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  const z = String(zip || '')
    .trim()
    .replace(/\D/g, '');
  if (z.length === 5) qs.set('zip', z);
  const r = await fetch(`/api/weather-authority-memos?${qs.toString()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return { heatAdvisory: j?.ok === true && j?.heatAdvisory === true };
}

/** Next moon phase caption under moonrise (`Full Moon: May 17` or `New Moon: Jun 15`). */
function buildMoonFlankItem(moonGlyph, moonriseLabel, moonPhaseCaption) {
  const item = document.createElement('div');
  item.className = 'hero-astro-item hero-astro-item--moon-flank';
  const g = document.createElement('div');
  g.className = 'hero-astro-glyph-wrap';
  g.appendChild(moonGlyph);
  const text = document.createElement('div');
  text.className = 'hero-astro-text';
  const t1 = document.createElement('span');
  t1.className = 'hero-astro-title';
  t1.textContent = 'Moonrise';
  const t2 = document.createElement('div');
  t2.className = 'hero-astro-time';
  const rise =
    moonriseLabel != null && String(moonriseLabel).trim() !== '' ? String(moonriseLabel).trim() : '—';
  t2.textContent = rise;
  text.append(t1, t2);
  if (moonPhaseCaption != null && String(moonPhaseCaption).trim() !== '') {
    const cap = document.createElement('div');
    cap.className = 'hero-caption-text hero-moon-next-full';
    cap.textContent = String(moonPhaseCaption).trim();
    text.appendChild(cap);
  }
  item.append(g, text);
  return item;
}

/**
 * @param {string} [linkHref] If set (https? only), row is an external link (e.g. ISS → Spot the Station).
 * @param {string} [captionText] Optional second line (same scale as city weather description).
 */
export function buildAstroItem(glyphEl, title, timeText, linkHref, captionText) {
  const href =
    typeof linkHref === 'string' && /^https?:\/\//i.test(linkHref.trim())
      ? linkHref.trim()
      : '';
  const item = href ? document.createElement('a') : document.createElement('div');
  item.className = href ? 'hero-astro-item hero-astro-item--link' : 'hero-astro-item';
  if (href) {
    item.href = href;
    item.target = '_blank';
    item.rel = 'noopener noreferrer';
  }
  const g = document.createElement('div');
  g.className = 'hero-astro-glyph-wrap';
  g.appendChild(glyphEl);
  const text = document.createElement('div');
  text.className = 'hero-astro-text';
  const t1 = document.createElement('span');
  t1.className = 'hero-astro-title';
  t1.textContent = title;
  text.appendChild(t1);
  if (timeText != null && String(timeText).trim() !== '') {
    const t2 = document.createElement('strong');
    t2.className = 'hero-astro-time';
    t2.textContent = timeText;
    text.appendChild(t2);
  }
  if (captionText != null && String(captionText).trim() !== '') {
    const cap = document.createElement('div');
    cap.className = 'hero-caption-text';
    cap.textContent = String(captionText).trim();
    text.appendChild(cap);
  }
  item.append(g, text);
  return item;
}

function formatSkyEventUntilEnd(endIso, timeZone) {
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : FALLBACK_TZ;
  const e = endIso != null && endIso !== '' ? new Date(endIso) : null;
  if (!e || Number.isNaN(e.getTime())) return '—';
  const d = e.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  });
  const t = e.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  });
  return `Until ${d} · ${t}`;
}

function formatSkyEventLine(startIso, endIso, peakIso, now, timeZone) {
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : FALLBACK_TZ;
  const nowMs = (now instanceof Date ? now : new Date()).getTime();
  const s = new Date(startIso);
  if (Number.isNaN(s.getTime())) return '—';
  const sMs = s.getTime();

  const e = endIso != null && endIso !== '' ? new Date(endIso) : null;
  const eMs = e && !Number.isNaN(e.getTime()) ? e.getTime() : null;

  const p = peakIso != null && peakIso !== '' ? new Date(peakIso) : null;
  const pMs = p && !Number.isNaN(p.getTime()) ? p.getTime() : null;

  if (pMs != null && nowMs < pMs) {
    const d = p.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: tz,
    });
    const t = p.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz,
    });
    return `${d} · ${t} (peak)`;
  }

  if (eMs != null && eMs > sMs && nowMs >= sMs) {
    const d2 = e.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: tz,
    });
    const t2 = e.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz,
    });
    return `Until ${d2} · ${t2}`;
  }

  const d1 = s.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  });
  const t1 = s.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  });
  if (eMs == null || eMs === sMs) return `${d1} · ${t1}`;
  const d1c = s.toLocaleDateString('en-CA', { timeZone: tz });
  const d2c = e.toLocaleDateString('en-CA', { timeZone: tz });
  const t2 = e.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  });
  if (d1c === d2c) return `${d1} · ${t1} – ${t2}`;
  const d2 = e.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  });
  return `${d1} ${t1} → ${d2} ${t2}`;
}

const SKY_AIRCRAFT_ICON = '/assets/sky/aircraft-strip.png';
const SKY_HELICOPTER_ICON = '/assets/sky/medical-helicopter-strip.png';

/**
 * @param {object} ev
 * @param {object} meta
 */
function skyEventIconSrc(ev, meta) {
  if (ev.type === 'aircraft') {
    if (ev.aircraftHelicopter || ev.aircraftMedicalHelicopter) return SKY_HELICOPTER_ICON;
    return SKY_AIRCRAFT_ICON;
  }
  return meta.icon;
}

function buildSkyEventGlyph(iconSrc, eventType) {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img';
  if (eventType === 'aurora') wrap.classList.add('hero-astro-glyph--aurora');
  if (iconSrc === SKY_AIRCRAFT_ICON) wrap.classList.add('sky-aircraft-glyph');
  if (iconSrc === SKY_HELICOPTER_ICON) wrap.classList.add('sky-helicopter-glyph');
  if (!iconSrc) {
    wrap.textContent = '◆';
    wrap.setAttribute('aria-hidden', 'true');
    return wrap;
  }
  const img = document.createElement('img');
  img.src = iconSrc;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

/**
 * @param {HTMLElement} container
 * @param {object | null} j
 * @param {object | null} moonJ
 * @param {string} tz
 */
/**
 * @param {object} ev
 * @param {string} tz
 */
function appendSkyStripRow(container, ev, tz) {
  const meta = ev.typeMeta || {};
  const glyph = buildSkyEventGlyph(skyEventIconSrc(ev, meta), ev.type);
  const shortTitle =
    ev.type === 'aircraft'
      ? (ev.title || meta.label || 'Aircraft nearby').trim()
      : (meta.label || '').trim() || ev.title || 'Event';
  let line = null;
  if (ev.type === 'supermoon') {
    line = null;
  } else if (ev.type === 'meteor' || ev.type === 'comet') {
    line = formatSkyEventUntilEnd(ev.endsAt, tz);
  } else if (typeof ev.detailLine === 'string' && ev.detailLine.trim() !== '') {
    line = ev.detailLine.trim();
  } else {
    line = formatSkyEventLine(ev.startsAt, ev.endsAt, ev.peakAt, new Date(), tz);
  }
  if (line != null && String(line).trim() !== '') {
    line = detailLineWithSkyHarvestLicenseHint(line, ev);
  }
  const linkHref =
    (typeof ev.forecastUrl === 'string' && ev.forecastUrl.trim()) ||
    (typeof meta.forecastUrl === 'string' ? meta.forecastUrl : '');
  const item = buildAstroItem(glyph, shortTitle, line, linkHref);
  if (ev.source) item.title = ev.source;
  else if (linkHref) item.title = 'Open sighting forecast (new tab)';
  container.appendChild(item);
}

function renderSkyEventStrip(container, j, moonJ, tz) {
  container.replaceChildren();
  const skyActive = j?.ok && Array.isArray(j.active) ? j.active : [];
  const aircraftRows = skyActive.filter((ev) => ev && ev.type === 'aircraft');
  const planetRows = skyActive.filter((ev) => ev && ev.type === 'planet');
  const otherRows = skyActive.filter(
    (ev) => ev && ev.type !== 'aircraft' && ev.type !== 'planet',
  );
  const moonbows =
    moonJ?.ok && Array.isArray(moonJ.items)
      ? moonJ.items.filter((x) => x && String(x.earthType || '') === 'yosemite_moonbow')
      : [];

  if (aircraftRows.length === 0 && planetRows.length === 0 && otherRows.length === 0 && moonbows.length === 0) {
    const p = document.createElement('p');
    p.className = 'hero-sky-empty';
    p.textContent = 'No sky events in the next 24 hours (or 3-day ISS / satellite pass window).';
    container.appendChild(p);
    return;
  }

  const maxCalendarRows = moonbows.length > 0 ? 5 : 6;
  for (let p = 0; p < planetRows.length; p++) {
    appendSkyStripRow(container, planetRows[p], tz);
  }
  const otherSlots = Math.max(0, maxCalendarRows - planetRows.length);
  for (let i = 0; i < Math.min(otherRows.length, otherSlots); i++) {
    appendSkyStripRow(container, otherRows[i], tz);
  }

  for (let m = 0; m < moonbows.length; m++) {
    const mb = moonbows[m];
    const glyph = buildYosemiteMoonbowSkyGlyph();
    const title = (mb.label || '').trim() || 'Yosemite moonbow';
    const lineRaw =
      typeof mb.detailLine === 'string' && mb.detailLine.trim() !== '' ? mb.detailLine.trim() : '';
    const linkHref =
      typeof mb.forecastUrl === 'string' && /^https?:\/\//i.test(mb.forecastUrl.trim())
        ? mb.forecastUrl.trim()
        : '';
    const item = buildAstroItem(glyph, title, lineRaw || null, linkHref);
    item.title =
      'Yosemite moonbow: static prediction window from public/data (update yearly); opens yosemitemoonbow.com (new tab)';
    container.appendChild(item);
  }

  for (let a = 0; a < aircraftRows.length; a++) {
    appendSkyStripRow(container, aircraftRows[a], tz);
  }
}

/**
 * @param {HTMLElement} container
 * @param {string} tz
 * @param {object | null} moonJ Yosemite moonbow payload (fetched once per page open).
 */
async function refreshSkyEventStrip(container, tz, moonJ) {
  const j = await fetch('/api/sky-events?windowHours=24', { cache: 'no-store' }).then((r) =>
    r.ok ? r.json() : null,
  );
  if (j) writePanelCache('sky-events', { sky: j, moon: moonJ });
  renderSkyEventStrip(container, j, moonJ, tz);
}

function fillSkyEventStrip(container, timeZone) {
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : FALLBACK_TZ;
  container.className = 'hero-astro-middle';
  container.setAttribute(
    'aria-label',
    'Sky & space: calendar events in the next 24 hours; ISS, satellite train, and launch passes within 3 days with look direction; aircraft nearby when in range (refreshes about every 90 seconds); total solar/lunar eclipse heads-up when upcoming; Yosemite moonbow when active',
  );

  if (container._skyStripPollTimer) {
    clearInterval(container._skyStripPollTimer);
    container._skyStripPollTimer = null;
  }

  let hasRendered = false;
  /** @type {object | null} */
  let moonJ = null;

  const cachedSky = readPanelCache('sky-events', SKY_CACHE_MAX_MS);
  if (cachedSky && typeof cachedSky === 'object' && cachedSky.sky) {
    moonJ = cachedSky.moon ?? null;
    renderSkyEventStrip(container, cachedSky.sky, moonJ, tz);
    hasRendered = true;
  }

  const moonbowPromise = fetch('/api/yosemite-moonbow', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      moonJ = j;
      return j;
    })
    .catch(() => null);

  /**
   * @param {boolean} waitForMoonbow
   */
  const tick = (waitForMoonbow = false) => {
    const run = async () => {
      if (waitForMoonbow) {
        const skyPromise = fetch('/api/sky-events?windowHours=24', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : null,
        );
        const [, skyJ] = await Promise.all([moonbowPromise, skyPromise]);
        if (skyJ) writePanelCache('sky-events', { sky: skyJ, moon: moonJ });
        renderSkyEventStrip(container, skyJ, moonJ, tz);
        return;
      }
      await refreshSkyEventStrip(container, tz, moonJ);
    };
    run()
      .then(() => {
        hasRendered = true;
      })
      .catch(() => {
        if (!hasRendered) container.replaceChildren();
      });
  };

  tick(true);
  container._skyStripPollTimer = setInterval(() => tick(false), SKY_STRIP_POLL_MS);
}

/**
 * @param {HTMLElement} root
 * @param {object} config
 * @param {{ skyStripMount?: HTMLElement | null, renderSkyStrip?: boolean }} [options]
 *   When `renderSkyStrip` is false, sky / space rows are not shown. Otherwise `skyStripMount` targets the sidebar; if omitted, rows render inside the hero.
 */
export function mountHero(root, config, options = {}) {
  const renderSkyStrip = options?.renderSkyStrip !== false;
  const skyStripMount = options?.skyStripMount ?? null;
  const locationMode =
    config?.locationMode === 'preview' || config?.locationMode === 'away'
      ? config.locationMode
      : 'home';
  const awayOnly = config?.awayOnly === true || locationMode === 'away';
  let displayTz =
    typeof config.weatherTimeZone === 'string' && config.weatherTimeZone.trim() !== ''
      ? config.weatherTimeZone.trim()
      : FALLBACK_TZ;

  root.replaceChildren();

  const cluster = document.createElement('div');
  cluster.className = 'hero-cluster';

  if (locationMode === 'preview') {
    const previewChip = document.createElement('p');
    previewChip.className = 'hero-away-preview-chip';
    previewChip.textContent = 'Preview — Away base (not on site)';
    cluster.append(previewChip);
  } else if (locationMode === 'away') {
    const awayChip = document.createElement('p');
    awayChip.className = 'hero-away-preview-chip hero-away-preview-chip--live';
    awayChip.textContent = `Away · ${config.awayBase?.label || config.weatherPlace || 'destination'}`;
    cluster.append(awayChip);
  }

  const timeRow = document.createElement('div');
  timeRow.className = 'hero-time-row';

  const clockEl = document.createElement('div');
  clockEl.className = 'hero-clock';
  const dateEl = document.createElement('div');
  dateEl.className = 'hero-date';
  const precipEl = document.createElement('div');
  precipEl.className = 'hero-date-precip';
  precipEl.setAttribute('aria-live', 'polite');

  const timeStack = document.createElement('div');
  timeStack.className = 'hero-time-stack';
  timeStack.append(clockEl, dateEl, precipEl);

  const sunBlock = document.createElement('div');
  sunBlock.className = 'hero-astro-end hero-astro-end--flank hero-astro-end--sun';
  const moonBlock = document.createElement('div');
  moonBlock.className = 'hero-astro-end hero-astro-end--flank hero-astro-end--moon';

  timeRow.append(sunBlock, timeStack, moonBlock);

  const citiesWrap = document.createElement('div');
  citiesWrap.className = 'hero-cities';

  const initialPlace = getDevicePlace();
  const hereLabel =
    locationMode === 'preview'
      ? (typeof config.weatherPlace === 'string' && config.weatherPlace.trim()) ||
        config.awayBase?.label ||
        'Away'
      : primaryPlaceLabel(config, initialPlace);
  const here = buildCityBlock(hereLabel);
  const sep = document.createElement('div');
  sep.className = 'hero-cities-sep';
  sep.setAttribute('role', 'presentation');
  const secondaryLabel =
    locationMode === 'preview'
      ? (typeof config.homeBase?.label === 'string' && config.homeBase.label.trim()) ||
        (typeof config.sfWeatherPlace === 'string' && config.sfWeatherPlace.trim()) ||
        'Home'
      : (typeof config.sfWeatherPlace === 'string' && config.sfWeatherPlace.trim()) ||
        'San Francisco';
  const sf = buildCityBlock(secondaryLabel);

  citiesWrap.append(here.col, sep, sf.col);
  if (awayOnly) {
    sep.hidden = true;
    sf.col.hidden = true;
    citiesWrap.classList.add('hero-cities--away-only');
  }

  let astro = null;
  if (renderSkyStrip) {
    if (skyStripMount) {
      fillSkyEventStrip(skyStripMount, displayTz);
    } else {
      astro = document.createElement('div');
      astro.className = 'hero-astro';

      const astroInner = document.createElement('div');
      astroInner.className = 'hero-astro-inner';

      const middle = document.createElement('div');
      fillSkyEventStrip(middle, displayTz);

      astroInner.append(middle);
      astro.append(astroInner);
    }
  }

  const loading = document.createElement('p');
  loading.className = 'hero-loading';
  loading.textContent = 'Loading weather…';

  cluster.append(timeRow, citiesWrap, ...(astro ? [astro] : []), loading);
  root.appendChild(cluster);

  const tick = () => {
    const now = new Date();
    clockEl.textContent = formatTime12h(now, displayTz);
    dateEl.textContent = formatDateLong(now, displayTz);
  };
  tick();
  setInterval(tick, 1000);

  const fallbackLat = Number(config.weatherLat);
  const fallbackLon = Number(config.weatherLon);
  const sfLat = config.sfWeatherLat;
  const sfLon = config.sfWeatherLon;

  /** @type {{ lat: number, lon: number } | null} */
  let loadedAt = null;
  /** @type {string} */
  let loadedLabel = here.lab.textContent || '';
  let rainPollStarted = false;
  let loadSeq = 0;

  /**
   * @param {{ a?: object | null, wHere?: object | null, wSf?: object | null, memo?: object | null, precipLine?: string }} payload
   * @param {{ keepLoading?: boolean, placeLive?: boolean }} [opts]
   */
  function paintHero(payload, opts = {}) {
    if (!opts.keepLoading) loading.remove();
    fillHeroPrecipLine(precipEl, typeof payload.precipLine === 'string' ? payload.precipLine : '');
    const a = payload.a;
    const wHere = payload.wHere || payload.wOak;
    const wSf = payload.wSf;
    const memo = payload.memo;
    if (wHere) {
      fillCityWeather(here, wHere, 'here', { heatAdvisory: memo?.heatAdvisory === true });
    }
    if (wSf) fillCityWeather(sf, wSf, 'sf');

    const zipOk = hasFiveDigitWeatherZip(config);
    const showUv = zipOk || opts.placeLive === true;

    if (!a || a.ok === false) {
      sunBlock.replaceChildren(
        buildAstroItem(buildHeroSunsetGlyph(), 'Sunset', '—', '', ''),
      );
      moonBlock.replaceChildren(
        buildMoonFlankItem(buildHeroMoonGlyph(new Date()), '—', ''),
      );
      return;
    }

    const sunsetMs = a.sunsetEpochMs;
    const moonMs = a.moonriseEpochMs;
    const sunsetAt =
      typeof sunsetMs === 'number' && Number.isFinite(sunsetMs) ? new Date(sunsetMs) : null;
    const astroTz =
      typeof a.timeZone === 'string' && a.timeZone.trim() !== '' ? a.timeZone.trim() : displayTz;
    const nwsLink =
      typeof a.nwsMapClickUrl === 'string' && /^https?:\/\//i.test(a.nwsMapClickUrl.trim())
        ? a.nwsMapClickUrl.trim()
        : typeof config.nwsMapClickUrl === 'string' && /^https?:\/\//i.test(config.nwsMapClickUrl.trim())
          ? config.nwsMapClickUrl.trim()
          : '';
    const showNextNew = a.moonCaptionShowsNextNewMoon === true;
    const capMs = showNextNew ? a.nextNewMoonEpochMs : a.nextFullMoonEpochMs;
    const capDate =
      typeof capMs === 'number' && Number.isFinite(capMs) ? new Date(capMs) : null;
    const moonCaption =
      capDate && !Number.isNaN(capDate.getTime())
        ? `${showNextNew ? 'New Moon:' : 'Full Moon:'} ${formatCaptionDateNoYear(capDate, astroTz)}`
        : '';

    const sunItem = buildAstroItem(
      buildHeroSunsetGlyph(),
      'Sunset',
      formatLaTime12h(sunsetAt, astroTz),
      nwsLink,
      '',
    );
    const textCol = sunItem.querySelector('.hero-astro-text');
    const timeEl = textCol?.querySelector('.hero-astro-time');
    if (
      timeEl &&
      showUv &&
      wHere &&
      wHere.uvIndex != null &&
      Number.isFinite(Number(wHere.uvIndex))
    ) {
      timeEl.after(buildSunUvWrap(wHere.uvIndex));
    }
    if (nwsLink) {
      sunItem.title = 'National Weather Service — point forecast (opens in new tab)';
    }
    sunBlock.replaceChildren(sunItem);

    moonBlock.replaceChildren(
      buildMoonFlankItem(
        buildHeroMoonGlyph(new Date()),
        formatMoonriseLabel(moonMs, astroTz),
        moonCaption,
      ),
    );
  }

  const fetchRainAlert = () =>
    fetch(`/api/rain-alert${rainAlertQueryString()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

  const refreshRain = () => {
    fetchRainAlert().then((d) => {
      fillHeroPrecipLine(
        precipEl,
        d?.imminent && d?.message ? String(d.message) : '',
      );
    });
  };

  /**
   * @param {{ lat: number, lon: number, label: string, placeLive: boolean, zip?: string | null, timeZone?: string }} point
   */
  function loadHeroForPlace(point) {
    const { lat, lon, label, placeLive } = point;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const labelText = (label || '').trim() || 'Here';
    here.lab.textContent = labelText;
    loadedLabel = labelText;
    if (typeof point.timeZone === 'string' && point.timeZone.trim() !== '') {
      displayTz = point.timeZone.trim();
    }

    const heroCacheKey = `hero-weather:${lat.toFixed(3)},${lon.toFixed(3)}:${sfLat},${sfLon}`;
    const cachedHero = readPanelCache(heroCacheKey, HERO_CACHE_MAX_MS);
    if (cachedHero && typeof cachedHero === 'object') {
      paintHero(cachedHero, { placeLive });
    }

    const astroQs = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
    });
    const memoZip = placeLive ? null : point.zip ?? config.weatherZip;
    const seq = ++loadSeq;

    Promise.all([
      fetch(`/api/hero-astronomy?${astroQs}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetchCurrentWeather(lat, lon).catch(() => null),
      fetchCurrentWeather(sfLat, sfLon).catch(() => null),
      fetchWeatherAuthorityMemo(lat, lon, memoZip).catch(() => ({ heatAdvisory: false })),
      fetchRainAlert().then((d) => (d?.imminent && d?.message ? String(d.message) : '')),
    ])
      .then(([a, wHere, wSf, memo, precipLine]) => {
        if (seq !== loadSeq) return;
        loadedAt = { lat, lon };
        const payload = {
          a,
          wHere,
          wSf,
          memo,
          precipLine: typeof precipLine === 'string' ? precipLine : '',
        };
        writePanelCache(heroCacheKey, payload);
        paintHero(payload, { placeLive });
        if (!rainPollStarted) {
          rainPollStarted = true;
          setInterval(refreshRain, 2 * 60 * 1000);
        }
      })
      .catch((e) => {
        if (seq !== loadSeq) return;
        if (!document.contains(loading)) return;
        loading.textContent = `Weather or astronomy unavailable: ${e.message}`;
      });
  }

  function placePointFromDevice(place) {
    // Preview: always use Away base coords from config (ignore home GPS).
    if (locationMode === 'preview') {
      return {
        lat: Number.isFinite(fallbackLat) ? fallbackLat : 40.7505,
        lon: Number.isFinite(fallbackLon) ? fallbackLon : -73.9971,
        label:
          (typeof config.weatherPlace === 'string' && config.weatherPlace.trim()) ||
          config.awayBase?.label ||
          'Away',
        placeLive: false,
        zip: config.weatherZip,
        timeZone: displayTz,
      };
    }
    const lat = Number(place?.lat);
    const lon = Number(place?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {
        lat: Number.isFinite(fallbackLat) ? fallbackLat : 37.848,
        lon: Number.isFinite(fallbackLon) ? fallbackLon : -122.253,
        label: primaryPlaceLabel(config, null),
        placeLive: false,
        zip: config.weatherZip,
        timeZone: displayTz,
      };
    }
    return {
      lat,
      lon,
      label: primaryPlaceLabel(config, place),
      placeLive: place?.source === 'device',
      zip: place?.source === 'device' ? null : config.weatherZip,
      timeZone:
        typeof place?.timeZone === 'string' && place.timeZone.trim() !== ''
          ? place.timeZone.trim()
          : displayTz,
    };
  }

  loadHeroForPlace(placePointFromDevice(initialPlace));

  subscribeDevicePlace((place) => {
    const next = placePointFromDevice(place);
    const labelChanged = next.label !== loadedLabel;
    if (labelChanged) {
      here.lab.textContent = next.label;
      loadedLabel = next.label;
    }
    if (
      typeof next.timeZone === 'string' &&
      next.timeZone.trim() !== '' &&
      next.timeZone !== displayTz
    ) {
      displayTz = next.timeZone.trim();
    }
    const moved =
      !loadedAt ||
      heroPlaceDistanceM(loadedAt.lat, loadedAt.lon, next.lat, next.lon) >= HERO_PLACE_MOVE_M;
    if (moved) {
      loadHeroForPlace(next);
    } else {
      refreshRain();
    }
  });
}
