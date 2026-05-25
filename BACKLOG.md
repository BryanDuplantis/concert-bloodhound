# Concert Bloodhound — Backlog

Deferred work, newest at top. The live MVP runs on Ticketmaster; items here are
not blocking it.

---

## Open-feed federated source — Phase 1 SHIPPED (2026-05-25); Phase 2/3 backlog
On-demand, stateless open-feed layer, live and merged into `search_concerts`.

**Shipped (Phase 1).** `src/feeds/` (iCal parser + registry + fetch/cache/normalize);
Cobb Travel & Tourism iCal wired for the Atlanta metro, filtered to its own
"Music & Concerts" category, deduped against TM, attributed per source, resilient to
a TM outage. Verified: `npm run smoke:feeds` returns 7 live Cobb music events TM
doesn't carry; merge + parser unit-tested.

**Finding — Localist (GSU/KSU) is dead in summer.** University recital calendars
publish near-term; in late May they return ~0 music events. `venue_id` filtering is
also broken on the v2 API (returns `total=1`/`events:[]`). Revisit in fall (Aug+);
filter by place id (GSU Kopleff `272271` / KSU Bailey `31678877210426`) via
client-side venue-name match, NOT `keyword`/`search` (both return non-music noise).

**Phase 2 (iCal expansion).** Battery ATL (108 live events) + Piedmont Park lack
usable CATEGORIES — would need a SUMMARY keyword classifier (riskier; weigh against
"never invent"). Cobb's pattern (trust the publisher's category) is the gold path.

**Phase 3 (RSS).** Red Light Café, GA Tech Arts — adds an RSS/XML parser dep.

**Refinement noted.** Cobb's "Music & Concerts" category is broad — includes musicals
("Footloose"), comedy open mics, festivals alongside concerts. Honest (publisher's own
category) but loose for a strict concert finder; consider a sub-filter if it proves noisy.

---

## Web-app pivot — multi-source federated aggregator (NOT YET STARTED)
_Referenced by `docs/atlanta-source-map.md` but not tracked here until now (2026-05-25)._

The on-demand MCP nails "what's <artist> doing near me" but structurally misses
the long tail — free civic series, university recitals, indie/DIY venues, and the
free Atlanta Jazz Festival. The map's core finding: that tail lives in open
iCal/RSS/JSON feeds (Trumba, Localist, venue RSS), not ticketing APIs — which
favors a **background-fetch model** (poll feeds on a schedule into a local store)
over pure on-demand, i.e. a small web app rather than (or alongside) the MCP.

- **Build-order spec:** `docs/atlanta-source-map.md` — Tier 1 (clean open feeds),
  Tier 2 (tiny static HTML), plus the verified dead-ends list.
- **Vision mock:** `atlanta-this-weekend.html` is a hand-built mock of the digest
  output — there is no generator for it yet.
- **Independent of the JamBase blocker** (these feeds need no JamBase key).
- Not scoped/phased — write a phased plan before building.

---

## JamBase 2nd source — BLOCKED on JamBase-side key provisioning
_Parked 2026-05-23. Scaffolded & committed (`daa4da4`); NOT wired into the live tools._

**Blocker.** The API rejects the `.env` key (ends `LjzS`) with `api_key_inactive`.

**Corrected diagnosis (this is NOT key-rotation grace — that earlier theory is dead).**
A control test on 2026-05-23 settled it:

| key sent | response |
|---|---|
| deliberately fake string | `api_key_inactive` — "is inactive" |
| our real `…LjzS` key | `api_key_inactive` — "is inactive" |
| empty | `missing_api_key` |

`api_key_inactive` is JamBase's **generic rejection for any string that isn't a
recognized, provisioned key** — a fake key gets the identical error. Our key is
being treated exactly like garbage. Revoking the "old" key and waiting for the
5/24 rotation expiry were both chasing a misread; the API has never once
distinguished our key from noise. Base URL + `apikey` query-param auth ARE
confirmed correct (the API parses and evaluates the param: present→inactive,
absent→missing). Root cause is account-side.

**Update 2026-05-23 (key-string path ELIMINATED):** re-copied the exact key
from the dashboard via clipboard→`.env` — it came back **byte-identical**
(54 chars, `…LjzS`). No typo / whitespace / truncation; the `.env` value matches
the dashboard exactly. The wrong/typo'd-key hypothesis is dead. Root cause is
**account-side provisioning**: the dashboard shows the key "Active" while the API
rejects it as `api_key_inactive`. Remaining path is step 2 → JamBase support only.

**Resolve (on the JamBase account/dashboard):**
1. ~~Re-copy the exact API key → update `.env`.~~ ✅ DONE 2026-05-23 — key string
   verified byte-identical; eliminated as a cause.
2. Verify the account has an **active API plan/subscription**, distinct from the
   key's "Active" toggle. Confirm the field copied is the API key, not an
   account / client / app ID.
3. If both look right and it still returns `api_key_inactive` → JamBase support
   (dashboard and API state are out of sync on their side).

**Then (once `npm run smoke:jambase` returns a real Atlanta event):**
- Finalize `normalizeJamBaseEvent` in `src/jambase.ts` against the dumped live
  event shape (verify the location/address/performer/offers/startDate/eventStatus
  paths and the `searchEvents` param names).
- Wire both providers (TM + JamBase) into `search_concerts` / `search_by_artist`:
  parallel fetch, cross-source dedupe (artist + date + venue key),
  "Powered by JamBase" attribution in the footer. `search_by_venue` stays
  Ticketmaster-only.
- Live-verify an Atlanta search surfaces a JamBase-sourced event
  (e.g. Atlanta Jazz Fest) with attribution. That is the positive signal.
  **Gap confirmed 2026-05-23:** Ticketmaster ALONE does NOT carry the Atlanta
  Jazz Festival (the free Piedmont Park Memorial Day event) — verified empty via
  general Atlanta search, `genre=Jazz`, and `keyword="Atlanta Jazz Festival"`.
  Free/non-ticketed festivals aren't in TM's Discovery catalog. Surfacing the
  Jazz Fest is therefore the concrete payoff of the JamBase source — this is the
  exact coverage hole it closes.

**Refs.** base = `www.jambase.com/jb-api/v3`, auth = `apikey` query param.
Source map: `docs/atlanta-source-map.md`. Discovery harness: `src/jambase-discovery.ts`
(`npm run smoke:jambase`).
