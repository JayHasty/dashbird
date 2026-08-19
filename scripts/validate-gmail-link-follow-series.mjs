/**
 * Validate WithJoy/Fuckup whitelist, personal relative dates, and recurring series expansion.
 * Run: node scripts/validate-gmail-link-follow-series.mjs
 */
import assert from 'node:assert/strict';
import {
  eventsFromGmailMessage,
  GMAIL_EVENTS_FROM_HOSTS,
  GMAIL_EVENTS_BODY_TERMS,
  sourceFromPlatformUrls,
  looksLikePersonalInviteMail,
  ymdAtLocalNoonIso,
  guessEventStartIso,
} from '../src/lib/events-finder-gmail.js';
import { isWhitelistedEventPlatformHost } from '../src/lib/events-finder-email-platforms.js';
import {
  extractFollowableUrls,
  scrapeWithJoyDateIso,
} from '../src/lib/events-finder-email-link-follow.js';
import {
  expandRecurringAndRelativeDates,
  nthWeekdayOfMonth,
} from '../src/lib/events-finder-recurring-dates.js';

function shapeHtmlMessage({ id = 'fixture', subject, from = '', text }) {
  const b64 = Buffer.from(String(text || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return {
    id,
    threadId: id,
    snippet: String(text || '').replace(/<[^>]+>/g, ' ').slice(0, 240),
    payload: {
      mimeType: 'text/html',
      headers: [
        { name: 'Subject', value: subject },
        { name: 'From', value: from },
        { name: 'Date', value: 'Tue, 4 Aug 2026 10:00:00 -0700' },
      ],
      body: { data: b64 },
    },
  };
}

assert.ok(GMAIL_EVENTS_FROM_HOSTS.includes('withjoy.com'));
assert.ok(GMAIL_EVENTS_FROM_HOSTS.includes('fuckupnights.com'));
assert.ok(GMAIL_EVENTS_BODY_TERMS.some((t) => t.includes('withjoy')));
assert.ok(isWhitelistedEventPlatformHost('https://withjoy.com/sarah-and-gavan'));
assert.ok(isWhitelistedEventPlatformHost('en.fuckupnights.com'));
assert.equal(sourceFromPlatformUrls(['https://withjoy.com/sarah-and-gavan']), 'withjoy');
assert.equal(sourceFromPlatformUrls(['https://en.fuckupnights.com/san-francisco']), 'fuckupnights');

const hrefs = extractFollowableUrls(
  '<a href="https://withjoy.com/sarah-and-gavan">RSVP</a> <a href="https://fonts.googleapis.com/x">x</a>',
);
assert.ok(hrefs.some((u) => u.includes('withjoy.com/sarah-and-gavan')));
assert.ok(!hrefs.some((u) => u.includes('fonts.googleapis')));

// every 3rd Thursday → ~3 months
const nth = expandRecurringAndRelativeDates('Join us every 3rd Thursday at 7pm', {
  now: Date.parse('2026-08-04T17:00:00Z'),
  monthsAhead: 3,
});
assert.ok(nth.some((ex) => ex.kind === 'nth_weekday' && ex.days.length >= 2));
assert.equal(nthWeekdayOfMonth(2026, 8, 4, 3), '2026-08-20'); // Thu

const personal = looksLikePersonalInviteMail(
  'Rosie <rosie@gmail.com>',
  'Hey want to come this Thursday? Hang out at my place.',
);
assert.equal(personal, true);

const rosie = eventsFromGmailMessage(
  shapeHtmlMessage({
    id: 'rosie1',
    subject: 'Thursday?',
    from: 'Rosie <rosie@gmail.com>',
    text: 'Want to come this Thursday around 7pm? Would love to see you.',
  }),
  'America/Los_Angeles',
  { mailbox: 'user@example.com' },
);
assert.ok(rosie.length >= 1, 'personal relative invite should parse');
assert.ok(rosie[0].start, 'relative Thursday should resolve a start');
assert.equal(rosie[0].raw?.personal, true);

const series = eventsFromGmailMessage(
  shapeHtmlMessage({
    id: 'series1',
    subject: 'Philosophy night',
    from: 'host@example.com',
    text: 'We meet every 3rd Thursday. Come hang out.',
  }),
  'America/Los_Angeles',
  { mailbox: 'intake@example.com' },
);
assert.ok(series.length >= 2, `expected series cards, got ${series.length}`);
assert.ok(series.every((ev) => ev.start));
assert.ok(series.some((ev) => ev.raw?.via === 'recurring_series'));

const wedding = eventsFromGmailMessage(
  shapeHtmlMessage({
    id: 'wedding1',
    subject: "Sarah and Gavan's Wedding Invitation",
    from: 'Joy <noreply@mail.withjoy.com>',
    text: `
      <html><body>
      <a href="https://withjoy.com/sarah-and-gavan">View invitation</a>
      You're invited to celebrate with us.
      </body></html>
    `,
  }),
  'America/Los_Angeles',
  { mailbox: 'user@example.com' },
);
assert.equal(wedding.length, 1);
assert.equal(wedding[0].source, 'withjoy');
assert.ok(
  (wedding[0].raw?.urls || []).some((u) => /withjoy\.com/i.test(u)),
  'withjoy URL should be captured for link-follow',
);

// noon helper still works for series ymds
assert.ok(ymdAtLocalNoonIso('2026-08-20'));

const joyIso = scrapeWithJoyDateIso(
  String.raw`{\"type\":\"text\",\"text\":\"SATURDAY, SEPTEMBER 26, 2026\"}`,
  guessEventStartIso,
);
assert.ok(joyIso, 'WithJoy escaped date should parse');
assertLocalYmdApprox(joyIso, '2026-09-26');

/**
 * @param {string | null | undefined} iso
 * @param {string} ymd
 */
function assertLocalYmdApprox(iso, ymd) {
  assert.ok(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const got = `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}-${parts.find((p) => p.type === 'day')?.value}`;
  assert.equal(got, ymd);
}

console.log('validate-gmail-link-follow-series: ok');
