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

## JamBase 2nd source — ✅ ROOT CAUSE RESOLVED 2026-05-25 (was a client v1→v3 gap)
_Scaffolded 2026-05-23 (`daa4da4`). The two-day "blocked" saga was OUR bug, not
JamBase's: the client used a retired origin + `apikey` query-param auth against a
new self-service-platform key. Proven fixed 5/25 — a correctly-formed v3 request
returns 40 real Atlanta events incl. the free **Atlanta Jazz Festival** (the exact
TM coverage hole this source exists to close)._

**✅ THE WORKING RECIPE (verified 2026-05-25 with the rotated `…BwF2` key):**
- **Origin:** `https://api.data.jambase.com/v3`  (NOT `www.jambase.com/jb-api/v3`)
- **Auth:** header `Authorization: Bearer <key>`  (NOT `?apikey=<key>`)
- **Also send:** `Accept: application/json`, a `User-Agent`.
- **Geo model is two-step** — events are queried by JamBase geo ID, not city name:
  1. `GET /geographies/metros?metroHasUpcomingEvents=true` → 203 metros; Atlanta = `geoMetroId=jambase:10`
     (intl: `GET /geographies/cities?geoCityName=London&geoCountryIso2=GB` → `geoCityId=jambase:N`)
  2. `GET /events?geoMetroId=jambase:10` → events array
- **Pagination:** response has `pagination{page,perPage(=40),totalItems,totalPages,nextPage,...}`.
  `perPage` is a RESPONSE field, NOT a query param (passing `?perPage=` → 400 unknown-parameter).
  Page through with `?page=N` (or follow `pagination.nextPage`).
- **Event shape (schema.org JSON-LD):** `name`, `identifier`(`jambase:N`), `url`,
  `eventStatus`("scheduled"), `startDate`(date OR ISO datetime — split on "T"),
  `endDate`, `isAccessibleForFree`(bool), `location{name, address{addressLocality(city),
  addressRegion{name,alternateName}, x-jamBaseMetroId, x-jamBaseCityId}, geo{latitude,longitude}}`,
  `offers[]`(empty for free shows → price unavailable), `performer[]{name, genre[], x-isHeadliner}`.
  The existing `normalizeJamBaseEvent` already matches this; minor tweaks only (prefer
  `addressRegion.alternateName` "GA"; scan performers for first non-empty `genre`).

**Earlier (now-retracted) trail — kept as a cautionary record:**

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

**Update 2026-05-25 — earlier "backend bug" conclusion RETRACTED; root cause is
almost certainly OURS (we never migrated to the v3 API).** Facts established 5/25:
- Dashboard confirms an **active plan** (quota 1,000, 0 used, 5/23→6/22). Plan exists.
- Rotated the key (`…LjzS` → `…BwF2`, clipboard→`.env`); the new key still returns
  `api_key_inactive` on our current call. (So rotation isn't the fix.)
- **THEN actually read JamBase's API docs (should have been step one).** JamBase
  launched a self-service Data Platform; there is a **v1→v3 migration** with THREE
  changes: **new origin, `Authorization: Bearer` header, new key format.** Our client
  (`src/jambase.ts`) does NONE of these — it calls the legacy origin
  `www.jambase.com/jb-api/v3` with an `apikey` *query param*.
- Empirical probes 5/25:
  - `www.jambase.com/jb-api/v3` + `Authorization: Bearer <key>` → HTTP 403
    **`Wrong number of segments`** (a JWT-parse error → that endpoint's Bearer path
    wants a JWT, not our opaque `jb…` key).
  - `api.jambase.com/v3` (a guessed origin) → DNS/fetch failure (wrong host).
- **Conclusion:** `api_key_inactive` is most likely the *legacy* endpoint rejecting a
  *new-platform* key — i.e. a client-side origin/auth mismatch, NOT a JamBase backend
  bug. The 5/23 "account-side provisioning" diagnosis and the 5/25 "backend bug /
  send a support ticket" diagnosis are BOTH retracted: neither checked the vendor docs.
- **Support ticket is ON HOLD — do NOT send it.** (`docs/jambase-support-ticket.md`)
- **Open:** the exact v3 origin + auth is in JamBase's SPA docs (`/api/docs/request-builder`,
  `/api/docs/migrate-from-v1`) which WebFetch can't render — needs the verbatim curl
  from the authenticated dashboard. Next step is migrate the client, not escalate.

**Resolve (on the JamBase account/dashboard):**
1. ~~Re-copy the exact API key → update `.env`.~~ ✅ DONE 2026-05-23 — key string
   verified byte-identical; eliminated as a cause.
2. ~~Verify the account has an **active API plan/subscription**.~~ ✅ DONE 2026-05-25 —
   dashboard confirms an active plan (quota 1,000, 0 used, 5/23→6/22). Plan EXISTS.
3. ~~Rotate the key to force a fresh plan↔key binding.~~ ✅ DONE 2026-05-25 — rotated
   to `…BwF2`; new key returns the **identical `api_key_inactive`**. Eliminated.
4. ~~JamBase support ticket.~~ ON HOLD 2026-05-25 — premature; we hadn't read the docs.
5. **← ACTIVE PATH: migrate the client to the JamBase v3 Data API.** Get the verbatim
   request example from the authenticated Request Builder (`data.jambase.com/api/docs/
   request-builder`): exact v3 origin/host, `Authorization: Bearer` format, and confirm
   the dashboard key is the right credential. Then update `src/jambase.ts` (BASE +
   header auth, drop the `apikey` query param) and re-probe. Only if a correct v3 call
   STILL fails does the support ticket come off hold.

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
