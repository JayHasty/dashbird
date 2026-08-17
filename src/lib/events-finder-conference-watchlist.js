/**
 * Research + 2-month heads-up cards for user-added big conferences / festivals.
 */
import { searchWeb, normalizeEventPageUrl } from './events-finder-event-url.js';
import {
  searchChromeResultUrls,
  searchChromeImageResults,
} from './chrome-web-search.js';
import {
  loadConferenceWatchlistStore,
  slugFromQuery,
  upsertConferenceWatchlistRecords,
  saveBigEventFlier,
} from './events-finder-conference-watchlist-store.js';
import { assertPublicHttpUrl } from './public-http-url.js';
import { braveApiEnabled, braveApiWebSearch, braveApiImageSearch } from './brave-search-api.js';
import {
  looksLikePasswordGate,
  cookieJarForPasswordSite,
} from './events-finder-site-unlock.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// Desktop Chrome UA (Windows). Many WAFs (Wordfence et al.) 403 headless/
// datacenter traffic that advertises "X11; Linux" — same fetch with a Windows
// Chrome UA succeeds. Keep this aligned with chrome-web-search.js.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/** Second-chance UA when the primary is blocked (403/429). */
const BROWSER_UA_FALLBACK =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** ~2 months before the event. */
export const CONFERENCE_HEADS_UP_MS = 60 * 24 * 60 * 60 * 1000;
const RESEARCH_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 24 * 60 * 60 * 1000;

const TEXT_FALLBACK_MODELS = [
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-20b:free',
  'openai/gpt-4o-mini',
];

const EXTRACT_SYSTEM = `You extract structured facts about a big conference or festival from web page text.
Return JSON only:
{
  "name": string,
  "url": string | null,
  "eventStart": "YYYY-MM-DD" | null,
  "eventEnd": "YYYY-MM-DD" | null,
  "venue": string | null,
  "city": string | null,
  "ticketPrice": string | null,
  "ticketSalesStart": "YYYY-MM-DD" | null,
  "earlyBirdPrice": string | null,
  "earlyBirdStart": "YYYY-MM-DD" | null,
  "earlyBirdEnd": "YYYY-MM-DD" | null,
  "notes": string | null
}
Report facts about the NEXT (upcoming) edition of the event.
Use ISO dates only. ticketPrice is the regular/standard ticket price as a short label like "$299" or "$120–$1,553".
ticketSalesStart is the date general/standard tickets go on sale for the upcoming edition (null if unknown or already on sale).
earlyBirdPrice is the cheaper early bird / advance ticket price if one is offered (e.g. "$99"); null if none.
If unsure, use null. Prefer the official event site over aggregators/resellers.`;

/** @type {Set<string>} */
const researchInFlight = new Set();

/** Spacing between web-search queries — keeps Brave under its bot-rate limit. */
const SEARCH_QUERY_DELAY_MS = 700;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeConferenceWatchlist(raw) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/\r?\n/)
      : [];
  for (const item of items) {
    const s = String(item || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 30) break;
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

/**
 * @param {string | null | undefined} ymd
 * @returns {number | null}
 */
function parseYmd(ymd) {
  const s = String(ymd || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T12:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const n = Number(dec);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

/**
 * Pull the social-share / preview image a page advertises for itself
 * (og:image, twitter:image, or <link rel="image_src">). This is the event's
 * own promo graphic and makes a far more reliable sidebar card image than a
 * separate poster image-search. Returns an absolute URL resolved against the
 * page, or null.
 * @param {string} html
 * @param {string} baseUrl
 * @returns {string | null}
 */
function extractOgImage(html, baseUrl) {
  const h = String(html || '');
  const patterns = [
    /<meta[^>]+(?:property|name)=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image(?::url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = h.match(re);
    if (m && m[1]) {
      const raw = m[1].trim();
      if (!raw) continue;
      try {
        return new URL(raw, baseUrl).toString();
      } catch {
        /* try next pattern */
      }
    }
  }
  return null;
}

/**
 * WordPress (and similar) often serve `-310x165` / `-scaled` crops in the HTML.
 * Prefer the full upload URL when the sized variant is what we scraped.
 * @param {string} url
 * @returns {string[]}
 */
function expandImageUrlVariants(url) {
  const s = String(url || '').trim();
  if (!s) return [];
  /** @type {string[]} */
  const out = [s];
  // Strip WordPress size suffix: name-1200x630.jpg → name.jpg
  const unsized = s.replace(/-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp|gif)(?:[?#]|$))/i, '');
  if (unsized !== s) out.push(unsized);
  // Strip -scaled before extension: name-scaled.png → name.png
  const unscaled = s.replace(/-scaled(?=\.(?:jpe?g|png|webp|gif)(?:[?#]|$))/i, '');
  if (unscaled !== s && !out.includes(unscaled)) out.push(unscaled);
  return out;
}

/**
 * When a page has no og:image (common on older WordPress event sites), pull the
 * best on-page promo images so cloud can still get a thumbnail without Brave /
 * headless image search.
 * @param {string} html
 * @param {string} baseUrl
 * @param {number} [limit]
 * @returns {string[]}
 */
function extractPageImages(html, baseUrl, limit = 8) {
  const h = String(html || '');
  if (!h) return [];
  let baseHost = '';
  try {
    baseHost = new URL(baseUrl).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    /* ignore */
  }
  /** @type {Map<string, number>} */
  const scored = new Map();
  const consider = (raw, bonus = 0) => {
    const s = String(raw || '').trim();
    if (!s || s.startsWith('data:')) return;
    let abs;
    try {
      abs = new URL(s, baseUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:\/\//i.test(abs)) return;
    const lower = abs.toLowerCase();
    if (!FLIER_IMAGE_EXT_RE.test(lower) && !/\/uploads\//i.test(lower)) return;
    if (/logo|icon|favicon|sprite|emoji|avatar|gravatar|wp-includes|1x1|pixel|tracking/i.test(lower)) {
      return;
    }
    let score = bonus;
    try {
      const host = new URL(abs).hostname.replace(/^www\./i, '').toLowerCase();
      if (baseHost && host === baseHost) score += 25;
      else if (baseHost && host.endsWith(`.${baseHost}`)) score += 10;
      else score -= 20; // off-site CDN noise
    } catch {
      return;
    }
    if (/header|hero|banner|feature|poster|flyer|flier|cover|promo|masthead/i.test(lower)) {
      score += 40;
    }
    if (/wp-content\/uploads/i.test(lower)) score += 8;
    // Prefer full-size over thumbnail crops.
    if (/-\d{2,4}x\d{2,4}\.(?:jpe?g|png|webp|gif)/i.test(lower)) score -= 15;
    for (const variant of expandImageUrlVariants(abs)) {
      const prev = scored.get(variant) || -Infinity;
      if (score > prev) scored.set(variant, score);
    }
  };

  for (const m of h.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    const dataSrc = tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1];
    const srcset = tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1];
    consider(src, 5);
    consider(dataSrc, 5);
    if (srcset) {
      // Take the last (usually largest) candidate in the srcset.
      const parts = srcset.split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
      if (parts.length) consider(parts[parts.length - 1], 8);
    }
  }
  for (const m of h.matchAll(/url\(\s*['"]?(https?:\/\/[^)'"\s]+\.(?:jpe?g|png|webp|gif)[^)'"\s]*)['"]?\s*\)/gi)) {
    consider(m[1], 3);
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Math.min(16, limit)))
    .map(([u]) => u);
}

/**
 * @param {string} url
 * @returns {Promise<{ text: string, ogImage: string | null }>}
 */
/**
 * Candidate URLs to try for a page scrape. Wikipedia / SERPs often hand us
 * `http://` official links; many hosts only serve (or only allow) HTTPS from
 * datacenter IPs, so always attempt the https upgrade as a second candidate.
 * @param {string} safeHref
 * @returns {string[]}
 */
function fetchPageCandidates(safeHref) {
  /** @type {string[]} */
  const out = [safeHref];
  try {
    const u = new URL(safeHref);
    if (u.protocol === 'http:') {
      const https = `https://${u.host}${u.pathname}${u.search}`;
      if (!out.includes(https)) out.push(https);
    }
  } catch {
    /* keep original only */
  }
  return out;
}

/**
 * @param {string} url
 * @param {{ password?: string | null, cookie?: string | null }} [opts]
 */
async function fetchPage(url, opts = {}) {
  const href = String(url || '').trim();
  if (!href) return { text: '', ogImage: null, pageImages: [] };
  // URLs here are user-pasted (manual add) or scraped from search results —
  // block private/link-local/metadata targets before requesting (SSRF).
  let safeHref;
  try {
    safeHref = await assertPublicHttpUrl(href);
  } catch {
    return { text: '', ogImage: null, pageImages: [] };
  }

  const candidates = fetchPageCandidates(safeHref);
  // Validate https upgrade through the same SSRF gate.
  /** @type {string[]} */
  const safeCandidates = [];
  for (const c of candidates) {
    try {
      safeCandidates.push(await assertPublicHttpUrl(c));
    } catch {
      /* skip */
    }
  }
  const uas = [BROWSER_UA, BROWSER_UA_FALLBACK];
  const passwordOverride = String(opts.password || '').trim() || null;
  /** @type {string | null} */
  let unlockedCookie = String(opts.cookie || '').trim() || null;

  for (const tryHref of safeCandidates) {
    for (const ua of uas) {
      try {
        /** @type {Record<string, string>} */
        const headers = {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': ua,
        };
        if (unlockedCookie) headers.Cookie = unlockedCookie;

        const r = await fetch(tryHref, {
          headers,
          signal: AbortSignal.timeout(12_000),
          redirect: 'follow',
        });
        if (!r.ok) {
          // Soft blocks are worth retrying with another UA / https; hard 404s aren't.
          if (r.status === 404 || r.status === 410) break;
          continue;
        }
        let html = await r.text();
        // Squarespace (and similar) lock screens — unlock once, then retry with cookie.
        if (!unlockedCookie && looksLikePasswordGate(html)) {
          unlockedCookie = await cookieJarForPasswordSite(
            tryHref,
            ua,
            passwordOverride,
            process.env,
          );
          if (unlockedCookie) {
            const unlocked = await fetch(tryHref, {
              headers: { ...headers, Cookie: unlockedCookie },
              signal: AbortSignal.timeout(12_000),
              redirect: 'follow',
            });
            if (unlocked.ok) {
              html = await unlocked.text();
              if (looksLikePasswordGate(html)) {
                continue;
              }
              const finalBase = unlocked.url || tryHref;
              return {
                text: htmlToText(html),
                ogImage: extractOgImage(html, finalBase),
                pageImages: extractPageImages(html, finalBase, 8),
                pageTitle: extractPageTitle(html),
                finalUrl: finalBase,
              };
            }
            continue;
          }
        }
        if (looksLikePasswordGate(html)) {
          // Known gate but no password / unlock failed — don't feed lock-screen text to LLM.
          continue;
        }
        const finalBase = r.url || tryHref;
        const text = htmlToText(html);
        const ogImage = extractOgImage(html, finalBase);
        // Sites without og:image still usually embed a header/feature upload —
        // collect those so thumbnail acquisition works without image-search APIs.
        const pageImages = extractPageImages(html, finalBase, 8);
        const pageTitle = extractPageTitle(html);
        return { text, ogImage, pageImages, pageTitle, finalUrl: finalBase };
      } catch {
        /* try next UA / URL candidate */
      }
    }
  }

  return { text: '', ogImage: null, pageImages: [], pageTitle: null, finalUrl: null };
}

/**
 * Pull a human event name from HTML title / og:title.
 * @param {string} html
 * @returns {string | null}
 */
function extractPageTitle(html) {
  const h = String(html || '');
  const og = h.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  ) || h.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
  );
  if (og?.[1]) return cleanPageTitle(og[1]);
  const t = h.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (t?.[1]) return cleanPageTitle(t[1]);
  return null;
}

/**
 * @param {string} raw
 * @returns {string | null}
 */
function cleanPageTitle(raw) {
  let s = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .trim();
  // Drop common " | Site" / " – Official" suffixes.
  s = s.split(/\s*[|–—•·]\s*/)[0].trim();
  s = s.replace(/\s*[-–—]\s*(home|official|tickets|welcome).*$/i, '').trim();
  if (s.length < 2) return null;
  return s.slice(0, 120);
}

/**
 * Resolve a producer from a pasted URL — name from page title / host, then
 * ready for research. No location filtering; rare festivals stay visible.
 * @param {string} rawUrl
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ ok: true, query: string, name: string, url: string, homepageUrl: string } | { ok: false, error: string }>}
 */
export async function probeProducerFromUrl(rawUrl, env = process.env) {
  void env;
  const href = String(rawUrl || '').trim();
  if (!href) return { ok: false, error: 'missing_url' };
  let normalized;
  try {
    const withProto = /^https?:\/\//i.test(href) ? href : `https://${href}`;
    normalized = await assertPublicHttpUrl(withProto);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  const page = await fetchPage(normalized);
  const finalUrl = page.finalUrl || normalized;
  let name = page.pageTitle || null;
  if (!name) {
    try {
      const host = new URL(finalUrl).hostname.replace(/^www\./, '');
      const base = host.split('.')[0] || host;
      name = base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    } catch {
      name = 'Producer event';
    }
  }
  const homepageUrl = homepageRootFromUrl(finalUrl) || finalUrl;
  return {
    ok: true,
    query: name,
    name,
    url: finalUrl,
    homepageUrl,
  };
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchPageText(url) {
  return (await fetchPage(url)).text;
}

/** Hosts that are never the official conference site. */
const OFFICIAL_NOISE_HOSTS = [
  'wikipedia.org', 'reddit.com', 'youtube.com', 'youtu.be', 'facebook.com',
  'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'tiktok.com',
  'medium.com', 'quora.com', 'tripadvisor.com', 'yelp.com', 'allevents.in',
  '10times.com', 'bizzabo.com', 'eventbrite.com', 'ticketmaster.com',
  'stubhub.com', 'viagogo.com', 'seatgeek.com', 'vividseats.com',
  'crunchbase.com', 'glassdoor.com', 'indeed.com', 'pinterest.com',
];

/** Tiny connectors skipped when building an event-name acronym (CES, SXSW, …). */
const ACRONYM_SKIP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'in', 'at', 'by', 'to', 'or']);

/**
 * Geographic / place tokens. When present we do NOT invent an acronym from
 * initials — "sesa san juan" must not become "ssj" (ssj.org.uk). The lead
 * brand token ("sesa") stays the name; place words only help ranking/domain
 * probes (sesapr.org).
 */
const PLACE_WORDS = new Set([
  'san', 'juan', 'los', 'angeles', 'las', 'vegas', 'new', 'york', 'porto', 'puerto',
  'rico', 'city', 'beach', 'springs', 'miami', 'orlando', 'chicago', 'austin',
  'denver', 'seattle', 'boston', 'atlanta', 'dallas', 'houston', 'phoenix',
  'oakland', 'francisco', 'diego', 'jose', 'nyc', 'la', 'sf', 'dc', 'uk', 'usa',
]);

/**
 * Place phrases → search expansions + domain abbreviations.
 * @type {Array<{ re: RegExp, expand: string[], abbrevs: string[] }>}
 */
const PLACE_PHRASES = [
  { re: /\bsan juan\b/i, expand: ['puerto rico', 'puerto rico summit'], abbrevs: ['pr', 'sju'] },
  { re: /\bpuerto rico\b/i, expand: ['san juan'], abbrevs: ['pr'] },
  { re: /\bnew york\b/i, expand: ['nyc'], abbrevs: ['nyc', 'ny'] },
  { re: /\bnew orleans\b/i, expand: ['nola'], abbrevs: ['nola'] },
  { re: /\blos angeles\b/i, expand: ['la'], abbrevs: ['la'] },
  { re: /\blas vegas\b/i, expand: [], abbrevs: ['vegas', 'lv'] },
  { re: /\bsan francisco\b/i, expand: ['sf'], abbrevs: ['sf'] },
];

/**
 * @param {string} query
 * @returns {string[]}
 */
function queryTokens(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  if (Math.abs(s.length - t.length) > 1) return 99;
  const rows = s.length + 1;
  const cols = t.length + 1;
  /** @type {number[]} */
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    /** @type {number[]} */
    const cur = [i];
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[t.length];
}

/**
 * Exact substring or 1-edit near-miss ("marti" ↔ "mardi" in a host/title).
 * @param {string} text
 * @param {string} token
 * @returns {boolean}
 */
function textContainsToken(text, token) {
  const t = String(token || '').toLowerCase();
  const raw = String(text || '').toLowerCase();
  if (!t || t.length <= 2) return false;
  if (raw.includes(t)) return true;
  if (t.length < 4) return false;
  const flat = raw.replace(/[^a-z0-9]/g, '');
  if (!flat) return false;
  if (flat.includes(t)) return true;
  for (let len = t.length - 1; len <= t.length + 1; len += 1) {
    if (len < 3) continue;
    for (let i = 0; i <= flat.length - len; i += 1) {
      if (editDistance(flat.slice(i, i + len), t) <= 1) return true;
    }
  }
  return false;
}

/**
 * Count significant query tokens that appear (exactly or fuzzy) in `text`.
 * @param {string} text
 * @param {string[]} tokens
 * @returns {number}
 */
function countTokenHits(text, tokens) {
  let n = 0;
  for (const t of tokens || []) {
    if (t.length > 2 && textContainsToken(text, t)) n += 1;
  }
  return n;
}

/**
 * Acronym of significant query words ("consumer electronics show" → "ces").
 * Returns "" when inventing an acronym would be misleading (brand + place).
 * @param {string[]} tokens
 * @returns {string}
 */
function queryAcronym(tokens) {
  const sig = tokens.filter((t) => t.length >= 2 && !ACRONYM_SKIP.has(t));
  if (sig.length < 3) return '';
  // Brand + place ("sesa san juan", "ces las vegas"): keep the lead brand; do
  // not mint ssj/clv from place initials.
  if (sig.some((t) => PLACE_WORDS.has(t))) return '';
  // Trailing acronym: "consumer electronics show ces" — last token is the
  // initials of the words before it. Minting ALL tokens wrongly yields "cesc".
  const lead = sig.slice(0, -1);
  if (lead.length >= 2) {
    const minted = lead.map((t) => t[0]).join('');
    const last = sig[sig.length - 1];
    if (last === minted) return last;
  }
  // Leading acronym: "ces consumer electronics show" — first token is the
  // initials of the words after it. Without this, minting all tokens → "cces"
  // and cces.org (schools) beats ces.tech.
  const tail = sig.slice(1);
  if (tail.length >= 2) {
    const minted = tail.map((t) => t[0]).join('');
    const first = sig[0];
    if (first.length >= 3 && first.length <= 6 && first === minted) return first;
  }
  return sig.map((t) => t[0]).join('');
}

/**
 * @param {string} query
 * @returns {{ expand: string[], abbrevs: string[] }}
 */
function placeHintsFromQuery(query) {
  const q = String(query || '').toLowerCase();
  /** @type {string[]} */
  const expand = [];
  /** @type {string[]} */
  const abbrevs = [];
  for (const p of PLACE_PHRASES) {
    if (!p.re.test(q)) continue;
    for (const e of p.expand) {
      if (!expand.includes(e)) expand.push(e);
    }
    for (const a of p.abbrevs) {
      if (!abbrevs.includes(a)) abbrevs.push(a);
    }
  }
  return { expand, abbrevs };
}

/**
 * @param {string} host
 * @param {string[]} tokens
 * @returns {number}
 */
function conferenceHostScore(host, tokens, query = '') {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  if (!h) return -Infinity;
  for (const n of OFFICIAL_NOISE_HOSTS) {
    if (h === n || h.endsWith(`.${n}`)) return -100;
  }
  let score = 0;
  const hostFlat = h.replace(/[^a-z0-9]/g, '');
  const nameFlat = tokens.join('');
  const label = h.split('.')[0] || '';
  const acronym = queryAcronym(tokens);
  // Official sites are often the acronym of the full name (ces.tech for
  // "Consumer Electronics Show") — without this, a partial token like
  // "consumer" wrongly elevates consumercellular.com over ces.tech.
  if (acronym.length >= 3 && (label === acronym || hostFlat === acronym)) {
    score += 55;
    // Exact acronym hosts: prefer real event TLDs (ces.tech) over lookalike
    // knockoffs (ces.ink "Asia CES") that also match every query token in title.
    if (/\.tech$/i.test(h)) score += 18;
    else if (/\.com$/i.test(h)) score += 10;
    else if (/\.org$/i.test(h)) score += 8;
    else if (/\.(ink|xyz|online|site|info|biz)$/i.test(h)) score -= 20;
  } else if (acronym.length >= 3 && hostFlat.startsWith(acronym) && label !== acronym) {
    // cesc.com starts with "ces" but is not the CES acronym host — smaller bump.
    score += 20;
  }
  if (nameFlat && (hostFlat.includes(nameFlat) || textContainsToken(hostFlat, nameFlat))) {
    score += 60;
  } else {
    // Length-weight token matches so a distinctive token ("sauce") counts far
    // more than a common one ("open"); avoids picking openai.com for "open sauce".
    // Fuzzy near-misses count too (marti ↔ mardi) so a typo'd query still
    // elevates mardigrasneworleans.com over unrelated Marti* brands.
    let hitLen = 0;
    let totalLen = 0;
    for (const t of tokens) {
      if (t.length <= 2) continue;
      totalLen += t.length;
      if (textContainsToken(hostFlat, t)) hitLen += t.length;
    }
    if (totalLen) score += (hitLen / totalLen) * 40;
  }
  // Brand + place domains: sesapr.org for "sesa san juan" / "sesa puerto rico".
  const brand = tokens.find((t) => t.length >= 3 && !PLACE_WORDS.has(t) && !ACRONYM_SKIP.has(t));
  const { abbrevs } = placeHintsFromQuery(query || tokens.join(' '));
  if (brand && abbrevs.length) {
    for (const ab of abbrevs) {
      if (hostFlat === `${brand}${ab}` || label === `${brand}${ab}` || label === `${brand}-${ab}`) {
        score += 70;
        break;
      }
      if (hostFlat.includes(brand) && hostFlat.includes(ab)) {
        score += 45;
        break;
      }
    }
  }
  if (/\.(?:com|org|net|io|co|tech|events?|fest|us)$/i.test(h)) score += 4;
  return score;
}

/**
 * Rank search hits and return the most likely official event site.
 * @param {string} query
 * @param {Array<{ url: string, title?: string }>} hits
 * @returns {string | null}
 */
export function pickOfficialSiteUrl(query, hits) {
  // Keep URL + pair pickers on the same acceptance bar.
  return pickOfficialSitePair(query, hits).homepageUrl;
}

/** Ticket / pricing / registration subpage path signals. */
const TICKET_PATH_RE =
  /(?:^|\/)(?:tickets?|ticketing|pricing|prices?|passes|pass|register|registration|admission|attend|rsvp|buy|purchase|checkout|box-?office|order)(?:[/?#]|-|$)/i;

/**
 * Resilient hit fetch for conference research/preview.
 *
 * Always merges DuckDuckGo/Yahoo (and Brave Search API when keyed) with the
 * headless-Chrome path. Chrome alone often falls back to Bing, which can return
 * a full page of irrelevant "first word" hits (e.g. consumercellular.com for
 * "consumer electronics show") — and the old `< 3 results` gate then skipped
 * DuckDuckGo, which ranks the real official site first.
 * @param {string} query
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{ url: string, title: string }>>}
 */
export async function searchConferenceHits(query, env = process.env, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const fast = opts.fast === true;
  /** @type {Array<{ url: string, title: string }>} */
  const out = [];
  const push = (rawUrl, title = '') => {
    const n = normalizeEventPageUrl(rawUrl);
    if (!n) return;
    if (out.some((x) => x.url === n)) return;
    out.push({ url: n, title: String(title || '') });
  };

  const [webHits, apiHits, chromeUrls] = await Promise.all([
    searchWeb(q).catch(() => []),
    braveApiEnabled(env)
      ? braveApiWebSearch(q, 8, env).catch(() => [])
      : Promise.resolve([]),
    fast
      ? Promise.resolve([])
      : searchChromeResultUrls(q, 8, env).catch(() => []),
  ]);

  // Prefer titled DDG/Yahoo + Brave API rows first so ranking has titles and so
  // hits[0] fallback is not Bing junk when scoring is inconclusive.
  for (const h of webHits || []) push(h.url, h.title);
  for (const h of apiHits || []) push(h.url, h.title);
  for (const u of chromeUrls || []) push(u);
  return out;
}

/**
 * Search query variants for finding an official conference/festival site.
 * Multi-word names also search their acronym (CES, SXSW) — many official
 * domains are the short form, and long-form queries confuse weaker engines.
 * @param {string} query
 * @param {number} year
 * @param {{ deep?: boolean }} [opts]
 * @returns {string[]}
 */
function conferenceSearchQueries(query, year, opts = {}) {
  const q = String(query || '').trim();
  const deep = opts.deep === true;
  const suggested = String(opts.suggestedQuery || '').trim();
  const tokens = queryTokens(q);
  const acronym = queryAcronym(tokens);
  const brand = tokens.find((t) => t.length >= 3 && !PLACE_WORDS.has(t) && !ACRONYM_SKIP.has(t));
  const { expand, abbrevs } = placeHintsFromQuery(q);
  /** @type {string[]} */
  const queries = deep
    ? [
        `${q} official website`,
        `${q} official site tickets ${year}`,
        `${q} ${year} tickets buy passes`,
        `${q} ${year + 1} tickets`,
        `${q} conference festival homepage`,
        `${q} summit conference ${year}`,
        `${q} event dates lineup ${year}`,
        `"${q}" official`,
      ]
    : [
        `${q} official site tickets ${year}`,
        `${q} conference festival official website`,
        `${q} summit conference official`,
        `${q} tickets ${year}`,
      ];
  if (suggested && suggested.toLowerCase() !== q.toLowerCase()) {
    queries.unshift(`${suggested} official website`);
    queries.splice(2, 0, `${suggested} official site tickets ${year}`);
  }
  // Place expansion: "sesa san juan" also searches "sesa puerto rico summit".
  if (brand && expand.length) {
    for (const place of expand) {
      queries.splice(1, 0, `${brand} ${place} official website`);
      queries.splice(2, 0, `${brand} ${place} summit conference`);
    }
  }
  // Brand + place abbrev domain-ish queries (sesapr / SESA-PR).
  if (brand && abbrevs.length) {
    for (const ab of abbrevs) {
      queries.push(`${brand}${ab} official`);
      queries.push(`${brand}-${ab} summit`);
    }
  }
  if (acronym.length >= 3 && acronym !== tokens.join('')) {
    // Insert early so a confident acronym hit can stop the preview loop sooner.
    queries.splice(1, 0, `${acronym} official website`);
    if (!queries.some((x) => x.includes(`"${q}"`))) {
      queries.push(`"${q}" official site`);
    }
  }
  return queries;
}

/**
 * Few query variants for the Add-event preview — run in parallel (HTML search
 * only, no Playwright) so the picker returns in a few seconds like Tool Library.
 * @param {string} query
 * @param {number} year
 * @param {{ suggestedQuery?: string }} [opts]
 * @returns {string[]}
 */
function previewSearchQueries(query, year, opts = {}) {
  const q = String(query || '').trim();
  const suggested = String(opts.suggestedQuery || '').trim();
  const tokens = queryTokens(q);
  const acronym = queryAcronym(tokens);
  const brand = tokens.find((t) => t.length >= 3 && !PLACE_WORDS.has(t) && !ACRONYM_SKIP.has(t));
  const { expand, abbrevs } = placeHintsFromQuery(q);
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const add = (s) => {
    const key = String(s || '').trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(String(s).trim());
  };
  // Spell-corrected / wiki-suggested form first so Bing (no autocorrect) still
  // finds the real event when the typed query is a near-miss typo.
  if (suggested) add(`${suggested} official website`);
  add(`${q} official website`);
  if (brand && expand.length) add(`${brand} ${expand[0]} official website`);
  if (brand && abbrevs.length) add(`${brand}${abbrevs[0]} official`);
  if (acronym.length >= 3 && acronym !== tokens.join('')) add(`${acronym} official website`);
  add(`${q} official site tickets ${year}`);
  if (suggested) add(`${suggested} official site tickets ${year}`);
  return out.slice(0, suggested ? 4 : 3);
}

/**
 * Merge search hit batches into one deduped list.
 * @param {Array<{ url: string, title: string }>} hits
 * @param {Array<Array<{ url: string, title: string }>>} batches
 */
function mergeSearchHits(hits, batches) {
  for (const batch of batches || []) {
    for (const h of batch || []) {
      if (!hits.some((x) => x.url === h.url)) hits.push(h);
    }
  }
}

/**
 * @param {string} query
 * @param {NodeJS.ProcessEnv} env
 * @param {number} year
 * @returns {Promise<{ hits: Array<{ url: string, title: string }>, pair: ReturnType<typeof pickOfficialSitePair>, ms: number }>}
 */
async function previewBigEventSearchFast(query, env, year) {
  const t0 = Date.now();
  const q = String(query || '').trim();
  // Cheap OpenSearch spell/title hint before SERPs — Bing will not rewrite
  // "marti gras" → "mardi gras" on its own.
  const suggested = await wikipediaSuggestedQuery(q);
  const queries = previewSearchQueries(q, year, { suggestedQuery: suggested });
  const tokens = queryTokens(q);
  const [searchBatches, probedBrand, probedName, probedAcronym] = await Promise.all([
    Promise.all(queries.map((sq) => searchConferenceHits(sq, env, { fast: true }))),
    probeBrandPlaceHomepage(q),
    // When datacenter Bing returns first-token junk and DDG is challenged,
    // concatenated-name domains (mardigrasneworleans.com) still resolve.
    probeNameFlatHomepage(q, suggested),
    // CES → ces.tech when Bing only returns consumercellular.com.
    probeAcronymHomepage(q),
  ]);
  /** @type {Array<{ url: string, title: string }>} */
  const hits = [];
  mergeSearchHits(hits, searchBatches);
  let pair = pickOfficialSitePair(q, hits);
  // Acronym probe is content-validated (ces.tech mentions consumer+electronics).
  // Prefer it over SERP lookalikes (ces.ink) that also match label===acronym.
  if (probedAcronym) {
    if (!hits.some((x) => x.url === probedAcronym)) {
      hits.unshift({ url: probedAcronym, title: suggested || q });
    }
    const scored = pickOfficialSitePair(q, hits);
    pair = {
      homepageUrl: probedAcronym,
      ticketUrl: scored.ticketUrl,
      officialHost: registrableDomain(new URL(probedAcronym).hostname),
      confident: true,
      bestScore: Math.max(scored.bestScore || 0, conferenceHostScore(
        new URL(probedAcronym).hostname,
        tokens,
        q,
      )),
    };
  } else {
    const probed = probedName || probedBrand;
    if (probed) {
      if (!hits.some((x) => x.url === probed)) {
        hits.unshift({ url: probed, title: suggested || q });
      }
      pair = pickOfficialSitePair(q, hits);
      if (!pair.confident && probedName) {
        const scored = pair;
        pair = {
          homepageUrl: probedName,
          ticketUrl: scored.ticketUrl,
          officialHost: registrableDomain(new URL(probedName).hostname),
          confident: true,
          bestScore: Math.max(scored.bestScore || 0, 70),
        };
      } else if (!pair.confident && probedBrand) {
        const scored = pair;
        pair = {
          homepageUrl: probedBrand,
          ticketUrl: scored.ticketUrl,
          officialHost: registrableDomain(new URL(probedBrand).hostname),
          confident: true,
          bestScore: Math.max(scored.bestScore || 0, 70),
        };
      }
    }
  }
  if (!pair.confident && pair.bestScore < MIN_OFFICIAL_ACCEPT_SCORE) {
    const wikiOfficial = await officialSiteFromWikipedia(q, hits);
    if (wikiOfficial) {
      if (!hits.some((x) => x.url === wikiOfficial)) {
        hits.unshift({ url: wikiOfficial, title: suggested || q });
      }
      pair = pickOfficialSitePair(q, hits);
    }
  }
  return { hits, pair, ms: Date.now() - t0 };
}

/** Common multi-label public suffixes so apex stripping keeps the real domain. */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.br',
  'co.jp', 'com.mx', 'co.za', 'com.sg', 'co.in',
]);

/**
 * Registrable apex domain for a host (strip subdomains, keep multi-part TLDs).
 * @param {string} host
 * @returns {string}
 */
function registrableDomain(host) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/**
 * Minimum host/title score before we trust a hit as the official site.
 * Partial first-word matches (consumercellular for "consumer electronics show")
 * land around ~18; real official domains (name-in-host or acronym) clear 40+.
 */
const MIN_OFFICIAL_ACCEPT_SCORE = 28;

/**
 * Select BOTH the official homepage root (dates live here) and the best ticketing
 * subpage (ticket/pricing info lives here) from ranked search hits.
 * @param {string} query
 * @param {Array<{ url: string, title?: string }>} hits
 * @returns {{ homepageUrl: string | null, ticketUrl: string | null, officialHost: string | null, confident: boolean, bestScore: number }}
 */
export function pickOfficialSitePair(query, hits) {
  const empty = {
    homepageUrl: null,
    ticketUrl: null,
    officialHost: null,
    confident: false,
    bestScore: -Infinity,
  };
  const tokens = queryTokens(query);
  const nameFlat = tokens.join('');
  const acronym = queryAcronym(tokens);
  /** @type {Array<{ url: string, u: URL, hostScore: number, score: number }>} */
  const scored = [];
  let best = null;
  let bestScore = -Infinity;
  for (const hit of hits || []) {
    const url = normalizeEventPageUrl(hit?.url);
    if (!url) continue;
    let u;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    const hostScore = conferenceHostScore(u.hostname, tokens, query);
    let score = hostScore;
    const title = String(hit?.title || '').toLowerCase();
    const thit = countTokenHits(title, tokens);
    if (tokens.length) score += (thit / tokens.length) * 15;
    if (
      acronym.length >= 3
      && new RegExp(`\\b${acronym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(title)
    ) {
      score += 12;
    }
    scored.push({ url, u, hostScore, score });
    if (score > bestScore) {
      bestScore = score;
      best = { url, u, score };
    }
  }
  if (!best) return empty;

  // Reject weak "first word" junk (Consumer Cellular for CES, etc.) instead of
  // surfacing it as a false-positive official site.
  if (bestScore < MIN_OFFICIAL_ACCEPT_SCORE) {
    return { ...empty, bestScore };
  }

  // Official domain = registrable apex of the best hit (e.g. profiles.burningman.org
  // and cart.sxsw.com both resolve to burningman.org / sxsw.com). The homepage is
  // the recognizable apex root — dates usually live there — even when search only
  // surfaced a subdomain/subpage.
  const officialHost = registrableDomain(best.u.hostname);
  let homepageUrl = null;
  for (const s of scored) {
    if (registrableDomain(s.u.hostname) !== officialHost) continue;
    const host = s.u.hostname.replace(/^www\./, '').toLowerCase();
    const path = s.u.pathname || '/';
    if (host === officialHost && (path === '/' || path === '')) {
      homepageUrl = `${s.u.origin}/`;
      break;
    }
  }
  if (!homepageUrl) homepageUrl = `https://${officialHost}/`;

  // Ticket URL: prefer a ticket-ish path on the same official domain; otherwise
  // a ticket-ish path on any other plausibly-official host.
  let ticketUrl = null;
  let ticketScore = -Infinity;
  for (const s of scored) {
    const path = s.u.pathname || '/';
    if (!TICKET_PATH_RE.test(`${path}${s.u.search}`)) continue;
    let ts;
    if (registrableDomain(s.u.hostname) === officialHost) ts = 100;
    else if (s.hostScore > 0) ts = 20;
    else continue;
    ts += Math.max(0, 60 - path.length);
    if (ts > ticketScore) {
      ticketScore = ts;
      ticketUrl = s.url;
    }
  }
  if (ticketUrl && ticketUrl.replace(/\/+$/, '') === homepageUrl.replace(/\/+$/, '')) {
    ticketUrl = null;
  }
  // Confident when the official domain embeds the flattened event name
  // (opensauce ⊂ opensauce.com) OR matches the name's acronym (ces ⊂ ces.tech).
  const officialFlat = officialHost.replace(/[^a-z0-9]/g, '');
  const officialLabel = officialHost.split('.')[0] || '';
  const confident = Boolean(
    (nameFlat && nameFlat.length >= 4 && officialFlat.includes(nameFlat))
    || (acronym.length >= 3 && officialLabel === acronym),
  );
  return { homepageUrl, ticketUrl, officialHost, confident, bestScore };
}

/**
 * Find a Wikipedia article URL whose slug/title matches the event query.
 * @param {string} query
 * @param {Array<{ url: string, title?: string }>} hits
 * @returns {string | null}
 */
function matchingWikipediaUrl(query, hits) {
  const tokens = queryTokens(query);
  const nameFlat = tokens.join('');
  const sig = tokens.filter((t) => t.length > 2);
  if (!nameFlat || nameFlat.length < 6) return null;
  let best = null;
  let bestOverlap = 0;
  for (const hit of hits || []) {
    const url = String(hit?.url || '').trim();
    if (!url) continue;
    let u;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (!/(^|\.)wikipedia\.org$/i.test(u.hostname)) continue;
    const rawSlug = decodeURIComponent((u.pathname.split('/') || []).pop() || '');
    if (!rawSlug || /^(File|Special|Help|Wikipedia|Template|Category):/i.test(rawSlug)) continue;
    const slug = rawSlug.replace(/_/g, ' ').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    const slugTokens = queryTokens(slug);
    const slugFlat = slugTokens.join('');
    if (!slugFlat) continue;
    if (slugFlat.includes(nameFlat) || nameFlat.includes(slugFlat)) {
      return normalizeEventPageUrl(url) || url;
    }
    const overlap = significantTokenOverlap(sig, slugTokens);
    if (overlap > bestOverlap && overlap >= Math.ceil(sig.length * 0.75)) {
      bestOverlap = overlap;
      best = normalizeEventPageUrl(url) || url;
    }
  }
  return best;
}

/**
 * Significant-token overlap with 1-edit near-miss tolerance (marti ↔ mardi).
 * @param {string[]} sig
 * @param {string[]} other
 * @returns {number}
 */
function significantTokenOverlap(sig, other) {
  const pool = Array.isArray(other) ? other : [];
  let n = 0;
  for (const t of sig || []) {
    if (t.length <= 2) continue;
    if (pool.some((u) => u === t || (t.length >= 4 && u.length >= 3 && editDistance(t, u) <= 1))) {
      n += 1;
    }
  }
  return n;
}

/**
 * Wikipedia OpenSearch often returns the correctly spelled event title for a
 * near-miss query ("marti gras new orleans" → "Mardi Gras in New Orleans").
 * Use that as an extra SERP query when Bing would otherwise return brand junk.
 * @param {string} query
 * @returns {Promise<string>}
 */
/**
 * @param {string} search
 * @returns {Promise<string[]>}
 */
async function wikipediaOpenSearchTitles(search) {
  const q = String(search || '').trim();
  if (!q) return [];
  const api =
    `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}`
    + '&limit=5&namespace=0&format=json';
  try {
    const safe = await assertPublicHttpUrl(api);
    const r = await fetch(safe, {
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data?.[1]) ? data[1].map((t) => String(t || '')) : [];
  } catch {
    return [];
  }
}

async function wikipediaSuggestedQuery(query) {
  const q = String(query || '').trim();
  if (!q) return '';
  try {
    const qTokens = queryTokens(q);
    const sig = qTokens.filter((t) => t.length > 2);
    if (!sig.length) return '';
    const acronym = queryAcronym(qTokens);
    // Full query often returns nothing when a trailing acronym is appended
    // ("consumer electronics show ces"); fall back to long form, then acronym.
    /** @type {string[]} */
    const searches = [q];
    if (acronym && qTokens[qTokens.length - 1] === acronym) {
      searches.push(qTokens.slice(0, -1).join(' '));
    }
    if (acronym) searches.push(acronym);
    /** @type {string[]} */
    let titles = [];
    let usedSearch = q;
    for (const s of searches) {
      if (!s || titles.length) continue;
      titles = await wikipediaOpenSearchTitles(s);
      if (titles.length) usedSearch = s;
    }
    const qNorm = qTokens.join(' ');
    for (const rawTitle of titles) {
      const title = String(rawTitle || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
      if (!title) continue;
      const titleTokens = queryTokens(title);
      // Drop filler words Wikipedia adds ("in", "the") for the search variant.
      const useful = titleTokens.filter((t) => t.length > 2 && !ACRONYM_SKIP.has(t));
      if (!useful.length) continue;
      const overlap = significantTokenOverlap(sig, titleTokens);
      // Acronym-only wiki hits ("CES") often share few long tokens — accept when
      // the title is the acronym or contains most of the long-form name.
      const acronymHit = acronym && (useful.join('') === acronym || titleTokens.includes(acronym));
      if (!acronymHit && overlap < Math.ceil(sig.length * 0.75)) continue;
      const suggested = useful.join(' ');
      if (!suggested || suggested === qNorm) continue;
      return suggested;
    }
  } catch {
    return '';
  }
  return '';
}

/**
 * Resolve a Wikipedia article URL via the public opensearch API when SERPs omit it.
 * @param {string} query
 * @returns {Promise<string | null>}
 */
async function wikipediaOpenSearchUrl(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const api =
    `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}`
    + '&limit=5&namespace=0&format=json';
  try {
    const safe = await assertPublicHttpUrl(api);
    const r = await fetch(safe, {
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const titles = Array.isArray(data?.[1]) ? data[1] : [];
    const urls = Array.isArray(data?.[3]) ? data[3] : [];
    const tokens = queryTokens(q);
    const nameFlat = tokens.join('');
    const sig = tokens.filter((t) => t.length > 2);
    for (let i = 0; i < urls.length; i += 1) {
      const title = String(titles[i] || '');
      const url = String(urls[i] || '');
      if (!url) continue;
      const titleTokens = queryTokens(title.replace(/\s*\([^)]*\)\s*/g, ' '));
      const titleFlat = titleTokens.join('');
      if (titleFlat.includes(nameFlat) || nameFlat.includes(titleFlat)) {
        return normalizeEventPageUrl(url) || url;
      }
      const overlap = significantTokenOverlap(sig, titleTokens);
      if (sig.length && overlap >= Math.ceil(sig.length * 0.75)) {
        return normalizeEventPageUrl(url) || url;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Pull the official website from a matching Wikipedia article when search engines
 * only return junk / aggregator hits. Wikipedia itself is never the event site,
 * but its infobox "Official website" link usually is (e.g. ces.tech).
 * @param {string} query
 * @param {Array<{ url: string, title?: string }>} hits
 * @returns {Promise<string | null>}
 */
/**
 * Whether a host is never a usable official event site (wiki/social/archives).
 * @param {string} host
 * @returns {boolean}
 */
function isWikipediaRecoveryNoiseHost(host) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  if (!h) return true;
  if (/wikipedia\.org$|wikimedia\.org$|archive\.org$|web\.archive\.org$/i.test(h)) return true;
  return OFFICIAL_NOISE_HOSTS.some((nHost) => h === nHost || h.endsWith(`.${nHost}`));
}

/**
 * Best external URL embedded in a Wikipedia article that looks like the event's
 * own site (infobox "Official website", or citation/JSON hosts that fuzzy-match
 * the query — Mardi Gras articles often lack a classic Official website row).
 * @param {string} html
 * @param {string} query
 * @returns {string | null}
 */
function pickOfficialUrlFromWikipediaHtml(html, query) {
  const patterns = [
    /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>\s*Official website/i,
    /Official website[\s\S]{0,200}?<a[^>]+href=["'](https?:\/\/[^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = String(html || '').match(re);
    if (!m?.[1]) continue;
    const n = normalizeEventPageUrl(m[1]);
    if (!n) continue;
    try {
      const host = new URL(n).hostname;
      if (isWikipediaRecoveryNoiseHost(host)) continue;
    } catch {
      continue;
    }
    return homepageRootFromUrl(n) || n;
  }

  const tokens = queryTokens(query);
  /** @type {Map<string, number>} */
  const hostScores = new Map();
  const consider = (raw) => {
    let href = String(raw || '').trim();
    if (!href) return;
    if (!/^https?:\/\//i.test(href)) href = `https://${href.replace(/^\/\//, '')}`;
    const n = normalizeEventPageUrl(href);
    if (!n) return;
    let host = '';
    try {
      host = new URL(n).hostname;
    } catch {
      return;
    }
    if (isWikipediaRecoveryNoiseHost(host)) return;
    const score = conferenceHostScore(host, tokens, query);
    if (score < MIN_OFFICIAL_ACCEPT_SCORE) return;
    const apex = registrableDomain(host);
    const prev = hostScores.get(apex) || -Infinity;
    if (score > prev) hostScores.set(apex, score);
  };

  for (const m of String(html || '').matchAll(/\bhttps?:\/\/[^\s"'<>\\]+/gi)) {
    consider(m[0].replace(/[),.;]+$/g, ''));
  }
  // Bare hosts in citation JSON / infobox text (www.mardigrasneworleans.com).
  for (const m of String(html || '').matchAll(
    /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|io|tech|events?|fest|us)\b/gi,
  )) {
    consider(m[0]);
  }

  let bestHost = '';
  let bestScore = -Infinity;
  for (const [apex, score] of hostScores) {
    if (score > bestScore) {
      bestScore = score;
      bestHost = apex;
    }
  }
  return bestHost ? `https://${bestHost}/` : null;
}

async function officialSiteFromWikipedia(query, hits) {
  let wikiUrl = matchingWikipediaUrl(query, hits);
  if (!wikiUrl) wikiUrl = await wikipediaOpenSearchUrl(query);
  if (!wikiUrl) return null;
  let safeHref;
  try {
    safeHref = await assertPublicHttpUrl(wikiUrl);
  } catch {
    return null;
  }
  try {
    const r = await fetch(safeHref, {
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return null;
    return pickOfficialUrlFromWikipediaHtml(await r.text(), query);
  } catch {
    return null;
  }
}

/**
 * Probe likely official domains built from the flattened event name
 * (mardigrasneworleans.com). Uses a Wikipedia-corrected spelling when the
 * typed query is a near-miss typo so Bing-only environments still recover.
 * @param {string} query
 * @param {string} [suggestedQuery]
 * @returns {Promise<string | null>}
 */
/**
 * When SERPs drown an acronym event (CES → consumercellular.com), probe the
 * short domain directly: ces.tech / ces.com. Requires a long-form name in the
 * query so random 3-letter tokens are not probed.
 * @param {string} query
 * @returns {Promise<string | null>}
 */
async function probeAcronymHomepage(query) {
  const q = String(query || '').trim();
  const tokens = queryTokens(q);
  const acronym = queryAcronym(tokens);
  if (!acronym || acronym.length < 3 || acronym.length > 6) return null;
  const longTokens = tokens.filter(
    (t) => t.length > 2 && t !== acronym && !ACRONYM_SKIP.has(t) && !PLACE_WORDS.has(t),
  );
  if (longTokens.length < 2) return null;

  const probeOne = async (url) => {
    let safe;
    try {
      safe = await assertPublicHttpUrl(url);
    } catch {
      return null;
    }
    const page = await fetchPage(safe);
    if (page.text.length < 160) return null;
    const host = (() => {
      try {
        return new URL(safe).hostname;
      } catch {
        return '';
      }
    })();
    if (!host) return null;
    const label = host.replace(/^www\./, '').split('.')[0] || '';
    if (label !== acronym) return null;
    const text = page.text.toLowerCase();
    if (!text.includes(acronym)) return null;
    const longHits = longTokens.filter((t) => textContainsToken(text.slice(0, 6000), t)).length;
    if (longHits < Math.min(2, longTokens.length)) return null;
    return homepageRootFromUrl(safe) || safe;
  };

  // Prefer .tech before .com/.org so CES resolves to ces.tech, not a race to
  // ces.org / a regional ces.* knockoff that happens to answer first.
  for (const tld of ['tech', 'com', 'org', 'net', 'io', 'events']) {
    for (const url of [`https://www.${acronym}.${tld}/`, `https://${acronym}.${tld}/`]) {
      const hit = await probeOne(url);
      if (hit) return hit;
    }
  }
  return null;
}

async function probeNameFlatHomepage(query, suggestedQuery = '') {
  const q = String(query || '').trim();
  const suggested = String(suggestedQuery || '').trim();
  /** @type {string[]} */
  const flats = [];
  const pushFlat = (raw) => {
    const tokens = queryTokens(raw).filter((t) => t.length > 2 && !ACRONYM_SKIP.has(t));
    if (tokens.length < 2) return;
    const flat = tokens.join('');
    if (flat.length >= 8 && flat.length <= 48 && !flats.includes(flat)) flats.push(flat);
  };
  pushFlat(suggested);
  pushFlat(q);
  if (!flats.length) return null;

  /** @type {string[]} */
  const candidates = [];
  for (const flat of flats.slice(0, 2)) {
    for (const tld of ['com', 'org', 'net']) {
      candidates.push(`https://www.${flat}.${tld}/`);
      candidates.push(`https://${flat}.${tld}/`);
    }
  }

  const scoreTokens = queryTokens(suggested || q);
  const probeOne = async (url) => {
    let safe;
    try {
      safe = await assertPublicHttpUrl(url);
    } catch {
      return null;
    }
    const page = await fetchPage(safe);
    if (page.text.length < 120) return null;
    const host = (() => {
      try {
        return new URL(safe).hostname;
      } catch {
        return '';
      }
    })();
    if (!host || conferenceHostScore(host, scoreTokens, suggested || q) < MIN_OFFICIAL_ACCEPT_SCORE) {
      return null;
    }
    const text = page.text.toLowerCase();
    const hits = countTokenHits(text.slice(0, 4000), scoreTokens);
    if (hits < Math.min(2, scoreTokens.filter((t) => t.length > 2).length)) return null;
    return homepageRootFromUrl(safe) || safe;
  };

  try {
    return await Promise.any(
      candidates.slice(0, 8).map((url) =>
        probeOne(url).then((r) => {
          if (!r) throw new Error('miss');
          return r;
        }),
      ),
    );
  } catch {
    return null;
  }
}

/**
 * Bare origin root ("https://host/") for any URL. Used to normalize a homepage.
 * @param {string | null | undefined} rawUrl
 * @returns {string | null}
 */
export function homepageRootFromUrl(rawUrl) {
  const n = normalizeEventPageUrl(rawUrl);
  if (!n) return null;
  try {
    return `${new URL(n).origin}/`;
  } catch {
    return null;
  }
}

/**
 * Add whole years to a YYYY-MM-DD date string.
 * @param {string | null | undefined} ymd
 * @param {number} years
 * @returns {string | null}
 */
function addYearsToYmd(ymd, years) {
  const s = String(ymd || '').trim().slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]) + Math.round(years);
  return `${String(y).padStart(4, '0')}-${m[2]}-${m[3]}`;
}

/** How many years to add so a past date lands on/after `nowMs`. */
function yearsUntilFuture(ymd, nowMs) {
  const ms = parseYmd(ymd);
  if (ms == null) return 0;
  if (ms >= nowMs) return 0;
  let add = 1;
  while (add < 25) {
    const rolled = parseYmd(addYearsToYmd(ymd, add));
    if (rolled != null && rolled >= nowMs) return add;
    add += 1;
  }
  return 1;
}

const FLIER_IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)(?:[?#]|$)/i;
const MAX_FLIER_BYTES = 6 * 1024 * 1024;

/**
 * Fetch an image URL into a Buffer, returning bytes + extension. Rejects
 * non-images, huge files, and tiny (likely-icon) payloads.
 * @param {string} url
 * @returns {Promise<{ buffer: Buffer, ext: string } | null>}
 */
async function fetchImageBuffer(url) {
  const href = String(url || '').trim();
  if (!/^https?:\/\//i.test(href)) return null;
  // The URL comes from image search or a scraped og:image tag (untrusted), so
  // block private/link-local/metadata targets before making the request (SSRF).
  /** @type {string[]} */
  const tryHrefs = [];
  for (const c of fetchPageCandidates(href)) {
    try {
      tryHrefs.push(await assertPublicHttpUrl(c));
    } catch {
      /* skip */
    }
  }
  if (!tryHrefs.length) return null;

  for (const safeHref of tryHrefs) {
    for (const ua of [BROWSER_UA, BROWSER_UA_FALLBACK]) {
      try {
        const r = await fetch(safeHref, {
          headers: {
            'User-Agent': ua,
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          signal: AbortSignal.timeout(12_000),
          redirect: 'follow',
        });
        if (!r.ok) {
          if (r.status === 404 || r.status === 410) break;
          continue;
        }
        const type = String(r.headers.get('content-type') || '').toLowerCase();
        if (type && !type.startsWith('image/')) continue;
        const ab = await r.arrayBuffer();
        const buffer = Buffer.from(ab);
        if (buffer.length < 3000 || buffer.length > MAX_FLIER_BYTES) continue;
        let ext = 'jpg';
        if (type.includes('png')) ext = 'png';
        else if (type.includes('webp')) ext = 'webp';
        else if (type.includes('gif')) ext = 'gif';
        else if (type.includes('jpeg') || type.includes('jpg')) ext = 'jpg';
        else {
          const m = safeHref.match(FLIER_IMAGE_EXT_RE);
          if (m) ext = m[1].toLowerCase().replace('jpeg', 'jpg');
        }
        return { buffer, ext };
      } catch {
        /* try next UA / URL */
      }
    }
  }
  return null;
}

/**
 * Find a flier / promotional graphic for the upcoming edition and download it.
 * @param {string} name
 * @param {number | null} eventYear
 * @param {string} slug
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string | null>} saved flier filename, or null
 */
async function findAndSaveFlier(name, eventYear, slug, env) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  const yr = Number.isFinite(Number(eventYear)) ? Number(eventYear) : new Date().getFullYear();
  const queries = [
    `${nm} ${yr} official poster flyer`,
    `${nm} ${yr} lineup poster`,
    `${nm} festival flyer`,
  ];
  for (const q of queries) {
    let hits = [];
    try {
      hits = await searchChromeImageResults(q, 8, {}, env);
    } catch {
      hits = [];
    }
    // Browser image search is empty on the slim cloud image — fall back to the
    // Brave image API (keyless-from-datacenter) so cloud can still grab a flier.
    if (!hits.length && braveApiEnabled(env)) {
      try {
        hits = await braveApiImageSearch(q, 8, env);
      } catch {
        hits = [];
      }
    }
    for (const hit of hits) {
      const img = await fetchImageBuffer(hit.url);
      if (!img) continue;
      const saved = await saveBigEventFlier(slug, img.buffer, img.ext, env).catch(() => null);
      if (saved) return saved;
    }
  }
  return null;
}

/**
 * Pull the first $ price (or range) from free text.
 * @param {string} text
 * @returns {string | null}
 */
function extractPriceLabel(text) {
  const m = String(text || '').match(
    /\$\s?\d[\d,]*(?:\.\d{2})?(?:\s*[-–—]\s*\$?\s?\d[\d,]*(?:\.\d{2})?)?/,
  );
  return m ? m[0].replace(/\s+/g, '') : null;
}

/**
 * Rank distinct official-site candidates for the Add-event picker when we are
 * not confident enough to auto-pick one URL.
 * @param {string} query
 * @param {Array<{ url: string, title?: string }>} hits
 * @param {number} [limit]
 * @returns {Array<{ url: string, title: string, score: number }>}
 */
export function rankOfficialSiteCandidates(query, hits, limit = 5) {
  const tokens = queryTokens(query);
  const acronym = queryAcronym(tokens);
  /** @type {Map<string, { url: string, title: string, score: number }>} */
  const byHost = new Map();
  for (const hit of hits || []) {
    const url = normalizeEventPageUrl(hit?.url);
    if (!url) continue;
    let u;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    const host = registrableDomain(u.hostname);
    if (!host) continue;
    // Skip pure noise aggregators / social for the picker shortlist.
    if (OFFICIAL_NOISE_HOSTS.some((n) => host === n || host.endsWith(`.${n}`))) continue;
    let score = conferenceHostScore(u.hostname, tokens, query);
    const title = String(hit?.title || '').trim();
    const titleLc = title.toLowerCase();
    const thit = countTokenHits(titleLc, tokens);
    if (tokens.length) score += (thit / tokens.length) * 15;
    if (
      acronym.length >= 3
      && new RegExp(`\\b${acronym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(titleLc)
    ) {
      score += 12;
    }
    // Soft floor: keep weakly related hits out of the picker.
    if (score < 8) continue;
    const home = homepageRootFromUrl(url) || `${u.origin}/`;
    const prev = byHost.get(host);
    if (!prev || score > prev.score) {
      byHost.set(host, {
        url: home,
        title: title.slice(0, 140) || host,
        score,
      });
    }
  }
  return [...byHost.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(8, limit)));
}

/**
 * When search engines drown a regional brand under unrelated acronym hits,
 * probe likely official domains: brand + place abbreviation (sesa + pr →
 * sesapr.org). Accept only if the live page mentions the brand and a place or
 * event keyword.
 * @param {string} query
 * @returns {Promise<string | null>}
 */
async function probeBrandPlaceHomepage(query) {
  const q = String(query || '').trim();
  const tokens = queryTokens(q);
  const brand = tokens.find((t) => t.length >= 3 && t.length <= 6 && !PLACE_WORDS.has(t) && !ACRONYM_SKIP.has(t));
  const { abbrevs, expand } = placeHintsFromQuery(q);
  if (!brand || !abbrevs.length) return null;

  /** @type {string[]} */
  const candidates = [];
  const push = (url) => {
    if (url && !candidates.includes(url)) candidates.push(url);
  };
  for (const ab of abbrevs) {
    for (const tld of ['org', 'com']) {
      push(`https://www.${brand}${ab}.${tld}/`);
      push(`https://${brand}${ab}.${tld}/`);
      push(`https://www.${brand}-${ab}.${tld}/`);
      push(`https://${brand}-${ab}.${tld}/`);
    }
  }

  const placeNeedles = [
    ...expand,
    ...abbrevs.filter((a) => a.length >= 2),
    ...tokens.filter((t) => PLACE_WORDS.has(t) && t.length > 2),
  ].map((s) => String(s).toLowerCase());

  const probeOne = async (url) => {
    let safe;
    try {
      safe = await assertPublicHttpUrl(url);
    } catch {
      return null;
    }
    const page = await fetchPage(safe);
    if (page.text.length < 160) return null;
    const text = page.text.toLowerCase();
    if (!text.includes(brand)) return null;
    const placeHit = placeNeedles.some((n) => n && text.includes(n));
    const eventHit = /\b(summit|conference|festival|symposium|expo|forum)\b/i.test(text);
    if (!placeHit && !eventHit) return null;
    return homepageRootFromUrl(safe) || safe;
  };

  const urls = candidates.slice(0, 6);
  if (!urls.length) return null;
  try {
    return await Promise.any(urls.map((url) => probeOne(url).then((r) => {
      if (!r) throw new Error('miss');
      return r;
    })));
  } catch {
    return null;
  }
}

/**
 * Search the web for a Big Event's official site (URL only — no snapshot). Used
 * by the "Add event → Search" preview step. In `deep` mode it runs more query
 * variants and inspects more hits so a "search again" can dig deeper when the
 * first pass could not find an official URL.
 * @param {string} query
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ deep?: boolean }} [opts]
 */
export async function previewBigEvent(query, env = process.env, opts = {}) {
  const q = String(query || '').trim().slice(0, 120);
  const slug = slugFromQuery(q);
  if (!slug) return { ok: false, error: 'invalid_query' };
  const deep = opts.deep === true;
  const year = new Date().getFullYear();
  /** @type {Array<{ url: string, title: string }>} */
  const hits = [];
  let pair = {
    homepageUrl: null,
    ticketUrl: null,
    officialHost: null,
    confident: false,
    bestScore: -Infinity,
  };
  let searchMs = 0;

  if (!deep) {
    const fast = await previewBigEventSearchFast(q, env, year);
    hits.push(...fast.hits);
    pair = fast.pair;
    searchMs = fast.ms;
  } else {
    const suggested = await wikipediaSuggestedQuery(q);
    const queries = conferenceSearchQueries(q, year, { deep, suggestedQuery: suggested });
    for (let i = 0; i < queries.length; i += 1) {
      if (i > 0) await sleep(SEARCH_QUERY_DELAY_MS);
      const batch = await searchConferenceHits(queries[i], env);
      for (const h of batch) {
        if (!hits.some((x) => x.url === h.url)) hits.push(h);
      }
      pair = pickOfficialSitePair(q, hits);
      if (pair.confident && !deep) break;
    }

    if (!pair.confident) {
      const wikiOfficial = await officialSiteFromWikipedia(q, hits);
      if (wikiOfficial) {
        if (!hits.some((x) => x.url === wikiOfficial)) {
          hits.unshift({ url: wikiOfficial, title: q });
        }
        pair = pickOfficialSitePair(q, hits);
      }
    }

    if (!pair.confident) {
      const probed = await probeBrandPlaceHomepage(q);
      if (probed) {
        if (!hits.some((x) => x.url === probed)) {
          hits.unshift({ url: probed, title: q });
        }
        const scored = pickOfficialSitePair(q, hits);
        pair = {
          homepageUrl: probed,
          ticketUrl: scored.ticketUrl,
          officialHost: registrableDomain(new URL(probed).hostname),
          confident: true,
          bestScore: Math.max(scored.bestScore || 0, 70),
        };
      }
    }
  }

  // Never fall back to hits[0] — that was returning Consumer Cellular etc.
  const homepageUrl = pair.homepageUrl || homepageRootFromUrl(pickOfficialSiteUrl(q, hits));
  const ticketUrl = pair.ticketUrl || null;
  // Ranked shortlist for the UI when we are not confident — Jay picks the right
  // one instead of us silently committing a wrong SERP hit.
  const candidates = rankOfficialSiteCandidates(q, hits, 5);
  if (homepageUrl && !candidates.some((c) => c.url === homepageUrl)) {
    candidates.unshift({
      url: homepageUrl,
      title: pair.officialHost || homepageUrl,
      score: pair.bestScore || 0,
    });
    if (candidates.length > 5) candidates.length = 5;
  }
  // Host-name embedding can look "confident" while several unrelated brands share
  // the same top score (e.g. query "summit"). Near-ties → show the picker.
  let confident = pair.confident === true;
  if (candidates.length >= 2) {
    const gap = (Number(candidates[0].score) || 0) - (Number(candidates[1].score) || 0);
    if (gap < 20) confident = false;
  }
  return {
    ok: true,
    slug,
    query: q,
    name: q,
    url: homepageUrl,
    homepageUrl,
    ticketUrl,
    deep,
    urlFound: Boolean(homepageUrl),
    confident,
    bestScore: Number.isFinite(pair.bestScore) ? pair.bestScore : null,
    candidates,
  };
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
 * @param {string} query
 * @param {Array<{ url: string, title: string, text: string }>} pages
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ correction?: { field?: string, message?: string } | null, fieldWires?: Record<string, { hint?: string, expectedValue?: string | null }> | null }} [opts]
 */
async function extractWithOpenRouter(query, pages, env = process.env, opts = {}) {
  const key = String(env.OPENROUTER_API_KEY || '').trim();
  if (!key || !pages.length) return null;

  const model = String(
    env.EVENTS_FINDER_CONFERENCE_MODEL
      || env.OPENROUTER_FREE_TEXT_MODEL
      || env.OPENROUTER_MODEL
      || 'openai/gpt-4o-mini',
  ).trim();
  const models = [model, ...TEXT_FALLBACK_MODELS.filter((m) => m !== model)];

  /** @type {Record<string, unknown>} */
  const payload = {
    query,
    pages: pages.map((p) => ({
      url: p.url,
      title: p.title.slice(0, 200),
      text: p.text.slice(0, 6000),
    })),
  };
  const correction = opts.correction;
  if (correction?.message) {
    payload.userCorrection = {
      field: correction.field || null,
      message: String(correction.message).slice(0, 500),
      instruction:
        'A human said the previous extraction was wrong. Find the value they describe on the pages and put the corrected value in the matching JSON field. Prefer their stated value when it appears on the page.',
    };
  }
  const wires = opts.fieldWires && typeof opts.fieldWires === 'object' ? opts.fieldWires : null;
  if (wires && Object.keys(wires).length) {
    payload.learnedWires = Object.entries(wires).map(([field, w]) => ({
      field,
      hint: String(w?.hint || '').slice(0, 400),
      lastCorrectValue: w?.expectedValue || null,
    }));
  }

  const system = correction?.message
    ? `${EXTRACT_SYSTEM}\n\nIMPORTANT: The user provided a correction in userCorrection — apply it. Locate the right figure/date on the pages so future scrapes can find it the same way.`
    : EXTRACT_SYSTEM;

  for (const m of models) {
    let r;
    try {
      r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
          'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-events-conference',
        },
        body: JSON.stringify({
          model: m,
          temperature: 0.2,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(payload) },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      continue;
    }
    if (!r.ok) continue;
    const j = await r.json().catch(() => null);
    const content = j?.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(typeof content === 'string' ? content : '');
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

/**
 * Lightweight regex fallback when OpenRouter is unavailable.
 * @param {string} query
 * @param {Array<{ url: string, title: string, text: string }>} pages
 */
function extractHeuristic(query, pages) {
  const blob = pages.map((p) => `${p.title}\n${p.text}`).join('\n');
  /** @type {Record<string, string | null>} */
  const out = {
    name: query,
    url: pages[0]?.url || null,
    eventStart: null,
    eventEnd: null,
    venue: null,
    city: null,
    ticketPrice: null,
    earlyBirdStart: null,
    earlyBirdEnd: null,
    notes: null,
  };

  const price = blob.match(/\$\s?\d[\d,]*(?:\.\d{2})?(?:\s*[-–—]\s*\$\s?\d[\d,]*(?:\.\d{2})?)?/);
  if (price) out.ticketPrice = price[0].replace(/\s+/g, '');

  const earlyBird = blob.match(/early\s+bird[^.\n]{0,120}/i);
  if (earlyBird) out.notes = earlyBird[0].trim().slice(0, 200);

  const isoDates = [...blob.matchAll(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g)]
    .map((m) => {
      const y = m[1];
      const mo = String(m[2]).padStart(2, '0');
      const d = String(m[3]).padStart(2, '0');
      return `${y}-${mo}-${d}`;
    })
    .filter((d, i, arr) => arr.indexOf(d) === i)
    .sort();
  if (isoDates.length) {
    out.eventStart = isoDates[0];
    if (isoDates.length > 1) out.eventEnd = isoDates[isoDates.length - 1];
  }

  const monthDates = [...blob.matchAll(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?,?\s+(20\d{2})\b/gi,
  )];
  if (!out.eventStart && monthDates.length) {
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const m = monthDates[0];
    const monKey = String(m[1]).slice(0, 3).toLowerCase();
    const mon = months[/** @type {keyof typeof months} */ (monKey)];
    if (mon != null) {
      const y = Number(m[4]);
      const d1 = Number(m[2]);
      const start = new Date(Date.UTC(y, mon, d1));
      if (Number.isFinite(start.getTime())) {
        out.eventStart = start.toISOString().slice(0, 10);
        const d2 = m[3] ? Number(m[3]) : null;
        if (d2) {
          const end = new Date(Date.UTC(y, mon, d2));
          if (Number.isFinite(end.getTime())) out.eventEnd = end.toISOString().slice(0, 10);
        }
      }
    }
  }

  return out;
}

/** First non-empty value from a list of candidates. */
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return v;
  }
  return null;
}

/**
 * @param {string} query
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ url?: string, homepageUrl?: string, ticketUrl?: string, screenshotPath?: string, force?: boolean, correction?: { field?: string, message?: string, expectedValue?: string | null } | null }} [opts]
 *   Seed from the Add-event preview. `force` re-researches even a hand-edited
 *   (manualEdit) record, clearing the lock. `correction` guides extraction after
 *   a user says a field was wrong (and learns a durable field wire).
 */
export async function researchConferenceQuery(query, env = process.env, opts = {}) {
  const q = String(query || '').trim().slice(0, 120);
  const slug = slugFromQuery(q);
  if (!slug) return { ok: false, error: 'invalid_query' };

  if (researchInFlight.has(slug)) return { ok: true, slug, skipped: true };
  researchInFlight.add(slug);
  const nowIso = new Date().toISOString();

  // Preserve any snapshot / user-picked URLs already on the record.
  const existingStore = await loadConferenceWatchlistStore(env);
  const existing = existingStore.bySlug[slug] || {};

  const seedHomepage =
    homepageRootFromUrl(opts.homepageUrl)
    || homepageRootFromUrl(existing.homepageUrl)
    || homepageRootFromUrl(opts.url)
    || homepageRootFromUrl(existing.url)
    || null;
  const seedTicket = normalizeEventPageUrl(opts.ticketUrl) || existing.ticketUrl || null;
  // The exact URL the user pasted (preserving its path) — a manually-added link
  // may point at a specific event page (Partiful/Luma/etc.) whose facts and
  // og:image live on that page, not the bare domain root.
  const seedExact = normalizeEventPageUrl(opts.url) || null;
  const seedUrl = seedHomepage || seedExact || existing.url || null;
  // A URL was handed to us for THIS call (manual entry or a confirmed preview) —
  // scrape it directly instead of spending web searches to rediscover it.
  const urlProvidedNow = Boolean(
    normalizeEventPageUrl(opts.url) || homepageRootFromUrl(opts.homepageUrl),
  );
  const correction = opts.correction && opts.correction.message
    ? {
        field: String(opts.correction.field || '').trim().slice(0, 40) || null,
        message: String(opts.correction.message).trim().slice(0, 500),
        expectedValue: opts.correction.expectedValue != null
          ? String(opts.correction.expectedValue).trim().slice(0, 160) || null
          : null,
      }
    : null;
  // Hand-edited records are locked: auto/daily research must not overwrite the
  // user's corrections. Exceptions: forced re-research, URL seed, or an explicit
  // correction pass (learns wires then unlocks).
  if (existing.manualEdit === true && opts.force !== true && !urlProvidedNow && !correction) {
    researchInFlight.delete(slug);
    return { ok: true, slug, skipped: true, manualEdit: true };
  }
  // Correction / force clears the lock so daily polls can keep following wires.
  const keepManualEdit =
    existing.manualEdit === true && opts.force !== true && !correction;
  let screenshotPath =
    String(opts.screenshotPath || '').trim() || existing.screenshotPath || null;

  /** @type {Record<string, { hint: string, expectedValue: string | null, learnedAt: string | null }>} */
  const fieldWires = {
    ...(existing.fieldWires && typeof existing.fieldWires === 'object' ? existing.fieldWires : {}),
  };
  if (correction) {
    const wireKey = correction.field || 'general';
    fieldWires[wireKey] = {
      hint: correction.message,
      expectedValue: correction.expectedValue,
      learnedAt: null,
    };
  }

  await upsertConferenceWatchlistRecords({
    [slug]: {
      ...existing,
      slug,
      query: q,
      name: existing.name || q,
      url: seedUrl,
      homepageUrl: seedHomepage,
      ticketUrl: seedTicket,
      screenshotPath,
      fieldWires,
      researching: true,
      researchedAt: nowIso,
    },
  }, env);

  try {
    const year = new Date().getFullYear();
    const queries = [
      ...conferenceSearchQueries(q, year),
      `${q} tickets pricing early bird ${year}`,
    ];
    /** @type {Array<{ url: string, title: string }>} */
    const hits = [];
    if (seedHomepage) hits.push({ url: seedHomepage, title: q });
    if (seedExact && seedExact !== seedHomepage) hits.push({ url: seedExact, title: q });
    if (seedTicket) hits.push({ url: seedTicket, title: `${q} tickets` });
    // Re-fetch known pages without searching once BOTH URLs are known — dates /
    // price changes show up on the same pages, and this keeps the recurring
    // daily poll well under any bot-rate limit. Still search when the ticket URL
    // hasn't been discovered yet so it can be filled in.
    if ((!seedHomepage || !seedTicket) && !urlProvidedNow) {
      for (let i = 0; i < queries.length; i += 1) {
        if (i > 0) await sleep(SEARCH_QUERY_DELAY_MS);
        const batch = await searchConferenceHits(queries[i], env);
        for (const h of batch) {
          if (!hits.some((x) => x.url === h.url)) hits.push(h);
        }
        if (pickOfficialSitePair(q, hits).confident) break;
      }
      // Acronym domains (ces.tech) often miss the SERP when Bing/Chrome goes
      // sideways — Wikipedia's official-website link is a durable fallback.
      if (!pickOfficialSitePair(q, hits).confident) {
        const wikiOfficial = await officialSiteFromWikipedia(q, hits);
        if (wikiOfficial && !hits.some((x) => x.url === wikiOfficial)) {
          hits.unshift({ url: wikiOfficial, title: q });
        }
      }
    }

    // Resolve BOTH pages: homepage (dates) + ticketing page (price/sales).
    const pair = pickOfficialSitePair(q, hits);
    const homepageUrl = seedHomepage || pair.homepageUrl || null;
    const ticketUrl = seedTicket || pair.ticketUrl || null;

    // Fetch homepage-first, then ticket page, then a couple more hits for redundancy.
    /** @type {Array<{ url: string, title: string, text: string }>} */
    const homePages = [];
    /** @type {Array<{ url: string, title: string, text: string }>} */
    const ticketPages = [];
    // Each fetched page advertises its own share graphic (og:image); collect them
    // in fetch order so a reliable event image can back the sidebar card when the
    // separate poster image-search comes up empty. The exact page the user linked
    // (seedExact) is fetched via the backfill loop, so its image is captured too.
    /** @type {string[]} */
    const ogImageCandidates = [];
    const pushOgImage = (src) => {
      const s = String(src || '').trim();
      if (s && !ogImageCandidates.includes(s)) ogImageCandidates.push(s);
    };
    /** Prefer og:image, then on-page promo images (header/feature uploads). */
    const pushPageImages = (page) => {
      pushOgImage(page?.ogImage);
      for (const src of page?.pageImages || []) pushOgImage(src);
    };
    if (homepageUrl) {
      const page = await fetchPage(homepageUrl);
      pushPageImages(page);
      if (page.text.length > 120) homePages.push({ url: homepageUrl, title: q, text: page.text });
    }
    if (ticketUrl && ticketUrl !== homepageUrl) {
      const page = await fetchPage(ticketUrl);
      pushPageImages(page);
      if (page.text.length > 120) {
        ticketPages.push({ url: ticketUrl, title: `${q} tickets`, text: page.text });
      }
    }
    // Backfill from other hits so extraction still has material if a primary
    // page is JS-heavy / empty.
    for (const h of hits) {
      if (homePages.length + ticketPages.length >= 5) break;
      if (h.url === homepageUrl || h.url === ticketUrl) continue;
      const page = await fetchPage(h.url);
      pushPageImages(page);
      if (page.text.length <= 120) continue;
      if (TICKET_PATH_RE.test(h.url) && ticketPages.length < 2) {
        ticketPages.push({ url: h.url, title: h.title || `${q} tickets`, text: page.text });
      } else if (homePages.length < 3) {
        homePages.push({ url: h.url, title: h.title || q, text: page.text });
      }
    }

    const extractOpts = { correction, fieldWires };
    const allPages = [...homePages, ...ticketPages];
    const homeParsed = homePages.length
      ? (await extractWithOpenRouter(q, homePages, env, extractOpts)) || extractHeuristic(q, homePages)
      : null;
    const ticketParsed = ticketPages.length
      ? (await extractWithOpenRouter(q, ticketPages, env, extractOpts)) || extractHeuristic(q, ticketPages)
      : null;

    // Merge across pages: dates/venue prefer the homepage; ticket price / early
    // bird prefer the ticketing page. Fall back either way when one is empty.
    const eventStart = normalizeYmd(firstNonEmpty(homeParsed?.eventStart, ticketParsed?.eventStart));
    const eventEnd = normalizeYmd(firstNonEmpty(homeParsed?.eventEnd, ticketParsed?.eventEnd));
    const venue = String(firstNonEmpty(homeParsed?.venue, ticketParsed?.venue) || '').trim().slice(0, 160) || null;
    const city = String(firstNonEmpty(homeParsed?.city, ticketParsed?.city) || '').trim().slice(0, 80) || null;
    const parsedName = String(firstNonEmpty(homeParsed?.name, ticketParsed?.name) || '').trim().slice(0, 160) || null;
    const notes = String(firstNonEmpty(homeParsed?.notes, ticketParsed?.notes) || '').trim().slice(0, 400) || null;
    const earlyBirdPrice =
      String(firstNonEmpty(ticketParsed?.earlyBirdPrice, homeParsed?.earlyBirdPrice) || '').trim().slice(0, 120) || null;
    const earlyBirdStart = normalizeYmd(firstNonEmpty(ticketParsed?.earlyBirdStart, homeParsed?.earlyBirdStart));
    const earlyBirdEnd = normalizeYmd(firstNonEmpty(ticketParsed?.earlyBirdEnd, homeParsed?.earlyBirdEnd));
    let ticketSalesStart = normalizeYmd(
      firstNonEmpty(ticketParsed?.ticketSalesStart, homeParsed?.ticketSalesStart),
    );

    let ticketPrice =
      String(firstNonEmpty(ticketParsed?.ticketPrice, homeParsed?.ticketPrice) || '').trim().slice(0, 120) || null;
    let ticketPriceEstimated = false;
    let estimatedFromYear = null;

    // No announced price for the upcoming edition → estimate from last year's edition.
    if (!ticketPrice) {
      const baseYear = eventStart ? Number(eventStart.slice(0, 4)) : year;
      const priorYear = (Number.isFinite(baseYear) ? baseYear : year) - 1;
      const estHits = await searchConferenceHits(`${q} ${priorYear} ticket price cost`, env);
      /** @type {Array<{ url: string, title: string, text: string }>} */
      const estPages = [];
      for (const h of estHits.slice(0, 4)) {
        const text = await fetchPageText(h.url);
        if (text.length > 120) estPages.push({ url: h.url, title: h.title || q, text });
        if (estPages.length >= 3) break;
      }
      const estAi = estPages.length
        ? await extractWithOpenRouter(`${q} ${priorYear}`, estPages, env)
        : null;
      const estPrice =
        (estAi && String(estAi.ticketPrice || '').trim())
        || extractPriceLabel(estPages.map((p) => p.text).join(' '));
      if (estPrice) {
        ticketPrice = String(estPrice).slice(0, 120);
        ticketPriceEstimated = true;
        estimatedFromYear = priorYear;
      }
    }

    // Never downgrade known-good data to null. Web-search result ordering is
    // non-deterministic (a pass can land on the JS-heavy homepage or a reseller
    // page with no dates/price), so when this pass comes back empty for a field,
    // keep the previously cached value instead of blanking it to "TBD".
    if (!ticketPrice && existing.ticketPrice) {
      ticketPrice = existing.ticketPrice;
      ticketPriceEstimated = existing.ticketPriceEstimated === true;
      estimatedFromYear = existing.estimatedFromYear ?? null;
    }

    // Resolve the NEXT edition's dates. If the best dates we found are already in
    // the past, first try a targeted next-year lookup; if that turns up nothing,
    // estimate the next edition as exactly one year after the previous one.
    const nowMs = Date.now();
    let finalStart = eventStart || existing.eventStart || null;
    let finalEnd = eventEnd || existing.eventEnd || null;
    let nextEditionEstimated = false;
    if (finalStart && parseYmd(finalStart) != null && parseYmd(finalStart) < nowMs) {
      const pastYear = Number(finalStart.slice(0, 4));
      const lookupYear = Math.max(pastYear + 1, new Date().getFullYear());
      let nextStart = null;
      let nextEnd = null;
      try {
        const nextHits = await searchConferenceHits(`${q} ${lookupYear} dates`, env);
        /** @type {Array<{ url: string, title: string, text: string }>} */
        const nextPages = [];
        for (const h of nextHits.slice(0, 4)) {
          const text = await fetchPageText(h.url);
          if (text.length > 120) nextPages.push({ url: h.url, title: h.title || q, text });
          if (nextPages.length >= 3) break;
        }
        const nextParsed = nextPages.length
          ? (await extractWithOpenRouter(`${q} ${lookupYear}`, nextPages, env))
            || extractHeuristic(`${q} ${lookupYear}`, nextPages)
          : null;
        const ns = normalizeYmd(nextParsed?.eventStart);
        if (ns && parseYmd(ns) != null && parseYmd(ns) >= nowMs) {
          nextStart = ns;
          nextEnd = normalizeYmd(nextParsed?.eventEnd);
        }
      } catch {
        /* fall through to estimate */
      }
      if (nextStart) {
        finalStart = nextStart;
        finalEnd = nextEnd || null;
      } else {
        // No announced next edition → assume one year (or more) after the last.
        const add = yearsUntilFuture(finalStart, nowMs) || 1;
        finalStart = addYearsToYmd(finalStart, add) || finalStart;
        finalEnd = finalEnd ? addYearsToYmd(finalEnd, add) : null;
        nextEditionEstimated = true;
      }
    }

    // Nail down WHEN tickets go on sale for the upcoming edition — this is what
    // the sidebar status pill shows. Only worth a targeted pass when the primary
    // pages didn't state it AND tickets aren't clearly on sale yet (price only
    // estimated from last year, or no price found). Keep it only if it lands in
    // the future so the pill can show a real "Tickets <date>" instead of the
    // generic "Not on sale yet".
    if (!ticketSalesStart && (ticketPriceEstimated || !ticketPrice)) {
      const salesYear = finalStart ? Number(finalStart.slice(0, 4)) : year;
      try {
        const salesHits = await searchConferenceHits(
          `${q} ${salesYear} when do tickets go on sale date`,
          env,
        );
        /** @type {Array<{ url: string, title: string, text: string }>} */
        const salesPages = [];
        for (const h of salesHits.slice(0, 4)) {
          const text = await fetchPageText(h.url);
          if (text.length > 120) salesPages.push({ url: h.url, title: h.title || q, text });
          if (salesPages.length >= 3) break;
        }
        const salesParsed = salesPages.length
          ? (await extractWithOpenRouter(`${q} ${salesYear}`, salesPages, env))
            || extractHeuristic(`${q} ${salesYear}`, salesPages)
          : null;
        const ss = normalizeYmd(salesParsed?.ticketSalesStart);
        // Only trust a genuinely future date — the point is to say when tickets
        // WILL go on sale. A past/"today" value is almost always a hallucination.
        if (ss && parseYmd(ss) != null && parseYmd(ss) > nowMs) ticketSalesStart = ss;
      } catch {
        /* leave ticketSalesStart null — pill falls back to a generic label */
      }
    }

    // Resolve the sidebar card image.
    // 1) Always try images we already scraped from the event pages (og:image +
    //    on-page header/feature uploads) whenever the card still has no flier —
    //    cheap, no search API, and recovers Add/Enrich even inside the 24h
    //    "already checked" window after a prior failed attempt.
    // 2) Fall back to poster image-search only when forced / freshly added
    //    (urlProvidedNow) / daily-stale, so cloud without Brave/Chromium isn't
    //    hammered on every poll.
    let flierPath = existing.flierPath || null;
    let flierCheckedAt = existing.flierCheckedAt || null;
    const flierCheckedMs = Date.parse(String(flierCheckedAt || ''));
    const flierStale =
      !Number.isFinite(flierCheckedMs) || nowMs - flierCheckedMs > RETRY_MS;
    const retryImageSearch =
      opts.force === true || flierStale || urlProvidedNow === true;
    if (!flierPath && ogImageCandidates.length) {
      for (const candidate of ogImageCandidates) {
        const img = await fetchImageBuffer(candidate);
        if (!img) continue;
        const saved = await saveBigEventFlier(slug, img.buffer, img.ext, env).catch(() => null);
        if (saved) {
          flierPath = saved;
          break;
        }
      }
      if (flierPath) flierCheckedAt = new Date().toISOString();
    }
    if (!flierPath && retryImageSearch) {
      const flierYear = finalStart ? Number(finalStart.slice(0, 4)) : new Date().getFullYear();
      const found = await findAndSaveFlier(parsedName || existing.name || q, flierYear, slug, env);
      if (found) flierPath = found;
      flierCheckedAt = new Date().toISOString();
    }

    const resolvedHomepage = homepageUrl || seedHomepage || existing.homepageUrl || null;

    // If the user stated an expected value in a correction, prefer it when the
    // scrape still missed — then mark the wire as learned so daily polls follow it.
    let finalTicketPrice = ticketPrice;
    let finalEarlyBirdPrice = earlyBirdPrice || existing.earlyBirdPrice || null;
    let finalNotes = notes || existing.notes || null;
    let finalStartOut = finalStart;
    let finalEndOut = finalEnd;
    if (correction?.expectedValue && correction.field) {
      const ev = correction.expectedValue;
      if (correction.field === 'ticketPrice') {
        finalTicketPrice = ev;
        ticketPriceEstimated = false;
        estimatedFromYear = null;
      } else if (correction.field === 'earlyBirdPrice') {
        finalEarlyBirdPrice = ev;
      } else if (correction.field === 'eventStart') {
        const ymd = normalizeYmd(ev);
        if (ymd) finalStartOut = ymd;
      } else if (correction.field === 'eventEnd') {
        const ymd = normalizeYmd(ev);
        if (ymd) finalEndOut = ymd;
      } else if (correction.field === 'notes') {
        finalNotes = ev;
      }
    }
    if (correction) {
      const wireKey = correction.field || 'general';
      const scrapedMatch = (() => {
        if (!correction.field) return true;
        const got = {
          ticketPrice: finalTicketPrice,
          earlyBirdPrice: finalEarlyBirdPrice,
          eventStart: finalStartOut,
          eventEnd: finalEndOut,
          notes: finalNotes,
          ticketSalesStart: ticketSalesStart || existing.ticketSalesStart || null,
          venue: venue || existing.venue || null,
          city: city || existing.city || null,
        }[correction.field];
        if (!correction.expectedValue) return Boolean(got);
        return String(got || '').toLowerCase().includes(
          String(correction.expectedValue).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40),
        ) || String(got || '').toLowerCase() === String(correction.expectedValue).toLowerCase();
      })();
      fieldWires[wireKey] = {
        hint: correction.message,
        expectedValue: correction.expectedValue
          || (correction.field === 'ticketPrice' ? finalTicketPrice : null)
          || null,
        learnedAt: scrapedMatch ? nowIso : null,
      };
    }

    // Dates went from TBD → set: stamp announcement time for the notify flag.
    let datesAnnouncedAt = existing.datesAnnouncedAt || null;
    if (!existing.eventStart && finalStartOut) {
      datesAnnouncedAt = nowIso;
    }

    const record = {
      slug,
      query: q,
      name: parsedName || existing.name || q,
      url: resolvedHomepage || existing.url || null,
      homepageUrl: resolvedHomepage,
      ticketUrl: ticketUrl || existing.ticketUrl || null,
      eventStart: finalStartOut,
      eventEnd: finalEndOut,
      venue: venue || existing.venue || null,
      city: city || existing.city || null,
      ticketPrice: finalTicketPrice,
      ticketPriceEstimated,
      estimatedFromYear,
      earlyBirdPrice: finalEarlyBirdPrice,
      earlyBirdStart: earlyBirdStart || existing.earlyBirdStart || null,
      earlyBirdEnd: earlyBirdEnd || existing.earlyBirdEnd || null,
      ticketSalesStart: ticketSalesStart || existing.ticketSalesStart || null,
      screenshotPath: screenshotPath || existing.screenshotPath || null,
      flierPath,
      flierCheckedAt,
      nextEditionEstimated,
      notes: finalNotes,
      planningNotes: existing.planningNotes || null,
      tripPlanning: existing.tripPlanning || null,
      reminderLeadDays: existing.reminderLeadDays ?? null,
      notifyWhenDatesSet: existing.notifyWhenDatesSet !== false,
      datesAnnouncedAt,
      fieldWires,
      researching: false,
      // Correction / force unlocks so wires keep tracking site changes.
      manualEdit: keepManualEdit,
      // Preserve user snooze/skip state across background re-research.
      snoozedUntil: existing.snoozedUntil || null,
      skipped: existing.skipped === true,
      error:
        finalStartOut || finalTicketPrice || allPages.length ? null : 'no_pages_found',
      researchedAt: nowIso,
    };

    await upsertConferenceWatchlistRecords({ [slug]: record }, env);
    return { ok: true, slug, record };
  } catch (e) {
    await upsertConferenceWatchlistRecords({
      [slug]: {
        ...existing,
        slug,
        query: q,
        name: existing.name || q,
        url: seedUrl,
        homepageUrl: seedHomepage,
        ticketUrl: seedTicket,
        screenshotPath,
        manualEdit: keepManualEdit,
        researching: false,
        error: String(e?.message || e || 'research_failed').slice(0, 200),
        researchedAt: nowIso,
      },
    }, env);
    return { ok: false, error: String(e?.message || e) };
  } finally {
    researchInFlight.delete(slug);
  }
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeYmd(raw) {
  const s = String(raw || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Number.isFinite(Date.parse(`${s}T12:00:00Z`)) ? s : null;
}

/**
 * @param {object} record
 * @param {Date} [now]
 */
export function buildEarlyBirdLine(record, now = new Date()) {
  const t = now.getTime();
  const ebStart = parseYmd(record.earlyBirdStart);
  const ebEnd = parseYmd(record.earlyBirdEnd);
  if (ebStart && t < ebStart) {
    return { kind: 'upcoming', text: `Early bird tickets start ${formatMd(record.earlyBirdStart)}` };
  }
  if (ebStart && ebEnd && t >= ebStart && t < ebEnd) {
    return { kind: 'active', text: `Early bird ends ${formatMd(record.earlyBirdEnd)}` };
  }
  if (ebEnd && t >= ebEnd) {
    return { kind: 'ended', text: record.ticketPrice ? String(record.ticketPrice) : 'Early bird ended' };
  }
  if (record.ticketPrice) {
    return { kind: 'price', text: String(record.ticketPrice) };
  }
  return null;
}

/**
 * Human status for where ticket sales stand for the upcoming edition.
 * @param {object} record
 * @param {Date} [now]
 * @returns {{ text: string, kind: 'pending'|'onsale'|'earlybird'|'soon'|'ended'|'unknown' }}
 */
export function buildTicketSalesStatus(record, now = new Date()) {
  if (record.researching) return { text: 'Checking…', kind: 'pending' };
  const t = now.getTime();
  const DAY = 24 * 60 * 60 * 1000;
  const startMs = parseYmd(record.eventStart);
  const endMs = parseYmd(record.eventEnd) || startMs;
  const ebStart = parseYmd(record.earlyBirdStart);
  const ebEnd = parseYmd(record.earlyBirdEnd);

  const salesStart = parseYmd(record.ticketSalesStart);

  if (endMs && t > endMs + DAY) return { text: 'Event passed', kind: 'ended' };
  if (ebStart && t < ebStart) return { text: 'Early bird soon', kind: 'soon' };
  if (ebStart && ebEnd && t >= ebStart && t < ebEnd) {
    return { text: 'Early bird on sale', kind: 'earlybird' };
  }
  // A known future on-sale date → show WHEN tickets go on sale.
  if (salesStart && t < salesStart) {
    return { text: `On sale ${formatMd(record.ticketSalesStart)}`, kind: 'soon' };
  }
  // Price only found on last year's edition → this year isn't on sale yet.
  if (record.ticketPriceEstimated) return { text: 'Not on sale yet', kind: 'soon' };
  if (record.ticketPrice) return { text: 'On sale', kind: 'onsale' };
  return { text: 'Unknown', kind: 'unknown' };
}

/**
 * @param {string | null | undefined} ymd
 */
function formatMd(ymd) {
  const ms = parseYmd(ymd);
  if (!ms) return String(ymd || '');
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return String(ymd);
  }
}

/**
 * @param {object} record
 * @param {Date} [now]
 */
export function isConferenceHeadsUpActive(record, now = new Date()) {
  if (record.researching) return true;
  if (record.skipped === true) return false;
  if (record.snoozedUntil && Date.parse(String(record.snoozedUntil)) > now.getTime()) {
    return false;
  }
  const t = now.getTime();
  const leadMs =
    record.reminderLeadDays != null && Number.isFinite(Number(record.reminderLeadDays))
      ? Number(record.reminderLeadDays) * 24 * 60 * 60 * 1000
      : CONFERENCE_HEADS_UP_MS;

  // Waiting for dates to be announced — stay visible until they land.
  if (record.notifyWhenDatesSet === true && !record.eventStart) return true;

  // Freshly announced dates — keep reminding for two weeks.
  const announcedMs = Date.parse(String(record.datesAnnouncedAt || ''));
  if (Number.isFinite(announcedMs) && t - announcedMs < 14 * 24 * 60 * 60 * 1000) {
    return true;
  }

  /** @param {string | null | undefined} ymd */
  const inLeadWindow = (ymd) => {
    const ms = parseYmd(ymd);
    if (!ms) return false;
    return t >= ms - leadMs && t <= ms + 24 * 60 * 60 * 1000;
  };

  if (inLeadWindow(record.ticketSalesStart)) return true;
  if (inLeadWindow(record.earlyBirdStart)) return true;

  const startMs = parseYmd(record.eventStart);
  const endMs = parseYmd(record.eventEnd) || startMs;
  if (startMs) {
    const windowStart = startMs - leadMs;
    const windowEnd = (endMs || startMs) + 24 * 60 * 60 * 1000;
    if (t >= windowStart && t <= windowEnd) return true;
    return false;
  }
  // No event date yet — keep visible while we research / user just added it.
  const researchedAt = Date.parse(String(record.researchedAt || ''));
  if (!Number.isFinite(researchedAt)) return true;
  return t - researchedAt < 14 * 24 * 60 * 60 * 1000;
}

/**
 * @param {object} record
 * @param {Date} [now]
 */
export function conferenceRecordToHeadsUp(record, now = new Date()) {
  const eb = buildEarlyBirdLine(record, now);
  const startMs = parseYmd(record.eventStart);
  const endMs = parseYmd(record.eventEnd);
  /** @type {string[]} */
  const whenBits = [];
  if (record.eventStart) {
    const range =
      endMs && endMs !== startMs
        ? `${formatMd(record.eventStart)} – ${formatMd(record.eventEnd)}`
        : formatMd(record.eventStart);
    whenBits.push(record.nextEditionEstimated ? `${range} (est.)` : range);
  } else {
    whenBits.push('Dates TBD');
  }
  const placeBits = [record.venue, record.city].filter(Boolean);

  // "Tickets go on sale …" line for the upcoming edition, when known & future.
  let salesStartLine = null;
  const salesStartMs = parseYmd(record.ticketSalesStart);
  if (salesStartMs && now.getTime() < salesStartMs) {
    salesStartLine = `Tickets on sale ${formatMd(record.ticketSalesStart)}`;
  }

  const priceEstimated = record.ticketPriceEstimated === true;
  let ticketLabel = null;
  if (record.ticketPrice) {
    ticketLabel = priceEstimated
      ? `${record.ticketPrice} (estimated from last year)`
      : String(record.ticketPrice);
  }
  let earlyBirdNote = null;
  if (record.earlyBirdPrice) {
    const ebp = String(record.earlyBirdPrice);
    earlyBirdNote =
      record.ticketPrice && ebp !== String(record.ticketPrice)
        ? `Early bird ${ebp} (vs ${record.ticketPrice})`
        : `Early bird ${ebp}`;
  }
  const screenshotUrl = record.screenshotPath
    ? `/api/events-finder/big-events/shot/${encodeURIComponent(record.screenshotPath)}`
    : null;
  const flierUrl = record.flierPath
    ? `/api/events-finder/big-events/shot/${encodeURIComponent(record.flierPath)}`
    : null;
  const sales = buildTicketSalesStatus(record, now);

  return {
    id: `conference-watch:${record.slug}`,
    slug: record.slug,
    query: record.query,
    title: record.name || record.query,
    url: record.homepageUrl || record.url || '',
    homepageUrl: record.homepageUrl || record.url || null,
    ticketUrl: record.ticketUrl || null,
    start: record.eventStart ? `${record.eventStart}T12:00:00.000Z` : null,
    end: record.eventEnd ? `${record.eventEnd}T12:00:00.000Z` : null,
    // Raw YYYY-MM-DD values for the edit form.
    eventStart: record.eventStart || null,
    eventEnd: record.eventEnd || null,
    manualEdit: record.manualEdit === true,
    venue: record.venue || null,
    city: record.city || null,
    whenLabel: whenBits.join(' · '),
    placeLabel: placeBits.join(' · ') || null,
    ticketPrice: record.ticketPrice || null,
    ticketLabel,
    priceEstimated,
    estimatedFromYear: record.estimatedFromYear || null,
    earlyBirdPrice: record.earlyBirdPrice || null,
    earlyBirdNote,
    earlyBirdStart: record.earlyBirdStart || null,
    earlyBirdEnd: record.earlyBirdEnd || null,
    earlyBirdLine: eb?.text || null,
    earlyBirdKind: eb?.kind || null,
    ticketSalesStart: record.ticketSalesStart || null,
    salesStartLine,
    salesStatus: sales.text,
    salesStatusKind: sales.kind,
    screenshotUrl,
    flierUrl,
    flierImageUrl: flierUrl || screenshotUrl,
    nextEditionEstimated: record.nextEditionEstimated === true,
    notes: record.notes || null,
    planningNotes: record.planningNotes || null,
    tripPlanning: record.tripPlanning || null,
    notifyWhenDatesSet: record.notifyWhenDatesSet === true,
    datesAnnouncedAt: record.datesAnnouncedAt || null,
    fieldWires: record.fieldWires || {},
    reminderLeadDays: record.reminderLeadDays ?? null,
    researching: record.researching === true,
    error: record.error || null,
    researchedAt: record.researchedAt || null,
    snoozedUntil: record.snoozedUntil || null,
    snoozed: Boolean(record.snoozedUntil) && Date.parse(String(record.snoozedUntil)) > now.getTime(),
    skipped: record.skipped === true,
    source: 'conference-watch',
    headsUp: true,
    conferenceWatch: true,
    producer: true,
  };
}

/**
 * @param {object} record
 * @param {Date} [now]
 */
export function conferenceRecordToWatchItem(record, now = new Date()) {
  const base = conferenceRecordToHeadsUp(record, now);
  const urlFound = Boolean(String(record.url || '').trim());
  const hasPayload = Boolean(
    record.eventStart || record.ticketPrice || record.notes || record.venue || record.city,
  );
  /** @type {'pending' | 'fetching' | 'fetched' | 'failed'} */
  let dataFetched = 'pending';
  if (record.researching) {
    dataFetched = 'fetching';
  } else if (record.researchedAt) {
    dataFetched = record.error && !hasPayload && !urlFound ? 'failed' : 'fetched';
  }
  return {
    ...base,
    urlFound,
    dataFetched,
    displayActive: isConferenceHeadsUpActive(record, now),
  };
}

/**
 * @param {string[]} watchlist
 * @param {Date} [now]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadConferenceHeadsUp(watchlist, now = new Date(), env = process.env) {
  const names = normalizeConferenceWatchlist(watchlist);
  const store = await loadConferenceWatchlistStore(env);
  /** @type {object[]} */
  const items = [];
  /** @type {string[]} */
  const needResearch = [];

  for (const name of names) {
    const slug = slugFromQuery(name);
    const rec = store.bySlug[slug];
    if (!rec) {
      needResearch.push(name);
      items.push(conferenceRecordToWatchItem({
        slug,
        query: name,
        name,
        researching: true,
        researchedAt: null,
      }, now));
      continue;
    }
    items.push(conferenceRecordToWatchItem(rec, now));
    const researchedAt = Date.parse(String(rec.researchedAt || ''));
    const stale = !Number.isFinite(researchedAt) || now.getTime() - researchedAt > RESEARCH_STALE_MS;
    const incomplete = !rec.url || !rec.eventStart;
    const retry = Number.isFinite(researchedAt) && now.getTime() - researchedAt > RETRY_MS;
    // Hand-edited records are locked — never queue them for auto-research.
    if (
      (stale || (incomplete && retry))
      && !rec.researching
      && !rec.manualEdit
      && !researchInFlight.has(slug)
    ) {
      needResearch.push(name);
    }
  }

  return { items, needResearch, watchlist: names };
}

/**
 * Kick off background research for stale / new watchlist names.
 * @param {string[]} names
 * @param {NodeJS.ProcessEnv} [env]
 */
export function scheduleConferenceWatchlistResearch(names, env = process.env) {
  const list = normalizeConferenceWatchlist(names);
  if (!list.length) return;
  setImmediate(() => {
    void (async () => {
      for (const name of list.slice(0, 4)) {
        await researchConferenceQuery(name, env);
      }
    })().catch((e) => {
      console.warn('[conference-watch] research failed:', e?.message || e);
    });
  });
}
