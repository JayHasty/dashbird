/**
 * Earth strip + Yosemite moonbow rows for Settings → Event types (always show value).
 */
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';
import { calendarMonthInZone } from './dashboard-geo.js';
import { lookupMonarchAllPhenology } from './monarch-earth.js';
import { evaluateNasturtiumBloom } from './nasturtium-bloom.js';
import { nativeEdiblePlantEventsNear } from './native-edible-plants-near.js';
import { salmonRunEventsNear } from './salmon-runs-near.js';
import { buildUsaNpnSpringEarthItems } from './usanpn-spring-context.js';
import { buildUsgsEarthquakeWeekItem } from './usgs-earthquake-week.js';
import { buildKilaueaDashboardPayload } from './kilauea-status.js';
import { buildGoesGlmLightningStripItem } from './goes-glm-lightning-strip.js';
import {
  loadDiabloTarantulaSeasonConfig,
  isDashboardInDiabloTarantulaRegion,
  isWallYmdInTarantulaRecurrence,
} from './diablo-tarantula-season.js';
import {
  fetchOpenMeteoSalamanderContext,
  isNearOaklandSalamanderAnchor,
  isOaklandSalamanderCalendarWindow,
  latestHourlyTempF,
  sumRecentHourlyPrecipInches,
} from './oakland-salamanders.js';
import {
  loadYosemiteMoonbowConfig,
  describeMoonbowForStatus,
  wallYmdInTimeZone,
} from './yosemite-moonbow.js';
import { buildSecondaryWatchEarthBundle, FALL_FOLIAGE_ZIP } from './secondary-watch-earth.js';
import { getEventTypeLiveUrl } from './event-types-manifest.js';

/**
 * @typedef {{ id: string, label: string, category: string, active: boolean, value: string, dataSource: string, liveUrl?: string | null }} EventTypeRow
 */

/**
 * @param {Partial<EventTypeRow>} row
 * @returns {EventTypeRow}
 */
function withLiveUrl(row) {
  return {
    ...row,
    liveUrl: getEventTypeLiveUrl(row.id),
  };
}

/**
 * @param {object} summary
 * @param {string} directionLabel
 */
function monarchValue(summary, directionLabel) {
  const pl = Number(summary.peakLikelihood) || 0;
  const cl = Number(summary.clusteringLikelihood) || 0;
  if (summary.status === 'peak_presence') {
    const until = summary.peakEndLabel ? `Until ${summary.peakEndLabel}` : 'Peak presence likely';
    return `${directionLabel}: ${until} · peak ${pl}%`;
  }
  if (summary.status === 'clustering') {
    return `${directionLabel}: Clustering likely · cluster ${cl}% · ${summary.peakWindowLabel || 'window'}`;
  }
  const mid = summary.midLabel ? `midpoint ~${summary.midLabel}` : '';
  const win = summary.peakWindowLabel ? `typical ${summary.peakWindowLabel}` : '';
  return `${directionLabel}: Below strip threshold (peak ${pl}%, cluster ${cl}%)${mid ? ` · ${mid}` : ''}${win ? ` · ${win}` : ''}`;
}

function itemValue(items, inactiveFallback) {
  if (!Array.isArray(items) || items.length === 0) return inactiveFallback;
  return items
    .map((it) => {
      const label = typeof it.label === 'string' ? it.label.trim() : '';
      const detail = typeof it.detailLine === 'string' ? it.detailLine.trim() : '';
      if (label && detail) return `${label} — ${detail}`;
      return label || detail || '';
    })
    .filter(Boolean)
    .join('; ');
}

/**
 * @param {{ includeSlow?: boolean }} [options]
 * @returns {Promise<EventTypeRow[]>}
 */
export async function buildEarthAndMoonbowEventTypes(options = {}) {
  const includeSlow = options.includeSlow !== false;
  const { lat, lon } = await resolveDashboardWeatherLatLon();
  const timeZone = (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
  const now = new Date();
  const wallYmd = wallYmdInTimeZone(now, timeZone);
  const month = calendarMonthInZone(now, timeZone);

  const rawEdibleRad = process.env.EDIBLE_NATIVE_PLANT_RADIUS_MI;
  const edibleRadiusMiles =
    rawEdibleRad != null && String(rawEdibleRad).trim() !== ''
      ? Math.min(200, Math.max(10, Number.parseFloat(String(rawEdibleRad))))
      : 75;

  const rawSalmonRad = process.env.SALMON_RUN_RADIUS_MI;
  const salmonRadiusMiles =
    rawSalmonRad != null && String(rawSalmonRad).trim() !== ''
      ? Math.min(200, Math.max(5, Number.parseFloat(String(rawSalmonRad))))
      : 50;

  const coreResults = await Promise.all([
    loadYosemiteMoonbowConfig(),
    buildUsaNpnSpringEarthItems({ lat, lon, timeZone, now }),
    Promise.resolve(lookupMonarchAllPhenology({ lat, lon, date: now, timeZone })),
    evaluateNasturtiumBloom({ lat, lon, timeZone, now, includeInactive: true }),
    loadDiabloTarantulaSeasonConfig(),
    (async () => {
      if (String(process.env.EARTH_OAKLAND_SALAMANDERS || '').trim() === '0') {
        return { disabled: true };
      }
      if (!isOaklandSalamanderCalendarWindow(wallYmd)) {
        return { offCalendar: true, wallYmd };
      }
      const rawRad = process.env.SALAMANDER_OAKLAND_RADIUS_MI;
      const radiusMiles =
        rawRad != null && String(rawRad).trim() !== ''
          ? Math.min(40, Math.max(5, Number.parseFloat(String(rawRad))))
          : 18;
      if (!isNearOaklandSalamanderAnchor(lat, lon, radiusMiles)) {
        return { offRegion: true, radiusMiles };
      }
      return fetchOpenMeteoSalamanderContext(lat, lon);
    })(),
    Promise.resolve(
      Number.isFinite(month) && month >= 1 && month <= 12
        ? nativeEdiblePlantEventsNear({ lat, lon, month, radiusMiles: edibleRadiusMiles }, { includeInactive: true })
        : [],
    ),
    Promise.resolve(
      Number.isFinite(month) && month >= 1 && month <= 12
        ? salmonRunEventsNear({ lat, lon, month, radiusMiles: salmonRadiusMiles }, { includeInactive: true })
        : [],
    ),
    buildSecondaryWatchEarthBundle({
      now,
      baseUrl: (process.env.USANPN_GEOSERVER_BASE || '').trim() || undefined,
    }),
  ]);

  const [
    moonbowCfg,
    npnBuilt,
    monarch,
    nasturtium,
    tarantulaCfg,
    salamanderWx,
    edibleEvents,
    salmonEvents,
    secondaryWatch,
  ] = coreResults;

  /** @type {EventTypeRow[]} */
  const rows = [];

  if (String(process.env.EARTH_YOSEMITE_MOONBOW || '').trim() === '0') {
    rows.push({
      id: 'yosemite_moonbow',
      label: 'Yosemite moonbow',
      category: 'Sky & space',
      active: false,
      value: 'Disabled (EARTH_YOSEMITE_MOONBOW=0)',
      dataSource: 'public/data/yosemite-moonbow-windows.json',
    });
  } else if (!moonbowCfg?.windows?.length) {
    rows.push({
      id: 'yosemite_moonbow',
      label: 'Yosemite moonbow',
      category: 'Sky & space',
      active: false,
      value: 'No windows configured',
      dataSource: 'public/data/yosemite-moonbow-windows.json',
    });
  } else {
    const mb = describeMoonbowForStatus(wallYmd, moonbowCfg.windows);
    rows.push({
      id: 'yosemite_moonbow',
      label: 'Yosemite moonbow',
      category: 'Sky & space',
      active: mb.active,
      value: mb.value,
      dataSource:
        'public/data/yosemite-moonbow-windows.json · hero sky strip (14-day lead through window end)',
    });
  }

  if (String(process.env.EARTH_USA_NPN_SPRING || '').trim() === '0') {
    rows.push({
      id: 'usa_npn_spring',
      label: 'Spring (first leaf)',
      category: 'Earth',
      active: false,
      value: 'Disabled (EARTH_USA_NPN_SPRING=0)',
      dataSource: 'USA-NPN GeoServer WCS (SI-x)',
    });
  } else if (npnBuilt.ok && npnBuilt.items.length) {
    rows.push({
      id: 'usa_npn_spring',
      label: 'Spring (first leaf)',
      category: 'Earth',
      active: true,
      value: itemValue(npnBuilt.items, 'Active'),
      dataSource: 'USA-NPN Extended Spring Index (SI-x) · 14-day window after modeled first leaf',
    });
  } else {
    rows.push({
      id: 'usa_npn_spring',
      label: 'Spring (first leaf)',
      category: 'Earth',
      active: false,
      value: 'Outside 14-day SI-x display window or outside CONUS coverage',
      dataSource: 'USA-NPN GeoServer WCS (SI-x)',
    });
  }

  const springActive =
    monarch.spring.status === 'clustering' || monarch.spring.status === 'peak_presence';
  const fallActive = monarch.fall.status === 'clustering' || monarch.fall.status === 'peak_presence';

  rows.push({
    id: 'monarch_spring',
    label: 'Monarchs (northbound)',
    category: 'Earth',
    active: springActive,
    value: monarchValue(monarch.spring, 'Spring'),
    dataSource: 'monarch-spring-migration-peaks.json · latitude × date',
  });
  rows.push({
    id: 'monarch_fall',
    label: 'Monarchs (southbound)',
    category: 'Earth',
    active: fallActive,
    value: monarchValue(monarch.fall, 'Fall'),
    dataSource: 'monarch-fall-migration-peaks.json · latitude × date',
  });

  if (String(process.env.EARTH_DIABLO_TARANTULA || '').trim() === '0') {
    rows.push({
      id: 'diablo_tarantula',
      label: 'Diablo tarantulas',
      category: 'Earth',
      active: false,
      value: 'Disabled (EARTH_DIABLO_TARANTULA=0)',
      dataSource: 'public/data/diablo-tarantula-season.json',
    });
  } else if (!tarantulaCfg?.recurrence) {
    rows.push({
      id: 'diablo_tarantula',
      label: 'Diablo tarantulas',
      category: 'Earth',
      active: false,
      value: 'Season config missing',
      dataSource: 'public/data/diablo-tarantula-season.json',
    });
  } else {
    const rawRad = process.env.TARANTULA_DIABLO_RADIUS_MI;
    const def = Number(tarantulaCfg.radiusMilesDefault) || 60;
    const radiusMiles =
      rawRad != null && String(rawRad).trim() !== ''
        ? Math.min(120, Math.max(15, Number.parseFloat(String(rawRad))))
        : Math.min(120, Math.max(15, def));
    const inSeason = isWallYmdInTarantulaRecurrence(wallYmd, tarantulaCfg.recurrence);
    const inRegion = isDashboardInDiabloTarantulaRegion({ lat, lon, cfg: tarantulaCfg, radiusMiles });
    const active = inSeason && inRegion;
    const rec = tarantulaCfg.recurrence;
    let value = `Sep ${rec.startDay}–Oct ${rec.endDay} mating window`;
    if (!inSeason) value = `Off season (${value})`;
    else if (!inRegion) value = `Outside ${radiusMiles} mi of Mount Diablo area`;
    else value = `Active · ${value} · within ${radiusMiles} mi`;
    rows.push({
      id: 'diablo_tarantula',
      label: 'Diablo tarantulas',
      category: 'Earth',
      active,
      value,
      dataSource: 'Static Sep–Oct calendar + distance from Mount Diablo',
    });
  }

  if (String(process.env.EARTH_OAKLAND_SALAMANDERS || '').trim() === '0') {
    rows.push({
      id: 'oakland_salamander',
      label: 'Oakland salamanders',
      category: 'Earth',
      active: false,
      value: 'Disabled (EARTH_OAKLAND_SALAMANDERS=0)',
      dataSource: 'Open-Meteo + Nov 1–Apr 1 window + Oakland radius',
    });
  } else if (salamanderWx?.disabled) {
    rows.push({
      id: 'oakland_salamander',
      label: 'Oakland salamanders',
      category: 'Earth',
      active: false,
      value: 'Disabled',
      dataSource: 'Open-Meteo + Nov 1–Apr 1 window + Oakland radius',
    });
  } else if (salamanderWx?.offCalendar) {
    rows.push({
      id: 'oakland_salamander',
      label: 'Oakland salamanders',
      category: 'Earth',
      active: false,
      value: `Outside Nov 1–Apr 1 wet-season gate (${wallYmd})`,
      dataSource: 'Open-Meteo rain + air temp; Nov 1–Apr 1; ~18 mi from downtown Oakland',
    });
  } else if (salamanderWx?.offRegion) {
    rows.push({
      id: 'oakland_salamander',
      label: 'Oakland salamanders',
      category: 'Earth',
      active: false,
      value: `Dashboard point outside Oakland salamander radius (${salamanderWx.radiusMiles} mi)`,
      dataSource: 'Open-Meteo rain + air temp; Nov 1–Apr 1; ~18 mi from downtown Oakland',
    });
  } else if (salamanderWx?.ok === false) {
    rows.push({
      id: 'oakland_salamander',
      label: 'Oakland salamanders',
      category: 'Earth',
      active: false,
      value: `Weather unavailable (${salamanderWx.error || 'fetch failed'})`,
      dataSource: 'Open-Meteo rain + air temp; Nov 1–Apr 1; ~18 mi from downtown Oakland',
    });
  } else if (salamanderWx?.ok) {
    const rainHours = 72;
    const rain = sumRecentHourlyPrecipInches(salamanderWx.data, rainHours);
    const tempF = latestHourlyTempF(salamanderWx.data);
    const sumIn = rain?.sumInches ?? null;
    const minRainIn = 0.28;
    const minAirTempF = 52;
    const wetEnough = rain != null && Number.isFinite(sumIn) && sumIn >= minRainIn;
    const warmEnough = tempF != null && Number.isFinite(tempF) && tempF >= minAirTempF;
    const active = wetEnough && warmEnough;
    rows.push({
      id: 'oakland_salamander',
      label: 'Oakland salamanders',
      category: 'Earth',
      active,
      value: active
        ? `${Math.round((sumIn ?? 0) * 100) / 100}" rain / ${rainHours}h · ${Math.round(tempF)}°F air`
        : `Below threshold · rain ${sumIn != null ? `${Math.round(sumIn * 100) / 100}"` : '—'} / ${rainHours}h · air ${tempF != null ? `${Math.round(tempF)}°F` : '—'}`,
      dataSource: 'Open-Meteo rain + air temp; Nov 1–Apr 1; ~18 mi from downtown Oakland',
    });
  } else {
    rows.push({
      id: 'oakland_salamander',
      label: 'Oakland salamanders',
      category: 'Earth',
      active: false,
      value: 'Could not evaluate',
      dataSource: 'Open-Meteo rain + air temp; Nov 1–Apr 1; ~18 mi from downtown Oakland',
    });
  }

  const edibleInMonth = edibleEvents.filter((e) => e.inMonth);
  rows.push({
    id: 'wild_edible',
    label: 'Wild edible / foraging',
    category: 'Earth',
    active: edibleInMonth.length > 0,
    value:
      edibleInMonth.length > 0
        ? edibleInMonth
            .slice(0, 4)
            .map((e) => `${e.plantLabel} (${e.distanceMi} mi)`)
            .join('; ')
        : edibleEvents.length
          ? `${edibleEvents.length} regional plants tracked · none in peak month ${month}`
          : `No sites within ${edibleRadiusMiles} mi`,
    dataSource: 'src/data/native-edible-plants.json (+ optional Falling Fruit API)',
  });

  const salmonInMonth = salmonEvents.filter((e) => e.inMonth);
  rows.push({
    id: 'salmon_run',
    label: 'Salmon / steelhead runs',
    category: 'Earth',
    active: salmonInMonth.length > 0,
    value:
      salmonInMonth.length > 0
        ? salmonInMonth
            .slice(0, 4)
            .map((e) => `${e.siteName} (${e.distanceMi} mi)`)
            .join('; ')
        : salmonEvents.length
          ? `${salmonEvents.length} runs in radius · none in month ${month}`
          : `No runs within ${salmonRadiusMiles} mi`,
    dataSource: 'src/data/salmon-run-sites.json + ZIP radius',
  });

  if (String(process.env.EARTH_NASTURTIUM_BLOOM || '').trim() === '0') {
    rows.push({
      id: 'nasturtium_bloom',
      label: 'Nasturtium flowers',
      category: 'Earth',
      active: false,
      value: 'Disabled (EARTH_NASTURTIUM_BLOOM=0)',
      dataSource: 'Open-Meteo daily max · Apr–Jun until ≥85°F (29°C)',
    });
  } else {
    rows.push({
      id: 'nasturtium_bloom',
      label: 'Nasturtium flowers',
      category: 'Earth',
      active: nasturtium.items.some((it) => it.earthType === 'nasturtium_bloom'),
      value: itemValue(nasturtium.items, nasturtium.status || '—'),
      dataSource: 'Open-Meteo daily max · Apr–Jun until ≥85°F (29°C)',
    });
  }

  if (secondaryWatch?.disabled) {
    rows.push({
      id: 'firefly_season',
      label: 'Lightning bugs (2nd ZIP)',
      category: 'Earth',
      active: false,
      value: 'Disabled (SECONDARY_WATCH=0)',
      dataSource: "Farmers' Almanac + Virginia Tech · src/data/firefly-season-us.json",
    });
    rows.push({
      id: 'fall_foliage_season',
      label: `Fall foliage (ZIP ${FALL_FOLIAGE_ZIP})`,
      category: 'Earth',
      active: false,
      value: 'Disabled (SECONDARY_WATCH=0)',
      dataSource: 'USA-NPN MODIS LSP Mid Greendown median',
    });
  } else if (secondaryWatch?.geocodeError) {
    rows.push({
      id: 'firefly_season',
      label: 'Lightning bugs (2nd ZIP)',
      category: 'Earth',
      active: false,
      value: 'Could not geocode secondary ZIP',
      dataSource: "Farmers' Almanac + Virginia Tech · src/data/firefly-season-us.json",
    });
    rows.push({
      id: 'fall_foliage_season',
      label: `Fall foliage (ZIP ${FALL_FOLIAGE_ZIP})`,
      category: 'Earth',
      active: false,
      value: `Could not geocode ZIP ${FALL_FOLIAGE_ZIP}`,
      dataSource: 'USA-NPN MODIS LSP Mid Greendown median',
    });
  } else {
    const ff = secondaryWatch?.firefly;
    const fol = secondaryWatch?.fallFoliage;
    const zipTag = secondaryWatch?.zip ? ` @ ${secondaryWatch.zip}` : '';
    rows.push({
      id: 'firefly_season',
      label: 'Lightning bugs (2nd ZIP)',
      category: 'Earth',
      active: Boolean(ff?.active),
      value: ff?.value || (zipTag ? `—${zipTag}` : '—'),
      dataSource:
        "Farmers' Almanac + Virginia Tech extension · strip 7d before start through season end; main page shows start+peak, then peak+until end",
    });
    rows.push({
      id: 'fall_foliage_season',
      label: `Fall foliage (ZIP ${FALL_FOLIAGE_ZIP})`,
      category: 'Earth',
      active: Boolean(fol?.active),
      value: fol?.value || `— @ ${FALL_FOLIAGE_ZIP}`,
      dataSource:
        'USA-NPN Land Surface Phenology Mid Greendown median (2001–2017); active 21d before start / peak / end',
    });
  }

  if (includeSlow) {
    rows.push(...(await buildEarthEventTypesSlow()));
  }

  return rows.map((row) => ({ ...withLiveUrl(row), pending: false }));
}

/**
 * USGS earthquake week + GOES GLM (slow network / S3).
 * @returns {Promise<EventTypeRow[]>}
 */
export async function buildEarthEventTypesSlow() {
  const { lat, lon } = await resolveDashboardWeatherLatLon();
  const [quakeBuilt, kilaueaBuilt, glmBuilt] = await Promise.all([
    buildUsgsEarthquakeWeekItem(),
    buildKilaueaDashboardPayload(),
    buildGoesGlmLightningStripItem({ lat, lon }),
  ]);

  /** @type {EventTypeRow[]} */
  const rows = [];

  if (quakeBuilt.ok && quakeBuilt.item) {
    rows.push({
      id: 'usgs_quake_week',
      label: 'Earthquake (24h)',
      category: 'Earth',
      active: true,
      value: `${quakeBuilt.item.label} — ${quakeBuilt.item.detailLine}`,
      dataSource: 'USGS FDSNWS · strongest CA M>3 within 150 mi of Oakland (24 hours after occurrence)',
    });
  } else {
    rows.push({
      id: 'usgs_quake_week',
      label: 'Earthquake (24h)',
      category: 'Earth',
      active: false,
      value: quakeBuilt.ok
        ? 'No California M>3 earthquake within 150 mi of Oakland in the past 24 hours'
        : `Unavailable (${quakeBuilt.error || 'fetch failed'})`,
      dataSource: 'USGS FDSNWS · strongest CA M>3 within 150 mi of Oakland (24 hours after occurrence)',
    });
  }

  if (kilaueaBuilt.ok && !kilaueaBuilt.disabled) {
    const volcano = Array.isArray(kilaueaBuilt.items)
      ? kilaueaBuilt.items.find((it) => it.earthType === 'kilauea_volcano')
      : null;
    const bits = [];
    if (volcano) bits.push(`${volcano.label} — ${volcano.detailLine}`);
    const volcanoActive = Boolean(volcano) || kilaueaBuilt.status?.active === true;
    rows.push({
      id: 'kilauea_volcano',
      label: 'Kīlauea (Hawaiʻi)',
      category: 'Earth',
      active: volcanoActive,
      value:
        bits.join(' · ') ||
        'Inactive — not fountaining and no dated next-episode forecast',
      dataSource:
        'USGS HANS + HVO messages · active when fountaining or dated next-episode forecast',
    });
  } else {
    rows.push({
      id: 'kilauea_volcano',
      label: 'Kīlauea (Hawaiʻi)',
      category: 'Earth',
      active: false,
      value: kilaueaBuilt.ok
        ? kilaueaBuilt.disabled
          ? 'Disabled (EARTH_KILAUEA=0)'
          : 'Inactive — not fountaining and no dated next-episode forecast'
        : `Unavailable (${kilaueaBuilt.error || 'fetch failed'})`,
      dataSource:
        'USGS HANS + HVO messages · active when fountaining or dated next-episode forecast',
    });
  }

  if (glmBuilt.ok && Array.isArray(glmBuilt.items)) {
    const main = glmBuilt.items.find((it) => it.earthType === 'goes_glm_lightning_max_recent');
    const sprite = glmBuilt.items.find((it) => it.earthType === 'goes_glm_sprite_proxy');
    rows.push({
      id: 'goes_glm_lightning',
      label: 'Lightning (GLM)',
      category: 'Earth',
      active: Boolean(main),
      value: main ? `${main.label} — ${main.detailLine}` : 'No qualifying flash within ~200 mi (rolling ~2h scan)',
      dataSource: 'GOES GLM L2 CFA on AWS open data',
    });
    rows.push({
      id: 'goes_glm_sprite',
      label: 'Sprite-class flash (GLM proxy)',
      category: 'Earth',
      active: Boolean(sprite),
      value: sprite
        ? `${sprite.label} — ${sprite.detailLine}`
        : 'No sprite-tier match in 7-day retention / recent scan',
      dataSource: 'GLM energy + footprint tiers · data/glm-sprite-events.json (7-day store)',
    });
  } else {
    const err = glmBuilt.ok === false ? glmBuilt.error : 'fetch failed';
    rows.push({
      id: 'goes_glm_lightning',
      label: 'Lightning (GLM)',
      category: 'Earth',
      active: false,
      value: `Unavailable (${err})`,
      dataSource: 'GOES GLM L2 CFA on AWS open data',
    });
    rows.push({
      id: 'goes_glm_sprite',
      label: 'Sprite-class flash (GLM proxy)',
      category: 'Earth',
      active: false,
      value: `Unavailable (${err})`,
      dataSource: 'GLM energy + footprint tiers · data/glm-sprite-events.json',
    });
  }

  return rows.map((row) => ({ ...withLiveUrl(row), pending: false }));
}
