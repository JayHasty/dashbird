import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';
import {
  thumbUpIcon,
  thumbDownIcon,
  zzzIcon,
  eyeOffIcon,
} from '../lib/local-news-icons.js';
import { isRead, markRead, unreadCount } from '../lib/local-news-read-state.js';
import { openLocalNewsReader } from './local-news-reader.js';

const REFRESH_MS = 5 * 60 * 1000;
const CACHE_KEY = 'local-news';
const CACHE_MAX_MS = 20 * 60 * 1000;
const COLLAPSE_KEY = 'dashbird-local-news-collapsed';

/**
 * Default collapsed (hidden body). Explicit `'0'` means expanded.
 * @returns {boolean}
 */
function readCollapsed() {
  try {
    const v = localStorage.getItem(COLLAPSE_KEY);
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

/**
 * @param {boolean} collapsed
 */
function writeCollapsed(collapsed) {
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * Wire Local News card heading collapse (body hide/show). Starts collapsed.
 * @param {HTMLElement} root
 */
function wireCardCollapse(root) {
  const card = root.closest('.life-sidebar__card--news');
  const btn = document.getElementById('local-news-collapse');
  if (!(card instanceof HTMLElement) || !(btn instanceof HTMLButtonElement)) return;

  const apply = (collapsed) => {
    card.classList.toggle('life-sidebar__card--collapsed', collapsed);
    root.hidden = collapsed;
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.setAttribute('aria-label', collapsed ? 'Expand Local News' : 'Collapse Local News');
    btn.title = collapsed ? 'Expand Local News' : 'Collapse Local News';
  };

  apply(readCollapsed());
  btn.addEventListener('click', () => {
    const next = !card.classList.contains('life-sidebar__card--collapsed');
    writeCollapsed(next);
    apply(next);
  });
}

/**
 * @param {string | null | undefined} iso
 */
function fmtRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMs = Date.now() - t;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/**
 * @param {object} feed
 * @param {{
 *   mode?: 'discover' | 'subscribed' | 'pending',
 *   busy?: boolean,
 *   onAdd?: () => void | Promise<void>,
 *   onRespond?: (r: 'yes' | 'defer') => void | Promise<void>,
 * }} [opts]
 */
function openFeedPreviewModal(feed, opts = {}) {
  const mode = opts.mode || 'discover';
  const backdrop = document.createElement('div');
  backdrop.className = 'events-finder__modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'events-finder__modal local-news__preview-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const title = document.createElement('h3');
  title.className = 'events-finder__modal-title';
  title.textContent = feed?.title || 'Feed preview';

  const hint = document.createElement('p');
  hint.className = 'events-finder__modal-hint';
  if (mode === 'subscribed') {
    hint.textContent = 'Latest headlines currently coming from this feed.';
  } else if (mode === 'pending') {
    hint.textContent =
      'Latest headlines that would appear if you subscribe — not added until you tap Yes. Defer brings this feed back in a few hours.';
  } else {
    hint.textContent = 'Latest headlines that would appear if you add this feed.';
  }

  const body = document.createElement('div');
  body.className = 'local-news__preview-body';
  body.textContent = 'Loading articles…';

  const msg = document.createElement('p');
  msg.className = 'events-finder__modal-msg';
  msg.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'events-finder__modal-actions local-news__preview-actions';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'events-finder__modal-btn';
  closeBtn.textContent = 'Close';

  const close = () => backdrop.remove();
  closeBtn.addEventListener('click', close);

  if (mode === 'pending' && opts.onRespond) {
    const deferBtn = document.createElement('button');
    deferBtn.type = 'button';
    deferBtn.className = 'events-finder__modal-btn';
    deferBtn.textContent = 'Defer';
    deferBtn.disabled = opts.busy;
    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'events-finder__modal-btn local-news__btn local-news__btn--yes';
    yesBtn.textContent = 'Yes';
    yesBtn.disabled = opts.busy;
    deferBtn.addEventListener('click', async () => {
      deferBtn.disabled = true;
      yesBtn.disabled = true;
      try {
        await opts.onRespond('defer');
        close();
      } catch {
        deferBtn.disabled = opts.busy;
        yesBtn.disabled = opts.busy;
      }
    });
    yesBtn.addEventListener('click', async () => {
      deferBtn.disabled = true;
      yesBtn.disabled = true;
      try {
        await opts.onRespond('yes');
        close();
      } catch {
        deferBtn.disabled = opts.busy;
        yesBtn.disabled = opts.busy;
      }
    });
    actions.append(deferBtn, yesBtn);
  } else if (mode === 'discover' && opts.onAdd) {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'events-finder__modal-btn local-news__btn local-news__btn--yes';
    addBtn.textContent = 'Add feed';
    addBtn.disabled = opts.busy;
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      try {
        await opts.onAdd();
        close();
      } catch {
        addBtn.disabled = opts.busy;
      }
    });
    actions.append(closeBtn, addBtn);
  } else {
    actions.append(closeBtn);
  }

  modal.append(title, hint, body, msg, actions);
  backdrop.append(modal);
  document.body.append(backdrop);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  void (async () => {
    try {
      const feedId = String(feed?.id || '').trim();
      const url = feedId
        ? `/api/local-news/feeds/${encodeURIComponent(feedId)}/preview`
        : '/api/local-news/suggestion/preview';
      const r = await fetch(url, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);

      body.replaceChildren();
      const articles = Array.isArray(j.articles) ? j.articles : [];
      if (!articles.length) {
        const empty = document.createElement('p');
        empty.className = 'muted local-news__preview-empty';
        empty.textContent = 'No recent articles match your taste filters for this feed.';
        body.append(empty);
        return;
      }

      const list = document.createElement('ul');
      list.className = 'local-news__preview-list';
      for (const a of articles) {
        const li = document.createElement('li');
        li.className = 'local-news__preview-row';

        const link = document.createElement('a');
        link.className = 'local-news__preview-link';
        link.href = a.link || '#';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = a.title || 'Untitled';
        li.append(link);

        if (a.relevance) {
          const summary = document.createElement('p');
          summary.className = 'local-news__preview-summary';
          summary.textContent = a.relevance;
          li.append(summary);
        } else if (a.summary) {
          const summary = document.createElement('p');
          summary.className = 'local-news__preview-summary local-news__preview-summary--rss';
          summary.textContent = a.summary;
          li.append(summary);
        } else if (a.relevancePending) {
          const summary = document.createElement('p');
          summary.className = 'local-news__preview-summary local-news__preview-summary--pending';
          summary.textContent = 'Summarizing…';
          li.append(summary);
        }

        const meta = document.createElement('span');
        meta.className = 'local-news__preview-meta';
        meta.textContent = fmtRelative(a.publishedAt);
        if (meta.textContent) li.append(meta);

        list.append(li);
      }
      body.append(list);
    } catch (e) {
      body.replaceChildren();
      msg.hidden = false;
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load preview';
    }
  })();
}

/**
 * @param {object} suggestion
 * @param {{ onRespond: (r: 'yes' | 'defer') => void | Promise<void>, busy: boolean }} opts
 */
function openSuggestionPreviewModal(suggestion, opts) {
  openFeedPreviewModal(suggestion?.feed, {
    mode: 'pending',
    busy: opts.busy,
    onRespond: opts.onRespond,
  });
}

/**
 * @param {HTMLElement} root
 * @param {object} suggestion
 * @param {{ onRespond: (r: 'yes' | 'no' | 'defer') => void | Promise<void>, onFresh: () => void, busy: boolean }} opts
 */
function renderSuggestionBlock(root, suggestion, opts) {
  const block = document.createElement('div');
  block.className = 'local-news__suggestion';

  const prompt = document.createElement('p');
  prompt.className = 'local-news__suggestion-prompt';
  prompt.textContent = 'Subscribe to this news feed?';
  block.append(prompt);

  const feed = document.createElement('div');
  feed.className = 'local-news__suggestion-feed';
  const title = document.createElement('span');
  title.className = 'local-news__suggestion-title local-news__suggestion-title--plain';
  title.textContent = suggestion.feed.title;
  feed.append(title);

  if (Array.isArray(suggestion.feed.tags) && suggestion.feed.tags.length) {
    const tags = document.createElement('span');
    tags.className = 'local-news__suggestion-tags';
    tags.textContent = suggestion.feed.tags.slice(0, 3).join(' · ');
    feed.append(tags);
  }
  block.append(feed);

  const explore = document.createElement('div');
  explore.className = 'local-news__suggestion-explore';

  const siteUrl = suggestion.feed.siteUrl || suggestion.feed.url;
  if (siteUrl) {
    const siteBtn = document.createElement('a');
    siteBtn.className = 'local-news__btn local-news__btn--site';
    siteBtn.href = siteUrl;
    siteBtn.target = '_blank';
    siteBtn.rel = 'noopener noreferrer';
    siteBtn.textContent = 'Visit website';
    explore.append(siteBtn);
  }

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'local-news__btn local-news__btn--preview';
  previewBtn.textContent = 'Preview articles';
  previewBtn.disabled = opts.busy;
  previewBtn.addEventListener('click', () =>
    openSuggestionPreviewModal(suggestion, { onRespond: opts.onRespond, busy: opts.busy }),
  );
  explore.append(previewBtn);
  block.append(explore);

  const reason = document.createElement('p');
  reason.className = 'local-news__suggestion-reason';
  reason.textContent =
    suggestion.reason === 'similar'
      ? 'Similar to feeds you already follow'
      : 'Popular feed you might like';
  block.append(reason);

  const actions = document.createElement('div');
  actions.className = 'local-news__suggestion-actions';

  const yesBtn = document.createElement('button');
  yesBtn.type = 'button';
  yesBtn.className = 'local-news__btn local-news__btn--yes';
  yesBtn.textContent = 'Yes';
  yesBtn.disabled = opts.busy;
  yesBtn.addEventListener('click', () => opts.onRespond('yes'));

  const noBtn = document.createElement('button');
  noBtn.type = 'button';
  noBtn.className = 'local-news__btn local-news__btn--no';
  noBtn.textContent = 'No';
  noBtn.disabled = opts.busy;
  noBtn.addEventListener('click', () => opts.onRespond('no'));

  const freshBtn = document.createElement('button');
  freshBtn.type = 'button';
  freshBtn.className = 'local-news__btn local-news__btn--fresh';
  freshBtn.textContent = 'Suggest fresh';
  freshBtn.disabled = opts.busy;
  freshBtn.addEventListener('click', () => opts.onFresh());

  actions.append(yesBtn, noBtn, freshBtn);
  block.append(actions);

  root.append(block);
}

/**
 * @param {string} reason
 * @param {{ matchTags?: string[], preferenceHits?: string[] }} [feed]
 */
function suggestionReasonText(reason, feed = {}) {
  if (reason === 'match') {
    const bits = [...(feed.matchTags || []), ...(feed.preferenceHits || [])].slice(0, 3);
    return bits.length ? `Matches your feeds & preferences · ${bits.join(' · ')}` : 'Matches your feeds & preferences';
  }
  if (reason === 'similar') {
    const bits = (feed.matchTags || []).slice(0, 3);
    return bits.length ? `Similar to feeds you follow · ${bits.join(' · ')}` : 'Similar to feeds you already follow';
  }
  if (reason === 'preferences') {
    const bits = (feed.preferenceHits || []).slice(0, 3);
    return bits.length ? `Matches Look for · ${bits.join(' · ')}` : 'Matches your Look for preferences';
  }
  return 'Popular feed you might like';
}

/**
 * @param {object} feed
 */
function formatFeedStatsLine(feed) {
  const stats = feed?.stats || {};
  const parts = [];
  if (Number.isFinite(stats.articleCount)) {
    parts.push(`${stats.articleCount} item${stats.articleCount === 1 ? '' : 's'}`);
  }
  const latest = fmtRelative(stats.latestPublishedAt);
  if (latest) parts.push(`latest ${latest}`);
  else if (feed.subscribedAt) {
    const since = fmtRelative(feed.subscribedAt);
    if (since) parts.push(`tuned in ${since}`);
  }
  if (feed.category) parts.push(String(feed.category));
  return parts.join(' · ');
}

/**
 * Payload for preference APIs — title + visible summary line only.
 * @param {object} a
 */
function articleFeedbackPayload(a) {
  return {
    id: a.id,
    title: a.title,
    summary: a.summary || '',
    relevance: a.relevance || '',
    feedTitle: a.feedTitle || '',
    feedId: a.feedId || '',
    link: a.link || '',
  };
}

/**
 * @param {HTMLButtonElement} btn
 * @param {SVGElement} icon
 * @param {string} label
 * @param {string} tip
 */
function feedbackButton(btn, icon, label, tip) {
  btn.type = 'button';
  btn.append(icon);
  btn.setAttribute('aria-label', label);
  btn.title = tip;
  return btn;
}

/**
 * @param {HTMLElement} root
 * @param {Array<object>} articles
 * @param {{
 *   onFeedback: (a: object, vibe: 'up' | 'down') => Promise<void>,
 *   onSnooze: (a: object) => Promise<void>,
 *   onSkip: (a: object) => Promise<void>,
 *   onRead?: (a: object) => void,
 * }} tasteOpts
 */
function renderArticleList(root, articles, tasteOpts) {
  if (!articles.length) {
    const empty = document.createElement('p');
    empty.className = 'muted local-news__empty';
    empty.textContent = 'No articles yet — open Feed editor to tune in to feeds.';
    root.append(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'local-news__list';
  for (const a of articles) {
    const li = document.createElement('li');
    li.className = 'local-news__row';
    if (isRead(a.id)) li.classList.add('local-news__row--read');

    const link = document.createElement('a');
    link.className = 'local-news__row-link';
    link.href = a.link || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';

    const dot = document.createElement('span');
    dot.className = 'local-news__row-dot';
    dot.setAttribute('aria-hidden', 'true');
    const titleText = document.createElement('span');
    titleText.className = 'local-news__row-title';
    titleText.textContent = a.title;
    link.append(dot, titleText);

    link.addEventListener('click', () => {
      markRead(a.id);
      li.classList.add('local-news__row--read');
      tasteOpts.onRead?.(a);
    });
    li.append(link);

    const isImportant = a.important === true || (Number(a.importance) >= 8);
    if (isImportant) {
      const badge = document.createElement('span');
      badge.className = 'local-news__important-badge';
      badge.textContent = 'Important';
      const why = Array.isArray(a.importantReasons)
        ? a.importantReasons.filter((r) => r && r !== 'normal' && !String(r).startsWith('demote')).join(' · ')
        : '';
      if (why) badge.title = why;
      li.append(badge);
    }

    if (a.relevance) {
      const relevance = document.createElement('p');
      relevance.className = 'local-news__row-relevance';
      relevance.textContent = a.relevance;
      li.append(relevance);
    } else if (a.relevancePending) {
      const relevance = document.createElement('p');
      relevance.className = 'local-news__row-relevance local-news__row-relevance--pending';
      relevance.textContent = 'Summarizing article…';
      li.append(relevance);
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'local-news__row-meta-row';

    const meta = document.createElement('span');
    meta.className = 'local-news__row-meta';
    meta.textContent = [a.feedTitle, fmtRelative(a.publishedAt)].filter(Boolean).join(' · ');
    metaRow.append(meta);

    const rowActions = document.createElement('span');
    rowActions.className = 'local-news__row-actions';

    const upBtn = feedbackButton(
      document.createElement('button'),
      thumbUpIcon({ size: 13 }),
      'More like this',
      'More like this — save title & summary to preferences',
    );
    upBtn.className = 'events-finder__card-action local-news__card-action local-news__card-action--up';
    upBtn.addEventListener('click', () => {
      void tasteOpts.onFeedback(a, 'up');
    });

    const snoozeBtn = feedbackButton(
      document.createElement('button'),
      zzzIcon({ size: 13 }),
      'Tired of this topic for now',
      'Tired of this topic — snooze similar for 2 weeks',
    );
    snoozeBtn.className = 'events-finder__card-action local-news__card-action local-news__card-action--snooze';
    snoozeBtn.addEventListener('click', () => {
      void tasteOpts.onSnooze(a);
    });

    const downBtn = feedbackButton(
      document.createElement('button'),
      thumbDownIcon({ size: 13 }),
      'Less like this',
      'Less like this — save title & summary to preferences',
    );
    downBtn.className = 'events-finder__card-action local-news__card-action local-news__card-action--down';
    downBtn.addEventListener('click', () => {
      void tasteOpts.onFeedback(a, 'down');
    });

    const skipBtn = feedbackButton(
      document.createElement('button'),
      eyeOffIcon({ size: 13 }),
      'Skip this article',
      'Hide this headline only',
    );
    skipBtn.className = 'events-finder__card-action local-news__card-action local-news__card-action--skip';
    skipBtn.addEventListener('click', () => {
      void tasteOpts.onSkip(a);
    });

    rowActions.append(upBtn, snoozeBtn, downBtn, skipBtn);

    metaRow.append(rowActions);
    li.append(metaRow);

    list.append(li);
  }
  root.append(list);
}

/**
 * Compact news feed for the main dashboard (beside Tasks).
 * First click expands summary; second click opens the article.
 * @param {HTMLElement | null} root
 */
export function mountMainNewsFeed(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('main-news');

  const body = document.createElement('div');
  body.className = 'main-news__body';

  const msg = document.createElement('p');
  msg.className = 'main-news__status';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  root.append(body, msg);

  /** @type {string | null} */
  let expandedId = null;
  let relevancePollTimer = null;
  /** @type {object | null} */
  let lastPayload = null;

  /**
   * @param {object} a
   */
  function articleSummary(a) {
    if (a.relevance) return a.relevance;
    if (a.summary) return a.summary;
    if (a.relevancePending) return 'Summarizing article…';
    return '';
  }

  /**
   * @param {HTMLElement} card
   * @param {object} a
   */
  function setCardExpanded(card, a, on) {
    card.classList.toggle('main-news__card--expanded', on);
    card.setAttribute('aria-expanded', on ? 'true' : 'false');
    const summaryEl = card.querySelector('.main-news__card-summary');
    if (!summaryEl) return;
    if (on) {
      summaryEl.hidden = false;
      summaryEl.textContent = articleSummary(a);
      summaryEl.classList.toggle('main-news__card-summary--pending', Boolean(a.relevancePending));
    } else {
      summaryEl.hidden = true;
      summaryEl.textContent = '';
    }
  }

  /**
   * @param {Array<object>} articles
   */
  function renderFeed(articles) {
    body.replaceChildren();
    const rows = Array.isArray(articles) ? articles.slice(0, 12) : [];
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'muted main-news__empty';
      empty.textContent = 'No headlines yet.';
      body.append(empty);
      expandedId = null;
      return;
    }

    if (expandedId && !rows.some((a) => a.id === expandedId)) expandedId = null;

    const list = document.createElement('ul');
    list.className = 'main-news__list';
    for (const a of rows) {
      const li = document.createElement('li');
      li.className = 'main-news__item';

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'main-news__card';
      card.dataset.id = a.id;
      const isExpanded = expandedId === a.id;
      card.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      if (isExpanded) card.classList.add('main-news__card--expanded');

      const media = document.createElement('div');
      media.className = 'main-news__card-media';
      const img = document.createElement('img');
      img.className = 'main-news__card-img';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      const imageUrl = String(a.imageUrl || '').trim();
      if (imageUrl) {
        img.src = imageUrl;
        img.addEventListener('error', () => {
          img.remove();
          media.classList.add('main-news__card-media--fallback');
        });
        media.append(img);
      } else {
        media.classList.add('main-news__card-media--fallback');
      }

      const textWrap = document.createElement('div');
      textWrap.className = 'main-news__card-text';

      const title = document.createElement('span');
      title.className = 'main-news__card-title';
      title.textContent = a.title || 'Untitled';

      const meta = document.createElement('span');
      meta.className = 'main-news__card-meta';
      meta.textContent = [a.feedTitle, fmtRelative(a.publishedAt)].filter(Boolean).join(' · ');

      const summary = document.createElement('p');
      summary.className = 'main-news__card-summary';
      summary.hidden = !isExpanded;
      if (isExpanded) {
        summary.textContent = articleSummary(a);
        summary.classList.toggle('main-news__card-summary--pending', Boolean(a.relevancePending));
      }

      textWrap.append(title, meta, summary);
      card.append(media, textWrap);

      card.addEventListener('click', () => {
        const id = a.id;
        const link = String(a.link || '').trim();
        if (expandedId === id) {
          if (link && /^https?:\/\//i.test(link)) {
            window.open(link, '_blank', 'noopener,noreferrer');
          }
          return;
        }
        const prev = expandedId
          ? list.querySelector(`.main-news__card[data-id="${CSS.escape(expandedId)}"]`)
          : null;
        if (prev) {
          const prevArticle = rows.find((x) => x.id === expandedId);
          if (prevArticle) setCardExpanded(prev, prevArticle, false);
        }
        expandedId = id;
        setCardExpanded(card, a, true);
      });

      li.append(card);
      list.append(li);
    }
    body.append(list);
  }

  /**
   * @param {object} j
   */
  function applyPayload(j) {
    lastPayload = j;
    const articles = Array.isArray(j.articles) ? j.articles : [];
    renderFeed(articles);

    if (relevancePollTimer) {
      window.clearTimeout(relevancePollTimer);
      relevancePollTimer = null;
    }
    const pendingRelevance =
      j.relevanceEnabled && articles.some((a) => a.relevancePending);
    if (pendingRelevance) {
      relevancePollTimer = window.setTimeout(() => {
        void refresh();
      }, 10_000);
    }
  }

  async function refresh() {
    try {
      const r = await fetch('/api/local-news', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      applyPayload(j);
      msg.hidden = true;
    } catch (e) {
      if (body.querySelector('.main-news__list') || body.querySelector('.main-news__empty')) return;
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load news';
      msg.hidden = false;
    }
  }

  const cached = readPanelCache(CACHE_KEY, CACHE_MAX_MS);
  if (cached && typeof cached === 'object') applyPayload(cached);

  refresh();
  window.setInterval(refresh, REFRESH_MS);
}

/**
 * @param {HTMLElement | null} root
 * @returns {{ openReader: () => void } | undefined}
 */
export function mountLocalNews(root) {
  if (!root) return undefined;
  root.replaceChildren();
  root.classList.add('local-news');
  wireCardCollapse(root);

  const toolbar = document.createElement('div');
  toolbar.className = 'local-news__toolbar events-finder__toolbar';

  const readerBtn = document.createElement('button');
  readerBtn.type = 'button';
  readerBtn.className = 'local-news__btn local-news__btn--reader';
  readerBtn.textContent = 'Reader';
  readerBtn.title = 'Open the full reader — feeds, list views, and reading pane';
  toolbar.append(readerBtn);

  const feedEditorBtn = document.createElement('button');
  feedEditorBtn.type = 'button';
  feedEditorBtn.className = 'local-news__btn local-news__btn--find';
  feedEditorBtn.textContent = 'Feed editor';
  feedEditorBtn.title = 'Manage feeds, suggestions, and keyword lists';
  feedEditorBtn.setAttribute('aria-expanded', 'false');
  toolbar.append(feedEditorBtn);

  const unreadTag = document.createElement('span');
  unreadTag.className = 'local-news__unread';
  unreadTag.hidden = true;
  toolbar.append(unreadTag);

  const body = document.createElement('div');
  body.className = 'local-news__body';

  const msg = document.createElement('p');
  msg.className = 'local-news__status';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  root.append(toolbar, body, msg);

  let busy = false;
  let relevancePollTimer = null;
  /** @type {{ lookFor: string, skip: string, blacklist: string }} */
  let taste = { lookFor: '', skip: '', blacklist: '' };
  /** @type {object | null} */
  let lastPayload = null;
  /** @type {HTMLElement | null} */
  let findPopoutBackdrop = null;
  /** @type {((e: KeyboardEvent) => void) | null} */
  let findPopoutKeyHandler = null;
  /** @type {{ update: (p: object) => void, close: () => void, isOpen: () => boolean } | null} */
  let reader = null;

  async function saveTaste(patch) {
    const r = await fetch('/api/local-news/criteria', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    taste = { lookFor: j.lookFor ?? '', skip: j.skip ?? '', blacklist: j.blacklist ?? '' };
    await refresh();
  }

  function paintUnread() {
    const articles = Array.isArray(lastPayload?.articles) ? lastPayload.articles : [];
    const n = unreadCount(articles);
    unreadTag.hidden = n === 0;
    unreadTag.textContent = n ? `${n} new` : '';
  }

  function openReader() {
    if (reader?.isOpen()) return;
    // Opened straight off a cold mount the first fetch may still be in flight.
    if (!lastPayload) void refresh();
    reader = openLocalNewsReader({
      payload: lastPayload || {},
      refresh,
      feedback: feedbackArticle,
      snooze: snoozeArticle,
      skip: skipArticle,
      openFeedEditor: () => void openFeedEditorPopout(),
      openLists: () => openListsPopout(),
      onClose: () => {
        reader = null;
        paintUnread();
        void refresh();
      },
    });
  }

  /**
   * @param {object} j
   */
  function applyPayload(j) {
    lastPayload = j;
    if (j.criteria && typeof j.criteria === 'object') {
      taste = {
        lookFor: j.criteria.lookFor ?? '',
        skip: j.criteria.skip ?? '',
        blacklist: j.criteria.blacklist ?? '',
      };
    }

    body.replaceChildren();
    const articles = Array.isArray(j.articles) ? j.articles : [];
    renderArticleList(body, articles, {
      onFeedback: feedbackArticle,
      onSnooze: snoozeArticle,
      onSkip: skipArticle,
      onRead: paintUnread,
    });
    paintUnread();
    reader?.update(j);

    if (relevancePollTimer) {
      window.clearTimeout(relevancePollTimer);
      relevancePollTimer = null;
    }
    const pendingRelevance =
      j.relevanceEnabled
      && Array.isArray(j.articles)
      && j.articles.some((a) => a.relevancePending);
    if (pendingRelevance) {
      relevancePollTimer = window.setTimeout(() => {
        void refresh();
      }, 10_000);
    }
  }

  /**
   * @param {object} a
   * @param {'up' | 'down'} vibe
   */
  async function feedbackArticle(a, vibe) {
    if (!a?.id || busy) return;
    busy = true;
    msg.hidden = false;
    msg.classList.remove('local-news__status--err');
    msg.textContent = vibe === 'up' ? 'Saving more-like-this…' : 'Saving less-like-this…';
    try {
      const r = await fetch('/api/local-news/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vibe, article: articleFeedbackPayload(a) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      await refresh();
      msg.textContent = vibe === 'up' ? 'Noted — more like this.' : 'Noted — less like this.';
      window.setTimeout(() => {
        if (msg.textContent.startsWith('Noted')) msg.hidden = true;
      }, 1800);
    } catch (e) {
      msg.classList.add('local-news__status--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not save feedback';
    } finally {
      busy = false;
    }
  }

  /**
   * @param {object} a
   */
  async function snoozeArticle(a) {
    if (!a?.id || busy) return;
    busy = true;
    msg.hidden = false;
    msg.classList.remove('local-news__status--err');
    msg.textContent = 'Snoozing topic for 2 weeks…';
    try {
      const r = await fetch('/api/local-news/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ article: articleFeedbackPayload(a) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      await refresh();
      msg.textContent = 'Snoozed for 2 weeks.';
      window.setTimeout(() => {
        if (msg.textContent.startsWith('Snoozed')) msg.hidden = true;
      }, 1800);
    } catch (e) {
      msg.classList.add('local-news__status--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not snooze';
    } finally {
      busy = false;
    }
  }

  /**
   * @param {object} a
   */
  async function skipArticle(a) {
    const id = String(a?.id || '').trim();
    if (!id || busy) return;
    busy = true;
    try {
      await saveTaste({ hiddenArticleIds: [id] });
    } finally {
      busy = false;
    }
  }

  async function refresh() {
    try {
      const r = await fetch('/api/local-news', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      writePanelCache(CACHE_KEY, j);
      applyPayload(j);
      const keep =
        msg.textContent.startsWith('Noted')
        || msg.textContent.startsWith('Snoozed')
        || msg.textContent.startsWith('Saving')
        || msg.textContent.startsWith('Snoozing');
      if (!keep) msg.hidden = true;
    } catch (e) {
      if (body.querySelector('.local-news__list') || body.querySelector('.local-news__empty')) return;
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load news feed';
      msg.hidden = false;
    }
  }

  async function subscribeFeed(feedId) {
    const r = await fetch('/api/local-news/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  async function unsubscribeFeed(feedId) {
    const r = await fetch(`/api/local-news/subscriptions/${encodeURIComponent(feedId)}/unsubscribe`, {
      method: 'POST',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  function closeFeedEditorPopout() {
    if (findPopoutKeyHandler) {
      document.removeEventListener('keydown', findPopoutKeyHandler);
      findPopoutKeyHandler = null;
    }
    if (findPopoutBackdrop) {
      findPopoutBackdrop.remove();
      findPopoutBackdrop = null;
    }
    feedEditorBtn.setAttribute('aria-expanded', 'false');
  }

  /**
   * Keyword lists (Look for / grey / black) — nested from Feed editor.
   * @param {{ onSaved?: () => void }} [opts]
   */
  function openListsPopout(opts = {}) {
    const backdrop = document.createElement('div');
    backdrop.className = 'events-finder__conference-popout-backdrop local-news__lists-backdrop';
    const shell = document.createElement('div');
    shell.className = 'events-finder__conference-popout local-news__lists-popout';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-label', 'Keyword lists');

    const bar = document.createElement('div');
    bar.className = 'events-finder__conference-popout-bar';
    const title = document.createElement('h2');
    title.className = 'events-finder__conference-popout-title';
    title.textContent = 'Keyword lists';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'events-finder__conference-popout-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';
    bar.append(title, closeBtn);

    const popBody = document.createElement('div');
    popBody.className = 'events-finder__conference-popout-body local-news__lists-body';

    const hint = document.createElement('p');
    hint.className = 'muted local-news__editor-hint';
    hint.textContent =
      'Keywords only. Thumbs up/down learn concepts separately (tone, framing) — not these lists.';
    popBody.append(hint);

    function tasteField(labelText, id, placeholder, value) {
      const field = document.createElement('div');
      field.className = 'events-finder__field';
      const label = document.createElement('label');
      label.className = 'events-finder__label';
      label.htmlFor = id;
      label.textContent = labelText;
      const area = document.createElement('textarea');
      area.id = id;
      area.className = 'local-news__taste-input';
      area.rows = 4;
      area.placeholder = placeholder;
      area.value = value || '';
      field.append(label, area);
      return { field, area };
    }

    const look = tasteField('Look for (white)', 'local-news-lookfor', 'Keywords or phrases to boost…', taste.lookFor);
    const skip = tasteField('Skip (grey)', 'local-news-skip', 'Downrank these topics…', taste.skip);
    const black = tasteField('Blacklist', 'local-news-blacklist', 'Never show these…', taste.blacklist);
    popBody.append(look.field, skip.field, black.field);

    const status = document.createElement('p');
    status.className = 'muted local-news__find-status';
    status.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'local-news__editor-card-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'events-finder__save';
    saveBtn.textContent = 'Save lists';
    actions.append(saveBtn);
    popBody.append(status, actions);

    shell.append(bar, popBody);
    backdrop.append(shell);
    document.body.append(backdrop);

    const close = () => backdrop.remove();
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      status.hidden = false;
      status.textContent = 'Saving…';
      try {
        await saveTaste({
          lookFor: look.area.value,
          skip: skip.area.value,
          blacklist: black.area.value,
        });
        status.textContent = 'Lists saved.';
        opts.onSaved?.();
        window.setTimeout(close, 500);
      } catch (e) {
        status.textContent =
          e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not save';
        saveBtn.disabled = false;
      }
    });

    closeBtn.focus();
  }

  async function openFeedEditorPopout() {
    closeFeedEditorPopout();

    const backdrop = document.createElement('div');
    backdrop.className = 'events-finder__conference-popout-backdrop local-news__find-backdrop';
    const shell = document.createElement('div');
    shell.className = 'events-finder__conference-popout local-news__find-popout local-news__editor-popout';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-label', 'Feed editor');

    const bar = document.createElement('div');
    bar.className = 'events-finder__conference-popout-bar';
    const title = document.createElement('h2');
    title.className = 'events-finder__conference-popout-title';
    title.textContent = 'Feed editor';
    const listsBtn = document.createElement('button');
    listsBtn.type = 'button';
    listsBtn.className = 'local-news__btn local-news__btn--lists';
    listsBtn.textContent = 'Lists';
    listsBtn.title = 'Look for / grey / blacklist keywords';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'events-finder__conference-popout-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.title = 'Close';
    closeBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';
    const barActions = document.createElement('div');
    barActions.className = 'local-news__editor-bar-actions';
    barActions.append(listsBtn, closeBtn);
    bar.append(title, barActions);

    const popBody = document.createElement('div');
    popBody.className = 'events-finder__conference-popout-body local-news__find-body local-news__editor-layout';

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'local-news__find-search';
    search.placeholder = 'Search publishers or feeds…';
    search.autocomplete = 'off';

    const status = document.createElement('p');
    status.className = 'muted local-news__find-status';
    status.textContent = 'Loading feed editor…';

    const layout = document.createElement('div');
    layout.className = 'local-news__editor-split';

    const sidebar = document.createElement('aside');
    sidebar.className = 'local-news__editor-sidebar';
    sidebar.setAttribute('aria-label', 'Publishers');

    const main = document.createElement('div');
    main.className = 'local-news__editor-main';

    layout.append(sidebar, main);
    popBody.append(search, status, layout);
    shell.append(bar, popBody);
    backdrop.append(shell);
    document.body.append(backdrop);
    findPopoutBackdrop = backdrop;
    feedEditorBtn.setAttribute('aria-expanded', 'true');

    /** @type {object[]} */
    let subscriptions = [];
    /** @type {object[]} */
    let suggestedFeeds = [];
    /** @type {string | null} selected publisher id, or null for all suggestions */
    let selectedPublisherId = null;

    const finishClose = () => {
      closeFeedEditorPopout();
      void refresh();
    };
    closeBtn.addEventListener('click', finishClose);
    listsBtn.addEventListener('click', () => {
      openListsPopout({
        onSaved: () => {
          status.textContent = 'Keyword lists saved.';
        },
      });
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finishClose();
    });
    findPopoutKeyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finishClose();
      }
    };
    document.addEventListener('keydown', findPopoutKeyHandler);

    async function onAddFeed(feedId) {
      if (busy) return;
      busy = true;
      try {
        await subscribeFeed(feedId);
        await loadDirectory();
      } catch (e) {
        status.textContent =
          e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not add feed';
      } finally {
        busy = false;
      }
    }

    async function onRemoveFeed(feedId) {
      if (busy) return;
      busy = true;
      try {
        await unsubscribeFeed(feedId);
        await loadDirectory();
      } catch (e) {
        status.textContent =
          e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not remove feed';
      } finally {
        busy = false;
      }
    }

    async function onHideSuggested(feedId) {
      if (busy) return;
      busy = true;
      try {
        const excludeIds = suggestedFeeds.map((f) => f.id).filter(Boolean);
        const r = await fetch(`/api/local-news/feeds/${encodeURIComponent(feedId)}/decline`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ excludeIds }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
        suggestedFeeds = (suggestedFeeds || []).filter((f) => f.id !== feedId);
        if (j.replacement?.id) {
          suggestedFeeds.push(j.replacement);
        } else if (Array.isArray(j.suggestedFeeds)) {
          const have = new Set(suggestedFeeds.map((f) => f.id));
          for (const f of j.suggestedFeeds) {
            if (f?.id && !have.has(f.id)) {
              suggestedFeeds.push(f);
              break;
            }
          }
        }
        paint();
      } catch (e) {
        status.textContent =
          e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not hide feed';
      } finally {
        busy = false;
      }
    }

    /**
     * @param {object} feed
     * @param {'tuned' | 'suggested'} kind
     */
    function renderFeedCard(feed, kind) {
      const card = document.createElement('div');
      card.className = 'local-news__editor-card';
      const titleWrap = document.createElement('div');
      titleWrap.className = 'local-news__editor-card-titles';
      const feedTitle = document.createElement('p');
      feedTitle.className = 'local-news__editor-card-title';
      feedTitle.textContent = feed.title || 'Feed';
      titleWrap.append(feedTitle);
      card.append(titleWrap);

      const stats = document.createElement('p');
      stats.className = 'muted local-news__editor-card-stats';
      if (kind === 'suggested') {
        stats.textContent = suggestionReasonText(feed.reason, feed);
      } else {
        stats.textContent = formatFeedStatsLine(feed) || feed.publisherTitle || '';
      }
      if (stats.textContent) card.append(stats);

      if (Array.isArray(feed.tags) && feed.tags.length) {
        const tags = document.createElement('p');
        tags.className = 'muted local-news__editor-card-tags';
        tags.textContent = feed.tags.slice(0, 5).join(' · ');
        card.append(tags);
      }

      const actions = document.createElement('div');
      actions.className = 'local-news__editor-card-actions';

      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'local-news__btn local-news__btn--preview';
      previewBtn.textContent = 'Preview';
      previewBtn.disabled = busy;
      previewBtn.addEventListener('click', () => {
        openFeedPreviewModal(feed, {
          mode: kind === 'tuned' ? 'subscribed' : 'discover',
          busy,
          onAdd: kind === 'tuned' ? undefined : () => onAddFeed(feed.id),
        });
      });
      actions.append(previewBtn);

      const siteUrl = feed.siteUrl || feed.url;
      if (siteUrl) {
        const siteBtn = document.createElement('a');
        siteBtn.className = 'local-news__btn local-news__btn--site';
        siteBtn.href = siteUrl;
        siteBtn.target = '_blank';
        siteBtn.rel = 'noopener noreferrer';
        siteBtn.textContent = 'Site';
        actions.append(siteBtn);
      }

      if (kind === 'tuned') {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'local-news__btn local-news__btn--remove';
        removeBtn.textContent = 'Remove';
        removeBtn.disabled = busy;
        removeBtn.addEventListener('click', () => void onRemoveFeed(feed.id));
        actions.append(removeBtn);
      } else {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'local-news__btn local-news__btn--yes';
        addBtn.textContent = 'Add';
        addBtn.disabled = busy;
        addBtn.addEventListener('click', () => void onAddFeed(feed.id));
        actions.append(addBtn);

        const hideBtn = document.createElement('button');
        hideBtn.type = 'button';
        hideBtn.className = 'local-news__btn local-news__btn--no';
        hideBtn.textContent = 'Hide';
        hideBtn.disabled = busy;
        hideBtn.title = 'Hide and show another similar suggestion';
        hideBtn.addEventListener('click', () => void onHideSuggested(feed.id));
        actions.append(hideBtn);
      }

      card.append(actions);
      return card;
    }

    function feedMatchesQuery(q, feed) {
      if (!q) return true;
      const hay = [
        feed.title,
        feed.id,
        feed.publisher,
        feed.publisherTitle,
        feed.category,
        ...(Array.isArray(feed.tags) ? feed.tags : []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    }

    function enrichSubscriptionStats(subs) {
      const articles = Array.isArray(lastPayload?.articles) ? lastPayload.articles : [];
      /** @type {Map<string, { articleCount: number, latestPublishedAt: string | null }>} */
      const byFeed = new Map();
      for (const a of articles) {
        const id = String(a?.feedId || '').trim();
        if (!id) continue;
        let entry = byFeed.get(id);
        if (!entry) {
          entry = { articleCount: 0, latestPublishedAt: null };
          byFeed.set(id, entry);
        }
        entry.articleCount += 1;
        const ms = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const cur = entry.latestPublishedAt ? new Date(entry.latestPublishedAt).getTime() : 0;
        if (ms > cur) entry.latestPublishedAt = a.publishedAt;
      }
      return subs.map((feed) => {
        const fromApi = feed.stats || {};
        const fromClient = byFeed.get(feed.id);
        if (Number.isFinite(fromApi.articleCount)) return feed;
        if (!fromClient) return feed;
        return {
          ...feed,
          stats: {
            articleCount: fromClient.articleCount,
            latestPublishedAt: fromClient.latestPublishedAt,
            fetchedAt: fromApi.fetchedAt || null,
          },
        };
      });
    }

    function paint() {
      sidebar.replaceChildren();
      main.replaceChildren();
      const q = search.value.trim().toLowerCase();

      const tunedByPub = new Map();
      for (const feed of subscriptions) {
        const pubId = feed.publisher || feed.id;
        const pubTitle = feed.publisherTitle || feed.title || pubId;
        if (!tunedByPub.has(pubId)) {
          tunedByPub.set(pubId, { id: pubId, title: pubTitle, feeds: [] });
        }
        tunedByPub.get(pubId).feeds.push(feed);
      }

      const suggestedByPub = new Map();
      for (const feed of suggestedFeeds) {
        if (!feedMatchesQuery(q, feed)) continue;
        const pubId = feed.publisher || 'other';
        const pubTitle = feed.publisherTitle || pubId;
        if (!suggestedByPub.has(pubId)) {
          suggestedByPub.set(pubId, { id: pubId, title: pubTitle, feeds: [] });
        }
        suggestedByPub.get(pubId).feeds.push(feed);
      }

      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'local-news__editor-pub';
      if (!selectedPublisherId) allBtn.classList.add('local-news__editor-pub--active');
      allBtn.textContent = `All suggestions (${suggestedFeeds.length})`;
      allBtn.addEventListener('click', () => {
        selectedPublisherId = null;
        paint();
      });
      sidebar.append(allBtn);

      const tunedLabel = document.createElement('p');
      tunedLabel.className = 'local-news__find-section-title';
      tunedLabel.textContent = 'Tuned in';
      sidebar.append(tunedLabel);

      if (!tunedByPub.size) {
        const empty = document.createElement('p');
        empty.className = 'muted local-news__editor-empty';
        empty.textContent = 'None yet';
        sidebar.append(empty);
      }

      for (const pub of [...tunedByPub.values()].sort((a, b) => a.title.localeCompare(b.title))) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'local-news__editor-pub';
        if (selectedPublisherId === pub.id) btn.classList.add('local-news__editor-pub--active');
        btn.textContent = pub.title;
        btn.title = pub.feeds.map((f) => f.title).join(', ');
        btn.addEventListener('click', () => {
          selectedPublisherId = pub.id;
          paint();
        });
        sidebar.append(btn);

        for (const feed of pub.feeds) {
          const sub = document.createElement('button');
          sub.type = 'button';
          sub.className = 'local-news__editor-pub local-news__editor-pub--feed';
          sub.textContent = feed.title;
          sub.addEventListener('click', () => {
            selectedPublisherId = pub.id;
            paint();
            const el = main.querySelector(`[data-feed-id="${CSS.escape(feed.id)}"]`);
            el?.scrollIntoView({ block: 'nearest' });
          });
          sidebar.append(sub);
        }
      }

      const sugLabel = document.createElement('p');
      sugLabel.className = 'local-news__find-section-title';
      sugLabel.textContent = 'Suggested publishers';
      sidebar.append(sugLabel);

      const sugPubs = [...suggestedByPub.values()]
        .filter((p) => !q || p.title.toLowerCase().includes(q) || p.feeds.some((f) => feedMatchesQuery(q, f)))
        .sort((a, b) => b.feeds.length - a.feeds.length || a.title.localeCompare(b.title));

      for (const pub of sugPubs) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'local-news__editor-pub';
        if (selectedPublisherId === pub.id) btn.classList.add('local-news__editor-pub--active');
        btn.textContent = `${pub.title} (${pub.feeds.length})`;
        btn.addEventListener('click', () => {
          selectedPublisherId = pub.id;
          paint();
        });
        sidebar.append(btn);
      }

      // Main pane
      const tunedForPub = selectedPublisherId
        ? subscriptions.filter((f) => (f.publisher || f.id) === selectedPublisherId)
        : [];
      let shownSuggested = suggestedFeeds.filter((f) => feedMatchesQuery(q, f));
      if (selectedPublisherId) {
        shownSuggested = shownSuggested.filter(
          (f) => (f.publisher || 'other') === selectedPublisherId,
        );
      }

      if (selectedPublisherId && tunedForPub.length) {
        const h = document.createElement('p');
        h.className = 'local-news__find-section-title';
        h.textContent = 'Tuned in from this publisher';
        main.append(h);
        for (const feed of tunedForPub) {
          const card = renderFeedCard(feed, 'tuned');
          card.dataset.feedId = feed.id;
          main.append(card);
        }
      }

      const sugHead = document.createElement('p');
      sugHead.className = 'local-news__find-section-title';
      sugHead.textContent = selectedPublisherId
        ? `Suggested feeds · ${shownSuggested.length}`
        : `Suggested for you · ${shownSuggested.length}`;
      main.append(sugHead);

      const hint = document.createElement('p');
      hint.className = 'muted local-news__editor-hint';
      hint.textContent = selectedPublisherId
        ? 'Feeds from this publisher you might add. Hide replaces with another similar to what you follow.'
        : 'At least 20 suggestions ranked like the feeds you follow. Hide swaps in a similar replacement.';
      main.append(hint);

      if (!shownSuggested.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = q || selectedPublisherId
          ? 'No suggested feeds here — try All suggestions or another publisher.'
          : 'No suggestions left in the directory.';
        main.append(empty);
      } else {
        for (const feed of shownSuggested) {
          main.append(renderFeedCard(feed, 'suggested'));
        }
      }

      status.textContent = `${subscriptions.length} tuned in · ${suggestedFeeds.length} suggested`;
    }

    async function loadDirectory() {
      status.textContent = 'Loading feed editor…';
      try {
        const r = await fetch('/api/local-news/directory', { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
        subscriptions = enrichSubscriptionStats(Array.isArray(j.subscriptions) ? j.subscriptions : []);
        suggestedFeeds = Array.isArray(j.suggestedFeeds) ? j.suggestedFeeds : [];
        paint();
      } catch (e) {
        status.textContent =
          e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load feed editor';
      }
    }

    search.addEventListener('input', () => paint());
    closeBtn.focus();
    await loadDirectory();
  }

  feedEditorBtn.addEventListener('click', () => {
    void openFeedEditorPopout();
  });

  readerBtn.addEventListener('click', () => openReader());

  const cached = readPanelCache(CACHE_KEY, CACHE_MAX_MS);
  if (cached && typeof cached === 'object') applyPayload(cached);

  refresh();
  window.setInterval(refresh, REFRESH_MS);

  return { openReader };
}
