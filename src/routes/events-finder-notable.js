/**
 * Notable events — flag catalog events, reminders, overrides, rescrape, logistics.
 */
import { Router } from 'express';
import express from 'express';
import {
  loadNotableEventsStore,
  upsertNotableEvent,
  applyNotableToEvent,
  normalizeLeadWeeks,
} from '../lib/events-finder-notable-store.js';
import {
  getEventsFinderEventById,
  listEventsFinderEvents,
  patchEventsFinderEvent,
  upsertEventsFinderEvents,
} from '../lib/events-finder-store.js';
import { fetchNormalizedEventFromUrl } from '../lib/events-finder-public-pages.js';
import { assertPublicHttpUrl } from '../lib/public-http-url.js';
import { buildEventLogistics } from '../lib/events-finder-travel-logistics.js';
import { loadEventsFinderCriteria } from '../lib/events-finder-criteria-store.js';

const router = Router();
router.use(express.json({ limit: '256kb' }));

/**
 * @param {string} eventId
 * @param {import('../lib/events-finder-notable-store.js').NotableEventRecord | null} notable
 */
function packItem(eventId, notable) {
  const event = getEventsFinderEventById(eventId);
  const merged = event ? applyNotableToEvent(event, notable) : null;
  return {
    eventId,
    notable: Boolean(notable?.notable),
    reminderLeadWeeks: notable?.reminderLeadWeeks ?? null,
    earlyBirdPrice: notable?.earlyBirdPrice ?? null,
    earlyBirdStart: notable?.earlyBirdStart ?? null,
    earlyBirdEnd: notable?.earlyBirdEnd ?? null,
    ticketSalesStart: notable?.ticketSalesStart ?? null,
    ticketPrice: notable?.ticketPrice ?? null,
    ticketUrl: notable?.ticketUrl ?? null,
    notes: notable?.notes ?? null,
    planningNotes: notable?.planningNotes ?? null,
    tripPlanning: notable?.tripPlanning ?? null,
    overrides: notable?.overrides || {},
    manualEdit: notable?.manualEdit === true,
    updatedAt: notable?.updatedAt ?? null,
    event: merged,
  };
}

/** GET / — all notable events. */
router.get('/', async (_req, res) => {
  try {
    const store = await loadNotableEventsStore();
    const items = Object.keys(store)
      .sort()
      .map((id) => packItem(id, store[id]));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** GET /:id/logistics — planning pack (map, flights links, nearby events). */
router.get('/:id/logistics', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'missing_id' });
      return;
    }
    const store = await loadNotableEventsStore();
    const notable = store[id] || null;
    const event = getEventsFinderEventById(id);
    if (!event) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const merged = applyNotableToEvent(event, notable);
    const catalog = listEventsFinderEvents({ limit: 2000 }).map((ev) => {
      const n = store[String(ev.id || '')];
      return n ? applyNotableToEvent(ev, n) : ev;
    });
    const criteria = await loadEventsFinderCriteria();
    const logistics = buildEventLogistics(merged, catalog, {
      taste: {
        lookFor: criteria.lookFor,
        skip: criteria.skip,
        blacklist: criteria.blacklist,
      },
      tripPlanning: notable?.tripPlanning,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(logistics);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /:id/rescrape — re-fetch the event URL and merge parsed fields.
 * Does not overwrite fields already in overrides unless `force: true`.
 */
router.post('/:id/rescrape', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'missing_id' });
      return;
    }
    const force = req.body?.force === true;
    const store = await loadNotableEventsStore();
    const notable = store[id] || null;
    const event = getEventsFinderEventById(id);
    if (!event) {
      res.status(404).json({ ok: false, error: 'event_not_in_catalog' });
      return;
    }
    const url = String(notable?.overrides?.url || event.url || '').trim();
    if (!url) {
      res.status(422).json({ ok: false, error: 'missing_url' });
      return;
    }
    let safeUrl;
    try {
      safeUrl = await assertPublicHttpUrl(url);
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
      return;
    }

    const scraped = await fetchNormalizedEventFromUrl(safeUrl, String(event.source || 'webpage'));
    if (!scraped) {
      res.status(422).json({ ok: false, error: 'scrape_empty' });
      return;
    }

    const locked = force ? {} : notable?.overrides || {};
    /** @type {Record<string, unknown>} */
    const catalogPatch = { manualEdit: notable?.manualEdit === true && !force };
    for (const [key, val] of Object.entries({
      title: scraped.title,
      start: scraped.start,
      end: scraped.end,
      venue: scraped.venue || scraped.location,
      city: scraped.city,
      lat: scraped.lat,
      lon: scraped.lon,
      description: scraped.description,
      url: scraped.url || safeUrl,
      priceLabel: scraped.priceLabel,
      imageUrl: scraped.imageUrl,
    })) {
      if (val == null || val === '') continue;
      if (!force && locked[key] != null && locked[key] !== '') continue;
      catalogPatch[key] = val;
    }

    upsertEventsFinderEvents([{ ...event, ...catalogPatch }], process.env);
    const updated = getEventsFinderEventById(id);

    /** Keep notable flag; clear override keys that were refreshed when force. */
    let nextNotable = notable;
    if (notable?.notable || req.body?.keepNotable !== false) {
      /** @type {Record<string, unknown>} */
      const nPatch = { notable: true };
      if (force) {
        nPatch.overrides = {};
        nPatch.manualEdit = false;
      }
      if (scraped.priceLabel && (!notable?.ticketPrice || force)) {
        nPatch.ticketPrice = String(scraped.priceLabel).slice(0, 80);
      }
      nextNotable = await upsertNotableEvent(id, nPatch);
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      scraped: {
        title: scraped.title || null,
        start: scraped.start || null,
        end: scraped.end || null,
        venue: scraped.venue || scraped.location || null,
        city: scraped.city || null,
        priceLabel: scraped.priceLabel || null,
        url: scraped.url || safeUrl,
      },
      item: packItem(id, nextNotable),
      event: updated ? applyNotableToEvent(updated, nextNotable) : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** GET /:id */
router.get('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'missing_id' });
      return;
    }
    const store = await loadNotableEventsStore();
    const notable = store[id] || null;
    const event = getEventsFinderEventById(id);
    if (!event && !notable) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, item: packItem(id, notable) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * PATCH /:id — set notable flag + metadata / overrides.
 * Body: { notable?, reminderLeadWeeks?, earlyBird*, ticket*, notes?, planningNotes?, tripPlanning?, overrides?, applyOverridesToCatalog? }
 */
router.patch('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'missing_id' });
      return;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const event = getEventsFinderEventById(id);
    if (!event && body.notable !== false) {
      res.status(404).json({ ok: false, error: 'event_not_in_catalog' });
      return;
    }

    if (body.notable === false) {
      await upsertNotableEvent(id, { notable: false });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, item: packItem(id, null) });
      return;
    }

    /** @type {Record<string, unknown>} */
    const patch = { notable: true };
    if (body.reminderLeadWeeks !== undefined) {
      patch.reminderLeadWeeks = normalizeLeadWeeks(body.reminderLeadWeeks);
    }
    for (const key of [
      'earlyBirdPrice',
      'earlyBirdStart',
      'earlyBirdEnd',
      'ticketSalesStart',
      'ticketPrice',
      'ticketUrl',
      'notes',
      'planningNotes',
    ]) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.tripPlanning !== undefined) {
      patch.tripPlanning = body.tripPlanning;
    }
    if (body.overrides !== undefined) {
      patch.overrides = body.overrides;
      patch.manualEdit = true;
    }
    if (body.manualEdit !== undefined) patch.manualEdit = body.manualEdit === true;

    const notable = await upsertNotableEvent(id, patch);

    if (
      body.applyOverridesToCatalog === true
      && notable?.overrides
      && Object.keys(notable.overrides).length
    ) {
      patchEventsFinderEvent(id, { ...notable.overrides, manualEdit: true });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, item: packItem(id, notable) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /:id/rescrape — re-fetch the event URL and merge parsed fields.
 * Does not overwrite fields already in overrides unless `force: true`.
 */
router.post('/:id/rescrape', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'missing_id' });
      return;
    }
    const force = req.body?.force === true;
    const store = await loadNotableEventsStore();
    const notable = store[id] || null;
    const event = getEventsFinderEventById(id);
    if (!event) {
      res.status(404).json({ ok: false, error: 'event_not_in_catalog' });
      return;
    }
    const url = String(notable?.overrides?.url || event.url || '').trim();
    if (!url) {
      res.status(422).json({ ok: false, error: 'missing_url' });
      return;
    }
    let safeUrl;
    try {
      safeUrl = await assertPublicHttpUrl(url);
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
      return;
    }

    const scraped = await fetchNormalizedEventFromUrl(safeUrl, String(event.source || 'webpage'));
    if (!scraped) {
      res.status(422).json({ ok: false, error: 'scrape_empty' });
      return;
    }

    const locked = force ? {} : notable?.overrides || {};
    /** @type {Record<string, unknown>} */
    const catalogPatch = { manualEdit: notable?.manualEdit === true && !force };
    for (const [key, val] of Object.entries({
      title: scraped.title,
      start: scraped.start,
      end: scraped.end,
      venue: scraped.venue || scraped.location,
      city: scraped.city,
      lat: scraped.lat,
      lon: scraped.lon,
      description: scraped.description,
      url: scraped.url || safeUrl,
      priceLabel: scraped.priceLabel,
      imageUrl: scraped.imageUrl,
    })) {
      if (val == null || val === '') continue;
      if (!force && locked[key] != null && locked[key] !== '') continue;
      catalogPatch[key] = val;
    }

    upsertEventsFinderEvents([{ ...event, ...catalogPatch }], process.env);
    const updated = getEventsFinderEventById(id);

    /** Keep notable flag; clear override keys that were refreshed when force. */
    let nextNotable = notable;
    if (notable?.notable || req.body?.keepNotable !== false) {
      /** @type {Record<string, unknown>} */
      const nPatch = { notable: true };
      if (force) {
        nPatch.overrides = {};
        nPatch.manualEdit = false;
      }
      if (scraped.priceLabel && (!notable?.ticketPrice || force)) {
        nPatch.ticketPrice = String(scraped.priceLabel).slice(0, 80);
      }
      nextNotable = await upsertNotableEvent(id, nPatch);
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      scraped: {
        title: scraped.title || null,
        start: scraped.start || null,
        end: scraped.end || null,
        venue: scraped.venue || scraped.location || null,
        city: scraped.city || null,
        priceLabel: scraped.priceLabel || null,
        url: scraped.url || safeUrl,
      },
      item: packItem(id, nextNotable),
      event: updated ? applyNotableToEvent(updated, nextNotable) : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
