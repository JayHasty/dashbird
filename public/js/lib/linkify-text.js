/**
 * Detect http(s) and www. URLs in plain text and append safe <a> nodes.
 * Never uses innerHTML. Only http: / https: hrefs; opens in a new tab.
 */

const URL_FIND_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'\\]+/gi;
const TRAILING_PUNCT_RE = /[),.;:!?\]}'"]+$/;

/**
 * @param {string} raw
 * @returns {string}
 */
function stripTrailingPunct(raw) {
  return String(raw || '').replace(TRAILING_PUNCT_RE, '');
}

/**
 * @param {string} raw
 * @returns {string | null} href, or null if not a safe http(s) URL
 */
function safeHttpHref(raw) {
  const trimmed = stripTrailingPunct(raw);
  if (!trimmed) return null;
  const withProto = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
  let parsed;
  try {
    parsed = new URL(withProto);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.href;
}

/**
 * @param {string} href
 * @param {string} display
 * @returns {HTMLAnchorElement}
 */
function makeLink(href, display) {
  const a = document.createElement('a');
  a.className = 'text-link';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = display;
  a.addEventListener('click', (e) => e.stopPropagation());
  a.addEventListener('pointerdown', (e) => e.stopPropagation());
  a.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  a.addEventListener('dblclick', (e) => e.stopPropagation());
  return a;
}

/**
 * Append text with detected URLs as hyperlinks.
 * @param {ParentNode} parent
 * @param {string} text
 */
export function appendLinkifiedText(parent, text) {
  const s = String(text ?? '');
  if (!s) return;

  const re = new RegExp(URL_FIND_RE.source, URL_FIND_RE.flags);
  let last = 0;
  for (const m of s.matchAll(re)) {
    const raw = m[0];
    const start = m.index ?? 0;
    if (start > last) parent.append(document.createTextNode(s.slice(last, start)));

    const stripped = stripTrailingPunct(raw);
    const trailing = raw.slice(stripped.length);
    const href = safeHttpHref(stripped);
    if (href) {
      parent.append(makeLink(href, stripped));
      if (trailing) parent.append(document.createTextNode(trailing));
    } else {
      parent.append(document.createTextNode(raw));
    }
    last = start + raw.length;
  }
  if (last < s.length) parent.append(document.createTextNode(s.slice(last)));
}

/**
 * Replace element children with linkified text (read-only display).
 * @param {HTMLElement} el
 * @param {string} text
 */
export function fillLinkifiedText(el, text) {
  el.replaceChildren();
  appendLinkifiedText(el, text);
}
