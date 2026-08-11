import { fetchFearGreedIndex } from '../lib/fear-greed.js';
import { createIndicatorDial } from '../lib/indicator-dial.js';

const REFRESH_MS = 90 * 1000;
const FNG_PAGE = 'https://www.cnn.com/markets/fear-and-greed';
/** Google Finance AI research chatbot (Home + Research). */
const FINANCE_CHAT_PAGE = 'https://www.google.com/finance/beta/';

/**
 * Fear & Greed semicircle dial block (used inside Market Watch).
 * @returns {{ section: HTMLElement, applyFng: (fng: object) => void, refresh: () => Promise<void> }}
 */
export function createSentimentDialBlock() {
  const section = document.createElement('div');
  section.className = 'sentiment-dial';

  const headRow = document.createElement('div');
  headRow.className = 'sentiment-dial__head-row';

  const head = document.createElement('a');
  head.className = 'sentiment-dial__head';
  head.href = FNG_PAGE;
  head.target = '_blank';
  head.rel = 'noopener noreferrer';
  head.textContent = 'F & G Index';
  head.title = 'CNN Business F & G Index (opens in new tab)';

  const finance = document.createElement('a');
  finance.className = 'sentiment-dial__head sentiment-dial__finance';
  finance.href = FINANCE_CHAT_PAGE;
  finance.target = '_blank';
  finance.rel = 'noopener noreferrer';
  finance.textContent = 'Finance';
  finance.title = 'Google Finance AI chat (opens in new tab)';

  headRow.append(head, finance);

  const dialMount = document.createElement('div');
  dialMount.className = 'sentiment-dial__dial-mount';

  const status = document.createElement('p');
  status.className = 'sentiment-dial__status';
  status.hidden = true;

  section.append(headRow, dialMount, status);

  const dial = createIndicatorDial(dialMount, { ariaLabel: 'F & G Index dial' });

  /** @type {{ score: number, label: string } | null} */
  let lastGood = null;

  /**
   * @param {number} score
   */
  function isLiveScore(score) {
    const n = Number(score);
    return Number.isFinite(n) && n > 0;
  }

  /** @param {object} fng */
  function applyFng(fng) {
    section.classList.remove('sentiment-dial--error');
    status.hidden = true;
    status.textContent = '';

    if (fng?.ok && isLiveScore(fng.score)) {
      const score = Math.round(Number(fng.score));
      const label = typeof fng.label === 'string' ? fng.label : '';
      lastGood = { score, label };
      const staleNote = fng.stale ? ' · prior reading' : '';
      dial.setValue(score, {
        caption: label + staleNote,
        ariaValueText: label ? `${score}, ${label}` : String(score),
      });
      return;
    }

    if (lastGood) {
      dial.setValue(lastGood.score, {
        caption: `${lastGood.label} · prior reading`,
        ariaValueText: `${lastGood.score}, ${lastGood.label}`,
      });
      return;
    }

    dial.setValue(null);
  }

  async function refresh() {
    dial.setLoading(true);
    try {
      const fng = await fetchFearGreedIndex();
      applyFng(fng);
    } catch {
      applyFng({ ok: false });
    } finally {
      dial.setLoading(false);
    }
  }

  return { section, applyFng, refresh };
}

/**
 * @param {HTMLElement} container
 */
export function mountSentimentDial(container) {
  if (!container) return;
  const { section, refresh } = createSentimentDialBlock();
  container.replaceChildren(section);
  refresh();
  window.setInterval(refresh, REFRESH_MS);
}
