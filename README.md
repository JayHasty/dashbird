# dashbird

Local **homepage dashboard** (Dashy-inspired glass UI): hero weather/clock, bookmark tiles, Google Calendar, tool library, sky/earth sidebars, and plain-text notes. Runs on your home network via Docker Compose.

Planning and deferred work: [`docs/v2-roadmap.md`](docs/v2-roadmap.md)  
Security operating plan: [`docs/security-plan.md`](docs/security-plan.md)  
**Backups (daily + weekly):** [`docs/backups.md`](docs/backups.md)  
Cross-project naming: [`docs/naming-system.md`](docs/naming-system.md)

## Current product truth

- **Local LAN only** — trusted home Wi‑Fi; do not port-forward to the public internet.
- **No login/password** on the dashboard itself for this deployment model (network boundary is your LAN; see security plan).
- **Chat** is out of scope for this repo.
- **CompHealth** is a separate project concern (not in this repo).
- **House Hunter**, **Events**, and **Local News** appear in the UI as **visual placeholders only** — not shipped features. Real development is tracked in the v2 roadmap.
- **OpenRouter** is the current AI enrichment provider (tool library ratings fallback); other providers are v2.

This repo supersedes the earlier **`homeassistantdashboard`** workspace.

## Quick start

1. Copy environment template:

   ```bash
   cp .env.example .env
   ```

2. Run with Docker Compose (service name **`dashboard`**):

   ```bash
   docker compose up --build
   ```

3. Open **`http://127.0.0.1:8787/`** (or `HOST_PORT` from `.env`). The container listens on **3000** internally; Compose publishes **`HOST_PORT` on all host interfaces** (`0.0.0.0`).

### Phone on the same Wi‑Fi

Use your PC’s **LAN IP**, not `127.0.0.1`.

After **`docker compose up`**, the **`lan-url`** service prints a bookmark URL in compose logs and writes **`public/data/phone-lan-url.txt`**.

```bash
docker compose logs lan-url
npm run lan-url
```

Example: `[dashbird] Phone (same Wi-Fi): http://192.168.1.42:8787/`

Optional: set **`DASHBOARD_LAN_ORIGIN`** in `.env` to override the auto-detected origin (no trailing slash).

**If the page does not load:** allow the port on the host firewall (e.g. `sudo ufw allow 8787/tcp`), confirm phone and PC share a subnet, and disable router AP/client isolation if enabled.

**Security:** anyone on your LAN who knows the IP can open the dashboard. That is acceptable for trusted home Wi‑Fi only. Do not expose this port to the internet.

### Local Node (without Docker)

```bash
npm install
npm start
```

Default `PORT` is **3000** when not using Compose.

## Layout (current UI)

- **Top bar:** brand, page tabs (main dashboard, House Hunter placeholder, Settings), live location context (GPS-first).
- **Main column:** web search, hero, bookmarks, calendar, tool library, notes.
- **Left sidebar (life):** Events and Local News **placeholders** (visual cues; v2 roadmap).
- **Right sidebar (sky):** Today’s To Do, Sky & Space, Earth, weather radar, magnetosphere, geoelectric field, market watch.

House Hunter is a separate topbar page — also a **placeholder** until v2.

## Configuration

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port inside the container / for `npm start` |
| `HOST_PORT` | Host port published by Compose (default `8787`) |
| `DASHBOARD_LAN_ORIGIN` | Optional full origin for phone/LAN bookmark link |
| `GOOGLE_CALENDAR_ICAL_URL` | Public iCal URL (Settings / calendar panel) |
| `GOOGLE_OAUTH_CLIENT_ID` / `SECRET` | Gmail Events intake OAuth (Settings → Connect Gmail) |
| `GMAIL_INTAKE_ADDRESS` | Default `intake@example.com` |
| `WEATHER_LAT` / `WEATHER_LON` | Fallback coordinates when GPS is denied |
| `SF_WEATHER_LAT` / `SF_WEATHER_LON` | Fallback second hero city when Secondary ZIP is unset/disabled (default San Francisco) |
| `OPENROUTER_API_KEY` | Optional; tool library AI rating fallback |
| `VIKUNJA_BASE_URL` / `VIKUNJA_TOKEN` | Vikunja instance + API token (Today’s To Do) |
| `VIKUNJA_PROJECT_ID` | Project used for list/create in the todo panel |

Commented placeholders are listed in [`.env.example`](.env.example).

**Today’s To Do** reads and writes Vikunja through `/api/vikunja` (tokens stay on the server). Compose starts a local Vikunja on port **3456**; set `VIKUNJA_*` in `.env` (see `.env.example`). Without those env vars the panel shows a setup hint.

## Product backlog

Tracked in [`docs/v2-roadmap.md`](docs/v2-roadmap.md), including:

- Google Keep snippets, Home Assistant proxy (Vikunja todos are live — see below)
- **House Hunter**, **Events**, **Local News** (real builds — UI slots exist as placeholders)
- **Network CRM** (friends + business contacts) with Telegram classifier (event/todo/note/contact) and web enrich
- Life-goals / refocus panel, agent daily-ops, bioclock notes, Amazon package banner
- Cybersecurity audit cadence (see security plan)
- Optional AI provider pluggability beyond OpenRouter

## Browser home / new tab

Set your browser home page or custom new tab URL to this app’s origin (e.g. `http://127.0.0.1:8787/`).

## Editing tiles and notes

- **Personal** tiles: [`public/data/bookmarks-personal.json`](public/data/bookmarks-personal.json)
- **Admin** tiles: [`public/data/bookmarks-work.json`](public/data/bookmarks-work.json)
- **Background:** [`public/assets/dashboard-bg.jpg`](public/assets/dashboard-bg.jpg)
- **Notes:** [`public/data/notes.md`](public/data/notes.md)

Bookmark links are normal **https://** URLs opened in a new tab.

Docker Compose mounts **`./public`** and **`./src`**, so static/panel changes often need only a refresh. After server or dependency changes, run **`docker compose up --build`**.

## Validation

```bash
npm run smoke:core
```

Core checks: OpenRouter health, tool ratings, Atlantic storm watch, weather radar.

## Tool Library ratings telemetry

`GET /api/tool-library/ratings` logs structured events (`sourceUsed`, `nullRating`, `latencyMs`).  
`GET /api/tool-library/ratings/debug` exposes in-memory counters for local debugging.

## Architecture

- **Express** serves `public/` and [`docs/`](docs/) at **`/docs/...`**.
- **Panels** are ES modules under [`public/js/panels/`](public/js/panels/), loaded from [`public/js/app.js`](public/js/app.js).
- **APIs:** `GET /api/config`, `GET /api/sky-events`, `GET /api/openrouter/health`, `/api/vikunja/*` (Vikunja proxy + `/todos` panel helpers), tool library routes, web catalog routes; **`501`** stub for `/api/home-assistant/*` (v2).

### Location and weather

Hero weather and rain alert are **GPS-first** (prompt per user/device/browser), with fallback to `WEATHER_ZIP` / `WEATHER_LAT`+`WEATHER_LON` when permission is denied.

### Earth strip (strict)

Atlantic storm rows appear only for **Atlantic Category 1+** systems with **projected land impact** in NHC advisory text. Puerto Rico risk uses a `!` marker when advisory text indicates hit or near-pass.

### Sky events

Hand-edited [`src/data/sky-events-calendar.json`](src/data/sky-events-calendar.json) plus live merges (geomagnetic, aurora, etc.). See existing calendar `sources` and NOAA/SWPC endpoints in that file.

### Developer connectivity checks

`POST /api/dashboard-check` and `src/lib/dashboard-check.js` remain for automated probes during development/smoke workflows — not exposed as an end-user “system sidebar” UI.

## Home Assistant / Lovelace vs this app

You can still set browser home to **Home Assistant Lovelace** for entity control. **dashbird** is a separate mixed “browser life” dashboard (weather, sky/earth, bookmarks, calendar, tools, notes).

## License

Private project unless you add a license.
