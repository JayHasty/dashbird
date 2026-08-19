/**
 * Brave Search API (HTTP/JSON) — a keyless-from-datacenter search source.
 *
 * The headless-Chrome scrapers in chrome-web-search.js work great from a home
 * IP but can't run on the slim cloud image (no Chromium) and get bot-challenged
 * from datacenter IPs. This official API returns real Brave results over plain
 * HTTPS, so the cloud (Vultr / jayhasty.com) can discover event URLs and fliers
 * without a browser. Free tier ≈ 2k queries/month.
 *
 * Set BRAVE_SEARCH_API_KEY (subscription token) to enable. When unset, every
 * function is a no-op so LAN keeps using the free headless-Chrome path.
 */
const WEB_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const IMAGE_ENDPOINT = 'https://api.search.brave.com/res/v1/images/search';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function apiKey(env = process.env) {
  return String(env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY || '').trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function braveApiEnabled(env = process.env) {
  return apiKey(env).length > 0;
}

/**
 * @param {string} url
 * @param {string} key
 * @returns {Promise<any | null>}
 */
async function getJson(url, key) {
  try {
    const r = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key,
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) {
      console.warn('[brave-search-api] HTTP', r.status, url.slice(0, 80));
      return null;
    }
    return await r.json();
  } catch (e) {
    console.warn('[brave-search-api] request failed', String(e?.message || e).slice(0, 160));
    return null;
  }
}

/**
 * Web search → ranked result URLs + titles (+ description when Brave provides it).
 * @param {string} query
 * @param {number} [limit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{ url: string, title: string, description: string }>>}
 */
export async function braveApiWebSearch(query, limit = 8, env = process.env) {
  const key = apiKey(env);
  const q = String(query || '').trim();
  if (!key || !q) return [];
  const count = Math.max(1, Math.min(20, Number(limit) || 8));
  const url = `${WEB_ENDPOINT}?q=${encodeURIComponent(q)}&count=${count}&country=US&safesearch=off`;
  const data = await getJson(url, key);
  const results = data?.web?.results;
  if (!Array.isArray(results)) return [];
  /** @type {Array<{ url: string, title: string, description: string }>} */
  const out = [];
  for (const r of results) {
    const u = String(r?.url || '').trim();
    if (!/^https?:\/\//i.test(u)) continue;
    if (out.some((x) => x.url === u)) continue;
    out.push({
      url: u,
      title: String(r?.title || ''),
      description: String(r?.description || '').trim().slice(0, 500),
    });
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Image search → candidate image URLs (with page + thumbnail when available).
 * @param {string} query
 * @param {number} [limit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{ url: string, thumbUrl: string | null, pageUrl: string | null }>>}
 */
export async function braveApiImageSearch(query, limit = 10, env = process.env) {
  const key = apiKey(env);
  const q = String(query || '').trim();
  if (!key || !q) return [];
  const count = Math.max(1, Math.min(50, Number(limit) || 10));
  const url = `${IMAGE_ENDPOINT}?q=${encodeURIComponent(q)}&count=${count}&country=US&safesearch=off`;
  const data = await getJson(url, key);
  const results = data?.results;
  if (!Array.isArray(results)) return [];
  /** @type {Array<{ url: string, thumbUrl: string | null, pageUrl: string | null }>} */
  const out = [];
  for (const r of results) {
    const img = String(r?.properties?.url || r?.thumbnail?.src || '').trim();
    if (!/^https?:\/\//i.test(img)) continue;
    if (out.some((x) => x.url === img)) continue;
    const thumb = String(r?.thumbnail?.src || '').trim();
    const page = String(r?.url || '').trim();
    out.push({
      url: img,
      thumbUrl: /^https?:\/\//i.test(thumb) ? thumb : null,
      pageUrl: /^https?:\/\//i.test(page) ? page : null,
    });
    if (out.length >= count) break;
  }
  return out;
}
