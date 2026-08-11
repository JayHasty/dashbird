/**
 * Network CRM UI — contact list + detail editor.
 * @param {HTMLElement} root
 */

import { beginWaitCursor, endWaitCursor } from '../lib/wait-cursor.js';
import { fillLinkifiedText } from '../lib/linkify-text.js';
import { formatContactLastContact } from '../lib/network-last-contact.js';
import { formatContactBirthday } from '../lib/network-birthday.js';
import {
  ageFromBirthYear,
  formatKidAgeLabel,
  normalizeKidsBirthYears,
} from '../lib/network-kids.js';
import { compareContactSearchNameRank } from '../lib/network-contact-search.js';
import {
  CONTACT_REGION_IN_BAY,
  CONTACT_REGION_OUT,
  contactRegionAttribute,
} from '../lib/network-contact-region.js';
import { NETWORK_LABELS } from '../lib/network-labels.js';
import {
  collectContactLocationOptions,
  createDefaultPeopleFilters,
  PEOPLE_FILTER_DEFAULTS_VERSION,
} from '../lib/network-people-filters.js';
import {
  collectSceneOptions,
  joinSceneTokens,
  splitSceneTokens,
} from '../lib/network-scenes.js';
import {
  invalidateNetworkPrefetch,
  takeGroupsPrefetch,
  takeNetworkPrefetch,
  warmNetworkPages,
} from '../lib/network-prefetch.js';
import { mountNetworkManageTable } from './network-manage-table.js?v=family-type-1';
import { openPickContactDialog } from '../lib/network-add-contacts-dialog.js?v=pick-contact-1';
import {
  fetchHowWeMetSuggestion,
  howWeMetStatusBit,
} from '../lib/network-how-we-met-suggest.js?v=how-we-met-1';
import { notifyContactTasksChanged, onContactTaskDone } from '../lib/task-bridge.js';
const WORKBENCH_KEY = 'dashbird-network-workbench-v1';


const METHOD_LABELS = {
  phone: 'Phone',
  office_phone: 'Office phone',
  email: 'Email',
  signal: 'Signal',
  whatsapp: 'WhatsApp',
  messenger: 'FB Messenger',
  linkedin: 'LinkedIn',
  other: 'Other',
};

const DEFAULT_METHODS = Object.keys(METHOD_LABELS);

/** Fallback until `/api/network/contacts` returns `relationshipStatuses`. */
const DEFAULT_RELATIONSHIP_STATUSES = [
  'Lead',
  'Acquaintance',
  'Cultivating',
  'Inner Circle',
  'Collaborator',
  'Meta',
  'Family',
  'Paused',
  'Former',
];

/**
 * Normalize a stored filter value to a string list (supports legacy single strings).
 * @param {unknown} value
 * @returns {string[]}
 */
function asFilterList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v || '').trim()).filter(Boolean))];
  }
  const s = String(value || '').trim();
  return s ? [s] : [];
}

/** Compact local display for ISO timestamps: MMDDYY-HH:mm (Pacific). */
function formatNetworkTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  /** @type {Record<string, string>} */
  const bag = {};
  for (const p of parts) {
    if (p.type !== 'literal') bag[p.type] = p.value;
  }
  return `${bag.month}${bag.day}${bag.year}-${bag.hour}:${bag.minute}`;
}

/**
 * @param {HTMLElement} root
 */
export function mountNetworkUi(root) {
  if (!root) return;
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'network-crm';

  const tabs = document.createElement('div');
  tabs.className = 'network-crm__tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Network views');

  const peopleTab = document.createElement('button');
  peopleTab.type = 'button';
  peopleTab.className = 'network-crm__tab network-crm__tab--active';
  peopleTab.setAttribute('role', 'tab');
  peopleTab.setAttribute('aria-selected', 'true');
  peopleTab.id = 'network-tab-people';
  peopleTab.textContent = 'People';

  const companiesTab = document.createElement('button');
  companiesTab.type = 'button';
  companiesTab.className = 'network-crm__tab';
  companiesTab.setAttribute('role', 'tab');
  companiesTab.setAttribute('aria-selected', 'false');
  companiesTab.id = 'network-tab-companies';
  companiesTab.textContent = 'Companies';

  tabs.append(peopleTab, companiesTab);

  const peopleSubTabs = document.createElement('div');
  peopleSubTabs.className = 'network-crm__subtabs';
  peopleSubTabs.setAttribute('role', 'tablist');
  peopleSubTabs.setAttribute('aria-label', 'People views');

  const contactsSubTab = document.createElement('button');
  contactsSubTab.type = 'button';
  contactsSubTab.className = 'network-crm__subtab network-crm__subtab--active';
  contactsSubTab.setAttribute('role', 'tab');
  contactsSubTab.setAttribute('aria-selected', 'true');
  contactsSubTab.id = 'network-subtab-contacts';
  contactsSubTab.textContent = 'Contacts';

  const manageSubTab = document.createElement('button');
  manageSubTab.type = 'button';
  manageSubTab.className = 'network-crm__subtab';
  manageSubTab.setAttribute('role', 'tab');
  manageSubTab.setAttribute('aria-selected', 'false');
  manageSubTab.id = 'network-subtab-manage';
  manageSubTab.textContent = 'Manage';

  const groupsSubTab = document.createElement('button');
  groupsSubTab.type = 'button';
  groupsSubTab.className = 'network-crm__subtab';
  groupsSubTab.setAttribute('role', 'tab');
  groupsSubTab.setAttribute('aria-selected', 'false');
  groupsSubTab.id = 'network-subtab-groups';
  groupsSubTab.textContent = 'Groups';

  peopleSubTabs.append(contactsSubTab, manageSubTab, groupsSubTab);

  const toolbar = document.createElement('div');
  toolbar.className = 'network-crm__toolbar';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'network-crm__search';
  search.placeholder = 'Search contacts…';
  search.autocomplete = 'off';

  const peopleActions = document.createElement('div');
  peopleActions.className = 'network-crm__toolbar-actions';
  peopleActions.dataset.view = 'people';

  const companyActions = document.createElement('div');
  companyActions.className = 'network-crm__toolbar-actions';
  companyActions.dataset.view = 'companies';
  companyActions.hidden = true;

  const groupActions = document.createElement('div');
  groupActions.className = 'network-crm__toolbar-actions';
  groupActions.dataset.view = 'groups';
  groupActions.hidden = true;

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'network-crm__btn';
  addBtn.textContent = 'New contact';

  const addCompanyBtn = document.createElement('button');
  addCompanyBtn.type = 'button';
  addCompanyBtn.className = 'network-crm__btn';
  addCompanyBtn.textContent = 'Add company';

  const addGroupBtn = document.createElement('button');
  addGroupBtn.type = 'button';
  addGroupBtn.className = 'network-crm__btn';
  addGroupBtn.textContent = NETWORK_LABELS.createEventOnly;

  const deleteGroupBtn = document.createElement('button');
  deleteGroupBtn.type = 'button';
  deleteGroupBtn.className = 'network-crm__btn network-crm__btn--danger';
  deleteGroupBtn.textContent = 'Delete';
  deleteGroupBtn.disabled = true;

  const saveGroupBtn = document.createElement('button');
  saveGroupBtn.type = 'button';
  saveGroupBtn.className = 'network-crm__btn network-crm__btn--primary';
  saveGroupBtn.textContent = 'Save';
  saveGroupBtn.disabled = true;

  groupActions.append(addGroupBtn, saveGroupBtn, deleteGroupBtn);

  const bulkBtn = document.createElement('button');
  bulkBtn.type = 'button';
  bulkBtn.className = 'network-crm__btn';
  bulkBtn.textContent = 'Bulk add';

  const peopleDefaultActions = document.createElement('div');
  peopleDefaultActions.className = 'network-crm__toolbar-actions';
  peopleDefaultActions.dataset.mode = 'default';
  peopleDefaultActions.append(addBtn, bulkBtn);

  const peopleSelectionActions = document.createElement('div');
  peopleSelectionActions.className = 'network-crm__toolbar-actions';
  peopleSelectionActions.dataset.mode = 'selection';
  peopleSelectionActions.hidden = true;

  const startGroupSelBtn = document.createElement('button');
  startGroupSelBtn.type = 'button';
  startGroupSelBtn.className = 'network-crm__btn network-crm__btn--primary';
  startGroupSelBtn.textContent = 'Start event group';

  const addToGroupBtn = document.createElement('button');
  addToGroupBtn.type = 'button';
  addToGroupBtn.className = 'network-crm__btn';
  addToGroupBtn.textContent = 'Add to group';

  const mergeBtn = document.createElement('button');
  mergeBtn.type = 'button';
  mergeBtn.className = 'network-crm__btn';
  mergeBtn.textContent = 'Merge';

  const deleteSelBtn = document.createElement('button');
  deleteSelBtn.type = 'button';
  deleteSelBtn.className = 'network-crm__btn network-crm__btn--danger';
  deleteSelBtn.textContent = 'Delete';

  const enhanceSelBtn = document.createElement('button');
  enhanceSelBtn.type = 'button';
  enhanceSelBtn.className = 'network-crm__btn';
  enhanceSelBtn.textContent = 'Enhance';

  peopleSelectionActions.append(
    enhanceSelBtn,
    addToGroupBtn,
    startGroupSelBtn,
    mergeBtn,
    deleteSelBtn,
  );

  peopleActions.append(peopleDefaultActions, peopleSelectionActions);
  companyActions.append(addCompanyBtn);
  toolbar.append(search, peopleActions, companyActions, groupActions);

  const peopleFilterBar = document.createElement('div');
  peopleFilterBar.className = 'network-crm__filters';
  peopleFilterBar.setAttribute('aria-label', 'Filter people');

  /** @type {HTMLElement | null} */
  let openFilterMenu = null;

  function closeOpenFilterMenu() {
    if (!openFilterMenu) return;
    openFilterMenu.hidden = true;
    const ownerBtn = /** @type {HTMLElement | undefined} */ (openFilterMenu._filterBtn);
    if (ownerBtn) ownerBtn.setAttribute('aria-expanded', 'false');
    openFilterMenu = null;
  }

  /**
   * Multi-select filter control (checkbox dropdown). Empty selection = All.
   * @param {string} label
   * @param {string} name
   * @param {(string | { value: string, label: string })[]} options
   */
  function makeFilterMultiSelect(label, name, options) {
    const wrapEl = document.createElement('div');
    wrapEl.className = 'network-crm__filter network-crm__filter--multi';
    const span = document.createElement('span');
    span.textContent = label;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'network-crm__input network-crm__filter-select network-crm__filter-multi-btn';
    btn.name = name;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('div');
    menu.className = 'network-crm__filter-multi-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', label);
    menu.setAttribute('aria-multiselectable', 'true');
    /** @type {any} */
    (menu)._filterBtn = btn;

    /** @type {{ value: string, label: string }[]} */
    let optionList = [];
    /** @type {Set<string>} */
    let selected = new Set();
    /** @type {(() => void) | null} */
    let changeHandler = null;

    function summarize() {
      if (!selected.size) return 'All';
      const labels = optionList.filter((o) => selected.has(o.value)).map((o) => o.label);
      if (labels.length === 1) return labels[0];
      if (labels.length === 2) return `${labels[0]}, ${labels[1]}`;
      return `${labels[0]} +${labels.length - 1}`;
    }

    function syncBtn() {
      btn.textContent = summarize();
      wrapEl.classList.toggle('network-crm__filter--active', selected.size > 0);
    }

    function paintMenu() {
      menu.replaceChildren();
      const actions = document.createElement('div');
      actions.className = 'network-crm__filter-multi-actions';
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'network-crm__filter-multi-link';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => {
        if (!selected.size) return;
        selected.clear();
        paintMenu();
        syncBtn();
        changeHandler?.();
      });
      actions.append(clearBtn);
      menu.append(actions);
      for (const opt of optionList) {
        const lab = document.createElement('label');
        lab.className = 'network-crm__filter-multi-opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = opt.value;
        cb.checked = selected.has(opt.value);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(opt.value);
          else selected.delete(opt.value);
          syncBtn();
          changeHandler?.();
        });
        lab.append(cb, document.createTextNode(` ${opt.label}`));
        menu.append(lab);
      }
    }

    /**
     * @param {(string | { value: string, label: string })[]} opts
     */
    function setOptions(opts) {
      optionList = (opts || []).map((opt) =>
        typeof opt === 'string' ? { value: opt, label: opt } : { value: opt.value, label: opt.label },
      );
      const valid = new Set(optionList.map((o) => o.value));
      selected = new Set([...selected].filter((v) => valid.has(v)));
      paintMenu();
      syncBtn();
    }

    function getSelected() {
      return optionList.filter((o) => selected.has(o.value)).map((o) => o.value);
    }

    /**
     * @param {unknown} values
     */
    function setSelected(values) {
      const valid = new Set(optionList.map((o) => o.value));
      selected = new Set(asFilterList(values).filter((v) => valid.has(v)));
      paintMenu();
      syncBtn();
    }

    /**
     * @param {() => void} fn
     */
    function onChange(fn) {
      changeHandler = fn;
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = menu.hidden;
      closeOpenFilterMenu();
      if (opening) {
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        openFilterMenu = menu;
      }
    });
    menu.addEventListener('click', (e) => e.stopPropagation());

    setOptions(options);
    wrapEl.append(span, btn, menu);
    return { wrapEl, getSelected, setSelected, setOptions, onChange };
  }

  const kindFilter = makeFilterMultiSelect('Type', 'filter-kind', [
    { value: 'friend', label: 'Friend' },
    { value: 'organizer', label: 'Organizer' },
    { value: 'business', label: 'Business' },
    { value: 'family', label: 'Family' },
  ]);
  const relationshipFilter = makeFilterMultiSelect(
    'Relationship',
    'filter-relationship',
    DEFAULT_RELATIONSHIP_STATUSES,
  );
  const statusFilter = makeFilterMultiSelect('Status', 'filter-status', [
    'Fan',
    'Hot',
    'Warm',
    'Cold',
  ]);
  const locationFilter = makeFilterMultiSelect('Location', 'filter-location', []);
  const regionFilter = makeFilterMultiSelect('Region', 'filter-region', [
    CONTACT_REGION_IN_BAY,
    CONTACT_REGION_OUT,
  ]);
  const hasTaskFilter = makeFilterMultiSelect('Has task', 'filter-has-task', [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
  ]);

  /**
   * @param {string} label
   * @param {string} name
   * @param {boolean} checked
   */
  function makeDefaultFilterCheck(label, name, checked) {
    const lab = document.createElement('label');
    lab.className = 'network-crm__filter-default-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.name = name;
    cb.checked = checked;
    cb.setAttribute('aria-label', label);
    lab.append(cb, document.createTextNode(` ${label}`));
    return { lab, cb };
  }

  const hidePausedFilter = makeDefaultFilterCheck('Hide Paused', 'filter-hide-paused', true);
  const hideFormerFilter = makeDefaultFilterCheck('Hide Former', 'filter-hide-former', true);
  const defaultFilters = document.createElement('div');
  defaultFilters.className = 'network-crm__filter network-crm__filter--default';
  defaultFilters.setAttribute('aria-label', 'Default filters');
  const defaultLabel = document.createElement('span');
  defaultLabel.textContent = 'Default';
  const defaultRows = document.createElement('div');
  defaultRows.className = 'network-crm__filter-default-stack';
  defaultRows.append(hidePausedFilter.lab, hideFormerFilter.lab);
  defaultFilters.append(defaultLabel, defaultRows);

  // Host for Manage toolbar (Columns / Undo fill) — shown only on Manage tab.
  const manageFilterActions = document.createElement('div');
  manageFilterActions.className = 'network-crm__filter-manage-actions';
  manageFilterActions.hidden = true;
  manageFilterActions.setAttribute('aria-label', 'Manage table actions');

  peopleFilterBar.append(
    kindFilter.wrapEl,
    relationshipFilter.wrapEl,
    statusFilter.wrapEl,
    locationFilter.wrapEl,
    regionFilter.wrapEl,
    manageFilterActions,
    defaultFilters,
  );

  const bulkPanel = document.createElement('div');
  bulkPanel.className = 'network-crm__bulk';
  bulkPanel.hidden = true;
  bulkPanel.innerHTML = `
    <label class="network-crm__field network-crm__field--full">
      <span>Names (one per line)</span>
      <textarea class="network-crm__input network-crm__bulk-text" rows="6" placeholder="Sam Rivera&#10;Alex Chen&#10;Jordan Lee"></textarea>
    </label>
    <div class="network-crm__checks">
      <label class="network-crm__check"><input type="checkbox" name="bulk-friend" checked> Friend</label>
      <label class="network-crm__check"><input type="checkbox" name="bulk-organizer"> Organizer</label>
      <label class="network-crm__check"><input type="checkbox" name="bulk-business"> Business</label>
      <label class="network-crm__check"><input type="checkbox" name="bulk-family"> Family</label>
      <label class="network-crm__check"><input type="checkbox" name="bulk-has-kids"> Have kids</label>
    </div>
    <div class="network-crm__bulk-actions">
      <button type="button" class="network-crm__btn network-crm__btn--primary" data-bulk-submit>Add all</button>
      <button type="button" class="network-crm__btn" data-bulk-cancel>Cancel</button>
    </div>
  `;

  const layout = document.createElement('div');
  layout.className = 'network-crm__layout';

  const list = document.createElement('ul');
  list.className = 'network-crm__list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'People');
  list.setAttribute('aria-labelledby', 'network-tab-people');

  const managePane = document.createElement('div');
  managePane.className = 'network-crm__manage-pane';
  managePane.setAttribute('aria-label', 'Manage contacts');
  managePane.hidden = true;

  const detail = document.createElement('div');
  detail.className = 'network-crm__detail';
  detail.innerHTML = '<p class="muted">Select a person</p>';

  const status = document.createElement('p');
  status.className = 'network-crm__status muted';
  status.hidden = true;

  layout.append(list, managePane, detail);
  const mainPane = document.createElement('div');
  mainPane.className = 'network-crm__main';
  mainPane.append(layout, status);

  const groupsPane = document.createElement('div');
  groupsPane.className = 'network-crm__groups-pane';
  groupsPane.hidden = true;

  // Toolbar sits above Contacts/Manage/Groups so search + actions stay visible on Groups.
  wrap.append(tabs, peopleSubTabs, toolbar, peopleFilterBar, bulkPanel, mainPane, groupsPane);

  /** Cap contacts/companies list + detail just above the browser bottom. */
  function syncWorkbenchToViewport() {
    if (!wrap.classList.contains('network-crm--fill')) return;
    if (groupsContactOpen) {
      if (!detail.isConnected || detail.hidden) return;
      const pagePad = 12;
      const top = detail.getBoundingClientRect().top;
      const avail = Math.floor(window.innerHeight - top - pagePad);
      detail.style.maxHeight = `${Math.max(120, avail)}px`;
      return;
    }
    if (list.hidden || !managePane.hidden) return;
    if (!list.isConnected) return;
    const pagePad = 12;
    for (const el of [list, detail]) {
      if (el.hidden) continue;
      const top = el.getBoundingClientRect().top;
      const avail = Math.floor(window.innerHeight - top - pagePad);
      el.style.maxHeight = `${Math.max(120, avail)}px`;
    }
  }

  const onWorkbenchViewportChange = () => {
    requestAnimationFrame(syncWorkbenchToViewport);
  };
  window.addEventListener('resize', onWorkbenchViewportChange);
  window.visualViewport?.addEventListener('resize', onWorkbenchViewportChange);
  const workbenchFitObs = new ResizeObserver(onWorkbenchViewportChange);
  workbenchFitObs.observe(wrap);

  const voiceBar = document.createElement('div');
  voiceBar.className = 'network-crm__voice-bar';
  voiceBar.hidden = true;
  voiceBar.innerHTML = `
    <span class="network-crm__voice-bar-dot" aria-hidden="true"></span>
    <span class="network-crm__voice-bar-label">Recording…</span>
    <button type="button" class="network-crm__btn network-crm__btn--primary" data-voice-stop>Stop &amp; enrich</button>
  `;
  wrap.append(voiceBar);
  root.append(wrap);

  /** @type {object[]} */
  let contacts = [];
  /** False until the first contacts fetch finishes (success or empty). */
  let contactsReady = false;
  /** @type {object[]} */
  let organizations = [];
  /** @type {string[]} */
  let methodOptions = DEFAULT_METHODS;
  /** @type {string[]} */
  let relationshipOptions = DEFAULT_RELATIONSHIP_STATUSES;
  /** @type {string | null} */
  let selectedId = null;
  /** Unsaved edits in the open contact detail form. */
  let detailDirty = false;
  /** @type {'people' | 'companies'} */
  let view = 'people';
  /** @type {'contacts' | 'manage' | 'groups'} */
  let peopleSubTab = 'contacts';
  /** @type {boolean} */
  let groupsUiMounted = false;
  /** @type {{ focus: (opts?: { selectGroupId?: string | null, refresh?: boolean }) => Promise<void>, setQuery?: (q: string) => void, createGroup?: () => Promise<void>, saveSelected?: () => Promise<void>, deleteSelected?: () => Promise<void>, canEditSelected?: () => boolean } | null} */
  let groupsUiApi = null;
  /** Prefetched groups for instant Groups tab paint. */
  let groupsCache = [];
  /** @type {{ render: () => void, syncSelectionUi?: () => void, destroy: () => void } | null} */
  let manageTableApi = null;
  /** @type {string | null} */
  let selectedOrgId = null;
  /** @type {Set<string>} */
  const selectedContactIds = new Set();
  /** @type {Set<string>} */
  const selectedOrgIds = new Set();
  let query = '';
  /** @type {{ kinds: string[], hasTasks: string[], relationships: string[], statuses: string[], locations: string[], regions: string[], hidePaused: boolean, hideFormer: boolean }} */
  let peopleFilters = createDefaultPeopleFilters();

  function persistWorkbenchState() {
    try {
      sessionStorage.setItem(
        WORKBENCH_KEY,
        JSON.stringify({
          view,
          peopleSubTab,
          query: search.value || query || '',
          peopleFilters,
          filterDefaultsVersion: PEOPLE_FILTER_DEFAULTS_VERSION,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  /**
   * @returns {{
   *   view?: 'people' | 'companies',
   *   peopleSubTab?: 'contacts' | 'manage' | 'groups',
   *   query?: string,
   *   peopleFilters?: Record<string, unknown>,
   *   filterDefaultsVersion?: number,
   * } | null}
   */
  function readWorkbenchState() {
    try {
      const raw = sessionStorage.getItem(WORKBENCH_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function applyWorkbenchFiltersToUi() {
    kindFilter.setSelected(peopleFilters.kinds);
    hasTaskFilter.setSelected(peopleFilters.hasTasks);
    relationshipFilter.setSelected(peopleFilters.relationships);
    statusFilter.setSelected(peopleFilters.statuses);
    locationFilter.setSelected(peopleFilters.locations);
    regionFilter.setSelected(peopleFilters.regions);
    hidePausedFilter.cb.checked = peopleFilters.hidePaused !== false;
    hideFormerFilter.cb.checked = peopleFilters.hideFormer !== false;
    if (typeof query === 'string') search.value = query;
  }
  /** Session flag: org detail "More attributes" panel open */
  let orgAttrsExpanded = false;
  /** Session flag: contact detail "More attributes" panel open */
  let contactAttrsExpanded = false;
  /** Manage tab: detail pane only after double-clicking a row */
  let manageDetailOpen = false;
  /** Groups tab: full contact card in the shared detail pane (same as Contacts). */
  let groupsContactOpen = false;
  /** Bumps when detail pane is remounted; cancels stale in-flight saves */
  let detailGeneration = 0;
  const MAX_UNDO = 25;
  /** @type {Map<string, object[]>} */
  const contactUndoStacks = new Map();
  /** @type {Map<string, object[]>} */
  const orgUndoStacks = new Map();

  /**
   * @param {unknown} a
   * @param {unknown} b
   */
  function sameJson(a, b) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  /**
   * Enrichment fields included in undo snapshots (wrong-person enrich revert).
   * @param {object | null | undefined} e
   */
  function enrichmentToPutBody(e) {
    return {
      sources: Array.isArray(e?.sources) ? [...e.sources] : [],
      enrichedAt: e?.enrichedAt || null,
      rawSummary: e?.rawSummary || null,
      confidence: typeof e?.confidence === 'number' ? e.confidence : null,
      needsReview: Boolean(e?.needsReview),
      lastMode: e?.lastMode || null,
    };
  }

  /**
   * PUT body snapshot from a loaded contact (for undo restore).
   * Includes avatar + enrichment so Undo can reverse a bad enrich.
   * @param {object} c
   */
  function contactToPutBody(c) {
    return {
      displayName: c.displayName || '',
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      nickname: c.nickname || '',
      memoryJog: c.memoryJog || '',
      title: c.title || '',
      org: c.org || '',
      kinds: Array.isArray(c.kinds) && c.kinds.length ? [...c.kinds] : ['friend'],
      hasKids: Boolean(c.hasKids),
      kidsBirthYears: Array.isArray(c.kidsBirthYears) ? [...c.kidsBirthYears] : [],
      location: c.location || '',
      address: c.address || '',
      relationshipStatus: c.relationshipStatus || '',
      aliases: Array.isArray(c.aliases) ? [...c.aliases] : [],
      department: c.department || '',
      rating: c.rating || '',
      sensitivity: c.sensitivity || '',
      nextStep: c.nextStep || '',
      tasks: Array.isArray(c.tasks)
        ? c.tasks.map((t) => {
            /** @type {{ id: string, text: string, done: boolean, vikunjaTaskId?: string }} */
            const row = {
              id: String(t.id || ''),
              text: String(t.text || ''),
              done: Boolean(t.done),
            };
            if (t.vikunjaTaskId) row.vikunjaTaskId = String(t.vikunjaTaskId);
            return row;
          })
        : [],
      mergeSuggestions: Array.isArray(c.mergeSuggestions)
        ? c.mergeSuggestions.map((s) => ({ ...s }))
        : [],
      bio: c.bio || '',
      howWeMet: c.howWeMet || '',
      relationshipSummary: c.relationshipSummary || '',
      networkCircles: c.networkCircles || '',
      notes: c.notes || '',
      alignedActivities: Array.isArray(c.alignedActivities) ? [...c.alignedActivities] : [],
      preferredContactMethods: Array.isArray(c.preferredContactMethods)
        ? [...c.preferredContactMethods]
        : [],
      lastContactAt: c.lastContactAt || null,
      lastContactPrecision: c.lastContactPrecision || null,
      birthdayMonth: c.birthdayMonth || null,
      birthdayDay: c.birthdayDay || null,
      birthdayYear: c.birthdayYear || null,
      channels: {
        email: c.channels?.email || null,
        phone: c.channels?.phone || null,
        officePhone: c.channels?.officePhone || null,
        sms: c.channels?.sms || null,
        signal: c.channels?.signal || null,
        whatsapp: c.channels?.whatsapp || null,
        telegram: c.channels?.telegram || null,
        messenger: c.channels?.messenger || null,
        linkedin: c.channels?.linkedin || null,
        other: c.channels?.other || null,
        urls: Array.isArray(c.channels?.urls) ? [...c.channels.urls] : [],
      },
      avatarUrl: c.avatarUrl || null,
      avatarSourceUrl: c.avatarSourceUrl || null,
      enrichment: enrichmentToPutBody(c.enrichment),
      intakeReviewed: c.intakeReviewed !== false,
      source: c.source || 'manual',
    };
  }

  /**
   * @param {object} o
   */
  function orgToPutBody(o) {
    return {
      name: o.name || '',
      type: o.type || '',
      industry: o.industry || '',
      website: o.website || null,
      description: o.description || '',
      lifecycleStatus: o.lifecycleStatus || '',
      region: o.region || '',
      location: o.location || '',
      phone: o.phone || '',
      ownership: o.ownership || '',
      accountSource: o.accountSource || '',
      rating: o.rating || '',
      annualRevenue: o.annualRevenue || '',
      employeeCount: o.employeeCount || '',
      fiscalYearEnd: o.fiscalYearEnd || '',
      competitiveNotes: o.competitiveNotes || '',
      email: o.email || '',
      linkedin: o.linkedin || null,
      socialUrls: Array.isArray(o.socialUrls) ? [...o.socialUrls] : [],
      locale: o.locale || '',
      primaryContactId: o.primaryContactId || null,
      partnerRelationships: o.partnerRelationships || '',
      nextStep: o.nextStep || '',
      summary: o.summary || '',
      aliases: Array.isArray(o.aliases) ? [...o.aliases] : [],
      urls: Array.isArray(o.urls) ? [...o.urls] : [],
      logoUrl: o.logoUrl || null,
      suggestedPeople: Array.isArray(o.suggestedPeople)
        ? o.suggestedPeople.map((p) => ({ ...p }))
        : [],
      enrichment: enrichmentToPutBody(o.enrichment),
      source: o.source || 'manual',
    };
  }

  /**
   * Push a pre-change snapshot so Undo can restore it (save or enrich).
   * @param {Map<string, object[]>} stacks
   * @param {string} id
   * @param {object} snap
   */
  function pushUndoSnap(stacks, id, snap) {
    if (!id || !snap) return;
    let stack = stacks.get(id);
    if (!stack) {
      stack = [];
      stacks.set(id, stack);
    }
    const top = stack[stack.length - 1];
    if (top && sameJson(top, snap)) return;
    stack.push(snap);
    if (stack.length > MAX_UNDO) stack.shift();
  }

  function syncPeopleSubView() {
    const onPeople = view === 'people';
    const onContacts = onPeople && peopleSubTab === 'contacts';
    const onManage = onPeople && peopleSubTab === 'manage';
    const onGroups = onPeople && peopleSubTab === 'groups';
    const onGroupsContact = onGroups && groupsContactOpen;

    peopleSubTabs.hidden = !onPeople;
    contactsSubTab.classList.toggle('network-crm__subtab--active', onContacts);
    manageSubTab.classList.toggle('network-crm__subtab--active', onManage);
    groupsSubTab.classList.toggle('network-crm__subtab--active', onGroups);
    contactsSubTab.setAttribute('aria-selected', onContacts ? 'true' : 'false');
    manageSubTab.setAttribute('aria-selected', onManage ? 'true' : 'false');
    groupsSubTab.setAttribute('aria-selected', onGroups ? 'true' : 'false');

    if (onContacts || view === 'companies') {
      list.hidden = false;
      managePane.hidden = true;
    } else if (onManage) {
      list.hidden = true;
      managePane.hidden = false;
    } else {
      list.hidden = true;
      managePane.hidden = true;
    }
    layout.classList.toggle('network-crm__layout--manage', onManage);
    layout.classList.toggle(
      'network-crm__layout--manage-table-only',
      onManage && !manageDetailOpen,
    );
    layout.classList.toggle('network-crm__layout--groups-contact', onGroupsContact);
    layout.classList.toggle('network-crm__layout--companies', view === 'companies');
    if (onManage && !manageDetailOpen) {
      detail.hidden = true;
    } else {
      detail.hidden = false;
    }

    // Contacts keeps the full filter bar; Manage keeps Columns / Undo fill + Default.
    kindFilter.wrapEl.hidden = onManage;
    relationshipFilter.wrapEl.hidden = onManage;
    statusFilter.wrapEl.hidden = onManage;
    locationFilter.wrapEl.hidden = onManage;
    regionFilter.wrapEl.hidden = onManage;
    manageFilterActions.hidden = !onManage;
    peopleFilterBar.classList.toggle('network-crm__filters--manage', onManage);
  }

  function syncTabs() {
    const onPeople = view === 'people';
    const onCompanies = view === 'companies';
    const onContacts = onPeople && peopleSubTab === 'contacts';
    const onManage = onPeople && peopleSubTab === 'manage';
    const onGroups = onPeople && peopleSubTab === 'groups';
    const onGroupsContact = onGroups && groupsContactOpen;
    const onPeopleWorkbench = onContacts || onManage;
    peopleTab.classList.toggle('network-crm__tab--active', onPeople);
    companiesTab.classList.toggle('network-crm__tab--active', onCompanies);
    peopleTab.setAttribute('aria-selected', onPeople ? 'true' : 'false');
    companiesTab.setAttribute('aria-selected', onCompanies ? 'true' : 'false');
    search.placeholder = onCompanies
      ? 'Search companies…'
      : onGroups
        ? 'Search groups…'
        : onManage
          ? 'Search contacts…'
          : 'Search people…';
    peopleActions.hidden = !onPeopleWorkbench;
    companyActions.hidden = !onCompanies;
    groupActions.hidden = !onGroups;
    peopleFilterBar.hidden = !onPeopleWorkbench;
    mainPane.hidden = onGroups && !groupsContactOpen;
    groupsPane.hidden = !onGroups;
    wrap.classList.toggle('network-crm--groups-contact', onGroupsContact);
    wrap.classList.toggle('network-crm--fill', onContacts || onManage || onGroups || onCompanies);
    if (!onPeopleWorkbench) bulkPanel.hidden = true;
    syncPeopleSubView();
    syncSelectionActions();
    syncGroupToolbar();
    syncWorkbenchToViewport();
  }

  function syncGroupToolbar() {
    const canEdit = Boolean(groupActions && !groupActions.hidden && groupsUiApi?.canEditSelected?.());
    deleteGroupBtn.disabled = !canEdit;
    saveGroupBtn.disabled = !canEdit;
  }

  function syncSelectionActions() {
    const n = selectedContactIds.size;
    const selecting =
      n > 0 && view === 'people' && (peopleSubTab === 'contacts' || peopleSubTab === 'manage');
    peopleDefaultActions.hidden = selecting;
    peopleSelectionActions.hidden = !selecting;
    const count = n ? ` (${n})` : '';
    startGroupSelBtn.textContent = `Start event group${count}`;
    addToGroupBtn.textContent = `Add to group${count}`;
    mergeBtn.textContent = n >= 2 ? `Merge (${n})` : 'Merge';
    mergeBtn.disabled = n < 2;
    deleteSelBtn.textContent = `Delete${count}`;
    enhanceSelBtn.textContent = `Enhance${count}`;
    if (peopleSubTab === 'manage') manageTableApi?.syncSelectionUi?.();
  }

  /**
   * @param {'people' | 'companies'} next
   * @param {{ selectOrgId?: string | null, selectGroupId?: string | null, peopleSubTab?: 'contacts' | 'manage' | 'groups' }} [opts]
   */
  async function setView(next, opts = {}) {
    const nextPeopleSub = next === 'people' ? opts.peopleSubTab || peopleSubTab : peopleSubTab;
    const onPeopleDetail =
      view === 'people'
      && Boolean(selectedId)
      && (peopleSubTab === 'contacts'
        || (peopleSubTab === 'manage' && manageDetailOpen)
        || (peopleSubTab === 'groups' && groupsContactOpen));
    const leavingPeopleDetail =
      onPeopleDetail
      && (next !== 'people' || nextPeopleSub !== peopleSubTab);
    if (leavingPeopleDetail && !confirmLeaveUnsaved()) return;
    if (leavingPeopleDetail) detailDirty = false;

    view = next;
    if (next === 'people' && opts.peopleSubTab) {
      if (opts.peopleSubTab !== 'groups' && peopleSubTab === 'groups') {
        groupsContactOpen = false;
        groupsUiApi?.setDetailPaneHidden?.(false);
      }
      peopleSubTab = opts.peopleSubTab;
    } else if (next === 'companies') {
      peopleSubTab = 'contacts';
      groupsContactOpen = false;
      groupsUiApi?.setDetailPaneHidden?.(false);
    }
    persistWorkbenchState();
    syncTabs();
    if (next === 'people' && peopleSubTab === 'groups') {
      await openGroupsUi({ selectGroupId: opts.selectGroupId || null });
      return;
    }
    // Keep Groups UI mounted while hidden so re-entry is instant.
    list.setAttribute('aria-label', next === 'people' ? 'People' : 'Companies');
    list.setAttribute(
      'aria-labelledby',
      next === 'people' ? 'network-subtab-contacts' : 'network-tab-companies',
    );
    if (next === 'companies') {
      await loadOrganizations();
      const listed = orgsWithPeople();
      const prefer = opts.selectOrgId ?? selectedOrgId;
      selectedOrgId =
        (prefer && listed.some((o) => o.id === prefer) ? prefer : null) ??
        listed[0]?.id ??
        null;
      // #region agent log
      {
        const body = JSON.stringify({
          sessionId: '3c9ec5',
          runId: 'pre-fix',
          hypothesisId: 'D',
          location: 'network-ui.js:setView:companies',
          message: 'companies tab loaded',
          data: {
            organizationsCount: organizations.length,
            listedCount: listed.length,
            selectedOrgId: selectedOrgId || null,
            personaInOrgs: organizations
              .filter((x) => /persona/i.test(String(x.name || '')))
              .map((x) => ({ id: x.id, name: x.name })),
            personaInListed: listed
              .filter((x) => /persona/i.test(String(x.name || '')))
              .map((x) => ({ id: x.id, name: x.name })),
            mattLink: (() => {
              const m = contacts.find((c) => /carney/i.test(String(c.displayName || '')));
              return m
                ? { id: m.id, org: m.org || null, orgId: m.orgId || null }
                : null;
            })(),
          },
          timestamp: Date.now(),
        });
        fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '3c9ec5' },
          body,
        }).catch(() => {});
        fetch('/api/dev-agent-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).catch(() => {});
      }
      // #endregion
      renderList();
      if (selectedOrgId) openOrganization(selectedOrgId);
      else {
        detail.innerHTML =
          '<p class="muted">No companies with people yet — link a contact to an organization, or add a company and a person.</p>';
      }
      return;
    }
    renderList();
    if (peopleSubTab === 'manage') {
      if (!manageDetailOpen) {
        selectedId = null;
        detail.innerHTML = '<p class="muted">Double-click a name for details · double-click other cells to edit</p>';
      } else if (selectedId) {
        selectContact(selectedId);
      } else {
        manageDetailOpen = false;
        detail.innerHTML = '<p class="muted">Double-click a name for details · double-click other cells to edit</p>';
      }
      syncPeopleSubView();
      return;
    }
    manageDetailOpen = false;
    if (selectedId) selectContact(selectedId);
    else detail.innerHTML = '<p class="muted">Select a person</p>';
  }

  /**
   * @param {'contacts' | 'manage' | 'groups'} next
   * @param {{ selectGroupId?: string | null }} [opts]
   */
  async function setPeopleSubTab(next, opts = {}) {
    if (view !== 'people') view = 'people';
    await setView('people', {
      peopleSubTab: next,
      selectGroupId: opts.selectGroupId || null,
    });
    if (peopleSubTab === next) manageDetailOpen = false;
    if (next !== 'groups') {
      groupsContactOpen = false;
      groupsUiApi?.setDetailPaneHidden?.(false);
    }
  }

  function ensureManageTable() {
    if (manageTableApi) return;
    try {
      manageTableApi = mountNetworkManageTable(managePane, {
        toolbarHost: manageFilterActions,
        getContacts: () => filtered(),
        getAllContacts: () => contacts,
        getSelectedIds: () => selectedContactIds,
        getRelationshipStatuses: () => relationshipOptions,
        getPreferredContactMethods: () => methodOptions,
        isLoading: () => !contactsReady,
        setSelectedIds: (ids) => {
          selectedContactIds.clear();
          for (const id of ids) selectedContactIds.add(id);
          syncSelectionActions();
        },
        onSelectContact: (id) => {
          manageDetailOpen = true;
          syncPeopleSubView();
          selectContact(id, { force: true });
        },
        onContactsUpdated: (updated) => {
          for (const u of updated) {
            const idx = contacts.findIndex((x) => x.id === u.id);
            if (idx >= 0) contacts[idx] = u;
          }
          if (peopleSubTab === 'manage') manageTableApi?.render();
          else if (peopleSubTab === 'contacts') renderList();
          if (selectedId && updated.some((u) => u.id === selectedId)) {
            const c = contacts.find((x) => x.id === selectedId);
            if (c) renderDetail(c);
          }
        },
        showStatus,
      });
    } catch (err) {
      manageTableApi = null;
      managePane.replaceChildren();
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Manage table failed to load — hard-refresh the page.';
      managePane.append(p);
      throw err;
    }
  }

  function applyContactEnumsFromApi(j) {
    if (Array.isArray(j.preferredContactMethods) && j.preferredContactMethods.length) {
      methodOptions = j.preferredContactMethods;
    }
    if (Array.isArray(j.relationshipStatuses) && j.relationshipStatuses.length) {
      relationshipOptions = j.relationshipStatuses;
      relationshipFilter.setOptions(relationshipOptions);
    }
  }

  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg || '';
    status.classList.toggle('network-crm__status--err', Boolean(isErr));
  }

  function kindsLabel(c) {
    const kinds = Array.isArray(c.kinds) ? c.kinds : [];
    const base = kinds.length ? kinds.join(' + ') : 'friend';
    if (!c.hasKids) return base;
    const ages = normalizeKidsBirthYears(c.kidsBirthYears)
      .map((y) => ageFromBirthYear(y))
      .filter((a) => a != null);
    if (ages.length) return `${base} · kids ${ages.join(', ')}`;
    return `${base} · have kids`;
  }

  /** @type {string} */
  let locationOptionsKey = '';

  /**
   * Unique contact locations for the Location multi-select (California first, then A→Z).
   * @param {object[]} [list]
   * @returns {string[]}
   */
  function refreshLocationFilterOptions() {
    const opts = collectContactLocationOptions(contacts);
    const key = opts.join('\0');
    if (key === locationOptionsKey) return;
    locationOptionsKey = key;
    locationFilter.setOptions(opts);
    locationFilter.setSelected(peopleFilters.locations);
  }

  function filteredByPeopleFilters(list = contacts) {
    return list.filter((c) => {
      // New Telegram intakes stay visible until reviewed, regardless of filters.
      if (c.intakeReviewed === false) return true;
      if (peopleFilters.kinds.length) {
        const kinds = Array.isArray(c.kinds) ? c.kinds.map((k) => String(k).toLowerCase()) : [];
        const want = peopleFilters.kinds.map((k) => k.toLowerCase());
        if (!want.some((k) => kinds.includes(k))) return false;
      }
      if (peopleFilters.hasTasks.length === 1) {
        const hasOpen = Array.isArray(c.tasks)
          ? c.tasks.some((t) => t && !t.done && String(t.text || '').trim())
          : Boolean(String(c.nextStep || '').trim());
        if (peopleFilters.hasTasks[0] === 'yes' && !hasOpen) return false;
        if (peopleFilters.hasTasks[0] === 'no' && hasOpen) return false;
      }
      if (peopleFilters.relationships.length) {
        if (!peopleFilters.relationships.includes(String(c.relationshipStatus || ''))) return false;
      } else {
        const rel = String(c.relationshipStatus || '');
        if (peopleFilters.hidePaused && rel === 'Paused') return false;
        if (peopleFilters.hideFormer && rel === 'Former') return false;
      }
      if (peopleFilters.statuses.length) {
        if (!peopleFilters.statuses.includes(String(c.rating || ''))) return false;
      }
      if (peopleFilters.locations.length) {
        const loc = String(c.location || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        const want = new Set(peopleFilters.locations.map((l) => l.toLowerCase()));
        if (!want.has(loc)) return false;
      }
      if (peopleFilters.regions?.length) {
        const region = contactRegionAttribute(c);
        if (!peopleFilters.regions.includes(region)) return false;
      }
      return true;
    });
  }

  function filtered() {
    const q = query.trim().toLowerCase();
    const items = filteredByPeopleFilters().filter((c) => {
      if (c.intakeReviewed === false) return true;
      if (!q) return true;
      const hay = [
        c.displayName,
        c.firstName,
        c.lastName,
        c.nickname,
        c.memoryJog,
        ...(c.aliases || []),
        ...(c.kinds || []),
        c.hasKids ? 'have kids kids' : '',
        ...(Array.isArray(c.tasks) ? c.tasks.map((t) => t?.text || '') : []),
        c.nextStep,
        ...(c.alignedActivities || []),
        ...(c.preferredContactMethods || []),
        c.summary,
        c.howWeMet,
        c.networkCircles,
        c.org,
        c.title,
        c.department,
        c.bio,
        c.notes,
        c.relationshipStatus,
        c.rating,
        c.sensitivity,
        c.location,
        c.address,
        formatContactBirthday(c),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
    // Pin new Telegram intakes first, then enrich-needs-review, then A→Z.
    return items.sort((a, b) => {
      const aNew = a.intakeReviewed === false;
      const bNew = b.intakeReviewed === false;
      if (aNew !== bNew) return aNew ? -1 : 1;
      if (aNew) {
        const aAt = String(a.createdAt || '');
        const bAt = String(b.createdAt || '');
        if (aAt !== bAt) return bAt.localeCompare(aAt);
      }
      const aReview = Boolean(a.enrichment?.needsReview);
      const bReview = Boolean(b.enrichment?.needsReview);
      if (aReview !== bReview) return aReview ? -1 : 1;
      if (aReview) {
        const aAt = String(a.enrichment?.enrichedAt || '');
        const bAt = String(b.enrichment?.enrichedAt || '');
        if (aAt !== bAt) return bAt.localeCompare(aAt);
      }
      return compareContactSearchNameRank(a, b, q);
    });
  }

  /**
   * Company is listed only when at least one contact is linked (orgId or matching org name).
   * @param {object} o
   */
  function orgHasLinkedPeople(o) {
    if (!o?.id && !o?.name) return false;
    const nameKey = String(o.name || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    return contacts.some((c) => {
      if (o.id && c.orgId === o.id) return true;
      if (
        nameKey &&
        String(c.org || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase() === nameKey
      ) {
        return true;
      }
      return false;
    });
  }

  function orgsWithPeople() {
    return organizations.filter((o) => orgHasLinkedPeople(o));
  }

  function filteredOrgs() {
    const withPeople = orgsWithPeople();
    const q = query.trim().toLowerCase();
    if (!q) return withPeople;
    return withPeople.filter((o) => {
      const hay = [o.name, ...(o.aliases || []), o.summary, o.description, o.location, o.website]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function orgName(idOrName) {
    if (!idOrName) return '';
    const byId = organizations.find((o) => o.id === idOrName);
    if (byId) return byId.name;
    return String(idOrName);
  }

  function avatarEl(contact, className) {
    const box = document.createElement('div');
    box.className = className;
    const isMatt =
      String(contact?.id || '') === '783'
      || /carney/i.test(String(contact?.displayName || ''))
      || /carney/i.test(`${contact?.firstName || ''} ${contact?.lastName || ''}`);
    if (contact.avatarUrl) {
      const img = document.createElement('img');
      const src = `${contact.avatarUrl}${contact.avatarUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(contact.updatedAt || '')}`;
      img.src = src;
      img.alt = '';
      img.width = 48;
      img.height = 48;
      // #region agent log
      if (isMatt) {
        const dbg = (hypothesisId, location, message, data) => {
          const body = JSON.stringify({
            sessionId: 'ee36d3',
            runId: 'pre-fix',
            hypothesisId,
            location,
            message,
            data,
            timestamp: Date.now(),
          });
          fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'ee36d3' },
            body,
          }).catch(() => {});
          fetch('/api/dev-agent-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          }).catch(() => {});
        };
        dbg('A', 'network-ui.js:avatarEl', 'Matt avatarEl with avatarUrl', {
          id: contact.id,
          displayName: contact.displayName || null,
          avatarUrl: contact.avatarUrl,
          src,
          className,
        });
        img.addEventListener('load', () => {
          dbg('B', 'network-ui.js:avatarEl img load', 'Matt avatar image loaded', {
            id: contact.id,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            src: img.currentSrc || img.src,
          });
        });
        img.addEventListener('error', () => {
          dbg('B', 'network-ui.js:avatarEl img error', 'Matt avatar image failed to load', {
            id: contact.id,
            src: img.src,
          });
        });
      }
      // #endregion
      box.append(img);
    } else {
      const first = String(contact.firstName || '').trim();
      const last = String(contact.lastName || '').trim();
      const initials = first || last
        ? `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
        : String(contact.displayName || '?')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map((p, i, arr) => (i === 0 || i === arr.length - 1 ? p[0] || '' : ''))
            .join('')
            .toUpperCase()
            .slice(0, 2);
      box.textContent = initials || '?';
      // #region agent log
      if (isMatt) {
        const body = JSON.stringify({
          sessionId: 'ee36d3',
          runId: 'pre-fix',
          hypothesisId: 'A',
          location: 'network-ui.js:avatarEl',
          message: 'Matt avatarEl FALLBACK initials (no avatarUrl)',
          data: {
            id: contact.id,
            displayName: contact.displayName || null,
            initials: box.textContent,
            className,
          },
          timestamp: Date.now(),
        });
        fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'ee36d3' },
          body,
        }).catch(() => {});
        fetch('/api/dev-agent-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).catch(() => {});
      }
      // #endregion
    }
    return box;
  }

  function logoEl(org, className) {
    const box = document.createElement('div');
    box.className = className;
    if (org.logoUrl) {
      const img = document.createElement('img');
      img.src = `${org.logoUrl}${org.logoUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(org.updatedAt || '')}`;
      img.alt = '';
      img.width = 48;
      img.height = 48;
      box.append(img);
    } else {
      const initials = String(org.name || '?')
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0] || '')
        .join('')
        .toUpperCase();
      box.textContent = initials || '?';
    }
    return box;
  }

  /**
   * Image-candidate picker in a pop-out dialog. Skips broken previews.
   * When `querySearch` is true (logos + people photos), a top text box drives image search.
   * One Search button: same query with more results continues; otherwise starts fresh.
   * @param {{
   *   candidatesUrl: string,
   *   applyUrl: string,
   *   buttonLabel?: string,
   *   emptyLabel?: string,
   *   dialogTitle?: string,
   *   queryPlaceholder?: string,
   *   queryAriaLabel?: string,
   *   querySearch?: boolean,
   *   defaultQuery?: string | (() => string),
   *   uploadUrl?: string,
   *   clear?: { url: string, body: object, label?: string, previewUrl?: string } | null,
   *   onApplied: (entity: object) => void,
   * }} opts
   */
  function mountImageCandidatePicker(opts) {
    const wrap = document.createElement('div');
    wrap.className = 'network-crm__img-pick';

    const findBtn = document.createElement('button');
    findBtn.type = 'button';
    findBtn.className = 'network-crm__btn network-crm__btn--tiny';
    findBtn.textContent = opts.buttonLabel || 'Find other photos';

    const querySearch = Boolean(opts.querySearch);
    const uploadUrl = String(opts.uploadUrl || '').trim();
    const clearOpts =
      opts.clear && typeof opts.clear === 'object' && String(opts.clear.url || '').trim()
        ? {
            url: String(opts.clear.url).trim(),
            body: opts.clear.body && typeof opts.clear.body === 'object' ? opts.clear.body : {},
            label: String(opts.clear.label || 'Remove current image').trim() || 'Remove current image',
            previewUrl: String(opts.clear.previewUrl || '').trim(),
          }
        : null;

    /** @type {number} */
    let nextOffset = 0;
    /** @type {boolean} */
    let hasMore = false;
    /** @type {string} */
    let activeQuery = '';
    /** @type {Set<string>} */
    const shownUrls = new Set();
    /** @type {HTMLElement | null} */
    let backdrop = null;

    function closeDialog() {
      if (backdrop) {
        backdrop.remove();
        backdrop = null;
      }
      document.removeEventListener('keydown', onKeydown);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') closeDialog();
    }

    function resolveDefaultQuery() {
      if (typeof opts.defaultQuery === 'function') return String(opts.defaultQuery() || '').trim();
      return String(opts.defaultQuery || '').trim();
    }

    /**
     * @param {HTMLElement} grid
     * @param {{ url?: string, thumbUrl?: string | null, pageUrl?: string | null }[]} candidates
     * @param {{ append?: boolean }} [mode]
     */
    function renderCandidates(grid, candidates, mode = {}) {
      if (!mode.append) {
        grid.replaceChildren();
        shownUrls.clear();
      }
      let added = 0;
      for (const cand of candidates) {
        const url = String(cand?.url || '').trim();
        if (!url || shownUrls.has(url)) continue;
        shownUrls.add(url);
        const thumb = String(cand?.thumbUrl || url).trim();
        const pageUrl = String(cand?.pageUrl || '').trim();
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'network-crm__img-pick-item';
        btn.title = 'Use this image';
        btn.hidden = true;
        const img = document.createElement('img');
        img.alt = '';
        // Eager: items start hidden; lazy often never fires for hidden imgs.
        img.loading = 'eager';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        let triedFull = thumb === url;
        img.addEventListener('error', () => {
          if (!triedFull && url) {
            triedFull = true;
            img.src = url;
            return;
          }
          btn.remove();
          shownUrls.delete(url);
          if (!grid.querySelector('.network-crm__img-pick-item')) {
            const empty = document.createElement('p');
            empty.className = 'muted network-crm__img-pick-hint';
            empty.dataset.empty = '1';
            empty.textContent = opts.emptyLabel || 'No previewable images found';
            grid.append(empty);
          }
        });
        img.addEventListener('load', () => {
          grid.querySelector('[data-empty="1"]')?.remove();
          btn.hidden = false;
        });
        img.src = thumb;
        btn.append(img);
        btn.addEventListener('click', async () => {
          if (btn.hidden || btn.disabled) return;
          btn.disabled = true;
          findBtn.disabled = true;
          showStatus('Saving image…');
          try {
            const body = { url };
            if (pageUrl && /^https?:\/\//i.test(pageUrl)) body.pageUrl = pageUrl;
            const ar = await fetch(opts.applyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const aj = await ar.json();
            if (!aj.ok) throw new Error(aj.error || 'apply_failed');
            closeDialog();
            showStatus('Image updated');
            opts.onApplied(aj.contact || aj.organization);
          } catch (err) {
            showStatus(String(err?.message || err), true);
            btn.disabled = false;
            findBtn.disabled = false;
          }
        });
        grid.append(btn);
        added += 1;
      }
      return added;
    }

    /**
     * One Search control: same query + hasMore → append; otherwise fresh search.
     * @param {{ reset?: boolean }} [fetchOpts]
     */
    async function loadCandidates(fetchOpts = {}) {
      if (!backdrop) return;
      const grid = backdrop.querySelector('.network-crm__img-pick-grid');
      const queryInput = backdrop.querySelector('.network-crm__img-pick-query');
      const searchBtn = backdrop.querySelector('.network-crm__img-pick-search');
      if (!grid || !searchBtn) return;

      const query = querySearch ? String(queryInput?.value || '').trim().slice(0, 160) : '';
      if (querySearch && !query) {
        showStatus('Enter text to search', true);
        queryInput?.focus();
        return;
      }

      let reset = Boolean(fetchOpts.reset);
      if (fetchOpts.reset == null) {
        // Button click / Enter: continue when query unchanged and more pages exist.
        reset = !(hasMore && query === activeQuery && nextOffset > 0);
      }
      if (reset) {
        nextOffset = 0;
        hasMore = false;
        activeQuery = query;
        shownUrls.clear();
        grid.replaceChildren();
      }

      searchBtn.disabled = true;
      if (queryInput) queryInput.disabled = true;
      findBtn.disabled = true;
      const loading = document.createElement('p');
      loading.className = 'muted network-crm__img-pick-hint';
      loading.dataset.loading = '1';
      loading.textContent = reset
        ? query
          ? `Searching “${query}”…`
          : 'Looking up images…'
        : 'Searching further…';
      grid.append(loading);
      showStatus(reset ? 'Finding images…' : 'Searching further…');

      try {
        const r = await fetch(opts.candidatesUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: nextOffset,
            limit: 5,
            ...(query ? { query } : {}),
          }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'candidates_failed');
        grid.querySelector('[data-loading="1"]')?.remove();

        const candidates = Array.isArray(j.candidates) ? j.candidates : [];
        nextOffset = Number(j.nextOffset) >= 0 ? Number(j.nextOffset) : nextOffset + candidates.length;
        hasMore = Boolean(j.hasMore);
        activeQuery = query;

        const added = renderCandidates(grid, candidates, { append: !reset });
        if (!grid.querySelector('.network-crm__img-pick-item') && !candidates.length) {
          const empty = document.createElement('p');
          empty.className = 'muted network-crm__img-pick-hint';
          empty.dataset.empty = '1';
          empty.textContent = opts.emptyLabel || 'No images found';
          grid.replaceChildren(empty);
          showStatus('No images found', true);
        } else {
          showStatus(added ? `Loaded ${added} image${added === 1 ? '' : 's'}` : 'No new images');
        }
        searchBtn.textContent = hasMore ? 'Search further' : 'Search';
      } catch (err) {
        grid.querySelector('[data-loading="1"]')?.remove();
        if (!grid.querySelector('.network-crm__img-pick-item')) {
          const empty = document.createElement('p');
          empty.className = 'muted network-crm__img-pick-hint';
          empty.textContent = 'Search failed';
          grid.replaceChildren(empty);
        }
        showStatus(String(err?.message || err), true);
        searchBtn.textContent = hasMore ? 'Search further' : 'Search';
      } finally {
        findBtn.disabled = false;
        searchBtn.disabled = false;
        if (queryInput) queryInput.disabled = false;
      }
    }

    function openDialog() {
      closeDialog();
      nextOffset = 0;
      hasMore = false;
      activeQuery = '';
      shownUrls.clear();
      backdrop = document.createElement('div');
      backdrop.className = 'network-crm__img-pick-backdrop';
      backdrop.setAttribute('role', 'presentation');

      const dialog = document.createElement('div');
      dialog.className = 'network-crm__img-pick-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', opts.dialogTitle || 'Pick an image');

      const header = document.createElement('div');
      header.className = 'network-crm__img-pick-dialog-header';
      const title = document.createElement('h3');
      title.className = 'network-crm__img-pick-dialog-title';
      title.textContent = opts.dialogTitle || 'Pick an image';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'network-crm__btn network-crm__btn--tiny';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', () => closeDialog());
      header.append(title, closeBtn);

      const grid = document.createElement('div');
      grid.className = 'network-crm__img-pick-grid';

      /** @type {HTMLElement[]} */
      const dialogParts = [header];

      if (clearOpts) {
        const currentBlock = document.createElement('div');
        currentBlock.className = 'network-crm__img-pick-current';
        const currentLabel = document.createElement('p');
        currentLabel.className = 'network-crm__img-pick-hint muted';
        currentLabel.textContent = 'Current';
        const frame = document.createElement('div');
        frame.className = 'network-crm__img-pick-current-frame';
        if (clearOpts.previewUrl) {
          const img = document.createElement('img');
          img.src = clearOpts.previewUrl;
          img.alt = '';
          img.referrerPolicy = 'no-referrer';
          frame.append(img);
        } else {
          const placeholder = document.createElement('div');
          placeholder.className = 'network-crm__img-pick-current-placeholder';
          placeholder.textContent = '—';
          frame.append(placeholder);
        }
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'network-crm__img-pick-current-clear';
        removeBtn.title = clearOpts.label;
        removeBtn.setAttribute('aria-label', clearOpts.label);
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', async () => {
          removeBtn.disabled = true;
          findBtn.disabled = true;
          showStatus('Removing image…');
          try {
            const r = await fetch(clearOpts.url, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(clearOpts.body),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'remove_failed');
            closeDialog();
            showStatus('Image removed');
            opts.onApplied(j.contact || j.organization);
          } catch (err) {
            showStatus(String(err?.message || err), true);
            removeBtn.disabled = false;
            findBtn.disabled = false;
          }
        });
        frame.append(removeBtn);
        currentBlock.append(currentLabel, frame);
        dialogParts.push(currentBlock);
      }

      dialogParts.push(grid);

      const actions = document.createElement('div');
      actions.className = 'network-crm__img-pick-dialog-actions';

      const searchBtn = document.createElement('button');
      searchBtn.type = 'button';
      searchBtn.className =
        'network-crm__btn network-crm__btn--primary network-crm__btn--tiny network-crm__img-pick-search';
      searchBtn.textContent = 'Search';
      searchBtn.addEventListener('click', () => {
        void loadCandidates({});
      });

      if (querySearch) {
        const queryInput = document.createElement('input');
        queryInput.type = 'search';
        queryInput.className = 'network-crm__img-pick-query';
        queryInput.placeholder = opts.queryPlaceholder || 'Type to search…';
        queryInput.autocomplete = 'off';
        queryInput.spellcheck = true;
        queryInput.setAttribute('aria-label', opts.queryAriaLabel || 'Search images');
        queryInput.value = resolveDefaultQuery();
        queryInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void loadCandidates({});
          }
        });
        queryInput.addEventListener('input', () => {
          const q = String(queryInput.value || '').trim().slice(0, 160);
          if (q !== activeQuery) searchBtn.textContent = 'Search';
          else if (hasMore) searchBtn.textContent = 'Search further';
        });
        actions.append(queryInput, searchBtn);
      } else {
        actions.append(searchBtn);
      }

      if (uploadUrl) {
        const uploadBtn = document.createElement('button');
        uploadBtn.type = 'button';
        uploadBtn.className = 'network-crm__btn network-crm__btn--tiny network-crm__img-pick-upload';
        uploadBtn.textContent = 'Upload';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.hidden = true;
        uploadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files?.[0];
          if (!file) return;
          uploadBtn.disabled = true;
          findBtn.disabled = true;
          showStatus('Uploading…');
          try {
            const dataUrl = await readFileAsDataUrl(file);
            const r = await fetch(uploadUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dataUrl }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'upload_failed');
            closeDialog();
            showStatus('Image updated');
            opts.onApplied(j.contact || j.organization);
          } catch (err) {
            showStatus(String(err?.message || err), true);
            uploadBtn.disabled = false;
            findBtn.disabled = false;
          } finally {
            fileInput.value = '';
          }
        });
        actions.append(uploadBtn, fileInput);
      }

      dialogParts.push(actions);
      dialog.append(...dialogParts);
      backdrop.append(dialog);
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeDialog();
      });
      document.body.append(backdrop);
      document.addEventListener('keydown', onKeydown);

      if (querySearch) {
        const queryInput = backdrop.querySelector('.network-crm__img-pick-query');
        queryInput?.focus();
        queryInput?.select();
      }
    }

    findBtn.addEventListener('click', () => openDialog());
    wrap.append(findBtn);
    return wrap;
  }

  function renderList() {
    if (view === 'companies') {
      list.replaceChildren();
      renderOrgList();
      syncWorkbenchToViewport();
      return;
    }
    if (peopleSubTab === 'manage') {
      ensureManageTable();
      manageTableApi?.render();
      return;
    }
    refreshLocationFilterOptions();
    list.replaceChildren();
    const items = filtered();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'network-crm__empty muted';
      empty.textContent = contacts.length ? 'No matches' : 'No people yet';
      list.append(empty);
      syncWorkbenchToViewport();
      return;
    }
    for (const c of items) {
      const li = document.createElement('li');
      li.className = 'network-crm__row';
      li.classList.toggle('network-crm__row--active', c.id === selectedId);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', c.id === selectedId ? 'true' : 'false');
      li.tabIndex = 0;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'network-crm__select';
      check.checked = selectedContactIds.has(c.id);
      check.title = 'Select';
      check.addEventListener('click', (e) => e.stopPropagation());
      check.addEventListener('change', () => {
        if (check.checked) selectedContactIds.add(c.id);
        else selectedContactIds.delete(c.id);
        syncSelectionActions();
      });

      const av = avatarEl(c, 'network-crm__avatar');
      const avWrap = document.createElement('div');
      avWrap.className = 'network-crm__row-avatar';
      avWrap.append(av);
      if (c.intakeReviewed === false) {
        const badge = document.createElement('span');
        badge.className = 'network-crm__new-intake';
        badge.title = 'New from Telegram';
        badge.setAttribute('aria-label', 'New from Telegram');
        avWrap.append(badge);
      }
      if (c.enrichment?.needsReview) {
        const badge = document.createElement('span');
        badge.className = 'network-crm__enrich-review';
        badge.title = 'Last enrichment needs review';
        badge.setAttribute('aria-label', 'Last enrichment needs review');
        badge.innerHTML =
          '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 2.2c.55 0 1 .45 1 1v4.1a1 1 0 1 1-2 0V4.7c0-.55.45-1 1-1zm0 8.1a1.05 1.05 0 1 1 0-2.1 1.05 1.05 0 0 1 0 2.1z"/></svg>';
        avWrap.append(badge);
      }
      const meta = document.createElement('div');
      meta.className = 'network-crm__row-meta';
      const name = document.createElement('div');
      name.className = 'network-crm__row-name';
      const nameText = document.createElement('span');
      nameText.textContent = c.displayName || 'Untitled';
      name.append(nameText);
      if (c.nickname) {
        const nick = document.createElement('span');
        nick.className = 'network-crm__row-nick muted';
        nick.textContent = c.nickname;
        name.append(document.createTextNode(' '), nick);
      }
      const sub = document.createElement('div');
      sub.className = 'network-crm__row-sub muted';
      const bits = [kindsLabel(c), c.networkCircles].filter(Boolean);
      sub.textContent = bits.join(' · ');
      meta.append(name, sub);
      li.append(check, avWrap, meta);
      li.addEventListener('click', () => selectContact(c.id));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectContact(c.id);
        }
      });
      list.append(li);
    }
    syncWorkbenchToViewport();
  }

  function renderOrgList() {
    const items = filteredOrgs();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'network-crm__empty muted';
      const withPeople = orgsWithPeople();
      empty.textContent = query.trim()
        ? withPeople.length
          ? 'No matches'
          : 'No companies with people yet'
        : withPeople.length
          ? 'No matches'
          : organizations.length
            ? 'No companies with people yet'
            : 'No companies yet';
      list.append(empty);
      return;
    }
    for (const o of items) {
      const li = document.createElement('li');
      li.className = 'network-crm__row';
      li.classList.toggle('network-crm__row--active', o.id === selectedOrgId);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', o.id === selectedOrgId ? 'true' : 'false');
      li.tabIndex = 0;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'network-crm__select';
      check.checked = selectedOrgIds.has(o.id);
      check.title = 'Select';
      check.addEventListener('click', (e) => e.stopPropagation());
      check.addEventListener('change', () => {
        if (check.checked) selectedOrgIds.add(o.id);
        else selectedOrgIds.delete(o.id);
      });

      const icon = logoEl(o, 'network-crm__avatar');
      const meta = document.createElement('div');
      meta.className = 'network-crm__row-meta';
      const name = document.createElement('div');
      name.className = 'network-crm__row-name';
      name.textContent = o.name || 'Untitled company';
      const sub = document.createElement('div');
      sub.className = 'network-crm__row-sub muted';
      sub.textContent = [o.industry || o.type, o.location, o.website].filter(Boolean).join(' · ');
      meta.append(name, sub);
      li.append(check, icon, meta);
      li.addEventListener('click', () => openOrganization(o.id));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openOrganization(o.id);
        }
      });
      list.append(li);
    }
  }

  function confirmLeaveUnsaved() {
    if (!detailDirty) return true;
    return window.confirm('You have unsaved contact edits. Leave without saving?');
  }

  function hideManageDetail() {
    if (!confirmLeaveUnsaved()) return;
    manageDetailOpen = false;
    detailDirty = false;
    detailGeneration += 1;
    detail.replaceChildren();
    detail.innerHTML = '<p class="muted">Double-click a name for details · double-click other cells to edit</p>';
    syncPeopleSubView();
  }

  function hideGroupsContactDetail() {
    if (!groupsContactOpen) return;
    if (!confirmLeaveUnsaved()) return;
    groupsContactOpen = false;
    detailDirty = false;
    detailGeneration += 1;
    detail.replaceChildren();
    detail.innerHTML = '<p class="muted">Select a person</p>';
    groupsUiApi?.setDetailPaneHidden?.(false);
    syncTabs();
  }

  function acknowledgeEnrichNeedsReview(contactId, opts = {}) {
    const idx = contacts.findIndex((x) => x.id === contactId);
    if (idx < 0) return;
    const c = contacts[idx];
    if (!c?.enrichment?.needsReview) return;
    const enrichment = { ...c.enrichment, needsReview: false };
    contacts[idx] = { ...c, enrichment };
    if (!opts.skipRenderList) renderList();
    void fetch(`/api/network/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrichment: { needsReview: false } }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (j?.ok && j.contact) {
          const i = contacts.findIndex((x) => x.id === j.contact.id);
          if (i >= 0) contacts[i] = j.contact;
          if (opts.remount && selectedId === j.contact.id && !detailDirty) {
            renderDetail(j.contact);
          }
        }
      })
      .catch(() => {
        // Local clear already applied; next load restores until retry succeeds.
      });
  }

  /**
   * Clear the "new from Telegram" flag after the card is viewed or marked reviewed.
   * @param {string} contactId
   * @param {{ remount?: boolean, skipRenderList?: boolean }} [opts]
   */
  function acknowledgeIntakeReview(contactId, opts = {}) {
    const idx = contacts.findIndex((x) => x.id === contactId);
    if (idx < 0) return;
    const c = contacts[idx];
    if (c?.intakeReviewed !== false) return;
    contacts[idx] = { ...c, intakeReviewed: true };
    if (!opts.skipRenderList) renderList();
    void fetch(`/api/network/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intakeReviewed: true }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (j?.ok && j.contact) {
          const i = contacts.findIndex((x) => x.id === j.contact.id);
          if (i >= 0) contacts[i] = j.contact;
          if (opts.remount && selectedId === j.contact.id && !detailDirty) {
            renderDetail(j.contact);
          }
        }
      })
      .catch(() => {
        // Local clear already applied; next load restores until retry succeeds.
      });
  }

  /**
   * @param {string} id
   */
  function isViewingContactDetail(id) {
    if (view !== 'people' || selectedId !== id) return false;
    if (peopleSubTab === 'manage') return manageDetailOpen;
    if (peopleSubTab === 'groups') return groupsContactOpen;
    return peopleSubTab === 'contacts';
  }

  /**
   * @param {string} id
   * @param {{ force?: boolean, keepEnrichReview?: boolean }} [opts]
   */
  function selectContact(id, opts = {}) {
    const force = Boolean(opts.force);
    if (selectedId === id && !force) {
      // Already on this person — don't remount and wipe an in-progress edit.
      if (detailDirty) return;
      // Only skip remount when THIS contact's card is already showing (company/org
      // forms also use .network-crm__form — don't treat those as the contact card).
      const mounted = detail.querySelector('.network-crm__form[data-contact-id]');
      if (mounted && mounted.getAttribute('data-contact-id') === id) return;
    } else if (selectedId && selectedId !== id && !confirmLeaveUnsaved()) {
      return;
    }
    selectedId = id;
    detailDirty = false;
    const hadReview = Boolean(contacts.find((x) => x.id === id)?.enrichment?.needsReview);
    const hadNewIntake = contacts.find((x) => x.id === id)?.intakeReviewed === false;
    // Clear review badge when Jay opens/views the card (unless enrich just remounted it).
    if (hadReview && !opts.keepEnrichReview) {
      acknowledgeEnrichNeedsReview(id, { skipRenderList: true });
    }
    if (hadNewIntake) {
      acknowledgeIntakeReview(id, { skipRenderList: true });
    }
    const c = contacts.find((x) => x.id === id);
    renderList();
    if (!c) {
      detail.innerHTML = '<p class="muted">Person not found</p>';
      return;
    }
    renderDetail(c);
  }

  /**
   * Show a contact's detail card (works from Contacts, Manage, Companies, or Groups).
   * @param {string} id
   */
  async function openContactDetail(id) {
    if (!id) return;
    if (view === 'companies') {
      detailDirty = false;
      manageDetailOpen = false;
      groupsContactOpen = false;
      selectedId = id;
      await setView('people', { peopleSubTab: 'contacts' });
      // Force remount — company detail still had a form in the pane.
      selectContact(id, { force: true });
      return;
    }
    if (peopleSubTab === 'groups') {
      detailDirty = false;
      manageDetailOpen = false;
      groupsContactOpen = true;
      selectedId = id;
      syncTabs();
      selectContact(id, { force: true });
      return;
    }
    if (peopleSubTab === 'manage') {
      manageDetailOpen = true;
      syncPeopleSubView();
      selectContact(id, { force: true });
      return;
    }
    selectContact(id);
  }

  /**
   * @param {string} title
   * @param {HTMLElement[]} children
   */
  function section(title, children) {
    const sec = document.createElement('fieldset');
    sec.className = 'network-crm__section';
    const legend = document.createElement('legend');
    legend.textContent = title;
    sec.append(legend, ...children);
    return sec;
  }

  /**
   * @param {object} c
   */
  function renderDetail(c) {
    // Don't let an in-progress voice note apply to a different contact.
    if (voiceSession.contactId && voiceSession.contactId !== c.id) {
      hideVoiceBar();
    }
    const gen = ++detailGeneration;
    detailDirty = false;
    /** @type {object} */
    let current = c;
    detail.replaceChildren();

    // Kick off shared-email fetch immediately so results are ready when More attributes opens.
    /** @type {Promise<object> | null} */
    let sharedEmailsPrefetch = fetch(
      `/api/network/contacts/${encodeURIComponent(c.id)}/shared-emails?offset=0&limit=10`,
    )
      .then((r) => r.json().catch(() => ({ ok: false, error: 'bad_json' })))
      .catch((err) => ({ ok: false, error: String(err?.message || err || 'network') }));

    const head = document.createElement('div');
    head.className = 'network-crm__detail-head';

    if (peopleSubTab === 'manage') {
      const hideBtn = document.createElement('button');
      hideBtn.type = 'button';
      hideBtn.className = 'network-crm__detail-hide';
      hideBtn.setAttribute('aria-label', 'Hide details');
      hideBtn.title = 'Hide details';
      hideBtn.innerHTML =
        '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5.5 2.5 11 8l-5.5 5.5-.9-.9L9.2 8 4.6 3.4z"/></svg>';
      hideBtn.addEventListener('click', () => {
        hideManageDetail();
      });
      head.append(hideBtn);
    } else if (peopleSubTab === 'groups' && groupsContactOpen) {
      const hideBtn = document.createElement('button');
      hideBtn.type = 'button';
      hideBtn.className = 'network-crm__detail-hide';
      hideBtn.setAttribute('aria-label', 'Back to group');
      hideBtn.title = 'Back to group';
      hideBtn.innerHTML =
        '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5.5 2.5 11 8l-5.5 5.5-.9-.9L9.2 8 4.6 3.4z"/></svg>';
      hideBtn.addEventListener('click', () => {
        hideGroupsContactDetail();
      });
      head.append(hideBtn);
    }

    const avWrap = document.createElement('div');
    avWrap.className = 'network-crm__avatar-wrap';

    const avFrame = document.createElement('div');
    avFrame.className = 'network-crm__avatar-frame';
    avFrame.append(avatarEl(current, 'network-crm__avatar network-crm__avatar--lg'));
    avWrap.append(avFrame);

    const pickWrap = mountImageCandidatePicker({
      candidatesUrl: `/api/network/contacts/${encodeURIComponent(current.id)}/avatar-candidates`,
      applyUrl: `/api/network/contacts/${encodeURIComponent(current.id)}/avatar-from-url`,
      uploadUrl: `/api/network/contacts/${encodeURIComponent(current.id)}/avatar`,
      buttonLabel: 'Find other photos',
      dialogTitle: 'Pick a photo',
      emptyLabel: 'No photos found — try a different search or Upload',
      querySearch: true,
      queryPlaceholder: 'Type a name or search phrase…',
      queryAriaLabel: 'Search photos',
      defaultQuery: () => {
        const liveName = detail.querySelector('.network-crm__form [name="displayName"]');
        const name =
          String(liveName?.value || current.displayName || '').trim()
          || [
            String(current.firstName || '').trim(),
            String(current.lastName || '').trim(),
          ]
            .filter(Boolean)
            .join(' ');
        // First search always pairs name with LinkedIn so headshots rank ahead of random hits.
        return name ? `"${name}" linkedin` : '';
      },
      clear: current.avatarUrl
        ? {
            url: `/api/network/contacts/${encodeURIComponent(current.id)}`,
            body: { avatarUrl: null, avatarSourceUrl: null },
            label: 'Remove current photo',
            previewUrl: `${current.avatarUrl}${current.avatarUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(current.updatedAt || '')}`,
          }
        : null,
      onApplied: (entity) => {
        const idx = contacts.findIndex((x) => x.id === entity.id);
        if (idx >= 0) contacts[idx] = entity;
        renderList();
        renderDetail(entity);
      },
    });
    avWrap.append(pickWrap);
    head.append(avWrap);

    const titles = document.createElement('div');
    const h = document.createElement('h3');
    h.className = 'network-crm__detail-name';
    h.textContent = current.displayName || 'Untitled';
    if (current.nickname) {
      const nick = document.createElement('span');
      nick.className = 'network-crm__detail-nick muted';
      nick.textContent = current.nickname;
      h.append(document.createTextNode(' '), nick);
    }
    titles.append(h);
    head.append(titles);

    /** @type {HTMLElement[]} */
    const reviewBanners = [];
    if (current.intakeReviewed === false) {
      const intakeBanner = document.createElement('div');
      intakeBanner.className = 'network-crm__new-intake-banner';
      const reviewText = document.createElement('span');
      reviewText.textContent = 'New contact from Telegram';
      const reviewBtn = document.createElement('button');
      reviewBtn.type = 'button';
      reviewBtn.className = 'network-crm__btn';
      reviewBtn.textContent = 'Mark reviewed';
      reviewBtn.title = 'Clear the new badge (also clears when you Save)';
      reviewBtn.addEventListener('click', () => {
        acknowledgeIntakeReview(current.id, { remount: true });
      });
      intakeBanner.append(reviewText, reviewBtn);
      reviewBanners.push(intakeBanner);
    }
    if (current.enrichment?.needsReview) {
      const enrichBanner = document.createElement('div');
      enrichBanner.className = 'network-crm__enrich-review-banner';
      const reviewText = document.createElement('span');
      reviewText.textContent = 'Last enrichment needs review';
      const reviewBtn = document.createElement('button');
      reviewBtn.type = 'button';
      reviewBtn.className = 'network-crm__btn';
      reviewBtn.textContent = 'Mark reviewed';
      reviewBtn.title = 'Clear the review badge (also clears when you Save)';
      reviewBtn.addEventListener('click', () => {
        acknowledgeEnrichNeedsReview(current.id, { remount: true });
      });
      enrichBanner.append(reviewText, reviewBtn);
      reviewBanners.push(enrichBanner);
    }

    /** @type {HTMLElement[]} */
    const mergeBanners = [];
    const pendingMerges = (Array.isArray(current.mergeSuggestions) ? current.mergeSuggestions : []).filter(
      (s) => s && s.status === 'pending' && s.otherContactId,
    );
    for (const suggestion of pendingMerges) {
      const banner = document.createElement('div');
      banner.className = 'network-crm__merge-suggest-banner';
      const text = document.createElement('span');
      const otherName = String(suggestion.otherDisplayName || 'another contact').trim();
      text.textContent = `Suggested merge with ${otherName}`;
      const actions = document.createElement('div');
      actions.className = 'network-crm__merge-suggest-actions';
      const openOther = document.createElement('button');
      openOther.type = 'button';
      openOther.className = 'network-crm__btn network-crm__btn--tiny';
      openOther.textContent = 'Open other';
      openOther.addEventListener('click', () => {
        void openContactDetail(String(suggestion.otherContactId));
      });
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'network-crm__btn network-crm__btn--tiny network-crm__btn--primary';
      confirmBtn.textContent = 'Confirm merge';
      confirmBtn.addEventListener('click', async () => {
        if (!confirm(`Merge with ${otherName}? This keeps one contact and closes the suggest-merge task.`)) {
          return;
        }
        try {
          const r = await fetch(
            `/api/network/contacts/${encodeURIComponent(current.id)}/merge-suggestions/${encodeURIComponent(suggestion.id)}/confirm`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
          );
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'merge_failed');
          const survivor = j.contact;
          const dropId = j.mergedFromId;
          contacts = contacts.filter((x) => x.id !== dropId);
          const idx = contacts.findIndex((x) => x.id === survivor.id);
          if (idx >= 0) contacts[idx] = survivor;
          else contacts = [survivor, ...contacts];
          selectedIds.delete(String(dropId || ''));
          renderList();
          renderDetail(survivor);
          showStatus(`Merged with ${otherName}`);
        } catch (e) {
          showStatus(String(e?.message || e), true);
        }
      });
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'network-crm__btn network-crm__btn--tiny';
      dismissBtn.textContent = 'Keep separate';
      dismissBtn.addEventListener('click', async () => {
        try {
          const r = await fetch(
            `/api/network/contacts/${encodeURIComponent(current.id)}/merge-suggestions/${encodeURIComponent(suggestion.id)}/dismiss`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
          );
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'dismiss_failed');
          const saved = j.contact;
          const idx = contacts.findIndex((x) => x.id === saved.id);
          if (idx >= 0) contacts[idx] = saved;
          const otherIdx = contacts.findIndex((x) => x.id === suggestion.otherContactId);
          if (otherIdx >= 0) {
            // Refresh other side so its banner/task clears after reload.
            try {
              const or = await fetch(`/api/network/contacts/${encodeURIComponent(suggestion.otherContactId)}`);
              const oj = await or.json();
              if (oj.ok && oj.contact) contacts[otherIdx] = oj.contact;
            } catch {
              /* ignore */
            }
          }
          renderList();
          renderDetail(saved);
          showStatus('Kept separate — suggest-merge task closed');
        } catch (e) {
          showStatus(String(e?.message || e), true);
        }
      });
      actions.append(openOther, confirmBtn, dismissBtn);
      banner.append(text, actions);
      mergeBanners.push(banner);
    }

    const form = document.createElement('form');
    form.className = 'network-crm__form';
    form.id = `network-crm-contact-${String(current.id || 'new').replace(/[^a-zA-Z0-9_-]/g, '')}`;
    form.dataset.contactId = String(current.id || '');
    form.setAttribute('aria-label', 'Edit contact');

    /**
     * @param {string} label
     * @param {string} name
     * @param {string} value
     * @param {{ type?: string, rows?: number, options?: string[], readonly?: boolean }} [opts]
     */
    function field(label, name, value, opts = {}) {
      const wrapEl = document.createElement('label');
      wrapEl.className = 'network-crm__field';
      if (opts.rows) wrapEl.classList.add('network-crm__field--full');
      const span = document.createElement('span');
      span.textContent = label;
      let input;
      if (opts.options) {
        input = document.createElement('select');
        input.className = 'network-crm__input';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '—';
        input.append(blank);
        for (const opt of opts.options) {
          const el = document.createElement('option');
          el.value = opt;
          el.textContent = opt;
          if (String(value || '') === opt) el.selected = true;
          input.append(el);
        }
      } else if (opts.rows) {
        input = document.createElement('textarea');
        input.rows = opts.rows;
        input.value = value || '';
        input.className = 'network-crm__input';
      } else {
        input = document.createElement('input');
        input.type = opts.type || 'text';
        input.value = value || '';
        input.className = 'network-crm__input';
        if (opts.readonly) {
          input.readOnly = true;
          input.classList.add('network-crm__input--readonly');
        }
      }
      input.name = name;
      input.required = false;
      wrapEl.append(span, input);
      return wrapEl;
    }

    /**
     * Scene: chips for current tags + dropdown of known scenes / new scene.
     * @param {string} initialValue
     */
    function mountSceneField(initialValue) {
      const wrapEl = document.createElement('div');
      wrapEl.className = 'network-crm__field network-crm__scene-field';
      const span = document.createElement('span');
      span.textContent = 'Scene';
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'networkCircles';
      const chips = document.createElement('div');
      chips.className = 'network-crm__scene-chips';
      chips.setAttribute('aria-label', 'Selected scenes');
      const select = document.createElement('select');
      select.className = 'network-crm__input';
      select.setAttribute('aria-label', 'Add scene');

      /** @type {string[]} */
      let selected = splitSceneTokens(initialValue);

      function notifyChanged() {
        hidden.dispatchEvent(new Event('input', { bubbles: true }));
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function renderSceneUi() {
        chips.replaceChildren();
        for (const token of selected) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'network-crm__scene-chip';
          chip.title = `Remove ${token}`;
          const label = document.createElement('span');
          label.textContent = token;
          const x = document.createElement('span');
          x.className = 'network-crm__scene-chip-x';
          x.setAttribute('aria-hidden', 'true');
          x.textContent = '×';
          chip.append(label, x);
          chip.addEventListener('click', () => {
            selected = selected.filter((t) => t.toLowerCase() !== token.toLowerCase());
            renderSceneUi();
            notifyChanged();
          });
          chips.append(chip);
        }

        select.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = selected.length ? 'Add scene…' : 'Choose scene…';
        select.append(placeholder);

        const selectedKeys = new Set(selected.map((t) => t.toLowerCase()));
        const known = collectSceneOptions(contacts, selected);
        for (const opt of known) {
          if (selectedKeys.has(opt.toLowerCase())) continue;
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          select.append(o);
        }
        const addNew = document.createElement('option');
        addNew.value = '__new__';
        addNew.textContent = '＋ New scene…';
        select.append(addNew);
        select.value = '';
        hidden.value = joinSceneTokens(selected);
      }

      select.addEventListener('change', () => {
        const v = select.value;
        if (!v) return;
        if (v === '__new__') {
          const name = (prompt('New scene name?') || '').replace(/\s+/g, ' ').trim();
          select.value = '';
          if (!name) return;
          if (!selected.some((t) => t.toLowerCase() === name.toLowerCase())) {
            selected = [...selected, name];
          }
        } else if (!selected.some((t) => t.toLowerCase() === v.toLowerCase())) {
          selected = [...selected, v];
        }
        renderSceneUi();
        notifyChanged();
      });

      wrapEl.append(span, chips, select, hidden);
      renderSceneUi();
      return wrapEl;
    }

    const kindsBox = document.createElement('div');
    kindsBox.className = 'network-crm__checks network-crm__checks--field';
    const kindsLabelEl = document.createElement('span');
    kindsLabelEl.className = 'network-crm__checks-label';
    kindsLabelEl.textContent = 'Type';
    kindsBox.append(kindsLabelEl);
    const kinds = new Set(c.kinds || ['friend']);
    for (const k of ['friend', 'organizer', 'business', 'family']) {
      const lab = document.createElement('label');
      lab.className = 'network-crm__check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = `kind-${k}`;
      cb.value = k;
      cb.checked = kinds.has(k);
      lab.append(cb, document.createTextNode(` ${k[0].toUpperCase()}${k.slice(1)}`));
      kindsBox.append(lab);
    }

    const hasKidsBox = document.createElement('div');
    hasKidsBox.className = 'network-crm__checks network-crm__kids-field';
    const hasKidsLab = document.createElement('label');
    hasKidsLab.className = 'network-crm__check';
    const hasKidsCb = document.createElement('input');
    hasKidsCb.type = 'checkbox';
    hasKidsCb.name = 'hasKids';
    hasKidsCb.checked = Boolean(c.hasKids);
    hasKidsLab.append(hasKidsCb, document.createTextNode(' Have kids'));
    hasKidsBox.append(hasKidsLab);

    const kidsYearsWrap = document.createElement('div');
    kidsYearsWrap.className = 'network-crm__kids-years';
    kidsYearsWrap.hidden = !hasKidsCb.checked;
    const kidsYearsLabel = document.createElement('span');
    kidsYearsLabel.className = 'network-crm__checks-label';
    kidsYearsLabel.textContent = 'Kids born (year)';
    const kidsYearsList = document.createElement('div');
    kidsYearsList.className = 'network-crm__kids-years-list';
    kidsYearsList.setAttribute('aria-label', 'Kid birth years');
    /** @type {number[]} */
    let kidsBirthYearsDraft = normalizeKidsBirthYears(c.kidsBirthYears);

    function syncKidsYearsHidden() {
      kidsYearsWrap.hidden = !hasKidsCb.checked;
    }

    function renderKidsYears() {
      kidsYearsList.replaceChildren();
      for (let i = 0; i < kidsBirthYearsDraft.length; i += 1) {
        const year = kidsBirthYearsDraft[i];
        const row = document.createElement('div');
        row.className = 'network-crm__kids-year-row';

        const yearInput = document.createElement('input');
        yearInput.type = 'number';
        yearInput.className = 'network-crm__input network-crm__kids-year-input';
        yearInput.name = `kidsBirthYear-${i}`;
        yearInput.inputMode = 'numeric';
        yearInput.min = String(new Date().getFullYear() - 120);
        yearInput.max = String(new Date().getFullYear());
        yearInput.placeholder = 'YYYY';
        yearInput.value = year ? String(year) : '';
        yearInput.setAttribute('aria-label', `Kid ${i + 1} birth year`);

        const ageEl = document.createElement('span');
        ageEl.className = 'network-crm__kids-age muted';
        ageEl.textContent = formatKidAgeLabel(year) || '—';

        yearInput.addEventListener('input', () => {
          const next = Number(yearInput.value);
          kidsBirthYearsDraft[i] = Number.isFinite(next) ? next : 0;
          ageEl.textContent = formatKidAgeLabel(kidsBirthYearsDraft[i]) || '—';
          markDirty?.();
        });
        yearInput.addEventListener('change', () => {
          kidsBirthYearsDraft = normalizeKidsBirthYears(kidsBirthYearsDraft);
          renderKidsYears();
          markDirty?.();
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'network-crm__btn network-crm__btn--tiny';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => {
          kidsBirthYearsDraft = kidsBirthYearsDraft.filter((_, idx) => idx !== i);
          renderKidsYears();
          markDirty?.();
        });

        row.append(yearInput, ageEl, removeBtn);
        kidsYearsList.append(row);
      }
    }

    const addKidYearBtn = document.createElement('button');
    addKidYearBtn.type = 'button';
    addKidYearBtn.className = 'network-crm__btn network-crm__btn--tiny';
    addKidYearBtn.textContent = 'Add birth year';
    addKidYearBtn.addEventListener('click', () => {
      kidsBirthYearsDraft = [...kidsBirthYearsDraft, 0];
      renderKidsYears();
      const inputs = kidsYearsList.querySelectorAll('input[type="number"]');
      const last = inputs[inputs.length - 1];
      if (last instanceof HTMLInputElement) last.focus();
      markDirty?.();
    });

    hasKidsCb.addEventListener('change', () => {
      syncKidsYearsHidden();
      if (hasKidsCb.checked && !kidsBirthYearsDraft.length) {
        kidsBirthYearsDraft = [0];
        renderKidsYears();
      }
    });

    kidsYearsWrap.append(kidsYearsLabel, kidsYearsList, addKidYearBtn);
    hasKidsBox.append(kidsYearsWrap);
    renderKidsYears();
    hasKidsBox.getKidsBirthYears = () =>
      normalizeKidsBirthYears(
        [...kidsYearsList.querySelectorAll('input[type="number"]')].map((el) =>
          Number(/** @type {HTMLInputElement} */ (el).value),
        ),
      );

    const preferred = new Set(c.preferredContactMethods || []);

    /** @type {Record<string, HTMLElement>} */
    const channelFieldsByMethod = {
      phone: field('Phone', 'phone', c.channels?.phone || ''),
      office_phone: field('Office phone', 'officePhone', c.channels?.officePhone || ''),
      email: field('Email', 'email', c.channels?.email || '', { type: 'email' }),
      signal: field('Signal', 'signal', c.channels?.signal || ''),
      whatsapp: field('WhatsApp', 'whatsapp', c.channels?.whatsapp || ''),
      messenger: field('FB Messenger', 'messenger', c.channels?.messenger || '', {
        type: 'text',
      }),
      linkedin: field('LinkedIn', 'linkedin', c.channels?.linkedin || '', { type: 'url' }),
      other: field('Other', 'other', c.channels?.other || ''),
    };

    /**
     * Wrap a Signal/WhatsApp field with a "Same as phone" checkbox that copies
     * a filled phone (or other messaging) number into this blank field.
     * @param {'signal' | 'whatsapp'} targetName
     */
    function attachSameAsPhone(targetName) {
      const fieldEl = channelFieldsByMethod[targetName];
      if (!fieldEl) return;
      const stack = document.createElement('div');
      stack.className = 'network-crm__field-stack';
      fieldEl.replaceWith(stack);
      stack.append(fieldEl);
      channelFieldsByMethod[targetName] = stack;

      const same = document.createElement('label');
      same.className = 'network-crm__check network-crm__same-as-phone';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = `same-phone-${targetName}`;
      same.append(cb, document.createTextNode(' Same as phone'));
      cb.addEventListener('change', () => {
        if (!cb.checked) return;
        const target = /** @type {HTMLInputElement | null} */ (fieldEl.querySelector(`[name="${targetName}"]`));
        if (!target) return;
        if (String(target.value || '').trim()) {
          // Already filled — leave it; uncheck so the box matches state.
          cb.checked = false;
          return;
        }
        const phone = String(form.querySelector('[name="phone"]')?.value || '').trim();
        const otherName = targetName === 'signal' ? 'whatsapp' : 'signal';
        const other = String(form.querySelector(`[name="${otherName}"]`)?.value || '').trim();
        const num = phone || other;
        if (!num) {
          cb.checked = false;
          showStatus('Fill phone first', true);
          return;
        }
        target.value = num;
        target.dispatchEvent(new Event('input', { bubbles: true }));
      });
      stack.append(same);
    }
    attachSameAsPhone('signal');
    attachSameAsPhone('whatsapp');
    const contactUrls = [
      ...new Set([...(c.channels?.urls || []), ...(c.enrichment?.sources || [])].filter(Boolean)),
    ];
    const urlsField = field(
      'URLs (enrichment sources — one per line)',
      'urls',
      contactUrls.join('\n'),
      { rows: 3 },
    );

    const methodsBox = document.createElement('div');
    methodsBox.className = 'network-crm__checks network-crm__checks--wrap';

    /** @type {Map<string, HTMLInputElement>} */
    const prefChecks = new Map();

    function syncChannelFieldVisibility() {
      for (const [method, el] of Object.entries(channelFieldsByMethod)) {
        el.hidden = !prefChecks.get(method)?.checked;
      }
    }

    for (const m of methodOptions) {
      const lab = document.createElement('label');
      lab.className = 'network-crm__check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = `pref-${m}`;
      cb.value = m;
      cb.checked = preferred.has(m);
      prefChecks.set(m, cb);
      if (channelFieldsByMethod[m]) {
        cb.addEventListener('change', syncChannelFieldVisibility);
      }
      lab.append(cb, document.createTextNode(` ${METHOD_LABELS[m] || m}`));
      methodsBox.append(lab);
    }
    syncChannelFieldVisibility();

    const moreChannels = section('Preferred contact methods', [
      methodsBox,
      ...Object.values(channelFieldsByMethod),
    ]);

    const orgField = field(NETWORK_LABELS.organization, 'org', c.org || '');
    if (c.orgId) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'network-crm__link-btn';
      link.textContent = 'Open company page →';
      link.addEventListener('click', () => openOrganization(c.orgId));
      orgField.append(link);
    }
    // #region agent log
    if (/carney/i.test(String(c.displayName || '')) || /persona/i.test(String(c.org || ''))) {
      const body = JSON.stringify({
        sessionId: '3c9ec5',
        runId: 'pre-fix',
        hypothesisId: 'B',
        location: 'network-ui.js:renderDetail:orgField',
        message: 'contact detail org link state',
        data: {
          contactId: String(c.id || ''),
          displayName: c.displayName || null,
          org: c.org || null,
          orgId: c.orgId || null,
          hasOpenLink: Boolean(c.orgId),
          orgInCache: c.orgId
            ? organizations.some((x) => x.id === c.orgId)
            : false,
          orgNameMatchesCache: organizations.some(
            (x) =>
              String(x.name || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase()
              === String(c.org || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase(),
          ),
        },
        timestamp: Date.now(),
      });
      fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '3c9ec5' },
        body,
      }).catch(() => {});
      fetch('/api/dev-agent-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => {});
    }
    // #endregion

    const lastContactField = field(
      'Last contact',
      'lastContactAt',
      formatContactLastContact(c),
    );
    const lastContactInput = lastContactField.querySelector('input');
    if (lastContactInput) {
      lastContactInput.placeholder = 'e.g. yesterday, 4/5/26, last month';
    }
    if (c.lastContactChannel) {
      const hint = document.createElement('p');
      hint.className = 'network-crm__field-hint muted';
      hint.textContent = `via ${c.lastContactChannel}`;
      lastContactField.append(hint);
    }

    const birthdayField = field(
      'Birthday',
      'birthday',
      formatContactBirthday(c),
    );
    const birthdayInput = birthdayField.querySelector('input');
    if (birthdayInput) {
      birthdayInput.placeholder = 'e.g. March, March 15, 3/15';
    }

    // Autofilled "how we met" / relationship summary should be visible immediately.
    if (String(c.howWeMet || '').trim() || String(c.relationshipSummary || '').trim()) {
      contactAttrsExpanded = true;
    }

    const relationshipSummaryField = field(
      'Relationship summary',
      'relationshipSummary',
      c.relationshipSummary || '',
      { rows: 5 },
    );

    const sharedEmailsBlock = document.createElement('div');
    sharedEmailsBlock.className = 'network-crm__field network-crm__field--full network-crm__shared-emails';

    const sharedEmailsLabel = document.createElement('span');
    sharedEmailsLabel.textContent = 'Shared emails';

    const sharedEmailsStatus = document.createElement('p');
    sharedEmailsStatus.className = 'network-crm__field-hint muted';
    sharedEmailsStatus.textContent = 'Loading shared emails…';

    const sharedEmailsList = document.createElement('ul');
    sharedEmailsList.className = 'network-crm__shared-emails-list';
    sharedEmailsList.setAttribute('role', 'list');

    const sharedEmailsActions = document.createElement('div');
    sharedEmailsActions.className = 'network-crm__shared-emails-actions';

    const loadMoreEmailsBtn = document.createElement('button');
    loadMoreEmailsBtn.type = 'button';
    loadMoreEmailsBtn.className = 'network-crm__btn';
    loadMoreEmailsBtn.textContent = 'Show next 10';
    loadMoreEmailsBtn.hidden = true;

    const summarizeRelBtn = document.createElement('button');
    summarizeRelBtn.type = 'button';
    summarizeRelBtn.className = 'network-crm__btn';
    summarizeRelBtn.textContent = 'Summarize relationship';
    summarizeRelBtn.title = 'Draft a relationship summary from shared emails';

    sharedEmailsActions.append(loadMoreEmailsBtn, summarizeRelBtn);
    sharedEmailsBlock.append(
      sharedEmailsLabel,
      sharedEmailsStatus,
      sharedEmailsList,
      sharedEmailsActions,
    );

    /** @type {{ offset: number, loading: boolean, loaded: boolean, hasMore: boolean }} */
    const sharedEmailsState = { offset: 0, loading: false, loaded: false, hasMore: false };

    function formatEmailDate(raw) {
      const ms = Date.parse(String(raw || ''));
      if (!Number.isFinite(ms)) return String(raw || '').trim() || '—';
      try {
        return new Date(ms).toLocaleString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });
      } catch {
        return String(raw || '').trim() || '—';
      }
    }

    /**
     * @param {Array<{ id?: string, subject?: string, from?: string, to?: string, date?: string, snippet?: string, url?: string | null }>} messages
     * @param {{ append?: boolean }} [opts]
     */
    function renderSharedEmailRows(messages, opts = {}) {
      if (!opts.append) sharedEmailsList.replaceChildren();
      for (const m of messages || []) {
        const li = document.createElement('li');
        li.className = 'network-crm__shared-emails-item';

        const top = document.createElement('div');
        top.className = 'network-crm__shared-emails-item-top';

        const subjectText = String(m.subject || '(no subject)').trim() || '(no subject)';
        const href = String(m.url || '').trim();
        /** @type {HTMLElement} */
        let subj;
        if (href) {
          const a = document.createElement('a');
          a.className = 'network-crm__shared-emails-subject';
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = subjectText;
          a.title = 'Open in Gmail';
          subj = a;
        } else {
          const strong = document.createElement('strong');
          strong.className = 'network-crm__shared-emails-subject';
          strong.textContent = subjectText;
          subj = strong;
        }

        const when = document.createElement('time');
        when.className = 'network-crm__shared-emails-date muted';
        when.textContent = formatEmailDate(m.date);

        top.append(subj, when);

        const meta = document.createElement('div');
        meta.className = 'network-crm__shared-emails-meta muted';
        const from = String(m.from || '').trim();
        const to = String(m.to || '').trim();
        meta.textContent = [from ? `From ${from}` : '', to ? `To ${to}` : ''].filter(Boolean).join(' · ');

        const snip = document.createElement('p');
        snip.className = 'network-crm__shared-emails-snippet';
        snip.textContent = String(m.snippet || '').trim();

        li.append(top);
        if (meta.textContent) li.append(meta);
        if (snip.textContent) li.append(snip);
        sharedEmailsList.append(li);
      }
    }

    async function loadSharedEmails({ append = false } = {}) {
      if (gen !== detailGeneration) return;
      if (sharedEmailsState.loading) return;
      sharedEmailsState.loading = true;
      loadMoreEmailsBtn.disabled = true;
      sharedEmailsStatus.textContent = append ? 'Loading more…' : 'Loading shared emails…';
      try {
        const offset = append ? sharedEmailsState.offset : 0;
        /** @type {any} */
        let j;
        if (!append && sharedEmailsPrefetch) {
          j = await sharedEmailsPrefetch;
          sharedEmailsPrefetch = null;
        } else {
          const r = await fetch(
            `/api/network/contacts/${encodeURIComponent(current.id)}/shared-emails?offset=${offset}&limit=10`,
          );
          j = await r.json().catch(() => ({}));
        }
        if (gen !== detailGeneration) return;
        if (!j.ok) {
          const err = String(j.error || 'load_failed');
          const friendly =
            err === 'no_shared_emails'
              ? 'No shared emails found in connected Gmail.'
              : err === 'no_email_or_name'
                ? 'Add an email or name to search Gmail.'
                : err === 'gmail_search_failed'
                  ? `Gmail search failed${j.detail ? `: ${j.detail}` : ''}`
                  : `Could not load emails (${err})`;
          sharedEmailsStatus.textContent = friendly;
          if (!append) {
            sharedEmailsList.replaceChildren();
            sharedEmailsState.offset = 0;
            sharedEmailsState.hasMore = false;
          }
          loadMoreEmailsBtn.hidden = true;
          return;
        }
        const messages = Array.isArray(j.messages) ? j.messages : [];
        renderSharedEmailRows(messages, { append });
        sharedEmailsState.offset = offset + messages.length;
        sharedEmailsState.hasMore = Boolean(j.hasMore);
        sharedEmailsState.loaded = true;
        const shown = sharedEmailsList.children.length;
        sharedEmailsStatus.textContent = shown
          ? `Showing ${shown} recent email${shown === 1 ? '' : 's'}`
          : 'No shared emails found in connected Gmail.';
        loadMoreEmailsBtn.hidden = !sharedEmailsState.hasMore;
      } catch (err) {
        if (gen !== detailGeneration) return;
        sharedEmailsStatus.textContent = String(err?.message || err);
        loadMoreEmailsBtn.hidden = true;
      } finally {
        sharedEmailsState.loading = false;
        loadMoreEmailsBtn.disabled = !sharedEmailsState.hasMore;
      }
    }

    loadMoreEmailsBtn.addEventListener('click', () => {
      loadSharedEmails({ append: true });
    });

    summarizeRelBtn.addEventListener('click', async () => {
      if (gen !== detailGeneration) return;
      summarizeRelBtn.disabled = true;
      const prevLabel = summarizeRelBtn.textContent;
      summarizeRelBtn.textContent = 'Summarizing…';
      showStatus('Summarizing relationship from email…');
      try {
        const r = await fetch(
          `/api/network/contacts/${encodeURIComponent(current.id)}/relationship-summary`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ card: buildContactBody() }),
          },
        );
        const j = await r.json().catch(() => ({}));
        if (gen !== detailGeneration) return;
        if (!j.ok) {
          const err = String(j.error || 'summary_failed');
          const friendly =
            err === 'no_shared_emails'
              ? 'No shared emails to summarize'
              : err === 'openrouter_not_configured'
                ? 'OpenRouter not configured'
                : err === 'no_email_or_name'
                  ? 'Add an email or name first'
                  : `Summary failed (${err})`;
          showStatus(friendly, true);
          return;
        }
        const text = String(j.relationshipSummary || '').trim();
        const ta = relationshipSummaryField.querySelector('textarea');
        if (ta && text) {
          ta.value = text;
          markDirty();
        }
        const n = Number(j.emailCount) || 0;
        showStatus(
          n
            ? `Relationship summary from ${n} email${n === 1 ? '' : 's'} — Save to keep`
            : 'Relationship summary ready — Save to keep',
        );
        contactAttrsExpanded = true;
        attrsPanel.hidden = false;
        toggleAttrs.textContent = NETWORK_LABELS.hideHidden;
        toggleAttrs.setAttribute('aria-expanded', 'true');
      } catch (err) {
        showStatus(String(err?.message || err), true);
      } finally {
        summarizeRelBtn.disabled = false;
        summarizeRelBtn.textContent = prevLabel;
      }
    });

    const attrsPanel = document.createElement('div');
    attrsPanel.className = 'network-crm__attrs-panel';
    attrsPanel.hidden = !contactAttrsExpanded;
    attrsPanel.append(
      lastContactField,
      hasKidsBox,
      orgField,
      field('Role', 'title', c.title),
      field('Department', 'department', c.department || ''),
      field('Address', 'address', c.address || '', { rows: 2 }),
      field(NETWORK_LABELS.aliases, 'aliases', (c.aliases || []).join(', ')),
      urlsField,
      field('How we met', 'howWeMet', c.howWeMet || '', { rows: 3 }),
      field('Private Notes', 'notes', c.notes || '', { rows: 3 }),
      relationshipSummaryField,
      sharedEmailsBlock,
    );

    const enrichMeta = document.createElement('p');
    enrichMeta.className = 'network-crm__meta muted';
    const conf =
      typeof c.enrichment?.confidence === 'number'
        ? ` · confidence ${Math.round(c.enrichment.confidence * 100)}%`
        : '';
    const enriched = c.enrichment?.enrichedAt
      ? `Enriched ${formatNetworkTimestamp(c.enrichment.enrichedAt)}${conf}`
      : 'Not enriched yet';
    const created = c.createdAt ? ` · created ${formatNetworkTimestamp(c.createdAt)}` : '';
    const updated = c.updatedAt ? ` · updated ${formatNetworkTimestamp(c.updatedAt)}` : '';
    enrichMeta.textContent = `${enriched} · source: ${c.source || '—'}${created}${updated}`;
    attrsPanel.append(enrichMeta);

    const toggleAttrs = document.createElement('button');
    toggleAttrs.type = 'button';
    toggleAttrs.className = 'network-crm__btn network-crm__btn--attrs';
    toggleAttrs.textContent = contactAttrsExpanded
      ? NETWORK_LABELS.hideHidden
      : NETWORK_LABELS.showHidden;
    toggleAttrs.setAttribute('aria-expanded', contactAttrsExpanded ? 'true' : 'false');
    toggleAttrs.addEventListener('click', () => {
      contactAttrsExpanded = !contactAttrsExpanded;
      attrsPanel.hidden = !contactAttrsExpanded;
      toggleAttrs.textContent = contactAttrsExpanded
        ? NETWORK_LABELS.hideHidden
        : NETWORK_LABELS.showHidden;
      toggleAttrs.setAttribute('aria-expanded', contactAttrsExpanded ? 'true' : 'false');
      if (contactAttrsExpanded && !sharedEmailsState.loaded && !sharedEmailsState.loading) {
        loadSharedEmails();
      }
    });
    // Always start (or finish) the prefetch as soon as the card is open.
    loadSharedEmails();

    form.append(
      field('Name', 'displayName', c.displayName || ''),
      field('Nickname', 'nickname', c.nickname || ''),
      (() => {
        const row = document.createElement('div');
        row.className = 'network-crm__field-row';
        const jog = field('Memory jog', 'memoryJog', c.memoryJog || '');
        const input = jog.querySelector('input');
        if (input) {
          input.placeholder = '1–2 words to remember who';
          input.maxLength = 80;
          input.autocomplete = 'off';
        }
        row.append(
          jog,
          field(NETWORK_LABELS.location, 'location', c.location || ''),
          birthdayField,
        );
        return row;
      })(),
      (() => {
        const row = document.createElement('div');
        row.className = 'network-crm__field-row';
        row.append(
          field('Relationship', 'relationshipStatus', c.relationshipStatus || '', {
            options: relationshipOptions,
          }),
          field('Status', 'rating', c.rating || '', {
            options: ['Fan', 'Hot', 'Warm', 'Cold'],
          }),
          field('Sensitivity', 'sensitivity', c.sensitivity || '', {
            options: ['Down', 'Situational', 'Proper'],
          }),
        );
        return row;
      })(),
      (() => {
        const row = document.createElement('div');
        row.className = 'network-crm__field-row';
        row.append(kindsBox, mountSceneField(c.networkCircles || ''));
        return row;
      })(),
      (() => {
        /** @type {{ id: string, text: string, done: boolean, vikunjaTaskId?: string }[]} */
        let draftTasks = Array.isArray(c.tasks)
          ? c.tasks.map((t) => {
              /** @type {{ id: string, text: string, done: boolean, vikunjaTaskId?: string }} */
              const row = {
                id: String(t.id || `task_${Math.random().toString(36).slice(2, 10)}`),
                text: String(t.text || '').trim(),
                done: Boolean(t.done),
              };
              if (t.vikunjaTaskId) row.vikunjaTaskId = String(t.vikunjaTaskId);
              return row;
            }).filter((t) => t.text)
          : String(c.nextStep || '')
              .split(/\n+|;/)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((text) => ({
                id: `task_${Math.random().toString(36).slice(2, 10)}`,
                text,
                done: false,
              }));

        const wrap = document.createElement('div');
        wrap.className = 'network-crm__field network-crm__field--full network-crm__tasks';
        wrap.dataset.tasksField = '1';
        wrap.dataset.contactId = String(c.id || '');

        const label = document.createElement('span');
        label.textContent = 'Tasks';

        const addRow = document.createElement('div');
        addRow.className = 'network-crm__tasks-add';

        const addInput = document.createElement('input');
        addInput.type = 'text';
        addInput.className = 'network-crm__input network-crm__tasks-input';
        addInput.placeholder = 'Add a task…';
        addInput.autocomplete = 'off';
        addInput.maxLength = 500;
        addInput.setAttribute('aria-label', 'Add a task');

        addRow.append(addInput);

        const list = document.createElement('ul');
        list.className = 'network-crm__tasks-list';
        list.setAttribute('role', 'list');

        function renderTasks() {
          list.replaceChildren();
          for (const task of draftTasks) {
            const li = document.createElement('li');
            li.className = 'network-crm__tasks-item';
            if (task.done) li.classList.add('network-crm__tasks-item--done');
            li.dataset.id = task.id;

            const row = document.createElement('label');
            row.className = 'network-crm__tasks-row';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'network-crm__tasks-check';
            cb.checked = task.done;
            cb.addEventListener('change', () => {
              task.done = cb.checked;
              li.classList.toggle('network-crm__tasks-item--done', task.done);
              markDirty();
            });

            const text = document.createElement('span');
            text.className = 'network-crm__tasks-text';
            fillLinkifiedText(text, task.text);

            row.append(cb, text);
            li.append(row);
            list.append(li);
          }
        }

        function tryAddTask() {
          const text = String(addInput.value || '').trim();
          if (!text) return;
          draftTasks = [
            ...draftTasks,
            {
              id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              text,
              done: false,
            },
          ];
          addInput.value = '';
          renderTasks();
          markDirty();
        }

        addInput.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          e.stopPropagation();
          tryAddTask();
        });

        wrap.getTasks = () =>
          draftTasks
            .map((t) => {
              /** @type {{ id: string, text: string, done: boolean, vikunjaTaskId?: string }} */
              const row = {
                id: t.id,
                text: String(t.text || '').trim(),
                done: Boolean(t.done),
              };
              if (t.vikunjaTaskId) row.vikunjaTaskId = String(t.vikunjaTaskId);
              return row;
            })
            .filter((t) => t.text);

        wrap.applyRemoteTaskDone = (contactId, taskId, done) => {
          if (String(contactId) !== String(c.id || wrap.dataset.contactId || '')) return;
          const task = draftTasks.find((t) => t.id === taskId);
          if (!task) return;
          task.done = Boolean(done);
          renderTasks();
        };

        wrap.append(label, addRow, list);
        renderTasks();
        return wrap;
      })(),
      field(NETWORK_LABELS.activities, 'alignedActivities', (c.alignedActivities || []).join('\n'), {
        rows: 4,
        placeholder: NETWORK_LABELS.activitiesPlaceholder,
      }),
      moreChannels,
      field('Bio', 'bio', c.bio || '', { rows: 3 }),
      toggleAttrs,
      attrsPanel,
    );

    const actions = document.createElement('div');
    actions.className = 'network-crm__actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'network-crm__btn network-crm__btn--primary network-crm__detail-save';
    saveBtn.setAttribute('form', form.id);
    saveBtn.textContent = 'Save';
    saveBtn.title = 'Save changes (Ctrl/Cmd+S)';

    function syncSaveBtn() {
      saveBtn.textContent = detailDirty ? 'Save' : 'Saved';
      saveBtn.classList.toggle('network-crm__btn--unsaved', detailDirty);
      saveBtn.title = detailDirty
        ? 'Save changes (Ctrl/Cmd+S)'
        : 'All changes saved';
    }
    syncSaveBtn();
    head.append(saveBtn);

    const markDirty = () => {
      if (gen !== detailGeneration) return;
      detailDirty = true;
      syncSaveBtn();
    };
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);

    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'network-crm__btn';
    undoBtn.textContent = 'Undo';
    undoBtn.disabled = true;
    undoBtn.title = 'Undo last save or enrich (Ctrl+Z outside a field)';

    const enrichBtn = document.createElement('button');
    enrichBtn.type = 'button';
    enrichBtn.className = 'network-crm__btn';
    enrichBtn.textContent = 'Enrich';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'network-crm__btn network-crm__btn--danger';
    delBtn.textContent = 'Delete';

    actions.append(undoBtn, enrichBtn, delBtn);
    form.append(actions);

    /** @type {object[]} */
    let undoStack = contactUndoStacks.get(current.id);
    if (!undoStack) {
      undoStack = [];
      contactUndoStacks.set(current.id, undoStack);
    }

    function syncUndoBtn() {
      undoBtn.disabled = undoStack.length === 0;
      undoBtn.textContent = undoStack.length > 1 ? `Undo (${undoStack.length})` : 'Undo';
    }
    syncUndoBtn();

    function buildContactBody() {
      const fd = new FormData(form);
      const splitCsv = (v) =>
        String(v || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      const kindsSel = ['friend', 'organizer', 'business', 'family'].filter((k) => form.querySelector(`[name="kind-${k}"]`)?.checked);
      const prefs = methodOptions.filter((m) => form.querySelector(`[name="pref-${m}"]`)?.checked);
      const circles = String(fd.get('networkCircles') || '').trim();
      return {
        displayName: String(fd.get('displayName') || '').trim(),
        nickname: String(fd.get('nickname') || '').trim(),
        memoryJog: String(fd.get('memoryJog') || '').trim().slice(0, 80),
        title: String(fd.get('title') || '').trim(),
        org: String(fd.get('org') || '').trim(),
        kinds: kindsSel.length ? kindsSel : ['friend'],
        hasKids: Boolean(form.querySelector('[name="hasKids"]')?.checked),
        kidsBirthYears: (() => {
          const el = form.querySelector('.network-crm__kids-field');
          if (el && typeof el.getKidsBirthYears === 'function') return el.getKidsBirthYears();
          return Array.isArray(current.kidsBirthYears) ? current.kidsBirthYears : [];
        })(),
        location: String(fd.get('location') || '').trim(),
        address: String(fd.get('address') || '').trim(),
        relationshipStatus: String(fd.get('relationshipStatus') || '').trim(),
        aliases: splitCsv(fd.get('aliases')),
        department: String(fd.get('department') || '').trim(),
        rating: String(fd.get('rating') || '').trim(),
        sensitivity: String(fd.get('sensitivity') || '').trim(),
        tasks: (() => {
          const el = form.querySelector('[data-tasks-field]');
          if (el && typeof el.getTasks === 'function') return el.getTasks();
          return Array.isArray(current.tasks) ? current.tasks : [];
        })(),
        bio: String(fd.get('bio') || '').trim(),
        howWeMet: String(fd.get('howWeMet') || '').trim(),
        relationshipSummary: String(fd.get('relationshipSummary') || '').trim(),
        networkCircles: circles,
        notes: String(fd.get('notes') || '').trim(),
        alignedActivities: String(fd.get('alignedActivities') || '')
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean),
        preferredContactMethods: prefs,
        lastContactAt: String(fd.get('lastContactAt') || '').trim(),
        birthday: String(fd.get('birthday') || '').trim(),
        channels: {
          email: String(fd.get('email') ?? current.channels?.email ?? '').trim() || null,
          phone: String(fd.get('phone') ?? current.channels?.phone ?? '').trim() || null,
          officePhone:
            String(fd.get('officePhone') ?? current.channels?.officePhone ?? '').trim() || null,
          sms: current.channels?.sms || null,
          signal: String(fd.get('signal') ?? current.channels?.signal ?? '').trim() || null,
          whatsapp: String(fd.get('whatsapp') ?? current.channels?.whatsapp ?? '').trim() || null,
          telegram: current.channels?.telegram || null,
          messenger:
            String(fd.get('messenger') ?? current.channels?.messenger ?? '').trim() || null,
          linkedin: String(fd.get('linkedin') ?? current.channels?.linkedin ?? '').trim() || null,
          other: String(fd.get('other') ?? current.channels?.other ?? '').trim() || null,
          urls: String(fd.get('urls') ?? (current.channels?.urls || []).join('\n') ?? '')
            .split(/\n+/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      };
    }

    let saveInFlight = false;
    let dirtyWhileSaving = false;

    /**
     * @param {{ remount?: boolean, fromUndo?: boolean, bodyOverride?: object }} [opts]
     */
    async function persistContact(opts = {}) {
      if (gen !== detailGeneration) return;
      if (saveInFlight) {
        dirtyWhileSaving = true;
        return;
      }
      saveInFlight = true;
      showStatus(opts.fromUndo ? 'Undoing…' : 'Saving…');
      try {
        do {
          dirtyWhileSaving = false;
          const priorId = current.id;
          const priorBody = contactToPutBody(current);
          const body = opts.bodyOverride || buildContactBody();
          // Only consume bodyOverride once (follow-up dirty saves use the form).
          opts = { ...opts, bodyOverride: undefined };
          // Saving the card counts as reviewing autofilled enrichment.
          if (!opts.fromUndo && current.enrichment?.needsReview) {
            body.enrichment = {
              ...enrichmentToPutBody(current.enrichment),
              needsReview: false,
            };
          }
          if (!opts.fromUndo && current.intakeReviewed === false) {
            body.intakeReviewed = true;
          }
          const r = await fetch(`/api/network/contacts/${encodeURIComponent(priorId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'save_failed');
          if (gen !== detailGeneration) return;

          const saved = j.contact;
          const mergedAway = saved.id !== priorId;
          contacts = contacts.filter((x) => x.id !== priorId || x.id === saved.id);
          const idx = contacts.findIndex((x) => x.id === saved.id);
          if (idx >= 0) contacts[idx] = saved;
          else contacts.push(saved);
          selectedId = saved.id;

          if (!opts.fromUndo && !sameJson(priorBody, contactToPutBody(saved))) {
            undoStack.push(priorBody);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
            syncUndoBtn();
          }
          if (mergedAway && priorId !== saved.id) {
            contactUndoStacks.set(saved.id, undoStack);
            contactUndoStacks.delete(priorId);
          }

          current = saved;
          notifyContactTasksChanged();

          // Scene tag changes create/update community groups server-side — drop
          // stale Groups prefetch so the next Groups visit sees them.
          if (String(saved.networkCircles || '') !== String(priorBody.networkCircles || '')) {
            invalidateNetworkPrefetch();
            groupsCache = [];
          }

          // Org ensure/create only matters when the org name changed.
          if (String(body.org || '') !== String(priorBody.org || '')) {
            await loadOrganizations();
            if (gen !== detailGeneration) return;
          }

          if (mergedAway || opts.remount || opts.fromUndo) {
            showStatus(opts.fromUndo ? 'Undone' : mergedAway ? 'Saved (merged duplicate)' : 'Saved');
            renderList();
            if (!opts.fromUndo && peopleSubTab === 'manage') {
              detailDirty = false;
              hideManageDetail();
              return;
            }
            renderDetail(saved);
            return;
          }

          h.replaceChildren();
          h.append(document.createTextNode(saved.displayName || 'Untitled'));
          if (saved.nickname) {
            const nick = document.createElement('span');
            nick.className = 'network-crm__detail-nick muted';
            nick.textContent = saved.nickname;
            h.append(document.createTextNode(' '), nick);
          }
          const confSaved =
            typeof saved.enrichment?.confidence === 'number'
              ? ` · confidence ${Math.round(saved.enrichment.confidence * 100)}%`
              : '';
          const enrichedSaved = saved.enrichment?.enrichedAt
            ? `Enriched ${formatNetworkTimestamp(saved.enrichment.enrichedAt)}${confSaved}`
            : 'Not enriched yet';
          const createdSaved = saved.createdAt
            ? ` · created ${formatNetworkTimestamp(saved.createdAt)}`
            : '';
          const updatedSaved = saved.updatedAt
            ? ` · updated ${formatNetworkTimestamp(saved.updatedAt)}`
            : '';
          enrichMeta.textContent = `${enrichedSaved} · source: ${saved.source || '—'}${createdSaved}${updatedSaved}`;
          detailDirty = false;
          syncSaveBtn();
          showStatus('Saved');

          // Sidebar only shows name / nick / kinds / circles — skip full rebuild for notes etc.
          // Manage table shows many columns, so always refresh when that tab is open.
          const listLabelChanged =
            String(saved.displayName || '') !== String(priorBody.displayName || '')
            || String(saved.nickname || '') !== String(priorBody.nickname || '')
            || !sameJson(saved.kinds || [], priorBody.kinds || [])
            || Boolean(saved.hasKids) !== Boolean(priorBody.hasKids)
            || String(saved.networkCircles || '') !== String(priorBody.networkCircles || '')
            || !sameJson(saved.tasks || [], priorBody.tasks || []);
          if (listLabelChanged || peopleSubTab === 'manage') renderList();
        } while (dirtyWhileSaving && gen === detailGeneration);

        // Manage tab: collapse detail after a successful Save (keep open after Undo).
        if (
          !opts.fromUndo
          && peopleSubTab === 'manage'
          && gen === detailGeneration
        ) {
          hideManageDetail();
        }
      } catch (err) {
        if (gen === detailGeneration) showStatus(String(err?.message || err), true);
      } finally {
        saveInFlight = false;
      }
    }

    async function undoContact() {
      if (!undoStack.length) return;
      const snap = undoStack.pop();
      syncUndoBtn();
      await persistContact({ fromUndo: true, bodyOverride: snap, remount: true });
    }

    form.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void persistContact();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey || e.altKey) return;
      const t = /** @type {HTMLElement} */ (e.target);
      const tag = t?.tagName || '';
      // Inside fields: keep browser native undo for typing.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!undoStack.length) return;
      e.preventDefault();
      void undoContact();
    });

    undoBtn.addEventListener('click', () => {
      void undoContact();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await persistContact();
    });

    enrichBtn.addEventListener('click', () => {
      const enrichErr = (j) => {
        const err = String(j?.error || 'enrich_failed');
        if (err === 'enrich_timeout' || err.includes('TimeoutError') || err.includes('aborted')) {
          return 'Enrich timed out — try again, or add a LinkedIn / website URL first';
        }
        if (err.includes('openrouter_http_402')) {
          return 'OpenRouter needs credits (or a free model). Check API key / billing.';
        }
        if (err.includes('openrouter_http_429')) {
          return 'OpenRouter is rate-limited — try again in a minute';
        }
        if (err === 'openrouter_not_configured') return 'OpenRouter API key not configured';
        if (err === 'no_shared_emails') {
          return 'No shared emails found — add their email or connect Gmail in Settings';
        }
        if (err === 'no_email_or_name') return 'Add a name or email first';
        if (err === 'gmail_search_failed') return j.detail || 'Gmail search failed — check Gmail connection';
        if (err === 'unsupported_file_type') return 'Unsupported file type — try txt, html, vcard, or an image';
        return err;
      };

      const contactId = current.id;
      const card = buildContactBody();

      /**
       * @param {string} path
       * @param {object} body
       * @param {string} okMsg
       * @param {number} [timeoutMs]
       */
      async function postEnrich(path, body, okMsg, timeoutMs = 95_000) {
        const save = await fetch(`/api/network/contacts/${encodeURIComponent(contactId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(card),
        });
        const saved = await save.json();
        if (!saved.ok) throw new Error(saved.error || 'save_failed');
        const enrichId = saved.contact?.id || contactId;
        if (saved.contact) {
          const idx = contacts.findIndex((x) => x.id === contactId || x.id === saved.contact.id);
          if (idx >= 0) contacts[idx] = saved.contact;
          else contacts.push(saved.contact);
          selectedId = enrichId;
        }
        const enrichPath = path.includes(encodeURIComponent(contactId))
          ? path.replace(encodeURIComponent(contactId), encodeURIComponent(enrichId))
          : path;
        let r;
        try {
          r = await fetch(enrichPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          const name = String(e?.name || '');
          if (name === 'TimeoutError' || name === 'AbortError') {
            throw new Error(enrichErr({ error: 'enrich_timeout' }));
          }
          throw e;
        }
        const j = await r.json();
        // #region agent log
        fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '951c32' },
          body: JSON.stringify({
            sessionId: '951c32',
            runId: 'post-fix',
            hypothesisId: 'C',
            location: 'network-ui.js:postEnrich:response',
            message: 'enrich client response',
            data: {
              contactId: String(enrichId),
              path: enrichPath,
              httpOk: r.ok,
              status: r.status,
              ok: Boolean(j?.ok),
              error: j?.error || null,
              filled: Array.isArray(j?.filled) ? j.filled : null,
              filledCount: Array.isArray(j?.filled) ? j.filled.length : null,
              confidence: j?.contact?.enrichment?.confidence ?? null,
              sources: (j?.contact?.enrichment?.sources || []).slice(0, 6),
              displayName: j?.contact?.displayName || card?.displayName || null,
              pagesHint: (j?.contact?.enrichment?.sources || []).slice(0, 6),
            },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion
        if (!j.ok) throw new Error(enrichErr(j));
        const filledCount = Array.isArray(j.filled) ? j.filled.length : 0;
        const conf = Number(j?.contact?.enrichment?.confidence);
        const weak =
          filledCount === 0 ||
          (Number.isFinite(conf) && conf < 0.45 && filledCount <= 1);
        const statusMsg = weak
          ? `${okMsg} (little found — add full name or LinkedIn)`
          : okMsg;
        applyEnrichedContact(j.contact, statusMsg);
        return j;
      }

      openEnrichOptionsDialog({
        title: 'Enrich',
        modes: ['web', 'file', 'email', 'voice'],
        webPreviewTitle: 'Start web enrich?',
        getWebPreview: () => buildContactWebEnrichPreview(card, current),
        onWeb: async (selection) => {
          await postEnrich(
            `/api/network/contacts/${encodeURIComponent(contactId)}/enrich`,
            {
              card,
              searchQueries: Array.isArray(selection?.searchQueries)
                ? selection.searchQueries
                : undefined,
              fetchUrls: Array.isArray(selection?.fetchUrls) ? selection.fetchUrls : undefined,
            },
            'Enriched from web',
          );
        },
        onFile: async (file) => {
          const dataUrl = await readFileAsDataUrl(file);
          await postEnrich(
            `/api/network/contacts/${encodeURIComponent(contactId)}/enrich-from-file`,
            {
              card,
              dataUrl,
              filename: file.name,
              mimeType: file.type || undefined,
            },
            'Enriched from file',
          );
        },
        onEmail: async () => {
          const j = await postEnrich(
            `/api/network/contacts/${encodeURIComponent(contactId)}/enrich-from-email`,
            { card },
            'Enriched from email',
          );
          const n = Number(j.emailCount) || 0;
          if (n) showStatus(`Enriched from ${n} email${n === 1 ? '' : 's'}`);
        },
        onVoiceStart: async () => {
          await startVoiceEnrichOnScreen({
            contactId,
            card,
            onVoice: async (dataUrl, mimeType) => {
              await postEnrich(
                `/api/network/contacts/${encodeURIComponent(contactId)}/enrich-from-voice`,
                { card, dataUrl, mimeType },
                'Enriched from voice',
              );
            },
          });
        },
      });
    });

    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete ${current.displayName || 'this person'}?`)) return;
      try {
        // #region agent log
        fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7b26c0'},body:JSON.stringify({sessionId:'7b26c0',runId:'post-fix',hypothesisId:'H5',location:'network-ui.js:delBtn',message:'client delete start',data:{id:current.id,displayName:current.displayName||null,orgId:current.orgId||null,org:current.org||null,avatarUrl:current.avatarUrl||null},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        const r = await fetch(`/api/network/contacts/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
        const j = await r.json();
        // #region agent log
        fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7b26c0'},body:JSON.stringify({sessionId:'7b26c0',runId:'post-fix',hypothesisId:'H5',location:'network-ui.js:delBtn:response',message:'client delete response',data:{id:current.id,status:r.status,ok:j?.ok,deleted:j?.deleted,orgsDeleted:j?.orgsDeleted??null,foundationOptedOut:j?.foundationOptedOut||null,error:j?.error||null},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        if (!j.ok) throw new Error(j.error || 'delete_failed');
        contacts = contacts.filter((x) => x.id !== current.id);
        contactUndoStacks.delete(current.id);
        selectedId = contacts[0]?.id || null;
        showStatus('Deleted');
        renderList();
        if (selectedId) selectContact(selectedId);
        else detail.innerHTML = '<p class="muted">Select a person</p>';
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    });

    detail.append(head, ...reviewBanners, ...mergeBanners, form);

    // #region agent log
    (() => {
      const labelOf = (el) => String(el.querySelector?.('span')?.textContent || el.className || '').slice(0, 48);
      const topOrder = [...form.children].map((el, i) => {
        if (el.classList?.contains('network-crm__field-row')) {
          return {
            i,
            kind: 'row',
            kids: [...el.children].map((c) => labelOf(c)),
            tops: [...el.children].map((c) => Math.round(c.getBoundingClientRect().top)),
            lefts: [...el.children].map((c) => Math.round(c.getBoundingClientRect().left)),
          };
        }
        return { i, kind: 'field', label: labelOf(el) };
      });
      const birthdayInForm = Boolean(form.querySelector('[name="birthday"]'));
      const birthdayInAttrs = Boolean(
        form.querySelector('.network-crm__attrs-panel [name="birthday"]'),
      );
      const jog = form.querySelector('[name="memoryJog"]');
      const loc = form.querySelector('[name="location"]');
      const bday = form.querySelector('[name="birthday"]');
      const rel = form.querySelector('[name="relationshipStatus"]');
      const payload = {
        sessionId: 'e55622',
        runId: 'post-fix',
        hypothesisId: 'A',
        location: 'network-ui.js:contactDetailMount',
        message: 'contact form field order probe',
        data: {
          buildTag: 'birthday-row-2',
          peopleSubTab,
          birthdayInForm,
          birthdayInAttrs,
          jogParentRow: Boolean(jog?.closest('.network-crm__field-row')),
          locParentRow: Boolean(loc?.closest('.network-crm__field-row')),
          bdayParentRow: Boolean(bday?.closest('.network-crm__field-row')),
          relParentRow: Boolean(rel?.closest('.network-crm__field-row')),
          sameRowJogLocBday:
            jog && loc && bday
              ? jog.closest('.network-crm__field-row') === loc.closest('.network-crm__field-row')
                && loc.closest('.network-crm__field-row') === bday.closest('.network-crm__field-row')
              : false,
          sameRowRelStatusSens: (() => {
            const a = form.querySelector('[name="relationshipStatus"]');
            const b = form.querySelector('[name="rating"]');
            const c = form.querySelector('[name="sensitivity"]');
            if (!a || !b || !c) return false;
            const r = a.closest('.network-crm__field-row');
            return r && r === b.closest('.network-crm__field-row') && r === c.closest('.network-crm__field-row');
          })(),
          topOrder,
          styleHref: [...document.styleSheets].map((ss) => {
            try { return ss.href || '(inline)'; } catch { return '(inaccessible)'; }
          }).find((h) => String(h).includes('styles')) || null,
          scriptSrc: document.querySelector('script[src*="app.js"]')?.getAttribute('src') || null,
          href: String(location.href || ''),
        },
        timestamp: Date.now(),
      };
      fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e55622' },
        body: JSON.stringify(payload),
      }).catch(() => {});
      fetch('/api/dev-agent-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    })();
    // #endregion
  }

  /**
   * Close the enrich picker and run work on the Network screen.
   * Wait cursor only while the UI is not yet free to use; once work yields
   * (request in flight), restore the normal pointer so Jay can click around
   * without thinking enrichment will be interrupted.
   * @param {string} pendingMsg
   * @param {() => Promise<void>} work
   */
  function runEnrichInBackground(pendingMsg, work) {
    showStatus(pendingMsg);
    beginWaitCursor();
    void (async () => {
      let holdingCursor = true;
      const releaseCursor = () => {
        if (!holdingCursor) return;
        holdingCursor = false;
        endWaitCursor();
      };
      try {
        const pending = work();
        // If work hangs synchronously before its first await, we never reach
        // here and the wait cursor stays — correct for a blocked UI.
        queueMicrotask(releaseCursor);
        await pending;
      } catch (err) {
        showStatus(String(err?.message || err), true);
      } finally {
        releaseCursor();
      }
    })();
  }

  /**
   * Apply an enriched contact if still on People; always refresh the list row.
   * Snapshots the pre-enrich card onto the undo stack so Undo can revert a bad match.
   * @param {object} contact
   * @param {string} [okMsg]
   */
  function applyEnrichedContact(contact, okMsg) {
    if (!contact?.id) return;
    const prev = contacts.find((x) => x.id === contact.id);
    if (prev && !sameJson(contactToPutBody(prev), contactToPutBody(contact))) {
      pushUndoSnap(contactUndoStacks, contact.id, contactToPutBody(prev));
    }
    let next = contact;
    const viewing = isViewingContactDetail(contact.id);
    // Keep needsReview when enrich finishes off-screen. If Jay is already on the
    // card, leave the flag set so the list badge still appears until they leave
    // and re-open (or re-select) — then selectContact clears it.
    const idx = contacts.findIndex((x) => x.id === next.id);
    if (idx >= 0) contacts[idx] = next;
    else contacts.push(next);
    // #region agent log
    {
      const orgId = String(next.orgId || '');
      const body = JSON.stringify({
        sessionId: '3c9ec5',
        runId: 'pre-fix',
        hypothesisId: 'C',
        location: 'network-ui.js:applyEnrichedContact',
        message: 'enrich applied to contact cache',
        data: {
          contactId: String(next.id || ''),
          displayName: next.displayName || null,
          org: next.org || null,
          orgId: orgId || null,
          orgInOrganizationsCache: orgId
            ? organizations.some((x) => x.id === orgId)
            : false,
          orgNameInCache: organizations.some(
            (x) =>
              String(x.name || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase()
              === String(next.org || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase(),
          ),
          organizationsCacheCount: organizations.length,
        },
        timestamp: Date.now(),
      });
      fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '3c9ec5' },
        body,
      }).catch(() => {});
      fetch('/api/dev-agent-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => {});
    }
    // #endregion
    renderList();
    if (viewing) {
      // Already on the card when enrich landed — remount and clear the review badge.
      selectContact(next.id, { force: true });
    }
    if (okMsg) showStatus(`${okMsg} · Undo to revert`);
  }

  /**
   * @param {object} organization
   * @param {string} [okMsg]
   */
  function applyEnrichedOrganization(organization, okMsg) {
    if (!organization?.id) return;
    const prev = organizations.find((x) => x.id === organization.id);
    if (prev && !sameJson(orgToPutBody(prev), orgToPutBody(organization))) {
      pushUndoSnap(orgUndoStacks, organization.id, orgToPutBody(prev));
    }
    const idx = organizations.findIndex((x) => x.id === organization.id);
    if (idx >= 0) organizations[idx] = organization;
    else organizations.push(organization);
    renderList();
    if (view === 'companies' && selectedOrgId === organization.id) {
      openOrganization(organization.id);
    }
    if (okMsg) showStatus(`${okMsg} · Undo to revert`);
  }

  /** @type {{
   *   recorder: MediaRecorder | null,
   *   stream: MediaStream | null,
   *   chunks: Blob[],
   *   contactId: string | null,
   *   card: object | null,
   *   onVoice: ((dataUrl: string, mimeType: string) => Promise<void>) | null,
   * }} */
  const voiceSession = {
    recorder: null,
    stream: null,
    chunks: [],
    contactId: null,
    card: null,
    onVoice: null,
  };

  function stopVoiceSessionMic() {
    if (voiceSession.recorder && voiceSession.recorder.state !== 'inactive') {
      try {
        voiceSession.recorder.stop();
      } catch {
        // ignore
      }
    }
    voiceSession.recorder = null;
    if (voiceSession.stream) {
      for (const t of voiceSession.stream.getTracks()) t.stop();
      voiceSession.stream = null;
    }
  }

  function hideVoiceBar() {
    stopVoiceSessionMic();
    voiceBar.hidden = true;
    voiceSession.contactId = null;
    voiceSession.card = null;
    voiceSession.onVoice = null;
    voiceSession.chunks = [];
  }

  /**
   * Start mic on the Network screen (dialog already closed).
   * @param {{
   *   contactId: string,
   *   card: object,
   *   onVoice: (dataUrl: string, mimeType: string) => Promise<void>,
   * }} args
   */
  async function startVoiceEnrichOnScreen(args) {
    hideVoiceBar();
    voiceSession.contactId = args.contactId;
    voiceSession.card = args.card;
    voiceSession.onVoice = args.onVoice;
    voiceSession.chunks = [];
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone not available in this browser');
    }
    voiceSession.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
    voiceSession.recorder = mimeType
      ? new MediaRecorder(voiceSession.stream, { mimeType })
      : new MediaRecorder(voiceSession.stream);
    voiceSession.recorder.addEventListener('dataavailable', (e) => {
      if (e.data?.size) voiceSession.chunks.push(e.data);
    });
    voiceSession.recorder.start();
    const label = voiceBar.querySelector('.network-crm__voice-bar-label');
    if (label) label.textContent = 'Recording… talk freely, then Stop & enrich';
    voiceBar.hidden = false;
    showStatus('Recording voice note…');
  }

  voiceBar.querySelector('[data-voice-stop]')?.addEventListener('click', () => {
    const recorder = voiceSession.recorder;
    const onVoice = voiceSession.onVoice;
    if (!recorder || !onVoice) return;
    const stopBtn = /** @type {HTMLButtonElement | null} */ (voiceBar.querySelector('[data-voice-stop]'));
    if (stopBtn) stopBtn.disabled = true;
    const mimeType = recorder.mimeType || 'audio/webm';
    const chunks = voiceSession.chunks;
    runEnrichInBackground('Transcribing and enriching…', async () => {
      try {
        const blob = await new Promise((resolve, reject) => {
          recorder.addEventListener('stop', () => {
            resolve(new Blob(chunks, { type: mimeType }));
          });
          recorder.addEventListener('error', () => reject(new Error('record_failed')));
          try {
            recorder.stop();
          } catch (e) {
            reject(e);
          }
        });
        stopVoiceSessionMic();
        voiceBar.hidden = true;
        if (!blob.size) throw new Error('No audio captured');
        const dataUrl = await readFileAsDataUrl(blob);
        await onVoice(dataUrl, mimeType);
      } finally {
        hideVoiceBar();
        if (stopBtn) stopBtn.disabled = false;
      }
    });
  });

  /**
   * Mirror server contactSearchQueries for the pre-enrich preview.
   * Scenes (Burning Man / climate / Maker Farm) plus aligned activities.
   * @param {object} contact
   * @returns {string[]}
   */
  function clientContactSearchQueries(contact) {
    const name = String(contact?.displayName || '').trim();
    const org = String(contact?.org || '').trim();
    const title = String(contact?.title || '').trim();
    const location = String(contact?.location || '')
      .split(/[,;|/]+/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(', ');
    const sceneQueryByKey = {
      burningman: 'Burning Man',
      climate: 'climate',
      makerfarm: 'Maker Farm',
    };
    /** @type {string[]} */
    const circleBits = [];
    for (const part of String(contact?.networkCircles || '')
      .split(/[,;|/]+/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      const compact = part.toLowerCase().replace(/[^a-z0-9]+/g, '');
      let key = null;
      if (compact === 'burningman' || compact.startsWith('burningman')) key = 'burningman';
      else if (compact === 'climate' || compact.startsWith('climate')) key = 'climate';
      else if (
        compact === 'makerfarm' ||
        compact === 'makerfare' ||
        compact === 'makerfaire' ||
        compact.startsWith('makerfarm') ||
        compact.startsWith('makerfare') ||
        compact.startsWith('makerfaire')
      ) {
        key = 'makerfarm';
      }
      if (!key) continue;
      const phrase = sceneQueryByKey[key];
      if (phrase && !circleBits.includes(phrase)) circleBits.push(phrase);
      if (circleBits.length >= 3) break;
    }
    /** @type {string[]} */
    const activityBits = [];
    for (const item of Array.isArray(contact?.alignedActivities) ? contact.alignedActivities : []) {
      const s = String(item || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      if (!s || s.length < 2) continue;
      if (/\btelegram\b|t\.me\b|telegram\.(?:me|org|dog)/i.test(s)) continue;
      if (!activityBits.includes(s)) activityBits.push(s);
      if (activityBits.length >= 8) break;
    }
    const aliases = (contact?.aliases || [])
      .map((a) => String(a || '').trim())
      .filter(Boolean)
      .slice(0, 4);
    const bioBits = String(contact?.bio || contact?.summary || '')
      .replace(/[^\p{L}\p{N}\s\-']/gu, ' ')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((w) => w.length >= 4 && !/^(telegram|t\.me)$/i.test(w))
      .slice(0, 8);
    const nameTokens = name.split(/\s+/).filter(Boolean);
    const shortName = nameTokens.length === 1;
    /** @type {string[]} */
    const queries = [];
    const pushQ = (q) => {
      const s = String(q || '').replace(/\s+/g, ' ').trim();
      if (!s || s.length < 2) return;
      if (/\btelegram\b|t\.me\b|telegram\.(?:me|org|dog)/i.test(s)) return;
      if (!queries.includes(s)) queries.push(s);
    };
    if (name && shortName) {
      pushQ(`site:linkedin.com/in "${name}"`);
      if (org) pushQ(`"${name}" ${org}`);
      if (circleBits[0]) pushQ(`"${name}" ${circleBits[0]}`);
      if (circleBits[1]) pushQ(`"${name}" ${circleBits[1]}`);
      for (const act of activityBits.slice(0, 3)) pushQ(`"${name}" ${act}`);
      pushQ(`"${name}" person`);
      if (location) pushQ(`"${name}" ${location}`);
      pushQ(`site:facebook.com "${name}"`);
      if (title) pushQ(`"${name}" ${title}`);
    } else if (name) {
      pushQ(`"${name}"`);
      if (org) pushQ(`"${name}" ${org}`);
      pushQ(`site:linkedin.com/in "${name}"`);
      if (title) pushQ(`"${name}" ${title}`);
      if (location) pushQ(`"${name}" ${location}`);
      if (circleBits[0]) pushQ(`"${name}" ${circleBits[0]}`);
      for (const act of activityBits.slice(0, 4)) pushQ(`"${name}" ${act}`);
      pushQ(`site:facebook.com "${name}"`);
    }
    if (name && bioBits.length) pushQ(`"${name}" ${bioBits.slice(0, 4).join(' ')}`);
    for (const a of aliases) {
      pushQ(`"${a}"`);
      if (org) pushQ(`"${a}" ${org}`);
      if (shortName) pushQ(`site:linkedin.com/in "${a}"`);
    }
    if (name && org) pushQ(`"${name}" "${org}" linkedin`);
    if (name) {
      for (const act of activityBits) pushQ(`"${name}" ${act}`);
    }
    return queries.slice(0, 16);
  }

  /**
   * @param {object} org
   * @returns {string[]}
   */
  function clientOrgSearchQueries(org) {
    const name = String(org?.name || '').trim();
    const industry = String(org?.industry || '').trim();
    const location = String(org?.location || org?.region || '').trim();
    const summaryBits = String(org?.summary || org?.description || '')
      .replace(/[^\p{L}\p{N}\s\-']/gu, ' ')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((w) => w.length >= 4 && !/^(telegram|t\.me)$/i.test(w))
      .slice(0, 6);
    /** @type {string[]} */
    const queries = [];
    const pushQ = (q) => {
      const s = String(q || '').replace(/\s+/g, ' ').trim();
      if (!s || s.length < 2) return;
      if (/\btelegram\b|t\.me\b|telegram\.(?:me|org|dog)/i.test(s)) return;
      if (!queries.includes(s)) queries.push(s);
    };
    if (name) pushQ(`"${name}" company`);
    if (name && industry) pushQ(`"${name}" ${industry}`);
    if (name && location) pushQ(`"${name}" ${location}`);
    if (name && summaryBits.length) pushQ(`"${name}" ${summaryBits.slice(0, 4).join(' ')}`);
    if (name) pushQ(`site:linkedin.com/company "${name}"`);
    return queries.slice(0, 8);
  }

  /**
   * @param {object} card
   * @param {object} contact
   */
  function buildContactWebEnrichPreview(card, contact) {
    const channels = {
      ...(contact?.channels || {}),
      ...(card?.channels && typeof card.channels === 'object' ? card.channels : {}),
    };
    if (card?.channels?.urls || contact?.channels?.urls) {
      channels.urls = [
        ...new Set([...(contact?.channels?.urls || []), ...(card?.channels?.urls || [])].filter(Boolean)),
      ];
    }
    const merged = {
      displayName: String(card?.displayName || contact?.displayName || '').trim(),
      aliases: Array.isArray(card?.aliases) ? card.aliases : contact?.aliases || [],
      org: card?.org != null ? String(card.org) : contact?.org || '',
      title: card?.title != null ? String(card.title) : contact?.title || '',
      location: card?.location != null ? String(card.location) : contact?.location || '',
      networkCircles:
        card?.networkCircles != null ? String(card.networkCircles) : contact?.networkCircles || '',
      bio: card?.bio != null ? String(card.bio) : contact?.bio || '',
      summary: contact?.summary || '',
      alignedActivities: Array.isArray(card?.alignedActivities)
        ? card.alignedActivities
        : contact?.alignedActivities || [],
      channels,
      avatarSourceUrl: contact?.avatarSourceUrl || null,
    };
    /** @type {[string, string][]} */
    const facts = [];
    const pushFact = (label, value) => {
      const v = String(value || '').trim();
      if (v) facts.push([label, v]);
    };
    pushFact('Name', merged.displayName);
    if (merged.aliases?.length) pushFact('Aliases', merged.aliases.join(', '));
    pushFact('Company', merged.org);
    pushFact('Title', merged.title);
    pushFact('Location', merged.location);
    {
      const searchableScenes = [];
      for (const part of String(merged.networkCircles || '')
        .split(/[,;|/]+/)
        .map((s) => s.trim())
        .filter(Boolean)) {
        const compact = part.toLowerCase().replace(/[^a-z0-9]+/g, '');
        let label = null;
        if (compact === 'burningman' || compact.startsWith('burningman')) label = 'Burning Man';
        else if (compact === 'climate' || compact.startsWith('climate')) label = 'climate';
        else if (
          compact === 'makerfarm' ||
          compact === 'makerfare' ||
          compact === 'makerfaire' ||
          compact.startsWith('makerfarm') ||
          compact.startsWith('makerfare') ||
          compact.startsWith('makerfaire')
        ) {
          label = 'Maker Farm';
        }
        if (label && !searchableScenes.includes(label)) searchableScenes.push(label);
      }
      if (searchableScenes.length) pushFact('Scene (search)', searchableScenes.join(', '));
    }
    if (merged.alignedActivities?.length) {
      pushFact('Activities', merged.alignedActivities.slice(0, 8).join('; '));
    }

    /** @type {[string, string][]} */
    const pages = [];
    const pushPage = (label, url) => {
      const u = String(url || '').trim();
      if (!u || !/^https?:\/\//i.test(u)) return;
      if (/(?:^|[/.])(?:t\.me|telegram\.(?:me|org|dog)|web\.telegram\.org)\b/i.test(u)) return;
      if (pages.some(([, x]) => x === u)) return;
      pages.push([label, u]);
    };
    pushPage('Photo page', merged.avatarSourceUrl);
    pushPage('LinkedIn', merged.channels?.linkedin);
    for (const u of merged.channels?.urls || []) pushPage('URL', u);

    return {
      facts,
      pages,
      queries: clientContactSearchQueries(merged),
    };
  }

  /**
   * @param {object} card
   * @param {object} org
   */
  function buildOrgWebEnrichPreview(card, org) {
    const merged = {
      name: String(card?.name || org?.name || '').trim(),
      industry: card?.industry != null ? String(card.industry) : org?.industry || '',
      location: card?.location != null ? String(card.location) : org?.location || org?.region || '',
      website: card?.website != null ? card.website : org?.website,
      description: card?.description != null ? String(card.description) : org?.description || '',
      summary: card?.summary != null ? String(card.summary) : org?.summary || '',
      urls: Array.isArray(card?.urls) ? card.urls : org?.urls || [],
      linkedin: card?.linkedin != null ? card.linkedin : org?.linkedin,
    };
    /** @type {[string, string][]} */
    const facts = [];
    const pushFact = (label, value) => {
      const v = String(value || '').trim();
      if (v) facts.push([label, v]);
    };
    pushFact('Name', merged.name);
    pushFact('Industry', merged.industry);
    pushFact('Location', merged.location);

    /** @type {[string, string][]} */
    const pages = [];
    const pushPage = (label, url) => {
      const u = String(url || '').trim();
      if (!u || !/^https?:\/\//i.test(u)) return;
      if (/(?:^|[/.])(?:t\.me|telegram\.(?:me|org|dog)|web\.telegram\.org)\b/i.test(u)) return;
      if (pages.some(([, x]) => x === u)) return;
      pages.push([label, u]);
    };
    pushPage('Website', merged.website);
    pushPage('LinkedIn', merged.linkedin);
    for (const u of merged.urls || []) pushPage('URL', u);

    return {
      facts,
      pages,
      queries: clientOrgSearchQueries(merged),
    };
  }

  /**
   * Confirm dialog listing the card facts / pages / queries web enrich will start with.
   * Pages and search queries are checkboxes (all on); uncheck ones that are not relevant.
   * @param {{
   *   title?: string,
   *   preview: { facts?: [string, string][], pages?: [string, string][], queries?: string[] },
   * }} opts
   * @returns {Promise<false | { queries: string[], pages: string[] }>}
   */
  function openEnrichPreviewDialog(opts) {
    const preview = opts.preview || {};
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'network-crm__img-pick-backdrop network-crm__enrich-backdrop';
      backdrop.setAttribute('role', 'presentation');

      const dialog = document.createElement('div');
      dialog.className = 'network-crm__img-pick-dialog network-crm__enrich-dialog network-crm__enrich-preview-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', opts.title || 'Start enrich');

      const header = document.createElement('div');
      header.className = 'network-crm__img-pick-dialog-header';
      const title = document.createElement('h3');
      title.className = 'network-crm__img-pick-dialog-title';
      title.textContent = opts.title || 'Start web enrich?';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'network-crm__btn network-crm__btn--tiny';
      closeBtn.textContent = 'Close';
      header.append(title, closeBtn);

      const hint = document.createElement('p');
      hint.className = 'network-crm__img-pick-hint muted';
      hint.textContent =
        'These are the card facts, known pages, and search queries Enrich will use. Uncheck any pages or search terms that are not relevant, then Go.';

      const body = document.createElement('div');
      body.className = 'network-crm__enrich-preview';

      /**
       * @param {string} heading
       * @param {HTMLElement} content
       */
      function addSection(heading, content) {
        const section = document.createElement('section');
        section.className = 'network-crm__enrich-preview-section';
        const h = document.createElement('h4');
        h.className = 'network-crm__enrich-preview-heading';
        h.textContent = heading;
        section.append(h, content);
        body.append(section);
      }

      const facts = Array.isArray(preview.facts) ? preview.facts : [];
      if (facts.length) {
        const dl = document.createElement('dl');
        dl.className = 'network-crm__enrich-preview-facts';
        for (const [label, value] of facts) {
          const dt = document.createElement('dt');
          dt.textContent = label;
          const dd = document.createElement('dd');
          dd.textContent = value;
          dl.append(dt, dd);
        }
        addSection('Card facts', dl);
      } else {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'No card facts yet — add a name (and ideally company or LinkedIn) first.';
        addSection('Card facts', empty);
      }

      const pages = Array.isArray(preview.pages) ? preview.pages : [];
      /** @type {HTMLInputElement[]} */
      const pageChecks = [];
      if (pages.length) {
        const ul = document.createElement('ul');
        ul.className =
          'network-crm__enrich-preview-list network-crm__enrich-preview-pages network-crm__enrich-preview-queries--checks';
        for (const [label, url] of pages) {
          const li = document.createElement('li');
          const lab = document.createElement('label');
          lab.className = 'network-crm__enrich-preview-query';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = true;
          cb.value = url;
          const text = document.createElement('span');
          const labEl = document.createElement('span');
          labEl.className = 'network-crm__enrich-preview-label muted';
          labEl.textContent = `${label}: `;
          const a = document.createElement('a');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = url;
          a.addEventListener('click', (e) => e.stopPropagation());
          text.append(labEl, a);
          lab.append(cb, text);
          li.append(lab);
          ul.append(li);
          pageChecks.push(cb);
        }
        addSection('Pages to fetch', ul);
      } else {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'No known profile/website URLs yet — search will rely on web queries.';
        addSection('Pages to fetch', empty);
      }

      const queries = Array.isArray(preview.queries) ? preview.queries : [];
      /** @type {HTMLInputElement[]} */
      const queryChecks = [];
      if (queries.length) {
        const ol = document.createElement('ul');
        ol.className =
          'network-crm__enrich-preview-list network-crm__enrich-preview-queries network-crm__enrich-preview-queries--checks';
        for (const q of queries) {
          const li = document.createElement('li');
          const lab = document.createElement('label');
          lab.className = 'network-crm__enrich-preview-query';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = true;
          cb.value = q;
          const span = document.createElement('span');
          span.textContent = q;
          lab.append(cb, span);
          li.append(lab);
          ol.append(li);
          queryChecks.push(cb);
        }
        addSection('Search queries', ol);
      }

      const actions = document.createElement('div');
      actions.className = 'network-crm__img-pick-dialog-actions network-crm__enrich-preview-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'network-crm__btn';
      cancelBtn.textContent = 'Cancel';
      const goBtn = document.createElement('button');
      goBtn.type = 'button';
      goBtn.className = 'network-crm__btn network-crm__btn--primary';
      goBtn.textContent = 'Go';
      actions.append(cancelBtn, goBtn);

      function selectedQueries() {
        return queryChecks.filter((c) => c.checked).map((c) => c.value);
      }

      function selectedPages() {
        return pageChecks.filter((c) => c.checked).map((c) => c.value);
      }

      /**
       * @param {false | { queries: string[], pages?: string[] }} result
       */
      function finish(result) {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        resolve(result);
      }

      function selectionPayload() {
        /** @type {{ queries: string[], pages?: string[] }} */
        const payload = { queries: selectedQueries() };
        // Only send pages when the dialog showed a checklist (so [] means “fetch none”).
        if (pageChecks.length) payload.pages = selectedPages();
        return payload;
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        } else if (e.key === 'Enter' && !e.isComposing) {
          const t = e.target;
          const tag = t && /** @type {HTMLElement} */ (t).tagName;
          if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT') return;
          e.preventDefault();
          finish(selectionPayload());
        }
      }

      closeBtn.addEventListener('click', () => finish(false));
      cancelBtn.addEventListener('click', () => finish(false));
      goBtn.addEventListener('click', () => finish(selectionPayload()));
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) finish(false);
      });

      dialog.append(header, hint, body, actions);
      backdrop.append(dialog);
      document.body.append(backdrop);
      document.addEventListener('keydown', onKey);
      goBtn.focus();
    });
  }

  /**
   * Enrich options dialog: from web / file / email / voice.
   * Choosing an option closes immediately and continues on the Network screen.
   * @param {{
   *   title?: string,
   *   modes?: Array<'web' | 'file' | 'email' | 'voice'>,
   *   getWebPreview?: () => { facts?: [string, string][], pages?: [string, string][], queries?: string[] },
   *   webPreviewTitle?: string,
   *   onWeb: (selection?: { searchQueries?: string[], fetchUrls?: string[] }) => Promise<void>,
   *   onFile: (file: File) => Promise<void>,
   *   onEmail: () => Promise<void>,
   *   onVoiceStart?: () => Promise<void>,
   * }} opts
   */
  function openEnrichOptionsDialog(opts) {
    const modes = new Set(opts.modes || ['web', 'file', 'email', 'voice']);
    const backdrop = document.createElement('div');
    backdrop.className = 'network-crm__img-pick-backdrop network-crm__enrich-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'network-crm__img-pick-dialog network-crm__enrich-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', opts.title || 'Enrich');

    const header = document.createElement('div');
    header.className = 'network-crm__img-pick-dialog-header';
    const title = document.createElement('h3');
    title.className = 'network-crm__img-pick-dialog-title';
    title.textContent = opts.title || 'Enrich';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'network-crm__btn network-crm__btn--tiny';
    closeBtn.textContent = 'Close';
    header.append(title, closeBtn);

    const hint = document.createElement('p');
    hint.className = 'network-crm__img-pick-hint muted';
    hint.textContent =
      'Choose a source — enrichment continues in the background; you can keep using the app.';

    const listEl = document.createElement('div');
    listEl.className = 'network-crm__enrich-options';

    function close() {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    /**
     * @param {string} label
     * @param {string} desc
     * @param {() => void | Promise<void>} onClick
     * @param {{ iconHtml?: string, className?: string }} [extra]
     */
    function addOption(label, desc, onClick, extra = {}) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `network-crm__enrich-option${extra.className ? ` ${extra.className}` : ''}`;
      if (extra.iconHtml) {
        const icon = document.createElement('span');
        icon.className = 'network-crm__enrich-option-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = extra.iconHtml;
        btn.append(icon);
      }
      const textWrap = document.createElement('span');
      textWrap.className = 'network-crm__enrich-option-text';
      const strong = document.createElement('strong');
      strong.textContent = label;
      const p = document.createElement('span');
      p.className = 'muted';
      p.textContent = desc;
      textWrap.append(strong, p);
      btn.append(textWrap);
      btn.addEventListener('click', () => {
        void Promise.resolve(onClick());
      });
      listEl.append(btn);
      return btn;
    }

    if (modes.has('web')) {
      addOption('From web', 'Search public pages and fill empty fields', async () => {
        close();
        /** @type {{ searchQueries?: string[], fetchUrls?: string[] } | undefined} */
        let selection;
        if (typeof opts.getWebPreview === 'function') {
          const result = await openEnrichPreviewDialog({
            title: opts.webPreviewTitle || 'Start web enrich?',
            preview: opts.getWebPreview() || {},
          });
          if (!result) return;
          selection = {
            searchQueries: result.queries,
            // Only constrain known pages when the dialog listed some to check.
            ...(Array.isArray(result.pages) ? { fetchUrls: result.pages } : {}),
          };
        }
        runEnrichInBackground(
          'Enriching from web in the background (up to ~90s)…',
          () => opts.onWeb(selection),
        );
      });
    }

    if (modes.has('file')) {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept =
        '.txt,.md,.csv,.json,.html,.htm,.vcf,.vcard,text/*,image/*,.png,.jpg,.jpeg,.webp,.gif';
      fileInput.hidden = true;
      addOption('From file', 'Upload a resume, bio, notes, or screenshot', () => {
        fileInput.click();
      });
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        close();
        runEnrichInBackground(`Reading ${file.name}…`, () => opts.onFile(file));
      });
      dialog.append(fileInput);
    }

    if (modes.has('email')) {
      addOption('From email', 'Look up emails you’ve been on together', () => {
        close();
        runEnrichInBackground('Searching shared emails…', () => opts.onEmail());
      });
    }

    if (modes.has('voice')) {
      const playIcon =
        '<svg class="network-crm__enrich-play" viewBox="0 0 24 24" width="22" height="22" focusable="false">' +
        '<circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.18"/>' +
        '<path d="M9.5 7.5v9l8-4.5-8-4.5z" fill="currentColor"/>' +
        '</svg>';
      addOption(
        'From voice',
        'Press to record — we transcribe and file the facts',
        async () => {
          close();
          try {
            if (typeof opts.onVoiceStart === 'function') {
              await opts.onVoiceStart();
            }
          } catch (err) {
            hideVoiceBar();
            showStatus(String(err?.message || err), true);
          }
        },
        { iconHtml: playIcon, className: 'network-crm__enrich-option--voice' },
      );
    }

    closeBtn.addEventListener('click', () => close());
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    dialog.append(header, hint, listEl);
    backdrop.append(dialog);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
  }

  /**
   * @param {File} file
   */
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('read_failed'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * @param {string} id
   */
  function openOrganization(id) {
    view = 'companies';
    selectedOrgId = id;
    syncTabs();
    list.setAttribute('aria-label', 'Companies');
    list.setAttribute('aria-labelledby', 'network-tab-companies');
    renderList();
    const o = organizations.find((x) => x.id === id);
    // #region agent log
    {
      const listed = orgsWithPeople();
      const body = JSON.stringify({
        sessionId: '3c9ec5',
        runId: 'pre-fix',
        hypothesisId: 'C',
        location: 'network-ui.js:openOrganization',
        message: 'open company from contact/link',
        data: {
          orgId: String(id || ''),
          foundInCache: Boolean(o),
          cacheCount: organizations.length,
          listedCount: listed.length,
          listedHasId: listed.some((x) => x.id === id),
          personaInCache: organizations.some((x) => /persona/i.test(String(x.name || ''))),
          personaInListed: listed.some((x) => /persona/i.test(String(x.name || ''))),
        },
        timestamp: Date.now(),
      });
      fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '3c9ec5' },
        body,
      }).catch(() => {});
      fetch('/api/dev-agent-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => {});
    }
    // #endregion
    if (!o) {
      detail.innerHTML = '<p class="muted">Company not found</p>';
      return;
    }
    renderOrgDetail(o);
  }

  /**
   * @param {object} o
   */
  function renderOrgDetail(o) {
    const gen = ++detailGeneration;
    /** @type {object} */
    let current = o;
    detail.replaceChildren();
    const head = document.createElement('div');
    head.className = 'network-crm__detail-head';

    const logoWrap = document.createElement('div');
    logoWrap.className = 'network-crm__avatar-wrap';

    const logoFrame = document.createElement('div');
    logoFrame.className = 'network-crm__avatar-frame';
    if (current.logoUrl) {
      logoFrame.append(logoEl(current, 'network-crm__avatar network-crm__avatar--lg'));
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'network-crm__avatar network-crm__avatar--lg';
      const initials = String(current.name || '?')
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0] || '')
        .join('')
        .toUpperCase();
      placeholder.textContent = initials || '?';
      logoFrame.append(placeholder);
    }
    logoWrap.append(logoFrame);

    const logoPick = mountImageCandidatePicker({
      candidatesUrl: `/api/network/organizations/${encodeURIComponent(current.id)}/logo-candidates`,
      applyUrl: `/api/network/organizations/${encodeURIComponent(current.id)}/logo-from-url`,
      uploadUrl: `/api/network/organizations/${encodeURIComponent(current.id)}/logo`,
      buttonLabel: 'Find other logos',
      dialogTitle: 'Pick a logo',
      emptyLabel: 'No logos found — try a different search or Upload',
      querySearch: true,
      queryPlaceholder: 'Type a company or brand name…',
      queryAriaLabel: 'Search logos',
      defaultQuery: () => {
        const live = detail.querySelector('.network-crm__form [name="name"]');
        const name = String(live?.value || current.name || '').trim();
        return name ? `${name} logo` : '';
      },
      clear: current.logoUrl
        ? {
            url: `/api/network/organizations/${encodeURIComponent(current.id)}`,
            body: { logoUrl: null },
            label: 'Remove current logo',
            previewUrl: `${current.logoUrl}${current.logoUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(current.updatedAt || '')}`,
          }
        : null,
      onApplied: (entity) => {
        const idx = organizations.findIndex((x) => x.id === entity.id);
        if (idx >= 0) organizations[idx] = entity;
        renderList();
        renderOrgDetail(entity);
      },
    });
    logoWrap.append(logoPick);
    head.append(logoWrap);

    const titles = document.createElement('div');
    const h = document.createElement('h3');
    h.className = 'network-crm__detail-name';
    h.textContent = current.name || 'Untitled company';
    if (!current.logoUrl) {
      const hint = document.createElement('p');
      hint.className = 'muted network-crm__aliases';
      hint.textContent = 'No logo yet — find logos, Upload, or Enrich';
      titles.append(h, hint);
    } else {
      titles.append(h);
    }
    head.append(titles);

    const form = document.createElement('form');
    form.className = 'network-crm__form';

    /**
     * @param {string} label
     * @param {string} name
     * @param {string} value
     * @param {{ rows?: number, type?: string, options?: string[], readonly?: boolean }} [opts]
     */
    function field(label, name, value, opts = {}) {
      const wrapEl = document.createElement('label');
      wrapEl.className = 'network-crm__field';
      if (opts.rows) wrapEl.classList.add('network-crm__field--full');
      const span = document.createElement('span');
      span.textContent = label;
      let input;
      if (opts.options) {
        input = document.createElement('select');
        input.className = 'network-crm__input';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '—';
        input.append(blank);
        for (const opt of opts.options) {
          const el = document.createElement('option');
          el.value = opt;
          el.textContent = opt;
          if (String(value || '') === opt) el.selected = true;
          input.append(el);
        }
      } else if (opts.rows) {
        input = document.createElement('textarea');
        input.rows = opts.rows;
        input.value = value || '';
        input.className = 'network-crm__input';
      } else {
        input = document.createElement('input');
        input.type = opts.type || 'text';
        input.value = value || '';
        input.className = 'network-crm__input';
        if (opts.readonly) {
          input.readOnly = true;
          input.classList.add('network-crm__input--readonly');
        }
      }
      input.name = name;
      input.required = false;
      wrapEl.append(span, input);
      return wrapEl;
    }

    const linkedPeople = contacts
      .filter(
        (c) => c.orgId === o.id || (c.org || '').toLowerCase() === (o.name || '').toLowerCase(),
      )
      .sort((a, b) =>
        String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, {
          sensitivity: 'base',
        }),
      );
    const linkedNameKeys = new Set(
      linkedPeople.flatMap((c) =>
        [c.displayName, c.nickname, ...(c.aliases || [])]
          .filter(Boolean)
          .map((n) => String(n).toLowerCase()),
      ),
    );
    const suggested = (Array.isArray(o.suggestedPeople) ? o.suggestedPeople : []).filter(
      (p) => p && p.status !== 'dismissed' && p.status !== 'added' && !linkedNameKeys.has(String(p.name || '').toLowerCase()),
    );

    const peopleBox = document.createElement('div');
    peopleBox.className = 'network-crm__people-panel';

    const peopleHead = document.createElement('div');
    peopleHead.className = 'network-crm__people-panel-head';
    const peopleTitle = document.createElement('h4');
    peopleTitle.className = 'network-crm__people-panel-title';
    peopleTitle.textContent = 'People';
    const addPersonBtn = document.createElement('button');
    addPersonBtn.type = 'button';
    addPersonBtn.className = 'network-crm__btn network-crm__btn--tiny';
    addPersonBtn.textContent = 'Add person';
    peopleHead.append(peopleTitle, addPersonBtn);
    peopleBox.append(peopleHead);

    /**
     * @param {object} nextOrg
     */
    async function persistSuggested(nextOrg) {
      const r = await fetch(`/api/network/organizations/${encodeURIComponent(o.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestedPeople: nextOrg.suggestedPeople }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save_failed');
      const idx = organizations.findIndex((x) => x.id === o.id);
      if (idx >= 0) organizations[idx] = j.organization;
      return j.organization;
    }

    /**
     * @param {string} suggestionId
     * @param {(p: object) => object | null} mapFn
     */
    async function patchSuggestion(suggestionId, mapFn) {
      const list = Array.isArray(o.suggestedPeople) ? o.suggestedPeople.map((p) => ({ ...p })) : [];
      const idx = list.findIndex((p) => p.id === suggestionId);
      if (idx < 0) return o;
      const next = mapFn(list[idx]);
      if (next == null) list.splice(idx, 1);
      else list[idx] = next;
      return persistSuggested({ ...o, suggestedPeople: list });
    }

    /**
     * @param {{ name: string, sub?: string, actions: HTMLElement[], onOpen?: () => void }} opts
     */
    function personRow(opts) {
      const { name, sub, actions, onOpen } = opts;
      const row = document.createElement('div');
      row.className = 'network-crm__person-row';
      const meta = document.createElement('div');
      meta.className = 'network-crm__person-meta';
      if (onOpen) {
        const nameBtn = document.createElement('button');
        nameBtn.type = 'button';
        nameBtn.className = 'network-crm__person-name network-crm__person-name--link';
        nameBtn.textContent = name || 'Untitled';
        nameBtn.title = 'Open contact';
        nameBtn.addEventListener('click', onOpen);
        meta.append(nameBtn);
      } else {
        const nameEl = document.createElement('div');
        nameEl.className = 'network-crm__person-name';
        nameEl.textContent = name || 'Untitled';
        meta.append(nameEl);
      }
      if (sub) {
        const subEl = document.createElement('div');
        subEl.className = 'network-crm__person-sub muted';
        subEl.textContent = sub;
        meta.append(subEl);
      }
      const acts = document.createElement('div');
      acts.className = 'network-crm__person-actions';
      for (const a of actions) acts.append(a);
      row.append(meta, acts);
      return row;
    }

    function tinyBtn(label, onClick, primary = false) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `network-crm__btn network-crm__btn--tiny${primary ? ' network-crm__btn--primary' : ''}`;
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      return btn;
    }

    const inNetwork = document.createElement('div');
    inNetwork.className = 'network-crm__people-block';
    const inNetworkLabel = document.createElement('div');
    inNetworkLabel.className = 'network-crm__checks-label';
    inNetworkLabel.textContent = 'In your network';
    inNetwork.append(inNetworkLabel);
    if (!linkedPeople.length) {
      const empty = document.createElement('p');
      empty.className = 'muted network-crm__people-empty';
      empty.textContent = 'No linked people yet.';
      inNetwork.append(empty);
    } else {
      for (const p of linkedPeople) {
        const openPerson = () => {
          void openContactDetail(p.id);
        };
        const openBtn = tinyBtn('Open', openPerson, true);
        const unlinkBtn = tinyBtn('Unlink', async () => {
          if (!confirm(`Unlink ${p.displayName} from ${o.name}?`)) return;
          showStatus('Unlinking…');
          try {
            const r = await fetch(`/api/network/contacts/${encodeURIComponent(p.id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ org: '', orgId: null }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'unlink_failed');
            const idx = contacts.findIndex((x) => x.id === p.id);
            if (idx >= 0) contacts[idx] = j.contact;
            showStatus('Unlinked');
            renderOrgDetail(organizations.find((x) => x.id === o.id) || o);
          } catch (err) {
            showStatus(String(err?.message || err), true);
          }
        });
        inNetwork.append(
          personRow({
            name: p.nickname ? `${p.displayName} (${p.nickname})` : p.displayName,
            sub: [p.title, 'in network'].filter(Boolean).join(' · '),
            actions: [openBtn, unlinkBtn],
            onOpen: openPerson,
          }),
        );
      }
    }
    peopleBox.append(inNetwork);

    const foundBlock = document.createElement('div');
    foundBlock.className = 'network-crm__people-block';
    const foundLabel = document.createElement('div');
    foundLabel.className = 'network-crm__checks-label';
    foundLabel.textContent = 'Found during enrichment';
    foundBlock.append(foundLabel);
    if (!suggested.length) {
      const empty = document.createElement('p');
      empty.className = 'muted network-crm__people-empty';
      empty.textContent = o.enrichment?.enrichedAt
        ? 'No new people pending — enrich again or add someone manually.'
        : 'Run Enrich from web to find people associated with this company.';
      foundBlock.append(empty);
    } else {
      for (const s of suggested) {
        const existingMatch = contacts.find(
          (c) =>
            String(c.displayName || '').toLowerCase() === String(s.name || '').toLowerCase() ||
            (c.aliases || []).some((a) => String(a).toLowerCase() === String(s.name || '').toLowerCase()),
        );
        const actions = [];
        if (existingMatch) {
          actions.push(
            tinyBtn(
              'Link',
              async () => {
                showStatus('Linking…');
                try {
                  const r = await fetch(`/api/network/contacts/${encodeURIComponent(existingMatch.id)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ org: o.name, orgId: o.id, title: s.title || existingMatch.title || '' }),
                  });
                  const j = await r.json();
                  if (!j.ok) throw new Error(j.error || 'link_failed');
                  const cidx = contacts.findIndex((x) => x.id === existingMatch.id);
                  if (cidx >= 0) contacts[cidx] = j.contact;
                  const orgNext = await patchSuggestion(s.id, (p) => ({ ...p, status: 'added' }));
                  showStatus('Linked');
                  renderOrgDetail(orgNext);
                } catch (err) {
                  showStatus(String(err?.message || err), true);
                }
              },
              true,
            ),
          );
        } else {
          actions.push(
            tinyBtn(
              'Add',
              async () => {
                showStatus('Adding…');
                try {
                  const body = {
                    displayName: s.name,
                    org: o.name,
                    orgId: o.id,
                    title: s.title || '',
                    kinds: ['business'],
                    channels: {},
                  };
                  if (s.linkedin) body.channels.linkedin = s.linkedin;
                  const r = await fetch('/api/network/contacts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  });
                  const j = await r.json();
                  if (!j.ok) throw new Error(j.error || 'create_failed');
                  contacts.unshift(j.contact);
                  await patchSuggestion(s.id, (p) => ({ ...p, status: 'added' }));
                  showStatus('Added to network');
                  await openContactDetail(j.contact.id);
                } catch (err) {
                  showStatus(String(err?.message || err), true);
                }
              },
              true,
            ),
          );
        }
        actions.push(
          tinyBtn('Dismiss', async () => {
            showStatus('Dismissing…');
            try {
              const orgNext = await patchSuggestion(s.id, (p) => ({ ...p, status: 'dismissed' }));
              showStatus('Dismissed');
              renderOrgDetail(orgNext);
            } catch (err) {
              showStatus(String(err?.message || err), true);
            }
          }),
        );
        foundBlock.append(
          personRow({
            name: s.name,
            sub: [s.title, existingMatch ? 'already in network' : 'new'].filter(Boolean).join(' · '),
            actions,
          }),
        );
      }
    }
    peopleBox.append(foundBlock);

    addPersonBtn.addEventListener('click', async () => {
      const pick = await openPickContactDialog({
        contacts,
        excludeIds: linkedPeople.map((p) => p.id),
        title: `Link person to ${o.name || 'company'}`,
        hint: `Search existing contacts, or add someone new — they’ll be linked to ${o.name || 'this company'}.`,
        orgLabel: o.name || 'this company',
      });
      if (!pick) return;

      if (pick.action === 'link') {
        const existing = contacts.find((c) => c.id === pick.contactId);
        if (!existing) {
          showStatus('Contact not found', true);
          return;
        }
        showStatus(`Linking ${existing.displayName || 'person'}…`);
        try {
          const r = await fetch(`/api/network/contacts/${encodeURIComponent(existing.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ org: o.name, orgId: o.id }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'link_failed');
          const idx = contacts.findIndex((x) => x.id === existing.id);
          if (idx >= 0) contacts[idx] = j.contact;
          showStatus('Linked');
          renderOrgDetail(organizations.find((x) => x.id === o.id) || o);
        } catch (err) {
          showStatus(String(err?.message || err), true);
        }
        return;
      }

      showStatus('Adding…');
      try {
        const met = await fetchHowWeMetSuggestion();
        const body = {
          displayName: pick.displayName,
          org: o.name,
          orgId: o.id,
          title: pick.title || '',
          kinds: ['business'],
        };
        if (met?.howWeMet) body.howWeMet = met.howWeMet;
        const r = await fetch('/api/network/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'create_failed');
        contacts.unshift(j.contact);
        showStatus(`Added${howWeMetStatusBit(met)}`);
        await openContactDetail(j.contact.id);
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    });

    const primaryContactSelect = document.createElement('label');
    primaryContactSelect.className = 'network-crm__field';
    const primarySpan = document.createElement('span');
    primarySpan.textContent = 'Primary contact';
    const primaryInput = document.createElement('select');
    primaryInput.name = 'primaryContactId';
    primaryInput.className = 'network-crm__input';
    const primaryBlank = document.createElement('option');
    primaryBlank.value = '';
    primaryBlank.textContent = '—';
    primaryInput.append(primaryBlank);
    for (const p of linkedPeople) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.displayName || p.id;
      if (o.primaryContactId === p.id) opt.selected = true;
      primaryInput.append(opt);
    }
    primaryContactSelect.append(primarySpan, primaryInput);

    const attrsPanel = document.createElement('div');
    attrsPanel.className = 'network-crm__attrs-panel';
    attrsPanel.hidden = !orgAttrsExpanded;
    attrsPanel.append(
      field('Ownership', 'ownership', o.ownership || ''),
      field('Account source', 'accountSource', o.accountSource || ''),
      field('Rating', 'rating', o.rating || '', { options: ['Fan', 'Hot', 'Warm', 'Cold'] }),
      field('Fiscal year end', 'fiscalYearEnd', o.fiscalYearEnd || ''),
      field('Competitive notes', 'competitiveNotes', o.competitiveNotes || '', { rows: 3 }),
      field('Email', 'email', o.email || '', { type: 'email' }),
      field('LinkedIn', 'linkedin', o.linkedin || '', { type: 'url' }),
      field('Social URLs (one per line)', 'socialUrls', (o.socialUrls || []).join('\n'), { rows: 2 }),
      field('Preferred language', 'locale', o.locale || ''),
      primaryContactSelect,
      field('Partner / channel relationships', 'partnerRelationships', o.partnerRelationships || '', { rows: 2 }),
      field('Next step', 'nextStep', o.nextStep || '', { rows: 2 }),
      field('Summary (freeform words for LLM search)', 'summary', o.summary || '', { rows: 2 }),
      field(NETWORK_LABELS.aliases, 'aliases', (o.aliases || []).join(', ')),
      field('URLs (one per line)', 'urls', (o.urls || []).join('\n'), { rows: 2 }),
      field('Account ID', 'accountIdDisplay', o.id || '', { readonly: true }),
    );
    const enrichMeta = document.createElement('p');
    enrichMeta.className = 'network-crm__meta muted';
    const conf =
      typeof o.enrichment?.confidence === 'number'
        ? ` · confidence ${Math.round(o.enrichment.confidence * 100)}%`
        : '';
    enrichMeta.textContent = o.enrichment?.enrichedAt
      ? `Enriched ${formatNetworkTimestamp(o.enrichment.enrichedAt)}${conf}`
      : 'Not enriched yet';
    attrsPanel.append(enrichMeta);

    const toggleAttrs = document.createElement('button');
    toggleAttrs.type = 'button';
    toggleAttrs.className = 'network-crm__btn network-crm__btn--attrs';
    toggleAttrs.textContent = orgAttrsExpanded
      ? NETWORK_LABELS.hideHidden
      : NETWORK_LABELS.showHidden;
    toggleAttrs.setAttribute('aria-expanded', orgAttrsExpanded ? 'true' : 'false');
    toggleAttrs.addEventListener('click', () => {
      orgAttrsExpanded = !orgAttrsExpanded;
      attrsPanel.hidden = !orgAttrsExpanded;
      toggleAttrs.textContent = orgAttrsExpanded
        ? NETWORK_LABELS.hideHidden
        : NETWORK_LABELS.showHidden;
      toggleAttrs.setAttribute('aria-expanded', orgAttrsExpanded ? 'true' : 'false');
    });

    form.append(
      field('Name', 'name', o.name),
      field('Type', 'type', o.type || '', {
        options: [
          'Prospect',
          'Customer',
          'Partner',
          'Subcontractor',
          'Vendor',
          'Supplier',
          'Competitor',
          'Other',
        ],
      }),
      field('Industry', 'industry', o.industry || ''),
      field('Website', 'website', o.website || '', { type: 'url' }),
      field('Employees', 'employeeCount', o.employeeCount || ''),
      field('Annual revenue', 'annualRevenue', o.annualRevenue || ''),
      field('Description', 'description', o.description || '', { rows: 4 }),
      field('Lifecycle stage', 'lifecycleStatus', o.lifecycleStatus || '', {
        options: ['Prospect', 'Qualified', 'Customer', 'Churned'],
      }),
      field('Location (city / HQ)', 'location', o.location || ''),
      field('Phone', 'phone', o.phone || '', { type: 'tel' }),
      toggleAttrs,
      attrsPanel,
    );

    const actions = document.createElement('div');
    actions.className = 'network-crm__actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'network-crm__btn network-crm__btn--primary';
    saveBtn.textContent = 'Save';
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'network-crm__btn';
    undoBtn.textContent = 'Undo';
    undoBtn.disabled = true;
    undoBtn.title = 'Undo last save or enrich (Ctrl+Z outside a field)';
    const enrichBtn = document.createElement('button');
    enrichBtn.type = 'button';
    enrichBtn.className = 'network-crm__btn';
    enrichBtn.textContent = 'Enrich';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'network-crm__btn network-crm__btn--danger';
    delBtn.textContent = 'Delete';
    const linkedCount = linkedPeople.length;
    if (linkedCount) {
      delBtn.disabled = true;
      delBtn.title = `Cannot delete — assigned to ${linkedCount} contact${linkedCount === 1 ? '' : 's'}. Remove people first.`;
    } else {
      delBtn.title = 'Delete this company (not assigned to any contact)';
    }
    actions.append(saveBtn, undoBtn, enrichBtn, delBtn);
    form.append(peopleBox, actions);

    /** @type {object[]} */
    let undoStack = orgUndoStacks.get(current.id);
    if (!undoStack) {
      undoStack = [];
      orgUndoStacks.set(current.id, undoStack);
    }
    function syncUndoBtn() {
      undoBtn.disabled = undoStack.length === 0;
      undoBtn.textContent = undoStack.length > 1 ? `Undo (${undoStack.length})` : 'Undo';
    }
    syncUndoBtn();

    function buildOrgBody() {
      const fd = new FormData(form);
      const splitLines = (key) =>
        String(fd.get(key) || '')
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean);
      return {
        name: String(fd.get('name') || '').trim(),
        type: String(fd.get('type') || '').trim(),
        industry: String(fd.get('industry') || '').trim(),
        website: String(fd.get('website') || '').trim() || null,
        description: String(fd.get('description') || '').trim(),
        lifecycleStatus: String(fd.get('lifecycleStatus') || '').trim(),
        location: String(fd.get('location') || '').trim(),
        phone: String(fd.get('phone') || '').trim(),
        ownership: String(fd.get('ownership') || '').trim(),
        accountSource: String(fd.get('accountSource') || '').trim(),
        rating: String(fd.get('rating') || '').trim(),
        annualRevenue: String(fd.get('annualRevenue') || '').trim(),
        employeeCount: String(fd.get('employeeCount') || '').trim(),
        fiscalYearEnd: String(fd.get('fiscalYearEnd') || '').trim(),
        competitiveNotes: String(fd.get('competitiveNotes') || '').trim(),
        email: String(fd.get('email') || '').trim(),
        linkedin: String(fd.get('linkedin') || '').trim() || null,
        socialUrls: splitLines('socialUrls'),
        locale: String(fd.get('locale') || '').trim(),
        primaryContactId: String(fd.get('primaryContactId') || '').trim() || null,
        partnerRelationships: String(fd.get('partnerRelationships') || '').trim(),
        nextStep: String(fd.get('nextStep') || '').trim(),
        summary: String(fd.get('summary') || '').trim(),
        aliases: String(fd.get('aliases') || '')
          .split(/[,;\n]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        urls: splitLines('urls'),
      };
    }

    let saveInFlight = false;
    let dirtyWhileSaving = false;

    /**
     * @param {{ fromUndo?: boolean, bodyOverride?: object, remount?: boolean }} [opts]
     */
    async function persistOrg(opts = {}) {
      if (gen !== detailGeneration) return;
      if (saveInFlight) {
        dirtyWhileSaving = true;
        return;
      }
      saveInFlight = true;
      showStatus(opts.fromUndo ? 'Undoing…' : 'Saving…');
      try {
        do {
          dirtyWhileSaving = false;
          const priorId = current.id;
          const priorBody = orgToPutBody(current);
          const body = opts.bodyOverride || buildOrgBody();
          opts = { ...opts, bodyOverride: undefined };
          const r = await fetch(`/api/network/organizations/${encodeURIComponent(priorId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'save_failed');
          if (gen !== detailGeneration) return;

          const saved = j.organization;
          const mergedAway = saved.id !== priorId;
          organizations = organizations.filter((x) => x.id !== priorId || x.id === saved.id);
          const idx = organizations.findIndex((x) => x.id === saved.id);
          if (idx >= 0) organizations[idx] = saved;
          else organizations.push(saved);
          selectedOrgId = saved.id;

          if (!opts.fromUndo && !sameJson(priorBody, orgToPutBody(saved))) {
            undoStack.push(priorBody);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
            syncUndoBtn();
          }
          if (mergedAway && priorId !== saved.id) {
            orgUndoStacks.set(saved.id, undoStack);
            orgUndoStacks.delete(priorId);
          }

          current = saved;

          if (mergedAway || opts.fromUndo || opts.remount) {
            showStatus(opts.fromUndo ? 'Undone' : mergedAway ? 'Saved (merged duplicate)' : 'Saved');
            renderList();
            renderOrgDetail(saved);
            return;
          }

          h.textContent = saved.name || 'Untitled company';
          showStatus('Saved');

          const listLabelChanged =
            String(saved.name || '') !== String(priorBody.name || '')
            || String(saved.industry || '') !== String(priorBody.industry || '')
            || String(saved.type || '') !== String(priorBody.type || '')
            || String(saved.location || '') !== String(priorBody.location || '')
            || String(saved.website || '') !== String(priorBody.website || '');
          if (listLabelChanged) renderList();
        } while (dirtyWhileSaving && gen === detailGeneration);
      } catch (err) {
        if (gen === detailGeneration) showStatus(String(err?.message || err), true);
      } finally {
        saveInFlight = false;
      }
    }

    async function undoOrg() {
      if (!undoStack.length) return;
      const snap = undoStack.pop();
      syncUndoBtn();
      await persistOrg({ fromUndo: true, bodyOverride: snap, remount: true });
    }

    form.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey || e.altKey) return;
      const t = /** @type {HTMLElement} */ (e.target);
      const tag = t?.tagName || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!undoStack.length) return;
      e.preventDefault();
      void undoOrg();
    });

    undoBtn.addEventListener('click', () => {
      void undoOrg();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await persistOrg();
    });

    enrichBtn.addEventListener('click', () => {
      const orgId = current.id;
      const card = buildOrgBody();
      openEnrichOptionsDialog({
        title: 'Enrich company',
        modes: ['web'],
        webPreviewTitle: 'Start company enrich?',
        getWebPreview: () => buildOrgWebEnrichPreview(card, current),
        onWeb: async (selection) => {
          const save = await fetch(`/api/network/organizations/${encodeURIComponent(orgId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(card),
          });
          const saved = await save.json();
          if (!saved.ok) throw new Error(saved.error || 'save_failed');
          if (saved.organization) {
            const idx = organizations.findIndex((x) => x.id === orgId || x.id === saved.organization.id);
            if (idx >= 0) organizations[idx] = saved.organization;
          }
          let r;
          try {
            r = await fetch(`/api/network/organizations/${encodeURIComponent(orgId)}/enrich`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                card,
                searchQueries: Array.isArray(selection?.searchQueries)
                  ? selection.searchQueries
                  : undefined,
                fetchUrls: Array.isArray(selection?.fetchUrls) ? selection.fetchUrls : undefined,
              }),
              signal: AbortSignal.timeout(95_000),
            });
          } catch (e) {
            const name = String(e?.name || '');
            if (name === 'TimeoutError' || name === 'AbortError') {
              throw new Error('Enrich timed out — try again, or add a website URL first');
            }
            throw e;
          }
          const j = await r.json();
          if (!j.ok) {
            if (j.error === 'enrich_timeout') {
              throw new Error('Enrich timed out — try again, or add a website URL first');
            }
            throw new Error(j.error || 'enrich_failed');
          }
          const found = Array.isArray(j.organization?.suggestedPeople)
            ? j.organization.suggestedPeople.filter((p) => p.status === 'pending').length
            : 0;
          applyEnrichedOrganization(
            j.organization,
            found ? `Enriched · ${found} people found` : 'Enriched from web',
          );
        },
        onFile: async () => {},
        onEmail: async () => {},
      });
    });

    delBtn.addEventListener('click', async () => {
      if (linkedPeople.length) {
        showStatus(
          `Cannot delete — assigned to ${linkedPeople.length} contact${linkedPeople.length === 1 ? '' : 's'}`,
          true,
        );
        return;
      }
      if (!confirm(`Delete ${current.name || 'this company'}?`)) return;
      try {
        const r = await fetch(`/api/network/organizations/${encodeURIComponent(current.id)}`, {
          method: 'DELETE',
        });
        const j = await r.json();
        if (!j.ok) {
          if (j.error === 'organization_in_use') {
            throw new Error(j.message || 'Cannot delete — assigned to contacts');
          }
          throw new Error(j.error || 'delete_failed');
        }
        organizations = organizations.filter((x) => x.id !== current.id);
        orgUndoStacks.delete(current.id);
        selectedOrgIds.delete(current.id);
        selectedOrgId = orgsWithPeople()[0]?.id || null;
        showStatus('Deleted');
        renderList();
        if (selectedOrgId) openOrganization(selectedOrgId);
        else {
          detail.innerHTML =
            '<p class="muted">No companies with people yet — link a contact to an organization, or add a company and a person.</p>';
        }
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    });

    detail.append(head, form);
  }

  async function loadOrganizations() {
    try {
      invalidateNetworkPrefetch();
      const r = await fetch('/api/network/organizations');
      const j = await r.json();
      if (j.ok) {
        organizations = Array.isArray(j.organizations) ? j.organizations : [];
        warmNetworkPages(contacts, organizations);
      }
    } catch {
      // keep previous
    }
  }

  peopleTab.addEventListener('click', () => {
    void setPeopleSubTab('contacts');
  });
  companiesTab.addEventListener('click', () => {
    void setView('companies');
  });
  contactsSubTab.addEventListener('click', () => {
    void setPeopleSubTab('contacts');
  });
  manageSubTab.addEventListener('click', () => {
    void setPeopleSubTab('manage');
  });
  groupsSubTab.addEventListener('click', () => {
    void setPeopleSubTab('groups');
  });

  /**
   * @param {{ selectGroupId?: string | null }} [opts]
   */
  async function openGroupsUi(opts = {}) {
    if (groupsUiMounted && groupsUiApi) {
      await groupsUiApi.focus({
        selectGroupId: opts.selectGroupId || null,
        // Always reload — Scene tags added from contact detail create community
        // groups server-side; a stale mounted list would omit them.
        refresh: true,
      });
      groupsUiApi.setQuery?.(search.value || query || '');
      syncGroupToolbar();
      return;
    }
    const [{ mountNetworkGroupsUi }, prefetched] = await Promise.all([
      import('./network-groups-ui.js?v=scene-tag-rw-1'),
      takeGroupsPrefetch().catch(() => groupsCache),
    ]);
    if (Array.isArray(prefetched)) groupsCache = prefetched;
    groupsUiMounted = true;
    groupsUiApi = mountNetworkGroupsUi(groupsPane, {
      contacts,
      groups: groupsCache,
      getContacts: () => contacts,
      getFilteredContacts: () => filteredByPeopleFilters(),
      isContactsLoading: () => !contactsReady,
      selectGroupId: opts.selectGroupId || null,
      embedded: true,
      onClose: () => {
        void setPeopleSubTab('contacts');
      },
      onOpenContact: (id) => {
        void openContactDetail(id);
      },
      onGroupFocus: () => {
        hideGroupsContactDetail();
      },
      onToolbarSync: () => {
        syncGroupToolbar();
      },
      onContactsChanged: async () => {
        const keepId = selectedId;
        const wasWorkbench = peopleSubTab === 'contacts' || peopleSubTab === 'manage';
        showStatus('Loading…');
        try {
          invalidateNetworkPrefetch();
          const [cr, or] = await Promise.all([
            fetch('/api/network/contacts'),
            fetch('/api/network/organizations'),
          ]);
          const j = await cr.json();
          const oj = await or.json();
          if (!j.ok) throw new Error(j.error || 'load_failed');
          contacts = Array.isArray(j.contacts) ? j.contacts : [];
          if (oj.ok) organizations = Array.isArray(oj.organizations) ? oj.organizations : [];
          applyContactEnumsFromApi(j);
          showStatus('');
          if (keepId && contacts.some((c) => c.id === keepId)) selectedId = keepId;
          else if (wasWorkbench) selectedId = contacts[0]?.id || null;
          if (wasWorkbench) {
            renderList();
            if (selectedId) selectContact(selectedId);
          }
          warmNetworkPages(contacts, organizations);
        } catch (err) {
          showStatus(String(err?.message || err), true);
        }
      },
    });
    groupsUiApi.setQuery?.(search.value || query || '');
    syncGroupToolbar();
  }

  async function refreshContactsQuiet() {
    try {
      invalidateNetworkPrefetch();
      const cr = await fetch('/api/network/contacts');
      const j = await cr.json();
      if (!j.ok) return;
      contacts = Array.isArray(j.contacts) ? j.contacts : [];
      applyContactEnumsFromApi(j);
      // Images only — do not re-warm hundreds of detail GETs after every mutation.
      warmNetworkPages(contacts, organizations);
    } catch {
      /* keep existing contacts */
    }
  }

  startGroupSelBtn.addEventListener('click', async () => {
    const ids = [...selectedContactIds];
    if (!ids.length) return;
    showStatus('Creating event group…');
    try {
      const r = await fetch('/api/network/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '', kind: 'event', eventType: '', memberIds: ids }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create_failed');
      selectedContactIds.clear();
      syncSelectionActions();
      renderList();
      showStatus('Created — fill in optional details');
      await setPeopleSubTab('groups', { selectGroupId: j.group?.id || null });
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  addToGroupBtn.addEventListener('click', async () => {
    const ids = [...selectedContactIds];
    if (!ids.length) return;
    showStatus('Loading groups…');
    try {
      const r = await fetch('/api/network/groups');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'groups_failed');
      const groups = Array.isArray(j.groups) ? j.groups : [];
      if (!groups.length) {
        showStatus('No groups yet — use Groups or Start group first', true);
        return;
      }
      const labels = groups
        .map((g, i) => {
          const kind = g.kind === 'event' ? NETWORK_LABELS.event : NETWORK_LABELS.scene;
          return `${i + 1}. [${kind}] ${g.name || 'Untitled'} (${(g.memberIds || []).length})`;
        })
        .join('\n');
      const pick = prompt(`Add ${ids.length} contact(s) to which group?\n${labels}\n\nEnter number:`);
      const idx = Number(pick) - 1;
      if (!Number.isFinite(idx) || idx < 0 || idx >= groups.length) {
        showStatus('Cancelled');
        return;
      }
      const group = groups[idx];
      const ar = await fetch(`/api/network/groups/${encodeURIComponent(group.id)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: ids }),
      });
      const aj = await ar.json();
      if (!aj.ok) throw new Error(aj.error || 'add_failed');
      selectedContactIds.clear();
      syncSelectionActions();
      if (group.kind !== 'event') await refreshContactsQuiet();
      renderList();
      showStatus(`Added to ${group.name || 'group'}`);
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  mergeBtn.addEventListener('click', async () => {
    const ids = [...selectedContactIds];
    if (ids.length < 2) return;
    // Capture before confirm/prompt/await — keep Manage after merge finishes.
    const fromManage = view === 'people' && peopleSubTab === 'manage';
    const fromManageDetail = fromManage && manageDetailOpen;
    const selected = ids.map((id) => contacts.find((c) => c.id === id)).filter(Boolean);
    const names = selected.map((c) => c.displayName || c.id).join(', ');
    if (!confirm(`Merge ${ids.length} contacts into one?\n\n${names}`)) return;
    const suggestedName = selected
      .map((c) => String(c.displayName || '').trim())
      .filter(Boolean)
      .reduce((best, next) => {
        const a = best.toLowerCase().split(/\s+/).filter(Boolean);
        const b = next.toLowerCase().split(/\s+/).filter(Boolean);
        const setA = new Set(a);
        const setB = new Set(b);
        const aInB = a.length && a.every((t) => setB.has(t));
        const bInA = b.length && b.every((t) => setA.has(t));
        if (aInB && !bInA) return next;
        if (bInA && !aInB) return best;
        if (best.toLowerCase().includes(next.toLowerCase()) && !next.toLowerCase().includes(best.toLowerCase())) {
          return best;
        }
        if (next.toLowerCase().includes(best.toLowerCase()) && !best.toLowerCase().includes(next.toLowerCase())) {
          return next;
        }
        if (a.length !== b.length) return a.length > b.length ? best : next;
        return best.length >= next.length ? best : next;
      }, '');
    const displayName = prompt('Merged name (edit if needed):', suggestedName || names.split(', ')[0] || '');
    if (displayName == null) return;
    const trimmedName = String(displayName).trim();
    if (!trimmedName) {
      showStatus('Name required to merge', true);
      return;
    }
    showStatus('Merging…');
    try {
      const r = await fetch('/api/network/contacts/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, displayName: trimmedName }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'merge_failed');
      const survivorId = j.contact?.id || null;
      const dropIds = new Set(ids.filter((id) => id !== survivorId));

      selectedContactIds.clear();
      syncSelectionActions();

      if (j.contact && survivorId) {
        contacts = contacts
          .filter((c) => !dropIds.has(c.id))
          .map((c) => (c.id === survivorId ? j.contact : c));
        if (!contacts.some((c) => c.id === survivorId)) {
          contacts = [j.contact, ...contacts];
        }
      } else if (dropIds.size) {
        contacts = contacts.filter((c) => !dropIds.has(c.id));
      }

      if (fromManage) {
        view = 'people';
        peopleSubTab = 'manage';
        manageDetailOpen = Boolean(fromManageDetail && survivorId);
        selectedId = manageDetailOpen ? survivorId : null;
        persistWorkbenchState();
        syncTabs();
        renderList();
        if (manageDetailOpen && survivorId) {
          selectContact(survivorId, { force: true });
        } else {
          detail.innerHTML =
            '<p class="muted">Double-click a name for details · double-click other cells to edit</p>';
        }
        showStatus(`Merged into ${j.contact?.displayName || 'one contact'}`);
        // Optimistic Manage paint already applied — skip a second full table rebuild
        // (was ~150ms+ main-thread freeze after merge felt "done").
        void refreshContactsQuiet();
        return;
      }

      selectedId = survivorId || selectedId;
      persistWorkbenchState();
      syncTabs();
      renderList();
      if (survivorId) selectContact(survivorId, { force: true });
      showStatus(`Merged into ${j.contact?.displayName || 'one contact'}`);
      void refreshContactsQuiet();
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  deleteSelBtn.addEventListener('click', async () => {
    const ids = [...selectedContactIds];
    if (!ids.length) return;
    const names = ids
      .map((id) => contacts.find((c) => c.id === id)?.displayName || 'contact')
      .slice(0, 8)
      .join(', ');
    const more = ids.length > 8 ? ` (+${ids.length - 8} more)` : '';
    if (!confirm(`Delete ${ids.length} contact(s)?\n\n${names}${more}`)) return;
    showStatus('Deleting…');
    try {
      const r = await fetch('/api/network/contacts/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'delete_failed');
      const drop = new Set(ids);
      contacts = contacts.filter((c) => !drop.has(c.id));
      for (const id of ids) contactUndoStacks.delete(id);
      if (selectedId && drop.has(selectedId)) selectedId = contacts[0]?.id || null;
      selectedContactIds.clear();
      syncSelectionActions();
      showStatus(`Deleted ${j.deleted || ids.length}`);
      renderList();
      if (selectedId) selectContact(selectedId);
      else detail.innerHTML = '<p class="muted">Select a person</p>';
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  enhanceSelBtn.addEventListener('click', async (ev) => {
    const ids = [...selectedContactIds];
    if (!ids.length) return;
    enhanceSelBtn.disabled = true;
    beginWaitCursor(ev);
    let ok = 0;
    let fail = 0;
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const name = contacts.find((c) => c.id === id)?.displayName || id;
        showStatus(`Enhancing ${i + 1}/${ids.length}: ${name}…`);
        try {
          const r = await fetch(`/api/network/contacts/${encodeURIComponent(id)}/enrich`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(95_000),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'enrich_failed');
          applyEnrichedContact(j.contact);
          ok += 1;
        } catch {
          fail += 1;
        }
      }
      selectedContactIds.clear();
      syncSelectionActions();
      renderList();
      if (selectedId) {
        const cur = contacts.find((c) => c.id === selectedId);
        if (cur) renderDetail(cur);
      }
      showStatus(
        fail ? `Enhanced ${ok}, failed ${fail}` : `Enhanced ${ok}`,
        Boolean(fail && !ok),
      );
    } finally {
      endWaitCursor();
      enhanceSelBtn.disabled = false;
    }
  });

  addBtn.addEventListener('click', async () => {
    const displayName = prompt('New contact name?');
    if (!displayName?.trim()) return;
    showStatus('Creating…');
    try {
      const met = await fetchHowWeMetSuggestion();
      const body = { displayName: displayName.trim(), kinds: ['friend'] };
      if (met?.howWeMet) body.howWeMet = met.howWeMet;
      const r = await fetch('/api/network/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create_failed');
      contacts.unshift(j.contact);
      selectedId = j.contact.id;
      showStatus(`Created${howWeMetStatusBit(met)}`);
      renderList();
      await openContactDetail(j.contact.id);
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  addCompanyBtn.addEventListener('click', async () => {
    const name = prompt('Company name?');
    if (!name?.trim()) return;
    showStatus('Creating…');
    try {
      const r = await fetch('/api/network/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create_failed');
      organizations.unshift(j.organization);
      selectedOrgId = j.organization.id;
      showStatus('Created');
      renderList();
      openOrganization(selectedOrgId);
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  bulkBtn.addEventListener('click', () => {
    bulkPanel.hidden = !bulkPanel.hidden;
  });
  bulkPanel.querySelector('[data-bulk-cancel]')?.addEventListener('click', () => {
    bulkPanel.hidden = true;
  });
  bulkPanel.querySelector('[data-bulk-submit]')?.addEventListener('click', async () => {
    const text = bulkPanel.querySelector('.network-crm__bulk-text')?.value || '';
    const kinds = [];
    if (bulkPanel.querySelector('[name="bulk-friend"]')?.checked) kinds.push('friend');
    if (bulkPanel.querySelector('[name="bulk-organizer"]')?.checked) kinds.push('organizer');
    if (bulkPanel.querySelector('[name="bulk-business"]')?.checked) kinds.push('business');
    if (bulkPanel.querySelector('[name="bulk-family"]')?.checked) kinds.push('family');
    const hasKids = Boolean(bulkPanel.querySelector('[name="bulk-has-kids"]')?.checked);
    showStatus('Bulk adding…');
    try {
      const met = await fetchHowWeMetSuggestion();
      const payload = {
        names: text,
        kinds: kinds.length ? kinds : ['friend'],
        hasKids,
      };
      if (met?.howWeMet) payload.howWeMet = met.howWeMet;
      const r = await fetch('/api/network/contacts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'bulk_failed');
      const created = Array.isArray(j.created) ? j.created : [];
      contacts = [...created, ...contacts];
      showStatus(
        `Added ${created.length}${j.skipped ? ` (skipped ${j.skipped} existing)` : ''}${howWeMetStatusBit(met)}`,
      );
      bulkPanel.hidden = true;
      const ta = bulkPanel.querySelector('.network-crm__bulk-text');
      if (ta) ta.value = '';
      if (created[0]) {
        selectedId = created[0].id;
        renderList();
        await openContactDetail(created[0].id);
      } else {
        renderList();
      }
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  function syncPeopleFiltersFromUi() {
    peopleFilters = {
      kinds: kindFilter.getSelected(),
      hasTasks: hasTaskFilter.getSelected(),
      relationships: relationshipFilter.getSelected(),
      statuses: statusFilter.getSelected(),
      locations: locationFilter.getSelected(),
      regions: regionFilter.getSelected(),
      hidePaused: Boolean(hidePausedFilter.cb.checked),
      hideFormer: Boolean(hideFormerFilter.cb.checked),
    };
    persistWorkbenchState();
    renderList();
    if (groupsUiMounted) groupsUiApi?.focus?.({});
  }
  kindFilter.onChange(syncPeopleFiltersFromUi);
  hasTaskFilter.onChange(syncPeopleFiltersFromUi);
  relationshipFilter.onChange(syncPeopleFiltersFromUi);
  statusFilter.onChange(syncPeopleFiltersFromUi);
  locationFilter.onChange(syncPeopleFiltersFromUi);
  regionFilter.onChange(syncPeopleFiltersFromUi);
  hidePausedFilter.cb.addEventListener('change', syncPeopleFiltersFromUi);
  hideFormerFilter.cb.addEventListener('change', syncPeopleFiltersFromUi);
  document.addEventListener('click', closeOpenFilterMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOpenFilterMenu();
  });

  search.addEventListener('input', () => {
    query = search.value;
    persistWorkbenchState();
    if (peopleSubTab === 'groups') {
      groupsUiApi?.setQuery?.(query);
      return;
    }
    renderList();
  });

  addGroupBtn.addEventListener('click', () => {
    void groupsUiApi?.createGroup?.();
  });
  deleteGroupBtn.addEventListener('click', () => {
    void groupsUiApi?.deleteSelected?.();
  });
  saveGroupBtn.addEventListener('click', () => {
    void groupsUiApi?.saveSelected?.();
  });

  async function load() {
    showStatus('Loading…');
    try {
      const data = await takeNetworkPrefetch();
      contacts = data.contacts;
      organizations = data.organizations;
      if (Array.isArray(data.groups)) groupsCache = data.groups;
      applyContactEnumsFromApi({
        preferredContactMethods: data.preferredContactMethods,
        relationshipStatuses: data.relationshipStatuses,
      });
      contactsReady = true;
      showStatus('');
      detailDirty = false;
      selectedContactIds.clear();

      const restored = readWorkbenchState();
      if (restored?.view === 'people' || restored?.view === 'companies') {
        view = restored.view;
      }
      if (
        restored?.peopleSubTab === 'contacts'
        || restored?.peopleSubTab === 'manage'
        || restored?.peopleSubTab === 'groups'
      ) {
        peopleSubTab = restored.peopleSubTab;
      } else {
        peopleSubTab = 'contacts';
      }
      if (
        restored?.peopleFilters
        && typeof restored.peopleFilters === 'object'
        && restored.filterDefaultsVersion === PEOPLE_FILTER_DEFAULTS_VERSION
      ) {
        const pf = restored.peopleFilters;
        peopleFilters = {
          kinds: asFilterList(pf.kinds ?? pf.kind),
          hasTasks: asFilterList(pf.hasTasks ?? pf.hasTask),
          relationships: asFilterList(pf.relationships ?? pf.relationship),
          statuses: asFilterList(pf.statuses ?? pf.status),
          locations: asFilterList(pf.locations ?? pf.location),
          regions: asFilterList(pf.regions ?? pf.region),
          // Always default on every refresh; Manage can uncheck for the session.
          hidePaused: true,
          hideFormer: true,
        };
      } else {
        peopleFilters = createDefaultPeopleFilters();
      }
      if (typeof restored?.query === 'string') {
        query = restored.query;
      }
      refreshLocationFilterOptions();
      applyWorkbenchFiltersToUi();

      if (view === 'companies') {
        selectedId = null;
        manageDetailOpen = false;
        await setView('companies');
      } else if (peopleSubTab === 'groups') {
        selectedId = null;
        manageDetailOpen = false;
        await setView('people', { peopleSubTab: 'groups' });
      } else if (peopleSubTab === 'manage') {
        selectedId = null;
        manageDetailOpen = false;
        syncTabs();
        renderList();
        detail.innerHTML =
          '<p class="muted">Double-click a name for details · double-click other cells to edit</p>';
      } else {
        selectedId = contacts[0]?.id || null;
        manageDetailOpen = false;
        syncTabs();
        renderList();
        if (selectedId) selectContact(selectedId);
        else detail.innerHTML = '<p class="muted">Select a person</p>';
      }
      persistWorkbenchState();
      warmNetworkPages(contacts, organizations);
    } catch (err) {
      contactsReady = true;
      showStatus(String(err?.message || err), true);
      if (peopleSubTab === 'manage') manageTableApi?.render();
      else if (peopleSubTab === 'groups' && groupsUiApi) {
        await groupsUiApi.focus({});
      }
    }
  }

  onContactTaskDone(({ contactId, taskId, done }) => {
    const idx = contacts.findIndex((c) => String(c.id) === String(contactId));
    if (idx >= 0 && Array.isArray(contacts[idx].tasks)) {
      contacts[idx] = {
        ...contacts[idx],
        tasks: contacts[idx].tasks.map((t) =>
          t.id === taskId ? { ...t, done: Boolean(done) } : t,
        ),
      };
    }
    const wrap = root.querySelector('[data-tasks-field]');
    if (wrap && typeof wrap.applyRemoteTaskDone === 'function') {
      wrap.applyRemoteTaskDone(contactId, taskId, done);
    }
    renderList();
  });

  window.addEventListener('beforeunload', (e) => {
    if (!detailDirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  syncTabs();
  applyWorkbenchFiltersToUi();
  load();
}
