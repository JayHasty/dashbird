import 'dotenv/config';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printLanUrl } from './lib/lan-url.js';

// IMAP and other libs can emit late errors after awaits settle. Log them instead
// of letting Node's default "throw er" tear down the whole dashboard process.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection', reason?.stack || reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  const code = err?.code || '';
  const msg = String(err?.message || err || '');
  // Socket resets from IMAP should not kill the process once handlers exist;
  // keep a last-resort guard for the same class of errors.
  if (code === 'ECONNRESET' || /ECONNRESET/i.test(msg)) {
    console.error('[process] uncaughtException (non-fatal)', code || msg.slice(0, 160));
    return;
  }
  console.error('[process] uncaughtException', err?.stack || msg);
  process.exit(1);
});

import configRouter from './routes/config.js';
import vikunjaRouter from './routes/vikunja.js';
import homeAssistantRouter from './routes/homeassistant.js';
import skyEventsRouter from './routes/sky-events.js';
import hostHealthRouter from './routes/host-health.js';
import dashboardCheckRouter from './routes/dashboard-check.js';
import monitoringSourcesRouter from './routes/monitoring-sources.js';
import dashboardSettingsRouter from './routes/dashboard-settings.js';
import dashboardCostsRouter from './routes/dashboard-costs.js';
import eventTypesStatusRouter from './routes/event-types-status.js';
import eventsFinderStatusRouter from './routes/events-finder-status.js';
import eventsFinderCriteriaRouter from './routes/events-finder-criteria.js';
import eventsFinderGmailRouter from './routes/events-finder-gmail.js';
import eventsFinderSourcesRouter from './routes/events-finder-sources.js';
import openDesktopRouter from './routes/open-desktop.js';
import networkHealthRouter from './routes/network-health.js';
import heroAstronomyRouter from './routes/hero-astronomy.js';
import heroWeatherRouter from './routes/hero-weather.js';
import calendarUpcomingRouter from './routes/calendar-upcoming.js';
import earthEventsRouter from './routes/earth-events.js';
import superbloomStatusRouter from './routes/superbloom-status.js';
import salmonRunsRouter from './routes/salmon-runs.js';
import wildForagingRouter from './routes/wild-foraging.js';
import usaNpnSpringRouter from './routes/usa-npn-spring.js';
import yosemiteMoonbowRouter from './routes/yosemite-moonbow.js';
import diabloTarantulaRouter from './routes/diablo-tarantula.js';
import oaklandSalamandersRouter from './routes/oakland-salamanders.js';
import nasturtiumBloomRouter from './routes/nasturtium-bloom.js';
import dashboardEarthquakeWeekRouter from './routes/dashboard-earthquake-week.js';
import dashboardKilaueaRouter from './routes/dashboard-kilauea.js';
import dashboardLightningGlmRouter from './routes/dashboard-lightning-glm.js';
import marketWatchRouter from './routes/market-watch.js';
import rainAlertRouter from './routes/rain-alert.js';
import geolocationRouter from './routes/geolocation.js';
import airQualityRouter from './routes/air-quality.js';
import weatherRadarRouter from './routes/weather-radar.js';
import openrouterRouter from './routes/openrouter.js';
import weatherAuthorityMemosRouter from './routes/weather-authority-memos.js';
import atlanticStormWatchRouter from './routes/atlantic-storm-watch.js';
import geoelectricFieldRouter from './routes/geoelectric-field.js';
import magnetosphereRouter from './routes/magnetosphere.js';
import { startGeospaceMagnetosphereMonitor } from './lib/geospace-magnetosphere.js';
import secondaryWatchRouter from './routes/secondary-watch.js';
import aircraftNearbyRouter from './routes/aircraft-nearby.js';
import { startSuperbloomAgent } from './lib/superbloom-agent.js';
import { warmGoogleCalendarCache } from './lib/google-calendar-ical.js';
import { startCalendarPresenceIndexScheduler } from './lib/calendar-presence-index.js';
import { syncManualCalendarEventsToCatalog } from './lib/manual-calendar-events.js';
import { resolveDashboardWeatherLatLon } from './lib/hero-weather-location.js';
import toolLibraryRouter from './routes/tool-library.js';
import localNewsRouter from './routes/local-news.js';
import webCatalogRouter from './routes/web-catalog.js';
import { startWebCatalogWatchPoller } from './lib/web-catalog-watch.js';
import { startWebCatalogDiscoveryWorker } from './lib/web-catalog-discovery.js';
import eventsFinderEventsRouter, {
  startEventsFinderIngestScheduler,
} from './routes/events-finder-events.js';
import { startSkippedEventsPurgeScheduler } from './lib/events-finder-skipped.js';
import { startFacebookEventsWeeklyScheduler } from './lib/events-finder-facebook.js';
import { startTelegramEventsPoller } from './lib/events-finder-telegram.js';
import { startToolsContactsBackupScheduler, startDailyDataBackupScheduler, startBackupStalenessMonitor } from './lib/data-backup-schedule.js';
import { startLocalNewsScheduler } from './lib/local-news-scheduler.js';
import { startJobWatchScheduler } from './lib/job-watch-scheduler.js';
import jobWatchRouter from './routes/job-watch.js';
import { startBigEventsDailyRefreshScheduler } from './lib/events-finder-conference-watchlist-schedule.js';

import { startGmailWeeklySummaryScheduler } from './lib/gmail-weekly-summary-synth.js';
import eventsFinderTelegramRouter from './routes/events-finder-telegram.js';
import eventsFinderBigEventsRouter from './routes/events-finder-big-events.js';
import eventsFinderNotableRouter from './routes/events-finder-notable.js';
import gmailWeeklySummaryRouter from './routes/gmail-weekly-summary.js';
import networkRouter from './routes/network.js';
import devNotesRouter from './routes/dev-notes.js';
import devRequestsRouter from './routes/dev-requests.js';
import devicePlaceRouter from './routes/device-place.js';
import awayBaseRouter from './routes/away-base.js';
import keepNotesRouter from './routes/keep-notes.js';
import dailyScratchRouter from './routes/daily-scratch.js';
import bookmarksRouter from './routes/bookmarks.js';
import devAgentLogRouter from './routes/dev-agent-log.js';
import trustedDeviceAuthRouter, {
  deviceBindHandler,
  trustedDeviceGateMiddleware,
} from './routes/trusted-device-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const docsDir = path.join(root, 'docs');
const leafletDir = path.join(root, 'node_modules', 'leaflet', 'dist');

const app = express();
const port = Number(process.env.PORT) || 3000;
const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';

app.get('/auth/device-bind', deviceBindHandler);
app.use(trustedDeviceGateMiddleware());
app.use('/api/trusted-device', trustedDeviceAuthRouter);

app.use(
  express.static(publicDir, {
    extensions: ['html'],
    /**
     * Local/dev: always revalidate so edits show up immediately.
     * Production: short-lived cache for static assets to reduce repeat RTT on remote hosts.
     */
    setHeaders(res, filePath) {
      const p = String(filePath || '').toLowerCase();
      if (!isProd) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        return;
      }
      const isHtml = p.endsWith('.html');
      // JS/CSS change often; max-age hid Network UI edits behind a 5-minute cache
      // even after docker rebuilds when the SPA stayed open or query tags lagged.
      const isScriptOrStyle =
        p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.css') || p.endsWith('.map');
      if (isHtml || isScriptOrStyle) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        return;
      }
      // Bookmark JSON + other public/data files: short TTL for remote RTT (same UI).
      const isBookmarkJson =
        p.endsWith('/bookmarks-personal.json') ||
        p.endsWith('/bookmarks-work.json') ||
        p.endsWith('bookmarks-personal.json') ||
        p.endsWith('bookmarks-work.json');
      if (isBookmarkJson) {
        res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    },
  }),
);
app.use('/docs', express.static(docsDir));
app.use('/vendor/leaflet', express.static(leafletDir));

app.use('/api/config', configRouter);
app.use('/api/vikunja', vikunjaRouter);
app.use('/api/home-assistant', homeAssistantRouter);
app.use('/api/sky-events', skyEventsRouter);
app.use('/api/host-health', hostHealthRouter);
app.use('/api/network-health', networkHealthRouter);
app.use('/api/hero-astronomy', heroAstronomyRouter);
app.use('/api/hero-weather', heroWeatherRouter);
app.use('/api/calendar', calendarUpcomingRouter);
app.use('/api/earth-events', earthEventsRouter);
app.use('/api/superbloom-status', superbloomStatusRouter);
app.use('/api/salmon-runs', salmonRunsRouter);
app.use('/api/wild-foraging', wildForagingRouter);
app.use('/api/usa-npn-spring', usaNpnSpringRouter);
app.use('/api/yosemite-moonbow', yosemiteMoonbowRouter);
app.use('/api/diablo-tarantula', diabloTarantulaRouter);
app.use('/api/oakland-salamanders', oaklandSalamandersRouter);
app.use('/api/nasturtium-bloom', nasturtiumBloomRouter);
app.use('/api/dashboard-earthquake-week', dashboardEarthquakeWeekRouter);
app.use('/api/dashboard-kilauea', dashboardKilaueaRouter);
app.use('/api/dashboard-lightning-glm', dashboardLightningGlmRouter);
app.use('/api/market-watch', marketWatchRouter);
app.use('/api/rain-alert', rainAlertRouter);
app.use('/api/geolocation', geolocationRouter);
app.use('/api/air-quality', airQualityRouter);
app.use('/api/weather-radar', weatherRadarRouter);
app.use('/api/openrouter', openrouterRouter);
app.use('/api/weather-authority-memos', weatherAuthorityMemosRouter);
app.use('/api/atlantic-storm-watch', atlanticStormWatchRouter);
app.use('/api/geoelectric-field', geoelectricFieldRouter);
app.use('/api/magnetosphere', magnetosphereRouter);
app.use('/api/secondary-watch', secondaryWatchRouter);
app.use('/api/aircraft-nearby', aircraftNearbyRouter);
app.use('/api/dashboard-check', dashboardCheckRouter);
app.use('/api/monitoring-sources', monitoringSourcesRouter);
app.use('/api/dashboard-settings', dashboardSettingsRouter);
app.use('/api/dashboard-costs', dashboardCostsRouter);
app.use('/api/event-types-status', eventTypesStatusRouter);
app.use('/api/events-finder-status', eventsFinderStatusRouter);
app.use('/api/events-finder-criteria', eventsFinderCriteriaRouter);
app.use('/api/events-finder-gmail', eventsFinderGmailRouter);
app.use('/api/events-finder-sources', eventsFinderSourcesRouter);
app.use('/api/events-finder/events', eventsFinderEventsRouter);
app.use('/api/events-finder/telegram', eventsFinderTelegramRouter);
app.use('/api/events-finder/big-events', eventsFinderBigEventsRouter);
app.use('/api/events-finder/notable', eventsFinderNotableRouter);
app.use('/api/gmail-daily-summary', gmailWeeklySummaryRouter);
app.use('/api/gmail-weekly-summary', gmailWeeklySummaryRouter); // legacy alias
app.use('/api/network', networkRouter);
app.use('/api/open-desktop', openDesktopRouter);
app.use('/api/tool-library', toolLibraryRouter);
app.use('/api/local-news', localNewsRouter);
app.use('/api/job-watch', jobWatchRouter);
app.use('/api/web-catalog', webCatalogRouter);
app.use('/api/dev-notes', devNotesRouter);
app.use('/api/dev-requests', devRequestsRouter);
app.use('/api/device-place', devicePlaceRouter);
app.use('/api/away-base', awayBaseRouter);
app.use('/api/keep-notes', keepNotesRouter);
app.use('/api/daily-scratch', dailyScratchRouter);
app.use('/api/bookmarks', bookmarksRouter);
app.use('/api/dev-agent-log', devAgentLogRouter);


app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, next) => {
  const msg = String(err?.message || err || 'internal_error').slice(0, 500);
  console.error('[express]', msg);
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: err.message || 'internal_error' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`dashbird listening on http://0.0.0.0:${port}`);
  if (!existsSync('/.dockerenv')) {
    printLanUrl();
  }
  // Stagger background warmers so the first browser paint is never blocked on
  // sync SQLite / HDF5 / catalog probes after listen().
  const kick = (fn, delayMs) => {
    const t = setTimeout(() => {
      try {
        fn();
      } catch (e) {
        console.warn('[startup]', e?.message || e);
      }
    }, delayMs);
    if (typeof t.unref === 'function') t.unref();
  };
  kick(() => startSuperbloomAgent(), 50);
  kick(() => startGeospaceMagnetosphereMonitor(), 200);
  kick(() => startWebCatalogWatchPoller(), 400);
  kick(() => startWebCatalogDiscoveryWorker(), 600);
  kick(() => startFacebookEventsWeeklyScheduler(), 800);
  kick(() => startEventsFinderIngestScheduler(), 900);
  kick(() => startSkippedEventsPurgeScheduler(), 950);
  kick(() => startTelegramEventsPoller(), 1000);
  kick(() => startToolsContactsBackupScheduler(), 1100);
  kick(() => startDailyDataBackupScheduler(), 1125);
  kick(() => startBackupStalenessMonitor(), 1140);
  kick(() => startLocalNewsScheduler(), 1150);
  kick(() => startJobWatchScheduler(), 1160);
  kick(() => startBigEventsDailyRefreshScheduler(), 1175);
  kick(() => startGmailWeeklySummaryScheduler(), 1250);
  kick(() => warmGoogleCalendarCache(), 1200);
  kick(() => startCalendarPresenceIndexScheduler(), 1500);
  kick(() => {
    void syncManualCalendarEventsToCatalog()
      .then((r) => {
        if (r?.upserted) console.log(`[manual-calendar] synced ${r.upserted}/${r.count} events`);
      })
      .catch((e) => console.warn('[manual-calendar]', e?.message || e));
  }, 1400);
  kick(() => {
    void resolveDashboardWeatherLatLon().catch(() => {});
  }, 300);
});
