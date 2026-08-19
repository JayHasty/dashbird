/**
 * Deterministic Daily Summary exclusions from the markdown ingestion guide.
 * Never show / Soft skip / Prefer less are enforced in code (LLM guide is advisory only).
 */

/** Keep in sync with GUIDE_SECTION_KEYS in gmail-daily-summary-guide-store.js */
const SECTION_HEADINGS = {
  show_these: '## Show these (important)',
  soft_skip: '## Soft skip',
  never_show: '## Never show',
  prefer_more: '### Prefer more like this',
  prefer_less: '### Prefer less like this',
};

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'was', 'have',
  'not', 'no', 'mail', 'email', 'similar', 'like', 'need', 'needed', 'action', 'when', 'where',
  'only', 'also', 'into', 'over', 'than', 'then', 'them', 'these', 'those', 'does', 'did',
  'require', 'requires', 'required', 'reply', 'decision', 'notifications', 'notification',
  'updates', 'update', 'confirmations', 'confirmation', 'notices', 'notice',
]);

/**
 * @param {string} append
 */
function normalizePatternKey(append) {
  return String(append || '')
    .replace(/^-\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} a
 * @param {string} b
 */
function patternSimilarity(a, b) {
  const ta = new Set(
    normalizePatternKey(a)
      .split(' ')
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
  const tb = new Set(
    normalizePatternKey(b)
      .split(' ')
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
  if (!ta.size || !tb.size) {
    return normalizePatternKey(a) === normalizePatternKey(b) ? 1 : 0;
  }
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter += 1;
  }
  return inter / Math.min(ta.size, tb.size);
}

/**
 * @typedef {{
 *   show_these: string[],
 *   soft_skip: string[],
 *   never_show: string[],
 *   prefer_more: string[],
 *   prefer_less: string[],
 * }} ParsedGuideSections
 */

/**
 * @param {string} markdown
 * @param {string} heading
 */
function sectionBullets(markdown, heading) {
  const text = String(markdown || '');
  const idx = text.indexOf(heading);
  if (idx < 0) return [];
  const after = idx + heading.length;
  const rest = text.slice(after);
  const next = rest.search(/\n(?:##|###)\s+/);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
    .map((l) => l.replace(/^-\s*/, '').trim())
    .filter((l) => l && !l.startsWith('(') && !/^none\b/i.test(l) && !l.includes('<!--'));
}

/**
 * @param {string} [markdown]
 * @returns {ParsedGuideSections}
 */
export function parseGuideSections(markdown) {
  const text = String(markdown || '');
  return {
    show_these: sectionBullets(text, SECTION_HEADINGS.show_these),
    soft_skip: sectionBullets(text, SECTION_HEADINGS.soft_skip),
    never_show: sectionBullets(text, SECTION_HEADINGS.never_show),
    prefer_more: sectionBullets(text, SECTION_HEADINGS.prefer_more),
    prefer_less: sectionBullets(text, SECTION_HEADINGS.prefer_less),
  };
}

/**
 * @param {{
 *   title?: string,
 *   company?: string,
 *   detail?: string,
 *   sources?: Array<{ subject?: string, from?: string }>,
 * }} item
 */
export function dailySummaryItemMatchBlob(item) {
  return [
    item?.company,
    item?.title,
    item?.detail,
    ...(Array.isArray(item?.sources)
      ? item.sources.flatMap((s) => [s?.subject, s?.from])
      : []),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * @param {string} text
 */
function contentTokens(text) {
  return normalizePatternKey(text)
    .split(' ')
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * True when a guide bullet pattern plausibly describes this item.
 * @param {string} bullet
 * @param {string} itemBlob
 */
export function guideBulletMatchesItem(bullet, itemBlob) {
  const pattern = normalizePatternKey(bullet);
  const blob = normalizePatternKey(itemBlob);
  if (!pattern || !blob) return false;

  // Short keyword rules (e.g. "marketing keywords", "OTP codes").
  const tokens = contentTokens(pattern);
  if (!tokens.length) {
    return blob.includes(pattern);
  }
  if (tokens.length <= 2) {
    return tokens.every((t) => blob.includes(t));
  }

  const hits = tokens.filter((t) => blob.includes(t)).length;
  if (hits / tokens.length >= 0.45) return true;
  return patternSimilarity(pattern, blob) >= 0.5;
}

/**
 * @param {string} itemBlob
 * @param {string[]} bullets
 */
function anyBulletMatches(itemBlob, bullets) {
  for (const bullet of bullets || []) {
    if (guideBulletMatchesItem(bullet, itemBlob)) return bullet;
  }
  return null;
}

/**
 * Built-in hard excludes that should never depend on LLM compliance.
 * @param {string} blob
 * @returns {string | null}
 */
export function builtInNoiseExcludeReason(blob) {
  const t = String(blob || '').toLowerCase();
  if (!t.trim()) return null;

  // Hard sender-domain blocks (never depend on guide / LLM).
  if (/@westernp\.com\b/.test(t)) {
    return 'blocked_domain';
  }

  if (
    /\b(track(ing)?\s+(your\s+)?(package|order|shipment|item)|out for delivery|package\s+(has\s+)?(been\s+)?(shipped|delivered|arrived)|shipping\s+(confirm|notif|update|status)|shipment\s+confirm|deliver(y|ed)\s+(confirm|notif|update)|packages?\s+have\s+been\s+(shipped|delivered))\b/.test(
      t,
    )
  ) {
    return 'shipping';
  }

  if (
    /\b(slack)\b/.test(t)
    && /\b(unread|new messages?|channel updates?|#\w+)/.test(t)
  ) {
    return 'slack_unread';
  }

  if (
    /\b(google\s+calendar|calendar\s+(event|notif|invite|reminder)|prepare for .{0,40} meeting)\b/.test(
      t,
    )
    && !/\b(reschedule|need(s)? (a |my )?reply|rsvp)\b/.test(t)
  ) {
    return 'calendar_noise';
  }

  if (
    /\b((new\s+)?sign[- ]?in\s+(alert|activity|notif|attempt)|login\s+(alert|attempt|activity)|security\s+(alert|activity|notif)|recent\s+sign[- ]?in)\b/.test(
      t,
    )
  ) {
    return 'security_fyi';
  }

  if (
    /\b(newsletter|mailing list|%\s*off|limited time|shop now|deal of the day|unsubscribe)\b/.test(
      t,
    )
    && !/\b(invoice|payment due|contract|deadline|sign (the|this)|reply)\b/.test(t)
  ) {
    return 'promo';
  }

  return null;
}

/**
 * Guide-driven exclude. Never show always wins.
 * Soft skip + Prefer less omit unless a Show these / Prefer more line also matches.
 * @param {{
 *   title?: string,
 *   company?: string,
 *   detail?: string,
 *   sources?: Array<{ subject?: string, from?: string }>,
 * }} item
 * @param {string} [guideMarkdown]
 * @returns {string | null} reason code
 */
export function guideExcludeReason(item, guideMarkdown = '') {
  const blob = dailySummaryItemMatchBlob(item);
  if (!blob.trim()) return null;

  const builtin = builtInNoiseExcludeReason(blob);
  if (builtin) return builtin;

  const guide = String(guideMarkdown || '').trim();
  if (!guide) return null;

  const sections = parseGuideSections(guide);
  const neverHit = anyBulletMatches(blob, sections.never_show);
  if (neverHit) return 'never_show';

  const showHit =
    anyBulletMatches(blob, sections.show_these)
    || anyBulletMatches(blob, sections.prefer_more);
  if (showHit) return null;

  const softHit =
    anyBulletMatches(blob, sections.soft_skip)
    || anyBulletMatches(blob, sections.prefer_less);
  if (softHit) return 'soft_skip';

  return null;
}
