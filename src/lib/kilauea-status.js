/**
 * Kīlauea (Hawaiʻi) status for the Earth strip + summit livestream card.
 * Alert/notice: USGS HANS public API. Short fountain updates: HVO volcano-messages HTML.
 * Cameras: USGS short links → YouTube livestream video IDs.
 * Nearby Hawaii quakes are intentionally not shown (local CA quake row only).
 */
const KILAUEA_VNUM = '332010';
const KILAUEA_ELEV_FT = 4091;
const KILAUEA_ELEV_M = 1247;

const HANS_ELEVATED = 'https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes';
const HANS_CAP = 'https://volcanoes.usgs.gov/hans-public/api/volcano/getCapElevated';
const HANS_NEWEST = `https://volcanoes.usgs.gov/hans-public/api/volcano/newestForVolcano/${KILAUEA_VNUM}`;
const HVO_MESSAGES_URL =
  'https://www.usgs.gov/volcanoes/kilauea/volcano-updates/volcano-messages';
const KILAUEA_UPDATES_URL = 'https://www.usgs.gov/volcanoes/kilauea/volcano-updates';
const SUMMIT_WEBCAMS_URL = 'https://www.usgs.gov/volcanoes/kilauea/summit-webcams';

const FETCH_TIMEOUT_MS = 16_000;
const UA = 'Dashbird/1.0 (dashboard Kilauea status; https://www.usgs.gov/volcanoes/kilauea)';

function cleanUrl(raw, fallback) {
  const s = String(raw || '').trim();
  if (!/^https?:\/\//i.test(s)) return fallback;
  return s.replace(/([^:]\/)\/+/g, '$1');
}

/** Stable USGS short links for the three summit livestreams. */
const CAM_SHORT_LINKS = [
  {
    id: 'v1cam',
    label: 'V1cam · west Halemaʻumaʻu',
    shortUrl: 'https://url.usgs.gov/v1cam',
    fallbackVideoId: 'HggWKlZv9yk',
  },
  {
    id: 'v2cam',
    label: 'V2cam · east Halemaʻumaʻu',
    shortUrl: 'https://url.usgs.gov/v2cam',
    fallbackVideoId: 'Tz5tPqRRv1Y',
  },
  {
    id: 'v3cam',
    label: 'V3cam · south Halemaʻumaʻu',
    shortUrl: 'https://url.usgs.gov/v3cam',
    fallbackVideoId: 'gXKuUyKt8mc',
  },
];

/**
 * @param {number} ms
 * @returns {AbortSignal}
 */
function timeoutSignal(ms) {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

/**
 * @param {string} url
 * @param {{ accept?: string, timeoutMs?: number }} [opts]
 */
async function fetchText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const res = await fetch(url, {
    signal: timeoutSignal(timeoutMs),
    redirect: 'follow',
    headers: {
      Accept: opts.accept || 'text/html,application/json;q=0.9,*/*;q=0.8',
      'User-Agent': UA,
    },
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return { text: await res.text(), finalUrl: res.url };
}

/**
 * @param {string} url
 */
async function fetchJson(url) {
  const { text } = await fetchText(url, { accept: 'application/json' });
  return JSON.parse(text);
}

function stripHtml(raw) {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|li|div|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text
 */
function parseEruptionStats(text) {
  const s = String(text || '');
  const episodeMatch = s.match(/\bEpisode\s+(\d+)\b/i);
  const startedMatch =
    s.match(
      /\bbegan\s+at\s+(?:about\s+)?(\d{1,2}:\d{2}\s*(?:a\.m\.|p\.m\.)\s*HST(?:\s+on\s+[A-Za-z]+\s+\d{1,2})?)/i,
    ) ||
    s.match(
      /\bbegan\s+at\s+(?:about\s+)?([^.]{8,60}?(?:a\.m\.|p\.m\.)\s*HST[^.]{0,40})/i,
    );
  const heightMatch =
    s.match(
      /(?:fountain(?:\s+has\s+grown\s+to|\s+is)?|reaching\s+heights?\s+of(?:\s+about)?)\s+(\d+)\s*(?:feet|ft)\s*(?:\((\d+)\s*m(?:eters?)?\))?/i,
    ) || s.match(/\b(\d+)\s*feet?\s*\((\d+)\s*meters?\)/i);

  let fountainFt = null;
  let fountainM = null;
  if (heightMatch) {
    fountainFt = Number.parseInt(heightMatch[1], 10);
    fountainM = heightMatch[2]
      ? Number.parseInt(heightMatch[2], 10)
      : Number.isFinite(fountainFt)
        ? Math.round(fountainFt * 0.3048)
        : null;
  }

  const startedRaw = startedMatch?.[1] ? startedMatch[1].replace(/\s+/g, ' ').trim() : null;
  let startedShort = startedRaw;
  if (startedRaw) {
    const compact = startedRaw
      .replace(/\s*a\.m\./i, 'a')
      .replace(/\s*p\.m\./i, 'p')
      .replace(/\s+HST/i, ' HST')
      .replace(/\s+on\s+/i, ' ')
      .trim();
    startedShort = compact.length > 28 ? compact.slice(0, 28).trim() : compact;
  }

  return {
    episode: episodeMatch ? Number.parseInt(episodeMatch[1], 10) : null,
    startedRaw,
    startedShort,
    fountainFt: Number.isFinite(fountainFt) ? fountainFt : null,
    fountainM: Number.isFinite(fountainM) ? fountainM : null,
  };
}

const MONTH_ABBR = {
  january: 'Jan',
  february: 'Feb',
  march: 'Mar',
  april: 'Apr',
  may: 'May',
  june: 'Jun',
  july: 'Jul',
  august: 'Aug',
  september: 'Sep',
  october: 'Oct',
  november: 'Nov',
  december: 'Dec',
};

/**
 * @param {string} month
 */
function abbrevMonth(month) {
  const key = String(month || '')
    .replace(/\./g, '')
    .trim()
    .toLowerCase();
  return MONTH_ABBR[key] || String(month || '').slice(0, 3);
}

/**
 * Compact a dated forecast window from HVO text, e.g. "between August 8 and 14" → "Aug 8–14".
 * Only returns a value when concrete calendar dates are present (not "within a few days").
 * @param {string} text
 * @returns {string | null}
 */
function extractForecastDateWindow(text) {
  const s = String(text || '');
  // between August 8 and August 14 | between August 8 and 14
  const between = s.match(
    /\bbetween\s+([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+and\s+(?:([A-Za-z]+)\.?\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i,
  );
  if (between) {
    const m1 = abbrevMonth(between[1]);
    const d1 = between[2];
    const m2 = between[3] ? abbrevMonth(between[3]) : m1;
    const d2 = between[4];
    return m1 === m2 ? `${m1} ${d1}–${d2}` : `${m1} ${d1}–${m2} ${d2}`;
  }
  // August 8–14 | Aug. 8-14 | August 8 to 14 | August 8 through August 14
  const enDash = s.match(
    /\b([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*[–—-]\s*(?:([A-Za-z]+)\.?\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/,
  );
  if (enDash) {
    const m1 = abbrevMonth(enDash[1]);
    const d1 = enDash[2];
    const m2 = enDash[3] ? abbrevMonth(enDash[3]) : m1;
    const d2 = enDash[4];
    return m1 === m2 ? `${m1} ${d1}–${d2}` : `${m1} ${d1}–${m2} ${d2}`;
  }
  const thru = s.match(
    /\b([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:to|through|thru)\s+(?:([A-Za-z]+)\.?\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i,
  );
  if (thru) {
    const m1 = abbrevMonth(thru[1]);
    const d1 = thru[2];
    const m2 = thru[3] ? abbrevMonth(thru[3]) : m1;
    const d2 = thru[4];
    return m1 === m2 ? `${m1} ${d1}–${d2}` : `${m1} ${d1}–${m2} ${d2}`;
  }
  // Single calendar day: "on August 12" / "around August 12"
  const single = s.match(/\b(?:on|around|by|before)\s+([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (single) return `${abbrevMonth(single[1])} ${single[2]}`;
  return null;
}

/**
 * Detect a dated forecast for the NEXT Kīlauea eruption / episode.
 * Only counts as a forecast when concrete dates are present (e.g. Aug 8–14).
 * Matches current HVO phrasing like "current forecast between August 8 and 14"
 * and "forecast window for episode 53 is between August 8 and August 14".
 * @param {string} text
 * @returns {{ hasForecast: boolean, forecast: string | null, forecastWhen: string | null }}
 */
function parseNextEruptionForecast(text) {
  const blob = String(text || '').replace(/\s+/g, ' ').trim();
  if (!blob) return { hasForecast: false, forecast: null, forecastWhen: null };

  const sentences = blob.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/);
  const forecastCue =
    /\b(?:forecast(?:ed|ing)?(?:\s+window)?|next\s+(?:(?:lava\s+|high\s+)?(?:fountain(?:ing)?\s+)?)?(?:episode|eruption|eruptive\s+episode)|another\s+episode\s+is\s+likely|episode\s+\d+\s+is\s+likely|likely\s+to\s+(?:begin|start|resume)|expected\s+to\s+(?:begin|start|resume))\b/i;

  for (const raw of sentences) {
    const s = raw.trim();
    if (!s || !forecastCue.test(s)) continue;
    const forecastWhen = extractForecastDateWindow(s);
    if (!forecastWhen) continue;
    return {
      hasForecast: true,
      forecast: s.replace(/\s+/g, ' ').trim().slice(0, 220),
      forecastWhen,
    };
  }

  // Whole-blob fallback: cue + date window may span sentence boundaries after HTML strip.
  if (forecastCue.test(blob)) {
    const forecastWhen = extractForecastDateWindow(blob);
    if (forecastWhen) {
      return {
        hasForecast: true,
        forecast: blob.slice(0, 220),
        forecastWhen,
      };
    }
  }

  return { hasForecast: false, forecast: null, forecastWhen: null };
}

/**
 * Reduce the full volcano-updates page HTML to its readable activity text.
 * @param {string} html
 */
function extractKilaueaUpdateText(html) {
  const raw = String(html || '');
  // Prefer the Volcanic Activity Summary / activity region when present, else whole page.
  const region =
    raw.match(/Volcanic\s+Activity\s+Summary[\s\S]{0,4000}/i)?.[0] ||
    raw.match(/Activity\s+Summary[\s\S]{0,4000}/i)?.[0] ||
    raw;
  return stripHtml(region).slice(0, 6000);
}

/**
 * @param {string} html
 */
function parseHvoMessages(html) {
  const out = [];
  const re =
    /class="volcano-message-single[^"]*"[\s\S]*?volcano-message-title[^>]*>\s*([^<]+?)\s*<[\s\S]*?field-content[^>]*>\s*([^<]+?)\s*</gi;
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    const title = m[1].replace(/\s+/g, ' ').trim();
    const body = m[2].replace(/\s+/g, ' ').trim();
    if (title && body) out.push({ title, body });
  }
  return out;
}

function youtubeIdFromUrl(url) {
  const s = String(url || '');
  const m =
    s.match(/[?&]v=([A-Za-z0-9_-]{6,})/) ||
    s.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/) ||
    s.match(/youtube\.com\/live\/([A-Za-z0-9_-]{6,})/) ||
    s.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/);
  return m?.[1] || null;
}

/**
 * @param {{ id: string, label: string, shortUrl: string, fallbackVideoId: string }} cam
 */
async function resolveCamera(cam) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch(cam.shortUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': UA },
    });
    clearTimeout(timer);
    const videoId = youtubeIdFromUrl(res.url) || cam.fallbackVideoId;
    return {
      id: cam.id,
      label: cam.label,
      videoId,
      watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
      embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`,
    };
  } catch {
    return {
      id: cam.id,
      label: cam.label,
      videoId: cam.fallbackVideoId,
      watchUrl: `https://www.youtube.com/watch?v=${cam.fallbackVideoId}`,
      embedUrl: `https://www.youtube.com/embed/${cam.fallbackVideoId}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`,
    };
  }
}

function isEruptingAlert(alertLevel, colorCode, textBlob) {
  const alert = String(alertLevel || '').toUpperCase();
  const color = String(colorCode || '').toUpperCase();
  const t = String(textBlob || '').toLowerCase();

  // HVO episodic updates keep saying "eruption" / "fountaining" while paused between
  // episodes ("The Halemaʻumaʻu eruption is paused"). That must not count as erupting.
  if (
    /\b(?:not\s+erupting|eruption\s+is\s+paused|summit\s+eruption\s+.*?is\s+paused|currently\s+paused|eruption\s+has\s+(?:paused|ended)|fountaining\s+has\s+(?:paused|ended|stopped))\b/.test(
      t,
    ) ||
    (/\bpaused\b/.test(t) && /\b(?:eruption|halema|fountain)\b/.test(t))
  ) {
    return false;
  }

  // Elevated aviation/alert codes usually mean unrest or eruption in progress.
  if (color === 'ORANGE' || color === 'RED') return true;
  if (alert === 'WATCH' || alert === 'WARNING') return true;

  // Present-tense active eruption only — not historical "has been erupting episodically".
  if (
    /\b(?:is\s+erupting|currently\s+erupting|lava\s+is\s+(?:erupting|fountaining)|fountaining\s+(?:is\s+)?(?:underway|ongoing|continuing|in\s+progress)|eruption\s+is\s+(?:underway|ongoing|continuing|in\s+progress)|active\s+lava\s+fountains?\b)/.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * @returns {Promise<{ ok: true, items: object[], cameras: object[], status: object } | { ok: false, error: string }>}
 */
export async function buildKilaueaDashboardPayload() {
  if (String(process.env.EARTH_KILAUEA || '').trim() === '0') {
    return { ok: true, disabled: true, items: [], cameras: [], status: { disabled: true } };
  }

  const upstream = {};

  const [
    elevatedSettled,
    capSettled,
    newestSettled,
    updatesSettled,
    messagesSettled,
    camerasSettled,
  ] = await Promise.allSettled([
    fetchJson(HANS_ELEVATED),
    fetchJson(HANS_CAP),
    fetchJson(HANS_NEWEST),
    fetchText(KILAUEA_UPDATES_URL, { accept: 'text/html', timeoutMs: 18_000 }),
    fetchText(HVO_MESSAGES_URL, { accept: 'text/html', timeoutMs: 18_000 }),
    Promise.all(CAM_SHORT_LINKS.map(resolveCamera)),
  ]);

  let alertLevel = null;
  let colorCode = null;
  let noticeUrl = KILAUEA_UPDATES_URL;
  let synopsis = '';
  let noticeSummary = '';
  let elevationFt = KILAUEA_ELEV_FT;
  let elevationM = KILAUEA_ELEV_M;

  if (elevatedSettled.status === 'fulfilled' && Array.isArray(elevatedSettled.value)) {
    const row = elevatedSettled.value.find(
      (v) =>
        String(v?.vnum) === KILAUEA_VNUM ||
        /k[iī]lauea/i.test(String(v?.volcano_name || '')),
    );
    if (row) {
      alertLevel = row.alert_level || alertLevel;
      colorCode = row.color_code || colorCode;
      if (row.notice_url) noticeUrl = cleanUrl(row.notice_url, noticeUrl);
    }
  } else if (elevatedSettled.status === 'rejected') {
    upstream.elevated = String(elevatedSettled.reason?.message || elevatedSettled.reason);
  }

  if (capSettled.status === 'fulfilled' && Array.isArray(capSettled.value)) {
    const row = capSettled.value.find(
      (v) =>
        String(v?.vnum) === KILAUEA_VNUM ||
        /k[iī]lauea/i.test(String(v?.volcano_name_appended || '')),
    );
    if (row) {
      alertLevel = row.alert_level || alertLevel;
      colorCode = row.color_code || colorCode;
      synopsis = String(row.synopsis || '').trim() || synopsis;
      if (row.notice_url) noticeUrl = cleanUrl(row.notice_url, noticeUrl);
      if (Number.isFinite(Number(row.elevation_feet))) {
        elevationFt = Math.round(Number(row.elevation_feet));
      }
      if (Number.isFinite(Number(row.elevation_meters))) {
        elevationM = Math.round(Number(row.elevation_meters));
      }
    }
  } else if (capSettled.status === 'rejected') {
    upstream.cap = String(capSettled.reason?.message || capSettled.reason);
  }

  if (newestSettled.status === 'fulfilled' && newestSettled.value && typeof newestSettled.value === 'object') {
    const n = newestSettled.value;
    alertLevel = n.noticeHighestAlertLevel || alertLevel;
    colorCode = n.noticeHighestColorCode || colorCode;
    if (n.noticeUrl) noticeUrl = cleanUrl(n.noticeUrl, noticeUrl);
    const sections = Array.isArray(n.noticeSections) ? n.noticeSections : [];
    const first = sections[0] || {};
    synopsis = stripHtml(first.synopsis || synopsis);
    noticeSummary = stripHtml(first.summary || '');
  } else if (newestSettled.status === 'rejected') {
    upstream.newest = String(newestSettled.reason?.message || newestSettled.reason);
  }

  // Primary content source: the main volcano-updates page.
  let updatesText = '';
  if (updatesSettled.status === 'fulfilled') {
    updatesText = extractKilaueaUpdateText(updatesSettled.value.text);
  } else {
    upstream.updates = String(updatesSettled.reason?.message || updatesSettled.reason);
  }

  /** @type {{ title: string, body: string }[]} */
  let messages = [];
  if (messagesSettled.status === 'fulfilled') {
    messages = parseHvoMessages(messagesSettled.value.text);
  } else {
    upstream.messages = String(messagesSettled.reason?.message || messagesSettled.reason);
  }

  const latestMessage = messages[0]?.body || '';
  const textBlob = [updatesText, latestMessage, synopsis, noticeSummary].filter(Boolean).join(' · ');
  const statsFromUpdates = parseEruptionStats(updatesText);
  const statsFromMessage = parseEruptionStats(latestMessage);
  const statsFromNotice = parseEruptionStats(`${synopsis} ${noticeSummary}`);
  const stats = {
    episode: statsFromUpdates.episode ?? statsFromMessage.episode ?? statsFromNotice.episode,
    startedRaw: statsFromUpdates.startedRaw || statsFromMessage.startedRaw || statsFromNotice.startedRaw,
    startedShort:
      statsFromUpdates.startedShort || statsFromMessage.startedShort || statsFromNotice.startedShort,
    fountainFt: statsFromUpdates.fountainFt ?? statsFromMessage.fountainFt ?? statsFromNotice.fountainFt,
    fountainM: statsFromUpdates.fountainM ?? statsFromMessage.fountainM ?? statsFromNotice.fountainM,
  };

  const forecast = parseNextEruptionForecast(
    [updatesText, latestMessage, synopsis, noticeSummary].filter(Boolean).join(' '),
  );
  // Dated window only — vague "likely soon" without calendar dates does not count.
  const hasDatedForecast = Boolean(forecast.hasForecast && forecast.forecastWhen);

  const erupting = isEruptingAlert(alertLevel, colorCode, textBlob);
  // Strip/active: fountaining now, or a dated next-episode forecast. Alert-only = inactive.
  const volcanoActive = erupting || hasDatedForecast;
  const cameras =
    camerasSettled.status === 'fulfilled' && Array.isArray(camerasSettled.value)
      ? camerasSettled.value
      : CAM_SHORT_LINKS.map((c) => ({
          id: c.id,
          label: c.label,
          videoId: c.fallbackVideoId,
          watchUrl: `https://www.youtube.com/watch?v=${c.fallbackVideoId}`,
          embedUrl: `https://www.youtube.com/embed/${c.fallbackVideoId}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`,
        }));

  /** @type {object[]} */
  const items = [];

  if (volcanoActive) {
    const parts = [];
    if (erupting) parts.push('Erupting');
    // Episode / fountain height are only current while lava is actively erupting.
    if (erupting) {
      if (stats.episode != null) parts.push(`Ep ${stats.episode}`);
      if (stats.startedShort) parts.push(`since ${stats.startedShort}`);
      if (stats.fountainFt != null) {
        parts.push(
          stats.fountainM != null
            ? `fountain ${stats.fountainFt} ft (${stats.fountainM} m)`
            : `fountain ${stats.fountainFt} ft`,
        );
      } else {
        parts.push(`summit ${elevationFt} ft`);
      }
      if (alertLevel || colorCode) {
        parts.push([alertLevel, colorCode].filter(Boolean).join('/'));
      }
    } else if (alertLevel || colorCode) {
      parts.push([alertLevel, colorCode].filter(Boolean).join(' · '));
    }
    // Dated next-eruption window (required for non-erupting strip visibility).
    // Calendar mark stays on the title only — not repeated in the subtitle.
    if (hasDatedForecast) {
      parts.push(`next: ${forecast.forecastWhen}`);
    }

    // ! when erupting, 📅 when a dated next-eruption forecast is available.
    const marks = [];
    if (erupting) marks.push('❗');
    if (hasDatedForecast) marks.push('📅');
    const label = marks.length ? `Kīlauea ${marks.join('')}` : 'Kīlauea';

    items.push({
      earthType: 'kilauea_volcano',
      label,
      detailLine: parts.join(' · '),
      forecastUrl: noticeUrl || KILAUEA_UPDATES_URL,
      erupting,
      eruptingMark: erupting ? '❗' : null,
      forecast: forecast.forecast,
      forecastWhen: forecast.forecastWhen,
      hasEruptionForecast: hasDatedForecast,
      forecastMark: hasDatedForecast ? '📅' : null,
      alertLevel: alertLevel || null,
      colorCode: colorCode || null,
      episode: stats.episode,
      started: stats.startedRaw,
      fountainFt: erupting ? stats.fountainFt : null,
      fountainM: erupting ? stats.fountainM : null,
      summitFt: elevationFt,
      summitM: elevationM,
      latestMessage: latestMessage || null,
      synopsis: synopsis || null,
    });
  }

  return {
    ok: true,
    items,
    cameras,
    status: {
      erupting,
      eruptingMark: erupting ? '❗' : null,
      active: volcanoActive,
      forecast: forecast.forecast,
      forecastWhen: forecast.forecastWhen,
      hasEruptionForecast: hasDatedForecast,
      forecastMark: hasDatedForecast ? '📅' : null,
      alertLevel: alertLevel || null,
      colorCode: colorCode || null,
      episode: stats.episode,
      started: stats.startedRaw,
      fountainFt: erupting ? stats.fountainFt : null,
      fountainM: erupting ? stats.fountainM : null,
      summitFt: elevationFt,
      summitM: elevationM,
      noticeUrl,
      updatesUrl: KILAUEA_UPDATES_URL,
      webcamsUrl: SUMMIT_WEBCAMS_URL,
      latestMessage: latestMessage || null,
      synopsis: synopsis || null,
      upstream: Object.keys(upstream).length ? upstream : undefined,
    },
  };
}
