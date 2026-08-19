# Events sample URLs (seed / parse fixtures)

Personal fixtures for P0 ingest. Trim trailing spaces; prefer `https://`.

## Partiful (event pages)

**City discovery (wired):** `https://partiful.com/explore/sf` is fetched automatically on each feed load (Bay Area public Explore).

Optional extra watchlist URLs (merged with Explore):

```
https://partiful.com/e/sNG4KUUrbwYskFZtXVUm
https://partiful.com/e/IIlhGomgXdZiH0o64FrT
https://partiful.com/e/rFuJxDXFtkGVUWOq8reK
https://partiful.com/e/hgFB26jigU4DfLaqU3wn
https://partiful.com/e/r6rIrHJEYDzTtfcexyRO
https://partiful.com/e/JqsqeIT0qcfGa6ole785
https://partiful.com/e/DMRUVpMFWsuxbTLn1kHB
```

Checked titles (approx): EBPG July Potluck; Elysian Mothership; Philosophy Slumber Party #31; Re-Animate NYE; Holiday Art Market; Carmen Sandiego at Euclid; NYC Climate Week Decompression.

## Secret Party (event subdomains)

**No public explore / list API** (`robots.txt` Disallow; `api.secretparty.io` needs auth). Events are share links on `https://<slug>.secretparty.io/`.

**Primary path:** route Secret Party notification/invite email → intake Gmail (`intake@example.com`). Gmail already matches `from:secretparty.io` and `*.secretparty.io` URLs.

Optional public watchlist (paste known public event URLs; one per line):

```
https://bass-barley-block-party.secretparty.io/
```

Gap plan: [`docs/secretparty-ingest-plan.md`](secretparty-ingest-plan.md).

## Luma (calendar hubs + event pages — wired)

**Path:** pinned calendars/events in [`luma-calendar-pins.md`](luma-calendar-pins.md) →
`events-finder-luma.js` (HTML `__NEXT_DATA__` + `api.lu.ma/calendar/get-items`) →
cache `data/luma-events-cache.json`.

**City discover (SF):**

```
https://luma.com/sf
```

**Hub calendars (from screenshot):**

```
https://luma.com/Big-Brain-SF
https://luma.com/frontiertower
https://luma.com/sf-hardware-meetup
https://luma.com/tiat
```

**Extra event-page pins** (also in the pin file):

```
https://luma.com/4esilsg5
https://luma.com/ghnew59o
```

Titles: AI Philosophy Nights; Create for Good. (`lu.ma/…` redirects to `luma.com/…`.)

Gmail intake also catches Luma invite mailers (`from:lu.ma`).

## Meetup (groups / search)

**Path:** dual lane — **email** for groups you join; **public find + pins** for discovery.

**Pin list (fill this):** [`meetup-group-pins.md`](meetup-group-pins.md)

| Mode | Intent |
| --- | --- |
| Email intake | Invites / digests / `.ics` via Intake Gmail |
| Group pins | Public upcoming from `meetup.com/<slug>/events/` — **wired** (`events-finder-meetup.js`, cache `data/meetup-events-cache.json`) |
| Location find | `meetup.com/find/?location=…&source=EVENTS` (planned) |

**Pin candidates** (need URLs in the pin file):

- SF Hardware Meetup (also appears as a Luma hub — may ingest both)
- Noisebridge

## Eventbrite (public listings — no API key)

Explore via destination URLs (JSON-LD / `__SERVER_DATA__`), e.g.:

```
https://www.eventbrite.com/d/ca--san-francisco/events/
https://www.eventbrite.com/b/ca--san-francisco/science-and-tech/
https://www.eventbrite.com/b/ca--san-francisco/arts/
https://www.eventbrite.com/d/ca--oakland/events/
```

**Wired:** city listing + category browse pages (`science-and-tech`, `arts`, `music`,
`film-and-media`, `food-and-drink`, `community`, `fashion`, `health`) and Oakland
city listing when the dashboard geo is Bay Area. Override categories with
`EVENTBRITE_CATEGORY_SEEDS`.

Official REST search needs a token and is optional later.

## Multiverse School (public Google Calendar — wired)

All-school calendar: https://themultiverse.school/calendar  
Public ICS (from the page embed): Google Calendar `basic.ics` for the Multiverse School calendar. Module: `events-finder-multiverse.js` → `data/multiverse-events-cache.json`.

## dorkbotSF (public homepage — wired)

Homepage (next meetup): https://dorkbotsf.org/  
Archive deep links: `https://dorkbotsf.org/archive/YYYYMM/` (e.g. https://dorkbotsf.org/archive/202606/).  
Module: `events-finder-dorkbotsf.js` → `data/dorkbotsf-events-cache.json`.  
Note: `/calendar.html` embeds a Google Calendar that is **not** publicly ICS-exportable (404); HTML is the source of truth. Facebook group pin remains complementary.

## Other orgs (not wired yet)

- Noisebridge — name only; add site/calendar/Meetup URL when ready.
