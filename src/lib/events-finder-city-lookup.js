/**
 * Online city lookup for Big Events when scrape/research left `city` empty.
 * Uses Chrome web search + optional OpenRouter JSON extract, then Nominatim geocode.
 */
import { searchChromeResultUrls } from './chrome-web-search.js';
import { geocodeAddress } from './geocode-address.js';
import { openRouterChatJson } from './openrouter-chat-json.js';
import { assertPublicHttpUrl } from './public-http-url.js';

const FETCH_UA = 'Dashbird/1.0 (events city lookup; local dashboard)';

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchPageText(url) {
  let safe;
  try {
    safe = await assertPublicHttpUrl(url);
  } catch {
    return '';
  }
  try {
    const r = await fetch(safe, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': FETCH_UA },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return '';
    const html = await r.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12_000);
  } catch {
    return '';
  }
}

/**
 * Pull a plausible "City, ST" from free text.
 * @param {string} text
 * @returns {string | null}
 */
function heuristicCityFromText(text) {
  const t = String(text || '');
  const patterns = [
    /\b(?:held|taking place|located|venue|happening)\s+in\s+([A-Z][a-zA-Z .'-]{2,40}(?:,\s*[A-Z]{2})?)\b/,
    /\b([A-Z][a-zA-Z .'-]{2,40},\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY))\b/,
    /\b([A-Z][a-zA-Z .'-]{2,40},\s*(?:United States|USA|Canada|UK|England|Germany|France|Japan|Australia|Mexico|Spain|Italy))\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m?.[1]) continue;
    const city = String(m[1]).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (city.length >= 3 && !/^(the|this|our|event|conference|festival)$/i.test(city)) {
      return city;
    }
  }
  return null;
}

/**
 * @param {{
 *   name?: string | null,
 *   query?: string | null,
 *   venue?: string | null,
 *   url?: string | null,
 *   year?: number | null,
 * }} event
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{
 *   city: string | null,
 *   lat: number | null,
 *   lon: number | null,
 *   source: string | null,
 *   displayName: string | null,
 * }>}
 */
export async function lookupEventCityOnline(event, env = process.env) {
  const name = String(event?.name || event?.query || '').trim();
  const venue = String(event?.venue || '').trim();
  const year = Number(event?.year) > 1900 ? Number(event.year) : new Date().getFullYear();
  if (!name && !venue) {
    return { city: null, lat: null, lon: null, source: null, displayName: null };
  }

  const queries = [
    venue ? `${venue} city location` : null,
    name ? `"${name}" ${year} city location venue` : null,
    name ? `${name} where is it held city` : null,
    name && venue ? `${name} ${venue}` : null,
  ].filter(Boolean);

  /** @type {string[]} */
  const snippets = [];
  if (venue) snippets.push(`Venue: ${venue}`);

  for (const q of queries.slice(0, 3)) {
    const urls = await searchChromeResultUrls(q, 5, env).catch(() => []);
    for (const u of urls.slice(0, 3)) {
      const text = await fetchPageText(u);
      if (text.length > 80) snippets.push(`${u}\n${text.slice(0, 2500)}`);
      if (snippets.length >= 5) break;
    }
    if (snippets.length >= 4) break;
  }

  let city = heuristicCityFromText(snippets.join('\n'));
  let source = city ? 'heuristic' : null;

  if (!city && snippets.length) {
    const ai = await openRouterChatJson(
      env,
      [
        {
          role: 'system',
          content:
            'Extract the host city for an event from search snippets. Reply JSON only: {"city":"City, ST or City, Country"|null}. Prefer the city where the event is held, not organizer HQ. If unknown, city null.',
        },
        {
          role: 'user',
          content: `Event: ${name || '(unknown)'}\nVenue hint: ${venue || '(none)'}\n\nSnippets:\n${snippets.join('\n---\n').slice(0, 9000)}`,
        },
      ],
      { xTitle: 'dashbird-events-city-lookup', maxTokens: 200, timeoutMs: 45_000 },
    );
    if (ai.ok && ai.parsed && typeof ai.parsed === 'object') {
      const c = String(/** @type {Record<string, unknown>} */ (ai.parsed).city || '')
        .trim()
        .slice(0, 80);
      if (c && c.toLowerCase() !== 'null') {
        city = c;
        source = 'openrouter';
      }
    }
  }

  if (!city) {
    return { city: null, lat: null, lon: null, source: null, displayName: null };
  }

  const geo = await geocodeAddress(city, { countrycodes: null }).catch(() => null);
  return {
    city,
    lat: geo?.lat ?? null,
    lon: geo?.lon ?? null,
    source,
    displayName: geo?.displayName ?? city,
  };
}
