/**
 * Human-readable inventory of dashboard data feeds (not host hardware probes).
 * Served at GET /api/monitoring-sources and bundled into /api/dashboard-settings.
 *
 * @typedef {{ id: string, label: string, source: string, group: string }} MonitoringSourceRow
 */

/** @type {MonitoringSourceRow[]} */
export const DASHBOARD_MONITORING_SOURCES = [
  {
    id: 'location',
    group: 'Location',
    label: 'Primary map point (top bar, Earth, sky, NWS)',
    source: 'WEATHER_ZIP → US ZIP geocode, else WEATHER_LAT / WEATHER_LON; WEATHER_TIME_ZONE or NWS points timeZone',
  },
  {
    id: 'hero_weather',
    group: 'Hero & weather',
    label: 'Hero weather tiles (live/primary + Secondary ZIP)',
    source:
      '/api/hero-weather — Open-Meteo forecast (cached) with NWS station observations fallback',
  },
  {
    id: 'hero_aqi',
    group: 'Hero & weather',
    label: 'US air quality on weather tiles',
    source: 'Open-Meteo air quality API',
  },
  {
    id: 'hero_precip',
    group: 'Hero & weather',
    label: 'Rain expected in N minutes (hero)',
    source:
      'Open-Meteo minutely_15 at live GPS when available, else dashboard WEATHER_ZIP; 2h horizon',
  },
  {
    id: 'market_fear_greed',
    group: 'Earth',
    label: 'Market Watch — CNN F & G Index',
    source: 'CNN Business production.dataviz.cnn.io F & G Index JSON',
  },
  {
    id: 'firefly_season',
    group: 'Earth',
    label: 'Lightning bugs (secondary ZIP)',
    source:
      "Farmers' Almanac + Virginia Tech · src/data/firefly-season-us.json; Earth strip 7d before start",
  },
  {
    id: 'fall_foliage_season',
    group: 'Earth',
    label: 'Fall foliage (ZIP 24066)',
    source: 'USA-NPN MODIS LSP Mid Greendown median WCS; 21-day heads-up',
  },
  {
    id: 'hero_sunset',
    group: 'Hero & weather',
    label: 'Hero sunset time',
    source: 'NWS api.weather.gov points → properties.astronomicalData.sunset',
  },
  {
    id: 'hero_moon',
    group: 'Hero & weather',
    label: 'Hero moonrise, phase glyph, next full/new moon caption',
    source: 'astronomy-engine (rise/set + lunar quarters); moon phase strip assets in public/assets/sky/moon/',
  },
  {
    id: 'sky_calendar',
    group: 'Sky & space',
    label: 'Sky strip — calendar events (meteors, launches, eclipses, etc.)',
    source: 'src/data/sky-events-calendar.json (edited locally)',
  },
  {
    id: 'sky_geomagnetic',
    group: 'Sky & space',
    label: 'Sky strip — geomagnetic storm (G-scale)',
    source:
      'NOAA SWPC noaa-scales.json + peak planetary K (noaa-planetary-k-index-forecast.json; 1m estimated fallback)',
  },
  {
    id: 'sky_aurora',
    group: 'Sky & space',
    label: 'Sky strip — aurora likelihood',
    source: 'NOAA SWPC ovation_aurora_latest.json + planetary K index at dashboard lat/lon',
  },
  {
    id: 'sky_planets',
    group: 'Sky & space',
    label: 'Sky strip — naked-eye planets',
    source: 'Computed at dashboard coordinates (astronomy-engine; civil night + altitude checks)',
  },
  {
    id: 'sky_aircraft',
    group: 'Sky & space',
    label: 'Sky strip — aircraft nearby (ADS-B)',
    source:
      'adsb.fi opendata lat/lon/dist · rain-alert address geocode · oakland-aircraft-registry.json · aircraft-tail-cache.json (adsbdb/hexdb when unknown)',
  },
  {
    id: 'sky_moonbow',
    group: 'Sky & space',
    label: 'Sky strip — Yosemite moonbow window',
    source: 'public/data/yosemite-moonbow-windows.json',
  },
  {
    id: 'earth_npn',
    group: 'Earth',
    label: 'USA-NPN Extended Spring Index',
    source: 'USA-NPN GeoServer WCS (SI-x first leaf + anomaly vs 1981–2010 baseline)',
  },
  {
    id: 'earth_monarch',
    group: 'Earth',
    label: 'Monarch migration (spring + fall)',
    source: 'src/data/monarch-spring-migration-peaks.json + monarch-fall-migration-peaks.json',
  },
  {
    id: 'earth_tarantula',
    group: 'Earth',
    label: 'Diablo-area tarantula mating season',
    source: 'Static Sep–Oct window + distance from Mount Diablo (public/data)',
  },
  {
    id: 'earth_salamander',
    group: 'Earth',
    label: 'Oakland salamander surface activity',
    source: 'Open-Meteo rain + air temperature; Nov 1–Apr 1 window + radius from downtown Oakland',
  },
  {
    id: 'earth_salmon',
    group: 'Earth',
    label: 'Salmon / steelhead run windows near you',
    source: 'src/data/salmon-run-sites.json + ZIP radius',
  },
  {
    id: 'earth_foraging',
    group: 'Earth',
    label: 'Wild edible / foraging notes',
    source: 'src/data/native-edible-plants.json; optional Falling Fruit API when FALLING_FRUIT_API_KEY is set',
  },
  {
    id: 'earth_nasturtium',
    group: 'Earth',
    label: 'Nasturtium seasonal bloom',
    source:
      'Open-Meteo daily max temperature at dashboard point; Apr–Jun window; strip until high ≥85°F (29°C)',
  },
  {
    id: 'earth_quake',
    group: 'Earth',
    label: 'Largest nearby earthquake (24h)',
    source:
      'USGS earthquake feed — strongest California M>3 within 150 mi of Oakland; shown 24 hours after occurrence with date/time',
  },
  {
    id: 'earth_kilauea',
    group: 'Earth',
    label: 'Kīlauea volcano (Hawaiʻi) + summit livestream',
    source:
      'USGS HANS alerts + HVO volcano messages · V1/V2/V3 YouTube cams via url.usgs.gov',
  },
  {
    id: 'earth_glm',
    group: 'Earth',
    label: 'Strongest recent lightning flash (~200 mi)',
    source: 'GOES Geostationary Lightning Mapper L2 CFA on AWS open data',
  },
  {
    id: 'earth_sprite',
    group: 'Earth',
    label: 'Sprite-class GLM proxy row (when tier matches)',
    source: 'Local retention file data/glm-sprite-events.json (7-day store; energy + footprint tiers)',
  },
  {
    id: 'calendar_upcoming',
    group: 'Calendar & notes',
    label: 'Next calendar event (hero row)',
    source: 'Google Calendar iCal feed (GOOGLE_CALENDAR_ICAL_URL or public embed calendar)',
  },
  {
    id: 'calendar_embed',
    group: 'Calendar & notes',
    label: 'Calendar panel embed',
    source: 'Google Calendar embed URL (CALENDAR_EMBED_URL)',
  },
  {
    id: 'notes',
    group: 'Calendar & notes',
    label: 'Notes panel',
    source: 'public/data/notes.md (local file)',
  },
  {
    id: 'local_news_bd_anthropic',
    group: 'News',
    label: 'Local News — Anthropic News (BD)',
    source:
      'anthropic.com/news HTML list (fetchMode anthropic-news-html) · docs/anthropic-bd-news-monitoring.md',
  },
  {
    id: 'local_news_bd_google',
    group: 'News',
    label: 'Local News — Anthropic BD Google News RSS',
    source:
      'Google News RSS query (Beneficial Deployments / Claude Corps / Nonprofits / Teachers / Gates×Anthropic)',
  },
  {
    id: 'job_watch_anthropic',
    group: 'Jobs',
    label: 'Opportunity Watch — Anthropic / Google / OpenAI roles',
    source:
      'Greenhouse + Ashby + Google Careers scrape every 2h · /api/job-watch · docs/job-watch.md',
  },
  {
    id: 'local_news_bd_watchlist',
    group: 'News',
    label: 'Local News — BD LinkedIn / partner watchlist (manual)',
    source: 'src/data/local-news-bd-watchlist.json — no login scrape',
  },
];

/**
 * @returns {{ ok: true, items: MonitoringSourceRow[], groups: string[] }}
 */
export function getMonitoringSourcesPayload() {
  const groups = [];
  for (const row of DASHBOARD_MONITORING_SOURCES) {
    if (!groups.includes(row.group)) groups.push(row.group);
  }
  return { ok: true, items: DASHBOARD_MONITORING_SOURCES, groups };
}
