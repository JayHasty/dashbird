/**
 * Offline validation for Daily Summary LLM intent triage (heuristics + gating).
 * Run: node scripts/validate-daily-summary-triage.mjs
 */
import assert from 'node:assert/strict';
import {
  TRIAGE_FYI_IMPORTANCE_MIN,
  buildTriageSystemPrompt,
  buildTriageUserPrompt,
  classifyGmailDailySummaryMessages,
  filterMessagesForDigest,
  heuristicSynthParsed,
  heuristicTriageMessage,
  mapTriageParsedToById,
  messageShouldEnterDigest,
  normalizeTriageCategory,
  triageMessageKey,
} from '../src/lib/gmail-daily-summary-triage.js';
import { shouldExcludeDailySummaryItem } from '../src/lib/gmail-weekly-summary-store.js';

const fixtures = [
  {
    id: '1',
    mailbox: 'intake@example.com',
    subject: 'Action required: sign the NDA',
    from: 'Legal <legal@acme.com>',
    text: 'Please review and sign the NDA by Friday. Action required.',
    expectCategory: 'action',
    expectKeep: true,
  },
  {
    id: '2',
    mailbox: 'intake@example.com',
    subject: 'Your package has shipped',
    from: 'Amazon <ship@amazon.com>',
    text: 'Tracking number 1Z999. Out for delivery tomorrow.',
    expectCategory: 'noise',
    expectKeep: false,
  },
  {
    id: '3',
    mailbox: 'intake@example.com',
    subject: "You're invited: Saturday pool party",
    from: 'Bonobo <info@bonobonetwork.com>',
    text: "You're invited! RSVP for the party Saturday. Add to calendar.",
    expectCategory: 'event',
    expectKeep: false,
  },
  {
    id: '4',
    mailbox: 'intake@example.com',
    subject: 'Your verification code is 482913',
    from: 'Security <noreply@example.com>',
    text: 'Use this one-time passcode to sign in. Do not share your OTP.',
    expectCategory: 'noise',
    expectKeep: false,
  },
  {
    id: '5',
    mailbox: 'intake@example.com',
    subject: 'Can we meet Thursday?',
    from: 'Sam <sam@partner.org>',
    text: 'When works for a 30 min Zoom? Calendly link inside — propose a time.',
    expectCategory: 'scheduling',
    expectKeep: true,
  },
  {
    id: '6',
    mailbox: 'intake@example.com',
    subject: 'Invoice #441 due',
    from: 'Billing <billing@vendor.com>',
    text: 'Payment due May 1. Invoice attached. ACH details below.',
    expectCategory: 'money_docs',
    expectKeep: true,
  },
  {
    id: '7',
    mailbox: 'intake@example.com',
    subject: 'Please reply about the lease',
    from: 'Office <manager@westernp.com>',
    text: 'Action required: confirm the unit by Friday.',
    expectCategory: 'noise',
    expectKeep: false,
  },
];

assert.equal(normalizeTriageCategory('money'), 'money_docs');
assert.equal(normalizeTriageCategory('EVENT'), 'event');

for (const fx of fixtures) {
  const h = heuristicTriageMessage(fx);
  assert.equal(
    h.category,
    fx.expectCategory,
    `${fx.id} category: got ${h.category}, want ${fx.expectCategory}`,
  );
  assert.equal(
    messageShouldEnterDigest(h),
    fx.expectKeep,
    `${fx.id} keep: got ${messageShouldEnterDigest(h)}, want ${fx.expectKeep}`,
  );
}

// FYI threshold
assert.equal(messageShouldEnterDigest({ category: 'fyi', importance: 0.69 }), false);
assert.equal(
  messageShouldEnterDigest({ category: 'fyi', importance: TRIAGE_FYI_IMPORTANCE_MIN }),
  true,
);

const prompt = buildTriageSystemPrompt('## Show these (important)\n- deadlines Jay owns\n', [
  { vibe: 'up', text: 'insurance paperwork follow-ups' },
  { vibe: 'down', text: 'newsletter digests', company: 'Substack' },
]);
assert.match(prompt, /prefer more/i);
assert.match(prompt, /prefer less/i);
assert.match(prompt, /insurance paperwork/);

const userPrompt = buildTriageUserPrompt(fixtures);
assert.match(userPrompt, /intake@example\.com:1/);
assert.match(userPrompt, /Action required: sign the NDA/);

const mapped = mapTriageParsedToById(
  {
    messages: [
      { id: 'intake@example.com:1', category: 'action', importance: 0.9, why: 'nda' },
      { id: 'intake@example.com:3', category: 'event', importance: 0.2, why: 'party' },
    ],
  },
  fixtures,
);
assert.equal(mapped.get('intake@example.com:1')?.category, 'action');
assert.equal(mapped.get('intake@example.com:3')?.category, 'event');
// Heuristic fill for unclassified rows
assert.ok(mapped.get('intake@example.com:2'));

const byId = new Map(
  fixtures.map((fx) => [triageMessageKey(fx), heuristicTriageMessage(fx)]),
);
const kept = filterMessagesForDigest(fixtures, byId);
assert.equal(kept.length, 3);
assert.deepEqual(
  kept.map((m) => m.id).sort(),
  ['1', '5', '6'],
);

// Heuristic-only classify path (no OpenRouter)
const classified = await classifyGmailDailySummaryMessages(fixtures, {
  heuristicOnly: true,
  guideMarkdown: '',
});
assert.equal(classified.via, 'heuristic');
assert.equal(classified.kept.length, 3);
assert.equal(classified.dropped.length, 4);

// Authoritative backstop still drops event-shaped synth items even if triage misfires
const eventItem = {
  title: 'RSVP for Saturday party',
  company: 'Bonobo',
  detail: 'Bonobo: you are invited to the pool party',
  sources: [{ subject: "You're invited", from: 'info@bonobonetwork.com' }],
};
assert.equal(shouldExcludeDailySummaryItem(eventItem, ''), 'event');

const otpItem = {
  title: 'Enter verification code',
  company: 'Example',
  detail: 'Example: your OTP is ready',
  sources: [{ subject: 'Verification code', from: 'noreply@example.com' }],
};
assert.equal(shouldExcludeDailySummaryItem(otpItem, ''), 'verification');

const heuristicParsed = heuristicSynthParsed(
  kept,
  new Map(fixtures.map((fx) => [triageMessageKey(fx), heuristicTriageMessage(fx)])),
);
assert.equal(heuristicParsed.items.length, 3);
assert.equal(heuristicParsed.items[0].sourceRefs[0].mailbox, 'intake@example.com');
assert.match(String(heuristicParsed.summaryText), /without an LLM/i);

console.log('validate-daily-summary-triage: ok');
console.log(
  `  kept=${classified.kept.map((m) => m.subject).join(' | ')}`,
);
