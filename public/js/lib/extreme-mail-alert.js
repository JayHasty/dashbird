/**
 * Immediate dialog when an extreme-priority Daily Summary item appears.
 * Seen ids persist in localStorage so a refresh does not re-alert.
 */

const SEEN_KEY = 'dashbird-extreme-mail-seen';

/**
 * @returns {Set<string>}
 */
function readSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

/**
 * @param {Set<string>} seen
 */
function writeSeen(seen) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-80)));
  } catch {
    /* ignore */
  }
}

/**
 * @param {object} item
 */
export function itemIsExtremePriority(item) {
  return String(item?.priority || '').toLowerCase() === 'extreme';
}

/**
 * @param {object} item
 */
function openExtremeMailDialog(item) {
  if (document.querySelector('.extreme-mail-alert')) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'extreme-mail-alert';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Extreme priority email');

  const panel = document.createElement('div');
  panel.className = 'extreme-mail-alert__panel';

  const kicker = document.createElement('p');
  kicker.className = 'extreme-mail-alert__kicker';
  kicker.textContent = 'Extreme priority';

  const title = document.createElement('h2');
  title.className = 'extreme-mail-alert__title';
  title.textContent = String(item.title || 'Anthropic application mail');

  const company = document.createElement('p');
  company.className = 'extreme-mail-alert__company';
  company.textContent = String(item.company || 'Anthropic');

  const detail = document.createElement('p');
  detail.className = 'extreme-mail-alert__detail';
  detail.textContent = String(item.detail || 'New mail about the Anthropic application.');

  const actions = document.createElement('div');
  actions.className = 'extreme-mail-alert__actions';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'extreme-mail-alert__btn';
  ok.textContent = 'OK';
  const open = document.createElement('a');
  open.className = 'extreme-mail-alert__btn extreme-mail-alert__btn--open';
  open.textContent = 'Open in Gmail';
  const href = String(item.replyUrl || '').trim();
  if (href) {
    open.href = href;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
  } else {
    open.hidden = true;
  }

  const close = () => backdrop.remove();
  ok.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  actions.append(ok, open);
  panel.append(kicker, title, company, detail, actions);
  backdrop.append(panel);
  document.body.append(backdrop);
  ok.focus();
}

/**
 * Alert for any extreme item whose id has not been shown yet.
 * @param {object[]} items
 */
export function alertNewExtremeMail(items) {
  const seen = readSeen();
  const incoming = (Array.isArray(items) ? items : []).filter(itemIsExtremePriority);
  /** @type {object | null} */
  let newest = null;
  for (const item of incoming) {
    const id = String(item?.id || item?.fingerprint || '').trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    newest = item;
  }
  writeSeen(seen);
  if (newest) openExtremeMailDialog(newest);
}
