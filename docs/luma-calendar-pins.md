# Luma calendar pins

Paste one Luma **calendar hub**, **discover place**, or **event** URL per line below **Pins**.
Ingested via public HTML (`__NEXT_DATA__`) + Luma APIs into the Events SQLite catalog
(cached ~6h in `data/luma-events-cache.json`):

- Calendar hubs → `api.lu.ma/calendar/get-items`
- Discover places (e.g. SF city feed) → `api.lu.ma/discover/get-paginated-events`
- Event pages → single-event parse from `__NEXT_DATA__`

**Accepted formats:**

```
https://luma.com/sf
https://luma.com/Big-Brain-SF
https://lu.ma/tiat
https://luma.com/4esilsg5
```

- Prefer calendar hub / discover-place URLs for ongoing ingest (lists upcoming events).
- Event page URLs are also accepted (single-event upsert).
- `lu.ma/…` redirects to `luma.com/…`; both work.
- Lines starting with `#` are comments; blank lines ignored.

**Link check (2026-07-10):** SF discover-place + hub calendars return HTTP 200;
SF paginates via get-paginated-events (~57 upcoming).

---

## Pins

<!-- one URL per line below this heading -->

https://luma.com/sf
https://luma.com/9zero
https://luma.com/Big-Brain-SF
https://luma.com/genai-sf
https://luma.com/buildercommunityanz
https://luma.com/climatecafe
https://luma.com/climatedraft-community
https://luma.com/frontiertower
https://luma.com/netzeroinsights
https://luma.com/outinclimate
https://luma.com/sf-builders-collective
https://luma.com/sf-hardware-meetup
https://luma.com/theclimateparty
https://luma.com/tiat
https://luma.com/h.h
https://luma.com/4esilsg5
https://luma.com/ghnew59o
