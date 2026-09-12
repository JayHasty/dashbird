import { Router } from 'express';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import {
  isDashboardInDiabloTarantulaRegion,
  isWallYmdInTarantulaRecurrence,
  loadDiabloTarantulaSeasonConfig,
} from '../lib/diablo-tarantula-season.js';
import { wallYmdInTimeZone } from '../lib/yosemite-moonbow.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const off = String(process.env.EARTH_DIABLO_TARANTULA || '').trim() === '0';
    if (off) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, items: [] });
      return;
    }

    const cfg = await loadDiabloTarantulaSeasonConfig();
    if (!cfg?.recurrence) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, items: [], itemCount: 0 });
      return;
    }

    const timeZone = (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
    const now = new Date();
    const wallYmd = wallYmdInTimeZone(now, timeZone);

    const rawRad = process.env.TARANTULA_DIABLO_RADIUS_MI;
    const def = Number(cfg.radiusMilesDefault) || 60;
    const radiusMiles =
      rawRad != null && String(rawRad).trim() !== ''
        ? Math.min(120, Math.max(15, Number.parseFloat(String(rawRad))))
        : Math.min(120, Math.max(15, def));

    const { lat, lon } = await resolveDashboardWeatherLatLon();
    const inSeason = isWallYmdInTarantulaRecurrence(wallYmd, cfg.recurrence);
    const inRegion = isDashboardInDiabloTarantulaRegion({ lat, lon, cfg, radiusMiles });

    if (!inSeason || !inRegion) {
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.json({
        ok: true,
        timeZone,
        wallYmd,
        radiusMiles,
        inSeason,
        inRegion,
        itemCount: 0,
        items: [],
      });
      return;
    }

    const region = typeof cfg.regionLabel === 'string' && cfg.regionLabel.trim() !== '' ? cfg.regionLabel.trim() : 'Mount Diablo area';
    const rec = cfg.recurrence;
    const windowHuman = `Sep ${rec.startDay}–Oct ${rec.endDay}`;
    const detailLine = `${region}: male tarantulas often wander trails and roads during mating season (${windowHuman}).`;

    const ref =
      typeof cfg.referenceUrl === 'string' && /^https?:\/\//i.test(cfg.referenceUrl.trim())
        ? cfg.referenceUrl.trim()
        : 'https://www.ebparks.org/parks/mt_diablo';

    const items = [
      {
        earthType: 'diablo_tarantula_mating',
        label: 'Diablo tarantulas',
        detailLine,
        forecastUrl: ref,
        tarantula: {
          wallYmd,
          radiusMiles,
          recurrence: rec,
        },
      },
    ];

    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({
      ok: true,
      timeZone,
      wallYmd,
      radiusMiles,
      inSeason: true,
      inRegion: true,
      itemCount: items.length,
      items,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
