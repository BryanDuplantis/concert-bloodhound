# Concert Bloodhound — Backlog

Deferred work, newest at top. The live MVP runs on Ticketmaster; items here are
not blocking it.

---

## Cross-surface access — Mac/Claude-Code only today (NOT scoped, 2026-05-25)
The server is **stdio** (`StdioServerTransport`, registered `type:stdio` in user-scope
`~/.claude.json`), i.e. a local Node child process Claude Code spawns on the Mac. So
**all queries originate in a Claude Code session on the Mac** — there is no iOS / web /
claude.ai path, and none was built. To reach it from the iOS Claude app you'd need to:
(1) add an HTTP transport (stdio-only today); (2) host it at a **publicly-reachable**
HTTPS endpoint — note claude.ai connectors are server-side, so a private Tailscale
`*.ts.net` URL would NOT work the way it does for brain-mcp in Claude Code; needs a real
public endpoint (Cloudflare Tunnel / hosted box) **plus auth**; (3) register it as a
claude.ai custom connector (propagates to iOS); (4) move the API keys server-side (they
live in the local `.env` via the stdio env-file today). Going public also sharpens the
security posture — see the prompt-injection / key-handling residuals below. Not scoped;
boundary recorded only.

## Security review residuals (2026-05-25) — non-blocking hardening
Full `/security_review` run: **0 Critical / 0 High / 3 Medium / 4 Low**, 5 categories
clean. The two reachable issues are **FIXED & committed in `6baeb36`**: M1 (TM error
path could echo the apikey to the chat surface → `redact()` + stderr-only body) and L1
(`url` accepted any scheme → `safeUrl()` https/http allowlist in all three normalizers).
Remaining recommendations, not auto-applied:
- **M2 — supply chain.** Deps are caret-ranged; `npm audit` clean today. Use `npm ci`
  (lockfile-exact) in any install/CI context, and consider pinning `@modelcontextprotocol/sdk`
  to an exact version (it's the trust-critical dep that sees every tool arg).
- **M3 — prompt injection via upstream concert data.** Event names / artists / feed
  summaries are attacker-influenceable free text flowing verbatim into the LLM context.
  **M3 cheap hardening SHIPPED 2026-06-25 (`646286e`)** — control-char strip + length cap
  (256, ellipsis) at the source boundaries, all 3 sources (`sanitizeText`/`sanitizeConcert`
  in `types.ts`, applied at `ticketmaster`/`jambase`/`feeds` output + `findVenue`; offline
  guards in `types.test.ts`; live `smoke:mcp` green). **NOT M3 done — REDUCED, not closed.**
  The full prompt-injection treatment remains event-gated to the HTTP/iOS build: the
  optional "untrusted external data" preamble in tool output was deliberately skipped (soft
  value, presentation noise), and a public transport sharpens the surface beyond what a
  content-strip covers (key handling, server-side trust boundary). **The gate did NOT move
  — resolve BEFORE/WHEN HTTP transport for iOS is added** (see cross-surface section above).
  Zod validates shape, not content; the cheap layer now guards content at the boundary.
  M2 has no hard date but apply `npm ci` the next time deps are installed.
- **L3/L4 — awareness only.** `nearestMetroKey` `?? 0` fallback (trusted table data);
  `jbGet`/`tmFetch` path arg would allow base-URL escape IF ever made dynamic (not
  reachable today — all callers pass hardcoded literals).

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

**Phase 2 (Battery ATL + Piedmont Park) — KILLED 2026-06-25 (recon), do NOT re-propose.**
Live recon of both feeds (Battery Trumba `atlbrv.ics` 121 events / 12 distinct titles;
Piedmont `piedmontpark.org` iCal 30 events) settled it: **these are amenity/lifestyle
calendars, not concert feeds — no long-tail to capture.** Battery's "events" are jazz
brunches (46×, a restaurant), Yappy Hour (dog), yoga, farmers markets, silent disco;
Piedmont's are walking clubs, 5Ks, green markets, with exactly ONE genuine music event
("44 Live Jazz Festival"). A SUMMARY classifier here can only stay silent (~95%
`unclassified`, earns nothing) or invent concerts — surfacing a restaurant jazz brunch
as a "Jazz concert" is the over-classification failure mode AND violates "never invent."
CATEGORIES exist in both but are useless (location tag / "Conservancy Events", no genre).
The classifier idea isn't wrong; the *sources* were. Don't resurrect Battery/Piedmont.

**Phase 3 (RSS) — NEXT, prerequisite RESOLVED.** Red Light Café, GA Tech Arts (actual
music venues — the real long-tail) — adds an RSS/XML parser dep. **Genre-vocab question
(Finding 4, 2026-06-25) RESOLVED: Option A — genre stays free-text; the open-feed layer
NEVER infers genre.** Phase 3 RSS mirrors the proven Cobb pattern: surface events honestly
with `genre: null`, gated out under a genre filter. No canonical vocab, no classifier, no
inference — keeps the "never invent" line clean (this is why Phase 2's classifier idea was
moot, not just its sources). The original brief's `genreSource`/B-compatible seam is moot
while feeds assert no genre; if the web-app pivot later wants feed genres, build the
canonical set then with full context. **Phase 3 build is now unblocked.** Given the Phase 2
lesson (premise didn't survive recon), START PHASE 3 WITH RECON: confirm Red Light Café +
GA Tech Arts feeds are genuine concert listings before adding the parser dep.

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

## JamBase 2nd source — ✅ SHIPPED & LIVE 2026-05-25 (v3 migration + search_concerts wireup)
_Scaffolded 2026-05-23 (`daa4da4`). The two-day "blocked" saga was OUR bug, not
JamBase's: the client used a retired origin + `apikey` query-param auth against a
new self-service-platform key. Proven fixed 5/25 — a correctly-formed v3 request
returns 40 real Atlanta events incl. the free **Atlanta Jazz Festival** (the exact
TM coverage hole this source exists to close)._

**✅ DONE — the wireup is live (2026-05-25).** `src/jambase.ts` migrated to the v3
recipe below; `normalizeJamBaseEvent` validated vs the live shape (festival name
headlines, ISO/date-only split, headliner-only genre, empty `priceSpecification` →
null price, `e.url` link, GA region); merged into `search_concerts` parallel with TM
+ feeds (`Promise.allSettled`, priority TM > JamBase > feeds, dedup artist|date,
mapped metro); `Powered by JamBase` attribution added to `format.ts`. Positive
signals confirmed: `npm run smoke:jambase` → 40 dated Atlanta events (Jazz Fest #1);
`npm run smoke:mcp` → Jazz Fest surfaces in a live Atlanta `search_concerts` with
attribution. Offline guards: `src/jambase.test.ts`. Exploratory
`src/jambase-discovery.ts` retired → `src/smoke-jambase.ts`. New metros: add to
`JAMBASE_METROS` in `jambase.ts` (id from `/geographies/metros`).

**✅ Post-test follow-ups DONE 2026-05-25** (after the 8-scenario live run): dedup
simplified to **artist|date** (venue dropped — TM/JamBase venue strings irreconcilable,
e.g. "District - GA" vs "District Atlanta", "Tabernacle"/"The Tabernacle"); **date
window** now trimmed by local date (`applyDateWindow`) to fix a TM UTC-midnight leak
(a May-28 8pm-EDT show leaking into a May-29 search); **genre-aware JamBase** — under
a `genre` filter JamBase stays in, matches the headliner's tags (token-subset, "rap"
≠ "trap"), and relabels to the matched tag, recovering shows TM files under a
neighbouring genre (Death Angel under Metal → surfaces on a Rock search); plus the
`search_by_artist`/`search_by_venue` singular-grammar nit.

**Open (not blocking):** (1) **artist-NAME divergence** ("mgk" vs "Machine Gun
Kelly") can slip a dupe — DELIBERATELY not fixed: fuzzy artist matching risks merging
distinct acts ("Eagles" vs "Eagles of Death Metal") for a rare gain. (2) **Date
window last-day**: TM can still OMIT a late-night show on the window's last local day
(UTC end cuts off before local midnight) — needs a tz-aware query, not just the
client trim. (3) **Genre-aware JamBase** scans page-1 only and won't bridge taxonomy
gaps (a "R&B" request misses "rhythm-and-blues-soul").

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

**Refs.** LIVE v3 client: origin `https://api.data.jambase.com/v3`, auth
`Authorization: Bearer <key>` (see `src/jambase.ts`). Source map:
`docs/atlanta-source-map.md`. Smoke: `src/smoke-jambase.ts` (`npm run smoke:jambase`).
_(The old `www.jambase.com/jb-api/v3` + `apikey` query param and
`src/jambase-discovery.ts` are retired — see the cautionary record above.)_
