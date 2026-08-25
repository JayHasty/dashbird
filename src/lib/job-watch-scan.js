/**
 * Scan opportunity sources, match watch targets, assess new/interesting roles.
 */
import {
  loadJobWatchState,
  loadJobWatchTargets,
  saveJobWatchState,
} from './job-watch-store.js';
import {
  assessJob,
  findMatchingTargets,
  isYellowCandidate,
  jobMatchesTarget,
  priorityToStars,
  scoreToStars,
} from './job-watch-assess.js';
import { parseLocations } from './job-watch-detail.js';
import {
  collectListingCompanies,
  fetchSourceDetail,
  fetchSourceJobs,
  isBundledStubConfig,
  isPlaceholderCompanyLabel,
  normalizeSources,
} from './job-watch-sources.js';

/** @type {Promise<{ ok: boolean, error?: string, state: object, jobCount?: number }> | null} */
let scanInFlight = null;

/** Only surfaced rows get a detail fetch, so a scan stays a handful of requests. */
const MAX_DETAIL_FETCHES = 12;

/** Postings without an `updated_at` (Google) are re-read on this cadence. */
const DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {object | null} detail
 * @param {object} job
 * @returns {boolean}
 */
function detailIsFresh(detail, job) {
  if (!detail) return false;
  // Older snapshots predate workMode / locations — force a refresh.
  if (!detail.workMode || !Array.isArray(detail.locations) || detail.detailVersion !== 2) {
    return false;
  }
  if (job.updatedAt && detail.updatedAt === job.updatedAt) return true;
  if (!job.updatedAt && detail.fetchedAt) {
    const age = Date.now() - Date.parse(detail.fetchedAt);
    return Number.isFinite(age) && age < DETAIL_TTL_MS;
  }
  return false;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ force?: boolean }} [opts]
 */
export async function runJobWatchScan(env = process.env, opts = {}) {
  if (scanInFlight) return scanInFlight;
  scanInFlight = runJobWatchScanUnlocked(env, opts).finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ force?: boolean }} [opts]
 */
async function runJobWatchScanUnlocked(env = process.env, opts = {}) {
  const config = await loadJobWatchTargets();
  const state = await loadJobWatchState(env);
  const sources = normalizeSources(config);
  if (!sources.length) {
    const now = new Date().toISOString();
    state.lastScanAt = now;
    state.lastScanError = isBundledStubConfig(config)
      ? 'targets_not_configured'
      : 'no_sources';
    await saveJobWatchState(state, env);
    return { ok: false, error: state.lastScanError, state, jobCount: 0 };
  }
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const now = new Date().toISOString();

  /** @type {Array<object>} */
  const jobs = [];
  /** @type {string[]} */
  const sourceErrors = [];
  for (const source of sources) {
    const result = await fetchSourceJobs(source);
    if (!result.ok) {
      sourceErrors.push(`${source.id}: ${result.error || 'fetch_failed'}`);
      continue;
    }
    jobs.push(...result.jobs);
  }

  // Every source down means no usable snapshot; a partial failure still updates.
  if (!jobs.length) {
    state.lastScanAt = now;
    state.lastScanError = sourceErrors.join('; ') || 'fetch_failed';
    await saveJobWatchState(state, env);
    return { ok: false, error: state.lastScanError, state };
  }

  const byId = new Map(jobs.map((j) => [j.id, j]));
  const known = new Set(state.knownJobIds || []);
  // Pre-multi-source state used bare Greenhouse ids; treat that as a fresh baseline
  // so the whole board does not flood yellow-dot candidates on upgrade.
  const legacyIds =
    known.size > 0 && [...known].every((id) => !String(id).includes(':'));
  const firstScan = (known.size === 0 || legacyIds) && !opts.forceBootstrapAsNew;
  // A newly added company (e.g. OpenAI) also needs a quiet baseline — every id
  // on that board looks "new" against an Anthropic/Google-only known set.
  const knownSourceIds = new Set(
    [...known]
      .map((id) => {
        const s = String(id);
        const i = s.indexOf(':');
        return i > 0 ? s.slice(0, i) : '';
      })
      .filter(Boolean),
  );
  const baseliningSources = new Set(
    sources
      .map((s) => s.id)
      .filter((id) => id && !knownSourceIds.has(id) && !firstScan),
  );
  if (legacyIds) {
    for (const c of state.candidates || []) {
      if (!String(c.id || '').includes(':')) c.dismissedAt = c.dismissedAt || now;
    }
  }

  /**
   * @param {object} job
   * @param {Record<string, object>} [details]
   */
  function jobForAssess(job, details = {}) {
    const fromDetail = details[String(job.id)]?.compensation;
    return fromDetail ? { ...job, compensation: fromDetail } : job;
  }

  /** @param {object} job @param {ReturnType<typeof assessJob>} assessment */
  function matchRecord(job, assessment) {
    return {
      id: job.id,
      title: job.title,
      location: job.location,
      url: job.url,
      updatedAt: job.updatedAt,
      sourceId: job.sourceId,
      sourceLabel: job.sourceLabel,
      assessment,
      matchStars: scoreToStars(assessment.score),
      matchScore: assessment.score,
    };
  }

  // Target matches (scoped by source via jobMatchesTarget)
  /** @type {Record<string, object | null>} */
  const targetMatches = {};
  for (const target of config.targets || []) {
    const hit = jobs.find((j) => jobMatchesTarget(j, target)) || null;
    if (!hit) {
      targetMatches[target.id] = null;
      continue;
    }
    targetMatches[target.id] = matchRecord(hit, assessJob(jobForAssess(hit), config));
  }

  // Yellow-dot candidates only from sources that opted in (Anthropic board).
  /** @type {Map<string, object>} */
  const candMap = new Map((state.candidates || []).map((c) => [String(c.id), c]));
  const candidateSources = new Set(
    sources.filter((s) => s.candidates !== false).map((s) => s.id),
  );

  for (const job of jobs) {
    if (!candidateSources.has(job.sourceId || 'anthropic')) continue;

    const matched = findMatchingTargets(job, config);
    const assessment = assessJob(jobForAssess(job), config);
    const isNew =
      !known.has(job.id) && !baseliningSources.has(job.sourceId || 'anthropic');
    const shouldConsider = isYellowCandidate(assessment, matched.map((t) => t.id));
    const prev = candMap.get(job.id);

    if (prev) {
      prev.lastSeenAt = now;
      prev.open = true;
      prev.title = job.title;
      prev.location = job.location;
      prev.url = job.url;
      prev.sourceId = job.sourceId;
      prev.sourceLabel = job.sourceLabel;
      prev.assessment = assessment;
      prev.matchStars = scoreToStars(assessment.score);
      prev.matchScore = assessment.score;
      if (matched.length) prev.matchedTargetIds = matched.map((t) => t.id);
      continue;
    }

    // First successful scan only baselines the board — no yellow-dot flood.
    if (firstScan || !shouldConsider || !isNew) continue;

    candMap.set(job.id, {
      id: job.id,
      greenhouseId: job.rawId || null,
      title: job.title,
      location: job.location,
      url: job.url,
      sourceId: job.sourceId,
      sourceLabel: job.sourceLabel,
      firstSeenAt: now,
      lastSeenAt: now,
      open: true,
      isNew: true,
      backlog: false,
      assessment,
      matchStars: scoreToStars(assessment.score),
      matchScore: assessment.score,
      reviewedAt: null,
      dismissedAt: null,
    });
  }

  for (const c of candMap.values()) {
    if (!byId.has(String(c.id))) {
      c.open = false;
      c.lastSeenAt = now;
    }
  }

  // Type + pay come from the posting body — only fetch for rows we show.
  const surfaced = new Set();
  for (const match of Object.values(targetMatches)) {
    if (match) surfaced.add(String(match.id));
  }
  for (const c of candMap.values()) {
    if (c.open !== false && !c.dismissedAt) surfaced.add(String(c.id));
  }

  /** @type {Record<string, object>} */
  const details = {};
  for (const [id, detail] of Object.entries(state.details || {})) {
    if (byId.has(String(id))) details[id] = detail;
  }
  let fetches = 0;
  for (const id of surfaced) {
    const job = byId.get(id);
    if (!job) continue;
    if (detailIsFresh(details[id], job)) continue;
    const source = sourceById.get(job.sourceId) || sources[0];
    // Ashby embeds the posting on the board listing — no extra HTTP, so it
    // should not consume the Greenhouse/Google detail budget.
    const ashbyInline = source?.type === 'ashby';
    if (!ashbyInline && fetches >= MAX_DETAIL_FETCHES) break;
    if (!ashbyInline) fetches += 1;
    const detail = await fetchSourceDetail(source, job);
    if (detail) {
      details[id] = {
        ...detail,
        detailVersion: 2,
        updatedAt: job.updatedAt,
        fetchedAt: now,
      };
    }
  }
  state.details = details;

  // Greenhouse/Google pay lands on the detail fetch — re-score so the $180k floor applies.
  for (const [tid, match] of Object.entries(targetMatches)) {
    if (!match) continue;
    const job = byId.get(String(match.id));
    if (!job) continue;
    const assessment = assessJob(jobForAssess(job, details), config);
    targetMatches[tid] = matchRecord(job, assessment);
  }
  for (const c of candMap.values()) {
    const job = byId.get(String(c.id));
    if (!job) continue;
    const assessment = assessJob(jobForAssess(job, details), config);
    c.assessment = assessment;
    c.matchStars = scoreToStars(assessment.score);
    c.matchScore = assessment.score;
  }

  state.lastScanAt = now;
  state.lastScanError = sourceErrors.length ? sourceErrors.join('; ') : null;
  state.knownJobIds = jobs.map((j) => j.id);
  state.openJobs = jobs.map((j) => ({
    id: j.id,
    title: j.title,
    location: j.location,
    url: j.url,
    sourceId: j.sourceId,
  }));
  state.targetMatches = targetMatches;
  state.candidates = [...candMap.values()].sort((a, b) => {
    const ao = a.open === false ? 1 : 0;
    const bo = b.open === false ? 1 : 0;
    if (ao !== bo) return ao - bo;
    const ar = a.reviewedAt || a.dismissedAt ? 1 : 0;
    const br = b.reviewedAt || b.dismissedAt ? 1 : 0;
    if (ar !== br) return ar - br;
    return String(b.firstSeenAt || '').localeCompare(String(a.firstSeenAt || ''));
  });

  await saveJobWatchState(state, env);
  return {
    ok: true,
    state,
    config,
    jobCount: jobs.length,
    sourceErrors: sourceErrors.length ? sourceErrors : null,
  };
}

/**
 * Build API payload for the panel.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function getJobWatchPayload(env = process.env) {
  const config = await loadJobWatchTargets();
  const state = await loadJobWatchState(env);

  // Never block GET on a board crawl — a refresh would hang or look empty.
  // Stale snapshots still render immediately; a scan runs in the background.
  const staleMs = 2 * 60 * 60 * 1000;
  const last = state.lastScanAt ? Date.parse(state.lastScanAt) : 0;
  if (!last || Date.now() - last > staleMs) {
    void runJobWatchScan(env).catch((e) => {
      console.warn('[job-watch] background scan', e?.message || e);
    });
  }

  const priorityRank = (p) => {
    if (p === 1 || p === '1') return 1;
    if (p === 2 || p === '2') return 2;
    if (p === 'watch') return 3;
    if (p === 'queued') return 4;
    return 5;
  };

  const detailFor = (id) => (id != null ? state.details?.[String(id)] || null : null);
  const sources = normalizeSources(config);

  const targets = (config.targets || [])
    .map((t) => {
      const match = state.targetMatches?.[t.id] || null;
      const detail = detailFor(match?.id);
      const open = Boolean(match);
      const matchStars = open
        ? Number(match.matchStars ?? scoreToStars(match.assessment?.score))
        : priorityToStars(t.priority);
      const matchScore = open
        ? Number(match.matchScore ?? match.assessment?.score ?? 0)
        : null;
      const locations = Array.isArray(detail?.locations) && detail.locations.length
        ? detail.locations
        : parseLocations(match?.location || '');
      return {
        id: t.id,
        label: t.label,
        priority: t.priority,
        summary: t.summary,
        source: t.source || 'anthropic',
        sourceLabel:
          match?.sourceLabel
          || sources.find((s) => s.id === (t.source || 'anthropic'))?.label
          || t.source
          || 'Anthropic',
        status: open ? 'open' : 'closed',
        type: detail?.type || t.kind || null,
        compensation: detail?.compensation || null,
        locations,
        workMode: detail?.workMode || null,
        matchStars,
        matchScore,
        // Closed rows use expected stars for the lane; open rows use live assessment.
        matchStarsKind: open ? 'live' : 'expected',
        job: match
          ? {
              id: match.id,
              title: match.title,
              location: match.location,
              url: match.url,
              updatedAt: match.updatedAt,
            }
          : null,
      };
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      if (b.matchStars !== a.matchStars) return b.matchStars - a.matchStars;
      return priorityRank(a.priority) - priorityRank(b.priority);
    });

  const candidates = (state.candidates || [])
    .filter((c) => c.open !== false && !c.dismissedAt)
    .filter((c) => {
      const matched = c.assessment?.matchedTargetIds || [];
      if (matched.length && targets.some((t) => t.status === 'open' && matched.includes(t.id))) {
        return false;
      }
      const v = c.assessment?.verdict;
      return v === 'maybe' || v === 'burn' || v === 'canary';
    })
    .map((c) => {
      const score = Number(c.matchScore ?? c.assessment?.score ?? 0);
      const detail = detailFor(c.id);
      const locations = Array.isArray(detail?.locations) && detail.locations.length
        ? detail.locations
        : parseLocations(c.location || '');
      return {
        id: c.id,
        title: c.title,
        location: c.location,
        url: c.url,
        sourceId: c.sourceId || 'anthropic',
        sourceLabel: c.sourceLabel || 'Anthropic',
        type: detail?.type || null,
        compensation: detail?.compensation || null,
        locations,
        workMode: detail?.workMode || null,
        matchStars: Number(c.matchStars ?? scoreToStars(score)),
        matchScore: score,
        firstSeenAt: c.firstSeenAt,
        isNew: c.isNew === true,
        backlog: c.backlog === true,
        reviewedAt: c.reviewedAt || null,
        assessment: c.assessment,
        needsReview: !c.reviewedAt,
      };
    });

  const listingSources = collectListingCompanies(targets, candidates);

  return {
    ok: true,
    company: isPlaceholderCompanyLabel(config.company)
      ? listingSources[0]?.label || null
      : config.company || 'Anthropic',
    careersUiUrl: config.careersUiUrl,
    // Filter list = companies on the listing, not the bundled stub's "Example Co".
    sources: listingSources.length
      ? listingSources
      : sources
          .filter((s) => !isPlaceholderCompanyLabel(s.label || s.id))
          .map((s) => ({ id: s.id, label: s.label || s.id, type: s.type })),
    lastScanAt: state.lastScanAt,
    lastScanError: state.lastScanError,
    scanIntervalMs: 2 * 60 * 60 * 1000,
    targets,
    candidates,
  };
}
