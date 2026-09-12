/**
 * Smoke: Kīlauea next-episode forecast must be a dated future window, not a past episode.
 * Usage: node scripts/smoke-kilauea-forecast.mjs
 */
import { parseNextEruptionForecast } from '../src/lib/kilauea-status.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const pausedToday = `HVO Kilauea YELLOW/ADVISORY - Kīlauea volcano is not erupting, as the summit eruption in Halemaʻumaʻu is paused. Reinflation has been minimal since the end of lava fountaining episode 54; more tilt data are needed to model the forecast window for the next episode. Episode 54 of the ongoing Halemaʻumaʻu eruption ended at 7:33 p.m. HST on August 25 after 9 hours of continuous lava fountaining. A detailed summary of lava fountaining episode 54 on August 25, 2026 can be found below.`;

{
  const now = new Date('2026-08-28T19:00:00Z');
  const r = parseNextEruptionForecast(pausedToday, now);
  assert(!r.hasForecast && !r.forecastWhen, `paused HVO text dated as ${r.forecastWhen}`);
}

{
  const now = new Date('2026-08-01T18:00:00Z');
  const r = parseNextEruptionForecast(
    'The current forecast window for episode 53 is between August 8 and August 14.',
    now,
  );
  assert(r.hasForecast && r.forecastWhen === 'Aug 8–14', `want Aug 8–14, got ${r.forecastWhen}`);
}

{
  const now = new Date('2026-08-20T18:00:00Z');
  const r = parseNextEruptionForecast(
    'The current forecast window for episode 53 is between August 8 and August 14.',
    now,
  );
  assert(!r.hasForecast, `expired Aug 8–14 window still active: ${r.forecastWhen}`);
}

{
  const now = new Date('2026-08-28T19:00:00Z');
  const r = parseNextEruptionForecast(
    'Another episode is likely. The current forecast is between September 3 and September 10.',
    now,
  );
  assert(r.hasForecast && r.forecastWhen === 'Sep 3–10', `want Sep 3–10, got ${r.forecastWhen}`);
}

{
  const now = new Date('2026-08-28T19:00:00Z');
  const r = parseNextEruptionForecast(
    'activity summary also available by phone: (808) 967-8862. Episode 54 ended on August 25. more data are needed to model the forecast window for the next episode.',
    now,
  );
  assert(!r.hasForecast, `boilerplate+ended date dated as ${r.forecastWhen}`);
}

console.log('smoke-kilauea-forecast: ok');
