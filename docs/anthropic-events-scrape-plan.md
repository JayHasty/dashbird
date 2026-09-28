# Anthropic events scrape plan

**Rule:** only tag an event `anthropic` when the listing **names Anthropic employees** (or says Anthropic staff / teammates). Community ambassadors do not count.

## Sources (ingest)

| Source | How | Employee bar |
|---|---|---|
| [luma.com/claudecommunity](https://luma.com/claudecommunity) | Luma pin (hub). Already in `docs/luma-calendar-pins.md`. | Tag only if copy says Anthropic staff / `@ Anthropic` / a known BD name. |
| [anthropic.com/events](https://www.anthropic.com/events) | Official page. JS-heavy; refresh weekly + paste new URLs into pins if parse fails. | Company event. Still extract speaker names before treating as BD-useful. |
| Claude for Nonprofits webinars | `anthropic.com/webinars` | Melissa Heinz, Alex Lyons, Aarushi Karandikar have already presented. High BD signal. |
| Climate Week NYC (20–27 Sep 2026) | Manual watch. [climateweeknyc.org](https://www.climateweeknyc.org/) | AI Forum speakers are **not** Anthropic. [Building with Claude lunch](https://luma.com/claude-av7h) is **ambassadors only** — do not tag. |

## Tag + logistics

When employees are confirmed, Dashbird:

1. Adds tag **`anthropic`** (purple chip on the Events card).
2. Turns on the **logistics** tag.
3. Writes notes: who, why, usefulness (high = BD/CS names; medium = unnamed Anthropic staff; low = ambassadors / unconfirmed).

## Calendar bar

Events Finder **Cal** button writes a Google Calendar event. That is what the top **Next on calendar** bar reads. Do not auto-add unconfirmed listings to the personal calendar.

## Cadence

- Luma hub: existing 6h cache.
- Official Anthropic events page: re-check on Events refresh.
- Climate Week: one pass before 20 Sep; only tag if a named employee appears.
