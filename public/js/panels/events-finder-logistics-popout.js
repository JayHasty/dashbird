import {
  focusTasksPanel,
  notifyProjectsChanged,
  notifySelectProject,
} from '../lib/task-bridge.js';

const AUTOSAVE_MS = 450;
const INBOX_MARKER = '--- From inbox ---';

/**
 * @param {unknown} existing
 * @param {unknown} scraped
 */
function mergeScraped(existing, scraped) {
  const add = String(scraped || '').trim();
  if (!add) return String(existing || '');
  const prev = String(existing || '').trim();
  if (!prev) return add;
  const idx = prev.indexOf(INBOX_MARKER);
  const head = (idx >= 0 ? prev.slice(0, idx) : prev).trimEnd();
  return `${head}\n\n${INBOX_MARKER}\n${add}`;
}

/**
 * @param {Record<string, unknown> | null | undefined} tp
 */
function travelLogisticsFromTrip(tp) {
  if (!tp || typeof tp !== 'object') return '';
  const parts = [
    tp.accommodations,
    tp.flightsTransport,
    tp.modules && typeof tp.modules === 'object'
      ? /** @type {any} */ (tp.modules).accommodations?.notes
      : '',
    tp.modules && typeof tp.modules === 'object'
      ? /** @type {any} */ (tp.modules).flights?.notes
      : '',
    tp.modules && typeof tp.modules === 'object'
      ? /** @type {any} */ (tp.modules).transportation?.notes
      : '',
  ]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return [...new Set(parts)].join('\n\n');
}

/**
 * @param {Record<string, unknown> | null | undefined} tp
 */
function inRegionFromTrip(tp) {
  if (!tp || typeof tp !== 'object') return '';
  const local =
    tp.modules && typeof tp.modules === 'object'
      ? /** @type {any} */ (tp.modules).local?.notes
      : '';
  const parts = [tp.notes, local].map((s) => String(s || '').trim()).filter(Boolean);
  return [...new Set(parts)].join('\n\n');
}

/**
 * Planning popout: three autosave notes + region rail (news, alerts, weather, events).
 * @param {object} ev
 * @param {{ producer?: boolean }} [opts]
 * @param {{
 *   openConferencePopout: (opts: { title: string, body: HTMLElement, shellClass?: string, bodyClass?: string }) => void,
 *   formatWhen: (iso: string) => string,
 *   patchNotable: (id: string, body: Record<string, unknown>) => Promise<unknown>,
 *   createPolygonWeatherIcon: (code: number, id: string) => HTMLElement,
 *   loadEvents: (opts?: object) => void,
 *   refreshBigEventsFromStore: () => Promise<unknown> | void,
 * }} deps
 */
export async function openPlanningLogisticsPopout(ev, opts, deps) {
  const producer = opts?.producer === true || ev?.producer === true || ev?.conferenceWatch === true;
  const eventId = String(ev?.id || '').trim();
  const slug = String(ev?.slug || '').trim();
  const body = document.createElement('div');
  body.className = 'events-finder__logistics';
  const loading = document.createElement('p');
  loading.className = 'muted';
  loading.textContent = 'Loading planning…';
  body.append(loading);

  deps.openConferencePopout({
    title: 'Planning & logistics',
    body,
    shellClass: 'events-finder__conference-popout--logistics',
    bodyClass: 'events-finder__conference-popout-body--logistics',
  });

  const logisticsPath = producer
    ? `/api/events-finder/big-events/${encodeURIComponent(slug)}/logistics`
    : `/api/events-finder/notable/${encodeURIComponent(eventId)}/logistics`;
  const savePath = producer
    ? `/api/events-finder/big-events/${encodeURIComponent(slug)}`
    : `/api/events-finder/notable/${encodeURIComponent(eventId)}`;
  const scrapePath = producer
    ? `/api/events-finder/big-events/${encodeURIComponent(slug)}/reservation-scrape`
    : `/api/events-finder/notable/${encodeURIComponent(eventId)}/reservation-scrape`;

  try {
    if (!producer && !ev.notable) {
      await deps.patchNotable(eventId, { notable: true, reminderLeadWeeks: 4 });
    }
    const res = await fetch(logisticsPath, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);

    const tp = data.tripPlanning || ev.tripPlanning || {};
    const draft = {
      beforeTrip: String(tp.beforeTrip || ''),
      travelLogistics: travelLogisticsFromTrip(tp),
      inRegion: inRegionFromTrip(tp),
      vikunjaProjectId: Number(tp.vikunjaProjectId) > 0 ? Number(tp.vikunjaProjectId) : null,
      beforeTripTasks: Array.isArray(tp.beforeTripTasks) ? tp.beforeTripTasks : [],
      packingList: tp.packingList || null,
      modules: tp.modules && typeof tp.modules === 'object' ? tp.modules : {},
    };

    body.replaceChildren();
    body.classList.add('events-finder__logistics--split');

    const main = document.createElement('div');
    main.className = 'events-finder__logistics-main';
    const sideRail = document.createElement('aside');
    sideRail.className = 'events-finder__logistics-side-rail events-finder__logistics-side-rail--region';
    sideRail.setAttribute('aria-label', 'Region intel');

    const head = document.createElement('h3');
    head.className = 'events-finder__conference-detail-title';
    head.textContent = String(ev.title || ev.query || 'Event');
    const whenEl = document.createElement('p');
    whenEl.className = 'events-finder__conference-detail-when';
    whenEl.textContent = [
      deps.formatWhen(ev.start) || ev.whenLabel || 'Date TBD',
      ev.city || ev.placeLabel || data.city || data.regionIntel?.city || '',
    ]
      .filter(Boolean)
      .join(' · ');
    main.append(head, whenEl);

    const tripStatus = document.createElement('p');
    tripStatus.className = 'events-finder__big-events-msg muted';
    tripStatus.hidden = true;

    function tripPayload() {
      return {
        packingList: draft.packingList,
        accommodations: draft.travelLogistics.trim() || null,
        flightsTransport: null,
        beforeTrip: draft.beforeTrip.trim() || null,
        notes: draft.inRegion.trim() || null,
        vikunjaProjectId: draft.vikunjaProjectId,
        beforeTripTasks: draft.beforeTripTasks,
        modules: {
          local: { notes: draft.inRegion.trim() || null },
          flights: { enabled: false, notes: null },
          transportation: { enabled: false, notes: null, destination: null },
          accommodations: { enabled: false, notes: null },
        },
      };
    }

    let tripAck = JSON.stringify(tripPayload());
    let tripTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
    let tripInFlight = false;
    let tripAgain = false;

    async function saveTripPlanning() {
      const payload = tripPayload();
      const serialized = JSON.stringify(payload);
      if (serialized === tripAck) return;
      if (tripInFlight) {
        tripAgain = true;
        return;
      }
      tripInFlight = true;
      tripStatus.hidden = false;
      tripStatus.textContent = 'Saving…';
      tripStatus.className = 'events-finder__big-events-msg muted';
      try {
        if (producer) {
          const outRes = await fetch(savePath, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tripPlanning: payload }),
          });
          const out = await outRes.json().catch(() => ({}));
          if (!outRes.ok || !out.ok) throw new Error(out.error || `HTTP ${outRes.status}`);
          const saved = out.item?.tripPlanning || payload;
          ev.tripPlanning = saved;
          ev.planningNotes = out.item?.planningNotes ?? ev.planningNotes;
          if (saved.vikunjaProjectId) {
            const created = !draft.vikunjaProjectId;
            draft.vikunjaProjectId = Number(saved.vikunjaProjectId);
            if (created) notifyProjectsChanged();
          }
          if (Array.isArray(saved.beforeTripTasks)) draft.beforeTripTasks = saved.beforeTripTasks;
        } else {
          const out = await deps.patchNotable(eventId, { notable: true, tripPlanning: payload });
          const saved = /** @type {any} */ (out)?.item?.tripPlanning || payload;
          ev.tripPlanning = saved;
          ev.planningNotes = saved.notes;
          if (saved.vikunjaProjectId) {
            const created = !draft.vikunjaProjectId;
            draft.vikunjaProjectId = Number(saved.vikunjaProjectId);
            if (created) notifyProjectsChanged();
          }
          if (Array.isArray(saved.beforeTripTasks)) draft.beforeTripTasks = saved.beforeTripTasks;
        }
        tripAck = JSON.stringify(tripPayload());
        tripStatus.textContent = 'Saved';
        void (producer ? deps.refreshBigEventsFromStore() : deps.loadEvents({ catalogOnly: true, quiet: true }));
      } catch (e) {
        tripStatus.className = 'events-finder__big-events-msg events-finder__big-events-msg--error';
        tripStatus.textContent = String(e?.message || e);
      } finally {
        tripInFlight = false;
        if (tripAgain) {
          tripAgain = false;
          void saveTripPlanning();
        }
      }
    }

    function scheduleTripSave() {
      tripStatus.hidden = false;
      tripStatus.textContent = 'Saving…';
      tripStatus.className = 'events-finder__big-events-msg muted';
      if (tripTimer) clearTimeout(tripTimer);
      tripTimer = setTimeout(() => void saveTripPlanning(), AUTOSAVE_MS);
    }

    /**
     * @param {{
     *   key: 'beforeTrip' | 'travelLogistics' | 'inRegion',
     *   label: string,
     *   hint?: string,
     *   placeholder: string,
     *   rows: number,
     *   scrape?: boolean,
     *   tasksLink?: boolean,
     * }} field
     */
    function addNoteBox(field) {
      const section = document.createElement('section');
      section.className = 'events-finder__logistics-box';

      const boxHead = document.createElement('div');
      boxHead.className = 'events-finder__logistics-box-head';
      const lab = document.createElement('h4');
      lab.className = 'events-finder__notable-subtitle';
      lab.textContent = field.label;
      boxHead.append(lab);

      if (field.tasksLink) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'events-finder__logistics-tasks-link';
        link.textContent = draft.vikunjaProjectId ? 'Open in Tasks' : 'Syncs to Tasks';
        link.addEventListener('click', () => {
          notifyProjectsChanged();
          if (draft.vikunjaProjectId) {
            const id = draft.vikunjaProjectId;
            setTimeout(() => notifySelectProject(id), 250);
          }
          focusTasksPanel();
        });
        boxHead.append(link);
      }

      if (field.scrape) {
        const scrapeBtn = document.createElement('button');
        scrapeBtn.type = 'button';
        scrapeBtn.className = 'events-finder__logistics-scrape';
        scrapeBtn.textContent = 'Scan inbox';
        scrapeBtn.title = 'Find flight, bus, hotel, and hostel confirmations';
        scrapeBtn.addEventListener('click', () => void runInboxScrape(scrapeBtn, field.key));
        boxHead.append(scrapeBtn);
      }

      const ta = document.createElement('textarea');
      ta.className = 'events-finder__notable-textarea events-finder__logistics-box-ta';
      ta.rows = field.rows;
      ta.placeholder = field.placeholder;
      ta.value = draft[field.key];
      ta.addEventListener('input', () => {
        draft[field.key] = ta.value;
        scheduleTripSave();
      });
      ta.addEventListener('blur', () => void saveTripPlanning());
      section.append(boxHead);
      if (field.hint) {
        const hint = document.createElement('p');
        hint.className = 'muted events-finder__logistics-box-hint';
        hint.textContent = field.hint;
        section.append(hint);
      }
      section.append(ta);
      main.append(section);
      return ta;
    }

    const beforeTa = addNoteBox({
      key: 'beforeTrip',
      label: 'Things to do before leaving',
      hint: 'One item per line. A Tasks category is created and kept in sync.',
      placeholder: 'Book flights\nConfirm lodging\nNotify work / house sit…',
      rows: 6,
      tasksLink: true,
    });
    const travelTa = addNoteBox({
      key: 'travelLogistics',
      label: 'Accommodations and travel logistics',
      hint: 'Flights, buses, hotels, hostels — check-in times, bag limits, confirmations.',
      placeholder: 'Flight UA123 · SFO→EWR · confirm ABC123\nBag: 50 lb checked\nHotel check-in 3pm…',
      rows: 8,
      scrape: true,
    });
    const regionTa = addNoteBox({
      key: 'inRegion',
      label: 'In-region notes',
      hint: 'Stuff to do, neighborhoods, food, local tickets.',
      placeholder: 'Walk the High Line\nDinner reservation…',
      rows: 6,
      scrape: true,
    });

    main.append(tripStatus);

    /**
     * @param {HTMLButtonElement} btn
     * @param {'travelLogistics' | 'inRegion'} target
     */
    async function runInboxScrape(btn, target) {
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = 'Scanning inbox…';
      tripStatus.hidden = false;
      tripStatus.textContent = 'Scanning reservation emails…';
      tripStatus.className = 'events-finder__big-events-msg muted';
      try {
        const scrapeRes = await fetch(scrapePath, { method: 'POST' });
        const j = await scrapeRes.json().catch(() => ({}));
        if (!scrapeRes.ok) throw new Error(j.error || `HTTP ${scrapeRes.status}`);
        if (!j.ok) {
          const why =
            j.error === 'no_reservation_mail'
              ? 'No reservation emails found for this trip.'
              : j.error === 'gmail_not_configured'
                ? 'Gmail intake is not connected.'
                : String(j.error || 'Inbox scan found nothing.');
          throw new Error(why);
        }
        if (j.travelLogistics) {
          draft.travelLogistics = mergeScraped(draft.travelLogistics, j.travelLogistics);
          travelTa.value = draft.travelLogistics;
        }
        if (j.inRegionNotes) {
          draft.inRegion = mergeScraped(draft.inRegion, j.inRegionNotes);
          regionTa.value = draft.inRegion;
        }
        if (target === 'inRegion' && j.inRegionNotes) {
          regionTa.focus();
        }
        await saveTripPlanning();
        tripStatus.textContent = j.scanned
          ? `Filled from ${j.scanned} email${j.scanned === 1 ? '' : 's'}.`
          : 'Inbox scan complete.';
      } catch (e) {
        tripStatus.className = 'events-finder__big-events-msg events-finder__big-events-msg--error';
        tripStatus.textContent = String(e?.message || e);
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    }

    renderRegionRail(sideRail, data, deps);
    body.append(main, sideRail);

    if (data.travelBrief && (data.travelBrief.researching || (!data.travelBrief.summary && !data.travelBrief.error))) {
      let polls = 0;
      const poll = async () => {
        polls += 1;
        if (polls > 24) return;
        try {
          const pollRes = await fetch(logisticsPath, { cache: 'no-store' });
          const j = await pollRes.json().catch(() => ({}));
          if (j.travelBrief) {
            data.travelBrief = j.travelBrief;
            if (Array.isArray(j.nwsAlerts)) data.nwsAlerts = j.nwsAlerts;
            renderRegionRail(sideRail, data, deps);
            if (j.travelBrief.summary || j.travelBrief.error) return;
          }
        } catch {
          /* ignore */
        }
        setTimeout(() => void poll(), 4000);
      };
      setTimeout(() => void poll(), 3500);
    }

    void beforeTa;
  } catch (e) {
    body.replaceChildren();
    const err = document.createElement('p');
    err.className = 'events-finder__big-events-msg events-finder__big-events-msg--error';
    err.textContent = String(e?.message || e);
    body.append(err);
  }
}

/**
 * @param {HTMLElement} rail
 * @param {any} data
 * @param {{ createPolygonWeatherIcon: (code: number, id: string) => HTMLElement }} deps
 */
function renderRegionRail(rail, data, deps) {
  rail.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'events-finder__logistics-region';

  const intel = data.regionIntel || { news: [], alerts: [], weather: [], travelEvents: [] };
  const brief = data.travelBrief;
  const nws = Array.isArray(data.nwsAlerts) && data.nwsAlerts.length
    ? data.nwsAlerts
    : brief?.nwsAlerts || [];

  addLinkSection(wrap, 'Local news', intel.news);
  if (brief?.sources?.length) {
    const extra = brief.sources.slice(0, 4).map((s) => ({
      label: s.title || s.url,
      detail: 'From local research',
      url: s.url,
    }));
    addLinkSection(wrap, 'Recent headlines', extra);
  }

  const alertsMount = document.createElement('section');
  alertsMount.className = 'events-finder__logistics-region-section';
  const alertsH = document.createElement('h4');
  alertsH.className = 'events-finder__notable-subtitle';
  alertsH.textContent = 'Current alerts';
  alertsMount.append(alertsH);
  if (nws.length) {
    const ul = document.createElement('ul');
    ul.className = 'events-finder__logistics-brief-alerts';
    for (const a of nws) {
      const li = document.createElement('li');
      li.textContent = a.headline ? `${a.event}: ${a.headline}` : String(a.event || 'Alert');
      ul.append(li);
    }
    alertsMount.append(ul);
  } else {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'No active weather alerts right now.';
    alertsMount.append(none);
  }
  appendLinks(alertsMount, intel.alerts);
  wrap.append(alertsMount);

  const wxMount = document.createElement('section');
  wxMount.className = 'events-finder__logistics-region-section';
  const wxH = document.createElement('h4');
  wxH.className = 'events-finder__notable-subtitle';
  wxH.textContent = 'Weather for your stay';
  wxMount.append(wxH);
  if (data.weather) wxMount.append(buildWeatherCard(data.weather, deps));
  appendLinks(wxMount, intel.weather);
  wrap.append(wxMount);

  const evMount = document.createElement('section');
  evMount.className = 'events-finder__logistics-region-section';
  const evH = document.createElement('h4');
  evH.className = 'events-finder__notable-subtitle';
  evH.textContent = 'Travel-impacting events';
  evMount.append(evH);
  const impactCats = new Set(['unrest', 'election', 'festival', 'construction', 'summit', 'transit']);
  const impactItems = Array.isArray(brief?.items)
    ? brief.items.filter((it) => impactCats.has(String(it.category || '')))
    : [];
  if (brief?.summary && impactItems.length) {
    const sum = document.createElement('p');
    sum.className = 'events-finder__logistics-brief-summary';
    sum.textContent = String(brief.summary);
    evMount.append(sum);
  }
  if (impactItems.length) {
    const ul = document.createElement('ul');
    ul.className = 'events-finder__logistics-brief-items';
    for (const it of impactItems) {
      const li = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = String(it.title || '');
      li.append(title);
      if (it.detail) {
        const d = document.createElement('p');
        d.className = 'muted';
        d.textContent = String(it.detail);
        li.append(d);
      }
      ul.append(li);
    }
    evMount.append(ul);
  } else if (!brief?.researching) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No large local disruptions found yet — use the searches below.';
    evMount.append(empty);
  } else {
    const pending = document.createElement('p');
    pending.className = 'muted';
    pending.textContent = 'Checking festivals, elections, and closures…';
    evMount.append(pending);
  }
  appendLinks(evMount, intel.travelEvents);
  wrap.append(evMount);

  rail.append(wrap);
}

/**
 * @param {HTMLElement} parent
 * @param {string} title
 * @param {{ label: string, detail?: string, url: string }[]} items
 */
function addLinkSection(parent, title, items) {
  if (!Array.isArray(items) || !items.length) return;
  const section = document.createElement('section');
  section.className = 'events-finder__logistics-region-section';
  const h = document.createElement('h4');
  h.className = 'events-finder__notable-subtitle';
  h.textContent = title;
  section.append(h);
  appendLinks(section, items);
  parent.append(section);
}

/**
 * @param {HTMLElement} parent
 * @param {{ label: string, detail?: string, url: string }[]} items
 */
function appendLinks(parent, items) {
  if (!Array.isArray(items) || !items.length) return;
  const ul = document.createElement('ul');
  ul.className = 'events-finder__logistics-list';
  for (const it of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = String(it.url || '#');
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = String(it.label || 'Link');
    li.append(a);
    if (it.detail) {
      const d = document.createElement('p');
      d.className = 'muted';
      d.textContent = String(it.detail);
      li.append(d);
    }
    ul.append(li);
  }
  parent.append(ul);
}

/**
 * @param {any} wx
 * @param {{ createPolygonWeatherIcon: (code: number, id: string) => HTMLElement }} deps
 */
function buildWeatherCard(wx, deps) {
  const wxWrap = document.createElement('div');
  wxWrap.className = 'events-finder__logistics-weather';
  wxWrap.setAttribute('aria-label', 'Stay weather forecast');

  if (wx.ok && Array.isArray(wx.days) && wx.days.length) {
    const row = document.createElement('div');
    row.className = 'events-finder__logistics-weather-days';
    for (const day of wx.days) {
      const card = document.createElement('div');
      card.className = 'events-finder__logistics-weather-day';
      const icon = deps.createPolygonWeatherIcon(day.code, `logistics-${day.date || 'd'}`);
      icon.classList.add('events-finder__logistics-weather-icon');
      const wd = document.createElement('span');
      wd.className = 'events-finder__logistics-weather-weekday';
      wd.textContent = String(day.weekday || '');
      const temps = document.createElement('span');
      temps.className = 'events-finder__logistics-weather-temps';
      const hi = day.highF != null ? `${day.highF}°` : '—';
      const lo = day.lowF != null ? `${day.lowF}°` : '—';
      temps.textContent = `${hi} / ${lo}`;
      const sum = document.createElement('span');
      sum.className = 'events-finder__logistics-weather-summary muted';
      sum.textContent = String(day.summary || '');
      if (day.precipProb != null && day.precipProb >= 20) {
        sum.textContent = `${sum.textContent}${sum.textContent ? ' · ' : ''}${day.precipProb}% rain`;
      }
      card.append(wd, icon, temps, sum);
      row.append(card);
    }
    wxWrap.append(row);
  } else {
    const miss = document.createElement('p');
    miss.className = 'muted';
    miss.textContent =
      wx.reason === 'no_forecast_days'
        ? 'Daily forecast appears once your stay is within 16 days.'
        : wx.reason === 'no_coords'
          ? (wx.city && wx.city !== 'destination'
            ? `Daily cards need a map pin — use the ${wx.city} forecast link below.`
            : 'Add a city to load a local forecast.')
          : 'Forecast unavailable right now — use the link below.';
    wxWrap.append(miss);
  }
  return wxWrap;
}
