import { loadSkyCalendar } from './sky-events.js';

/**
 * Primary live / forecast page for each event type (Settings “Live feed” column).
 * Sky rows prefer `forecastUrl` from sky-events-calendar.json when set.
 */
export const EVENT_TYPE_LIVE_URLS = {
  aurora: 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast',
  geomagnetic: 'https://www.swpc.noaa.gov/products/noaa-scales',
  lunar_eclipse: 'https://www.timeanddate.com/eclipse/',
  solar_eclipse: 'https://www.timeanddate.com/eclipse/solar.html',
  comet: 'https://in-the-sky.org/news.php',
  supermoon: 'https://science.nasa.gov/solar-system/skywatching/whats-up/',
  meteor: 'https://www.amsmeteors.org/meteor-showers/meteor-shower-calendar/',
  planet: 'https://science.nasa.gov/solar-system/skywatching/',
  iss: 'https://spotthestation.nasa.gov/',
  iridium: 'https://www.heavens-above.com/',
  starlink: 'https://www.heavens-above.com/',
  rocket: 'https://www.nasa.gov/nasalive/',
  aircraft: 'https://adsb.fi/',
  yosemite_moonbow: 'https://www.yosemitemoonbow.com/',
  usa_npn_spring: 'https://www.usanpn.org/data/maps/spring',
  monarch_spring: 'https://monarchwatch.org/migration/',
  monarch_fall: 'https://monarchwatch.org/migration/',
  diablo_tarantula: 'https://www.ebparks.org/parks/diablo',
  oakland_salamander: 'https://www.inaturalist.org/observations',
  wild_edible: 'https://fallingfruit.org/',
  salmon_run: 'https://wildlife.ca.gov/Conservation/Fishes/Salmon-Steelhead',
  nasturtium_bloom: 'https://www.rhs.org.uk/plants/nasturtium/growing-guide',
  firefly_season: 'https://www.farmersalmanac.com/fireflies-weather',
  fall_foliage_season: 'https://www.usanpn.org/data/maps/land_surface_phenology',
  usgs_quake_week: 'https://earthquake.usgs.gov/earthquakes/map/',
  kilauea_volcano: 'https://www.usgs.gov/volcanoes/kilauea/volcano-updates',
  goes_glm_lightning: 'https://www.star.nesdis.noaa.gov/GOES/thumbnail.php?v=glm',
  goes_glm_sprite: 'https://www.star.nesdis.noaa.gov/GOES/thumbnail.php?v=glm',
  fear_greed_index: 'https://www.cnn.com/markets/fear-and-greed',
  weather_radar: 'https://radar.weather.gov/',
};

/**
 * @param {string} id
 * @param {{ eventTypes?: Array<{ id?: string, forecastUrl?: string }> } | null} [calendarData]
 * @returns {string | null}
 */
export function getEventTypeLiveUrl(id, calendarData = null) {
  const types = calendarData?.eventTypes;
  if (Array.isArray(types)) {
    const hit = types.find((t) => t && t.id === id);
    const raw = hit?.forecastUrl;
    if (typeof raw === 'string' && /^https?:\/\//i.test(raw.trim())) {
      return raw.trim();
    }
  }
  const fallback = EVENT_TYPE_LIVE_URLS[id];
  return typeof fallback === 'string' && fallback.trim() !== '' ? fallback.trim() : null;
}

/** Static data-source labels for Settings (sky types filled from calendar JSON). */
export const SKY_TYPE_DATA_SOURCES = {
  aurora:
    'NOAA SWPC Ovation + planetary K at dashboard coordinates; calendar aurora rows dropped when live fetch works.',
  geomagnetic:
    'NOAA SWPC noaa-scales.json + peak planetary K (3h forecast product; 1m fallback); calendar geomagnetic rows dropped when live merge runs.',
  lunar_eclipse:
    'Curated total-eclipse rows in src/data/sky-events-calendar.json (Time and Date / NASA-style sources). Annular/partial not shown.',
  solar_eclipse:
    'Curated total-eclipse rows in src/data/sky-events-calendar.json. Annular/partial not shown.',
  comet: 'Curated rows in src/data/sky-events-calendar.json.',
  supermoon:
    'Curated rows in sky-events-calendar.json; strip only when listedSupermoon: true and LA date within ±1 day of peakAt.',
  meteor: 'Curated rows in sky-events-calendar.json (AMS / IMO peak-night windows).',
  planet:
    'Computed each request via Astronomy Engine at WEATHER_LAT/LON (Mercury–Saturn naked-eye rules).',
  iss: 'Curated rows in sky-events-calendar.json (NASA Spot the Station); 3-day heads-up + look direction; strip only when startsAt is after sunset and before sunrise at WEATHER_LAT/LON.',
  iridium: 'Curated rows in sky-events-calendar.json (Heavens-Above bright passes); 3-day heads-up + look direction from WEATHER_ZIP.',
  starlink: 'Curated rows in sky-events-calendar.json; 3-day heads-up + look direction; strip only when startsAt is after sunset and before sunrise at WEATHER_LAT/LON.',
  rocket: 'Curated rows in sky-events-calendar.json (launch schedules); 3-day heads-up + look direction; strip only when startsAt is after sunset and before sunrise at WEATHER_LAT/LON.',
  aircraft:
    'adsb.fi within AIRCRAFT_WATCH_RADIUS_MI of rain-alert address (registration + type from feed); labels from oakland-aircraft-registry.json when known. Unknown craft with a tail/hex get a one-shot adsbdb/hexdb registry lookup (cached in data/aircraft-tail-cache.json). Excludes airlines and alt <50 ft. SKY_AIRCRAFT_NEARBY=0 disables.',
};

/** Earth + moonbow rows (order preserved for Settings table). */
export const EARTH_EVENT_MANIFEST = [
  {
    id: 'yosemite_moonbow',
    label: 'Yosemite moonbow',
    category: 'Sky & space',
    dataSource:
      'public/data/yosemite-moonbow-windows.json · hero sky strip (14-day lead through window end)',
  },
  {
    id: 'usa_npn_spring',
    label: 'Spring (first leaf)',
    category: 'Earth',
    dataSource: 'USA-NPN Extended Spring Index (SI-x) · 14-day window after modeled first leaf',
  },
  {
    id: 'monarch_spring',
    label: 'Monarchs (northbound)',
    category: 'Earth',
    dataSource: 'monarch-spring-migration-peaks.json · latitude × date',
  },
  {
    id: 'monarch_fall',
    label: 'Monarchs (southbound)',
    category: 'Earth',
    dataSource: 'monarch-fall-migration-peaks.json · latitude × date',
  },
  {
    id: 'diablo_tarantula',
    label: 'Diablo tarantulas',
    category: 'Earth',
    dataSource: 'Static Sep–Oct calendar + distance from Mount Diablo',
  },
  {
    id: 'oakland_salamander',
    label: 'Oakland salamanders',
    category: 'Earth',
    dataSource: 'Open-Meteo rain + air temp; Nov 1–Apr 1; ~18 mi from downtown Oakland',
  },
  {
    id: 'wild_edible',
    label: 'Wild edible / foraging',
    category: 'Earth',
    dataSource: 'src/data/native-edible-plants.json (+ optional Falling Fruit API)',
  },
  {
    id: 'salmon_run',
    label: 'Salmon / steelhead runs',
    category: 'Earth',
    dataSource: 'src/data/salmon-run-sites.json + ZIP radius',
  },
  {
    id: 'nasturtium_bloom',
    label: 'Nasturtium flowers',
    category: 'Earth',
    dataSource: 'Open-Meteo daily max · Apr–Jun until ≥85°F (29°C)',
  },
  {
    id: 'firefly_season',
    label: 'Lightning bugs (2nd ZIP)',
    category: 'Earth',
    dataSource:
      "Farmers' Almanac + Virginia Tech · latitude table; Earth strip 7d before start through season end (start+peak, then peak+until end)",
  },
  {
    id: 'fall_foliage_season',
    label: 'Fall foliage (ZIP 24066)',
    category: 'Earth',
    dataSource:
      'USA-NPN MODIS LSP Mid Greendown median (inca WCS); active 21d before start / peak / end',
  },
  {
    id: 'usgs_quake_week',
    label: 'Earthquake (24h)',
    category: 'Earth',
    dataSource:
      'USGS FDSNWS · strongest CA M>3 within 150 mi of Oakland (24 hours after occurrence)',
  },
  {
    id: 'kilauea_volcano',
    label: 'Kīlauea (Hawaiʻi)',
    category: 'Earth',
    dataSource:
      'USGS HANS + HVO messages · active when fountaining or dated next-episode forecast',
  },
  {
    id: 'goes_glm_lightning',
    label: 'Lightning (GLM)',
    category: 'Earth',
    dataSource: 'GOES GLM L2 CFA on AWS open data',
  },
  {
    id: 'goes_glm_sprite',
    label: 'Sprite-class flash (GLM proxy)',
    category: 'Earth',
    dataSource: 'GLM energy + footprint tiers · data/glm-sprite-events.json (7-day store)',
  },
];

/** Market & weather service rows (order preserved for Settings table). */
export const SERVICE_EVENT_MANIFEST = [
  {
    id: 'fear_greed_index',
    label: 'F & G Index',
    category: 'Market & weather',
    dataSource: 'CNN Markets F & G Index (scraped)',
  },
  {
    id: 'weather_radar',
    label: 'Weather radar',
    category: 'Market & weather',
    dataSource:
      'IEM MRMS SeamlessHSR via Leaflet · device location · shown when precip is within ~20 mi (Open-Meteo)',
  },
];

/**
 * Instant row list for progressive Settings UI (no live fetches).
 */
export async function getEventTypesManifest() {
  const data = await loadSkyCalendar();
  const skyTypes = (data.eventTypes || [])
    .filter((et) => et.id !== 'rainbow')
    .map((et) => ({
      id: et.id,
      label: et.label || et.id,
      category: 'Sky & space',
      dataSource: SKY_TYPE_DATA_SOURCES[et.id] || 'sky-events-calendar.json',
      liveUrl: getEventTypeLiveUrl(et.id, data),
      active: null,
      value: null,
      pending: true,
    }));

  const earthTypes = EARTH_EVENT_MANIFEST.map((row) => ({
    ...row,
    liveUrl: getEventTypeLiveUrl(row.id, data),
    active: null,
    value: null,
    pending: true,
  }));

  const serviceTypes = SERVICE_EVENT_MANIFEST.map((row) => ({
    ...row,
    liveUrl: getEventTypeLiveUrl(row.id, data),
    active: null,
    value: null,
    pending: true,
  }));

  const types = [...skyTypes, ...earthTypes, ...serviceTypes];

  return {
    ok: true,
    groups: ['Sky & space', 'Earth', 'Market & weather'],
    types,
  };
}
