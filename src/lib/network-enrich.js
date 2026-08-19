/**
 * Enrich Network contacts and organizations from public web pages via OpenRouter.
 * Only fills empty fields unless force=true. No tag taxonomy — freeform summary words only.
 */
import { randomUUID } from 'node:crypto';
import {
  getContactById,
  newContactTaskId,
  saveContactAvatar,
  saveNetworkAsset,
  updateContact,
} from './network-contacts-store.js';
import {
  ensureOrganizationByName,
  getOrganizationById,
  updateOrganization,
} from './network-organizations-store.js';
import { fetchOrgFirmographics } from './network-firmographics.js';
import {
  applyQrFactsToContactPatch,
  decodeContactQrFromImage,
} from './network-qr-decode.js';
import { assertPublicHttpUrl, looksLikePublicHttpUrl } from './public-http-url.js';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// #region agent log
async function agentDbgEnrich(payload) {
  const body = {
    sessionId: '951c32',
    runId: 'post-fix',
    timestamp: Date.now(),
    ...payload,
  };
  try {
    const p = path.resolve(process.cwd(), 'data/debug-951c32.ndjson');
    await mkdir(path.dirname(p), { recursive: true });
    await appendFile(p, `${JSON.stringify(body)}\n`, 'utf8');
  } catch {
    /* ignore */
  }
  for (const url of [
    'http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22',
    'http://172.17.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22',
  ]) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '951c32' },
      body: JSON.stringify(body),
    }).catch(() => {});
  }
}
// #endregion

const CONTACT_ENRICH_SYSTEM = `You extract profile facts for a personal CRM contact from the provided source material.
Return JSON only:
{
  "bio": string | null,
  "org": string | null,
  "title": string | null,
  "department": string | null,
  "location": string | null,
  "address": string | null,
  "rating": "Fan" | "Hot" | "Warm" | "Cold" | null,
  "relationshipStatus": "Lead" | "Cultivating" | "Collaborator" | "Family" | "Inner Circle" | "Acquaintance" | "Meta" | "Paused" | "Former" | null,
  "nextStep": string | null,
  "howWeMet": string | null,
  "notes": string | null,
  "networkCircles": string | null,
  "linkedin": string | null,
  "email": string | null,
  "phone": string | null,
  "officePhone": string | null,
  "nickname": string | null,
  "aliases": string[],
  "urls": string[],
  "avatarImageUrl": string | null,
  "confidence": number
}
Rules:
- Only include facts supported by the source material (web pages, emails, files, or spoken notes). Prefer null over guesses.
- Do not invent private details (home address, unpublished phone/email) unless the source explicitly contains them.
- bio: short bio plus space-separated keywords/phrases useful for later search (no hashtags).
- howWeMet / notes / networkCircles: pull relationship context when the source mentions it (especially voice notes or emails).
- nextStep: concrete follow-ups if mentioned.
- aliases: other names clearly referring to this person (maiden names, former names). Prefer nickname for the everyday short name.
- nickname: the primary short name / moniker they go by day-to-day (e.g. "Jay" for Julia), if clearly stated; else null.
- title: role / job title when stated.
- department: team or department when stated.
- location: city / area freeform when known.
- address: full mailing / street / P.O. Box address when explicitly present; keep separate from location.
- rating / relationshipStatus: only when clearly implied; else null. Prefer null over guessing "Hot" or "Fan". Fan is higher than Hot (closest / strongest fans).
- avatarImageUrl: direct image URL of a headshot if present; else null.
- urls: public profile / personal site links only. Never include Telegram / t.me / telegram.org links.
- If the image is a business card with a QR code and the URL is printed next to it (or otherwise readable as text), include that URL in urls or linkedin. Do not invent a URL from an unread QR.
- confidence: 0-1.`;

const ORG_ENRICH_SYSTEM = `You extract public facts about an organization for a personal CRM.
Return JSON only:
{
  "description": string | null,
  "summary": string | null,
  "website": string | null,
  "location": string | null,
  "region": string | null,
  "type": "Prospect" | "Customer" | "Partner" | "Subcontractor" | "Vendor" | "Supplier" | "Competitor" | "Other" | null,
  "industry": string | null,
  "ownership": string | null,
  "accountSource": string | null,
  "rating": "Fan" | "Hot" | "Warm" | "Cold" | null,
  "annualRevenue": string | null,
  "employeeCount": string | null,
  "fiscalYearEnd": string | null,
  "competitiveNotes": string | null,
  "phone": string | null,
  "email": string | null,
  "linkedin": string | null,
  "socialUrls": string[],
  "locale": string | null,
  "partnerRelationships": string | null,
  "lifecycleStatus": "Prospect" | "Qualified" | "Customer" | "Churned" | null,
  "nextStep": string | null,
  "aliases": string[],
  "urls": string[],
  "logoImageUrl": string | null,
  "people": [
    {
      "name": string,
      "title": string | null,
      "linkedin": string | null
    }
  ],
  "confidence": number
}
Rules:
- Prefer facts from the page excerpts.
- summary: space-separated keywords/phrases for later LLM search (industry, products, geography).
- website: canonical public homepage if known.
- region: geographic market / territory / HQ region when known.
- location: city/HQ freeform when known.
- industry, ownership, phone, email, linkedin: only when clearly public.
- annualRevenue / employeeCount: only when publicly stated on the pages; leave null if unknown — do not invent (structured Wikidata/SEC data is merged separately).
- socialUrls: other public social profile URLs (not LinkedIn, not Telegram / t.me).
- urls: public site links only — never Telegram / t.me / telegram.org.
- people: notable public people clearly associated with this organization (founders, executives, team page names). Prefer real full names; include title/role when stated. Cap at 20. Omit if none found.
- logoImageUrl: direct image URL of the company logo / brand mark if present among page images; prefer a square icon / symbol mark over full wordmarks that include company-name text, photos, or banners; else null.
- Do not invent private internal details or people not supported by the excerpts.
- confidence: 0-1.`;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function openRouterKey(env = process.env) {
  return String(env.OPENROUTER_API_KEY || '').trim();
}

/** Free-tier-safe defaults (paid gpt-4o-mini 402s when OpenRouter credits are empty). */
const DEFAULT_TEXT_MODEL = 'openai/gpt-oss-20b:free';
/** Keep the chain short — free models often sit until timeout; long chains freeze the wait cursor. */
const TEXT_FALLBACK_MODELS = [
  'openai/gpt-oss-20b:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'openai/gpt-4o-mini',
];
const DEFAULT_VISION_MODEL = 'google/gemma-4-26b-a4b-it:free';
const VISION_FALLBACK_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
];

/** Wall-clock budget for one enrich-from-web run (search + pages + LLM + images). */
const ENRICH_WALL_MS = 90_000;
const OPENROUTER_PRIMARY_TIMEOUT_MS = 45_000;
const OPENROUTER_FALLBACK_TIMEOUT_MS = 25_000;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function textModel(env = process.env) {
  return String(
    env.NETWORK_ENRICH_MODEL || env.OPENROUTER_FREE_TEXT_MODEL || env.OPENROUTER_MODEL || DEFAULT_TEXT_MODEL,
  ).trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function visionModel(env = process.env) {
  return String(
    env.NETWORK_ENRICH_VISION_MODEL || env.OPENROUTER_FREE_VISION_MODEL || DEFAULT_VISION_MODEL,
  ).trim();
}

/**
 * @param {string} primary
 * @param {string[]} fallbacks
 */
function modelChain(primary, fallbacks) {
  return [...new Set([String(primary || '').trim(), ...fallbacks].filter(Boolean))];
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function openRouterHeaders(env = process.env) {
  return {
    Authorization: `Bearer ${openRouterKey(env)}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
    'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-network-enrich',
  };
}

/**
 * Chat completion with max_tokens cap + free-model fallback on HTTP 402.
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   models?: string[],
 *   messages: object[],
 *   temperature?: number,
 *   maxTokens?: number,
 *   timeoutMs?: number,
 *   deadlineAt?: number,
 * }} args
 * @returns {Promise<{ ok: true, content: string, model: string } | { ok: false, error: string, detail?: string }>}
 */
async function openRouterChatJson(args) {
  const env = args.env || process.env;
  const models = [...new Set((args.models || []).map((m) => String(m || '').trim()).filter(Boolean))];
  if (!models.length) return { ok: false, error: 'no_model' };
  const maxTokens = Math.max(64, Math.min(8192, Number(args.maxTokens) || 4096));
  const deadlineAt =
    typeof args.deadlineAt === 'number' && Number.isFinite(args.deadlineAt) ? args.deadlineAt : null;
  let lastError = 'openrouter_failed';
  let lastDetail = '';

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    if (deadlineAt != null && Date.now() >= deadlineAt) {
      lastError = 'enrich_timeout';
      break;
    }
    const defaultTimeout =
      i === 0 ? OPENROUTER_PRIMARY_TIMEOUT_MS : OPENROUTER_FALLBACK_TIMEOUT_MS;
    let timeoutMs = Math.max(5_000, Number(args.timeoutMs) || defaultTimeout);
    if (deadlineAt != null) {
      timeoutMs = Math.min(timeoutMs, Math.max(3_000, deadlineAt - Date.now()));
    }
    let r;
    try {
      r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: openRouterHeaders(env),
        body: JSON.stringify({
          model,
          temperature: args.temperature ?? 0.2,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: args.messages,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastError = String(e?.message || e);
      continue;
    }
    if (!r.ok) {
      lastDetail = await r.text().catch(() => '');
      lastError = `openrouter_http_${r.status}`;
      if (r.status === 401 || r.status === 403) break;
      if (r.status === 404) continue;
      if (r.status === 429) {
        // Shared free pools: one short wait, then stop the chain (do not fan out).
        const ra = Number(r.headers.get('retry-after'));
        const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(Math.max(ra, 2), 30) * 1000 : 2000;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        break;
      }
      if (r.status === 402 || r.status >= 500) continue;
      break;
    }
    const j = await r.json().catch(() => ({}));
    const content = j?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      return { ok: true, content, model: String(j?.model || model) };
    }
    lastError = 'empty_completion';
  }

  return { ok: false, error: lastError, detail: lastDetail.slice(0, 400) };
}

/**
 * @param {string} text
 */
function extractJsonObject(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param {string} href
 * @param {string} [baseUrl]
 */
function resolveAbsUrl(href, baseUrl = '') {
  const s = String(href || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (!s || s.startsWith('data:')) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (!baseUrl) return '';
  try {
    return new URL(s, baseUrl).href;
  } catch {
    return '';
  }
}

/**
 * Pull likely headshot / logo URLs from HTML before tags are stripped.
 * Icons are appended last so contact avatar fallbacks still prefer og/img first.
 * @param {string} html
 * @param {string} [baseUrl]
 * @returns {string[]}
 */
function extractImageUrlsFromHtml(html, baseUrl = '') {
  const raw = String(html || '');
  /** @type {string[]} */
  const out = [];
  const push = (u) => {
    const s = resolveAbsUrl(u, baseUrl);
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (/\.svg(\?|$)/i.test(s)) return;
    if (/sprite|pixel|tracking|1x1|blank\.(gif|png)/i.test(s)) return;
    if (!out.includes(s)) out.push(s);
  };

  const og =
    raw.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    raw.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og) push(og[1]);

  const twitter =
    raw.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
    raw.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (twitter) push(twitter[1]);

  // Prefer <img> tags that look like logos before generic images.
  /** @type {string[]} */
  const logoImgs = [];
  /** @type {string[]} */
  const otherImgs = [];
  const imgRe = /<img\b([^>]*)>/gi;
  let m;
  while ((m = imgRe.exec(raw)) && logoImgs.length + otherImgs.length < 16) {
    const attrs = m[1] || '';
    const src =
      attrs.match(/\s(?:src|data-src)=["']([^"']+)["']/i)?.[1] ||
      attrs.match(/\s(?:src|data-src)=([^\s>]+)/i)?.[1];
    if (!src) continue;
    const blob = `${src} ${attrs}`;
    if (/logo|brand|wordmark|site-icon/i.test(blob)) logoImgs.push(src);
    else otherImgs.push(src);
  }
  for (const src of logoImgs) push(src);
  for (const src of otherImgs) push(src);

  // Site icons (apple-touch / favicon) — useful for org logos, low priority for contacts.
  const iconRe = /<link\b([^>]*rel=["'][^"']*icon[^"']*["'][^>]*)>/gi;
  while ((m = iconRe.exec(raw))) {
    const tag = m[1] || '';
    const href = tag.match(/\shref=["']([^"']+)["']/i)?.[1];
    if (href) push(href);
  }

  return out;
}

/**
 * Score image URLs for logo-likeness (square brand marks over banners/photos).
 * @param {string} url
 */
function scoreLogoUrl(url) {
  const u = String(url || '').toLowerCase();
  let score = 0;
  if (/logo|brand|mark|apple-touch|site-icon/i.test(u)) score += 12;
  if (/icon|favicon|symbol|glyph|logomark/i.test(u)) score += 6;
  if (/wordmark|lockup|horizontal[-_]?logo|logo[-_]?text/i.test(u)) score -= 8;
  if (/clearbit\.com\/|google\.com\/s2\/favicons/i.test(u)) score += 8;
  if (/banner|hero|cover|og-image|social[-_]?share|screenshot|photo|portrait|team|people|headshot/i.test(u)) {
    score -= 6;
  }
  if (/sprite|pixel|tracking|1x1/i.test(u)) score -= 20;
  return score;
}

/**
 * @param {string[]} urls
 * @returns {string[]}
 */
function prioritizeLogoUrls(urls) {
  return [...new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean))].sort(
    (a, b) => scoreLogoUrl(b) - scoreLogoUrl(a),
  );
}

/**
 * Clearbit-style logo CDN when we know a website host.
 * @param {string} website
 * @returns {string | null}
 */
function clearbitLogoUrl(website) {
  try {
    const host = new URL(String(website || '').trim()).hostname.replace(/^www\./i, '');
    if (!host || host.includes('duckduckgo.com') || host.includes('linkedin.com')) return null;
    return `https://logo.clearbit.com/${host}`;
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 */
async function fetchPageText(url) {
  let safeUrl;
  try {
    // SSRF guard: reject private/link-local/metadata targets before any network I/O.
    // Untrusted page content reaches the enrich prompt, so the model (or a caller-supplied
    // fetchUrls value) must never be able to make the server hit internal addresses.
    safeUrl = await assertPublicHttpUrl(url);
  } catch {
    return { url, ok: false, text: '', imageUrls: [] };
  }
  try {
    const r = await fetch(safeUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; DashbirdNetworkEnrich/1.0; +https://localhost)',
      },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return { url, ok: false, text: '', imageUrls: [] };
    const ct = String(r.headers.get('content-type') || '');
    if (!ct.includes('text') && !ct.includes('json') && !ct.includes('html')) {
      return { url, ok: false, text: '', imageUrls: [] };
    }
    const raw = await r.text();
    const imageUrls = extractImageUrlsFromHtml(raw, url);
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12_000);
    return { url, ok: true, text, imageUrls };
  } catch {
    return { url, ok: false, text: '', imageUrls: [] };
  }
}

/**
 * Image search for enrich / avatar picker — Chrome (Brave/Bing Images) first, DuckDuckGo fallback.
 * @param {string} query
 * @param {number} [limit]
 * @param {{ preferSquare?: boolean }} [opts]
 * @returns {Promise<{ url: string, thumbUrl: string | null, pageUrl: string | null }[]>}
 */
export async function searchDuckDuckGoImageResults(query, limit = 10, opts = {}) {
  try {
    const { searchGoogleImageResults } = await import('./chrome-web-search.js');
    const chromeHits = await searchGoogleImageResults(query, limit, opts);
    if (chromeHits.length) return chromeHits;
  } catch (e) {
    console.warn('[network-enrich] chrome image search failed', String(e?.message || e).slice(0, 120));
  }
  // Brave image API — works from a datacenter IP / the slim cloud image (no browser).
  try {
    const { braveApiEnabled, braveApiImageSearch } = await import('./brave-search-api.js');
    if (braveApiEnabled()) {
      const api = await braveApiImageSearch(query, limit);
      if (api.length) return api;
    }
  } catch (e) {
    console.warn('[network-enrich] brave api image search failed', String(e?.message || e).slice(0, 120));
  }
  return searchDuckDuckGoImageResultsLegacy(query, limit, opts);
}

/**
 * DuckDuckGo image search (unofficial i.js) — fallback when Chrome search returns nothing.
 * @param {string} query
 * @param {number} [limit]
 * @param {{ preferSquare?: boolean }} [opts]
 * @returns {Promise<{ url: string, thumbUrl: string | null, pageUrl: string | null }[]>}
 */
async function searchDuckDuckGoImageResultsLegacy(query, limit = 10, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const preferSquare = Boolean(opts.preferSquare);
  const ua =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  try {
    const home = await fetch('https://duckduckgo.com/', {
      method: 'POST',
      headers: {
        'User-Agent': ua,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ q }),
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    const html = await home.text();
    const vqdMatch =
      html.match(/vqd=["']([^"']+)["']/) ||
      html.match(/vqd=([\d-]+)/) ||
      html.match(/vqd\\?":\\?"([^"\\]+)/);
    const vqd = vqdMatch?.[1];
    if (!vqd) return [];

    const params = new URLSearchParams({
      l: 'us-en',
      o: 'json',
      q,
      vqd,
      f: ',,,',
      p: '1',
    });
    const imgRes = await fetch(`https://duckduckgo.com/i.js?${params}`, {
      headers: {
        'User-Agent': ua,
        Accept: 'application/json',
        Referer: 'https://duckduckgo.com/',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!imgRes.ok) return [];
    const data = await imgRes.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    /** @type {{ url: string, thumbUrl: string | null, pageUrl: string | null, score: number }[]} */
    const out = [];
    for (const row of results) {
      const image = String(row?.image || '').trim() || String(row?.url || '').trim();
      const pageRaw = String(row?.url || '').trim();
      const thumb = String(row?.thumbnail || '').trim();
      const w = Number(row?.width) || 0;
      const h = Number(row?.height) || 0;
      if (w && h && (w < 80 || h < 80)) continue;
      if (preferSquare && w && h) {
        const ratio = w / h;
        // Skip obvious banners / tall photos when looking for logos.
        if (ratio > 2.8 || ratio < 0.35) continue;
      }
      if (!image || !/^https?:\/\//i.test(image)) continue;
      if (out.some((x) => x.url === image)) continue;
      // DDG `url` is the hosting page when `image` is the direct asset URL.
      const pageUrl =
        pageRaw &&
        /^https?:\/\//i.test(pageRaw) &&
        pageRaw !== image &&
        !/duckduckgo\.com/i.test(pageRaw)
          ? pageRaw
          : null;
      let score = scoreLogoUrl(image);
      if (preferSquare && w && h) {
        const ratio = w / h;
        if (ratio >= 0.75 && ratio <= 1.35) score += 5;
        else if (ratio >= 0.5 && ratio <= 2) score += 2;
      }
      out.push({
        url: image,
        thumbUrl: thumb && /^https?:\/\//i.test(thumb) ? thumb : null,
        pageUrl,
        score,
      });
      if (out.length >= Math.max(limit * 2, limit)) break;
    }
    if (preferSquare) out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit).map(({ url, thumbUrl, pageUrl }) => ({ url, thumbUrl, pageUrl }));
  } catch {
    return [];
  }
}

/**
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<string[]>}
 */
export async function searchDuckDuckGoImages(query, limit = 10) {
  const rows = await searchDuckDuckGoImageResults(query, limit);
  return rows.map((r) => r.url);
}

/**
 * @param {string[]} urls
 * @param {string} id
 * @param {string} kind
 * @param {NodeJS.ProcessEnv} [env]
 */
async function tryDownloadFirstImage(urls, id, kind, env = process.env) {
  for (const url of urls || []) {
    const saved = await tryDownloadImage(url, id, kind, env);
    if (saved) return saved;
  }
  return null;
}

/**
 * @param {string[]} urls
 */
async function fetchPages(urls) {
  const candidates = (urls || [])
    .filter((u) => u && !/duckduckgo\.com/i.test(String(u)))
    .slice(0, 6);
  if (!candidates.length) return [];
  const settled = await Promise.all(candidates.map((url) => fetchPageText(url)));
  return settled.filter((page) => page.ok && page.text);
}

/**
 * Scene tokens that can disambiguate web search. Everything else is local/private
 * and must not be sent to DuckDuckGo.
 * @type {Readonly<Record<string, string>>} compact key → query phrase
 */
const ENRICH_SEARCHABLE_SCENES = Object.freeze({
  burningman: 'Burning Man',
  climate: 'climate',
  makerfarm: 'Maker Farm',
});

/**
 * Map a scene/circle token to an enrich-searchable key, or null if it must be ignored.
 * @param {string} token
 * @returns {keyof typeof ENRICH_SEARCHABLE_SCENES | null}
 */
export function enrichSearchableSceneKey(token) {
  const raw = String(token || '').trim().toLowerCase();
  if (!raw) return null;
  const compact = raw.replace(/[^a-z0-9]+/g, '');
  if (!compact) return null;
  if (compact === 'burningman' || compact.startsWith('burningman')) return 'burningman';
  if (compact === 'climate' || compact.startsWith('climate')) return 'climate';
  if (
    compact === 'makerfarm' ||
    compact === 'makerfare' ||
    compact === 'makerfaire' ||
    compact.startsWith('makerfarm') ||
    compact.startsWith('makerfare') ||
    compact.startsWith('makerfaire')
  ) {
    return 'makerfarm';
  }
  return null;
}

/**
 * Search phrases derived from networkCircles — only Burning Man / climate / Maker Farm.
 * @param {unknown} networkCircles
 * @returns {string[]}
 */
export function enrichSearchableSceneQueries(networkCircles) {
  /** @type {string[]} */
  const out = [];
  const parts = String(networkCircles || '')
    .split(/[,;|/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const key = enrichSearchableSceneKey(part);
    if (!key) continue;
    const phrase = ENRICH_SEARCHABLE_SCENES[key];
    if (phrase && !out.includes(phrase)) out.push(phrase);
  }
  return out.slice(0, 3);
}

/**
 * Build progressive web-search queries from the newest card fields.
 * Each enrich click should use whatever is currently on the contact.
 * @param {object} contact
 * @returns {string[]}
 */
/**
 * Aligned-activity phrases safe to use in web search (from the contact card).
 * @param {unknown} alignedActivities
 * @returns {string[]}
 */
export function enrichActivitySearchPhrases(alignedActivities) {
  const raw = Array.isArray(alignedActivities) ? alignedActivities : [];
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    const s = String(item || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (!s || s.length < 2) continue;
    if (/\btelegram\b|t\.me\b|telegram\.(?:me|org|dog)/i.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}

export function contactSearchQueries(contact) {
  const name = String(contact?.displayName || '').trim();
  const org = String(contact?.org || '').trim();
  const title = String(contact?.title || '').trim();
  const location = String(contact?.location || '').trim();
  // Only Burning Man / climate / Maker Farm scenes are worth searching; skip APL, houses, etc.
  const circleBits = enrichSearchableSceneQueries(contact?.networkCircles);
  const activityBits = enrichActivitySearchPhrases(contact?.alignedActivities);
  const aliases = (contact?.aliases || [])
    .map((a) => String(a || '').trim())
    .filter(Boolean)
    .slice(0, 4);
  const bioBits = String(contact?.bio || contact?.summary || '')
    .replace(/[^\p{L}\p{N}\s\-']/gu, ' ')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((w) => w.length >= 4 && !/^(telegram|t\.me)$/i.test(w))
    .slice(0, 8);
  const place = location;
  const nameTokens = name.split(/\s+/).filter(Boolean);
  const shortName = nameTokens.length === 1;

  /** @type {string[]} */
  const queries = [];
  const pushQ = (q) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2) return;
    // Never run Telegram-targeted searches.
    if (/\btelegram\b|t\.me\b|telegram\.(?:me|org|dog)/i.test(s)) return;
    if (!queries.includes(s)) queries.push(s);
  };
  // Short nicknames ("Bear") match animals/restaurants in DDG — prioritize person profiles first.
  // discoverUrlsFromQueries only runs the first few queries, so LinkedIn must be early.
  if (name && shortName) {
    pushQ(`site:linkedin.com/in "${name}"`);
    if (org) pushQ(`"${name}" ${org}`);
    if (circleBits[0]) pushQ(`"${name}" ${circleBits[0]}`);
    if (circleBits[1]) pushQ(`"${name}" ${circleBits[1]}`);
    for (const act of activityBits.slice(0, 3)) pushQ(`"${name}" ${act}`);
    pushQ(`"${name}" person`);
    if (place) pushQ(`"${name}" ${place}`);
    pushQ(`site:facebook.com "${name}"`);
    if (title) pushQ(`"${name}" ${title}`);
  } else if (name) {
    pushQ(`"${name}"`);
    if (org) pushQ(`"${name}" ${org}`);
    pushQ(`site:linkedin.com/in "${name}"`);
    if (title) pushQ(`"${name}" ${title}`);
    if (place) pushQ(`"${name}" ${place}`);
    if (circleBits[0]) pushQ(`"${name}" ${circleBits[0]}`);
    for (const act of activityBits.slice(0, 4)) pushQ(`"${name}" ${act}`);
    pushQ(`site:facebook.com "${name}"`);
  }
  if (name && bioBits.length) pushQ(`"${name}" ${bioBits.slice(0, 4).join(' ')}`);
  for (const a of aliases) {
    pushQ(`"${a}"`);
    if (org) pushQ(`"${a}" ${org}`);
    if (shortName) pushQ(`site:linkedin.com/in "${a}"`);
  }
  if (name && org) pushQ(`"${name}" "${org}" linkedin`);
  // Remaining activities after the early slots (preview can still uncheck them).
  if (name) {
    for (const act of activityBits) pushQ(`"${name}" ${act}`);
  }
  return queries.slice(0, 16);
}

/**
 * @param {object} org
 * @returns {string[]}
 */
export function orgSearchQueries(org) {
  const name = String(org?.name || '').trim();
  const industry = String(org?.industry || '').trim();
  const location = String(org?.location || org?.region || '').trim();
  const summaryBits = String(org?.summary || org?.description || '')
    .replace(/[^\p{L}\p{N}\s\-']/gu, ' ')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((w) => w.length >= 4 && !/^(telegram|t\.me)$/i.test(w))
    .slice(0, 6);
  /** @type {string[]} */
  const queries = [];
  const pushQ = (q) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2) return;
    if (/\btelegram\b|t\.me\b|telegram\.(?:me|org|dog)/i.test(s)) return;
    if (!queries.includes(s)) queries.push(s);
  };
  if (name) pushQ(`"${name}" company`);
  if (name && industry) pushQ(`"${name}" ${industry}`);
  if (name && location) pushQ(`"${name}" ${location}`);
  if (name && summaryBits.length) pushQ(`"${name}" ${summaryBits.slice(0, 4).join(' ')}`);
  if (name) pushQ(`site:linkedin.com/company "${name}"`);
  return queries.slice(0, 8);
}

/**
 * Pull outbound result URLs — Chrome (Brave Search) first, DuckDuckGo HTML fallback.
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<string[]>}
 */
async function searchWebResultUrls(query, limit = 6) {
  try {
    const { searchGoogleResultUrls } = await import('./chrome-web-search.js');
    const chromeHits = await searchGoogleResultUrls(query, limit);
    if (chromeHits.length) {
      return chromeHits.filter((u) => !isLikelyNonPersonEnrichUrl(u)).slice(0, limit);
    }
  } catch (e) {
    console.warn('[network-enrich] chrome web search failed', String(e?.message || e).slice(0, 120));
  }
  // Brave Search API — reliable from a datacenter IP / the slim cloud image where
  // headless Chrome can't run. Only used when the browser path came up empty.
  try {
    const { braveApiEnabled, braveApiWebSearch } = await import('./brave-search-api.js');
    if (braveApiEnabled()) {
      const api = await braveApiWebSearch(query, limit);
      const urls = api.map((h) => h.url).filter((u) => !isLikelyNonPersonEnrichUrl(u));
      if (urls.length) return urls.slice(0, limit);
    }
  } catch (e) {
    console.warn('[network-enrich] brave api web search failed', String(e?.message || e).slice(0, 120));
  }
  return searchDuckDuckGoResultUrls(query, limit);
}

/**
 * Pull outbound result URLs from DuckDuckGo HTML search.
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<string[]>}
 */
async function searchDuckDuckGoResultUrls(query, limit = 6) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const r = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return [];
    const html = await r.text();
    /** @type {string[]} */
    const urls = [];
    const push = (u) => {
      const s = String(u || '').trim();
      if (!s || !/^https?:\/\//i.test(s)) return;
      if (/duckduckgo\.com/i.test(s)) return;
      if (isLikelyNonPersonEnrichUrl(s)) return;
      if (urls.includes(s)) return;
      urls.push(s);
    };
    for (const m of html.matchAll(/uddg=([^&"]+)/gi)) {
      try {
        push(decodeURIComponent(m[1]));
      } catch {
        // ignore bad encodings
      }
      if (urls.length >= limit) break;
    }
    if (urls.length < limit) {
      for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/gi)) {
        push(m[1]);
        if (urls.length >= limit) break;
      }
    }
    return urls.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * @param {string[]} queries
 * @param {number} [maxUrls]
 * @returns {Promise<string[]>}
 */
async function discoverUrlsFromQueries(queries, maxUrls = 10) {
  /** @type {string[]} */
  const urls = [];
  // Prefer the caller’s curated list (e.g. unchecked terms removed in the preview dialog).
  // Chrome searches are heavier — run a few in parallel, not all eight at once.
  const list = (queries || []).slice(0, 8);
  const concurrency = 2;
  for (let i = 0; i < list.length; i += concurrency) {
    const chunk = list.slice(i, i + concurrency);
    const batches = await Promise.all(chunk.map((q) => searchWebResultUrls(q, 4)));
    for (const hits of batches) {
      for (const u of hits) {
        if (isLikelyNonPersonEnrichUrl(u)) continue;
        if (!urls.includes(u)) urls.push(u);
        if (urls.length >= maxUrls) return urls;
      }
    }
  }
  return urls;
}

/**
 * Sanitize optional client-selected page URLs from the enrich preview dialog.
 * Honors Jay’s checks: only drop clearly invalid / Telegram / DuckDuckGo URLs.
 * @param {unknown} raw
 * @returns {string[] | null} null when the client did not send a list
 */
export function sanitizeEnrichFetchUrls(raw) {
  if (!Array.isArray(raw)) return null;
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    const s = String(item || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) continue;
    if (/duckduckgo\.com/i.test(s)) continue;
    if (isTelegramEnrichUrl(s)) continue;
    // Drop obvious private/link-local/metadata targets at intake (DNS-level check
    // still happens in fetchPageText); prevents caller-supplied SSRF URLs early.
    if (!looksLikePublicHttpUrl(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Sanitize optional client-selected search queries from the enrich preview dialog.
 * @param {unknown} raw
 * @returns {string[] | null} null when the client did not send a list
 */
export function sanitizeEnrichSearchQueries(raw) {
  if (!Array.isArray(raw)) return null;
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    const s = String(item || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    if (!s || s.length < 2) continue;
    if (/\btelegram\b|t\.me\b|telegram\.(?:me|org|dog)/i.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 16) break;
  }
  return out;
}

/**
 * Telegram hosts — never fetch or promote as enrichment sources.
 * @param {string} url
 */
export function isTelegramEnrichUrl(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  let host = '';
  try {
    host = new URL(s).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return /(?:^|[/.])(?:t\.me|telegram\.(?:me|org|dog)|web\.telegram\.org)\b/i.test(s);
  }
  return (
    host === 't.me' ||
    host.endsWith('.t.me') ||
    host === 'telegram.me' ||
    host.endsWith('.telegram.me') ||
    host === 'telegram.org' ||
    host.endsWith('.telegram.org') ||
    host === 'telegram.dog' ||
    host.endsWith('.telegram.dog') ||
    host === 'web.telegram.org'
  );
}

/**
 * URLs that must not be used as enrichment sources (junk encyclopedia / diner hits,
 * Telegram, etc.).
 * @param {string} url
 */
export function isLikelyNonPersonEnrichUrl(url) {
  const s = String(url || '').trim();
  if (!s || !/^https?:\/\//i.test(s)) return true;
  if (isTelegramEnrichUrl(s)) return true;
  let host = '';
  let path = '';
  try {
    const u = new URL(s);
    host = u.hostname.replace(/^www\./i, '').toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return false;
  }
  if (/^(merriam-webster|dictionary|wiktionary)\./.test(host) || host.endsWith('.merriam-webster.com')) {
    return true;
  }
  if (host === 'britannica.com' || host.endsWith('.britannica.com')) {
    if (/\/animal\b|\/topic\/.*bear/.test(path)) return true;
  }
  if (/^(yelp|tripadvisor|restaurantji|birdeye|opentable)\./.test(host) || /\.yelp\.com$/.test(host)) {
    return true;
  }
  if (/blackbeardiner\.com/.test(host)) return true;
  if (host === 'wikipedia.org' || host.endsWith('.wikipedia.org')) {
    const title = decodeURIComponent((path.replace(/^\/wiki\//, '').split('/')[0] || '')).toLowerCase();
    if (!title) return false;
    // Common animal / species pages that drown person nicknames.
    if (
      /^(bear|american_black_bear|brown_bear|polar_bear|grizzly_bear|black_bear)(_\(|$)/.test(title) ||
      /_(black|brown|polar|grizzly|sloth|sun)_bear$/.test(title) ||
      title === 'american_black_bear'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Higher = fetch sooner. Profiles and name-in-path beat stale encyclopedia hits.
 * @param {string} url
 * @param {object} contact
 */
function scoreContactEnrichUrl(url, contact) {
  const s = String(url || '').trim();
  if (!s) return -1000;
  if (isLikelyNonPersonEnrichUrl(s)) return -500;
  let score = 0;
  if (isPublicProfileUrl(s)) score += 100;
  if (/linkedin\.com\/in\//i.test(s)) score += 80;
  if (/\/(staff|people|team|about-us|apl-staff)\b/i.test(s)) score += 40;
  const nameTokens = String(contact?.displayName || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 3);
  try {
    const path = new URL(s).pathname.toLowerCase();
    if (nameTokens.some((t) => path.includes(t))) score += 30;
  } catch {
    /* ignore */
  }
  return score;
}

/**
 * @param {object} contact
 */
function contactCandidateUrls(contact) {
  /** @type {string[]} */
  const urls = [];
  const push = (u) => {
    const s = String(u || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (isLikelyNonPersonEnrichUrl(s)) return;
    if (!urls.includes(s)) urls.push(s);
  };
  // Page the selected avatar photo came from — strong signal for the right person.
  push(contact?.avatarSourceUrl);
  // Prefer explicit profile links. Do NOT re-queue historical enrichment.sources —
  // a bad first pass (wiki animals / diners) otherwise fills fetchPages' first 6 slots.
  push(contact?.channels?.linkedin);
  for (const u of contact?.channels?.urls || []) {
    if (isPublicProfileUrl(u) || scoreContactEnrichUrl(u, contact) >= 0) push(u);
  }
  for (const s of contact?.enrichment?.sources || []) {
    if (isPublicProfileUrl(s) || scoreContactEnrichUrl(s, contact) >= 40) push(s);
  }
  return urls;
}

/**
 * @param {object} org
 */
function orgCandidateUrls(org) {
  /** @type {string[]} */
  const urls = [];
  const push = (u) => {
    const s = String(u || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (!urls.includes(s)) urls.push(s);
  };
  push(org?.website);
  for (const u of org?.urls || []) push(u);
  for (const s of org?.enrichment?.sources || []) push(s);
  for (const q of orgSearchQueries(org)) {
    push(`https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
  }
  return urls;
}

/**
 * Owned site URLs only (no DuckDuckGo HTML search pages) — used for fast logo scraping.
 * @param {object} org
 */
function orgOwnedUrls(org) {
  return orgCandidateUrls(org).filter((u) => !/duckduckgo\.com/i.test(u)).slice(0, 3);
}

/**
 * Merge optional live card fields into the stored contact before searching.
 * @param {object} contact
 * @param {object | null | undefined} card
 */
function applyContactCardHints(contact, card) {
  if (!card || typeof card !== 'object') return contact;
  const channels = {
    ...(contact.channels || {}),
    ...(card.channels && typeof card.channels === 'object' ? card.channels : {}),
  };
  if (card.channels?.urls || contact.channels?.urls) {
    channels.urls = [
      ...new Set([...(contact.channels?.urls || []), ...(card.channels?.urls || [])].filter(Boolean)),
    ].slice(0, 20);
  }
  return {
    ...contact,
    displayName: String(card.displayName || contact.displayName || '').trim() || contact.displayName,
    nickname: card.nickname != null ? String(card.nickname) : contact.nickname,
    aliases: Array.isArray(card.aliases) ? card.aliases : contact.aliases,
    org: card.org != null ? String(card.org) : contact.org,
    title: card.title != null ? String(card.title) : contact.title,
    department: card.department != null ? String(card.department) : contact.department,
    location: card.location != null ? String(card.location) : contact.location,
    address: card.address != null ? String(card.address) : contact.address,
    bio: card.bio != null ? String(card.bio) : contact.bio,
    summary: card.summary != null ? String(card.summary) : contact.summary,
    notes: card.notes != null ? String(card.notes) : contact.notes,
    networkCircles: card.networkCircles != null ? String(card.networkCircles) : contact.networkCircles,
    howWeMet: card.howWeMet != null ? String(card.howWeMet) : contact.howWeMet,
    relationshipSummary:
      card.relationshipSummary != null ? String(card.relationshipSummary) : contact.relationshipSummary,
    alignedActivities: Array.isArray(card.alignedActivities)
      ? card.alignedActivities
      : contact.alignedActivities,
    channels,
  };
}

/**
 * @param {Buffer} buf
 * @returns {string | null} mime subtype hint
 */
function sniffImageKind(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Fetch remote image bytes with browser-like headers (for apply + image proxy).
 * @param {string} url
 * @returns {Promise<{ buffer: Buffer, contentType: string, ext: string } | null>}
 */
export async function fetchRemoteImageBytes(url) {
  const src = String(url || '').trim();
  if (!src || !/^https?:\/\//i.test(src)) return null;

  // SSRF guard: the avatar/logo URL can come straight from the LLM (parsed.avatarImageUrl)
  // or a caller-supplied list, so validate it resolves to a public address before fetching.
  try {
    await assertPublicHttpUrl(src);
  } catch {
    return null;
  }

  let refererOrigin = 'https://duckduckgo.com/';
  try {
    refererOrigin = `${new URL(src).origin}/`;
  } catch {
    // keep default
  }

  const headerSets = [
    {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: 'https://duckduckgo.com/',
    },
    {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: refererOrigin,
    },
    {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'image/*,*/*;q=0.8',
    },
  ];

  for (const headers of headerSets) {
    try {
      const r = await fetch(src, {
        headers,
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow',
      });
      if (!r.ok) continue;
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      const ab = await r.arrayBuffer();
      const buf = Buffer.from(ab);
      if (buf.length < 200 || buf.length > 5_000_000) continue;
      const sniffed = sniffImageKind(buf);
      const looksLikeImage = Boolean(sniffed) || ct.startsWith('image/');
      if (!looksLikeImage) continue;
      if (ct.includes('svg') || (!sniffed && /svg/i.test(ct))) continue;
      let ext = '.jpg';
      let contentType = 'image/jpeg';
      if (sniffed === 'png' || ct.includes('png')) {
        ext = '.png';
        contentType = 'image/png';
      } else if (sniffed === 'webp' || ct.includes('webp')) {
        ext = '.webp';
        contentType = 'image/webp';
      } else if (sniffed === 'gif' || ct.includes('gif')) {
        ext = '.gif';
        contentType = 'image/gif';
      } else if (sniffed === 'jpeg' || ct.includes('jpeg') || ct.includes('jpg')) {
        ext = '.jpg';
        contentType = 'image/jpeg';
      } else if (ct.startsWith('image/')) {
        contentType = ct.split(';')[0].trim() || contentType;
      }
      return { buffer: buf, contentType, ext };
    } catch {
      // try next header set
    }
  }
  return null;
}

/**
 * @param {string} url
 * @param {string} id
 * @param {string} kind
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function tryDownloadImage(url, id, kind, env = process.env) {
  const fetched = await fetchRemoteImageBytes(url);
  if (!fetched) return null;
  let buf = fetched.buffer;
  let ext = fetched.ext;
  if (kind === 'logo') {
    try {
      const { cropLogoToIconMark } = await import('./network-logo-icon.js');
      const cropped = await cropLogoToIconMark(buf);
      // Cropped icon marks can be small PNGs; keep anything usable.
      if (cropped?.buffer?.length >= 200) {
        buf = cropped.buffer;
        if (cropped.ext) ext = cropped.ext;
      }
    } catch {
      // Keep original bytes if crop/decode fails.
    }
  }
  return saveNetworkAsset(buf, `${id}-${kind}${ext}`, env);
}

/**
 * Try primary URL then optional fallbacks (e.g. DDG thumbnail).
 * @param {string[]} urls
 * @param {string} id
 * @param {string} kind
 * @param {NodeJS.ProcessEnv} [env]
 */
async function tryDownloadImageFromUrls(urls, id, kind, env = process.env) {
  const seen = new Set();
  for (const u of urls || []) {
    const s = String(u || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    const saved = await tryDownloadImage(s, id, kind, env);
    if (saved) return saved;
  }
  return null;
}

/**
 * @param {{ url: string, thumbUrl?: string | null, pageUrl?: string | null }[]} list
 * @param {string} url
 * @param {string | null} [thumbUrl]
 * @param {string | null} [pageUrl]
 */
function pushCandidate(list, url, thumbUrl = null, pageUrl = null) {
  const s = String(url || '').trim();
  if (!s || !/^https?:\/\//i.test(s)) return;
  if (/\.svg(\?|$)/i.test(s)) return;
  const page =
    pageUrl && /^https?:\/\//i.test(pageUrl) && pageUrl !== s && !/duckduckgo\.com/i.test(pageUrl)
      ? String(pageUrl).trim()
      : null;
  const existing = list.find((x) => x.url === s);
  if (existing) {
    if (thumbUrl && !existing.thumbUrl && /^https?:\/\//i.test(thumbUrl)) {
      existing.thumbUrl = thumbUrl;
    }
    if (page && !existing.pageUrl) existing.pageUrl = page;
    return;
  }
  list.push({
    url: s,
    thumbUrl: thumbUrl && /^https?:\/\//i.test(thumbUrl) ? thumbUrl : null,
    pageUrl: page,
  });
}

/**
 * Re-run image search for a contact; return a page of candidates without saving.
 * Default path: scrape known pages, then Google Images (Chrome) for `"Name" linkedin` first, then org/name.
 * When `opts.query` is set (picker text box), skip page scrapes and search with that hint.
 * @param {string} contactId
 * @param {{ offset?: number, limit?: number, query?: string }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function findContactAvatarCandidates(contactId, opts = {}, env = process.env) {
  const contact = await getContactById(contactId, env);
  if (!contact) return { ok: false, error: 'not_found' };

  const limit = Math.max(1, Math.min(10, Number(opts.limit) || 5));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const poolTarget = Math.min(40, offset + limit + 10);
  const hint = String(opts.query || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

  /** @type {{ url: string, thumbUrl: string | null, pageUrl: string | null }[]} */
  const candidates = [];

  const name = String(contact.displayName || '').trim();
  const org = String(contact.org || '').trim();
  /** @type {string[]} */
  const queries = [];
  const pushQ = (q) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (!s || queries.includes(s)) return;
    queries.push(s);
  };

  if (hint) {
    pushQ(hint);
    if (name && hint.toLowerCase() !== name.toLowerCase()) {
      pushQ(`"${name}" ${hint}`);
    }
    if (name && org) pushQ(`"${name}" ${org}`);
    if (name) pushQ(`"${name}"`);
  } else {
    // First image query always includes LinkedIn so profile photos surface early.
    if (name) pushQ(`"${name}" linkedin`);
    if (name && org) pushQ(`"${name}" ${org}`);
    if (name) pushQ(`"${name}"`);
    if (name) pushQ(name);
  }

  // Refine hints skip page scrapes for speed (same as logo picker).
  if (!hint) {
    const pageUrls = contactCandidateUrls(contact);
    const pages = await fetchPages(pageUrls);
    for (const p of pages) {
      for (const img of p.imageUrls || []) {
        pushCandidate(candidates, img, null, p.url);
        if (candidates.length >= poolTarget) break;
      }
      if (candidates.length >= poolTarget) break;
    }
  }

  if (candidates.length < poolTarget) {
    for (const q of queries) {
      const hits = await searchDuckDuckGoImageResults(q, 15);
      for (const hit of hits) {
        pushCandidate(candidates, hit.url, hit.thumbUrl, hit.pageUrl);
        if (candidates.length >= poolTarget) break;
      }
      if (candidates.length >= poolTarget) break;
    }
  }

  const page = candidates.slice(offset, offset + limit);
  return {
    ok: true,
    candidates: page,
    offset,
    nextOffset: offset + page.length,
    hasMore: candidates.length > offset + limit,
  };
}

/**
 * Collect ranked logo image candidates for an organization (page icons/og/logo
 * imgs → Clearbit-style host logo → Google Images `"Name" logo` queries).
 * Shared by enrichOrganization and the image-picker UI.
 *
 * @param {object} org
 * @param {number} [limit]
 * @param {{ pages?: { url?: string, imageUrls?: string[] }[], query?: string }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ url: string, thumbUrl: string | null }[]>}
 */
export async function searchOrgLogoCandidates(org, limit = 5, opts = {}, env = process.env) {
  const max = Math.max(1, Math.min(40, Number(limit) || 5));
  const hint = String(opts.query || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  /** @type {{ url: string, thumbUrl: string | null, score: number }[]} */
  const scored = [];
  const pushScored = (url, thumbUrl = null, bonus = 0) => {
    const s = String(url || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (/\.svg(\?|$)/i.test(s)) return;
    if (/sprite|pixel|tracking|1x1|blank\.(gif|png)/i.test(s)) return;
    const score = scoreLogoUrl(s) + bonus;
    const existing = scored.find((x) => x.url === s);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      if (thumbUrl && !existing.thumbUrl) {
        existing.thumbUrl = /^https?:\/\//i.test(thumbUrl) ? thumbUrl : null;
      }
      return;
    }
    scored.push({
      url: s,
      thumbUrl: thumbUrl && /^https?:\/\//i.test(thumbUrl) ? thumbUrl : null,
      score,
    });
  };

  const name = String(org?.name || '').trim();
  /** @type {string[]} */
  const queries = [];
  const pushQ = (q) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (!s || queries.includes(s)) return;
    queries.push(s);
  };
  if (hint) {
    pushQ(hint);
    if (name) {
      pushQ(`"${name}" ${hint}`);
      pushQ(`${name} ${hint} logo`);
    }
  }
  if (name) {
    pushQ(`"${name}" logo`);
    pushQ(`${name} logo`);
    pushQ(`${name} company logo`);
    pushQ(`${name} brand icon`);
  }

  // Page scrape + first image search in parallel (do not fetch DuckDuckGo HTML
  // search pages here — that made Find logos much slower than before).
  // Refine hints skip page scrapes for speed.
  const pagesPromise =
    hint
      ? Promise.resolve([])
      : Array.isArray(opts.pages)
        ? Promise.resolve(opts.pages)
        : fetchPages(orgOwnedUrls(org));
  const firstImagePromise = queries[0]
    ? searchDuckDuckGoImageResults(queries[0], 15, { preferSquare: true })
    : Promise.resolve([]);

  const [pages, firstHits] = await Promise.all([pagesPromise, firstImagePromise]);

  for (const img of prioritizeLogoUrls(pages.flatMap((p) => p.imageUrls || []))) {
    pushScored(img, null, 3);
  }

  if (!hint) {
    const website = String(org?.website || pages[0]?.url || '').trim();
    const cb = clearbitLogoUrl(website);
    if (cb) pushScored(cb, null, 8);
  }

  for (const hit of firstHits) {
    pushScored(hit.url, hit.thumbUrl, hint ? 4 : 0);
  }

  for (const q of queries.slice(1)) {
    if (scored.length >= max * 2) break;
    const hits = await searchDuckDuckGoImageResults(q, 15, { preferSquare: true });
    for (const hit of hits) {
      pushScored(hit.url, hit.thumbUrl, hint ? 2 : 0);
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(({ url, thumbUrl }) => ({ url, thumbUrl }));
}

/**
 * Re-run logo image search for an organization; return a page of candidates without saving.
 * @param {string} orgId
 * @param {{ offset?: number, limit?: number, query?: string }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function findOrganizationLogoCandidates(orgId, opts = {}, env = process.env) {
  const org = await getOrganizationById(orgId, env);
  if (!org) return { ok: false, error: 'not_found' };
  const limit = Math.max(1, Math.min(10, Number(opts.limit) || 5));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const hint = String(opts.query || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const pool = await searchOrgLogoCandidates(
    org,
    Math.min(40, offset + limit + 10),
    hint ? { query: hint } : {},
    env,
  );
  const page = pool.slice(offset, offset + limit);
  return {
    ok: true,
    candidates: page,
    offset,
    nextOffset: offset + page.length,
    hasMore: pool.length > offset + limit,
    query: hint || undefined,
  };
}

/**
 * Download a remote image URL and set it as the contact avatar.
 * When the picker had a hosting page URL for the image, store it as avatarSourceUrl
 * so the next Enrich can fetch that page as a source.
 * @param {string} contactId
 * @param {string} imageUrl
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ thumbUrl?: string | null, dataUrl?: string | null, pageUrl?: string | null }} [opts]
 */
export async function applyContactAvatarFromUrl(contactId, imageUrl, env = process.env, opts = {}) {
  const contact = await getContactById(contactId, env);
  if (!contact) return { ok: false, error: 'not_found' };
  const dataUrl = String(opts.dataUrl || '').trim();
  if (dataUrl.startsWith('data:image/')) {
    try {
      const updated = await saveContactAvatar(contactId, { dataUrl }, env);
      return { ok: true, contact: updated };
    } catch (e) {
      return { ok: false, error: String(e?.code || e?.message || 'invalid_image') };
    }
  }
  const url = String(imageUrl || '').trim();
  const thumb = String(opts.thumbUrl || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid_url' };
  const avatarUrl = await tryDownloadImageFromUrls([url, thumb], contact.id, 'avatar', env);
  if (!avatarUrl) return { ok: false, error: 'download_failed' };
  const pageRaw = String(opts.pageUrl || '').trim();
  const avatarSourceUrl =
    pageRaw && /^https?:\/\//i.test(pageRaw) && pageRaw !== url && !/duckduckgo\.com/i.test(pageRaw)
      ? pageRaw.slice(0, 500)
      : null;
  const updated = await updateContact(contactId, { avatarUrl, avatarSourceUrl }, env);
  return { ok: true, contact: updated };
}

/**
 * Download a remote image URL and set it as the organization logo.
 * @param {string} orgId
 * @param {string} imageUrl
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ thumbUrl?: string | null, dataUrl?: string | null }} [opts]
 */
export async function applyOrganizationLogoFromUrl(orgId, imageUrl, env = process.env, opts = {}) {
  const org = await getOrganizationById(orgId, env);
  if (!org) return { ok: false, error: 'not_found' };
  const dataUrl = String(opts.dataUrl || '').trim();
  if (dataUrl.startsWith('data:image/')) {
    try {
      const { saveOrganizationLogo } = await import('./network-organizations-store.js');
      const updated = await saveOrganizationLogo(orgId, { dataUrl }, env);
      return { ok: true, organization: updated };
    } catch (e) {
      return { ok: false, error: String(e?.code || e?.message || 'invalid_image') };
    }
  }
  const url = String(imageUrl || '').trim();
  const thumb = String(opts.thumbUrl || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid_url' };
  const logoUrl = await tryDownloadImageFromUrls([url, thumb], org.id, 'logo', env);
  if (!logoUrl) return { ok: false, error: 'download_failed' };
  const updated = await updateOrganization(orgId, { logoUrl }, env);
  return { ok: true, organization: updated };
}

/**
 * @param {unknown} v
 */
function emptyField(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === '';
}

/**
 * Append an open follow-up task when enrich finds a nextStep and the contact has none open.
 * @param {object} contact
 * @param {Record<string, unknown>} patch
 * @param {unknown} value
 * @param {boolean} force
 */
function maybeAppendOpenTask(contact, patch, value, force) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) return;
  const existing = Array.isArray(patch.tasks)
    ? /** @type {{ id: string, text: string, done: boolean }[]} */ (patch.tasks)
    : Array.isArray(contact.tasks)
      ? contact.tasks.map((t) => ({
          id: String(t.id || ''),
          text: String(t.text || '').trim(),
          done: Boolean(t.done),
        }))
      : [];
  const hasOpen = existing.some((t) => t && !t.done && String(t.text || '').trim());
  if (!force && hasOpen) return;
  const key = text.toLowerCase();
  if (existing.some((t) => !t.done && String(t.text || '').trim().toLowerCase() === key)) return;
  patch.tasks = [
    ...existing,
    { id: newContactTaskId(), text, done: false },
  ].slice(0, 40);
}

/**
 * LinkedIn / Facebook / personal profile URLs — safe to store on the card.
 * @param {string} url
 */
function isPublicProfileUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
      return /\/in\//i.test(u.pathname);
    }
    if (host === 'facebook.com' || host.endsWith('.facebook.com')) {
      return !/\/(pages|groups|events|watch|reel)\//i.test(u.pathname);
    }
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) return true;
    if (host === 'x.com' || host === 'twitter.com') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Reject profile URLs whose slug clearly disagrees with the contact's name
 * (stops a contact from inheriting another person's LinkedIn URL).
 * @param {string} url
 * @param {string} displayName
 * @param {string[]} [aliases]
 */
function profileUrlPlausiblyMatchesName(url, displayName, aliases = []) {
  const names = [displayName, ...(aliases || [])]
    .map((n) => String(n || '').trim().toLowerCase())
    .filter(Boolean);
  if (!names.length) return true;
  let path = '';
  try {
    path = new URL(String(url || '').trim()).pathname.toLowerCase();
  } catch {
    path = String(url || '').toLowerCase();
  }
  const slug = path
    .replace(/^\/(?:in|company|school)\//, '')
    .split('/')
    .filter(Boolean)[0] || '';
  const slugNorm = slug.replace(/[^a-z0-9]+/g, '');
  if (!slugNorm) return true;

  for (const name of names) {
    const tokens = name
      .replace(/[^a-z0-9\s'-]+/g, ' ')
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9]/g, ''))
      .filter((t) => t.length >= 3);
    if (!tokens.length) continue;
    // Any substantial name token appears in the slug → plausible.
    if (tokens.some((t) => slugNorm.includes(t))) return true;
    // Initials-style: "nik bertulus" → nb
    if (tokens.length >= 2) {
      const initials = tokens.map((t) => t[0]).join('');
      if (initials.length >= 2 && slugNorm.includes(initials)) return true;
    }
  }
  // No name overlap — likely the wrong person.
  return false;
}

/**
 * @param {string} contactId
 * @param {{ force?: boolean, card?: object }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function enrichContact(contactId, opts = {}, env = process.env) {
  const force = Boolean(opts.force);
  const startedAt = Date.now();
  const deadlineAt = startedAt + ENRICH_WALL_MS;
  const stored = await getContactById(contactId, env);
  if (!stored) return { ok: false, error: 'not_found' };
  if (!openRouterKey(env)) return { ok: false, error: 'openrouter_not_configured', contact: stored };

  // Prefer the live card snapshot (newest UI fields) so each Enrich deepens from what you see.
  const contact = applyContactCardHints(stored, opts.card);
  const selectedQueries = sanitizeEnrichSearchQueries(opts.searchQueries);
  const searchQueries =
    selectedQueries != null ? selectedQueries : contactSearchQueries(contact);
  const selectedFetchUrls = sanitizeEnrichFetchUrls(opts.fetchUrls);
  const knownUrls =
    selectedFetchUrls != null
      ? selectedFetchUrls
      : contactCandidateUrls(contact).filter((u) => !/duckduckgo\.com/i.test(u));
  const discovered = await discoverUrlsFromQueries(searchQueries, 10);
  // Prefer freshly discovered + profile URLs; never let stale animal/diner sources crowd the fetch slot.
  const urls = [...new Set([...discovered, ...knownUrls])]
    .filter((u) => u && !/duckduckgo\.com/i.test(u) && !isLikelyNonPersonEnrichUrl(u))
    .sort((a, b) => scoreContactEnrichUrl(b, contact) - scoreContactEnrichUrl(a, contact))
    .slice(0, 10);
  // Pin the page associated with the selected photo — but only if Jay left it checked
  // (or there was no page-picker list).
  const avatarPage = String(contact.avatarSourceUrl || '').trim();
  const pinAvatar =
    avatarPage &&
    /^https?:\/\//i.test(avatarPage) &&
    !/duckduckgo\.com/i.test(avatarPage) &&
    !isLikelyNonPersonEnrichUrl(avatarPage) &&
    (selectedFetchUrls == null || selectedFetchUrls.includes(avatarPage));
  if (pinAvatar) {
    const idx = urls.indexOf(avatarPage);
    if (idx >= 0) urls.splice(idx, 1);
    urls.unshift(avatarPage);
    if (urls.length > 10) urls.length = 10;
  }
  const pages = await fetchPages(urls);
  const pageImageUrls = [...new Set(pages.flatMap((p) => p.imageUrls || []))].slice(0, 16);
  const excerpt = pages
    .map((p) => {
      const imgs = (p.imageUrls || []).slice(0, 6).join('\n  ');
      return `URL: ${p.url}\n${p.text.slice(0, 4000)}${imgs ? `\nImage URLs found on page:\n  ${imgs}` : ''}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 24_000);

  // #region agent log
  void agentDbgEnrich({
    hypothesisId: 'A',
    location: 'network-enrich.js:enrichContact:search',
    message: 'web enrich search context',
    data: {
      contactId: String(contactId),
      displayName: contact.displayName || null,
      location: contact.location || null,
      networkCircles: contact.networkCircles || null,
      org: contact.org || null,
      searchQueries,
      discoveredUrls: discovered.slice(0, 12),
      urlsUsed: urls,
      pagesFetched: pages.map((p) => p.url),
      excerptChars: excerpt.length,
    },
  });
  // #endregion

  if (Date.now() >= deadlineAt) {
    // #region agent log
    void agentDbgEnrich({
      hypothesisId: 'B',
      location: 'network-enrich.js:enrichContact:timeout-pre-llm',
      message: 'enrich timeout before LLM',
      data: { contactId: String(contactId), elapsedMs: Date.now() - startedAt },
    });
    // #endregion
    return { ok: false, error: 'enrich_timeout', contact: stored };
  }

  const chat = await openRouterChatJson({
    env,
    models: modelChain(textModel(env), TEXT_FALLBACK_MODELS),
    temperature: 0.2,
    maxTokens: 4096,
    deadlineAt,
    messages: [
      { role: 'system', content: CONTACT_ENRICH_SYSTEM },
      {
        role: 'user',
        content: `Contact to enrich (use these current card facts to disambiguate and deepen — do not discard known fields):
displayName: ${contact.displayName}
aliases: ${(contact.aliases || []).join(', ') || '(none)'}
org: ${contact.org || '(none)'}
title: ${contact.title || '(none)'}
location: ${contact.location || '(none)'}
address: ${contact.address || '(none)'}
scene/circles: ${contact.networkCircles || '(none)'}
bio: ${contact.bio || '(none)'}
summary: ${contact.summary || '(none)'}
email: ${contact.channels?.email || '(none)'}
phone: ${contact.channels?.phone || '(none)'}
officePhone: ${contact.channels?.officePhone || '(none)'}
linkedin: ${contact.channels?.linkedin || '(none)'}
search queries used: ${searchQueries.join(' | ') || '(none)'}
known urls: ${urls.join(', ') || '(none)'}

Page excerpts:
${excerpt || '(no pages fetched — only high-confidence public facts; else null)'}`,
      },
    ],
  });

  if (!chat.ok) {
    // #region agent log
    void agentDbgEnrich({
      hypothesisId: 'B',
      location: 'network-enrich.js:enrichContact:llm-fail',
      message: 'openrouter enrich failed',
      data: {
        contactId: String(contactId),
        error: chat.error || 'openrouter_failed',
        detail: String(chat.detail || '').slice(0, 200),
        elapsedMs: Date.now() - startedAt,
      },
    });
    // #endregion
    return { ok: false, error: chat.error || 'openrouter_failed', contact };
  }
  const parsed = extractJsonObject(chat.content);
  if (!parsed || typeof parsed !== 'object') {
    // #region agent log
    void agentDbgEnrich({
      hypothesisId: 'B',
      location: 'network-enrich.js:enrichContact:parse-fail',
      message: 'enrich JSON parse failed',
      data: {
        contactId: String(contactId),
        contentPreview: String(chat.content || '').slice(0, 240),
      },
    });
    // #endregion
    return { ok: false, error: 'parse_failed', contact };
  }

  let confidence = null;
  if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
    confidence = Math.max(0, Math.min(1, parsed.confidence));
  }

  /** @type {Record<string, unknown>} */
  const patch = {
    enrichment: {
      sources: [
        ...new Set([
          ...(contact.enrichment?.sources || []).filter((u) => !isLikelyNonPersonEnrichUrl(u)),
          ...pages.map((p) => p.url).filter((u) => !isLikelyNonPersonEnrichUrl(u)),
          ...((Array.isArray(parsed.urls) ? parsed.urls : [])
            .map((u) => String(u).trim())
            .filter((u) => /^https?:\/\//i.test(u) && !isLikelyNonPersonEnrichUrl(u))),
        ]),
      ].slice(0, 30),
      enrichedAt: new Date().toISOString(),
      rawSummary: String(parsed.summary || '').trim().slice(0, 4000) || contact.enrichment?.rawSummary || null,
      confidence: confidence ?? contact.enrichment?.confidence ?? null,
    },
    source: contact.source === 'seed' ? 'seed' : 'enrich',
  };

  const maybeSet = (field, value) => {
    if (value == null) return;
    const s = Array.isArray(value)
      ? value.map((x) => String(x).trim()).filter(Boolean)
      : String(value).trim();
    if (Array.isArray(s) ? !s.length : !s) return;
    if (!force && !emptyField(contact[field])) return;
    patch[field] = s;
  };

  maybeSet('bio', parsed.bio || parsed.summary);
  maybeSet('org', parsed.org);
  maybeSet('title', parsed.title);
  maybeSet('department', parsed.department);
  maybeSet('location', parsed.location || parsed.region);
  maybeSet('address', parsed.address);
  maybeSet('rating', parsed.rating);
  maybeSet('relationshipStatus', parsed.relationshipStatus);
  maybeAppendOpenTask(contact, patch, parsed.nextStep, force);
  maybeSet('howWeMet', parsed.howWeMet);
  maybeSet('notes', parsed.notes);
  maybeSet('networkCircles', parsed.networkCircles);
  maybeSet('nickname', parsed.nickname);

  if (Array.isArray(parsed.aliases) && parsed.aliases.length) {
    const aliases = [...new Set([...(contact.aliases || []), ...parsed.aliases.map((a) => String(a).trim()).filter(Boolean)])];
    if (force || emptyField(contact.aliases) || aliases.length > (contact.aliases || []).length) {
      patch.aliases = aliases;
    }
  }

  const channels = { ...contact.channels };
  let channelsChanged = false;
  const setChannel = (key, value) => {
    const s = String(value || '').trim();
    if (!s) return;
    if (!force && !emptyField(channels[key])) return;
    // Refuse LinkedIn that clearly belongs to someone else (common enrich mix-up).
    if (key === 'linkedin' && !profileUrlPlausiblyMatchesName(s, contact.displayName, contact.aliases)) {
      return;
    }
    channels[key] = s;
    channelsChanged = true;
  };
  const linkedinCandidate = String(parsed.linkedin || '').trim();
  const linkedinRejected =
    Boolean(linkedinCandidate) &&
    !profileUrlPlausiblyMatchesName(linkedinCandidate, contact.displayName, contact.aliases);
  setChannel('linkedin', parsed.linkedin);
  setChannel('email', parsed.email);
  setChannel('phone', parsed.phone);
  setChannel('officePhone', parsed.officePhone);
  {
    // Keep enrichment.sources for audit; only promote clear profile URLs onto the card.
    const profileUrls = [
      ...((Array.isArray(parsed.urls) ? parsed.urls : []).map((u) => String(u).trim())),
      ...pages.map((p) => p.url),
    ].filter(
      (u) =>
        /^https?:\/\//i.test(String(u)) &&
        isPublicProfileUrl(u) &&
        profileUrlPlausiblyMatchesName(u, contact.displayName, contact.aliases),
    );
    // Drop dictionary / animal / restaurant junk left on the card from earlier bad enriches.
    const priorUrls = (channels.urls || []).filter(
      (u) => isPublicProfileUrl(u) || (!isLikelyNonPersonEnrichUrl(u) && scoreContactEnrichUrl(u, contact) >= 0),
    );
    const urlsMerged = [...new Set([...priorUrls, ...profileUrls])].slice(0, 20);
    if (
      force ||
      emptyField(channels.urls) ||
      urlsMerged.length !== (channels.urls || []).length ||
      urlsMerged.some((u, i) => u !== (channels.urls || [])[i])
    ) {
      channels.urls = urlsMerged;
      channelsChanged = true;
    }
  }
  if (channelsChanged) patch.channels = channels;

  // #region agent log
  void agentDbgEnrich({
    hypothesisId: 'A',
    location: 'network-enrich.js:enrichContact:parsed',
    message: 'LLM enrich parse + guard outcomes',
    data: {
      contactId: String(contactId),
      confidence,
      parsedKeys: Object.keys(parsed).filter((k) => parsed[k] != null && parsed[k] !== ''),
      parsedBio: parsed.bio ? String(parsed.bio).slice(0, 120) : null,
      parsedOrg: parsed.org || null,
      parsedTitle: parsed.title || null,
      parsedLinkedin: linkedinCandidate || null,
      linkedinRejected,
      patchFieldKeys: Object.keys(patch).filter((k) => k !== 'enrichment' && k !== 'source'),
      sources: (patch.enrichment?.sources || []).slice(0, 8),
    },
  });
  // #endregion

  if ((force || emptyField(contact.avatarUrl)) && parsed.avatarImageUrl) {
    const avatarUrl = await tryDownloadImage(String(parsed.avatarImageUrl), contact.id, 'avatar', env);
    if (avatarUrl) patch.avatarUrl = avatarUrl;
  }

  // Prefer images found on the contact's own pages (og:image / <img>).
  if ((force || emptyField(contact.avatarUrl)) && !patch.avatarUrl && pageImageUrls.length) {
    const avatarUrl = await tryDownloadFirstImage(pageImageUrls, contact.id, 'avatar', env);
    if (avatarUrl) patch.avatarUrl = avatarUrl;
  }

  // Same path you see in Chrome: Google Images for name + LinkedIn first, then org/name.
  if ((force || emptyField(contact.avatarUrl)) && !patch.avatarUrl && Date.now() < deadlineAt - 8_000) {
    const name = String(contact.displayName || '').trim();
    const org = String(patch.org || contact.org || '').trim();
    /** @type {string[]} */
    const queries = [];
    if (name) queries.push(`"${name}" linkedin`);
    if (name && org) queries.push(`"${name}" ${org}`);
    else if (name) queries.push(`"${name}"`);
    if (name && queries[0] !== name) queries.push(name);
    /** @type {string[]} */
    let imageHits = [];
    for (const q of queries.slice(0, 2)) {
      if (Date.now() >= deadlineAt - 5_000) break;
      imageHits = await searchDuckDuckGoImages(q, 8);
      if (imageHits.length) break;
    }
    if (imageHits.length) {
      const avatarUrl = await tryDownloadFirstImage(imageHits.slice(0, 4), contact.id, 'avatar', env);
      if (avatarUrl) patch.avatarUrl = avatarUrl;
    }
  }

  if ((force || emptyField(contact.avatarUrl)) && !patch.avatarUrl) {
    const neo = 'https://www.neoh2.com/wp-content/uploads/2020/04/J-Hasty.jpg';
    const name = String(contact.displayName || '').toLowerCase();
    if (name.includes('julia hasty') || name.includes('jay hasty')) {
      const avatarUrl = await tryDownloadImage(neo, contact.id, 'avatar', env);
      if (avatarUrl) patch.avatarUrl = avatarUrl;
    }
  }

  // Ensure org page exists when enrich finds an org name, then enrich the company.
  const orgName = String(patch.org || contact.org || '').trim();
  if (orgName) {
    try {
      const org = await ensureOrganizationByName(orgName, env);
      if (org) {
        patch.org = org.name;
        patch.orgId = org.id;
        // Background company enrich (don't block contact save on failure).
        enrichOrganization(org.id, {}, env).catch((e) => {
          console.warn('[network-enrich] org enrich failed', e?.message || e);
        });
      }
    } catch {
      // ignore
    }
  }

  const filled = markContactEnrichNeedsReview(patch);
  const updated = await updateContact(contactId, patch, env);
  // #region agent log
  void agentDbgEnrich({
    hypothesisId: 'C',
    location: 'network-enrich.js:enrichContact:done',
    message: 'web enrich completed',
    data: {
      contactId: String(contactId),
      filled,
      filledCount: filled.length,
      confidence: updated?.enrichment?.confidence ?? confidence,
      elapsedMs: Date.now() - startedAt,
      emptySuccess: filled.length === 0,
    },
  });
  // #endregion
  return { ok: true, contact: updated, filled };
}

/**
 * Flag autofilled enrichments for human review when any card fields changed.
 * @param {Record<string, unknown>} patch
 * @returns {string[]}
 */
function markContactEnrichNeedsReview(patch) {
  const filled = Object.keys(patch).filter((k) => k !== 'enrichment' && k !== 'source');
  // Any successful enrich write should flag the card for review (not only field fills).
  if (
    patch.enrichment &&
    typeof patch.enrichment === 'object' &&
    !Array.isArray(patch.enrichment)
  ) {
    /** @type {Record<string, unknown>} */ (patch.enrichment).needsReview = true;
  }
  return filled;
}

/**
 * Apply LLM-parsed contact fields onto a contact (fill empty unless force).
 * @param {object} contact
 * @param {object} parsed
 * @param {{ force?: boolean, sourceUrls?: string[], sourceLabel?: string }} opts
 */
function buildContactEnrichPatch(contact, parsed, opts = {}) {
  const force = Boolean(opts.force);
  const sourceUrls = Array.isArray(opts.sourceUrls) ? opts.sourceUrls : [];
  let confidence = null;
  if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
    confidence = Math.max(0, Math.min(1, parsed.confidence));
  }

  /** @type {Record<string, unknown>} */
  const patch = {
    enrichment: {
      sources: [
        ...new Set([
          ...(contact.enrichment?.sources || []),
          ...sourceUrls,
          ...((Array.isArray(parsed.urls) ? parsed.urls : []).filter((u) => /^https?:\/\//i.test(String(u)))),
        ]),
      ].slice(0, 30),
      enrichedAt: new Date().toISOString(),
      rawSummary: String(parsed.summary || parsed.bio || '').trim().slice(0, 4000) || contact.enrichment?.rawSummary || null,
      confidence: confidence ?? contact.enrichment?.confidence ?? null,
      lastMode: opts.sourceLabel || contact.enrichment?.lastMode || null,
    },
    source: contact.source === 'seed' ? 'seed' : 'enrich',
  };

  const maybeSet = (field, value) => {
    if (value == null) return;
    const s = Array.isArray(value)
      ? value.map((x) => String(x).trim()).filter(Boolean)
      : String(value).trim();
    if (Array.isArray(s) ? !s.length : !s) return;
    if (!force && !emptyField(contact[field])) return;
    patch[field] = s;
  };

  maybeSet('bio', parsed.bio || parsed.summary);
  maybeSet('org', parsed.org);
  maybeSet('title', parsed.title);
  maybeSet('department', parsed.department);
  maybeSet('location', parsed.location || parsed.region);
  maybeSet('address', parsed.address);
  maybeSet('rating', parsed.rating);
  maybeSet('relationshipStatus', parsed.relationshipStatus);
  maybeAppendOpenTask(contact, patch, parsed.nextStep, force);
  maybeSet('howWeMet', parsed.howWeMet);
  maybeSet('notes', parsed.notes);
  maybeSet('networkCircles', parsed.networkCircles);
  maybeSet('nickname', parsed.nickname);

  if (Array.isArray(parsed.aliases) && parsed.aliases.length) {
    const aliases = [
      ...new Set([...(contact.aliases || []), ...parsed.aliases.map((a) => String(a).trim()).filter(Boolean)]),
    ];
    if (force || emptyField(contact.aliases) || aliases.length > (contact.aliases || []).length) {
      patch.aliases = aliases;
    }
  }

  const channels = { ...contact.channels };
  let channelsChanged = false;
  const setChannel = (key, value) => {
    const s = String(value || '').trim();
    if (!s) return;
    if (!force && !emptyField(channels[key])) return;
    if (key === 'linkedin' && !profileUrlPlausiblyMatchesName(s, contact.displayName, contact.aliases)) {
      return;
    }
    channels[key] = s;
    channelsChanged = true;
  };
  setChannel('linkedin', parsed.linkedin);
  setChannel('email', parsed.email);
  setChannel('phone', parsed.phone);
  setChannel('officePhone', parsed.officePhone);
  {
    const profileUrls = [
      ...sourceUrls,
      ...((Array.isArray(parsed.urls) ? parsed.urls : []).map((u) => String(u).trim())),
    ].filter(
      (u) =>
        /^https?:\/\//i.test(String(u)) &&
        isPublicProfileUrl(u) &&
        profileUrlPlausiblyMatchesName(u, contact.displayName, contact.aliases),
    );
    const urlsMerged = [...new Set([...(channels.urls || []), ...profileUrls])].slice(0, 20);
    if (force || emptyField(channels.urls) || urlsMerged.length > (channels.urls || []).length) {
      channels.urls = urlsMerged;
      channelsChanged = true;
    }
  }
  if (channelsChanged) patch.channels = channels;
  return patch;
}

/**
 * Enrich a contact from freeform source text (emails, notes, transcripts, file text).
 * @param {string} contactId
 * @param {{ text: string, force?: boolean, card?: object, sourceLabel?: string, sourceUrls?: string[] }} opts
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function enrichContactFromText(contactId, opts = {}, env = process.env) {
  const force = Boolean(opts.force);
  const sourceText = String(opts.text || '').trim();
  if (!sourceText) return { ok: false, error: 'empty_text' };

  const stored = await getContactById(contactId, env);
  if (!stored) return { ok: false, error: 'not_found' };
  if (!openRouterKey(env)) return { ok: false, error: 'openrouter_not_configured', contact: stored };

  const contact = applyContactCardHints(stored, opts.card);
  const sourceLabel = String(opts.sourceLabel || 'text').trim() || 'text';

  const chat = await openRouterChatJson({
    env,
    models: modelChain(textModel(env), TEXT_FALLBACK_MODELS),
    temperature: 0.2,
    maxTokens: 4096,
    timeoutMs: 60_000,
    messages: [
      { role: 'system', content: CONTACT_ENRICH_SYSTEM },
      {
        role: 'user',
        content: `Contact to enrich (use these current card facts to disambiguate — do not discard known fields):
displayName: ${contact.displayName}
aliases: ${(contact.aliases || []).join(', ') || '(none)'}
org: ${contact.org || '(none)'}
title: ${contact.title || '(none)'}
location: ${contact.location || '(none)'}
address: ${contact.address || '(none)'}
email: ${contact.channels?.email || '(none)'}
phone: ${contact.channels?.phone || '(none)'}
officePhone: ${contact.channels?.officePhone || '(none)'}
linkedin: ${contact.channels?.linkedin || '(none)'}
howWeMet: ${contact.howWeMet || '(none)'}
notes: ${contact.notes || '(none)'}

Source (${sourceLabel}):
${sourceText.slice(0, 28_000)}`,
      },
    ],
  });

  if (!chat.ok) return { ok: false, error: chat.error || 'openrouter_failed', contact };
  const parsed = extractJsonObject(chat.content);
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'parse_failed', contact };

  const patch = buildContactEnrichPatch(contact, parsed, {
    force,
    sourceLabel,
    sourceUrls: opts.sourceUrls,
  });

  if ((force || emptyField(contact.avatarUrl)) && parsed.avatarImageUrl) {
    const avatarUrl = await tryDownloadImage(String(parsed.avatarImageUrl), contact.id, 'avatar', env);
    if (avatarUrl) patch.avatarUrl = avatarUrl;
  }

  const orgName = String(patch.org || contact.org || '').trim();
  if (orgName) {
    try {
      const org = await ensureOrganizationByName(orgName, env);
      if (org) {
        patch.org = org.name;
        patch.orgId = org.id;
      }
    } catch {
      // ignore
    }
  }

  const filled = markContactEnrichNeedsReview(patch);
  const updated = await updateContact(contactId, patch, env);
  return {
    ok: true,
    contact: updated,
    filled,
    mode: sourceLabel,
  };
}

/**
 * Enrich from an uploaded file (text, HTML, vCard, CSV, or image via vision).
 * @param {string} contactId
 * @param {{
 *   filename?: string,
 *   mimeType?: string,
 *   base64?: string,
 *   dataUrl?: string,
 *   force?: boolean,
 *   useImageAsAvatar?: boolean,
 *   preserveAvatar?: boolean,
 *   card?: object,
 * }} opts
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function enrichContactFromFile(contactId, opts = {}, env = process.env) {
  const stored = await getContactById(contactId, env);
  if (!stored) return { ok: false, error: 'not_found' };
  if (!openRouterKey(env)) return { ok: false, error: 'openrouter_not_configured', contact: stored };

  let mime = String(opts.mimeType || '').toLowerCase().trim();
  let b64 = String(opts.base64 || '').trim();
  const dataUrl = String(opts.dataUrl || '').trim();
  const filename = String(opts.filename || 'upload').trim() || 'upload';
  if (dataUrl.startsWith('data:')) {
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
    if (!m) return { ok: false, error: 'invalid_file' };
    mime = mime || m[1].toLowerCase();
    b64 = m[2];
  }
  if (!b64) return { ok: false, error: 'invalid_file' };

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return { ok: false, error: 'invalid_file' };
  }
  if (buf.length < 8 || buf.length > 8_000_000) return { ok: false, error: 'invalid_file_size' };

  const lowerName = filename.toLowerCase();
  const isImage =
    mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(lowerName);
  const isTextish =
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('csv') ||
    mime.includes('vcard') ||
    mime.includes('html') ||
    /\.(txt|md|csv|json|html?|vcf|vcard|log)$/i.test(lowerName);

  if (isImage) {
    const contact = applyContactCardHints(stored, opts.card);
    const dataUrlOut = `data:${mime.startsWith('image/') ? mime : 'image/jpeg'};base64,${b64}`;
    /** QR decode is deterministic — run before vision so card URLs are never missed. */
    let qr = { payloads: [], urls: [], emails: [], phones: [], linkedin: null };
    try {
      qr = await decodeContactQrFromImage(buf);
    } catch (e) {
      console.warn('[network-enrich] QR decode failed', e?.message || e);
    }
    const chat = await openRouterChatJson({
      env,
      models: modelChain(visionModel(env), VISION_FALLBACK_MODELS),
      temperature: 0.2,
      maxTokens: 4096,
      timeoutMs: 90_000,
      messages: [
        { role: 'system', content: CONTACT_ENRICH_SYSTEM },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Extract CRM fields for contact "${contact.displayName}" from this uploaded image/document scan (resume, bio card, flyer, screenshot). Current email: ${contact.channels?.email || '(none)'}.${
                qr.urls.length || qr.linkedin
                  ? ` A QR code on the image decoded to: ${[qr.linkedin, ...qr.urls].filter(Boolean).join(', ')} — include these on the card.`
                  : ''
              }`,
            },
            { type: 'image_url', image_url: { url: dataUrlOut } },
          ],
        },
      ],
    });
    if (!chat.ok) return { ok: false, error: chat.error || 'openrouter_failed', contact: stored };
    const parsed = extractJsonObject(chat.content);
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'parse_failed', contact: stored };
    const force = Boolean(opts.force);
    const preserveAvatar = Boolean(opts.preserveAvatar);
    const patch = buildContactEnrichPatch(contact, parsed, {
      force,
      sourceLabel: `file:${filename}`,
      sourceUrls: [...(qr.linkedin ? [qr.linkedin] : []), ...qr.urls],
    });
    applyQrFactsToContactPatch(contact, patch, qr);

    if (!preserveAvatar && (force || emptyField(contact.avatarUrl)) && parsed.avatarImageUrl) {
      const avatarUrl = await tryDownloadImage(String(parsed.avatarImageUrl), contact.id, 'avatar', env);
      if (avatarUrl) patch.avatarUrl = avatarUrl;
    }
    if (
      !preserveAvatar
      && (force || emptyField(contact.avatarUrl))
      && !patch.avatarUrl
      && opts.useImageAsAvatar
    ) {
      try {
        const updatedAvatar = await saveContactAvatar(
          contactId,
          { base64: b64, mimeType: mime.startsWith('image/') ? mime : 'image/jpeg' },
          env,
        );
        if (updatedAvatar?.avatarUrl) patch.avatarUrl = updatedAvatar.avatarUrl;
      } catch {
        // Avatar apply is best-effort.
      }
    }

    const orgName = String(patch.org || contact.org || '').trim();
    if (orgName) {
      try {
        const org = await ensureOrganizationByName(orgName, env);
        if (org) {
          patch.org = org.name;
          patch.orgId = org.id;
        }
      } catch {
        // ignore
      }
    }

    const filled = markContactEnrichNeedsReview(patch);
    const updated = await updateContact(contactId, patch, env);
    return {
      ok: true,
      contact: updated,
      mode: 'file',
      filename,
      filled,
      qrUrls: qr.urls,
      qrLinkedin: qr.linkedin,
    };
  }

  if (!isTextish) {
    // Best-effort UTF-8 decode for unknown types (e.g. .docx will be noisy — still try).
    const asText = buf.toString('utf8');
    if (!/[\x20-\x7e\n\r\t]{40}/.test(asText)) {
      return { ok: false, error: 'unsupported_file_type' };
    }
  }

  let text = buf.toString('utf8');
  if (mime.includes('html') || /\.html?$/i.test(lowerName)) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  text = text.replace(/\u0000/g, '').trim();
  if (text.length < 8) return { ok: false, error: 'empty_text' };

  return enrichContactFromText(
    contactId,
    {
      text,
      force: opts.force,
      card: opts.card,
      sourceLabel: `file:${filename}`,
    },
    env,
  );
}

/**
 * List shared Gmail messages with a contact (newest first), with offset/limit paging.
 * @param {string} contactId
 * @param {{ offset?: number, limit?: number, card?: object }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function listSharedEmailsForContact(contactId, opts = {}, env = process.env) {
  const stored = await getContactById(contactId, env);
  if (!stored) return { ok: false, error: 'not_found' };
  const contact = applyContactCardHints(stored, opts.card);

  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 10), 1), 20);
  // Oversample so calendar notifications can be stripped without short pages.
  const need = Math.min(Math.max(offset + limit + 1, 40), 100);

  const {
    fetchSharedEmailsWithContact,
    gmailExactMessageUrl,
    isCalendarNotificationEmail,
  } = await import('./events-finder-gmail.js');
  const found = await fetchSharedEmailsWithContact(
    {
      email: contact.channels?.email,
      displayName: contact.displayName,
      nickname: contact.nickname,
      aliases: contact.aliases,
    },
    env,
    { maxMessages: need, mode: 'list' },
  );
  if (!found.ok) {
    return {
      ok: false,
      error: found.error || 'no_shared_emails',
      detail: found.detail,
      contact: stored,
      messages: [],
      offset,
      limit,
      hasMore: false,
    };
  }

  const all = (Array.isArray(found.messages) ? found.messages : []).filter(
    (m) => !isCalendarNotificationEmail(m),
  );
  const page = all.slice(offset, offset + limit).map((m) => {
    const url = gmailExactMessageUrl({
      mailbox: m.mailbox,
      id: m.id,
      gmailId: m.gmailId,
      rfc822MessageId: m.rfc822MessageId,
    });
    return {
      id: m.id,
      mailbox: m.mailbox,
      subject: m.subject,
      from: m.from,
      to: m.to,
      date: m.date,
      snippet: m.snippet,
      url: url || null,
    };
  });

  return {
    ok: true,
    query: found.query,
    messages: page,
    offset,
    limit,
    hasMore: all.length > offset + limit,
    fetched: all.length,
  };
}

const RELATIONSHIP_SUMMARY_SYSTEM = `You summarize the relationship between Jay (the mailbox owner) and a CRM contact from their shared email history and card facts.
Return JSON only:
{
  "summary": string
}
Rules:
- Write 2–5 short paragraphs (or tight bullets) in plain language.
- Cover: how they know each other, topics they discuss, tone/closeness, notable collaborations or plans, and anything useful for follow-up.
- Stick to evidence in the emails and card; say when the record is thin.
- Do not invent private facts. Prefer "unclear" over guessing.
- Second person for Jay is fine ("you"), or neutral third person — stay consistent.`;

/**
 * Generate and save a relationship summary from shared emails + contact card.
 * @param {string} contactId
 * @param {{ card?: object, maxMessages?: number, force?: boolean }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function summarizeContactRelationship(contactId, opts = {}, env = process.env) {
  const stored = await getContactById(contactId, env);
  if (!stored) return { ok: false, error: 'not_found' };
  if (!openRouterKey(env)) return { ok: false, error: 'openrouter_not_configured', contact: stored };
  const contact = applyContactCardHints(stored, opts.card);

  const { fetchSharedEmailsWithContact } = await import('./events-finder-gmail.js');
  const found = await fetchSharedEmailsWithContact(
    {
      email: contact.channels?.email,
      displayName: contact.displayName,
      nickname: contact.nickname,
      aliases: contact.aliases,
    },
    env,
    { maxMessages: Math.min(Math.max(Number(opts.maxMessages) || 30, 1), 100) },
  );
  if (!found.ok) {
    return {
      ok: false,
      error: found.error || 'no_shared_emails',
      detail: found.detail,
      contact: stored,
    };
  }

  const deadlineAt = Date.now() + ENRICH_WALL_MS;
  const chat = await openRouterChatJson({
    env,
    models: modelChain(textModel(env), TEXT_FALLBACK_MODELS),
    temperature: 0.3,
    maxTokens: 2048,
    deadlineAt,
    messages: [
      { role: 'system', content: RELATIONSHIP_SUMMARY_SYSTEM },
      {
        role: 'user',
        content: `Contact card:
name: ${contact.displayName || '(unknown)'}
nickname: ${contact.nickname || '(none)'}
email: ${contact.channels?.email || '(none)'}
org / title: ${[contact.org, contact.title].filter(Boolean).join(' · ') || '(none)'}
relationshipStatus: ${contact.relationshipStatus || '(none)'}
howWeMet: ${contact.howWeMet || '(none)'}
bio: ${contact.bio || '(none)'}
notes: ${contact.notes || '(none)'}
existing relationshipSummary: ${
          contact.relationshipSummary ||
          (opts.card && opts.card.relationshipSummary != null
            ? String(opts.card.relationshipSummary)
            : '') ||
          '(none)'
        }

Shared emails (${Array.isArray(found.messages) ? found.messages.length : 0}, newest first):
${found.combinedText || '(none)'}`,
      },
    ],
  });

  if (!chat.ok) return { ok: false, error: chat.error || 'openrouter_failed', contact: stored, detail: chat.detail };
  const parsed = extractJsonObject(chat.content);
  const summaryRich = String(parsed?.summary || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 8000);
  if (!summaryRich) return { ok: false, error: 'parse_failed', contact: stored };

  return {
    ok: true,
    contact: stored,
    relationshipSummary: summaryRich,
    emailCount: Array.isArray(found.messages) ? found.messages.length : 0,
    model: chat.model,
  };
}

/**
 * Enrich from shared Gmail threads with this contact.
 * @param {string} contactId
 * @param {{ force?: boolean, card?: object, maxMessages?: number }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function enrichContactFromEmail(contactId, opts = {}, env = process.env) {
  const stored = await getContactById(contactId, env);
  if (!stored) return { ok: false, error: 'not_found' };
  const contact = applyContactCardHints(stored, opts.card);

  const { fetchSharedEmailsWithContact } = await import('./events-finder-gmail.js');
  const found = await fetchSharedEmailsWithContact(
    {
      email: contact.channels?.email,
      displayName: contact.displayName,
      aliases: contact.aliases,
    },
    env,
    { maxMessages: opts.maxMessages },
  );
  if (!found.ok) {
    return {
      ok: false,
      error: found.error || 'no_shared_emails',
      detail: found.detail,
      contact: stored,
    };
  }

  const result = await enrichContactFromText(
    contactId,
    {
      text: found.combinedText,
      force: opts.force,
      card: opts.card,
      sourceLabel: 'email',
    },
    env,
  );
  if (!result.ok) return result;
  return {
    ...result,
    emailCount: Array.isArray(found.messages) ? found.messages.length : 0,
    messages: found.messages,
  };
}

/**
 * Transcribe voice audio then enrich contact fields from the transcript.
 * @param {string} contactId
 * @param {{
 *   base64?: string,
 *   dataUrl?: string,
 *   mimeType?: string,
 *   filename?: string,
 *   force?: boolean,
 *   card?: object,
 * }} opts
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function enrichContactFromVoice(contactId, opts = {}, env = process.env) {
  const stored = await getContactById(contactId, env);
  if (!stored) return { ok: false, error: 'not_found' };
  if (!openRouterKey(env)) return { ok: false, error: 'openrouter_not_configured', contact: stored };

  let mime = String(opts.mimeType || 'audio/webm').toLowerCase();
  let b64 = String(opts.base64 || '').trim();
  const dataUrl = String(opts.dataUrl || '').trim();
  if (dataUrl.startsWith('data:')) {
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
    if (!m) return { ok: false, error: 'invalid_audio' };
    mime = m[1].toLowerCase();
    b64 = m[2];
  }
  if (!b64) return { ok: false, error: 'invalid_audio' };

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return { ok: false, error: 'invalid_audio' };
  }
  if (buf.length < 64 || buf.length > 12_000_000) return { ok: false, error: 'invalid_audio_size' };

  const { transcribeInviteAudio } = await import('./events-finder-invite-parse.js');
  const ext = mime.includes('mp4') || mime.includes('m4a')
    ? 'm4a'
    : mime.includes('mpeg') || mime.includes('mp3')
      ? 'mp3'
      : mime.includes('ogg')
        ? 'ogg'
        : mime.includes('wav')
          ? 'wav'
          : 'webm';
  const transcript = await transcribeInviteAudio(
    buf,
    { filename: opts.filename || `voice.${ext}`, mimeType: mime },
    env,
  );
  if (!transcript.ok) {
    return { ok: false, error: transcript.error || 'transcription_failed', contact: stored };
  }

  const result = await enrichContactFromText(
    contactId,
    {
      text: `Spoken notes about this contact (transcribed):\n${transcript.text}`,
      force: opts.force,
      card: opts.card,
      sourceLabel: 'voice',
    },
    env,
  );
  if (!result.ok) return result;
  return { ...result, transcript: transcript.text };
}

/**
 * @param {string} orgId
 * @param {{ force?: boolean, card?: object }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function enrichOrganization(orgId, opts = {}, env = process.env) {
  const force = Boolean(opts.force);
  const stored = await getOrganizationById(orgId, env);
  if (!stored) return { ok: false, error: 'not_found' };
  if (!openRouterKey(env)) return { ok: false, error: 'openrouter_not_configured', organization: stored };

  const org = (() => {
    const card = opts.card && typeof opts.card === 'object' ? opts.card : null;
    if (!card) return stored;
    return {
      ...stored,
      name: String(card.name || stored.name || '').trim() || stored.name,
      aliases: Array.isArray(card.aliases) ? card.aliases : stored.aliases,
      website: card.website != null ? String(card.website) : stored.website,
      description: card.description != null ? String(card.description) : stored.description,
      summary: card.summary != null ? String(card.summary) : stored.summary,
      location: card.location != null ? String(card.location) : stored.location,
      region: card.region != null ? String(card.region) : stored.region,
      industry: card.industry != null ? String(card.industry) : stored.industry,
      urls: [
        ...new Set([...(stored.urls || []), ...(Array.isArray(card.urls) ? card.urls : [])].filter(Boolean)),
      ].slice(0, 20),
    };
  })();

  const firmographicsPromise = fetchOrgFirmographics(
    { name: org.name, website: org.website, linkedin: org.linkedin },
    env,
  ).catch(() => ({ employeeCount: '', annualRevenue: '', sources: [], providers: [] }));

  const selectedQueries = sanitizeEnrichSearchQueries(opts.searchQueries);
  const searchQueries = selectedQueries != null ? selectedQueries : orgSearchQueries(org);
  const selectedFetchUrls = sanitizeEnrichFetchUrls(opts.fetchUrls);
  const knownUrls =
    selectedFetchUrls != null
      ? selectedFetchUrls
      : orgCandidateUrls(org).filter((u) => !/duckduckgo\.com/i.test(u));
  const discovered = await discoverUrlsFromQueries(searchQueries, 8);
  const urls = [...new Set([...knownUrls, ...discovered])].slice(0, 10);
  const pages = await fetchPages(urls);
  const pageImageUrls = prioritizeLogoUrls(
    [...new Set(pages.flatMap((p) => p.imageUrls || []))],
  ).slice(0, 24);
  const excerpt = pages
    .map((p) => {
      const imgs = prioritizeLogoUrls(p.imageUrls || [])
        .slice(0, 8)
        .join('\n  ');
      return `URL: ${p.url}\n${p.text.slice(0, 4000)}${imgs ? `\nImage URLs found on page:\n  ${imgs}` : ''}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 24_000);

  const deadlineAt = Date.now() + ENRICH_WALL_MS;
  const chat = await openRouterChatJson({
    env,
    models: modelChain(textModel(env), TEXT_FALLBACK_MODELS),
    temperature: 0.2,
    maxTokens: 4096,
    deadlineAt,
    messages: [
      { role: 'system', content: ORG_ENRICH_SYSTEM },
      {
        role: 'user',
        content: `Organization to enrich (use these current card facts to deepen search):
name: ${org.name}
aliases: ${(org.aliases || []).join(', ') || '(none)'}
summary: ${org.summary || '(none)'}
description: ${org.description || '(none)'}
industry: ${org.industry || '(none)'}
location: ${org.location || '(none)'}
website: ${org.website || '(none)'}
search queries used: ${searchQueries.join(' | ') || '(none)'}
known urls: ${urls.join(', ') || '(none)'}

Page excerpts:
${excerpt || '(no pages fetched — only high-confidence public facts; else null)'}`,
      },
    ],
  });

  if (!chat.ok) return { ok: false, error: chat.error || 'openrouter_failed', organization: org };
  const parsed = extractJsonObject(chat.content);
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'parse_failed', organization: org };

  let confidence = null;
  if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
    confidence = Math.max(0, Math.min(1, parsed.confidence));
  }

  /** @type {Record<string, unknown>} */
  const patch = {
    enrichment: {
      sources: [
        ...new Set([
          ...(org.enrichment?.sources || []),
          ...pages.map((p) => p.url),
          ...((Array.isArray(parsed.urls) ? parsed.urls : []).filter((u) => /^https?:\/\//i.test(String(u)))),
        ]),
      ].slice(0, 30),
      enrichedAt: new Date().toISOString(),
      rawSummary: String(parsed.summary || '').trim().slice(0, 4000) || org.enrichment?.rawSummary || null,
      confidence: confidence ?? org.enrichment?.confidence ?? null,
    },
    source: org.source === 'seed' ? 'seed' : 'enrich',
  };

  const maybeSet = (field, value) => {
    if (value == null) return;
    const s = Array.isArray(value)
      ? value.map((x) => String(x).trim()).filter(Boolean)
      : String(value).trim();
    if (Array.isArray(s) ? !s.length : !s) return;
    if (!force && !emptyField(org[field])) return;
    patch[field] = s;
  };

  maybeSet('description', parsed.description);
  maybeSet('summary', parsed.summary);
  maybeSet('website', parsed.website);
  maybeSet('location', parsed.location);
  maybeSet('region', parsed.region);
  maybeSet('type', parsed.type);
  maybeSet('industry', parsed.industry);
  maybeSet('ownership', parsed.ownership);
  maybeSet('accountSource', parsed.accountSource);
  maybeSet('rating', parsed.rating);
  maybeSet('annualRevenue', parsed.annualRevenue);
  maybeSet('employeeCount', parsed.employeeCount);

  // Structured firmographics beat LLM page-guesses when the card field was empty.
  const firm = await firmographicsPromise;
  if (firm.employeeCount && (force || emptyField(org.employeeCount))) {
    patch.employeeCount = firm.employeeCount;
  }
  if (firm.annualRevenue && (force || emptyField(org.annualRevenue))) {
    patch.annualRevenue = firm.annualRevenue;
  }
  if (firm.sources?.length) {
    const enrichment = /** @type {{ sources?: string[] }} */ (patch.enrichment || {});
    enrichment.sources = [...new Set([...(enrichment.sources || []), ...firm.sources])].slice(0, 30);
    patch.enrichment = enrichment;
  }

  maybeSet('fiscalYearEnd', parsed.fiscalYearEnd);
  maybeSet('competitiveNotes', parsed.competitiveNotes);
  maybeSet('phone', parsed.phone);
  maybeSet('email', parsed.email);
  maybeSet('linkedin', parsed.linkedin);
  maybeSet('locale', parsed.locale);
  maybeSet('partnerRelationships', parsed.partnerRelationships);
  maybeSet('lifecycleStatus', parsed.lifecycleStatus);
  maybeSet('nextStep', parsed.nextStep);

  if (Array.isArray(parsed.aliases) && parsed.aliases.length) {
    const aliases = [...new Set([...(org.aliases || []), ...parsed.aliases.map((a) => String(a).trim()).filter(Boolean)])];
    if (force || emptyField(org.aliases) || aliases.length > (org.aliases || []).length) {
      patch.aliases = aliases;
    }
  }
  if (Array.isArray(parsed.urls) && parsed.urls.length) {
    const urlsMerged = [
      ...new Set([
        ...(org.urls || []),
        ...parsed.urls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)),
      ]),
    ].slice(0, 20);
    if (force || emptyField(org.urls) || urlsMerged.length > (org.urls || []).length) {
      patch.urls = urlsMerged;
    }
  }
  if (Array.isArray(parsed.socialUrls) && parsed.socialUrls.length) {
    const socialMerged = [
      ...new Set([
        ...(org.socialUrls || []),
        ...parsed.socialUrls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)),
      ]),
    ].slice(0, 20);
    if (force || emptyField(org.socialUrls) || socialMerged.length > (org.socialUrls || []).length) {
      patch.socialUrls = socialMerged;
    }
  }

  if ((force || emptyField(org.logoUrl)) && parsed.logoImageUrl) {
    const logoUrl = await tryDownloadImage(String(parsed.logoImageUrl), org.id, 'logo', env);
    if (logoUrl) patch.logoUrl = logoUrl;
  }

  // Prefer logo / icon / og images from the company's own pages.
  if ((force || emptyField(org.logoUrl)) && !patch.logoUrl && pageImageUrls.length) {
    const logoUrl = await tryDownloadFirstImage(pageImageUrls, org.id, 'logo', env);
    if (logoUrl) patch.logoUrl = logoUrl;
  }

  // Clearbit-style host logo when website is known.
  if ((force || emptyField(org.logoUrl)) && !patch.logoUrl) {
    const website = String(patch.website || org.website || '').trim();
    const cb = clearbitLogoUrl(website);
    if (cb) {
      const logoUrl = await tryDownloadImage(cb, org.id, 'logo', env);
      if (logoUrl) patch.logoUrl = logoUrl;
    }
  }

  // DuckDuckGo Images: "Company Name" logo (reuse shared candidate helper).
  if ((force || emptyField(org.logoUrl)) && !patch.logoUrl) {
    const candidates = await searchOrgLogoCandidates(
      {
        ...org,
        website: String(patch.website || org.website || '').trim() || org.website,
        urls: Array.isArray(patch.urls) ? patch.urls : org.urls,
      },
      8,
      { pages },
      env,
    );
    // Skip page/clearbit URLs already attempted above; still try remaining (DDG).
    const tried = new Set(pageImageUrls);
    const website = String(patch.website || org.website || '').trim();
    const cb = clearbitLogoUrl(website);
    if (cb) tried.add(cb);
    const remaining = candidates.map((c) => c.url).filter((u) => !tried.has(u));
    if (remaining.length) {
      const logoUrl = await tryDownloadFirstImage(remaining, org.id, 'logo', env);
      if (logoUrl) patch.logoUrl = logoUrl;
    }
  }

  // Merge publicly named people found on company pages into suggestedPeople.
  if (Array.isArray(parsed.people) && parsed.people.length) {
    const existing = Array.isArray(org.suggestedPeople) ? [...org.suggestedPeople] : [];
    const byName = new Map(existing.map((p) => [String(p.name || '').toLowerCase(), p]));
    const dismissed = new Set(
      existing.filter((p) => p.status === 'dismissed').map((p) => String(p.name || '').toLowerCase()),
    );
    const nowIso = new Date().toISOString();
    for (const raw of parsed.people.slice(0, 20)) {
      if (!raw || typeof raw !== 'object') continue;
      const name = String(raw.name || '').replace(/\s+/g, ' ').trim();
      if (!name || name.length < 2) continue;
      const key = name.toLowerCase();
      if (!force && dismissed.has(key)) continue;
      const title = String(raw.title || '').replace(/\s+/g, ' ').trim();
      const linkedin = String(raw.linkedin || '').trim();
      const prev = byName.get(key);
      if (prev) {
        if (prev.status === 'dismissed' && !force) continue;
        byName.set(key, {
          ...prev,
          name: prev.name || name,
          title: prev.title || title || '',
          linkedin: prev.linkedin || (/^https?:\/\//i.test(linkedin) ? linkedin : null),
          status: prev.status === 'added' ? 'added' : 'pending',
        });
      } else {
        byName.set(key, {
          id: cryptoRandomId(),
          name,
          title: title || '',
          linkedin: /^https?:\/\//i.test(linkedin) ? linkedin : null,
          sourceUrl: pages[0]?.url || null,
          status: 'pending',
          foundAt: nowIso,
        });
      }
    }
    patch.suggestedPeople = [...byName.values()].slice(0, 40);
  }

  const updated = await updateOrganization(orgId, patch, env);
  return { ok: true, organization: updated, filled: Object.keys(patch).filter((k) => k !== 'enrichment' && k !== 'source') };
}

function cryptoRandomId() {
  return randomUUID();
}
