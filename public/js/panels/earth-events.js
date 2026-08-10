import { buildAstroItem } from './hero.js';
import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

const EARTH_CACHE_KEY = 'earth-strip-fast';
const EARTH_CACHE_MAX_MS = 60 * 60 * 1000;

const MONARCH_STRIP_ICON_SRC = '/assets/monarch-earth-strip.png';

function buildMonarchGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-monarch-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = MONARCH_STRIP_ICON_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

const SALMON_STRIP_ICON_SRC = '/assets/salmon-earth-strip.png';

function buildSalmonGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-salmon-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = SALMON_STRIP_ICON_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

const MINERS_LETTUCE_STRIP_SRC = '/assets/miners-lettuce-earth-strip.png';
const TARANTULA_STRIP_ICON_SRC = '/assets/earth-tarantula-strip.png';
const SALAMANDER_STRIP_ICON_SRC = '/assets/earth-salamander-strip.png';
const EARTHQUAKE_PIN_SRC = '/assets/earth-earthquake-pin.png';
const KILAUEA_STRIP_ICON_SRC = '/assets/earth-kilauea-volcano.png';
const GLM_LIGHTNING_STRIP_SRC = '/assets/earth-glm-lightning-strip.png';
const NASTURTIUM_STRIP_ICON_SRC = '/assets/earth-nasturtium-strip.png';
const FIREFLY_STRIP_ICON_SRC = '/assets/earth-firefly-strip.png';
const FALL_FOLIAGE_STRIP_ICON_SRC = '/assets/earth-fall-foliage-strip.png';
const HURRICANE_ICON_SRC = '/assets/earth-hurricane-icon.png';
const FRUIT_APPLE_ICON_SRC = '/assets/fruit-apple.png';
const FRUIT_PEAR_ICON_SRC = '/assets/fruit-pear.png';
const FRUIT_PEACH_ICON_SRC = '/assets/fruit-peach.png';
const FRUIT_PLUM_ICON_SRC = '/assets/fruit-plum.png';
const FRUIT_FIG_ICON_SRC = '/assets/fruit-fig.png';
const FRUIT_LOQUAT_ICON_SRC = '/assets/fruit-loquat.png';
const FRUIT_BLACKBERRY_ICON_SRC = '/assets/fruit-blackberry.png';

function buildTarantulaGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-tarantula-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = TARANTULA_STRIP_ICON_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

function buildSalamanderGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-salamander-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = SALAMANDER_STRIP_ICON_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

function isMinersLettuceRowLabel(label) {
  const s = String(label || '').toLowerCase();
  if (s.includes('claytonia')) return true;
  if (s.includes('miner') && s.includes('lettuce')) return true;
  return false;
}

function buildWildEdibleImageGlyph(className, src) {
  const wrap = document.createElement('span');
  wrap.className = `hero-astro-glyph hero-astro-glyph--img earth-wild-edible-glyph ${className}`;
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

function buildWildEdibleGlyph(plantLabel) {
  const s = String(plantLabel || '').toLowerCase();
  if (isMinersLettuceRowLabel(plantLabel)) {
    return buildWildEdibleImageGlyph('earth-miners-lettuce-glyph', MINERS_LETTUCE_STRIP_SRC);
  }
  if (s.includes('loquat')) return buildWildEdibleImageGlyph('earth-wild-fruit-glyph', FRUIT_LOQUAT_ICON_SRC);
  if (s.includes('pear')) return buildWildEdibleImageGlyph('earth-wild-fruit-glyph', FRUIT_PEAR_ICON_SRC);
  if (s.includes('plum')) return buildWildEdibleImageGlyph('earth-wild-fruit-glyph', FRUIT_PLUM_ICON_SRC);
  if (/(peach|nectarine|stone fruit)/.test(s)) {
    return buildWildEdibleImageGlyph('earth-wild-fruit-glyph', FRUIT_PEACH_ICON_SRC);
  }
  if (s.includes('fig')) return buildWildEdibleImageGlyph('earth-wild-fruit-glyph', FRUIT_FIG_ICON_SRC);
  if (s.includes('apple')) return buildWildEdibleImageGlyph('earth-wild-fruit-glyph', FRUIT_APPLE_ICON_SRC);
  if (s.includes('blackberry')) return buildWildEdibleImageGlyph('earth-wild-fruit-glyph', FRUIT_BLACKBERRY_ICON_SRC);

  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph earth-wild-edible-glyph';
  wrap.textContent = '🌿';
  wrap.setAttribute('aria-hidden', 'true');
  return wrap;
}

/**
 * @param {number} p 0..1
 * @returns {string} #rrggbb
 */
function npnSpringRingStrokeHex(p) {
  const t = Math.max(0, Math.min(1, Number(p) || 0));
  const r = Math.round(200 + (16 - 200) * t);
  const g = Math.round(238 + (90 - 238) * t);
  const b = Math.round(180 + (40 - 180) * t);
  const hx = (n) => n.toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/**
 * @param {number} progress01
 */
function buildNpnSpringGlyph(progress01) {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph earth-npn-spring-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const p = Math.max(0, Math.min(1, Number(progress01) || 0));
  const stroke = npnSpringRingStrokeHex(p);
  const c = 22;
  const r = 16;
  const len = 2 * Math.PI * r;
  const dash = len * p;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 44 44');
  svg.setAttribute('class', 'earth-npn-spring-svg');
  const bg = document.createElementNS(ns, 'circle');
  bg.setAttribute('cx', String(c));
  bg.setAttribute('cy', String(c));
  bg.setAttribute('r', String(r));
  bg.setAttribute('class', 'earth-npn-spring-ring earth-npn-spring-ring--bg');
  const fg = document.createElementNS(ns, 'circle');
  fg.setAttribute('cx', String(c));
  fg.setAttribute('cy', String(c));
  fg.setAttribute('r', String(r));
  fg.setAttribute('class', 'earth-npn-spring-ring earth-npn-spring-ring--fg');
  fg.setAttribute('stroke', stroke);
  fg.setAttribute('stroke-dasharray', `${dash} ${len}`);
  fg.setAttribute('transform', `rotate(-90 ${c} ${c})`);
  svg.append(bg, fg);
  wrap.appendChild(svg);
  return wrap;
}

/** GOES GLM lightning strip row (public/assets/earth-glm-lightning-strip.png). */
function buildGlmLightningGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-glm-lightning-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = GLM_LIGHTNING_STRIP_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

/** USGS weekly quake row: map pin with seismogram (raster). */
function buildQuakeWeekGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-earthquake-pin-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = EARTHQUAKE_PIN_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

/** Kīlauea volcano / Hawaiʻi summit activity row. */
function buildKilaueaGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-kilauea-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = KILAUEA_STRIP_ICON_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

/** @param {{ earthType?: string, label?: string, npnSpring?: object }} ev */
function earthItemGlyph(ev) {
  const t = String(ev?.earthType || '');
  if (t === 'usa_npn_spring') return buildNpnSpringGlyph(ev.npnSpring?.progress01 ?? 0);
  if (t === 'goes_glm_lightning_max_recent') return buildGlmLightningGlyph();
  if (t === 'goes_glm_sprite_proxy') return buildGlmLightningGlyph();
  if (t === 'usgs_quake_week_max') return buildQuakeWeekGlyph();
  if (t === 'kilauea_volcano') return buildKilaueaGlyph();
  if (t === 'diablo_tarantula_mating') return buildTarantulaGlyph();
  if (t === 'oakland_salamander_surface') return buildSalamanderGlyph();
  if (t.startsWith('monarch_')) return buildMonarchGlyph();
  if (t.startsWith('salmon_run')) return buildSalmonGlyph();
  if (t.startsWith('wild_edible')) return buildWildEdibleGlyph(ev.label);
  if (t.startsWith('nasturtium_bloom')) return buildNasturtiumGlyph();
  if (t === 'firefly_season') return buildFireflyGlyph();
  if (t === 'fall_foliage_season') return buildFallFoliageGlyph();
  if (t === 'atlantic_cyclone_land_impact') return buildAtlanticStormGlyph();
  return buildMonarchGlyph();
}

function buildFireflyGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-firefly-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = FIREFLY_STRIP_ICON_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

function buildFallFoliageGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-foliage-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = FALL_FOLIAGE_STRIP_ICON_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

function buildAtlanticStormGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-atlantic-storm-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = HURRICANE_ICON_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

function buildNasturtiumGlyph() {
  const wrap = document.createElement('span');
  wrap.className = 'hero-astro-glyph hero-astro-glyph--img earth-nasturtium-glyph';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = NASTURTIUM_STRIP_ICON_SRC;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  wrap.appendChild(img);
  return wrap;
}

function earthItemTooltip(earthType, ev) {
  const t = String(earthType || '');
  if (t.startsWith('monarch_')) {
    if (t.endsWith('_inactive')) {
      return 'Below strip threshold (debug). Static latitude × date lookup.';
    }
    return 'Monarch migration by latitude and date (static lookup).';
  }
  if (t.startsWith('salmon_run')) {
    if (t === 'salmon_run_offseason') {
      return 'Salmon run out of calendar month (debug: EARTH_DEBUG_SHOW_INACTIVE); verify regulations; opens reference (new tab)';
    }
    return 'Seasonal salmon/steelhead run windows from static regional calendars (ZIP + month + distance); verify regulations before fishing; opens reference (new tab)';
  }
  if (t.startsWith('wild_edible')) {
    if (t === 'wild_edible_offseason') {
      return 'Wild plant out of typical month window (debug: EARTH_DEBUG_SHOW_INACTIVE); verify ID, access, regs; opens reference (new tab)';
    }
    return 'Wild food notes: static regional ripeness windows and optional nearby map points; verify ID, land access, and regulations; opens reference (new tab)';
  }
  if (t === 'usa_npn_spring') {
    return 'USA-NPN Extended Spring Index (SI-x, NCEP): 14-day window from average first-leaf timing; anomaly vs 1981–2010 baseline; opens Status of Spring (new tab)';
  }
  if (t === 'diablo_tarantula_mating') {
    return 'Mount Diablo area tarantula mating season: static Sep–Oct window + distance from Diablo in public/data; opens park reference (new tab)';
  }
  if (t === 'oakland_salamander_surface') {
    return 'Oakland salamanders: Open-Meteo rain sum + air temp at dashboard point, Nov 1–Apr 1 + distance from downtown Oakland; AmphibiaWeb reference (new tab)';
  }
  if (t === 'usgs_quake_week_max') {
    const when =
      typeof ev?.quakeEventAt === 'string' && ev.quakeEventAt.trim()
        ? ev.quakeEventAt.trim()
        : typeof ev?.quakeAsOfMd === 'string' && /^[0-9]{1,2}\/[0-9]{1,2}$/.test(ev.quakeAsOfMd.trim())
          ? ev.quakeAsOfMd.trim()
          : formatLocalQuakeMd();
    return `Strongest California earthquake at ${when} (USGS): M>3 within 150 mi of Oakland, CA; shown for 24 hours after occurrence; opens USGS event (new tab)`;
  }
  if (t === 'kilauea_volcano') {
    return 'Kīlauea (Hawaiʻi): shown when fountaining or HVO posts a dated next-episode forecast; opens USGS volcano update (new tab)';
  }
  if (t === 'goes_glm_lightning_max_recent') {
    return 'Strongest recent GOES Geostationary Lightning Mapper flash (AWS open-data L2 CFA) within ~200 mi of dashboard lat/lon; thumbnail opens STAR GLM mosaic (new tab)';
  }
  if (t === 'goes_glm_sprite_proxy') {
    return 'Sprite-class row: GLM radiant energy + footprint tier (not measured +CG or kA — tune EARTH_SPRITE_*); retained 7 days in data/glm-sprite-events.json; STAR GLM mosaic (new tab)';
  }
  if (t.startsWith('nasturtium_bloom')) {
    if (t.endsWith('_inactive')) {
      return 'Nasturtium bloom below strip threshold (debug: EARTH_DEBUG_SHOW_INACTIVE); Apr–Jun window + Open-Meteo daily max vs 85°F (29°C) cutoff; RHS growing guide (new tab)';
    }
    return 'Nasturtium (Tropaeolum): late spring–early summer bloom at dashboard point until Open-Meteo daily high ≥85°F; RHS growing guide (new tab)';
  }
  if (t === 'firefly_season') {
    return "Lightning-bug season at secondary ZIP: strip from 7 days before start through season end; before start shows start + peak dates, after start shows peak + until end; Farmers' Almanac reference (new tab)";
  }
  if (t === 'fall_foliage_season') {
    return 'Fall leaf-color season at ZIP 24066: USA-NPN MODIS LSP Mid Greendown median; active 21 days before start, peak, or end; opens Status of Autumn (new tab)';
  }
  if (t === 'atlantic_cyclone_land_impact') {
    return 'Atlantic Category 1+ cyclone row shown when NHC advisory indicates projected land impact; detail names forecasted landfall location when parsed from advisory text.';
  }
  return '';
}

function parseEarthPayload(j) {
  if (!j?.ok || !Array.isArray(j.items)) return [];
  return j.items;
}

/**
 * Fetch JSON for Earth strip sources. Never throws: bad/empty bodies and network errors yield `null`
 * so one endpoint cannot reject the whole batch and hide the Earth card.
 *
 * @param {string} path
 * @returns {Promise<object | null>}
 */
async function fetchEarthJson(path) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) return null;
    const txt = await r.text();
    const trimmed = txt.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * @param {Array<object | null>} payloads
 * @returns {{ merged: object[], quakeItems: object[] }}
 */
function mergeFastEarthPayloads([
  npnSpringJson,
  tarantulaJson,
  salamanderJson,
  monarchJson,
  salmonJson,
  foragingJson,
  nasturtiumJson,
  secondaryWatchJson,
  quakeJson,
  atlanticStormJson,
  kilaueaJson,
]) {
  const npnSpringItems = parseEarthPayload(npnSpringJson);
  const tarantulaItems = parseEarthPayload(tarantulaJson);
  const salamanderItems = parseEarthPayload(salamanderJson);
  const monarchItems = parseEarthPayload(monarchJson);
  const salmonItems = parseEarthPayload(salmonJson);
  const foragingItems = parseEarthPayload(foragingJson);
  const nasturtiumItems = parseEarthPayload(nasturtiumJson);
  const secondaryItems = parseEarthPayload(secondaryWatchJson);
  const quakeItems = parseEarthPayload(quakeJson);
  const atlanticStormItems = parseEarthPayload(atlanticStormJson);
  const kilaueaItems = parseEarthPayload(kilaueaJson);
  const merged = npnSpringItems.concat(
    tarantulaItems,
    salamanderItems,
    monarchItems,
    salmonItems,
    foragingItems,
    nasturtiumItems,
    secondaryItems,
    quakeItems,
    atlanticStormItems,
    kilaueaItems,
  );
  return { merged, quakeItems };
}

/**
 * Drop Bay-only (or profile-hidden) Earth rows while Away/preview.
 * @param {object[]} items
 * @param {string[]} hideIds
 */
function filterHiddenEarthItems(items, hideIds) {
  if (!Array.isArray(items) || !Array.isArray(hideIds) || !hideIds.length) return items;
  const hide = new Set(hideIds.map((x) => String(x || '').trim()).filter(Boolean));
  return items.filter((ev) => {
    const t = String(ev?.earthType || '');
    for (const id of hide) {
      if (t === id || t.startsWith(`${id}_`)) return false;
    }
    return true;
  });
}

/** @param {HTMLElement} container @param {object[]} items */
function appendEarthEventRows(container, items) {
  for (let i = 0; i < items.length; i++) {
    const ev = items[i];
    try {
      const glyph = earthItemGlyph(ev);
      const title = (ev.label || '').trim() || 'Earth event';
      const line =
        typeof ev.detailLine === 'string' && ev.detailLine.trim() !== '' ? ev.detailLine.trim() : '';
      const linkHref =
        typeof ev.forecastUrl === 'string' && /^https?:\/\//i.test(ev.forecastUrl.trim())
          ? ev.forecastUrl.trim()
          : '';
      const item = buildAstroItem(glyph, title, line || null, linkHref);
      const tip = earthItemTooltip(ev.earthType, ev);
      if (tip) item.title = tip;
      container.appendChild(item);
    } catch {
      // Skip malformed rows so one bad payload does not blank the whole Earth section.
    }
  }
}

/** M/D in the browser's local calendar (fallback if API omits `quakeAsOfMd`). */
function formatLocalQuakeMd(d = new Date()) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Earth strip: USA-NPN spring, tarantulas, salamanders, monarchs, salmon, foraging, then (when active) largest nearby quake (USGS, date/time, 24h after occurrence), strongest recent GLM flash (~200 mi), optional Sprite-class proxy row (7-day retention).
 * Uses the same row chrome as sky events (`hero-astro-item`).
 *
 * @param {HTMLElement | null} container
 * @param {{ hideEarth?: string[] }} [opts]
 */
export function mountEarthStrip(container, opts = {}) {
  if (!container) return;
  const hideEarth = Array.isArray(opts.hideEarth) ? opts.hideEarth : [];
  const card = document.getElementById('earth-sidebar-card');
  container.className = 'hero-astro-middle';

  function setEarthAriaLabel(quakeAsOfMd) {
    const md = typeof quakeAsOfMd === 'string' && quakeAsOfMd ? quakeAsOfMd : formatLocalQuakeMd();
    container.setAttribute(
      'aria-label',
      `Earth events: USA-NPN spring when active, Diablo-area tarantulas, Oakland salamander heuristic, monarch migration, salmon seasons, wild edible / foraging notes, nasturtium bloom, lightning bugs at secondary ZIP (7-day heads-up before start), fall foliage at ZIP 24066, Atlantic Category 1+ storms with forecasted landfall location when parsed from NHC advisories, California earthquake${md ? ` (${md})` : ''} when strongest is M>3 within 150 mi of Oakland (24 hours after occurrence), Kīlauea eruption when active, GOES GLM strongest flash and optional Sprite-class proxy row when a tier match is stored (~200 mi, 7-day retention)`,
    );
  }

  function setEarthCardVisible(show) {
    if (card) card.hidden = !show;
  }

  // Fast earth endpoints first; GLM (S3 + NetCDF, often several seconds) waits until
  // the Earth card is near the viewport so it does not contend with the initial fan-out.
  let glmStarted = false;
  let fastRowCount = 0;
  let glmRowCount = 0;
  let fastDone = false;
  let glmDone = false;
  /** @type {object[] | null} */
  let pendingGlmItems = null;

  function syncEarthVisibility() {
    if (!fastDone) {
      if (glmDone && glmRowCount > 0) setEarthCardVisible(true);
      return;
    }
    if (!glmDone) {
      if (fastRowCount > 0) setEarthCardVisible(true);
      return;
    }
    setEarthCardVisible(fastRowCount + glmRowCount > 0);
  }

  function applyGlmItems(lightningItems) {
    glmRowCount = lightningItems.length;
    glmDone = true;
    if (lightningItems.length === 0) {
      syncEarthVisibility();
      return;
    }
    if (fastDone) {
      appendEarthEventRows(container, lightningItems);
    } else {
      pendingGlmItems = lightningItems;
    }
    syncEarthVisibility();
  }

  function startGlmFetch() {
    if (glmStarted) return;
    glmStarted = true;
    fetchEarthJson('/api/dashboard-lightning-glm').then((lightningJson) => {
      applyGlmItems(parseEarthPayload(lightningJson));
    });
  }

  function scheduleGlmWhenNear() {
    const target = card || container;
    if (!target || typeof IntersectionObserver !== 'function') {
      // Fallback: still defer past the initial paint / fast-batch fan-out.
      setTimeout(startGlmFetch, 2500);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          startGlmFetch();
        }
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(target);
    // Safety net if the card stays off-screen (e.g. hidden until first rows arrive).
    setTimeout(() => {
      io.disconnect();
      startGlmFetch();
    }, 8000);
  }

  /**
   * @param {object[]} merged
   * @param {object[]} quakeItems
   */
  function paintFastEarth(merged, quakeItems) {
    merged = filterHiddenEarthItems(merged, hideEarth);
    quakeItems = filterHiddenEarthItems(quakeItems, hideEarth);
    container.replaceChildren();
    fastRowCount = merged.length;
    fastDone = true;

    if (merged.length > 0) {
      const qEv = quakeItems.find((e) => e.earthType === 'usgs_quake_week_max');
      setEarthAriaLabel(qEv?.quakeEventAt || qEv?.quakeAsOfMd);
      appendEarthEventRows(container, merged);
    }

    if (pendingGlmItems?.length) {
      appendEarthEventRows(container, pendingGlmItems);
      pendingGlmItems = null;
    }

    syncEarthVisibility();
  }

  const cachedEarth = readPanelCache(EARTH_CACHE_KEY, EARTH_CACHE_MAX_MS);
  if (cachedEarth && typeof cachedEarth === 'object' && Array.isArray(cachedEarth.merged)) {
    paintFastEarth(cachedEarth.merged, Array.isArray(cachedEarth.quakeItems) ? cachedEarth.quakeItems : []);
    scheduleGlmWhenNear();
  }

  Promise.all([
    fetchEarthJson('/api/usa-npn-spring'),
    fetchEarthJson('/api/diablo-tarantula'),
    fetchEarthJson('/api/oakland-salamanders'),
    fetchEarthJson('/api/earth-events'),
    fetchEarthJson('/api/salmon-runs'),
    fetchEarthJson('/api/wild-foraging'),
    fetchEarthJson('/api/nasturtium-bloom'),
    fetchEarthJson('/api/secondary-watch'),
    fetchEarthJson('/api/dashboard-earthquake-week'),
    fetchEarthJson('/api/atlantic-storm-watch'),
    fetchEarthJson('/api/dashboard-kilauea'),
  ])
    .then((payloads) => {
      const { merged, quakeItems } = mergeFastEarthPayloads(payloads);
      writePanelCache(EARTH_CACHE_KEY, { merged, quakeItems });
      paintFastEarth(merged, quakeItems);
      scheduleGlmWhenNear();
    })
    .catch(() => {
      if (!fastDone) {
        container.replaceChildren();
        fastDone = true;
        fastRowCount = 0;
        syncEarthVisibility();
      }
      scheduleGlmWhenNear();
    });
}
