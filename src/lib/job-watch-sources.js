/**
 * Opportunity sources — one adapter per board.
 *
 * Greenhouse / Ashby give clean JSON. Google Careers retired its public API, so that
 * adapter runs keyword searches against the server-rendered results page and reads
 * the job anchors out of the markup.
 */
import { assertPublicHttpUrl } from './public-http-url.js';
import {
  fetchOpportunityDetail,
  parseCompensation,
  parseLocations,
  parseOpportunityType,
  parseWorkMode,
} from './job-watch-detail.js';

const UA = 'dashbird-opportunity-watch/1.0 (+local; careers watch)';
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** Google job cards: the anchor carries both the id/slug and the full title. */
const GOOGLE_ANCHOR =
  /href="jobs\/results\/(\d+)-([a-z0-9-]+)[^"]*"\s+aria-label="Learn more about ([^"]+)"/g;
const GOOGLE_LOCATION = /class="r0wTof\s*">([^<]+)<\/span>/g;

/**
 * Bundled stub in src/data/job-watch-targets.json uses this placeholder.
 * @param {unknown} label
 * @returns {boolean}
 */
export function isPlaceholderCompanyLabel(label) {
  return /^example\s*co\.?$/i.test(String(label || '').trim());
}

/**
 * Empty public-repo stub — not a real watch board.
 * @param {object} config
 * @returns {boolean}
 */
export function isBundledStubConfig(config) {
  const sources = Array.isArray(config?.sources) ? config.sources : [];
  const targets = Array.isArray(config?.targets) ? config.targets : [];
  if (sources.length || targets.length) return false;
  const urls = [config?.boardUrl, config?.boardUrl, config?.careersUiUrl, config?.careersUiUrl]
    .map((u) => String(u || ''))
    .join(' ');
  return (
    isPlaceholderCompanyLabel(config?.company)
    || /\/boards\/example(?:\/|$|\?)/i.test(urls)
    || /greenhouse\.io\/example(?:\/|$|\?)/i.test(urls)
  );
}

/**
 * Unique companies on listing rows (watch lanes + candidates).
 * Skips the bundled "Example Co" placeholder.
 * @param {Array<{ source?: string, sourceId?: string, sourceLabel?: string }>} [targets]
 * @param {Array<{ source?: string, sourceId?: string, sourceLabel?: string }>} [candidates]
 * @returns {Array<{ id: string, label: string }>}
 */
export function collectListingCompanies(targets = [], candidates = []) {
  /** @type {Map<string, { id: string, label: string }>} */
  const byId = new Map();
  const add = (id, label) => {
    const key = String(id || '').trim();
    if (!key) return;
    const name = String(label || '').trim() || key;
    if (isPlaceholderCompanyLabel(name)) return;
    const prev = byId.get(key);
    if (!prev) byId.set(key, { id: key, label: name });
    else if (name !== key && prev.label === key) byId.set(key, { id: key, label: name });
  };
  for (const t of targets) add(t?.source || t?.sourceId, t?.sourceLabel);
  for (const c of candidates) add(c?.sourceId || c?.source, c?.sourceLabel);
  return [...byId.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
}

/**
 * @param {object} config targets file
 * @returns {Array<object>} sources
 */
export function normalizeSources(config) {
  const listed = Array.isArray(config?.sources) ? config.sources : [];
  if (listed.length) return listed;
  // Public stub has no sources/targets — do not invent a fake "Example Co" board.
  if (isBundledStubConfig(config)) return [];
  // Pre-multi-source config: a single Greenhouse board at the top level.
  return [
    {
      id: 'anthropic',
      label: config?.company || 'Anthropic',
      type: 'greenhouse',
      boardUrl: config?.boardUrl,
      careersUiUrl: config?.careersUiUrl,
    },
  ];
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number, accept?: string, ua?: string }} [opts]
 * @returns {Promise<{ ok: boolean, body?: string, error?: string }>}
 */
async function fetchText(url, opts = {}) {
  let safeUrl;
  try {
    safeUrl = await assertPublicHttpUrl(url);
  } catch {
    return { ok: false, error: 'url_not_public' };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 25000);
  try {
    const res = await fetch(safeUrl, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'user-agent': opts.ua || UA,
        accept: opts.accept || 'application/json',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.text() };
  } catch (e) {
    return { ok: false, error: String(/** @type {Error} */ (e)?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} source
 * @returns {Promise<{ ok: boolean, jobs: Array<object>, error?: string }>}
 */
async function fetchGreenhouseJobs(source) {
  const boardUrl = String(source.boardUrl || '').trim();
  if (!boardUrl) return { ok: false, jobs: [], error: 'missing_board_url' };

  const res = await fetchText(boardUrl);
  if (!res.ok) return { ok: false, jobs: [], error: res.error };

  let parsed;
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch {
    return { ok: false, jobs: [], error: 'bad_json' };
  }

  const jobs = (Array.isArray(parsed?.jobs) ? parsed.jobs : [])
    .map((raw) => {
      const rawId = raw?.id != null ? String(raw.id) : '';
      return {
        id: `${source.id}:${rawId}`,
        rawId,
        sourceId: source.id,
        sourceLabel: source.label || source.id,
        title: String(raw?.title || '').trim(),
        url: String(raw?.absolute_url || '').trim(),
        location: String(raw?.location?.name || '').trim(),
        updatedAt: raw?.updated_at || raw?.first_published || null,
      };
    })
    .filter((j) => j.rawId && j.title && j.url);

  return { ok: true, jobs };
}

/**
 * @param {object} raw Ashby board job
 * @returns {string}
 */
function ashbyLocation(raw) {
  const primary = String(raw?.location || '').trim();
  const secondary = Array.isArray(raw?.secondaryLocations)
    ? raw.secondaryLocations.map((x) => String(x?.location || x || '').trim()).filter(Boolean)
    : [];
  return [primary, ...secondary].filter(Boolean).join(' | ');
}

/**
 * Map Ashby's employmentType enum onto Opportunity Watch labels.
 * @param {string} employmentType
 * @returns {string | null}
 */
function ashbyEmploymentLabel(employmentType) {
  const t = String(employmentType || '');
  if (/^full/i.test(t)) return 'Full-time';
  if (/^part/i.test(t)) return 'Part-time';
  if (/intern/i.test(t)) return 'Internship';
  if (/contract|temporary|fixed/i.test(t)) return 'Contract';
  return null;
}

/**
 * Prefer Ashby's structured compensation block; fall back to posting text.
 * @param {object | null | undefined} compensation
 * @param {string} text
 * @returns {{ min: number | null, max: number | null, period: string, display: string } | null}
 */
function ashbyCompensation(compensation, text) {
  const salary =
    (Array.isArray(compensation?.summaryComponents)
      ? compensation.summaryComponents.find((c) => /salary/i.test(String(c?.compensationType || '')))
      : null)
    || null;
  const min = Number(salary?.minValue);
  const max = Number(salary?.maxValue);
  if (Number.isFinite(min) && min > 0 && Number.isFinite(max) && max > 0) {
    const display =
      String(compensation?.scrapeableCompensationSalarySummary || '').trim()
      || `$${Math.round(min / 1000)}K–$${Math.round(max / 1000)}K`;
    return { min, max, period: 'year', display: display.replace(/\s*-\s*/, '–') };
  }
  const summary = String(
    compensation?.scrapeableCompensationSalarySummary
    || compensation?.compensationTierSummary
    || '',
  );
  return parseCompensation(summary) || parseCompensation(text);
}

/**
 * @param {object} source
 * @returns {Promise<{ ok: boolean, jobs: Array<object>, error?: string }>}
 */
async function fetchAshbyJobs(source) {
  const boardUrl = String(source.boardUrl || '').trim();
  if (!boardUrl) return { ok: false, jobs: [], error: 'missing_board_url' };

  const url = boardUrl.includes('includeCompensation=')
    ? boardUrl
    : `${boardUrl}${boardUrl.includes('?') ? '&' : '?'}includeCompensation=true`;
  const res = await fetchText(url);
  if (!res.ok) return { ok: false, jobs: [], error: res.error };

  let parsed;
  try {
    parsed = JSON.parse(res.body || '{}');
  } catch {
    return { ok: false, jobs: [], error: 'bad_json' };
  }

  const jobs = (Array.isArray(parsed?.jobs) ? parsed.jobs : [])
    .filter((raw) => raw?.isListed !== false)
    .map((raw) => {
      const rawId = raw?.id != null ? String(raw.id) : '';
      const location = ashbyLocation(raw);
      const text = String(raw?.descriptionPlain || '').trim()
        || String(raw?.descriptionHtml || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const compensation = ashbyCompensation(raw?.compensation || null, text);
      return {
        id: `${source.id}:${rawId}`,
        rawId,
        sourceId: source.id,
        sourceLabel: source.label || source.id,
        title: String(raw?.title || '').trim(),
        url: String(raw?.jobUrl || raw?.applyUrl || '').trim(),
        location,
        updatedAt: raw?.publishedAt || null,
        compensation,
        // Ashby embeds the full posting on the board listing — keep fields for detail.
        _ashby: {
          text,
          employmentType: raw?.employmentType || null,
          workplaceType: raw?.workplaceType || null,
          isRemote: raw?.isRemote,
          compensation: raw?.compensation || null,
        },
      };
    })
    .filter((j) => j.rawId && j.title && j.url);

  return { ok: true, jobs };
}

/**
 * @param {object} job
 * @returns {{ type: string, compensation: object | null, locations: string[], workMode: object } | null}
 */
function detailFromAshbyJob(job) {
  const meta = job?._ashby;
  if (!meta) return null;
  const text = String(meta.text || '');
  const compensation = ashbyCompensation(meta.compensation, text);
  const location = String(job.location || '');
  const locationType =
    meta.workplaceType
    || (meta.isRemote === true ? 'Hybrid' : meta.isRemote === false ? 'Onsite' : null);
  return {
    type: ashbyEmploymentLabel(meta.employmentType)
      || parseOpportunityType(job.title, text, compensation),
    compensation,
    locations: parseLocations(location),
    workMode: parseWorkMode(text, { locationType, location }),
  };
}

/**
 * @param {string} html
 * @param {object} source
 * @returns {Array<object>}
 */
export function parseGoogleResults(html, source) {
  const body = String(html || '');
  const out = [];
  let prevIndex = 0;
  GOOGLE_ANCHOR.lastIndex = 0;
  for (let m = GOOGLE_ANCHOR.exec(body); m; m = GOOGLE_ANCHOR.exec(body)) {
    // Locations render just above their anchor, so scan the gap since the last card.
    const segment = body.slice(prevIndex, m.index);
    const locations = [...segment.matchAll(GOOGLE_LOCATION)].map((x) => x[1].trim());
    const unique = [...new Set(locations)];
    out.push({
      id: `${source.id}:${m[1]}`,
      rawId: m[1],
      sourceId: source.id,
      sourceLabel: source.label || source.id,
      title: m[3].trim(),
      url: `https://www.google.com/about/careers/applications/jobs/results/${m[1]}-${m[2]}`,
      location: unique.slice(-3).join(' | '),
      updatedAt: null,
    });
    prevIndex = m.index;
  }
  return out;
}

/**
 * Google search only returns one page of hits per keyword, so the lanes we care
 * about are covered by running a short list of queries and merging the results.
 * @param {object} source
 * @returns {Promise<{ ok: boolean, jobs: Array<object>, error?: string }>}
 */
async function fetchGoogleCareersJobs(source) {
  const searchUrl =
    String(source.searchUrl || '').trim()
    || 'https://www.google.com/about/careers/applications/jobs/results/';
  const queries = Array.isArray(source.queries) ? source.queries : [];
  if (!queries.length) return { ok: false, jobs: [], error: 'missing_queries' };

  /** @type {Map<string, object>} */
  const byId = new Map();
  const failures = [];

  for (const q of queries) {
    const url = `${searchUrl}?q=${encodeURIComponent(q)}`;
    const res = await fetchText(url, { accept: 'text/html', ua: BROWSER_UA });
    if (!res.ok) {
      failures.push(`${q}: ${res.error}`);
      continue;
    }
    for (const job of parseGoogleResults(res.body || '', source)) {
      if (!byId.has(job.id)) byId.set(job.id, job);
    }
  }

  if (!byId.size && failures.length) {
    return { ok: false, jobs: [], error: failures[0] };
  }
  return { ok: true, jobs: [...byId.values()] };
}

/**
 * Static postings curated into the targets file (UN System retainers, one-offs).
 * @param {object} source
 * @returns {Promise<{ ok: boolean, jobs: Array<object>, error?: string }>}
 */
async function fetchManualJobs(source) {
  const listed = Array.isArray(source?.jobs) ? source.jobs : [];
  const jobs = listed
    .map((raw, i) => {
      const rawId = String(raw?.id || raw?.rawId || `manual-${i + 1}`).trim();
      const title = String(raw?.title || '').trim();
      const url = String(raw?.url || '').trim();
      if (!rawId || !title || !url) return null;
      return {
        id: `${source.id}:${rawId}`,
        rawId,
        sourceId: source.id,
        sourceLabel: source.label || source.id,
        title,
        url,
        location: String(raw?.location || '').trim(),
        updatedAt: raw?.updatedAt || raw?.postedAt || null,
        opportunityType: raw?.kind || raw?.type || null,
        workModeHint: raw?.workMode || null,
        summary: String(raw?.summary || '').trim(),
      };
    })
    .filter(Boolean);
  return { ok: true, jobs };
}

/**
 * @param {object} source
 * @param {object} job
 * @returns {Promise<{ type: string, compensation: object | null, locations: string[], workMode: object | null } | null>}
 */
async function detailFromManualJob(job) {
  const text = [job?.title, job?.summary, job?.location].filter(Boolean).join('\n');
  const locations = parseLocations(job?.location || '');
  const workMode = parseWorkMode(
    job?.workModeHint ? String(job.workModeHint) : text,
    { location: job?.location },
  );
  return {
    type: job?.opportunityType
      || parseOpportunityType(job?.title || '', text, null),
    compensation: null,
    locations,
    workMode,
  };
}

/**
 * @param {object} source
 * @returns {Promise<{ ok: boolean, jobs: Array<object>, error?: string }>}
 */
export async function fetchSourceJobs(source) {
  if (source?.type === 'manual') return fetchManualJobs(source);
  if (source?.type === 'google-careers') return fetchGoogleCareersJobs(source);
  if (source?.type === 'ashby') return fetchAshbyJobs(source);
  return fetchGreenhouseJobs(source);
}

/**
 * @param {string} html
 * @returns {string}
 */
function googlePageText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' \n ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {object} job
 * @returns {Promise<{ type: string, compensation: object | null } | null>}
 */
async function fetchGoogleDetail(job) {
  const res = await fetchText(job.url, { accept: 'text/html', ua: BROWSER_UA });
  if (!res.ok) return null;
  const html = String(res.body || '');
  // The posting's own range is the unescaped one; related-job blobs are \u-escaped.
  const own = html.match(/<br><br>US:\s*\$([\d,]+)\s*-\s*\$([\d,]+)\s*\(USD\)/);
  const text = googlePageText(html);
  let compensation = own
    ? parseCompensation(`Annual Salary: $${own[1]} — $${own[2]} USD`)
    : parseCompensation(text);
  if (!compensation) compensation = null;
  // Google embeds office expectation in a structured blob: "Ability to be onsite N days a week."
  const onsiteCue = html.match(/Ability to be onsite\s+(\d)\s+days?\s+a\s+week/i);
  const workText = onsiteCue
    ? `${text}\nAbility to be onsite ${onsiteCue[1]} days a week.`
    : text;
  const locations = parseLocations(job.location);
  const workMode = parseWorkMode(workText, { location: job.location });
  return {
    type: parseOpportunityType(job.title, text, compensation),
    compensation,
    locations,
    workMode,
  };
}

/**
 * @param {object} source
 * @param {object} job
 * @returns {Promise<{ type: string, compensation: object | null } | null>}
 */
export async function fetchSourceDetail(source, job) {
  if (source?.type === 'manual') return detailFromManualJob(job);
  if (source?.type === 'google-careers') return fetchGoogleDetail(job);
  if (source?.type === 'ashby') return detailFromAshbyJob(job);
  return fetchOpportunityDetail(source?.boardUrl, job?.rawId);
}
