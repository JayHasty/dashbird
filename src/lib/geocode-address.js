/**
 * Geocode a US street address (Nominatim) for rain alert / radar center.
 */
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/** @type {Map<string, { lat: number, lon: number, displayName: string }>} */
const cache = new Map();

/**
 * @param {string} query
 * @param {{ countrycodes?: string | null }} [opts]
 * @returns {Promise<{ lat: number, lon: number, displayName: string } | null>}
 */
export async function geocodeAddress(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const countrycodes =
    opts.countrycodes === null
      ? null
      : opts.countrycodes === undefined
        ? 'us'
        : String(opts.countrycodes || '').trim() || null;
  const key = `${q.toLowerCase()}|${countrycodes || 'world'}`;
  if (cache.has(key)) return cache.get(key);

  const url = new URL(NOMINATIM);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  if (countrycodes) url.searchParams.set('countrycodes', countrycodes);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Dashbird/1.0 (rain-alert geocode; local dashboard)',
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const hit = Array.isArray(rows) ? rows[0] : null;
    if (!hit) return null;
    const lat = Number.parseFloat(hit.lat);
    const lon = Number.parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const out = {
      lat,
      lon,
      displayName: typeof hit.display_name === 'string' ? hit.display_name : q,
    };
    cache.set(key, out);
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
