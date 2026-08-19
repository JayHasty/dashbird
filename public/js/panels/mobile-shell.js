import {
  initMobileHistory,
  pushMobileNav,
  setMobileNavApplyHandler,
  runMobileNavApply,
  isMobileNavApplying,
} from '../lib/mobile-history.js';

const MOBILE_TAB_KEY = 'dashbirdMobileTab';
/** Bump when any mobile panel module changes (cache-bust dynamic imports). */
const MOBILE_PANELS_V = 'mobile-panels-20260810-gmail-open-1';
function phoneDeviceBindUrl() {
  let did = '';
  try { did = String(localStorage.getItem('dashbird_did') || '').trim(); } catch { /* ignore */ }
  return did ? `/auth/device-bind?did=${encodeURIComponent(did)}` : '/auth/device-bind';
}

/**
 * @param {unknown} err
 * @param {string} moduleUrl
 * @returns {Promise<string>}
 */
async function describeModuleImportError(err, moduleUrl) {
  let detail = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
  if (cause && !detail.includes(cause)) detail += ` (${cause})`;
  try {
    const r = await fetch(moduleUrl, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) {
      if (r.status === 401) {
        detail += ` — session expired; open ${phoneDeviceBindUrl()}`;
        return detail;
      }
      detail += ` — server returned HTTP ${r.status}`;
      return detail;
    }
    const ct = String(r.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('javascript') && !ct.includes('ecmascript')) {
      detail += ` — expected JavaScript, got ${ct.split(';')[0]}`;
    }
  } catch {
    /* ignore probe errors */
  }
  return detail;
}

/**
 * @returns {import('../lib/mobile-history.js').MobileTab}
 */
function loadTab() {
  try {
    const t = localStorage.getItem(MOBILE_TAB_KEY);
    if (
      t === 'notes' ||
      t === 'network' ||
      t === 'events' ||
      t === 'groups' ||
      t === 'tasks' ||
      t === 'gmail'
    ) {
      return t;
    }
  } catch {
    /* ignore */
  }
  return 'notes';
}

/**
 * @param {import('../lib/mobile-history.js').MobileTab} tab
 */
function saveTab(tab) {
  try {
    localStorage.setItem(MOBILE_TAB_KEY, tab);
  } catch {
    /* ignore */
  }
}

/**
 * Lean mobile shell: Notes | Tasks | Mail | Events | Contacts | Groups.
 * @param {{
 *   tabsRoot?: HTMLElement | null,
 *   notesRoot?: HTMLElement | null,
 *   networkRoot?: HTMLElement | null,
 *   eventsRoot?: HTMLElement | null,
 *   groupsRoot?: HTMLElement | null,
 *   tasksRoot?: HTMLElement | null,
 *   gmailRoot?: HTMLElement | null,
 * }} mounts
 */
export function mountMobileShell(mounts = {}) {
  const page = document.getElementById('page-mobile');
  if (page) page.hidden = false;

  const tabsRoot = mounts.tabsRoot || document.getElementById('mount-mobile-tabs');
  const notesRoot = mounts.notesRoot || document.getElementById('mount-mobile-notes');
  const networkRoot = mounts.networkRoot || document.getElementById('mount-mobile-network');
  const eventsRoot = mounts.eventsRoot || document.getElementById('mount-mobile-events');
  const groupsRoot = mounts.groupsRoot || document.getElementById('mount-mobile-groups');
  const tasksRoot = mounts.tasksRoot || document.getElementById('mount-mobile-tasks');
  const gmailRoot = mounts.gmailRoot || document.getElementById('mount-mobile-gmail');
  if (
    !tabsRoot ||
    !notesRoot ||
    !networkRoot ||
    !eventsRoot ||
    !groupsRoot ||
    !tasksRoot ||
    !gmailRoot
  ) {
    return;
  }

  tabsRoot.replaceChildren();
  tabsRoot.classList.add('mobile-shell__tabs');

  let tab = loadTab();
  let notesMounted = false;
  let networkMounted = false;
  let eventsMounted = false;
  let groupsMounted = false;
  let tasksMounted = false;
  let gmailMounted = false;

  const notesBtn = document.createElement('button');
  notesBtn.type = 'button';
  notesBtn.className = 'mobile-shell__tab mobile-shell__tab--notes';
  notesBtn.textContent = 'Notes';

  const tasksBtn = document.createElement('button');
  tasksBtn.type = 'button';
  tasksBtn.className = 'mobile-shell__tab mobile-shell__tab--tasks';
  tasksBtn.textContent = 'Tasks';

  const gmailBtn = document.createElement('button');
  gmailBtn.type = 'button';
  gmailBtn.className = 'mobile-shell__tab mobile-shell__tab--mail';
  gmailBtn.textContent = 'Mail';

  const eventsBtn = document.createElement('button');
  eventsBtn.type = 'button';
  eventsBtn.className = 'mobile-shell__tab mobile-shell__tab--events';
  eventsBtn.textContent = 'Events';

  const networkBtn = document.createElement('button');
  networkBtn.type = 'button';
  networkBtn.className = 'mobile-shell__tab mobile-shell__tab--contacts';
  networkBtn.textContent = 'Contacts';

  const groupsBtn = document.createElement('button');
  groupsBtn.type = 'button';
  groupsBtn.className = 'mobile-shell__tab mobile-shell__tab--groups';
  groupsBtn.textContent = 'Groups';

  tabsRoot.append(notesBtn, tasksBtn, gmailBtn, eventsBtn, networkBtn, groupsBtn);

  function syncTabs() {
    notesBtn.classList.toggle('mobile-shell__tab--active', tab === 'notes');
    tasksBtn.classList.toggle('mobile-shell__tab--active', tab === 'tasks');
    gmailBtn.classList.toggle('mobile-shell__tab--active', tab === 'gmail');
    eventsBtn.classList.toggle('mobile-shell__tab--active', tab === 'events');
    networkBtn.classList.toggle('mobile-shell__tab--active', tab === 'network');
    groupsBtn.classList.toggle('mobile-shell__tab--active', tab === 'groups');
    notesBtn.setAttribute('aria-pressed', tab === 'notes' ? 'true' : 'false');
    tasksBtn.setAttribute('aria-pressed', tab === 'tasks' ? 'true' : 'false');
    gmailBtn.setAttribute('aria-pressed', tab === 'gmail' ? 'true' : 'false');
    eventsBtn.setAttribute('aria-pressed', tab === 'events' ? 'true' : 'false');
    networkBtn.setAttribute('aria-pressed', tab === 'network' ? 'true' : 'false');
    groupsBtn.setAttribute('aria-pressed', tab === 'groups' ? 'true' : 'false');
    notesRoot.hidden = tab !== 'notes';
    tasksRoot.hidden = tab !== 'tasks';
    gmailRoot.hidden = tab !== 'gmail';
    eventsRoot.hidden = tab !== 'events';
    networkRoot.hidden = tab !== 'network';
    groupsRoot.hidden = tab !== 'groups';
  }

  /**
   * @param {HTMLElement} statusEl
   * @param {string} label
   * @param {unknown} err
   * @param {string} [moduleUrl]
   */
  async function showPanelLoadError(statusEl, label, err, moduleUrl) {
    const detail = moduleUrl
      ? await describeModuleImportError(err, moduleUrl)
      : err instanceof Error
        ? err.message
        : String(err);
    statusEl.replaceChildren();
    statusEl.append(`${label} failed: ${detail}`);
    if (detail.includes('session expired') || detail.includes('401')) {
      statusEl.append(document.createElement('br'));
      const a = document.createElement('a');
      a.href = phoneDeviceBindUrl();
      a.textContent = 'Re-trust this phone';
      a.style.color = 'inherit';
      a.style.textDecoration = 'underline';
      statusEl.append(a);
    }
  }

  async function ensureNotes() {
    if (notesMounted) return;
    notesMounted = true;
    notesRoot.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = 'Loading notes…';
    notesRoot.append(status);
    const notesUrl = new URL(`./keep-notes.js?v=${MOBILE_PANELS_V}`, import.meta.url).href;
    try {
      const { mountKeepNotes } = await import(notesUrl);
      notesRoot.replaceChildren();
      mountKeepNotes(notesRoot);
    } catch (e) {
      await showPanelLoadError(status, 'Notes', e, notesUrl);
      notesMounted = false;
    }
  }

  async function ensureNetwork() {
    if (networkMounted) return;
    networkMounted = true;
    networkRoot.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = 'Loading contacts…';
    networkRoot.append(status);
    try {
      const { mountNetworkContactsMobile } = await import(
        `./network-contacts-mobile.js?v=${MOBILE_PANELS_V}`
      );
      mountNetworkContactsMobile(networkRoot);
    } catch (e) {
      status.textContent = `Contacts failed: ${e?.message || e}`;
      networkMounted = false;
    }
  }

  async function ensureEvents() {
    if (eventsMounted) return;
    eventsMounted = true;
    eventsRoot.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = 'Loading events…';
    eventsRoot.append(status);
    const eventsModuleUrl = new URL(`./events-finder-mobile.js?v=${MOBILE_PANELS_V}`, import.meta.url).href;
    try {
      const { mountEventsFinderMobile } = await import(eventsModuleUrl);
      mountEventsFinderMobile(eventsRoot);
    } catch (e) {
      status.textContent = `Events failed: ${await describeModuleImportError(e, eventsModuleUrl)}`;
      eventsMounted = false;
    }
  }

  async function ensureGroups() {
    if (groupsMounted) return;
    groupsMounted = true;
    groupsRoot.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = 'Loading groups…';
    groupsRoot.append(status);
    try {
      const { mountNetworkGroupsMobile } = await import(
        `./network-groups-mobile.js?v=${MOBILE_PANELS_V}`
      );
      mountNetworkGroupsMobile(groupsRoot);
    } catch (e) {
      status.textContent = `Groups failed: ${e?.message || e}`;
      groupsMounted = false;
    }
  }

  async function ensureTasks() {
    if (tasksMounted) return;
    tasksMounted = true;
    tasksRoot.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = 'Loading tasks…';
    tasksRoot.append(status);
    try {
      const [{ mountTasksMobile }, config] = await Promise.all([
        import(`./tasks-mobile.js?v=${MOBILE_PANELS_V}`),
        fetch('/api/config', { cache: 'no-store' })
          .then((r) => r.json())
          .catch(() => ({})),
      ]);
      mountTasksMobile(tasksRoot, config && typeof config === 'object' ? config : {});
    } catch (e) {
      status.textContent = `Tasks failed: ${e?.message || e}`;
      tasksMounted = false;
    }
  }

  async function ensureGmail() {
    if (gmailMounted) return;
    gmailMounted = true;
    gmailRoot.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = 'Loading mail…';
    gmailRoot.append(status);
    try {
      const { mountGmailSummaryMobile } = await import(
        `./gmail-summary-mobile.js?v=${MOBILE_PANELS_V}`
      );
      mountGmailSummaryMobile(gmailRoot);
    } catch (e) {
      status.textContent = `Mail failed: ${e?.message || e}`;
      gmailMounted = false;
    }
  }

  /**
   * @param {import('../lib/mobile-history.js').MobileTab} next
   * @param {{ fromHistory?: boolean }} [opts]
   */
  async function setTab(next, opts = {}) {
    tab = next;
    saveTab(tab);
    syncTabs();
    if (tab === 'notes') {
      await ensureNotes();
      document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: { tab: 'notes', pane: 'list' } }));
    } else if (tab === 'network') await ensureNetwork();
    else if (tab === 'groups') await ensureGroups();
    else if (tab === 'tasks') {
      await ensureTasks();
      document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: { tab: 'tasks', pane: 'list' } }));
    } else if (tab === 'gmail') await ensureGmail();
    else await ensureEvents();
  }

  /**
   * @param {import('../lib/mobile-history.js').MobileTab} next
   */
  function onTabClick(next) {
    if (isMobileNavApplying()) return;
    if (next === tab) {
      pushMobileNav({ tab: next, pane: 'list' });
      document.dispatchEvent(
        new CustomEvent('dashbird:mobile-nav', { detail: { tab: next, pane: 'list' } }),
      );
      return;
    }
    pushMobileNav({ tab: next, pane: 'list' });
    void setTab(next).then(() => {
      document.dispatchEvent(
        new CustomEvent('dashbird:mobile-nav', { detail: { tab: next, pane: 'list' } }),
      );
    });
  }

  initMobileHistory(tab);

  setMobileNavApplyHandler((state) =>
    runMobileNavApply(state, async (s) => {
      if (s.tab !== tab) await setTab(s.tab, { fromHistory: true });
      document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: s }));
    }),
  );

  notesBtn.addEventListener('click', () => onTabClick('notes'));
  tasksBtn.addEventListener('click', () => onTabClick('tasks'));
  gmailBtn.addEventListener('click', () => onTabClick('gmail'));
  eventsBtn.addEventListener('click', () => onTabClick('events'));
  networkBtn.addEventListener('click', () => onTabClick('network'));
  groupsBtn.addEventListener('click', () => onTabClick('groups'));

  document.addEventListener('dashbird:mobile-goto', (e) => {
    const d = e.detail;
    if (!d?.tab) return;
    const frame = {
      tab: d.tab,
      pane: d.pane || 'list',
      contactId: d.contactId,
      groupId: d.groupId,
      projectId: d.projectId,
    };
    pushMobileNav(/** @type {import('../lib/mobile-history.js').MobileNavState} */ (frame));
    void setTab(d.tab).then(() => {
      document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: frame }));
    });
  });

  void setTab(tab);
}
