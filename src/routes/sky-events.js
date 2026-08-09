import { Router } from 'express';
import {
  loadSkyCalendar,
  filterActiveEvents,
  filterSupermoonForHeroStrip,
} from '../lib/sky-events.js';
import { mergeGeomagneticStormGScale } from '../lib/geomagnetic-storm-merge.js';
import { mergeAuroraWithSwpc } from '../lib/swpc-aurora.js';
import { mergeNakedEyePlanetsWithComputed } from '../lib/naked-eye-planets.js';
import { planetIconUrl } from '../lib/planet-icons.js';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { mergeSightingHeadsUp } from '../lib/sky-sighting-heads-up.js';
import { mergeAircraftNearby } from '../lib/merge-aircraft-nearby.js';
import { sortSkyStripWithPlanetsFirst } from '../lib/sky-strip-order.js';
import { mergeEclipseHeadsUp } from '../lib/sky-eclipse-heads-up.js';

const HERO_TZ = 'America/Los_Angeles';

const router = Router();

/**
 * GET /api/sky-events?windowHours=24
 * Calendar + event types live in src/data/sky-events-calendar.json (server-side only).
 */
router.get('/', async (req, res) => {
  try {
    const wh = Number.parseInt(String(req.query.windowHours ?? '24'), 10);
    const windowHours = Number.isFinite(wh) ? Math.min(168, Math.max(1, wh)) : 24;
    const windowMs = windowHours * 60 * 60 * 1000;

    const data = await loadSkyCalendar();
    const now = new Date();
    const { lat, lon, zip } = await resolveDashboardWeatherLatLon();
    const locationLabel = (process.env.DASHBOARD_LOCATION_LABEL || '').trim() || 'Oakland, CA · 94608';

    let active = filterSupermoonForHeroStrip(
      filterActiveEvents(data.events, now, windowMs),
      now,
      HERO_TZ,
    );
    active = await mergeGeomagneticStormGScale(active, now, windowMs);

    const auroraLat = lat;
    const auroraLon = lon;
    active = await mergeAuroraWithSwpc(
      active,
      auroraLat,
      auroraLon,
      now,
      windowMs,
      HERO_TZ,
      locationLabel,
    );
    active = mergeNakedEyePlanetsWithComputed(
      active,
      auroraLat,
      auroraLon,
      now,
      windowMs,
      HERO_TZ,
    );
    active = mergeEclipseHeadsUp(active, data.events, now, windowMs);
    active = mergeSightingHeadsUp(active, data.events, now, windowMs, HERO_TZ, {
      lat,
      lon,
      zip,
      locationLabel,
    });
    active = await mergeAircraftNearby(active, now);
    active = sortSkyStripWithPlanetsFirst(active);

    const typeById = Object.fromEntries(
      (data.eventTypes || []).map((t) => [t.id, t]),
    );

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      now: now.toISOString(),
      windowHours,
      sources: data.sources || [],
      eventTypes: data.eventTypes || [],
      active: active.map((ev) => {
        const baseMeta = typeById[ev.type] || { id: ev.type, label: ev.type, icon: '' };
        let typeMeta = baseMeta;
        if (ev.type === 'planet' && typeof ev.planetKey === 'string') {
          const pk = ev.planetKey.toLowerCase().trim();
          const mapped = planetIconUrl(pk);
          const icon = mapped ?? baseMeta.icon;
          const label =
            typeof ev.planetLabel === 'string' && ev.planetLabel.trim() !== ''
              ? ev.planetLabel.trim()
              : baseMeta.label;
          typeMeta = { ...baseMeta, icon, label };
        } else if (ev.type === 'aircraft') {
          const forecastPatch =
            typeof ev.forecastUrl === 'string' && /^https?:\/\//i.test(ev.forecastUrl.trim())
              ? { forecastUrl: ev.forecastUrl.trim() }
              : {};
          typeMeta = { ...baseMeta, ...forecastPatch };
        }
        const rowForecastUrl =
          typeof ev.forecastUrl === 'string' && /^https?:\/\//i.test(ev.forecastUrl.trim())
            ? ev.forecastUrl.trim()
            : null;
        return {
          id: ev.id,
          type: ev.type,
          title: ev.title,
          startsAt: ev.startsAt,
          endsAt: ev.endsAt ?? null,
          peakAt: ev.peakAt ?? null,
          source: ev.source ?? null,
          detailLine: typeof ev.detailLine === 'string' ? ev.detailLine : null,
          headsUp: ev.headsUp === true,
          lookAzimuthDeg:
            Number.isFinite(ev.lookAzimuthDeg) ? ev.lookAzimuthDeg : null,
          licenseRequired: ev.licenseRequired === true,
          auroraLikelihood: ev.auroraLikelihood ?? null,
          planetKey: ev.type === 'planet' ? ev.planetKey ?? null : null,
          magnitude: ev.type === 'planet' && Number.isFinite(ev.magnitude) ? ev.magnitude : null,
          forecastUrl: rowForecastUrl,
          aircraftCategory: ev.type === 'aircraft' ? ev.aircraftCategory ?? null : null,
          aircraftMedicalHelicopter:
            ev.type === 'aircraft' ? ev.aircraftMedicalHelicopter === true : false,
          aircraftHelicopter: ev.type === 'aircraft' ? ev.aircraftHelicopter === true : false,
          typeMeta,
        };
      }),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
