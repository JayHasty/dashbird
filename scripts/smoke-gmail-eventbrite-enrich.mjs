/**
 * Smoke: Eventbrite click URL extract + page enrich for Gmail intake.
 */
import {
  extractPlatformUrls,
  pickBestPlatformUrl,
  isEventbriteEventUrl,
  enrichGmailEventsFromPublicPages,
  resolveEventbriteTrackingUrl,
} from '../src/lib/events-finder-gmail.js';

const sampleHtml = `
Eventbrite
HMU Tie Me Down: Hot, Dirty Rope
More Info: https://clicks.eventbrite.com/f/a/onz92BQmVLRPj3jB0Nj_xQ~~/AAQxARA~/fulltokenhere
Also https://www.eventbrite.com/ and https://eventbrite.com/
`;

const urls = extractPlatformUrls(sampleHtml);
console.log('extractPlatformUrls:', urls);
console.log('pickBest:', pickBestPlatformUrl(urls, ''));

const known = 'https://www.eventbrite.com/e/hmu-tie-me-down-hot-dirty-rope-tickets-1992075386105';
console.log('isEventUrl:', isEventbriteEventUrl(known));
console.log('resolve known:', await resolveEventbriteTrackingUrl(known));

const thin = [
  {
    id: 'gmail:user@example.com:152049',
    title: 'Just added! HMU Tie Me Down: Hot, Dirty Rope from Hit Me Up 📅',
    start: '2026-07-16T00:00:00.000Z',
    end: null,
    venue: null,
    city: null,
    url: 'https://eventbrite.com/',
    source: 'eventbrite',
    raw: {
      via: 'platform_link',
      urls: ['https://eventbrite.com/', known],
      mailbox: 'user@example.com',
    },
  },
];

const enriched = await enrichGmailEventsFromPublicPages(thin);
console.log(JSON.stringify(enriched[0], null, 2));
const e = enriched[0];
const ok =
  e
  && isEventbriteEventUrl(e.url)
  && e.city
  && e.venue
  && e.start
  && e.start !== '2026-07-16T00:00:00.000Z'
  && !/^Just added!/i.test(e.title);
console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL');
process.exit(ok ? 0 : 1);
