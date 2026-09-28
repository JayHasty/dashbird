import { focusWebSearchInput } from './web-search.js';

const LS_PAGE_KEY = 'dashbirdPage';

/** @typedef {'main' | 'now' | 'network' | 'house-hunter' | 'settings'} DashbirdPage */

/**
 * @param {{ onChange: (page: DashbirdPage) => void }} opts
 */
export function mountPageTabs(mountEl, opts) {
  if (!mountEl) return;

  mountEl.replaceChildren();
  const tabsWrap = document.createElement('div');
  tabsWrap.className = 'topbar__tabs';
  tabsWrap.setAttribute('role', 'tablist');
  tabsWrap.setAttribute('aria-label', 'Dashboard pages');

  /** @type {{ id: DashbirdPage, label: string, el: HTMLButtonElement }[]} */
  // House Hunter tab omitted until work starts (page mount still exists for later).
  const tabs = [
    { id: 'main', label: 'Main', el: document.createElement('button') },
    { id: 'now', label: 'Now', el: document.createElement('button') },
    { id: 'network', label: 'Network', el: document.createElement('button') },
    { id: 'settings', label: 'Settings', el: document.createElement('button') },
  ];

  for (const tab of tabs) {
    tab.el.type = 'button';
    tab.el.className = 'topbar__tab';
    tab.el.id = `page-tab-${tab.id}`;
    tab.el.setAttribute('role', 'tab');
    tab.el.textContent = tab.label;
    tab.el.addEventListener('click', () => setPage(tab.id));
    tabsWrap.append(tab.el);
  }

  mountEl.append(tabsWrap);

  /** @returns {DashbirdPage} */
  function loadPage() {
    const p = localStorage.getItem(LS_PAGE_KEY);
    // house-hunter hidden for now — fall back to main if last page was that tab
    if (p === 'house-hunter') return 'main';
    if (p === 'settings' || p === 'network' || p === 'now' || p === 'nrm') {
      return p === 'nrm' ? 'network' : p;
    }
    return 'main';
  }

  /** @param {DashbirdPage} page */
  function setPage(page) {
    for (const tab of tabs) {
      const active = tab.id === page;
      tab.el.classList.toggle('topbar__tab--active', active);
      tab.el.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    localStorage.setItem(LS_PAGE_KEY, page);
    document.body.classList.toggle('dashy--page-settings', page === 'settings');
    document.body.classList.toggle('dashy--page-house-hunter', page === 'house-hunter');
    document.body.classList.toggle('dashy--page-network', page === 'network');
    document.body.classList.toggle('dashy--page-now', page === 'now');
    document.dispatchEvent(new CustomEvent('dashbird:page', { detail: { page } }));
    opts.onChange(page);
    if (page === 'main') focusWebSearchInput();
  }

  setPage(loadPage());
}
