/**
 * Big Events — search a name, preview the official site snapshot, then add it to
 * the tracked table (dates, ticket price, early bird, prior-year estimate).
 */
import { Router } from 'express';
import express from 'express';
import {
  loadEventsFinderCriteria,
  saveEventsFinderCriteria,
} from '../lib/events-finder-criteria-store.js';
import {
  loadConferenceWatchlistStore,
  slugFromQuery,
  upsertConferenceWatchlistRecords,
  removeConferenceWatchlistSlugs,
  removeBigEventShot,
  bigEventsShotsDir,
  normalizeLeadDays,
} from '../lib/events-finder-conference-watchlist-store.js';
import {
  previewBigEvent,
  researchConferenceQuery,
  normalizeConferenceWatchlist,
  conferenceRecordToWatchItem,
  loadConferenceHeadsUp,
  probeProducerFromUrl,
} from '../lib/events-finder-conference-watchlist.js';
import {
  buildEventLogistics,
  normalizeTripPlanning,
  tripPlanningToLegacyNotes,
  resolveLogisticsLatLon,
  fetchEventLogisticsWeather,
} from '../lib/events-finder-travel-logistics.js';
import { lookupEventCityOnline } from '../lib/events-finder-city-lookup.js';
import {
  getFlightModule,
  upsertFlightModule,
} from '../lib/events-finder-flight-module.js';
import {
  ensureTravelBriefForLogistics,
  publicTravelBrief,
  refreshTravelBrief,
} from '../lib/events-finder-travel-brief.js';
import {
  getLogisticsModule,
  publicLogisticsModule,
  upsertLogisticsModule,
} from '../lib/events-finder-logistics-modules.js';
import {
  listEventsFinderEvents,
} from '../lib/events-finder-store.js';
import {
  loadNotableEventsStore,
  applyNotableToEvent,
} from '../lib/events-finder-notable-store.js';
import { geocodeAddress } from '../lib/geocode-address.js';

const router = Router();
router.use(express.json({ limit: '256kb' }));

// Serve cached website snapshots.
router.use(
  '/shot',
  express.static(bigEventsShotsDir(process.env), {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'private, max-age=300');
    },
  }),
);

/** GET the current tracked Big Events table. */
router.get('/', async (_req, res) => {
  try {
    const criteria = await loadEventsFinderCriteria();
    const pack = await loadConferenceHeadsUp(criteria.conferenceWatchlist, new Date(), process.env);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, items: pack.items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** POST /search { query, deep? } — find the official site URL (no snapshot, no commit). */
router.post('/search', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim().slice(0, 120);
    if (!query) {
      res.status(400).json({ ok: false, error: 'missing_query' });
      return;
    }
    const deep = req.body?.deep === true;
    const preview = await previewBigEvent(query, process.env, { deep });
    if (!preview.ok) {
      res.status(422).json(preview);
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      preview: {
        slug: preview.slug,
        query: preview.query,
        name: preview.name,
        url: preview.url,
        homepageUrl: preview.homepageUrl || preview.url || null,
        ticketUrl: preview.ticketUrl || null,
        urlFound: preview.urlFound === true,
        deep: preview.deep === true,
        confident: preview.confident === true,
        candidates: Array.isArray(preview.candidates)
          ? preview.candidates.map((c) => ({
              url: String(c?.url || '').trim(),
              title: String(c?.title || '').trim().slice(0, 140),
              score: Number(c?.score) || 0,
            })).filter((c) => c.url)
          : [],
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /add { query?, url?, homepageUrl?, ticketUrl?, manual? }
 * Commit to the producers watchlist. Prefer `url` alone — we probe the page for
 * a display name, then scrape dates / tickets / early bird. `manual: true` locks
 * name-only adds that cannot be found via search.
 */
router.post('/add', async (req, res) => {
  try {
    let query = String(req.body?.query || '').trim().slice(0, 120);
    let url = String(req.body?.url || '').trim().slice(0, 500) || null;
    let homepageUrl = String(req.body?.homepageUrl || '').trim().slice(0, 500) || url || null;
    const ticketUrl = String(req.body?.ticketUrl || '').trim().slice(0, 500) || null;
    const screenshotPath = String(req.body?.screenshotPath || '').trim().slice(0, 200) || null;
    const manual = req.body?.manual === true;

    // URL-only add (producers tab): pull the event name from the page.
    if (!query && url) {
      const probed = await probeProducerFromUrl(url, process.env);
      if (!probed.ok) {
        res.status(422).json(probed);
        return;
      }
      query = probed.query;
      url = probed.url;
      homepageUrl = probed.homepageUrl || probed.url;
    }

    if (!query) {
      res.status(400).json({ ok: false, error: 'missing_query_or_url' });
      return;
    }
    const slug = slugFromQuery(query);
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_query' });
      return;
    }

    const criteria = await loadEventsFinderCriteria();
    const names = normalizeConferenceWatchlist([
      ...(Array.isArray(criteria.conferenceWatchlist) ? criteria.conferenceWatchlist : []),
      query,
    ]);
    const saved = await saveEventsFinderCriteria({
      lookFor: criteria.lookFor,
      skip: criteria.skip,
      blacklist: criteria.blacklist,
      conferenceWatchlist: names,
    });
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }

    // Seed the record with the chosen URL + snapshot so research keeps them.
    // Preserve any previously researched data (dates, price, etc.) while the
    // background pass runs — a bare stub would blank the card to "TBD" until
    // (and unless) research completes. Only overlay the new url/screenshot.
    const priorStore = await loadConferenceWatchlistStore(process.env);
    const priorRec = priorStore.bySlug[slug] || {};
    const hasSite = Boolean(homepageUrl || url);
    // Manual name-only add: lock so daily research cannot invent a wrong site.
    // Manual + pasted URL: still scrape that page, but keep the manual lock.
    const runResearch = !manual || hasSite;
    await upsertConferenceWatchlistRecords(
      {
        [slug]: {
          ...priorRec,
          slug,
          query,
          name: priorRec.name || query,
          url: homepageUrl || url || priorRec.url || null,
          homepageUrl: homepageUrl || priorRec.homepageUrl || null,
          ticketUrl: ticketUrl || priorRec.ticketUrl || null,
          screenshotPath: screenshotPath || priorRec.screenshotPath || null,
          // New producers default to "tell me when dates are set".
          notifyWhenDatesSet:
            priorRec.notifyWhenDatesSet === true
            || priorRec.notifyWhenDatesSet == null,
          manualEdit: manual || priorRec.manualEdit === true,
          researching: runResearch,
          researchedAt: new Date().toISOString(),
        },
      },
      process.env,
    );

    if (runResearch) {
      setImmediate(() => {
        void researchConferenceQuery(query, process.env, {
          url,
          homepageUrl,
          ticketUrl,
          screenshotPath,
        }).catch((err) => {
          console.warn('[big-events] research failed:', String(err?.message || err).slice(0, 160));
        });
      });
    }

    const store = await loadConferenceWatchlistStore(process.env);
    const rec = store.bySlug[slug] || {
      slug,
      query,
      name: query,
      url,
      screenshotPath,
      manualEdit: manual,
      researching: runResearch,
    };
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, item: conferenceRecordToWatchItem(rec, new Date()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** POST /research { query|slug } — re-run research for one tracked event. */
router.post('/research', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim().slice(0, 120);
    if (!query) {
      res.status(400).json({ ok: false, error: 'missing_query' });
      return;
    }
    // An explicit re-research overrides a manual-edit lock (discards hand edits
    // and re-fetches from the web).
    setImmediate(() => {
      void researchConferenceQuery(query, process.env, { force: true }).catch(() => {});
    });
    res.json({ ok: true, slug: slugFromQuery(query) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * PATCH /:slug — update one event. Accepts `reminderLeadDays` and/or any of the
 * editable metadata fields below. Editing metadata sets `manualEdit` so the
 * daily/auto research leaves the hand-corrected record alone (use POST /research
 * to discard edits and re-fetch).
 */
const EDITABLE_STRING_FIELDS = [
  'name',
  'homepageUrl',
  'ticketUrl',
  'venue',
  'city',
  'ticketPrice',
  'earlyBirdPrice',
  'gatesOpen',
  'notes',
  'planningNotes',
];
const EDITABLE_DATE_FIELDS = [
  'eventStart',
  'eventEnd',
  'ticketSalesStart',
  'earlyBirdStart',
  'earlyBirdEnd',
];

/**
 * GET /:slug/logistics — trip planning pack + nearby taste-ranked events.
 */
router.get('/:slug/logistics', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    let store = await loadConferenceWatchlistStore(process.env);
    let rec = store.bySlug[slug];
    if (!rec) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }

    // Fill missing city from an online lookup (search + optional LLM).
    if (!String(rec.city || '').trim()) {
      try {
        const looked = await lookupEventCityOnline(
          {
            name: rec.name || rec.query,
            query: rec.query,
            venue: rec.venue,
            url: rec.homepageUrl || rec.url,
            year: rec.eventStart ? Number(String(rec.eventStart).slice(0, 4)) : null,
          },
          process.env,
        );
        if (looked.city) {
          const patch = {
            ...rec,
            city: looked.city,
            researchedAt: rec.researchedAt || new Date().toISOString(),
          };
          store = await upsertConferenceWatchlistRecords({ [slug]: patch }, process.env);
          rec = store.bySlug[slug] || patch;
        }
      } catch (e) {
        console.warn('[big-events] city lookup failed', String(e?.message || e).slice(0, 160));
      }
    }

    const item = conferenceRecordToWatchItem(rec, new Date());
    const asEvent = {
      id: item.id,
      title: item.title,
      start: item.start,
      end: item.end,
      venue: item.venue,
      city: item.city,
      url: item.url,
      planningNotes: item.planningNotes,
      tripPlanning: item.tripPlanning,
    };
    let coords = resolveLogisticsLatLon(asEvent);
    if (!coords && item.city) {
      const geo = await geocodeAddress(item.city, { countrycodes: null }).catch(() => null);
      if (geo) {
        asEvent.lat = geo.lat;
        asEvent.lon = geo.lon;
        coords = { lat: geo.lat, lon: geo.lon };
      }
    } else if (coords) {
      asEvent.lat = coords.lat;
      asEvent.lon = coords.lon;
    }
    const notableStore = await loadNotableEventsStore();
    const catalog = listEventsFinderEvents({ limit: 2000 }).map((ev) => {
      const n = notableStore[String(ev.id || '')];
      return n ? applyNotableToEvent(ev, n) : ev;
    });
    const criteria = await loadEventsFinderCriteria();
    const logistics = await buildEventLogistics(asEvent, catalog, {
      taste: {
        lookFor: criteria.lookFor,
        skip: criteria.skip,
        blacklist: criteria.blacklist,
      },
      tripPlanning: rec.tripPlanning,
    });
    const flightModule = await getFlightModule('big', slug, process.env);
    const [transportMod, staysMod] = await Promise.all([
      getLogisticsModule('big', slug, 'transportation', process.env),
      getLogisticsModule('big', slug, 'accommodations', process.env),
    ]);
    const travelBriefPack = await ensureTravelBriefForLogistics(
      {
        kind: 'big',
        id: slug,
        city: asEvent.city,
        start: asEvent.start,
        end: asEvent.end,
        lat: asEvent.lat,
        lon: asEvent.lon,
        title: asEvent.title,
      },
      process.env,
      { wait: false },
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ...logistics,
      slug,
      producer: true,
      city: asEvent.city || logistics.map?.label || null,
      travelBrief: travelBriefPack.eligible
        ? publicTravelBrief(travelBriefPack.brief) || {
            ok: false,
            researching: true,
            city: asEvent.city || null,
            summary: null,
            items: [],
            packingTips: [],
            sources: [],
            nwsAlerts: [],
            generatedAt: null,
            error: null,
            fresh: false,
          }
        : null,
      flightModule: flightModule
        ? {
            enabled: flightModule.enabled,
            destination: flightModule.destination,
            destinationCity: flightModule.destinationCity,
            departDate: flightModule.departDate,
            origins: flightModule.origins,
            cheapest: flightModule.cheapest,
            best: flightModule.best,
            priceTier: flightModule.priceTier,
            buyByDate: flightModule.buyByDate,
            buyByReason: flightModule.buyByReason,
            googleFlightsUrl: flightModule.googleFlightsUrl,
            lastCheckedAt: flightModule.lastCheckedAt,
            nextCheckAt: flightModule.nextCheckAt,
            checking: flightModule.checking,
            error: flightModule.error,
            historyPoints: flightModule.priceHistory?.length || 0,
          }
        : { enabled: false },
      logisticsModules: {
        transportation: publicLogisticsModule(transportMod) || { enabled: false, type: 'transportation' },
        accommodations: publicLogisticsModule(staysMod) || { enabled: false, type: 'accommodations' },
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /:slug/travel-brief — refresh local conditions / packing brief.
 * Body: { refresh?: boolean } (defaults to force refresh)
 */
router.post('/:slug/travel-brief', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const store = await loadConferenceWatchlistStore(process.env);
    const rec = store.bySlug[slug];
    if (!rec) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const item = conferenceRecordToWatchItem(rec, new Date());
    const city = String(item.city || '').trim();
    if (!city) {
      res.status(400).json({ ok: false, error: 'missing_city' });
      return;
    }
    const asEvent = {
      title: item.title,
      start: item.start,
      end: item.end,
      venue: item.venue,
      city,
    };
    const coords = resolveLogisticsLatLon(asEvent);
    if (coords) {
      asEvent.lat = coords.lat;
      asEvent.lon = coords.lon;
    } else {
      const geo = await geocodeAddress(city, { countrycodes: null }).catch(() => null);
      if (geo) {
        asEvent.lat = geo.lat;
        asEvent.lon = geo.lon;
      }
    }
    const brief = await refreshTravelBrief(
      {
        kind: 'big',
        id: slug,
        city,
        start: asEvent.start,
        end: asEvent.end,
        lat: asEvent.lat,
        lon: asEvent.lon,
        title: asEvent.title,
      },
      process.env,
      { force: req.body?.refresh !== false },
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, travelBrief: publicTravelBrief(brief) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * GET /:slug/logistics-module/:type — transportation | accommodations research state.
 */
router.get('/:slug/logistics-module/:type', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    const type =
      String(req.params.type || '') === 'accommodations' ? 'accommodations' : 'transportation';
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const store = await loadConferenceWatchlistStore(process.env);
    if (!store.bySlug[slug]) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const mod = await getLogisticsModule('big', slug, type, process.env);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      module: publicLogisticsModule(mod) || { enabled: false, type },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /:slug/logistics-module/:type — enable/disable + research transport/stays.
 * Body: { enabled?: boolean, refresh?: boolean }
 */
router.post('/:slug/logistics-module/:type', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    const type =
      String(req.params.type || '') === 'accommodations' ? 'accommodations' : 'transportation';
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const store = await loadConferenceWatchlistStore(process.env);
    const rec = store.bySlug[slug];
    if (!rec) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const item = conferenceRecordToWatchItem(rec, new Date());
    const asEvent = {
      id: item.id,
      title: item.title,
      start: item.start,
      end: item.end,
      venue: item.venue,
      city: item.city,
      lat: item.lat,
      lon: item.lon,
    };
    let coords = resolveLogisticsLatLon(asEvent);
    if (!coords && item.city) {
      const geo = await geocodeAddress(item.city, { countrycodes: null }).catch(() => null);
      if (geo) {
        asEvent.lat = geo.lat;
        asEvent.lon = geo.lon;
        coords = { lat: geo.lat, lon: geo.lon };
      }
    }
    const enabled = req.body?.enabled !== false;
    const forceRefresh = req.body?.refresh === true;
    /** @type {object | null} */
    let weather = null;
    if (type === 'accommodations' && enabled && coords) {
      weather = await fetchEventLogisticsWeather(coords.lat, coords.lon, asEvent);
    }
    const mod = await upsertLogisticsModule(
      {
        kind: 'big',
        id: slug,
        type,
        event: asEvent,
        weather,
        enabled,
        forceRefresh: forceRefresh || enabled,
        wait: false,
      },
      process.env,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, module: publicLogisticsModule(mod) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * GET /:slug/flight-module — current Google Flights watch state.
 */
router.get('/:slug/flight-module', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const store = await loadConferenceWatchlistStore(process.env);
    if (!store.bySlug[slug]) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const flightModule = await getFlightModule('big', slug, process.env);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      flightModule: flightModule || { enabled: false },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /:slug/flight-module — enable/disable Google Flights watch for this Big Event.
 * Body: { enabled?: boolean, refresh?: boolean }
 */
router.post('/:slug/flight-module', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const store = await loadConferenceWatchlistStore(process.env);
    const rec = store.bySlug[slug];
    if (!rec) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const enabled = req.body?.enabled !== false;
    const forceRefresh = req.body?.refresh === true;
    const item = conferenceRecordToWatchItem(rec, new Date());
    const asEvent = {
      title: item.title,
      start: item.start,
      end: item.end,
      venue: item.venue,
      city: item.city,
    };
    const coords = resolveLogisticsLatLon(asEvent);
    if (coords) {
      asEvent.lat = coords.lat;
      asEvent.lon = coords.lon;
    } else if (item.city) {
      const geo = await geocodeAddress(item.city, { countrycodes: null }).catch(() => null);
      if (geo) {
        asEvent.lat = geo.lat;
        asEvent.lon = geo.lon;
      }
    }
    const flightModule = await upsertFlightModule(
      {
        kind: 'big',
        id: slug,
        event: asEvent,
        enabled,
        forceRefresh: forceRefresh || enabled,
        wait: false,
      },
      process.env,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, flightModule });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** @param {unknown} raw */
function cleanDateInput(raw) {
  const s = String(raw ?? '').trim().slice(0, 10);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T12:00:00Z`))
    ? s
    : undefined; // undefined → invalid, reject
}

/**
 * Pull a plausible expected value out of a freeform correction
 * ("correct the ticket prices to $575" → "$575").
 * @param {string} message
 * @param {string | null} field
 */
function guessExpectedFromCorrection(message, field) {
  const msg = String(message || '');
  if (field === 'ticketPrice' || field === 'earlyBirdPrice' || !field) {
    const m = msg.match(/\$\s?[\d,]+(?:\.\d{2})?(?:\s*[-–—]\s*\$?\s?[\d,]+(?:\.\d{2})?)?/);
    if (m) return m[0].replace(/\s+/g, '');
  }
  if (field === 'eventStart' || field === 'eventEnd' || field === 'ticketSalesStart'
    || field === 'earlyBirdStart' || field === 'earlyBirdEnd') {
    const iso = msg.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (iso) return iso[1];
  }
  const toMatch = msg.match(/\b(?:to|is|are|should be)\s+["']?([^"'.,;]+)["']?/i);
  if (toMatch) return toMatch[1].trim().slice(0, 120);
  return null;
}

router.patch('/:slug', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const body = req.body || {};
    const store = await loadConferenceWatchlistStore(process.env);
    const rec = store.bySlug[slug];
    if (!rec) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }

    /** @type {Record<string, unknown>} */
    const patch = {};
    let metaEdited = false;

    for (const key of EDITABLE_STRING_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const val = String(body[key] ?? '').trim() || null;
      patch[key] = val;
      if (key === 'homepageUrl') patch.url = val; // keep url mirror in sync
      // A hand-typed price is authoritative — drop the "estimated" annotation.
      if (key === 'ticketPrice') {
        patch.ticketPriceEstimated = false;
        patch.estimatedFromYear = null;
      }
      // Logistics notes are user-only; do not treat as research-lock.
      if (key !== 'planningNotes') metaEdited = true;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'tripPlanning')) {
      const tp = normalizeTripPlanning(body.tripPlanning, rec.planningNotes);
      patch.tripPlanning = tp;
      patch.planningNotes = tripPlanningToLegacyNotes(tp);
    }
    for (const key of EDITABLE_DATE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const val = cleanDateInput(body[key]);
      if (val === undefined) {
        res.status(400).json({ ok: false, error: `invalid_${key}` });
        return;
      }
      patch[key] = val;
      // A hand-typed start date is authoritative — drop the "(est.)" annotation.
      if (key === 'eventStart') patch.nextEditionEstimated = false;
      metaEdited = true;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'reminderLeadDays')) {
      patch.reminderLeadDays = normalizeLeadDays(body.reminderLeadDays);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'notifyWhenDatesSet')) {
      patch.notifyWhenDatesSet = body.notifyWhenDatesSet === true;
    }

    if (
      !metaEdited
      && !Object.prototype.hasOwnProperty.call(patch, 'reminderLeadDays')
      && !Object.prototype.hasOwnProperty.call(patch, 'notifyWhenDatesSet')
      && !Object.prototype.hasOwnProperty.call(patch, 'planningNotes')
      && !Object.prototype.hasOwnProperty.call(patch, 'tripPlanning')
    ) {
      res.status(400).json({ ok: false, error: 'no_editable_fields' });
      return;
    }

    // Editing metadata locks the record from auto-research; reminder / logistics
    // / notify toggles do not.
    if (metaEdited) {
      patch.manualEdit = true;
      patch.researching = false;
    }

    const updated = await upsertConferenceWatchlistRecords(
      { [slug]: { ...rec, ...patch } },
      process.env,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      item: conferenceRecordToWatchItem(updated.bySlug[slug] || rec, new Date()),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /:slug/correct { field?, message }
 * Double-click correction: user says what is wrong; we re-scrape with that hint,
 * apply any stated value, and store a field wire so future polls keep the right path.
 */
router.post('/:slug/correct', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const message = String(req.body?.message || '').trim().slice(0, 500);
    if (!message) {
      res.status(400).json({ ok: false, error: 'missing_message' });
      return;
    }
    const field = String(req.body?.field || '').trim().slice(0, 40) || null;
    const store = await loadConferenceWatchlistStore(process.env);
    const rec = store.bySlug[slug];
    if (!rec) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }

    const expectedValue =
      String(req.body?.expectedValue || '').trim().slice(0, 160)
      || guessExpectedFromCorrection(message, field);

    /** @type {Record<string, unknown>} */
    const immediate = {
      researching: true,
      researchedAt: new Date().toISOString(),
    };
    if (expectedValue && field === 'ticketPrice') {
      immediate.ticketPrice = expectedValue;
      immediate.ticketPriceEstimated = false;
      immediate.estimatedFromYear = null;
    } else if (expectedValue && field === 'earlyBirdPrice') {
      immediate.earlyBirdPrice = expectedValue;
    } else if (expectedValue && field === 'gatesOpen') {
      immediate.gatesOpen = String(expectedValue).trim().slice(0, 200);
    } else if (expectedValue && (field === 'eventStart' || field === 'eventEnd'
      || field === 'ticketSalesStart' || field === 'earlyBirdStart' || field === 'earlyBirdEnd')) {
      const ymd = cleanDateInput(expectedValue);
      if (ymd) immediate[field] = ymd;
    }

    await upsertConferenceWatchlistRecords(
      { [slug]: { ...rec, ...immediate } },
      process.env,
    );

    setImmediate(() => {
      void researchConferenceQuery(rec.query || rec.name || slug, process.env, {
        force: true,
        url: rec.url || undefined,
        homepageUrl: rec.homepageUrl || undefined,
        ticketUrl: rec.ticketUrl || undefined,
        correction: { field, message, expectedValue },
      }).catch((err) => {
        console.warn('[big-events] correct failed:', String(err?.message || err).slice(0, 160));
      });
    });

    const fresh = await loadConferenceWatchlistStore(process.env);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      item: conferenceRecordToWatchItem(fresh.bySlug[slug] || rec, new Date()),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Update one big event's record with a partial patch, returning the fresh
 * watch item. Shared by the snooze / skip / restore feed-card actions.
 * @param {string} slug
 * @param {Record<string, unknown>} patch
 * @param {import('express').Response} res
 */
async function patchBigEventRecord(slug, patch, res) {
  const store = await loadConferenceWatchlistStore(process.env);
  const rec = store.bySlug[slug];
  if (!rec) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  const updated = await upsertConferenceWatchlistRecords(
    { [slug]: { ...rec, ...patch } },
    process.env,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    ok: true,
    item: conferenceRecordToWatchItem(updated.bySlug[slug] || rec, new Date()),
  });
}

/** POST /:slug/snooze { days? } — hide from the feed for a week (default). */
router.post('/:slug/snooze', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const daysRaw = Number(req.body?.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 7;
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    await patchBigEventRecord(slug, { snoozedUntil: until, skipped: false }, res);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** POST /:slug/skip — dismiss from the feed (kept in the tracked table). */
router.post('/:slug/skip', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    await patchBigEventRecord(slug, { skipped: true, snoozedUntil: null }, res);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** POST /:slug/restore — clear snooze + skip so it shows in the feed again. */
router.post('/:slug/restore', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    await patchBigEventRecord(slug, { skipped: false, snoozedUntil: null }, res);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** DELETE /:slug — remove from the watchlist + cached research + snapshot. */
router.delete('/:slug', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const store = await loadConferenceWatchlistStore(process.env);
    const rec = store.bySlug[slug];

    const criteria = await loadEventsFinderCriteria();
    const names = (Array.isArray(criteria.conferenceWatchlist) ? criteria.conferenceWatchlist : [])
      .filter((name) => slugFromQuery(name) !== slug);
    const saved = await saveEventsFinderCriteria({
      lookFor: criteria.lookFor,
      skip: criteria.skip,
      blacklist: criteria.blacklist,
      conferenceWatchlist: names,
    });
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }

    if (rec?.screenshotPath) await removeBigEventShot(rec.screenshotPath, process.env);
    if (rec?.flierPath) await removeBigEventShot(rec.flierPath, process.env);
    await removeConferenceWatchlistSlugs([slug], process.env);

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, slug, conferenceWatchlist: saved.conferenceWatchlist });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
