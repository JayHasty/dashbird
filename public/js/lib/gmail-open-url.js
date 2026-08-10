/**
 * Gmail web + native app deep links for Daily Summary "Open".
 *
 * Desktop: AccountChooser with the full target (fragment percent-encoded) inside
 * `continue` so Google’s account bounce does not strip `#all/{threadId}` and
 * strand the click on the inbox.
 *
 * Targeting (shared): hex thread → `#all/{threadId}` (open the message thread),
 * then rfc822msgid search, then a distinct hex message id — IMAP decimal UIDs
 * never work in the web UI or native deep links.
 *
 * Mobile handoff:
 * - Prefer a Gmail *search* for rfc822msgid (or subject). That is the only
 *   widely-working way to surface a specific message in the native app.
 *   `googlegmail:///cv?th=` and https VIEW intents open the app but land on
 *   the inbox (thread fragments are not honored), and once the app takes
 *   focus our web fallback never runs.
 * - iOS: googlegmail:///search?q=… (legacy googlegmail:///cv=THREAD as last resort)
 * - Android: intent:// SEARCH into com.google.android.gm
 * - Last resort: web Gmail (AccountChooser), then mailto: compose when only a
 *   sender address is known (no message deep link).
 */

/**
 * @typedef {{
 *   email?: string,
 *   threadId?: string,
 *   gmailId?: string,
 *   messageId?: string,
 *   rfc822MessageId?: string,
 *   subject?: string,
 *   from?: string,
 * }} GmailOpenSource
 */

/** @param {unknown} value */
function hexId(value) {
  const v = String(value || '').trim();
  return /^[0-9a-f]+$/i.test(v) && !/^\d+$/.test(v) ? v.toLowerCase() : '';
}

/**
 * Strip IMAP decimal UIDs that look like ids but are not Gmail hex thread/message
 * ids (those break googlegmail:///cv=… and land on nothing).
 *
 * @param {GmailOpenSource | null | undefined} source
 * @returns {GmailOpenSource | null}
 */
export function sanitizeGmailOpenSource(source) {
  if (!source || typeof source !== 'object') return null;
  /** @type {GmailOpenSource} */
  const next = { ...source };
  if (!hexId(next.threadId)) next.threadId = '';
  if (!hexId(next.gmailId)) next.gmailId = '';
  if (!hexId(next.messageId)) next.messageId = '';
  // IMAP OBJECTID sometimes collapses emailId to the thread id — useless for
  // message-level deep links.
  if (next.gmailId && next.threadId && next.gmailId === next.threadId) {
    next.gmailId = '';
  }
  return next;
}

/**
 * @param {GmailOpenSource | null | undefined} source
 * @returns {string} Gmail UI hash (without leading '#'), or ''.
 */
export function gmailTargetHash(source) {
  const threadId = hexId(source?.threadId);
  if (threadId) return `all/${threadId}`;

  const rfc = String(source?.rfc822MessageId || '')
    .trim()
    .replace(/^<|>$/g, '');
  if (rfc) return `search/${encodeURIComponent(`rfc822msgid:${rfc}`)}`;

  const gmailId = hexId(source?.gmailId);
  if (gmailId && gmailId !== threadId) return `all/${gmailId}`;

  const apiId = hexId(source?.messageId);
  if (apiId && apiId !== threadId) return `all/${apiId}`;

  const subject = String(source?.subject || '').trim();
  if (subject) return `search/${encodeURIComponent(`subject:${subject}`)}`;

  const rawId = String(source?.messageId || '').trim();
  if (rawId) return `search/${encodeURIComponent(rawId)}`;
  return '';
}

/**
 * Unique-ish Gmail search query that isolates the source message in the app.
 * @param {GmailOpenSource | null | undefined} source
 * @returns {string}
 */
export function gmailSearchQuery(source) {
  const clean = sanitizeGmailOpenSource(source);
  const rfc = String(clean?.rfc822MessageId || '')
    .trim()
    .replace(/^<|>$/g, '');
  if (rfc) return `rfc822msgid:${rfc}`;
  const subject = String(clean?.subject || '').trim();
  if (subject) return `subject:${subject}`;
  return '';
}

/**
 * Desktop / web fallback: AccountChooser → mail.google.com thread (or search).
 * @param {GmailOpenSource | null | undefined} source
 */
export function gmailWebMessageUrl(source) {
  const clean = sanitizeGmailOpenSource(source);
  if (!clean?.email) return '';
  const email = String(clean.email).trim().toLowerCase();
  const hash = gmailTargetHash(clean);
  if (!hash) return '';
  const target = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#${hash}`;
  return (
    'https://accounts.google.com/AccountChooser'
    + `?Email=${encodeURIComponent(email)}`
    + `&continue=${encodeURIComponent(target)}`
  );
}

/**
 * iOS Gmail app deep link.
 * Prefer search (rfc822msgid / subject). Avoid `cv?th=` — it opens the app
 * inbox. Legacy path form `cv=THREAD` is a last resort when no search key exists.
 * @param {GmailOpenSource | null | undefined} source
 * @returns {string}
 */
export function gmailNativeAppUrl(source) {
  const clean = sanitizeGmailOpenSource(source);
  const query = gmailSearchQuery(clean);
  if (query) {
    return `googlegmail:///search?q=${encodeURIComponent(query)}`;
  }
  const threadId = hexId(clean?.threadId);
  if (threadId) {
    return `googlegmail:///cv=${encodeURIComponent(threadId)}`;
  }
  const msgId = hexId(clean?.gmailId) || hexId(clean?.messageId);
  if (msgId) {
    return `googlegmail:///cv=${encodeURIComponent(msgId)}`;
  }
  return '';
}

/**
 * Direct mail.google.com deep link (web / tests). Not used as an Android VIEW
 * intent target — the Gmail app ignores the `#all/{threadId}` fragment and
 * opens the inbox.
 *
 * @param {GmailOpenSource | null | undefined} source
 */
export function gmailDirectWebMessageUrl(source) {
  const clean = sanitizeGmailOpenSource(source);
  if (!clean?.email) return '';
  const email = String(clean.email).trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  const hash = gmailTargetHash(clean);
  if (!hash) return '';
  return `https://mail.google.com/mail/u/${email}/#${hash}`;
}

/**
 * Android Gmail app via SEARCH intent (package com.google.android.gm).
 * VIEW intents on mail.google.com/#all/{threadId} open the app inbox.
 *
 * @param {GmailOpenSource | null | undefined} source
 * @param {string} fallbackWebUrl
 */
export function gmailAndroidAppUrl(source, fallbackWebUrl) {
  const clean = sanitizeGmailOpenSource(source);
  const query = gmailSearchQuery(clean);
  if (!query) return '';
  const fallback = encodeURIComponent(
    String(fallbackWebUrl || gmailWebMessageUrl(clean) || '').trim(),
  );
  return (
    'intent:#Intent;'
    + 'action=android.intent.action.SEARCH;'
    + 'package=com.google.android.gm;'
    + `S.query=${encodeURIComponent(query)};`
    + (fallback ? `S.browser_fallback_url=${fallback};` : '')
    + 'end'
  );
}

/**
 * Resolve the best "Open" href for mobile.
 *
 * iOS: googlegmail:///search when possible.
 * Android: SEARCH intent into com.google.android.gm.
 * Falls back to web AccountChooser (thread-preserving).
 *
 * @param {string} webUrl
 * @param {GmailOpenSource | null | undefined} [source]
 * @param {string} [userAgent] optional UA override (tests)
 */
export function gmailMobileOpenUrl(webUrl, source = null, userAgent = '') {
  const url = String(webUrl || '').trim();
  const clean = sanitizeGmailOpenSource(source);
  const ua =
    String(userAgent || '').trim()
    || (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  if (/iPhone|iPad|iPod/i.test(ua)) {
    const native = gmailNativeAppUrl(clean);
    if (native) return native;
  }
  if (/Android/i.test(ua)) {
    const intent = gmailAndroidAppUrl(clean, url);
    if (intent) return intent;
  }
  return url;
}

/** @returns {boolean} */
export function isMobileGmailClient() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Android|iPhone|iPad|iPod/i.test(ua);
}

/** @param {string} raw */
function extractEmailAddress(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const angle = s.match(/<([^>]+)>/);
  if (angle?.[1] && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(angle[1].trim())) {
    return angle[1].trim().toLowerCase();
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.toLowerCase();
  return '';
}

/**
 * mailto: compose fallback when no Gmail deep link can be built.
 * @param {GmailOpenSource | null | undefined} source
 */
export function gmailMailtoFallbackUrl(source) {
  const to = extractEmailAddress(source?.from);
  if (!to) return '';
  const subject = String(source?.subject || '').trim();
  const params = new URLSearchParams();
  if (subject) params.set('subject', `Re: ${subject.replace(/^Re:\s*/i, '')}`);
  const qs = params.toString();
  return qs ? `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?${qs}` : `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}`;
}

/** Label for the mobile/desktop Open control. */
export const GMAIL_OPEN_LABEL = 'Open in Gmail';

/**
 * @param {string} primary
 * @param {string} webUrl
 */
function mobileOpenFallbackChain(primary, webUrl) {
  const started = Date.now();
  let cancelled = false;
  const onHide = () => {
    cancelled = true;
    cleanup();
  };
  const cleanup = () => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('blur', onHide);
  };
  const onVis = () => {
    if (document.visibilityState === 'hidden') onHide();
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('blur', onHide);

  window.location.href = primary;

  window.setTimeout(() => {
    cleanup();
    if (cancelled) return;
    // Still here → native handoff likely missing / blocked.
    if (Date.now() - started < 2000 && document.visibilityState === 'visible' && webUrl) {
      window.location.href = webUrl;
    }
  }, 900);
}

/**
 * Wire an <a> to open the message thread in the native Gmail app on phones, with
 * a web fallback. Desktop keeps a normal new-tab AccountChooser link.
 *
 * iOS googlegmail:// has no built-in fallback; if the app is missing we hop to
 * web Gmail after a short delay while the page is still visible.
 *
 * @param {HTMLAnchorElement} anchor
 * @param {string} webUrl
 * @param {GmailOpenSource | null | undefined} [source]
 */
export function wireGmailOpenAnchor(anchor, webUrl, source = null) {
  const url = String(webUrl || '').trim();
  if (!url) return;

  anchor.title = GMAIL_OPEN_LABEL;
  anchor.setAttribute('aria-label', GMAIL_OPEN_LABEL);
  anchor.textContent = GMAIL_OPEN_LABEL;

  if (!isMobileGmailClient()) {
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return;
  }

  const clean = sanitizeGmailOpenSource(source);
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const nativePrimary = isIos
    ? gmailNativeAppUrl(clean)
    : isAndroid
      ? gmailAndroidAppUrl(clean, url)
      : '';

  // Prefer AccountChooser when we have no reliable in-app search key — native
  // VIEW/cv?th handoffs open the Gmail app inbox and block the web fallback.
  const mobileHref = nativePrimary || url;
  anchor.href = mobileHref;
  anchor.removeAttribute('target');
  anchor.removeAttribute('rel');

  if (!nativePrimary || nativePrimary === url) return;

  anchor.addEventListener('click', (e) => {
    // Let modified clicks / long-press “open in new tab” use the href as-is.
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.button != null && e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();
    mobileOpenFallbackChain(nativePrimary, url);
  });
}
