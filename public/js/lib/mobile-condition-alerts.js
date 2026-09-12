/**
 * Mobile topbar: condition alert icons (volcano, geomagnetic storm / aurora,
 * air quality, rain). Each icon only appears when that condition is active,
 * mirroring the aircraft-alert pattern. Tapping opens a small popup with details.
 * Reuses existing endpoints only — no new backends.
 */
import { mountIemLeaflet } from '../panels/weather-radar.js';
import { devicePlaceQueryString, subscribeDevicePlace } from './device-location.js';

const POLL_MS = 5 * 60 * 1000;
/** Same key as desktop `kilauea-livestream.js` so cam choice syncs across surfaces. */
const KILAUEA_CAM_STORAGE_KEY = 'dashbird-kilauea-live-camera';

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;

/** @type {HTMLElement | null} */
let mountEl = null;

/** @type {{ lat: number, lon: number } | null} */
let coords = null;

/** @type {HTMLElement | null} */
let popupBackdrop = null;

/** @type {((e: KeyboardEvent) => void) | null} */
let popupKeyHandler = null;

/** @type {ReturnType<typeof setInterval> | null} */
let popupMediaTimer = null;

/** @type {(() => void) | null} */
let popupRadarCleanup = null;

/**
 * @typedef {{ id?: string, label?: string, embedUrl: string }} VolcanoCam
 * @typedef {{ kind: 'image', src: string, alt?: string }
 *   | { kind: 'iframe', src: string, title?: string, cameras?: VolcanoCam[], cameraIndex?: number }
 *   | { kind: 'frames', urls: string[], frameMs?: number, alt?: string }
 *   | { kind: 'radar', data: object }
 *   | { kind: 'slides', slides: AlertSlide[] }} AlertMedia
 * @typedef {{ id: string, label: string, media: Exclude<AlertMedia, { kind: 'slides' }> }} AlertSlide
 * @typedef {{ active: boolean, title: string, lines: string[], media?: AlertMedia | null }} AlertState
 * @typedef {{ key: string, glyph: string, label: string, load: () => Promise<AlertState>,
 *   btn: HTMLButtonElement | null, state: AlertState }} AlertDef
 */

function readSavedKilaueaCameraId() {
  try {
    return String(localStorage.getItem(KILAUEA_CAM_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

/**
 * @param {string} id
 */
function writeSavedKilaueaCameraId(id) {
  const key = String(id || '').trim();
  if (!key) return;
  try {
    localStorage.setItem(KILAUEA_CAM_STORAGE_KEY, key);
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * @param {VolcanoCam[]} cameras
 */
function indexForSavedKilaueaCamera(cameras) {
  const saved = readSavedKilaueaCameraId();
  if (!saved || !cameras.length) return 0;
  const found = cameras.findIndex((c) => c?.id === saved);
  return found >= 0 ? found : 0;
}

/** @type {AlertDef[]} */
const ALERTS = [
  { key: 'volcano', glyph: '\uD83C\uDF0B', label: 'Volcano', load: loadVolcano, btn: null, state: idle() },
  { key: 'geomag', glyph: '\uD83C\uDF0C', label: 'Geomagnetic storm', load: loadGeomag, btn: null, state: idle() },
  { key: 'air', glyph: '\uD83D\uDE37', label: 'Air quality', load: loadAir, btn: null, state: idle() },
  { key: 'rain', glyph: '\uD83C\uDF27\uFE0F', label: 'Weather radar', load: loadRain, btn: null, state: idle() },
];

/** @returns {AlertState} */
function idle() {
  return { active: false, title: '', lines: [], media: null };
}

async function loadVolcano() {
  try {
    const r = await fetch('/api/dashboard-kilauea', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    const s = j?.status || {};
    // Mobile header: erupting only. Paused + projected next dates stay desktop Earth strip.
    if (s.erupting !== true) return idle();
    const detail =
      Array.isArray(j.items) && j.items[0]?.detailLine ? String(j.items[0].detailLine) : '';
    const lines = ['\u2757 K\u012Blauea is erupting.'];
    if (detail) {
      // Strip pause/forecast segments — those are desktop-only.
      const cleaned = detail
        .split(/\s*\u00B7\s*/)
        .filter((part) => !/^\s*Paused\s*$/i.test(part) && !/\uD83D\uDCC5|\bnext:\b/i.test(part))
        .join(' \u00B7 ');
      if (cleaned) lines.push(cleaned);
    } else {
      const parts = [];
      if (s.alertLevel) parts.push(`Alert ${s.alertLevel}`);
      if (s.colorCode) parts.push(s.colorCode);
      if (s.episode != null) parts.push(`Episode ${s.episode}`);
      if (s.fountainFt != null) parts.push(`fountain ${s.fountainFt} ft`);
      if (parts.length) lines.push(parts.join(' \u00B7 '));
    }
    /** @type {VolcanoCam[]} */
    const cameras = Array.isArray(j.cameras)
      ? j.cameras
          .filter((c) => c?.embedUrl)
          .map((c) => ({
            id: c.id ? String(c.id) : undefined,
            label: c.label ? String(c.label) : undefined,
            embedUrl: String(c.embedUrl),
          }))
      : [];
    /** @type {AlertMedia} */
    let media;
    if (cameras.length) {
      const cameraIndex = indexForSavedKilaueaCamera(cameras);
      const cam = cameras[cameraIndex] || cameras[0];
      media = {
        kind: 'iframe',
        src: cam.embedUrl,
        title: cam.label
          ? `K\u012Blauea livestream \u2014 ${cam.label}`
          : 'K\u012Blauea summit livestream',
        cameras,
        cameraIndex,
      };
    } else {
      media = { kind: 'image', src: '/assets/earth-kilauea-volcano.png', alt: 'K\u012Blauea volcano' };
    }
    return {
      active: true,
      title: 'K\u012Blauea volcano \u2757',
      lines,
      media,
    };
  } catch {
    return idle();
  }
}

async function loadGeomag() {
  try {
    const [magRes, geoRes] = await Promise.all([
      fetch('/api/magnetosphere', { cache: 'no-store' }),
      fetch('/api/geoelectric-field', { cache: 'no-store' }),
    ]);
    const j = await magRes.json().catch(() => ({}));
    const geo = await geoRes.json().catch(() => ({}));
    const active = j?.stormGte2 === true || j?.stormActive === true;
    if (!active) return idle();
    const storm = j.storm || {};
    const lines = ['Geomagnetic storm active \u2014 aurora may be visible.'];
    if (storm.label) lines.push(String(storm.label));
    else {
      const parts = [];
      if (storm.g != null) parts.push(`G${storm.g}`);
      if (storm.kp != null) parts.push(`Kp ${storm.kp}`);
      if (storm.category) parts.push(String(storm.category));
      if (parts.length) lines.push(parts.join(' \u00B7 '));
    }
    const urls = Array.isArray(j.frames) ? j.frames.map((f) => f?.url).filter(Boolean) : [];
    /** @type {Exclude<AlertMedia, { kind: 'slides' }>} */
    const stormMedia = urls.length
      ? { kind: 'frames', urls, frameMs: Number(j.frameMs) || 450, alt: 'Magnetosphere cut-plane animation' }
      : { kind: 'image', src: '/assets/sky/aurora.png', alt: 'Aurora' };
    /** @type {AlertSlide[]} */
    const slides = [{ id: 'storm', label: 'Magnetosphere', media: stormMedia }];
    const geoRegions = Array.isArray(geo?.regions) ? geo.regions : [];
    for (const region of geoRegions) {
      const src = String(region?.imageSrc || region?.imageUrl || '').trim();
      if (!src) continue;
      const label = String(region.label || 'Electric grid').trim() || 'Electric grid';
      slides.push({
        id: String(region.id || src),
        label,
        media: {
          kind: 'image',
          src,
          alt: `NOAA geoelectric field \u2014 ${label}`,
        },
      });
    }
    if (!geoRegions.length) {
      const src = String(geo?.imageSrc || geo?.imageUrl || '').trim();
      if (src) {
        slides.push({
          id: 'grid',
          label: 'Electric grid',
          media: { kind: 'image', src, alt: 'NOAA 1-minute geoelectric field map' },
        });
      }
    }
    /** @type {AlertMedia} */
    const media = slides.length > 1 ? { kind: 'slides', slides } : stormMedia;
    return { active: true, title: 'Geomagnetic storm', lines, media };
  } catch {
    return idle();
  }
}

async function loadAir() {
  try {
    const r = await fetch('/api/air-quality', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (j?.disabled) return idle();
    // Server threshold is US AQI > 100 (unhealthy for sensitive groups or worse).
    const active = j?.aboveThreshold === true;
    if (!active) return idle();
    const aqi = j.usAqi != null ? Math.round(Number(j.usAqi)) : null;
    const lines = ['Air quality is in the unhealthy range.'];
    const parts = [];
    if (aqi != null) parts.push(`US AQI ${aqi}`);
    if (j.category) parts.push(String(j.category));
    if (j.zip) parts.push(`ZIP ${j.zip}`);
    if (parts.length) lines.push(parts.join(' \u00B7 '));
    /** @type {AlertMedia | null} */
    const media =
      typeof j.mapUrl === 'string' && /^https?:\/\//i.test(j.mapUrl)
        ? { kind: 'iframe', src: j.mapUrl, title: 'Air quality map (PM2.5)' }
        : null;
    return { active: true, title: 'Air quality', lines, media };
  } catch {
    return idle();
  }
}

async function loadRain() {
  try {
    // Same source the desktop Weather Radar card uses: precip active/imminent
    // within ~20 mi of the device location. More reliable than the raw WMO
    // "current" code, which often reports light rain as plain "overcast".
    const qs = devicePlaceQueryString({ includeLabel: true });
    const r = await fetch(`/api/weather-radar${qs}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false || j.show !== true) return idle();

    const place = typeof j.geo?.displayName === 'string' ? j.geo.displayName.trim() : '';
    /** @type {string[]} */
    const lines = [];
    if (j.imminent === true && Number.isFinite(Number(j.minutesUntil))) {
      const mins = Math.max(0, Math.round(Number(j.minutesUntil)));
      lines.push(mins <= 1 ? 'Rain expected now.' : `Rain expected in ~${mins} min.`);
    } else if (Number.isFinite(Number(j.hoursUntilPrecip)) && Number(j.hoursUntilPrecip) > 0) {
      lines.push(`Rain nearby within ~${Math.round(Number(j.hoursUntilPrecip))} h.`);
    } else {
      lines.push('Rain active or nearby.');
    }
    if (place) lines.push(place);

    const frames = Array.isArray(j.radar?.frames) ? j.radar.frames : [];
    /** @type {AlertMedia | null} */
    let media = null;
    if (j.provider === 'iem' && j.radar && frames.length) {
      media = { kind: 'radar', data: j };
    } else if (typeof j.embed?.mapPageUrl === 'string' && /^https?:\/\//i.test(j.embed.mapPageUrl)) {
      media = { kind: 'iframe', src: j.embed.mapPageUrl, title: 'Live weather radar' };
    }

    return { active: true, title: 'Weather radar', lines, media };
  } catch {
    return idle();
  }
}

/** Bumped to cancel in-flight frame decode/swap when the popup closes or slides change. */
let popupFrameLoopGen = 0;

function stopPopupMedia() {
  popupFrameLoopGen += 1;
  if (popupMediaTimer) {
    clearInterval(popupMediaTimer);
    popupMediaTimer = null;
  }
  if (popupRadarCleanup) {
    try {
      popupRadarCleanup();
    } catch {
      /* ignore teardown errors */
    }
    popupRadarCleanup = null;
  }
}

function closePopup() {
  if (popupKeyHandler) {
    document.removeEventListener('keydown', popupKeyHandler);
    popupKeyHandler = null;
  }
  stopPopupMedia();
  popupBackdrop?.remove();
  popupBackdrop = null;
  for (const a of ALERTS) a.btn?.setAttribute('aria-expanded', 'false');
}

/**
 * Fixed-size image box so loading / frame swaps cannot resize the dialog.
 * @param {HTMLElement} host
 * @param {string} src
 * @param {string} [alt]
 */
function appendStillImage(host, src, alt) {
  const stage = document.createElement('div');
  stage.className = 'mobile-alert-header__media-stage';
  const img = document.createElement('img');
  img.className = 'mobile-alert-header__media-img mobile-alert-header__media-img--show';
  img.src = src;
  img.alt = alt || '';
  img.decoding = 'async';
  stage.append(img);
  host.append(stage);
}

/**
 * Double-buffer NOAA frame loops so the popup keeps a stable size while frames decode.
 * @param {HTMLElement} host
 * @param {string[]} urls
 * @param {string} [alt]
 * @param {number} [frameMs]
 */
function startStableFrameLoop(host, urls, alt, frameMs) {
  const stage = document.createElement('div');
  stage.className = 'mobile-alert-header__media-stage';
  const a = document.createElement('img');
  const b = document.createElement('img');
  a.className = 'mobile-alert-header__media-img mobile-alert-header__media-img--show';
  b.className = 'mobile-alert-header__media-img';
  a.alt = alt || '';
  b.alt = '';
  b.setAttribute('aria-hidden', 'true');
  a.decoding = 'async';
  b.decoding = 'async';
  stage.append(a, b);
  host.append(stage);

  const list = urls.filter(Boolean);
  if (!list.length) return;
  for (const url of list) {
    const pre = new Image();
    pre.decoding = 'async';
    pre.src = url;
  }

  const gen = ++popupFrameLoopGen;
  let idx = 0;
  let showingA = true;
  a.src = list[0];

  /**
   * @param {number} i
   */
  async function paint(i) {
    if (gen !== popupFrameLoopGen) return;
    const url = list[i % list.length];
    const hidden = showingA ? b : a;
    const shown = showingA ? a : b;
    hidden.src = url;
    try {
      await hidden.decode();
    } catch {
      /* decode can fail on abort; still try to show */
    }
    if (gen !== popupFrameLoopGen) return;
    hidden.classList.add('mobile-alert-header__media-img--show');
    shown.classList.remove('mobile-alert-header__media-img--show');
    showingA = !showingA;
  }

  if (list.length < 2) return;
  const ms = Number(frameMs) || 450;
  if (popupMediaTimer) clearInterval(popupMediaTimer);
  popupMediaTimer = setInterval(() => {
    idx = (idx + 1) % list.length;
    void paint(idx);
  }, ms);
}

/**
 * Overlay arrows + caption row for paging slides or cameras.
 * @param {{ ariaPrev: string, ariaNext: string, onStep: (delta: number) => void }} opts
 */
function attachSlideControls(wrap, frameWrap, opts) {
  const labelEl = document.createElement('span');
  labelEl.className = 'mobile-alert-header__cam-label';
  const counterEl = document.createElement('span');
  counterEl.className = 'mobile-alert-header__cam-counter';

  const arrowPrev = document.createElement('button');
  arrowPrev.type = 'button';
  arrowPrev.className = 'mobile-alert-header__cam-arrow mobile-alert-header__cam-arrow--prev';
  arrowPrev.setAttribute('aria-label', opts.ariaPrev);
  arrowPrev.textContent = '\u2039';
  arrowPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onStep(-1);
  });

  const arrowNext = document.createElement('button');
  arrowNext.type = 'button';
  arrowNext.className = 'mobile-alert-header__cam-arrow mobile-alert-header__cam-arrow--next';
  arrowNext.setAttribute('aria-label', opts.ariaNext);
  arrowNext.textContent = '\u203A';
  arrowNext.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onStep(1);
  });

  frameWrap.append(arrowPrev, arrowNext);

  const meta = document.createElement('div');
  meta.className = 'mobile-alert-header__cam-meta';
  const navPrev = document.createElement('button');
  navPrev.type = 'button';
  navPrev.className = 'mobile-alert-header__cam-nav';
  navPrev.setAttribute('aria-label', opts.ariaPrev);
  navPrev.textContent = '\u2039';
  navPrev.addEventListener('click', () => opts.onStep(-1));
  const navNext = document.createElement('button');
  navNext.type = 'button';
  navNext.className = 'mobile-alert-header__cam-nav';
  navNext.setAttribute('aria-label', opts.ariaNext);
  navNext.textContent = '\u203A';
  navNext.addEventListener('click', () => opts.onStep(1));
  meta.append(navPrev, labelEl, counterEl, navNext);
  wrap.append(meta);
  return { labelEl, counterEl };
}

/**
 * @param {Exclude<AlertMedia, { kind: 'slides' }>} media
 * @param {HTMLElement} host
 */
function fillMediaHost(host, media) {
  if (media.kind === 'image') {
    appendStillImage(host, media.src, media.alt);
    return;
  }
  if (media.kind === 'frames' && media.urls.length) {
    startStableFrameLoop(host, media.urls, media.alt, media.frameMs);
  }
}

/**
 * Build the visual media element for a popup, if the alert has any.
 * Uses only assets/animations that already exist in the app.
 * @param {AlertMedia | null | undefined} media
 * @returns {HTMLElement | null}
 */
function buildMedia(media) {
  if (!media) return null;

  if (media.kind === 'slides' && media.slides.length) {
    const slides = media.slides.filter((s) => s?.media && s.media.kind !== 'slides');
    if (!slides.length) return null;
    if (slides.length === 1) return buildMedia(slides[0].media);

    const wrap = document.createElement('div');
    wrap.className = 'mobile-alert-header__media mobile-alert-header__media--cams';
    const frameWrap = document.createElement('div');
    frameWrap.className = 'mobile-alert-header__frame-wrap';
    const stageHost = document.createElement('div');
    stageHost.className = 'mobile-alert-header__slide-host';
    frameWrap.append(stageHost);
    wrap.append(frameWrap);

    let index = 0;
    const { labelEl, counterEl } = attachSlideControls(wrap, frameWrap, {
      ariaPrev: 'Previous storm graphic',
      ariaNext: 'Next storm graphic',
      onStep: (delta) => {
        index = (index + delta + slides.length) % slides.length;
        paint();
      },
    });

    const paint = () => {
      stopPopupMedia();
      stageHost.replaceChildren();
      const slide = slides[index];
      fillMediaHost(stageHost, slide.media);
      labelEl.textContent = slide.label || `Graphic ${index + 1}`;
      counterEl.textContent = `${index + 1} / ${slides.length}`;
    };

    paint();
    return wrap;
  }

  const wrap = document.createElement('div');
  wrap.className = 'mobile-alert-header__media';
  if (media.kind === 'image' || media.kind === 'frames') {
    fillMediaHost(wrap, media);
    return wrap.childNodes.length ? wrap : null;
  }

  if (media.kind === 'radar') {
    wrap.classList.add('mobile-alert-header__media--radar');
    const host = document.createElement('div');
    host.className = 'mobile-alert-header__media-radar';
    wrap.append(host);
    try {
      popupRadarCleanup = mountIemLeaflet(host, media.data);
    } catch {
      popupRadarCleanup = null;
    }
    return wrap;
  }

  if (media.kind === 'iframe') {
    const cameras = Array.isArray(media.cameras) ? media.cameras.filter((c) => c?.embedUrl) : [];
    if (cameras.length > 1) {
      wrap.classList.add('mobile-alert-header__media--cams');

      let index = Number.isFinite(Number(media.cameraIndex))
        ? Math.max(0, Math.min(cameras.length - 1, Number(media.cameraIndex)))
        : 0;

      const frameWrap = document.createElement('div');
      frameWrap.className = 'mobile-alert-header__frame-wrap';

      const iframe = document.createElement('iframe');
      iframe.className = 'mobile-alert-header__media-frame';
      iframe.loading = 'lazy';
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.setAttribute(
        'allow',
        'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen',
      );
      iframe.allowFullscreen = true;

      const labelEl = document.createElement('span');
      labelEl.className = 'mobile-alert-header__cam-label';
      const counterEl = document.createElement('span');
      counterEl.className = 'mobile-alert-header__cam-counter';

      const paint = () => {
        const cam = cameras[index];
        if (!cam) return;
        iframe.src = cam.embedUrl;
        iframe.title = cam.label
          ? `K\u012Blauea livestream \u2014 ${cam.label}`
          : media.title || 'K\u012Blauea summit livestream';
        labelEl.textContent = cam.label || `Cam ${index + 1}`;
        counterEl.textContent = `${index + 1} / ${cameras.length}`;
        if (cam.id) writeSavedKilaueaCameraId(cam.id);
      };

      /**
       * @param {number} delta
       */
      const step = (delta) => {
        index = (index + delta + cameras.length) % cameras.length;
        paint();
      };

      const arrowPrev = document.createElement('button');
      arrowPrev.type = 'button';
      arrowPrev.className = 'mobile-alert-header__cam-arrow mobile-alert-header__cam-arrow--prev';
      arrowPrev.setAttribute('aria-label', 'Previous K\u012Blauea camera');
      arrowPrev.textContent = '\u2039';
      arrowPrev.addEventListener('click', (e) => {
        e.stopPropagation();
        step(-1);
      });

      const arrowNext = document.createElement('button');
      arrowNext.type = 'button';
      arrowNext.className = 'mobile-alert-header__cam-arrow mobile-alert-header__cam-arrow--next';
      arrowNext.setAttribute('aria-label', 'Next K\u012Blauea camera');
      arrowNext.textContent = '\u203A';
      arrowNext.addEventListener('click', (e) => {
        e.stopPropagation();
        step(1);
      });

      frameWrap.append(iframe, arrowPrev, arrowNext);

      const meta = document.createElement('div');
      meta.className = 'mobile-alert-header__cam-meta';
      const navPrev = document.createElement('button');
      navPrev.type = 'button';
      navPrev.className = 'mobile-alert-header__cam-nav';
      navPrev.setAttribute('aria-label', 'Previous K\u012Blauea camera');
      navPrev.textContent = '\u2039';
      navPrev.addEventListener('click', () => step(-1));
      const navNext = document.createElement('button');
      navNext.type = 'button';
      navNext.className = 'mobile-alert-header__cam-nav';
      navNext.setAttribute('aria-label', 'Next K\u012Blauea camera');
      navNext.textContent = '\u203A';
      navNext.addEventListener('click', () => step(1));
      meta.append(navPrev, labelEl, counterEl, navNext);

      wrap.append(frameWrap, meta);
      paint();
      return wrap;
    }

    const iframe = document.createElement('iframe');
    iframe.className = 'mobile-alert-header__media-frame';
    iframe.src = media.src;
    iframe.title = media.title || 'Details';
    iframe.loading = 'lazy';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.setAttribute(
      'allow',
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen',
    );
    iframe.allowFullscreen = true;
    wrap.append(iframe);
    return wrap;
  }

  return null;
}

/**
 * @param {AlertDef} alert
 */
function openPopup(alert) {
  if (!alert.state.active) return;
  closePopup();

  const backdrop = document.createElement('div');
  backdrop.className = 'mobile-alert-header__backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closePopup();
  });

  const shell = document.createElement('div');
  shell.className = 'mobile-alert-header__dialog';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-modal', 'true');
  shell.setAttribute('aria-label', alert.state.title || alert.label);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mobile-alert-header__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';
  closeBtn.addEventListener('click', closePopup);

  const head = document.createElement('div');
  head.className = 'mobile-alert-header__head';
  const glyph = document.createElement('span');
  glyph.className = 'mobile-alert-header__head-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = alert.glyph;
  const title = document.createElement('div');
  title.className = 'mobile-alert-header__title';
  title.textContent = alert.state.title || alert.label;
  head.append(glyph, title);

  const media = buildMedia(alert.state.media);

  const body = document.createElement('div');
  body.className = 'mobile-alert-header__body';
  for (const line of alert.state.lines) {
    const p = document.createElement('p');
    p.className = 'mobile-alert-header__line';
    p.textContent = line;
    body.append(p);
  }

  if (media) shell.append(closeBtn, head, media, body);
  else shell.append(closeBtn, head, body);
  backdrop.append(shell);
  document.body.append(backdrop);
  popupBackdrop = backdrop;
  alert.btn?.setAttribute('aria-expanded', 'true');

  popupKeyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePopup();
    }
  };
  document.addEventListener('keydown', popupKeyHandler);
}

/**
 * @param {AlertDef} alert
 */
function renderIcon(alert) {
  if (!alert.btn) return;
  const on = alert.state.active;
  alert.btn.hidden = !on;
  if (on) {
    alert.btn.title = alert.state.lines[0] || alert.state.title || alert.label;
    alert.btn.setAttribute('aria-label', `${alert.state.title || alert.label}: tap for details`);
  }
}

function syncMountVisibility() {
  if (!mountEl) return;
  mountEl.hidden = !ALERTS.some((a) => a.state.active);
}

async function refreshAlerts() {
  await Promise.all(
    ALERTS.map(async (alert) => {
      alert.state = await alert.load();
      renderIcon(alert);
    }),
  );
  if (popupBackdrop && !ALERTS.some((a) => a.state.active)) closePopup();
  syncMountVisibility();
}

/**
 * @param {import('./device-location.js').DevicePlace} place
 */
function onPlaceChange(place) {
  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return;
  const changed = !coords || coords.lat !== place.lat || coords.lon !== place.lon;
  coords = { lat: place.lat, lon: place.lon };
  // Re-check conditions right away on a meaningful move (e.g. arriving somewhere
  // that is actively raining) instead of waiting for the next poll.
  if (changed) void refreshAlerts();
}

/**
 * @param {HTMLElement | null} root
 */
export function mountMobileConditionAlerts(root) {
  if (!root) return;
  mountEl = root;
  mountEl.hidden = true;
  mountEl.className = 'topbar__conditions mobile-alert-header';
  mountEl.replaceChildren();

  for (const alert of ALERTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mobile-alert-header__btn mobile-alert-header__btn--${alert.key}`;
    btn.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    const glyph = document.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = alert.glyph;
    btn.append(glyph);
    btn.addEventListener('click', () => {
      if (popupBackdrop && popupBackdrop.dataset.key === alert.key) closePopup();
      else {
        openPopup(alert);
        if (popupBackdrop) popupBackdrop.dataset.key = alert.key;
      }
    });
    alert.btn = btn;
    mountEl.append(btn);
  }

  subscribeDevicePlace(onPlaceChange);
  void refreshAlerts();
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      void refreshAlerts();
    }, POLL_MS);
  }
}
