/**
 * Offline validation for Daily Summary expiry / pin / chronological order.
 * Run: node scripts/validate-daily-summary.mjs
 */
import assert from 'node:assert/strict';
import {
  guideExcludeReason,
  guideBulletMatchesItem,
  parseGuideSections,
} from '../src/lib/gmail-daily-summary-guide-match.js';
import {
  GMAIL_DAILY_SUMMARY_MAX_AGE_DAYS,
  GMAIL_DAILY_SUMMARY_UNPIN_GRACE_MS,
  collapseDuplicateDailySummaryItems,
  dailySummaryItemsAreSameAsk,
  dropOpenItemsMatchingClosed,
  keepNewestSourceOnly,
  matchesClosedDailySummaryItem,
  mergeSynthesizedDigest,
  pruneExpiredGmailDailySummary,
  reconcileDigestClosedTombstones,
  openGmailWeeklyItems,
  scrubEventMentionsFromSummary,
  sortItemsChronological,
  isPastDailySummaryRetention,
  shouldExcludeDailySummaryItem,
} from '../src/lib/gmail-weekly-summary-store.js';

assert.equal(GMAIL_DAILY_SUMMARY_MAX_AGE_DAYS, 10);
assert.equal(GMAIL_DAILY_SUMMARY_UNPIN_GRACE_MS, 30_000);

const now = Date.now();
const old = new Date(now - 11 * 24 * 60 * 60 * 1000).toISOString();
const fresh = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
const mid = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();

function baseItem(partial) {
  return {
    detail: '',
    deadline: null,
    deadlineSource: 'none',
    needsReply: false,
    mailboxes: [],
    sources: [],
    pinned: false,
    unpinDeleteAt: null,
    ...partial,
  };
}

const { digest, changed } = pruneExpiredGmailDailySummary(
  {
    summaryText: 'stale prose',
    generatedAt: old,
    lastScanYmd: '2026-07-01',
    windowDays: 10,
    lastError: null,
    items: [
      baseItem({
        id: 'a',
        title: 'Old open',
        status: 'open',
        createdAt: old,
        updatedAt: old,
        fingerprint: 'oldfp',
        sources: [{ email: 'a@x.com', messageId: '1', threadId: '', subject: 'Old', date: old }],
      }),
      baseItem({
        id: 'b',
        title: 'Fresh open',
        status: 'open',
        createdAt: fresh,
        updatedAt: fresh,
        fingerprint: 'freshfp',
        sources: [{ email: 'a@x.com', messageId: '2', threadId: '', subject: 'Fresh', date: fresh }],
      }),
      baseItem({
        id: 'c',
        title: 'Pinned old',
        status: 'open',
        pinned: true,
        createdAt: old,
        updatedAt: old,
        fingerprint: 'pinnedfp',
        sources: [{ email: 'a@x.com', messageId: '3', threadId: '', subject: 'Pinned', date: old }],
      }),
    ],
  },
  now,
);

assert.equal(changed, true);
assert.equal(digest.summaryText, '');
assert.equal(digest.generatedAt, null);
// Old unpinned hard-deleted (not dismissed).
assert.equal(digest.items.find((i) => i.id === 'a'), undefined);
assert.equal(digest.items.find((i) => i.id === 'b')?.status, 'open');
assert.equal(digest.items.find((i) => i.id === 'c')?.status, 'open');
assert.equal(digest.items.find((i) => i.id === 'c')?.pinned, true);
assert.deepEqual(
  openGmailWeeklyItems(digest).map((i) => i.id),
  ['b', 'c'],
);

// Unpin grace: still visible before deleteAt, gone after.
const graceUntil = new Date(now + 15_000).toISOString();
const { digest: graceDigest } = pruneExpiredGmailDailySummary(
  {
    summaryText: '',
    generatedAt: fresh,
    lastScanYmd: '2026-07-14',
    windowDays: 10,
    lastError: null,
    items: [
      baseItem({
        id: 'd',
        title: 'Unpinned expired',
        status: 'open',
        pinned: false,
        unpinDeleteAt: graceUntil,
        createdAt: old,
        updatedAt: old,
        fingerprint: 'gracefp',
        sources: [{ email: 'a@x.com', messageId: '4', threadId: '', subject: 'Grace', date: old }],
      }),
    ],
  },
  now,
);
assert.equal(graceDigest.items.find((i) => i.id === 'd')?.status, 'open');

const { digest: afterGrace } = pruneExpiredGmailDailySummary(graceDigest, now + 20_000);
assert.equal(afterGrace.items.find((i) => i.id === 'd'), undefined);

// Chronological: newest first; pin does not float.
const sorted = sortItemsChronological([
  baseItem({
    id: 'old',
    title: 'Old',
    status: 'open',
    pinned: true,
    createdAt: old,
    updatedAt: now,
    fingerprint: '1',
    sources: [{ email: 'a@x.com', messageId: '1', threadId: '', subject: 'x', date: old }],
  }),
  baseItem({
    id: 'new',
    title: 'New',
    status: 'open',
    pinned: false,
    createdAt: fresh,
    updatedAt: fresh,
    fingerprint: '2',
    sources: [{ email: 'a@x.com', messageId: '2', threadId: '', subject: 'y', date: fresh }],
  }),
  baseItem({
    id: 'mid',
    title: 'Mid',
    status: 'open',
    pinned: true,
    createdAt: mid,
    updatedAt: mid,
    fingerprint: '3',
    sources: [{ email: 'a@x.com', messageId: '3', threadId: '', subject: 'z', date: mid }],
  }),
]);
assert.deepEqual(
  sorted.map((i) => i.id),
  ['new', 'mid', 'old'],
);

assert.equal(
  isPastDailySummaryRetention(
    baseItem({
      id: 'x',
      title: 'x',
      status: 'open',
      createdAt: old,
      updatedAt: old,
      fingerprint: 'x',
      sources: [{ email: 'a@x.com', messageId: '9', threadId: '', subject: 'x', date: old }],
    }),
    now,
  ),
  true,
);

const scrubbed = scrubEventMentionsFromSummary(
  'Workspace reminders need attention. You also have a few upcoming events, but those are handled by Events Finder. No other urgent actions are required.',
);
assert.equal(scrubbed, 'Workspace reminders need attention.');
assert.equal(
  scrubEventMentionsFromSummary('Only an Events Finder handoff sentence.'),
  '',
);
assert.equal(
  scrubEventMentionsFromSummary('Apify usage exceeded. No other urgent actions are required.'),
  'Apify usage exceeded.',
);

// Newest source only when the same ask repeats across emails.
const newestOnly = keepNewestSourceOnly([
  { email: 'a@x.com', messageId: '1', threadId: '', subject: 'Security alert', date: old },
  { email: 'a@x.com', messageId: '2', threadId: '', subject: 'Security alert', date: fresh },
]);
assert.equal(newestOnly.length, 1);
assert.equal(newestOnly[0].messageId, '2');

assert.equal(
  dailySummaryItemsAreSameAsk(
    baseItem({
      title: 'Review your PayPal statement',
      company: 'PayPal',
      status: 'open',
      sources: [{ email: 'a@x.com', messageId: '1', threadId: '', subject: 'June statement', date: old }],
    }),
    baseItem({
      title: 'Check your PayPal account statement',
      company: 'PayPal',
      status: 'open',
      sources: [{ email: 'a@x.com', messageId: '2', threadId: '', subject: 'June statement', date: fresh }],
    }),
  ),
  true,
);

// Distinct workspace asks must not collapse together.
assert.equal(
  dailySummaryItemsAreSameAsk(
    baseItem({
      title: 'Check workspace deletion reminders',
      company: 'Cursor',
      status: 'open',
      sources: [
        {
          email: 'a@x.com',
          messageId: '1',
          threadId: '',
          subject: 'Reminder: Your workspace "MarioJay" will be deleted',
          date: old,
        },
      ],
    }),
    baseItem({
      title: 'Check workspace deletion reminders',
      company: 'Cursor',
      status: 'open',
      sources: [
        {
          email: 'a@x.com',
          messageId: '2',
          threadId: '',
          subject: 'Reminder: Your workspace "Jaybird\'s Workspace" will be deleted',
          date: fresh,
        },
      ],
    }),
  ),
  false,
);

const collapsed = collapseDuplicateDailySummaryItems([
  baseItem({
    id: 'p1',
    title: 'Update privacy settings for Julia\'s account',
    company: 'Acme',
    status: 'open',
    createdAt: old,
    updatedAt: old,
    fingerprint: 'p1',
    sources: [
      {
        email: 'a@x.com',
        messageId: '1',
        threadId: '',
        subject: 'Action required: Update your privacy settings',
        date: old,
      },
    ],
  }),
  baseItem({
    id: 'p2',
    title: 'Check your privacy settings',
    company: 'Acme',
    status: 'open',
    createdAt: fresh,
    updatedAt: fresh,
    fingerprint: 'p2',
    sources: [
      {
        email: 'a@x.com',
        messageId: '2',
        threadId: '',
        subject: 'Action required: Update your privacy settings',
        date: fresh,
      },
      {
        email: 'a@x.com',
        messageId: '3',
        threadId: '',
        subject: 'Action required: Update your privacy settings',
        date: mid,
      },
    ],
  }),
  baseItem({
    id: 'other',
    title: 'Confirm Vultr server',
    company: 'Vultr',
    status: 'open',
    createdAt: mid,
    updatedAt: mid,
    fingerprint: 'other',
    sources: [
      { email: 'a@x.com', messageId: '9', threadId: '', subject: 'Server activated', date: mid },
    ],
  }),
]);
const collapsedOpen = collapsed.filter((i) => i.status === 'open');
assert.equal(collapsedOpen.length, 2);
assert.equal(collapsedOpen.find((i) => i.company === 'Acme')?.id, 'p2');
assert.equal(collapsedOpen.find((i) => i.company === 'Acme')?.sources.length, 1);
assert.equal(collapsedOpen.find((i) => i.company === 'Acme')?.sources[0].messageId, '2');

// Dismissed tombstone must block same message even when the model rephrases the title.
const dismissedSource = {
  email: 'a@x.com',
  messageId: '152490',
  threadId: 't1',
  subject: 'Reminder: Your workspace "Jaybird\'s Workspace" will be deleted in 7 days',
  date: fresh,
  gmailId: '19f6747be37acb49',
};
const healed = dropOpenItemsMatchingClosed([
  baseItem({
    id: 'open-resurrect',
    title: 'Confirm workspace deletion',
    company: 'Workspace Provider',
    status: 'open',
    createdAt: fresh,
    updatedAt: fresh,
    fingerprint: 'newfp',
    sources: [dismissedSource],
  }),
  baseItem({
    id: 'dismissed-mislabel',
    title: "Review Julia's USAA claim closure",
    company: '',
    status: 'dismissed',
    createdAt: mid,
    updatedAt: mid,
    fingerprint: 'oldfp',
    sources: [dismissedSource],
  }),
  baseItem({
    id: 'unrelated',
    title: 'Pay rent',
    company: 'Landlord',
    status: 'open',
    createdAt: fresh,
    updatedAt: fresh,
    fingerprint: 'rent',
    sources: [
      { email: 'a@x.com', messageId: '99', threadId: '', subject: 'Rent due', date: fresh },
    ],
  }),
]);
assert.equal(
  healed.filter((i) => i.status === 'open').map((i) => i.id).join(','),
  'unrelated',
);
assert.equal(healed.find((i) => i.id === 'dismissed-mislabel')?.status, 'dismissed');

assert.equal(
  matchesClosedDailySummaryItem(
    baseItem({
      title: 'Confirm Zelle payment',
      company: 'USAA',
      fingerprint: 'zelle-new',
      sources: [
        {
          email: 'a@x.com',
          messageId: '77',
          threadId: '',
          subject: 'Zelle payment received',
          date: fresh,
        },
      ],
    }),
    [
      baseItem({
        title: 'Confirm Zelle transaction',
        company: 'USAA Federal Savings Bank',
        status: 'dismissed',
        fingerprint: 'zelle-old',
        sources: [
          {
            email: 'a@x.com',
            messageId: '76',
            threadId: '',
            subject: 'Zelle payment received',
            date: mid,
          },
        ],
      }),
    ],
  ),
  true,
);

const merged = mergeSynthesizedDigest(
  {
    summaryText: '',
    generatedAt: fresh,
    lastScanYmd: '2026-07-14',
    windowDays: 10,
    lastError: null,
    items: [
      baseItem({
        id: 'd1',
        title: 'Confirm Zelle transaction',
        company: 'USAA Federal Savings Bank',
        status: 'dismissed',
        createdAt: fresh,
        updatedAt: fresh,
        fingerprint: 'zelle-old',
        sources: [
          {
            email: 'a@x.com',
            messageId: '76',
            threadId: '',
            subject: 'Zelle payment received',
            date: fresh,
          },
        ],
      }),
    ],
  },
  {
    summaryText: 'ok',
    windowDays: 10,
    lastScanYmd: '2026-07-14',
    items: [
      {
        title: 'Review your Zelle transaction',
        company: 'USAA',
        detail: '',
        needsReply: false,
        deadline: null,
        deadlineSource: 'none',
        sources: [
          {
            email: 'a@x.com',
            messageId: '76',
            threadId: '',
            subject: 'Zelle payment received',
            date: fresh,
          },
        ],
      },
      {
        title: 'Ship package',
        company: 'UPS',
        detail: '',
        needsReply: false,
        deadline: null,
        deadlineSource: 'none',
        sources: [
          {
            email: 'a@x.com',
            messageId: '88',
            threadId: '',
            subject: 'Your package is ready',
            date: fresh,
          },
        ],
      },
    ],
  },
);
assert.equal(merged.items.filter((i) => i.status === 'open').length, 1);
assert.equal(merged.items.find((i) => i.status === 'open')?.company, 'UPS');
assert.equal(merged.items.find((i) => i.status === 'dismissed')?.id, 'd1');

const sampleGuide = `# Daily Summary

## Show these (important)

- Deadlines I own or need to meet
- Money, contracts, or docs to sign

## Soft skip

- FYI newsletters with weak or no action

## Never show

- Shipping/delivery noise with no action needed
- bank statements

### Prefer more like this

### Prefer less like this

- Slack notifications indicating unread messages or channel updates (no action required)
- Security alerts or account activity notifications that do not require a reply
`;

const sections = parseGuideSections(sampleGuide);
assert.ok(sections.never_show.some((b) => /shipping/i.test(b)));
assert.ok(guideBulletMatchesItem('bank statements', 'USAA Review your USAA credit card statement bank statements'));

assert.equal(
  shouldExcludeDailySummaryItem({
    company: 'Amazon',
    title: 'Track package deliveries',
    detail: 'Amazon: Several packages have been shipped and delivered.',
  }),
  'shipping',
);

assert.equal(
  shouldExcludeDailySummaryItem({
    company: 'Slack',
    title: 'Review Slack unread messages',
    detail: 'Slack: There are 5 new unread messages in the #facilities-committee channel',
  }),
  'slack_unread',
);

assert.equal(
  shouldExcludeDailySummaryItem({
    company: 'Google',
    title: 'Review new sign-in activity',
    detail: 'Google: A new sign-in was detected on your account',
  }),
  'security_fyi',
);

assert.equal(
  shouldExcludeDailySummaryItem({
    company: 'WesternP',
    title: 'Follow up on lease',
    detail: 'Please reply about the unit',
    sources: [{ subject: 'Lease', from: 'Office <manager@westernp.com>' }],
  }),
  'blocked_domain',
);

assert.equal(
  guideExcludeReason(
    {
      company: 'Chase',
      title: 'Review bank statement',
      detail: 'Your monthly bank statements are ready',
    },
    sampleGuide,
  ),
  'never_show',
);

assert.equal(
  guideExcludeReason(
    {
      company: 'Acme',
      title: 'Sign the contract',
      detail: 'Acme: Money and contracts — docs to sign by Friday',
    },
    sampleGuide,
  ),
  null,
);

const prunedNoise = pruneExpiredGmailDailySummary(
  {
    summaryText: '',
    generatedAt: fresh,
    lastScanYmd: '2026-07-14',
    windowDays: 10,
    lastError: null,
    items: [
      baseItem({
        id: 'ship1',
        title: 'Track package deliveries',
        company: 'Amazon',
        detail: 'Amazon: packages have been shipped and delivered',
        status: 'open',
        createdAt: fresh,
        updatedAt: fresh,
        fingerprint: 'shipfp',
      }),
      baseItem({
        id: 'keep1',
        title: 'Sign insurance paperwork',
        company: 'USAA',
        detail: 'USAA: contract docs to sign',
        status: 'open',
        createdAt: fresh,
        updatedAt: fresh,
        fingerprint: 'keepfp',
      }),
    ],
  },
  now,
  { guideMarkdown: sampleGuide },
);
assert.equal(prunedNoise.changed, true);
assert.equal(
  prunedNoise.digest.items.find((i) => i.id === 'ship1')?.status,
  'dismissed',
);
assert.equal(
  prunedNoise.digest.items.find((i) => i.id === 'keep1')?.status,
  'open',
);

// Dismissed tombstones survive past the rolling window so rescans cannot resurrect them.
const oldDismissed = baseItem({
  id: 'old-dismissed',
  title: 'Confirm Zelle transaction',
  company: 'USAA',
  status: 'dismissed',
  createdAt: old,
  updatedAt: old,
  fingerprint: 'zelle-tomb',
  sources: [
    {
      email: 'a@x.com',
      messageId: '76',
      threadId: '',
      subject: 'Zelle payment received',
      date: old,
    },
  ],
});
const prunedTomb = pruneExpiredGmailDailySummary(
  {
    summaryText: '',
    generatedAt: old,
    lastScanYmd: '2026-07-01',
    windowDays: 10,
    lastError: null,
    items: [oldDismissed],
  },
  now,
);
assert.equal(prunedTomb.digest.items.length, 1);
assert.equal(prunedTomb.digest.items[0]?.status, 'dismissed');

const resurrectAttempt = mergeSynthesizedDigest(prunedTomb.digest, {
  items: [
    {
      title: 'Review your Zelle transaction',
      company: 'USAA',
      detail: '',
      needsReply: false,
      deadline: null,
      deadlineSource: 'none',
      sources: oldDismissed.sources,
    },
  ],
});
assert.equal(resurrectAttempt.items.filter((i) => i.status === 'open').length, 0);

// Scan save must not overwrite a dismiss that landed while synthesis was running.
const staleOpen = baseItem({
  id: 'race-open',
  title: 'Pay rent',
  company: 'Landlord',
  status: 'open',
  createdAt: fresh,
  updatedAt: fresh,
  fingerprint: 'rent-race',
  sources: [
    { email: 'a@x.com', messageId: '99', threadId: '', subject: 'Rent due', date: fresh },
  ],
});
const latestDismissed = { ...staleOpen, status: 'dismissed', updatedAt: fresh, pinned: false };
const reconciled = reconcileDigestClosedTombstones(
  {
    summaryText: '',
    generatedAt: fresh,
    lastScanYmd: '2026-08-23',
    windowDays: 10,
    lastError: null,
    items: [staleOpen],
  },
  {
    summaryText: '',
    generatedAt: fresh,
    lastScanYmd: '2026-08-23',
    windowDays: 10,
    lastError: null,
    items: [latestDismissed],
  },
);
assert.equal(openGmailWeeklyItems(reconciled).length, 0);
assert.equal(reconciled.items.find((i) => i.id === 'race-open')?.status, 'dismissed');

console.log('validate-daily-summary: ok');
