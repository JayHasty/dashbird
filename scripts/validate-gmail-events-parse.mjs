/**
 * Harden Intake Gmail → Events Finder parsing.
 * Catches the Bonobo-class failure: plurals not in query, multi-event digests
 * collapsed to one subject row, invite cues with curly apostrophes ignored.
 *
 * Run: node scripts/validate-gmail-events-parse.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GMAIL_EVENTS_BODY_TERMS,
  GMAIL_EVENTS_FROM_HOSTS,
  GMAIL_EVENTS_SUBJECT_TERMS,
  buildDefaultGmailEventsQuery,
  eventsFromGmailMessage,
  extractDatedInviteBlocks,
  extractPlatformUrls,
  gmailEventsQuery,
  parseClockToken,
  sourceFromPlatformUrls,
  ymdAtLocalTimeIso,
} from '../src/lib/events-finder-gmail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

/**
 * @param {string | null | undefined} iso
 * @param {string} ymd
 */
function assertLocalYmd(iso, ymd) {
  assert.ok(iso, `missing start for ${ymd}`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const got = `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}-${parts.find((p) => p.type === 'day')?.value}`;
  assert.equal(got, ymd);
}

/**
 * @param {{ id?: string, subject: string, from?: string, date?: string, text: string }} opts
 */
function shapePlainMessage({ id = 'fixture', subject, from = '', date = '', text }) {
  const b64 = Buffer.from(String(text || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return {
    id,
    threadId: id,
    snippet: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: subject },
        { name: 'From', value: from },
        { name: 'Date', value: date },
      ],
      body: { data: b64 },
    },
  };
}

// --- Query coverage (Gmail does not stem party → parties) ---
assert.ok(
  GMAIL_EVENTS_SUBJECT_TERMS.includes('party'),
  'subject terms must include party',
);
assert.ok(
  GMAIL_EVENTS_SUBJECT_TERMS.includes('parties'),
  'subject terms must include parties (Gmail does not stem plurals)',
);
assert.ok(
  GMAIL_EVENTS_SUBJECT_TERMS.includes('"pool parties"'),
  'subject terms must include pool parties',
);
assert.ok(
  GMAIL_EVENTS_FROM_HOSTS.some((h) => h.includes('bonobonetwork')),
  'from: hosts must include Bonobo',
);
assert.ok(
  GMAIL_EVENTS_BODY_TERMS.some((t) => t.includes('bonobonetwork')),
  'body terms must include Bonobo',
);

const defaultQuery = buildDefaultGmailEventsQuery();
assert.equal(gmailEventsQuery({}), defaultQuery);
assert.match(defaultQuery, /\bparties\b/);
assert.match(defaultQuery, /bonobonetwork\.com/);
assert.match(defaultQuery, /plra\.io/);

// Subjects that previously slipped the query intent
const mustMatchSubjects = [
  'TWO hot August pool parties - are you ready?',
  "You're invited to our gathering",
  'Pool party this weekend',
];
for (const subject of mustMatchSubjects) {
  const hit = GMAIL_EVENTS_SUBJECT_TERMS.some((term) => {
    const bare = term.replace(/^"|"$/g, '').toLowerCase();
    return subject.toLowerCase().includes(bare);
  });
  assert.ok(hit, `subject terms should cover: ${subject}`);
}

// --- Clock / local time helpers ---
assert.deepEqual(parseClockToken('12pm'), { hours: 12, minutes: 0 });
assert.deepEqual(parseClockToken('8pm'), { hours: 20, minutes: 0 });
assert.deepEqual(parseClockToken('12:30pm'), { hours: 12, minutes: 30 });
const aug8noon = ymdAtLocalTimeIso('2026-08-08', 12, 0, 'America/Los_Angeles');
assert.ok(aug8noon);
assert.equal(new Date(aug8noon).toISOString().slice(0, 13), '2026-08-08T19'); // PDT

// --- Bonobo multi-event digest fixture ---
const fixture = JSON.parse(
  readFileSync(
    path.join(root, 'scripts/fixtures/gmail-bonobo-august-parties.json'),
    'utf8',
  ),
);
assert.match(fixture.subject, /parties/i);
assert.match(fixture.text, /Afternoon Delight/i);
assert.match(fixture.text, /Unholy Sunday/i);

const blocks = extractDatedInviteBlocks(fixture.text, Date.parse('2026-07-24T20:00:00Z'));
assert.equal(blocks.length, 2, `expected 2 dated blocks, got ${blocks.length}`);
assert.match(String(blocks[0].title), /Weird Barbie|Afternoon Delight/i);
assert.match(String(blocks[1].title), /Queergasm|Unholy Sunday/i);
assert.equal(blocks[0].city, 'Oakland');
assert.equal(blocks[1].city, 'Oakland');
assertLocalYmd(blocks[0].start, '2026-08-08');
assertLocalYmd(blocks[1].start, '2026-08-16');

const platformUrls = extractPlatformUrls(fixture.text);
assert.ok(
  platformUrls.some((u) => /bonobonetwork\.com/i.test(u)),
  'should extract bonobonetwork URLs',
);
assert.ok(
  platformUrls.some((u) => /plra\.io/i.test(u)),
  'should extract Plura RSVP URL',
);
assert.equal(sourceFromPlatformUrls(platformUrls.filter((u) => /plra\.io/i.test(u))), 'plura');
assert.equal(
  sourceFromPlatformUrls(platformUrls.filter((u) => /bonobonetwork\.com/i.test(u))),
  'bonobo',
);

const shaped = shapePlainMessage({
  id: '2439',
  subject: fixture.subject,
  from: fixture.from,
  date: fixture.date,
  text: fixture.text,
});
const events = eventsFromGmailMessage(shaped, 'America/Los_Angeles', {
  mailbox: 'intake@example.com',
});
assert.equal(events.length, 2, `expected 2 events from Bonobo mail, got ${events.length}`);
assert.match(events[0].title, /Weird Barbie|Afternoon Delight/i);
assert.match(events[1].title, /Queergasm|Unholy Sunday/i);
assertLocalYmd(events[0].start, '2026-08-08');
assertLocalYmd(events[1].start, '2026-08-16');
assert.equal(events[0].city, 'Oakland');
assert.equal(events[1].city, 'Oakland');
assert.equal(events[0].raw?.via, 'dated_blocks');
assert.equal(events[1].raw?.via, 'dated_blocks');
// Must not collapse onto the Mailchimp subject as the only title
assert.notEqual(events[0].title, fixture.subject);
assert.notEqual(events[1].title, fixture.subject);
// Venue heuristic must not grab "at all of our upcoming gatherings"
assert.ok(
  !/all of our upcoming/i.test(String(events[0].venue || '')),
  'venue must not be marketing prose',
);

// Curly-apostrophe invite cue still counts as inviteish via dated blocks / invite re
const curly = shapePlainMessage({
  id: 'curly',
  subject: 'Newsletter',
  text: '** YOU\u2019RE INVITED!\n** Saturday, September 5, 7pm | Berkeley\nJoin us at The New Parish.',
});
const curlyEvents = eventsFromGmailMessage(curly, 'America/Los_Angeles');
assert.equal(curlyEvents.length, 1);
assert.equal(curlyEvents[0].city, 'Berkeley');
assertLocalYmd(curlyEvents[0].start, '2026-09-05');

// Single-event platform mail still yields one row (regression)
const luma = shapePlainMessage({
  id: 'luma1',
  subject: "You're invited: Rooftop Jazz",
  from: 'Luma <noreply@lu.ma>',
  text: 'Join us on https://lu.ma/rooftop-jazz-2026 for Rooftop Jazz on October 12, 2026 at 6pm.',
});
const lumaEvents = eventsFromGmailMessage(luma, 'America/Los_Angeles');
assert.equal(lumaEvents.length, 1);
assert.equal(lumaEvents[0].source, 'luma');
assertLocalYmd(lumaEvents[0].start, '2026-10-12');

console.log('validate-gmail-events-parse: ok');
console.log(
  `  Bonobo → ${events.length} events: ${events.map((e) => `${e.title} @ ${e.start}`).join(' | ')}`,
);
