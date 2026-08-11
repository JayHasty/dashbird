/**
 * Assess Anthropic postings against Jay's STRATEGY (Beneficial Deployments lane).
 *
 * Assessment plan for brand-new / unreviewed roles:
 * 1. Hard-pass check (clinical, Life Sciences eng-manager, Evangelist, Head BD Arch, pure research)
 * 2. Exact watch-target match (Priority-1/2 / watch / queued)
 * 3. Candidate-interest patterns (BD / nonprofit / agri / mobility adjacency)
 * 4. Location signal (SF / NYC / Bay preferred; remote/other noted)
 * 5. Pay floor ($180k/year USD posted max) → pass if clearly below
 * 6. Score → verdict: burn | maybe | pass | canary
 * 7. Persist prose recommendation for the yellow-dot popup
 */

/** Posted-max cash floor from the recruiter job-fit brief. */
export const DEFAULT_COMP_FLOOR_ANNUAL_USD = 180_000;
const HOURS_PER_YEAR = 2080;

/**
 * @param {string | RegExp | Array<string>} patterns
 * @param {string} text
 */
function anyMatch(patterns, text) {
  const hay = String(text || '').toLowerCase();
  for (const p of patterns || []) {
    try {
      if (new RegExp(p, 'i').test(hay)) return true;
    } catch {
      if (hay.includes(String(p).toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * @param {object} job
 * @param {object} target
 */
export function jobMatchesTarget(job, target) {
  const title = String(job?.title || '');
  if (!title) return false;
  // Keep Anthropic targets from swallowing Google titles (and vice versa).
  const jobSource = String(job?.sourceId || 'anthropic');
  const targetSource = String(target?.source || 'anthropic');
  if (jobSource !== targetSource) return false;
  if (anyMatch(target.excludeAny, title)) return false;
  return anyMatch(target.matchAny, title);
}

/**
 * @param {object} job
 * @param {object} config targets file
 */
export function findMatchingTargets(job, config) {
  const targets = Array.isArray(config?.targets) ? config.targets : [];
  return targets.filter((t) => jobMatchesTarget(job, t));
}

/**
 * Map 0–10 fit score to a 1–3 star rating.
 * Weak / near hard-pass scores rarely surface through the panel filter.
 * @param {number} score
 * @returns {number}
 */
export function scoreToStars(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 9) return 3;
  if (n >= 7) return 2;
  return 1;
}

/**
 * Highest published annual cash in USD, or null if unknown / non-USD.
 * Hourly bands annualize at 2080 hours.
 * @param {object | null | undefined} compensation
 * @returns {number | null}
 */
export function annualCashCeilingUsd(compensation) {
  if (!compensation) return null;
  const display = String(compensation.display || '');
  if (/[£€]/.test(display) && !/\$/.test(display)) return null;
  const max = Number(compensation.max ?? compensation.min);
  if (!Number.isFinite(max) || max <= 0) return null;
  if (compensation.period === 'hour') return max * HOURS_PER_YEAR;
  return max;
}

/**
 * @param {object | null | undefined} compensation
 * @param {object} [config]
 * @returns {{ below: boolean, floor: number, ceiling: number | null, display: string }}
 */
export function payFloorCheck(compensation, config = {}) {
  const floor = Number(config.compFloorAnnualUsd);
  const usdFloor = Number.isFinite(floor) && floor > 0 ? floor : DEFAULT_COMP_FLOOR_ANNUAL_USD;
  const ceiling = annualCashCeilingUsd(compensation);
  const display = String(compensation?.display || (ceiling != null ? `$${Math.round(ceiling)}` : 'unposted'));
  return {
    below: ceiling != null && ceiling < usdFloor,
    floor: usdFloor,
    ceiling,
    display,
  };
}

/**
 * Expected-fit stars for a watched lane that is not currently posted.
 * @param {unknown} priority
 * @returns {number}
 */
export function priorityToStars(priority) {
  if (priority === 1 || priority === '1') return 3;
  if (priority === 2 || priority === '2' || priority === 'watch') return 2;
  if (priority === 'queued') return 1;
  return 1;
}

/**
 * @param {string} location
 */
function locationSignal(location) {
  const loc = String(location || '').toLowerCase();
  if (!loc) return { tier: 'unknown', note: 'Location not listed.' };
  if (/san francisco|new york|seattle|bay area|emeryville|oakland/.test(loc)) {
    return { tier: 'preferred', note: 'Location aligns with SF/NYC/Bay preference.' };
  }
  if (/remote/.test(loc)) return { tier: 'ok', note: 'Remote-friendly — confirm hybrid expectation.' };
  if (/london|tokyo|munich|paris|bangalore|washington|boston|zürich|zurich/.test(loc)) {
    return { tier: 'weak', note: 'Office outside primary Bay Area / NYC target.' };
  }
  return { tier: 'ok', note: `Location: ${location}` };
}

/**
 * @param {object} job { title, location, url, id }
 * @param {object} config
 * @returns {{
 *   verdict: 'burn' | 'maybe' | 'pass' | 'canary',
 *   score: number,
 *   closeFit: 'strong' | 'partial' | 'weak' | 'none',
 *   matchedTargetIds: string[],
 *   reasons: string[],
 *   recommendation: string,
 *   applyNow: boolean,
 * }}
 */
export function assessJob(job, config) {
  const title = String(job?.title || '').trim();
  const location = String(job?.location || '').trim();
  const hay = `${title}\n${location}`.toLowerCase();
  const reasons = [];
  const hardPass = Array.isArray(config?.hardPassPatterns) ? config.hardPassPatterns : [];
  const interest = Array.isArray(config?.candidateInterestPatterns)
    ? config.candidateInterestPatterns
    : [];

  const matchedTargets = findMatchingTargets(job, config);
  const matchedTargetIds = matchedTargets.map((t) => t.id);
  const loc = locationSignal(location);
  const pay = payFloorCheck(job?.compensation, config);

  if (pay.below) {
    const floorLabel = `$${Math.round(pay.floor / 1000)}k/year`;
    reasons.push(`Posted max ${pay.display} is below the ${floorLabel} floor`);
    return {
      verdict: 'pass',
      score: 1,
      closeFit: 'none',
      matchedTargetIds,
      reasons,
      recommendation:
        `${title} publishes pay topping out at ${pay.display}, below the ${floorLabel} floor. `
        + 'Pass unless Jay explicitly overrides. '
        + loc.note,
      applyNow: false,
    };
  }

  // Class E canaries — leadership seats that signal IC wave but are not apply-now
  const isCanary =
    /head of applied ai architecture/.test(hay)
    || (/manager,\s*applied ai engineering/.test(hay) && /beneficial/.test(hay))
    || (/manager of applied ai architecture/.test(hay) && /beneficial|nonprofit|partnerships/.test(hay));

  if (isCanary && !matchedTargets.some((t) => t.priority === 1 || t.priority === 2)) {
    reasons.push('Leadership / IC-wave canary — track, do not burn cooldown');
    return {
      verdict: 'canary',
      score: 4,
      closeFit: 'weak',
      matchedTargetIds,
      reasons,
      recommendation:
        `${title} looks like a Beneficial Deployments leadership canary. `
        + 'Useful signal that the org is staffing the lane, but STRATEGY says pass on Head/Manager Applied AI Architecture and Life Sciences eng-manager seats. '
        + 'Watch for the IC Applied AI Architect or Partner/Customer Success BD roles underneath this hire. '
        + loc.note,
      applyNow: false,
    };
  }

  if (anyMatch(hardPass, title) && !matchedTargets.length) {
    reasons.push('Matches hard-pass / do-not-burn pattern from STRATEGY');
    return {
      verdict: 'pass',
      score: 1,
      closeFit: 'none',
      matchedTargetIds,
      reasons,
      recommendation:
        `${title} is on the explicit do-not-apply list (clinical/Global Health, Life Sciences eng-manager, `
        + 'Evangelist/DevRel, Head of Applied AI Architecture BD, or pure research). '
        + 'Not worth the company-wide ~12-month cooldown. '
        + loc.note,
      applyNow: false,
    };
  }

  if (matchedTargets.length) {
    const top = matchedTargets[0];
    const prio = top.priority;
    reasons.push(`Matches watched target: ${top.label}`);
    if (loc.tier === 'preferred') reasons.push(loc.note);
    else if (loc.tier === 'weak') reasons.push(loc.note);

    if (prio === 1) {
      return {
        verdict: 'burn',
        score: loc.tier === 'weak' ? 8 : 10,
        closeFit: 'strong',
        matchedTargetIds,
        reasons,
        recommendation:
          `Strong fit — Priority-1 watch target "${top.label}". `
          + `${top.summary} `
          + 'If the JD as written is competitive for Jay (deployment + partner technical work, not pure SWE/ML management), this is an apply-now cooldown burn. '
          + 'One role only; get referral if possible. '
          + loc.note,
        applyNow: loc.tier !== 'weak',
      };
    }
    if (prio === 2) {
      return {
        verdict: 'maybe',
        score: 7,
        closeFit: 'partial',
        matchedTargetIds,
        reasons,
        recommendation:
          `Priority-2 watch target "${top.label}". ${top.summary} `
          + 'Read the JD carefully: field partners / agri / global development = interesting; MD/clinical research = pass. '
          + loc.note,
        applyNow: false,
      };
    }
    if (prio === 'queued') {
      return {
        verdict: 'maybe',
        score: 6,
        closeFit: 'partial',
        matchedTargetIds,
        reasons,
        recommendation:
          `Queued (not auto-apply): "${top.label}". ${top.summary} `
          + 'Still a cooldown burn — confirm packet and timing before submit. '
          + loc.note,
        applyNow: false,
      };
    }
    // watch lane
    return {
      verdict: 'burn',
      score: 9,
      closeFit: 'strong',
      matchedTargetIds,
      reasons,
      recommendation:
        `Watch-lane seat opened: "${top.label}". ${top.summary} `
        + 'This is the agri/mobility domain lane STRATEGY has been waiting for — treat as high-priority review against the full JD. '
        + loc.note,
      applyNow: true,
    };
  }

  // Generic commercial seats without mission-lane cues — not yellow-dot material
  const commercialOnly =
    /(customer success|partner success|applied ai architect|account executive)/i.test(title)
    && !/(beneficial|nonprofit|claude|mobility|agriculture|smallholder|education|global development|raising the floor)/i.test(hay);
  if (commercialOnly) {
    reasons.push('Commercial / industries seat without BD or mission-lane cues');
    return {
      verdict: 'pass',
      score: 2,
      closeFit: 'none',
      matchedTargetIds: [],
      reasons,
      recommendation:
        `${title} looks like a commercial GTM/CS seat, not Beneficial Deployments. `
        + 'Skip unless the JD explicitly serves nonprofits, agri/mobility, or underserved field partners. '
        + loc.note,
      applyNow: false,
    };
  }

  // Unmatched but interesting
  const interestHits = interest.filter((p) => {
    try {
      return new RegExp(p, 'i').test(hay);
    } catch {
      return hay.includes(String(p).toLowerCase());
    }
  });

  if (!interestHits.length) {
    return {
      verdict: 'pass',
      score: 0,
      closeFit: 'none',
      matchedTargetIds: [],
      reasons: ['No BD / mission-lane adjacency'],
      recommendation: `${title} does not look BD-adjacent for Jay's lane. Ignore unless the JD text changes the story.`,
      applyNow: false,
    };
  }

  reasons.push(`Interest cues: ${interestHits.slice(0, 4).join(', ')}`);
  if (loc.tier === 'preferred') reasons.push(loc.note);

  const bdish = /beneficial deployments|claude corps|claude for nonprofits|economic mobility|smallholder|agriculture/.test(hay);
  const architectish = /applied ai architect|forward.?deployed|partner success|customer success/.test(hay);

  let score = 5;
  if (bdish) score += 2;
  if (architectish) score += 2;
  if (loc.tier === 'preferred') score += 1;
  if (loc.tier === 'weak') score -= 2;
  score = Math.max(0, Math.min(10, score));

  const closeFit = score >= 8 ? 'strong' : score >= 5 ? 'partial' : 'weak';
  const verdict = score >= 8 ? 'maybe' : score >= 5 ? 'maybe' : 'pass';

  return {
    verdict,
    score,
    closeFit,
    matchedTargetIds: [],
    reasons,
    recommendation:
      `${title} is not an exact watched target, but shows mission-lane cues (${interestHits.slice(0, 3).join(', ')}). `
      + (bdish
        ? 'Beneficial Deployments / mobility / agri adjacency is real — open the JD and score against Priority-1 (Architect IC or Partner/Customer Success). '
        : 'Adjacent at best — only escalate if the day job is field deployment / partner enablement for underserved populations. ')
      + 'Do not spray-apply; cooldown is company-wide. '
      + loc.note,
    applyNow: false,
  };
}

/**
 * Should this open job appear as a yellow-dot candidate?
 * @param {ReturnType<typeof assessJob>} assessment
 * @param {string[]} matchedTargetIds
 */
export function isYellowCandidate(assessment, matchedTargetIds) {
  if (matchedTargetIds?.length) return false; // shown on target row instead
  if (!assessment) return false;
  if (assessment.verdict === 'pass') return false;
  return assessment.verdict === 'maybe' || assessment.verdict === 'burn' || assessment.verdict === 'canary';
}
