# Daily Summary — email ingestion guide

Edit this file (or **Settings → Daily Summary**) to tune what intake mail becomes action items on the main page.
Scans **intake** + **your-gmail** every ~30 minutes (rolling 10-day window).

**Runtime enforcement:** Never show is always hard-excluded in code. Soft skip and Prefer less are omitted unless a Show these / Prefer more line also matches. The LLM still reads this guide; code is the backstop.

---

## Principles

- Return **durable action items**, not a filtered mail list — prefer thematic tasks over subject lines.
- **Deduplicate**: same sender + same ask → one item citing the newest message.
- **Events / RSVPs / workshops** belong in Events Finder, not Daily Summary.
- **Verification / OTP / magic-link** mail is never an action item.

---

## Show these (important)

Create action items when mail matches any of these patterns:

- Deadlines I own or need to meet
- Scheduling that needs a yes/no from me
- Money, contracts, or docs to sign
- Travel or logistics needing confirmation
- Anything waiting on my reply
- Important personal/family follow-ups

---

## Soft skip

Down-rank or omit **only when not** also covered under **Show these**:

- FYI newsletters with weak or no action
- Automated status updates I only need to skim
- CC threads where someone else owns the next step

---

## Never show

Always exclude — even if something else might match:

- Pure marketing / promo blasts
- Account verification / magic links / sign-in OTP emails
- Password resets and security codes
- Event invites, RSVPs, info sessions, workshops (Events Finder)
- Shipping/delivery noise with no action needed
- Unsubscribe / list hygiene mail
- Anything from @westernp.com

---

## Learned preferences

Appended from 👍 / 👎 on Daily Summary items. One bullet per feedback; edit freely.
Repeated similar 👎 on the same pattern auto-promotes: **Prefer less** → **Soft skip** (3×) → **Never show** (5×).

### Prefer more like this

<!-- thumbs-up appends below -->

### Prefer less like this

<!-- thumbs-down appends below -->
