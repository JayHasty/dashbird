/**
 * Opportunity detail — employment type and compensation for a single Greenhouse posting.
 *
 * Greenhouse exposes no structured pay field, so the amount is parsed out of the
 * posting body. Board `content` is HTML-escaped twice (`&amp;mdash;`), hence the
 * double unescape before tags are stripped.
 */
import { assertPublicHttpUrl } from './public-http-url.js';

const UA = 'dashbird-opportunity-watch/1.0 (+local; Anthropic careers watch)';

/** Employment types we can tell apart from a title or posting body. */
const TITLE_TYPES = [
  [/\bintern(ship)?s?\b/i, 'Internship'],
  [/\bfellow(ship)?s?\b/i, 'Fellowship'],
  [/\bresidency\b/i, 'Residency'],
  [/\bgrants?\b/i, 'Grant'],
  [/\bcontract(or)?s?\b/i, 'Contract'],
  [/\bpart[-\s]time\b/i, 'Part-time'],
  [/\b(temporary|fixed[-\s]term)\b/i, 'Fixed-term'],
];

const BODY_TYPES = [
  [/\bthis is a (?:\d+[-\s]month\s+)?(?:contract|contractor) (?:role|position|engagement)\b/i, 'Contract'],
  [/\bfixed[-\s]term (?:contract|role|position|appointment)\b/i, 'Fixed-term'],
  [/\bthis is a part[-\s]time (?:role|position)\b/i, 'Part-time'],
  [/\bgrant (?:program|opportunity|application|funding)\b/i, 'Grant'],
];

/**
 * @param {string} raw
 * @returns {string} plain text
 */
function htmlToText(raw) {
  let text = String(raw || '');
  for (let i = 0; i < 2; i += 1) {
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '–')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
  }
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} s
 * @returns {number | null}
 */
function toNumber(s) {
  const n = Number(String(s || '').replace(/[,$\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {number} n
 * @param {string} symbol
 * @returns {string}
 */
function compact(n, symbol) {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${symbol}${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${symbol}${Math.round(n / 1000)}K`;
  return `${symbol}${Math.round(n)}`;
}

/**
 * @param {string} text
 * @returns {string} currency symbol
 */
function currencySymbol(text) {
  if (/\bGBP\b|£/.test(text)) return '£';
  if (/\bEUR\b|€/.test(text)) return '€';
  return '$';
}

const LEAD = '(?:annual salary|annual compensation|salary range|compensation range|pay range|base salary|total compensation|award|grant amount)';

/**
 * @param {string} text plain-text posting body
 * @returns {{ min: number | null, max: number | null, period: string, display: string } | null}
 */
export function parseCompensation(text) {
  const body = String(text || '');
  const symbol = currencySymbol(body);

  const hourly = body.match(
    /[$£€]\s?([\d,]+(?:\.\d+)?)\s*(?:—|–|-|to)\s*[$£€]?\s?([\d,]+(?:\.\d+)?)\s*(?:per hour|\/\s?hour|hourly)/i,
  );
  if (hourly) {
    const min = toNumber(hourly[1]);
    const max = toNumber(hourly[2]);
    if (min && max) {
      return { min, max, period: 'hour', display: `${symbol}${min}–${symbol}${max}/hr` };
    }
  }

  const oneHourly = body.match(/[$£€]\s?([\d,]+(?:\.\d+)?)\s*(?:per hour|\/\s?hour|hourly)/i);
  if (oneHourly) {
    const min = toNumber(oneHourly[1]);
    if (min) return { min, max: null, period: 'hour', display: `${symbol}${min}/hr` };
  }

  // Google Careers writes the band as `US: $207000 - $300000 (USD)`, with no lead-in word.
  const usBand = body.match(/\bUS:\s*\$([\d,]+)\s*(?:—|–|-|to)\s*\$([\d,]+)\s*\(USD\)/i);
  if (usBand) {
    const min = toNumber(usBand[1]);
    const max = toNumber(usBand[2]);
    if (min && max) {
      return { min, max, period: 'year', display: `${compact(min, '$')}–${compact(max, '$')}` };
    }
  }

  const range = body.match(
    new RegExp(`${LEAD}[^$£€]{0,80}?[$£€]\\s?([\\d,]+)\\s*(?:—|–|-|to)\\s*[$£€]?\\s?([\\d,]+)`, 'i'),
  );
  if (range) {
    const min = toNumber(range[1]);
    const max = toNumber(range[2]);
    if (min && max) {
      return { min, max, period: 'year', display: `${compact(min, symbol)}–${compact(max, symbol)}` };
    }
  }

  const single = body.match(new RegExp(`${LEAD}[^$£€]{0,80}?[$£€]\\s?([\\d,]+)`, 'i'));
  if (single) {
    const min = toNumber(single[1]);
    if (min) return { min, max: null, period: 'year', display: compact(min, symbol) };
  }

  return null;
}

/**
 * @param {string} title
 * @param {string} text plain-text posting body
 * @param {{ period: string } | null} [compensation]
 * @returns {string}
 */
export function parseOpportunityType(title, text, compensation = null) {
  for (const [re, label] of TITLE_TYPES) {
    if (re.test(String(title || ''))) return label;
  }
  for (const [re, label] of BODY_TYPES) {
    if (re.test(String(text || ''))) return label;
  }
  if (compensation?.period === 'hour') return 'Contract';
  return 'Full-time';
}

/**
 * Split a location field into distinct office / area labels.
 * @param {string} location
 * @returns {string[]}
 */
export function parseLocations(location) {
  const raw = String(location || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/\s*[|;]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  }
  const hay = out.join(' · ').toLowerCase();
  const areas = [];
  if (/\b(san francisco|oakland|emeryville|mountain view|sunnyvale|san jose|san bruno|palo alto|bay area)\b/.test(hay)) {
    areas.push('Bay Area');
  }
  if (/\b(new york|nyc|brooklyn|manhattan)\b/.test(hay)) areas.push('NYC Area');
  if (/\b(reston|arlington|washington,??\s*dc|district of columbia)\b/.test(hay)) {
    areas.push('DC Area');
  }
  if (/\bremote\b/.test(hay) || /\bhome[-\s]?based\b/.test(hay)) areas.push('Remote');
  for (const a of areas) {
    if (!out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  }
  return out;
}

/**
 * @param {number} remotePercent
 * @returns {string}
 */
function workModeLabel(remotePercent) {
  if (remotePercent >= 100) return '100% remote';
  if (remotePercent <= 0) return 'In-house only';
  return `${remotePercent}% remote`;
}

/**
 * Infer remote / hybrid / in-house from structured type + posting text.
 * Day-count cues like "onsite 4 days a week" map to 25% buckets.
 *
 * @param {string} text
 * @param {{ locationType?: string | null, location?: string }} [opts]
 * @returns {{ mode: 'remote' | 'hybrid' | 'onsite' | 'unknown', remotePercent: number | null, label: string }}
 */
export function parseWorkMode(text, opts = {}) {
  const body = String(text || '');
  const locType = String(opts.locationType || '').toLowerCase();
  const location = String(opts.location || '');
  const hay = `${body}\n${location}\n${locType}`.toLowerCase();

  if (/\b(100\s*%\s*remote|fully remote|remote[-\s]?first|work from anywhere)\b/.test(hay)) {
    return { mode: 'remote', remotePercent: 100, label: '100% remote' };
  }
  if (/\b(home[-\s]?based|home based)\b/.test(hay) && !/\bon[-\s]?site\b/.test(locType)) {
    return { mode: 'remote', remotePercent: 100, label: '100% remote' };
  }
  if (/\bremote\b/.test(location) && !/\bon[-\s]?site\b/.test(locType)) {
    return { mode: 'remote', remotePercent: 100, label: '100% remote' };
  }

  const days =
    body.match(/\bonsite\s+(\d)\s+days?\s+(?:a|per)\s+week\b/i)
    || body.match(/\b(\d)\s+days?\s+(?:a|per)\s+week\s+in\s+(?:the\s+)?office\b/i)
    || body.match(/\bability to be onsite\s+(\d)\s+days?\s+a\s+week\b/i);
  if (days) {
    const onsite = Math.max(0, Math.min(5, Number(days[1])));
    const remotePct = Math.round(((5 - onsite) / 5) * 100 / 25) * 25;
    if (remotePct <= 0) return { mode: 'onsite', remotePercent: 0, label: 'In-house only' };
    if (remotePct >= 100) return { mode: 'remote', remotePercent: 100, label: '100% remote' };
    return { mode: 'hybrid', remotePercent: remotePct, label: workModeLabel(remotePct) };
  }

  const pct = body.match(/\b(\d{1,3})\s*%\s*remote\b/i);
  if (pct) {
    const n = Math.max(0, Math.min(100, Number(pct[1])));
    if (n <= 0) return { mode: 'onsite', remotePercent: 0, label: 'In-house only' };
    if (n >= 100) return { mode: 'remote', remotePercent: 100, label: '100% remote' };
    return { mode: 'hybrid', remotePercent: n, label: workModeLabel(n) };
  }

  // Structured Location Type wins over incidental body words (e.g. "hybrid cloud").
  if (/\b(on[-\s]?site|in[-\s]?office|in[-\s]?house)\b/.test(locType)) {
    return { mode: 'onsite', remotePercent: 0, label: 'In-house only' };
  }
  if (locType.includes('remote')) {
    return { mode: 'remote', remotePercent: 100, label: '100% remote' };
  }
  if (locType.includes('hybrid') || /\bhybrid (work|role|schedule|position|arrangement)\b/.test(hay)) {
    return { mode: 'hybrid', remotePercent: 50, label: '50% remote' };
  }
  if (/\b(on[-\s]?site only|in[-\s]?office only)\b/.test(hay)) {
    return { mode: 'onsite', remotePercent: 0, label: 'In-house only' };
  }

  // Multiple listed offices with no remote cue → treat as in-house.
  if (parseLocations(location).filter((l) => !/^remote$/i.test(l) && !/area$/i.test(l)).length) {
    return { mode: 'onsite', remotePercent: 0, label: 'In-house only' };
  }

  return { mode: 'unknown', remotePercent: null, label: 'Remote TBD' };
}

/**
 * @param {object} raw Greenhouse job detail
 * @returns {{
 *   type: string,
 *   compensation: object | null,
 *   locations: string[],
 *   workMode: ReturnType<typeof parseWorkMode>,
 * }}
 */
export function parseOpportunityDetail(raw) {
  const text = htmlToText(raw?.content || '');
  const compensation = parseCompensation(text);
  const location = String(raw?.location?.name || '').trim();
  const meta = Array.isArray(raw?.metadata) ? raw.metadata : [];
  const locationType =
    meta.find((m) => /location\s*type/i.test(String(m?.name || '')))?.value || null;
  const workMode = parseWorkMode(text, { locationType, location });
  return {
    type: parseOpportunityType(raw?.title || '', text, compensation),
    compensation,
    locations: parseLocations(location),
    workMode,
  };
}

/**
 * @param {string} boardUrl board listing endpoint from config
 * @param {string} jobId
 * @returns {Promise<{ type: string, compensation: object | null } | null>}
 */
export async function fetchOpportunityDetail(boardUrl, jobId) {
  const id = String(jobId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const base = String(boardUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;

  let safeUrl;
  try {
    safeUrl = await assertPublicHttpUrl(`${base}/${id}`);
  } catch {
    return null;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(safeUrl, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!res.ok) return null;
    return parseOpportunityDetail(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
