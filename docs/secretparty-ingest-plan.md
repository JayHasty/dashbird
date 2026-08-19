# Secret Party ingest — automated gap plan

Secret Party is **wired** for Dashbird via **Intake Gmail** (primary) plus an optional **public watchlist**. There is no Partiful-style city Explore feed.

## What is wired now

| Path | Behavior |
| --- | --- |
| Gmail intake | Query includes `from:secretparty.io`. Body/HTML URLs matching `*.secretparty.io` become catalog events with `source: secretparty`. |
| Watchlist | URLs under **Secret Party** in [`events-sample-urls.md`](events-sample-urls.md) are fetched on each feed load (`events-finder-public-pages.js`). |
| Title fallback | If the page/subject is generic “Secret Party”, title is derived from the subdomain slug. |

## Significant gaps (cannot scrape away)

1. **Private / semi-private events** — public HTML and unauthenticated API cannot see them. Only invite/notification email to an intake inbox works.
2. **No city discovery** — `robots.txt` is `Disallow: /`; marketing site has empty `__NEXT_DATA__`; `api.secretparty.io/events/…` returns **401**. There is no SF/Bay listing to crawl.
3. **Thin public event pages** — SSR often ships generic OG tags only; dates/venues may be missing unless the invite mail has `.ics` or a parseable date.

## Automated follow-ups (run / check periodically)

### A. Account routing (one-time, then verify quarterly)

- [ ] In the Secret Party account UI, set notification / invite email to `intake@example.com` (or another address in `GMAIL_INTAKE_ADDRESSES`).
- [ ] Trigger a test invite to yourself; confirm a message appears in intake within ~1 day.
- [ ] Confirm Settings → Events sources → Intake Gmail rows stay **Connected** (IMAP/OAuth).

### B. Mail parse smoke (each deploy or weekly)

```bash
curl -s 'http://127.0.0.1:8787/api/events-finder-gmail/status' | jq '.probe.accounts'
curl -s 'http://127.0.0.1:8787/api/events-finder/events' | jq '.store.bySource.secretparty, [.events[]|select(.source=="secretparty")]|length'
```

Expect: both inboxes `ok`; `secretparty` count rises when real invites land.

### C. Watchlist growth (when you see a public party)

- [ ] Paste `https://<slug>.secretparty.io/` into the Secret Party section of [`events-sample-urls.md`](events-sample-urls.md).
- [ ] Reload Events feed; confirm a `secretparty` row appears (title at least from slug).

### D. Future API (only if credentials appear)

- [ ] If Secret Party ever grants a public/read API token, wire `api.secretparty.io` behind env (`SECRETPARTY_API_TOKEN`) and prefer it over HTML.
- [ ] Until then, do **not** block the feed on public crawl — keep Gmail primary.

## Manual spot-check reminder

Compare live Secret Party invite mail / public event pages against the Events sidebar after routing email, to confirm nothing important is missing from ingest.
