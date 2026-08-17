# Opportunity Watch — roles panel

**Purpose:** Watch STRATEGY-aligned opportunities at Anthropic, Google, and OpenAI (jobs, contracts, fellowships, grants) and assess brand-new postings — in a dedicated left-rail **Opportunity Watch** card, not Local News.

> Internal identifiers still say `job-watch` (files, CSS classes, `/api/job-watch`). Only the user-facing name changed.

**Strategy source:** portfolio `products/applications/anthropic/STRATEGY.md`  
**Config:** `src/data/job-watch-targets.json`  
**State:** `data/job-watch.json`  
**API:** `GET/POST /api/job-watch`

---

## What moved out of Local News

Feed `anthropic-careers-bd` is stripped from Local News subscriptions on load/save (`stripCareersFeedFromNews`). Anthropic **news** feeds (site HTML + Google News BD) stay in Local News. Careers belong here.

---

## Watched targets (grey → green sparkle)

| Priority | Target | Icon when open |
|----------|--------|----------------|
| 1 | Applied AI Architect (IC), BD | Green sparkle star |
| 1 | Customer / Partner Success, BD | Green sparkle star |
| 2 | Partnerships / GTM — agri or global development | Green sparkle star |
| Watch | Gates agriculture / smallholder | Green sparkle star |
| Watch | Economic mobility / Claude Corps | Green sparkle star |
| Queued | Startup Partnerships Lead | Green sparkle star |

Closed targets show a **solid grey crystal**.

### OpenAI (Ashby)

| Priority | Target |
|----------|--------|
| 1 | Forward Deployed Engineer, Gov |
| 1 | AI Success Engineer, Government |
| 2 | Partner AI Deployment Engineer |
| Watch | AI Success / Education |
| Watch | Academic / research partnerships |

Board: `https://api.ashbyhq.com/posting-api/job-board/openai` (`type: ashby`, `includeCompensation=true`).

### UNOPS (manual shortlist)

Curated home-based retainers that cleared a recruiter-brief scan (`docs/un-job-fit-shortlist.md`). Source `type: manual` — jobs live in `job-watch-targets.json`, not a live board poll.

| Priority | Target |
|----------|--------|
| 2 | GPA Policy Advisor — energy in displacement |
| Watch | Climate Finance Senior Advisor (retainer) |

### Scale AI / Breakthrough Energy / Elemental / GEAPP (Greenhouse)

| Priority | Target |
|----------|--------|
| 2 | Scale — AI Advisory Principal |
| Watch | Scale — public sector deployment / engagement |
| 2 | Breakthrough Energy — GRIDS / grid & energy |
| 2 | Elemental Impact — climate programs (not fundraising) |
| 2 | GEAPP — grids / energy access (not fundraising) |

### World Bank / IMF / Gates / Rockefeller / IRENA / IEA (careers links; no public job API)

Named lanes stay grey until a posting is pasted into the manual source. Org cheat-sheet: `docs/mission-orgs.md`.

| Priority | Target |
|----------|--------|
| 2 | World Bank — Energy / ESMAP (GG–GH, DC) |
| Watch | IMF — climate/energy policy (not econ bench) |
| 2 | Gates — ag / energy / WASH / public-interest AI |
| 2 | Rockefeller — Power / GEAPP (Director, not SVP) |
| Watch | IRENA — renewables programme (not junior P-1 / Bonn-only) |
| Watch | IEA — energy policy / electricity systems (not junior PAL / Paris-only) |

---

## Default region filter

On every Dashbird page load, Opportunity Watch **resets Region to Bay Area + NYC Area** (closed lanes and DC/Denver/etc. postings stay hidden until you check them). You can change the checkboxes during the session; a refresh puts the default back.

---

## Row contents

Every row shows priority tier, posted / not posted, and opportunity **type**. Open rows add the
**amount** and location, and the title links to the posting.

| Field | Source |
|-------|--------|
| Type | Title/body keywords → `Full-time`, `Contract`, `Fellowship`, `Internship`, `Residency`, `Grant`, `Fixed-term`, `Part-time`. Closed rows fall back to the target's `kind` in the config. |
| Amount | Parsed from the posting body (`Annual Salary: $215,000 — $300,000 USD`), shown compact as `$215K–$300K`. Hourly pay renders as `$85/hr`. |

**Pay floor:** **$180,000/year** (`compFloorAnnualUsd` in the targets file). If a USD posting’s published max (hourly × 2080 if needed) is below that, `assessJob` returns `pass` — the row can still show as a watched target, but it is not apply-now and will not yellow-dot. Unknown / non-USD pay is not auto-failed.

Greenhouse publishes no structured pay field and its `content` is **double** HTML-escaped, so
`job-watch-detail.js` unescapes twice before stripping tags. About 355 of 398 Anthropic postings
publish a range; the rest render `No published range`.

Detail requests only run for **surfaced** rows (open targets + live candidates), are capped at 12
per scan, and are cached in `state.details` keyed by the posting's `updated_at`.

---

## Match stars (1–3)

Live posted matches use `assessJob` score → stars. Weak / near hard-pass roles
rarely reach the panel, so the scale stays short:

| Score | Stars | Meaning |
|------:|:-----:|---------|
| 9–10 | ★★★ | Strong apply / burn-worthy |
| 7–8 | ★★☆ | Solid fit, read JD carefully |
| 1–6 | ★☆☆ | Partial / queued / canary |

Closed lanes show **expected** stars from priority (P1 = 3, P2/Watch = 2, Queued = 1) at lower opacity until a posting is live.

---

## Cadence

- Server scheduler: **every 2 hours** (`startJobWatchScheduler`, `JOB_WATCH_INTERVAL_MS`)
- Startup scan ~25s after listen
- Panel refresh: reads `/api/job-watch` every 5 minutes (triggers scan if snapshot &gt; 2h stale)
- Manual: **Scan now** in the card header / footer

Disable with `JOB_WATCH=0`.

---

## Assessment plan (new postings)

When a job ID appears that was not in the previous snapshot:

1. **Hard-pass** — clinical / Global Health, Life Sciences eng-manager, Evangelist/DevRel, Head of Applied AI Architecture BD, pure research/RL/pretraining → verdict `pass`, no yellow dot.
2. **Watch-target match** — updates the target row to open (green star); not duplicated as a yellow candidate.
3. **IC-wave canary** — BD leadership seats that signal staffing but are do-not-apply → yellow dot, verdict `canary`.
4. **Interest heuristics** — BD / nonprofit / agri / mobility / Architect / Success cues → score 0–10, verdict `maybe` or `burn`.
5. **Location** — SF / NYC / Bay preferred; other offices noted as weaker.
6. **Recommendation prose** — stored on the candidate; shown when the yellow dot is clicked.

### Yellow dot UI

- Unreviewed candidate → yellow glowing dot.
- Click the **dot** → modal with type, amount, close-fit (`strong` / `partial` / `weak` / `none`), score, verdict, recommendation, reasons. The candidate **title** is a link straight to the posting.
- Close marks **reviewed**; Dismiss hides the row.

### First scan

Baselines each source board into `knownJobIds` **without** creating yellow dots. Only jobs that appear on a later scan become candidates.

---

## Related

- Local News BD news monitoring: `docs/anthropic-bd-news-monitoring.md` (news only; careers → this doc)
- IC-wave canary prompt: `docs/anthropic-bd-ic-wave-trigger-prompt.md`
