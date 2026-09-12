/**
 * Opportunity detail — employment type and compensation for a single Greenhouse posting.
 *
 * Greenhouse exposes no structured pay field, so the amount is parsed out of the
 * posting body. Board `content` is HTML-escaped twice (`&amp;mdash;`), hence the
 * double unescape before tags are stripped.
 */
import { assertPublicHttpUrl } from './public-http-url.js';

const UA = 'dashbird-opportunity-watch/1.0 (+local; Anthropic careers watch)';

/**
 * Bump when type / pay / work-mode parsers change so cached `state.details` refetch.
 * v2: workMode + locations. v3: grant type no longer matches incidental JD text.
 */
export const OPPORTUNITY_DETAIL_VERSION = 3;

/** Employment types we can tell apart from a title or posting body. */
const TITLE_TYPES = [
  [/\bintern(ship)?s?\b/i, 'Internship'],
  [/\bfellow(ship)?s?\b/i, 'Fellowship'],
  [/\bresidency\b/i, 'Residency'],
  [/\bcontract(or)?s?\b/i, 'Contract'],
  [/\bpart[-\s]time\b/i, 'Part-time'],
  [/\b(temporary|fixed[-\s]term)\b/i, 'Fixed-term'],
];

const BODY_TYPES = [
  [/\bthis is a (?:\d+[-\s]month\s+)?(?:contract|contractor) (?:role|position|engagement)\b/i, 'Contract'],
  [/\bfixed[-\s]term (?:contract|role|position|appointment)\b/i, 'Fixed-term'],
  [/\bthis is a part[-\s]time (?:role|position)\b/i, 'Part-time'],
];

/**
 * Hired-role titles that work *on* grants (Grant Writer, Grants Officer, …)
 * are jobs, not grant offerings.
 */
const HIRED_ROLE_TITLE =
  /\b(manager|director|engineer|architect|officer|specialist|writer|analyst|lead|coordinator|associate|administrator|scientist|researcher|developer|designer|counsel|advisor|consultant|recruiter|accountant|president|head of|vp)\b/i;

/**
 * True when the posting itself is a grant (RFP / award), not a job whose JD
 * mentions grant funding as customer context.
 * @param {string} title
 * @returns {boolean}
 */
export function titleLooksLikeGrant(title) {
  const t = String(title || '').trim();
  if (!/\bgrants?\b/i.test(t)) return false;
  if (HIRED_ROLE_TITLE.test(t)) return false;
  return (
    /\bgrants?\s+(?:program|round|award|opportunity|competition|rfp|call)\b/i.test(t)
    || /\b(?:call for|open call for)\s+grants?\b/i.test(t)
    || /\bgrants?\s*$/i.test(t)
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function bodyLooksLikeGrantVehicle(text) {
  const body = String(text || '');
  return (
    /\bthis is a (?:grant|funded grant) (?:program|opportunity|award)\b/i.test(body)
    || /\b(?:apply|applications?) (?:now )?for this grant\b/i.test(body)
    || /\bwe (?:are|will be) awarding grants?\b/i.test(body)
  );
}

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
  const t = String(title || '');
  for (const [re, label] of TITLE_TYPES) {
    if (re.test(t)) return label;
  }
  if (titleLooksLikeGrant(t)) return 'Grant';
  for (const [re, label] of BODY_TYPES) {
    if (re.test(String(text || ''))) return label;
  }
  if (bodyLooksLikeGrantVehicle(text)) return 'Grant';
  if (compensation?.period === 'hour') return 'Contract';
  return 'Full-time';
}

/**
 * Stored snapshots used to label hired roles as Grant when the JD mentioned
 * “grant funding”. Until those rows refetch, refuse Grant unless the title
 * itself is a grant offering.
 * @param {string | null | undefined} type
 * @param {string} title
 * @returns {string | null}
 */
export function coerceOpportunityType(type, title) {
  const t = String(type || '').trim();
  if (!t) return null;
  if (t === 'Grant' && !titleLooksLikeGrant(title)) return 'Full-time';
  return t;
}

/**
 * Metro buckets for filter chips. Keep in sync with
 * `public/js/lib/job-location-region.js`.
 * @type {ReadonlyArray<{ region: string, re: RegExp }>}
 */
const LOCATION_REGIONS = Object.freeze([
  {
    region: 'Bay Area',
    re: /\b(san francisco|oakland|emeryville|mountain view|sunnyvale|san jose|san bruno|palo alto|bay area|berkeley|menlo park|redwood city|cupertino|santa clara|san mateo|foster city|milpitas|fremont|daly city|south san francisco)\b/i,
  },
  {
    region: 'NYC Area',
    re: /\b(new york city|new york|nyc|brooklyn|manhattan|queens|the bronx|staten island)\b/i,
  },
  {
    region: 'DC Area',
    re: /\b(reston|arlington|alexandria|mclean|tysons|washington,?\s*d\.?c\.?|district of columbia)\b/i,
  },
  {
    region: 'Remote',
    re: /\b(remote|home[-\s]?based)\b/i,
  },
]);

const PLACE_JUNK =
  /^(united states of america|united states|usa|u\.s\.a\.|u\.s\.|us|united kingdom|great britain|england|scotland|wales|uk|canada|germany|france|india|japan|australia|ireland|netherlands|switzerland|california|ca|new york|ny|washington|wa|virginia|va|massachusetts|ma|texas|tx|colorado|co|illinois|il|oregon|or)$/i;

/**
 * Collapse a posting location to a region / city for filters.
 * Specific office strings stay on the job card.
 * @param {string} value
 * @returns {string}
 */
export function locationRegion(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  for (const { region, re } of LOCATION_REGIONS) {
    if (re.test(s)) return region;
  }
  const bits = s
    .replace(/\s*[-–—]\s*(remote|hybrid|on[-\s]?site).*$/i, '')
    .split(/[,|/]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !PLACE_JUNK.test(p));
  const city = (bits[0] || s.split(/[,|/]/)[0] || s).replace(/\s+/g, ' ').trim();
  return city;
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
  const areas = [];
  for (const p of out) {
    const r = locationRegion(p);
    if (LOCATION_REGIONS.some((x) => x.region === r) && !areas.includes(r)) areas.push(r);
  }
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
