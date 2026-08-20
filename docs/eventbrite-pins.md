# Eventbrite pins

Paste one Eventbrite **organizer**, **collection**, **format/browse**, or **search** URL
per line below **Pins**. Merged into the Events finder Eventbrite scrape alongside the
default city + category listings (`events-finder-public-pages.js`).

**Why:** city `/d/` and category `/b/` first pages rank popular parties/concerts first.
Series like Lectures on Tap often never appear there even when tickets are live.

**Accepted formats:**

```
https://www.eventbrite.com/o/lectures-on-tap-86136754923
https://www.eventbrite.com/cc/lectures-on-tap-sf-august-2026-4856059
https://www.eventbrite.com/d/ca--san-francisco/lectures/
https://www.eventbrite.com/d/ca--san-francisco/events/?q=science+lecture
```

- Prefer **organizer** (`/o/…`) URLs for recurring series (lists upcoming `/e/` tickets).
- **Collection** (`/cc/…`) URLs work for a month’s batch but go stale — prefer `/o/` when possible.
- Format paths (`/lectures/`, `/science-and-tech/lectures/`) catch bar/science talks the generic city feed misses.
- Keyword search (`?q=…`) catches similar organizers without a dedicated pin.
- Lines starting with `#` are comments; blank lines ignored.

Built-in (also fetched when this file is missing): Lectures on Tap organizer, SF lectures
format, science+tech lectures, and a few science/lecture keyword searches.

---

## Pins

<!-- one URL per line below this heading -->

# Organizers — recurring science / lecture-in-a-bar series
https://www.eventbrite.com/o/lectures-on-tap-86136754923
# Current SF month collection (update when a new month drops)
https://www.eventbrite.com/cc/lectures-on-tap-sf-august-2026-4856059

# Format + category×format (city first-page misses these)
https://www.eventbrite.com/d/ca--san-francisco/lectures/
https://www.eventbrite.com/d/ca--san-francisco/science-and-tech/lectures/
https://www.eventbrite.com/d/ca--oakland/lectures/

# Keyword discovery (similar series + fail/nerd nights when ticketed)
https://www.eventbrite.com/d/ca--san-francisco/events/?q=lectures+on+tap
https://www.eventbrite.com/d/ca--san-francisco/events/?q=science+lecture
https://www.eventbrite.com/d/ca--san-francisco/events/?q=bar+lecture
https://www.eventbrite.com/d/ca--san-francisco/events/?q=low+key+lectures
https://www.eventbrite.com/d/ca--san-francisco/events/?q=fail+night
https://www.eventbrite.com/d/ca--san-francisco/events/?q=nerd+nite
https://www.eventbrite.com/d/ca--san-francisco/events/?q=science+social
