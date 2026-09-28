/**
 * Search intake Gmail for flight / bus / hotel / hostel confirmations and
 * extract trip-critical facts (check-in, bag limits, confirmations).
 */
import { openRouterChatJson } from './openrouter-chat-json.js';
import { gmailIntakeAddresses } from './events-finder-gmail.js';
import { fetchWeeklyMailboxMessages } from './gmail-weekly-summary-fetch.js';
import { eventDateYmd } from './events-finder-travel-logistics.js';

const MAX_MESSAGES = 24;
const TEXT_PER_MSG = 1800;

/**
 * @param {unknown} raw
 * @returns {string}
 */
function cleanMailText(raw) {
  return String(raw || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\.[A-Za-z][\w-]*\s*\{[^}]*\}/g, ' ')
    .replace(/\{[^{}]{0,200}\}/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const RESERVATION_QUERY_CORE = [
  'subject:(itinerary OR confirmation OR reservation OR booking OR e-ticket',
  'OR "boarding pass" OR "check-in" OR eTicket OR "your trip")',
  'OR from:(united.com OR delta.com OR aa.com OR jetblue.com OR southwest.com',
  'OR alaskaair.com OR expedia.com OR booking.com OR airbnb.com OR hilton.com',
  'OR marriott.com OR hostelworld.com OR hotels.com OR kayak.com',
  'OR megabus.com OR greyhound.com OR flixbus.com OR amtrak.com',
  'OR hopper.com OR tripadvisor.com OR vrbo.com OR ihg.com)',
].join(' ');

/**
 * @param {object} event
 * @returns {string}
 */
export function reservationSearchQuery(event) {
  const city = String(event?.city || '').trim();
  const bits = [RESERVATION_QUERY_CORE];
  if (city) bits.push(`("${city.replace(/"/g, '')}")`);
  bits.push('newer_than:180d');
  return bits.join(' ');
}

/**
 * @param {string} existing
 * @param {string} scraped
 * @param {string} [marker]
 */
export function mergeScrapedNotes(existing, scraped, marker = '--- From inbox ---') {
  const add = String(scraped || '').trim();
  if (!add) return String(existing || '').trim();
  const prev = String(existing || '').trim();
  if (!prev) return add;
  const idx = prev.indexOf(marker);
  const head = (idx >= 0 ? prev.slice(0, idx) : prev).trimEnd();
  return `${head}\n\n${marker}\n${add}`.trim();
}

/**
 * @param {object} event
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function scrapeTripReservations(event, env = process.env) {
  const addresses = gmailIntakeAddresses(env);
  if (!addresses.length) {
    return {
      ok: false,
      error: 'gmail_not_configured',
      travelLogistics: '',
      inRegionNotes: '',
      scanned: 0,
    };
  }

  const query = reservationSearchQuery(event);
  const city = String(event?.city || '').trim();
  const title = String(event?.title || event?.name || 'Trip').trim();
  const start = eventDateYmd(event?.start);
  const end = eventDateYmd(event?.end) || start;

  /** @type {Array<{ subject: string, from: string, date: string, text: string }>} */
  const messages = [];
  let lastError = '';
  for (const email of addresses) {
    try {
      const box = await fetchWeeklyMailboxMessages(email, env, {
        query,
        days: 180,
        maxMessages: MAX_MESSAGES,
      });
      if (!box?.ok) {
        lastError = String(box?.error || 'gmail_fetch_failed');
        continue;
      }
      for (const msg of box.messages || []) {
        messages.push({
          subject: String(msg.subject || '').slice(0, 200),
          from: String(msg.from || '').slice(0, 160),
          date: String(msg.date || '').slice(0, 80),
          text: cleanMailText(msg.text || msg.snippet || '').slice(0, TEXT_PER_MSG),
        });
        if (messages.length >= MAX_MESSAGES) break;
      }
    } catch (e) {
      lastError = String(e?.message || e);
    }
    if (messages.length >= MAX_MESSAGES) break;
  }

  if (!messages.length) {
    return {
      ok: false,
      error: lastError || 'no_reservation_mail',
      travelLogistics: '',
      inRegionNotes: '',
      scanned: 0,
    };
  }

  const snippetBlock = messages
    .map(
      (m, i) =>
        `[${i + 1}] ${m.subject}\nFrom: ${m.from}\nDate: ${m.date}\n${m.text}`,
    )
    .join('\n---\n')
    .slice(0, 16_000);

  const ai = await openRouterChatJson(
    env,
    [
      {
        role: 'system',
        content: `You extract trip-critical facts from reservation emails.
Only keep flights, buses, trains, hotels, hostels, vacation rentals, and local-activity tickets that match the destination or travel dates.
Reply JSON only:
{
  "travelLogistics": "plain text for a trip notebook. Group by type. Include confirmation numbers, dates/times, check-in and check-out times, addresses, bag weight limits, seat/class, cancellation deadlines, and other must-know rules. Omit marketing.",
  "inRegionNotes": "plain text for local tickets, tours, or in-city activity reservations only. Empty string if none."
}
If nothing matches the destination, return empty strings. Never invent confirmations or times.`,
      },
      {
        role: 'user',
        content: [
          `Event: ${title.slice(0, 160)}`,
          `City: ${city || 'unknown'}`,
          `Travel window: ${start || 'unknown'}${end && end !== start ? ` → ${end}` : ''}`,
          '',
          'Emails:',
          snippetBlock,
        ].join('\n'),
      },
    ],
    {
      xTitle: 'dashbird-reservation-scrape',
      maxTokens: 2200,
      timeoutMs: 90_000,
    },
  );

  if (!ai.ok || !ai.parsed || typeof ai.parsed !== 'object') {
    const fallback = messages
      .map((m) => {
        const lines = [
          m.subject,
          m.from ? `From: ${m.from}` : '',
          m.date ? `Date: ${m.date}` : '',
          m.text ? m.text.slice(0, 600) : '',
        ].filter(Boolean);
        return lines.join('\n');
      })
      .join('\n\n---\n\n');
    return {
      ok: true,
      error: ai.error || 'summarize_failed',
      travelLogistics: fallback.slice(0, 12_000),
      inRegionNotes: '',
      scanned: messages.length,
      extractedBy: 'fallback',
    };
  }

  const parsed = /** @type {Record<string, unknown>} */ (ai.parsed);
  return {
    ok: true,
    error: null,
    travelLogistics: String(parsed.travelLogistics || '').trim().slice(0, 12_000),
    inRegionNotes: String(parsed.inRegionNotes || '').trim().slice(0, 8_000),
    scanned: messages.length,
    extractedBy: 'llm',
  };
}
