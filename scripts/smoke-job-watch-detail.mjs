/**
 * Smoke: opportunity type must follow the posting, not incidental JD phrases.
 * Usage: node scripts/smoke-job-watch-detail.mjs
 */
import {
  coerceOpportunityType,
  parseCompensation,
  parseOpportunityType,
  titleLooksLikeGrant,
} from '../src/lib/job-watch-detail.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const anthropicCsJd = `
As a Manager of Beneficial Deployments Customer Success at Anthropic, you'll be a
pivotal front-line leader managing Customer Success Managers.
Clear understanding of nonprofit operational realities (budget cycles, grant funding,
board governance, resource constraints) and awareness of how mission-driven
organizations evaluate success (impact metrics, beneficiary outcomes, funder requirements).
Annual Salary: $265,000 — $320,000 USD
`;

{
  const title = 'Manager, Customer Success - Beneficial Deployments';
  const pay = parseCompensation(anthropicCsJd);
  const type = parseOpportunityType(title, anthropicCsJd, pay);
  assert(type === 'Full-time', `Anthropic CS manager typed as ${type}, want Full-time`);
  assert(pay?.min === 265000 && pay?.max === 320000, 'Anthropic salary band');
  assert(!titleLooksLikeGrant(title), 'CS manager title is not a grant');
  assert(
    coerceOpportunityType('Grant', title) === 'Full-time',
    'stale Grant snapshot coerced for hired-role title',
  );
}

{
  assert(parseOpportunityType('Grant Writer', 'Writes proposals. Grant funding cycles.', null) === 'Full-time', 'Grant Writer is a job');
  assert(parseOpportunityType('Grants Officer', '', null) === 'Full-time', 'Grants Officer is a job');
  assert(parseOpportunityType('Manager, Grant Programs', 'grant funding', null) === 'Full-time', 'Grant Programs manager is a job');
}

{
  assert(titleLooksLikeGrant('Community Grant'), 'Community Grant');
  assert(titleLooksLikeGrant('Open Call for Grants'), 'Open Call for Grants');
  assert(parseOpportunityType('Claude Education Grant', '', null) === 'Grant', 'title ending in Grant');
  assert(
    parseOpportunityType('AI Safety Grant Program', 'This is a grant opportunity for researchers.', null) === 'Grant',
    'grant program title',
  );
  assert(
    parseOpportunityType('Field Fellowship', 'This is a grant opportunity.', null) === 'Fellowship',
    'fellowship title wins over grant body',
  );
}

{
  assert(
    parseOpportunityType('Advisor', 'This is a 6-month contract role with UNOPS.', null) === 'Contract',
    'explicit contract body',
  );
  assert(parseOpportunityType('Summer Intern, Policy', '', null) === 'Internship', 'intern title');
  assert(parseOpportunityType('Research Residency', '', null) === 'Residency', 'residency title');
}

console.log('smoke-job-watch-detail: ok');
