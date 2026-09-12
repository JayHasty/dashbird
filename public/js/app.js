/**
 * Dashbird entry — keep static imports minimal so mobile mode does not download
 * the desktop dashboard graph before painting Network/Events.
 */
import { isMobileView } from './lib/view-mode.js';
import { readPanelCache, writePanelCache } from './lib/panel-cache.js';

const CONFIG_CACHE_KEY = 'config';
const CONFIG_CACHE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

async function loadConfig() {
  const r = await fetch('/api/config');
  if (!r.ok) throw new Error('config failed');
  const config = await r.json();
  writePanelCache(CONFIG_CACHE_KEY, config);
  return config;
}

/** Prefer a fresh fetch; fall back to last session so priority UI never waits on a blank config. */
async function loadConfigPreferLive() {
  try {
    return await loadConfig();
  } catch (e) {
    const cached = readPanelCache(CONFIG_CACHE_KEY, CONFIG_CACHE_MAX_MS);
    if (cached && typeof cached === 'object') return cached;
    throw e;
  }
}

/**
 * Header top-right: live device place when GPS is allowed, else server WEATHER_ZIP/lat/lon.
 * @param {HTMLElement | null} el
 * @param {{ shortLabel?: string, timeZone?: string, source?: string, label?: string }} place
 */
function renderTopbarContext(el, place) {
  if (!el || !place) return;

  const loc = (place.shortLabel || '').trim() || '—';
  const live = place.source === 'device';

  el.replaceChildren();
  const lineLoc = document.createElement('span');
  lineLoc.className = 'topbar__context-line topbar__context-loc';
  lineLoc.textContent = live ? `${loc} · live` : loc;

  el.append(lineLoc);
  el.title = live
    ? `Your current location (${place.label || loc}). Rain alert uses this point.`
    : 'Server default location (WEATHER_ZIP). Allow location in the browser for live updates.';
}

let settingsLoaded = false;
let houseHunterLoaded = false;
let networkLoaded = false;

/** @param {'main' | 'network' | 'house-hunter' | 'settings'} page */
function showPage(page) {
  const main = document.getElementById('page-main');
  const settings = document.getElementById('page-settings');
  const houseHunter = document.getElementById('page-house-hunter');
  const network = document.getElementById('page-network');
  const mobile = document.getElementById('page-mobile');
  if (main) main.hidden = page !== 'main';
  if (settings) settings.hidden = page !== 'settings';
  if (houseHunter) houseHunter.hidden = page !== 'house-hunter';
  if (network) network.hidden = page !== 'network';
  if (mobile) mobile.hidden = true;
  if (page === 'settings' && !settingsLoaded) {
    settingsLoaded = true;
    void import('./panels/settings-page.js').then(({ mountSettingsPage }) => {
      mountSettingsPage(document.getElementById('mount-settings'));
    });
  }
  if (page === 'house-hunter' && !houseHunterLoaded) {
    houseHunterLoaded = true;
    import('./panels/house-hunter.js')
      .then(({ mountHouseHunter }) => {
        mountHouseHunter(document.getElementById('mount-house-hunter'));
      })
      .catch((e) => console.error('House Hunter mount failed:', e));
  }
  if (page === 'network') {
    import('./lib/network-prefetch.js')
      .then(({ beginNetworkPrefetch }) => beginNetworkPrefetch())
      .catch(() => {});
  }
  if (page === 'network' && !networkLoaded) {
    networkLoaded = true;
    import('./panels/network.js?v=scene-list-tall-1')
      .then(({ mountNetwork }) => {
        mountNetwork(document.getElementById('mount-network'));
      })
      .catch((e) => console.error('Network mount failed:', e));
  }
}

function markPriorityReady() {
  document.body.classList.add('dashy--priority-ready');
}

function markDeferredReady() {
  if (document.body.classList.contains('dashy--deferred-ready')) return;
  document.body.classList.add('dashy--deferred-ready');
  for (const el of document.querySelectorAll('.boot-deferred[aria-busy]')) {
    el.removeAttribute('aria-busy');
  }
}

/**
 * @param {string} label
 * @param {() => Promise<unknown>} load
 */
function mountWhenReady(label, load) {
  return load()
    .then(() => {
      markDeferredReady();
    })
    .catch((e) => {
      console.error(`${label} mount failed:`, e);
    });
}

/**
 * @param {object} config
 */
async function mountDeferredPanels(config) {
  const jobs = [
    mountWhenReady('hero', () =>
      Promise.all([
        import('./panels/hero.js'),
        import('./lib/device-location.js'),
        import('./lib/location-profile.js'),
      ]).then(
        ([
          { mountHero },
          { startDeviceLocation, subscribeDevicePlace },
          { startLocationProfile, subscribeLocationMode, reloadForLocationMode },
        ]) => {
          const topbarEl = document.getElementById('mount-topbar-context');
          startDeviceLocation(config).then((place) => {
            if (place) renderTopbarContext(topbarEl, place);
          });
          subscribeDevicePlace((place) => renderTopbarContext(topbarEl, place));
          startLocationProfile(config);
          let lastMode = config.locationMode || 'home';
          subscribeLocationMode((next) => {
            if (next !== lastMode) {
              lastMode = next;
              reloadForLocationMode();
            }
          });
          mountHero(document.getElementById('mount-hero'), config, {
            renderSkyStrip: true,
            skyStripMount: document.getElementById('mount-sky-strip'),
          });
        },
      ),
    ),
    mountWhenReady('earth', () =>
      import('./panels/earth-events.js').then(({ mountEarthStrip }) => {
        mountEarthStrip(document.getElementById('mount-earth-strip'), {
          hideEarth: Array.isArray(config.hideEarth) ? config.hideEarth : [],
        });
      }),
    ),
    mountWhenReady('kilauea-live', () =>
      import('./panels/kilauea-livestream.js').then(({ mountKilaueaLivestream }) => {
        mountKilaueaLivestream(
          document.getElementById('kilauea-live-card'),
          document.getElementById('mount-kilauea-live'),
        );
      }),
    ),
    mountWhenReady('weather-radar', () =>
      import('./panels/weather-radar.js').then(({ mountWeatherRadar }) => {
        mountWeatherRadar(
          document.getElementById('weather-radar-card'),
          document.getElementById('mount-weather-radar'),
        );
      }),
    ),
    mountWhenReady('geoelectric', () =>
      import('./panels/geoelectric-field.js').then(({ mountGeoelectricField }) => {
        mountGeoelectricField(
          document.getElementById('geoelectric-field-card'),
          document.getElementById('mount-geoelectric-field'),
        );
      }),
    ),
    mountWhenReady('air-quality', () =>
      import('./panels/air-quality.js').then(({ mountAirQuality }) => {
        mountAirQuality(
          document.getElementById('air-quality-card'),
          document.getElementById('mount-air-quality'),
        );
      }),
    ),
    mountWhenReady('magnetosphere', () =>
      import('./panels/magnetosphere.js').then(({ mountMagnetosphere }) => {
        mountMagnetosphere(
          document.getElementById('magnetosphere-card'),
          document.getElementById('mount-magnetosphere'),
        );
      }),
    ),
    mountWhenReady('market-watch', () =>
      import('./panels/market-watch.js').then(({ mountMarketWatch }) => {
        mountMarketWatch(document.getElementById('mount-market-watch'));
      }),
    ),
    mountWhenReady('daily-summary', () =>
      import('./panels/daily-summary.js').then(({ mountDailySummary }) => {
        mountDailySummary(document.getElementById('mount-daily-summary'));
      }),
    ),
    mountWhenReady('tool-library', () =>
      import('./panels/tool-library.js').then(({ mountToolLibrary }) => {
        mountToolLibrary(document.getElementById('mount-tool-library'));
      }),
    ),
    mountWhenReady('job-watch', () =>
      import('./panels/job-watch.js?v=posted-title-type').then(({ mountJobWatch }) => {
        mountJobWatch(document.getElementById('mount-job-watch'));
        const scanBtn = document.getElementById('job-watch-scan');
        if (scanBtn) {
          scanBtn.addEventListener('click', () => {
            document.querySelector('.job-watch__scan-btn')?.click();
          });
        }
      }),
    ),
    mountWhenReady('events-finder', () =>
      import('./panels/events-finder.js?v=big-events-filter-1').then(({ mountEventsFinder }) => {
        mountEventsFinder(document.getElementById('mount-events-finder'));
      }),
    ),
    mountWhenReady('local-news', () =>
      import('./panels/local-news.js').then(({ mountLocalNews }) => {
        const news = mountLocalNews(document.getElementById('mount-local-news'));
        const readerBtn = document.getElementById('local-news-reader');
        if (news && readerBtn) {
          readerBtn.addEventListener('click', () => news.openReader());
        }
      }),
    ),
  ];

  await Promise.allSettled(jobs);

  markDeferredReady();
}

/** Lean phone boot: view toggle + Network/Events shell only. */
async function mainMobile() {
  document.body.classList.add('dashy--view-mobile');

  /* Cloud: if session is still 401 after did self-heal, send phone to bind once.
   * Device ID comes from localStorage (set at bind time) — never hardcode personal DIDs. */
  try {
    const probe = await fetch('/api/config', { cache: 'no-store', credentials: 'same-origin' });
    if (probe.status === 401 && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      let did = '';
      try { did = String(localStorage.getItem('dashbird_did') || '').trim(); } catch { /* ignore */ }
      location.replace(did ? `/auth/device-bind?did=${encodeURIComponent(did)}` : '/auth/device-bind');
      return;
    }
  } catch {
    /* continue — shell may still load on LAN */
  }

  const [{ mountViewModeToggle }, { mountMobileShell }] = await Promise.all([
    import('./panels/view-mode-toggle.js'),
    import('./panels/mobile-shell.js?v=mobile-panels-20260825-big-events-filter-1'),
  ]);

  mountViewModeToggle(document.getElementById('mount-view-mode'));
  mountMobileShell({
    tabsRoot: document.getElementById('mount-mobile-tabs'),
    notesRoot: document.getElementById('mount-mobile-notes'),
    networkRoot: document.getElementById('mount-mobile-network'),
    eventsRoot: document.getElementById('mount-mobile-events'),
    groupsRoot: document.getElementById('mount-mobile-groups'),
    tasksRoot: document.getElementById('mount-mobile-tasks'),
    gmailRoot: document.getElementById('mount-mobile-gmail'),
  });

  /* Active-state chips (aircraft / volcano / etc.) must mount even if config
     fetch fails — they use dedicated APIs + server watch fallbacks. */
  void Promise.all([
    import('./lib/mobile-aircraft-header.js'),
    import('./lib/mobile-condition-alerts.js'),
  ])
    .then(([{ mountMobileAircraftHeader }, { mountMobileConditionAlerts }]) => {
      mountMobileAircraftHeader(document.getElementById('mount-topbar-aircraft'));
      mountMobileConditionAlerts(document.getElementById('mount-topbar-conditions'));
    })
    .catch((e) => console.error('Mobile active-state chips failed:', e));

  /* Weather + zip / TZ still need config for device location seeding. */
  void loadConfigPreferLive()
    .then(async (config) => {
      try {
        const { startDeviceLocation, subscribeDevicePlace } = await import('./lib/device-location.js');
        const {
          startLocationProfile,
          subscribeLocationMode,
          reloadForLocationMode,
        } = await import('./lib/location-profile.js');
        const topbarEl = document.getElementById('mount-topbar-context');
        startDeviceLocation(config).then((place) => {
          if (place) renderTopbarContext(topbarEl, place);
        });
        subscribeDevicePlace((place) => renderTopbarContext(topbarEl, place));
        startLocationProfile(config);
        let lastMode = config.locationMode || 'home';
        subscribeLocationMode((next) => {
          if (next !== lastMode) {
            lastMode = next;
            reloadForLocationMode();
          }
        });
        const { mountMobileWeatherHeader } = await import('./lib/mobile-weather-header.js');
        mountMobileWeatherHeader(document.getElementById('mount-topbar-weather'));
      } catch (e) {
        console.error('Mobile location context failed:', e);
      }
    })
    .catch(() => {});

  void import('./panels/dev-request-mobile.js')
    .then(({ mountDevRequestMobile }) => {
      mountDevRequestMobile();
    })
    .catch((e) => console.error('Dev request mobile mount failed:', e));

  void import('./panels/daily-scratch-mobile.js')
    .then(({ mountDailyScratchMobile }) => {
      mountDailyScratchMobile();
    })
    .catch((e) => console.error('Daily scratch mobile mount failed:', e));

  markPriorityReady();
  markDeferredReady();
}

async function mainDesktop() {
  const [
    { mountViewModeToggle },
    { mountPageTabs },
    { mountSkySidebarToggle },
    { mountTasksKeepCollapse },
    { mountBookmarkGrid, createBookmarksCoordinator },
    { mountCalendarUpcoming },
    { mountCalendar },
  ] = await Promise.all([
    import('./panels/view-mode-toggle.js'),
    import('./panels/page-tabs.js'),
    import('./panels/sky-sidebar-toggle.js'),
    import('./panels/tasks-keep-collapse.js'),
    import('./panels/bookmarks.js'),
    import('./panels/calendar-upcoming.js'),
    import('./panels/calendar.js'),
  ]);

  mountViewModeToggle(document.getElementById('mount-view-mode'));
  mountPageTabs(document.getElementById('mount-page-tabs'), { onChange: showPage });
  mountSkySidebarToggle(document.getElementById('sky-sidebar-toggle'));
  mountTasksKeepCollapse();

  const bookmarksCoordinator = createBookmarksCoordinator();
  const bookmarksPersonalPromise = mountBookmarkGrid(
    document.getElementById('mount-bookmarks-personal'),
    '/data/bookmarks-personal.json',
    'Add tiles in public/data/bookmarks-personal.json (up to 9).',
    bookmarksCoordinator,
  );
  const bookmarksWorkPromise = mountBookmarkGrid(
    document.getElementById('mount-bookmarks-work'),
    '/data/bookmarks-work.json',
    'Add tiles in public/data/bookmarks-work.json.',
    bookmarksCoordinator,
  );
  const bookmarksActions = document.getElementById('bookmarks-actions');
  if (bookmarksActions) bookmarksCoordinator.mountToolbar(bookmarksActions);

  const cachedConfig = readPanelCache(CONFIG_CACHE_KEY, CONFIG_CACHE_MAX_MS);
  const configPromise = loadConfigPreferLive();

  /** Paint calendar ASAP from last session while config refreshes. */
  let config =
    cachedConfig && typeof cachedConfig === 'object' ? cachedConfig : await configPromise;

  const calUpcomingMount = document.getElementById('mount-cal-upcoming');
  if (calUpcomingMount) {
    mountCalendarUpcoming(calUpcomingMount, config, {});
  }

  mountCalendar(document.getElementById('mount-calendar'), config);

  void import('./panels/tasks.js?v=tasks-reorder-1')
    .then(({ mountTasks }) => {
      mountTasks(document.getElementById('mount-tasks'), config);
    })
    .catch((e) => console.error('Tasks mount failed:', e));

  void import('./panels/keep-notes.js')
    .then(({ mountKeepNotes }) => {
      mountKeepNotes(document.getElementById('mount-keep-notes'));
    })
    .catch((e) => console.error('Keep notes mount failed:', e));

  void import('./panels/dev-sticky-note.js')
    .then(({ mountDevStickyNote }) => {
      mountDevStickyNote();
    })
    .catch((e) => console.error('Dev sticky mount failed:', e));

  void import('./panels/daily-scratch-sticky.js')
    .then(({ mountDailyScratchSticky }) => {
      mountDailyScratchSticky();
    })
    .catch((e) => console.error('Daily scratch sticky mount failed:', e));

  void configPromise.then((fresh) => {
    if (!fresh || typeof fresh !== 'object') return;
    if (fresh.vikunjaPublicUrl === config.vikunjaPublicUrl) return;
    import('./panels/tasks.js?v=tasks-reorder-1')
      .then(({ mountTasks }) => {
        mountTasks(document.getElementById('mount-tasks'), fresh);
      })
      .catch(() => {});
  });

  markPriorityReady();

  void Promise.allSettled([bookmarksPersonalPromise, bookmarksWorkPromise]);

  const scheduleDeferred =
    typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(() => fn(), { timeout: 200 })
      : (fn) => setTimeout(fn, 0);

  scheduleDeferred(() => {
    mountDeferredPanels(config).catch((e) => {
      console.error('Deferred panels failed:', e);
    });
  });

  void configPromise.then((fresh) => {
    if (fresh && typeof fresh === 'object') config = fresh;
  });
}

async function main() {
  if (isMobileView()) {
    await mainMobile();
    return;
  }
  await mainDesktop();
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<p class="err err--banner">Failed to start dashboard: ${String(e.message)}</p>`,
  );
});
