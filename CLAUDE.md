@~/.claude/CLAUDE.md

---
## ✅ JamBase 2nd source — SHIPPED & LIVE 2026-05-25 (v3 migration + search_concerts wireup)
The two-day "blocked" saga was **our bug, not JamBase's** — the client never migrated
to the v3 Data API (two earlier diagnoses, "account-side provisioning" and "backend
bug → support ticket", were both reached without reading the vendor docs, both wrong).
Now fully migrated and merged into `search_concerts`. Positive signal confirmed:
`npm run smoke:jambase` → 40 dated Atlanta events (Jazz Festival #1); `npm run
smoke:mcp` → the free Atlanta Jazz Festival surfaces in a live Atlanta search with
`Powered by JamBase` attribution — the exact TM coverage hole, closed.

**What's live:**
- `src/jambase.ts` — v3 client: origin `https://api.data.jambase.com/v3`, auth
  `Authorization: Bearer <key>` (+ `Accept`/`User-Agent`), two-step geo via the
  `JAMBASE_METROS` map (`atlanta → jambase:10`; add new metros from
  `/geographies/metros`). `normalizeJamBaseEvent` validated vs the live shape
  (festival name headlines; ISO/date-only split; **headliner-only genre**, never
  borrowed from openers; empty `priceSpecification` → null price; `e.url` link).
- `search_concerts` (`src/index.ts`) — fetches TM + JamBase + feeds in parallel via
  `Promise.allSettled` (any source can fail without breaking the others); merges
  priority TM > JamBase > feeds, deduped on **artist|date** (NOT venue — sources
  format the same room irreconcilably, e.g. "Tabernacle"/"The Tabernacle",
  "District - GA"/"District Atlanta"; a touring act can't be two places a day).
  Results are trimmed to the requested window by local date (`applyDateWindow`),
  fixing a TM UTC-midnight boundary leak. JamBase fires for any mapped metro; under
  a `genre` filter it honors the request itself (matching the headliner's tags and
  relabeling to the matched tag), so it's genre-aware. Feeds gate off under genre.
- `src/format.ts` — `Powered by JamBase` on its own attribution line when present.
- `src/jambase.test.ts` (offline normalizer + genre-match guards) + `src/smoke-jambase.ts`
  (live). Old exploratory `src/jambase-discovery.ts` retired. Support ticket obsolete.

**Backlog (not blocking):** (1) artist-NAME divergence between sources ("mgk" vs
"Machine Gun Kelly") can slip a dupe — deliberately NOT fixed: fuzzy artist matching
risks merging distinct acts ("Eagles" vs "Eagles of Death Metal") for a rare gain.
**Distinct from ENCODING divergence, which IS fixed (2026-07-16):** TM's
"Nocturne's Kiss" (U+0027) vs JamBase's "Nocturne’s Kiss" (U+2019) leaked a live
dupe until `canonical()` folded accents/quote-forms/dashes into the dedup key.
Canonicalization is not fuzzy matching — it reconciles encodings of the same
characters, so the Eagles guard still holds (unit-tested both ways).
(2) Date window: TM can still omit a late-night show on the window's LAST local day
(its UTC end cuts off before local midnight) — needs a tz-aware query, not just the
client trim. (3) Genre-aware JamBase only scans page-1 events and won't bridge
taxonomy gaps (a "R&B" request misses "rhythm-and-blues-soul"). **Lesson logged:**
read the vendor's current API docs BEFORE theorizing about why auth fails.
---

# Concert Bloodhound — Project Conventions

MCP server (TypeScript, stdio) that surfaces real live-music listings via the
Ticketmaster Discovery API. It maps the "Concert Bloodhound" assistant spec
onto the Claude-only stack: MCP as the integration layer, Zod as the typed
output contract (the TS analog of the Pydantic rule).

## Non-negotiable: never invent data
The product rests on never fabricating ticket prices, times, availability, or
links. Every field flows from the API; absent fields render as "… not listed" /
"Price unavailable" / "Availability unknown". Do not add heuristics that guess
these. If a future source can't confirm a field, surface the gap — don't fill it.

Standing rule (2026-06-25): the open-feed layer never infers genre. Feed events
carry `genre: null` and are gated out under a genre filter — same as Cobb. No
SUMMARY classifier, no canonical vocab.

## Architecture
- `src/index.ts` — MCP server; registers the three tools. `search_concerts`
  orchestrates TM + JamBase + feeds in parallel (`Promise.allSettled`).
- `src/ticketmaster.ts` — Discovery API client + event/venue normalization. The api
  key is attached here and never logged.
- `src/jambase.ts` — JamBase Data API **v3** client (Bearer auth, `geoMetroId` geo
  model) + normalizer. Second source for `search_concerts`; closes the free-festival
  / civic hole TM's catalog misses (e.g. the Atlanta Jazz Festival). Key never logged.
- `src/feeds/` — federated open-feed layer (`ical.ts` parser, `registry.ts` metro→
  source map, `index.ts` fetch/cache/normalize). Closes the long-tail (free civic/
  indie shows) TM misses, on demand, without leaving the stateless model.
- **Network invariant:** I/O is isolated to the source clients — `ticketmaster.ts`,
  `jambase.ts`, and `feeds/*`. No other module fetches — `geo.ts`, `merge.ts`,
  `format.ts`, `types.ts` are all pure.
- `src/geo.ts` — PURE city→latlong metro table + resolver (+ nearest-metro). Lets a
  `city` search auto-upgrade to a geospatial `latlong`+`radius` query, and tags the
  resolved metro key so feeds for that metro are picked up.
- `src/merge.ts` — PURE result shaping: cross-source dedup (artist|date),
  date sort, max-price filter, plus `canonical()` (the shared name-folding used by
  the dedup key and venue matching) and `venueMatches()`.
- `src/types.ts` — Zod `Concert` schema = the typed output contract.
- `src/format.ts` — pure formatters (price/date/time/result + source attribution,
  incl. the required `Powered by JamBase` line).
- `src/smoke.ts`, `src/smoke-mcp.ts`, `src/smoke-feeds.ts`, `src/smoke-jambase.ts` —
  live verification harnesses (exit non-zero on failure). Unit tests: `*.test.ts`
  via `npm test`.

## Tools
- `search_concerts` — city / genre / date range / max price.
- `search_by_artist` — artist (+ optional location / dates / price). **Ticketmaster
  only** — open feeds are not wired in (feed events carry the title as the artist,
  so artist matching there needs a product call first).
- `search_by_venue` — venue lookup → its upcoming events, from Ticketmaster **and**
  the metro's open feeds (2026-07-16). The feed leg is not optional: a feed-only
  room (Red Light Café) has no TM venue id, so a TM miss or outage must not decide
  the answer — it previously reported a confident "no upcoming concerts listed"
  for a venue whose shows the feeds held. Feed events are matched to the query via
  `venueMatches` (canonical fold + containment): the query is a human's typed name,
  which is intent resolution, NOT the cross-source venue reconciliation
  `mergeConcerts` deliberately refuses.

`search_concerts` and `search_by_artist` resolve a known metro (or an explicit
`latlong`) to a geospatial `latlong`+`radius` search (default 30 mi) covering the
whole metro; unknown cities fall back to the `city` text match. When coords are
used the `city` text param is dropped (it would narrow back to the city proper).
Coordinate resolution mirrors how relative dates are handled — the calling
assistant can pass `latlong` for any city not in the built-in table.

`search_concerts` also merges JamBase + open-feed listings for a resolved metro
(Atlanta has JamBase `jambase:10` and Cobb Travel & Tourism live; see
`src/jambase.ts` `JAMBASE_METROS` and `src/feeds/registry.ts`) — deduped against TM
(which wins on price + ticket links) and attributed per source (`Powered by
JamBase`). Under a `genre` filter, feeds are skipped (they carry no genre) but
JamBase stays in, matching the headliner's tags (never guessing) — this even
recovers genre-relevant shows TM's stricter single-classification excludes (e.g.
Death Angel, which TM files under Metal, surfaces under a Rock search). Every source
is fetched independently, so any one failing — including a TM outage — degrades
gracefully instead of failing.

## Native Web/runtime APIs
Use native Web/runtime APIs — `URL`/`URLSearchParams` for query construction (never
string-concatenated query params), `fetch` + `AbortSignal.timeout` for HTTP with
timeouts, `Promise.allSettled` for the multi-source fan-out (already the pattern
in `search_concerts`). Never hand-roll query-string encoding, timeout timers, or
retry plumbing the runtime already covers.

## Secrets
`TICKETMASTER_API_KEY` and `JAMBASE_API_KEY` live only in `.env` (gitignored). Never
commit them, never echo them, never pass them as a CLI arg that lands in shell
history. The JamBase key is a Bearer token — attached only in `jambase.ts` and
redacted from every error. Local runs load `.env` via `node --env-file=.env`; Claude
integration passes them via the mcpServers `env` block.

## Verification — the positive signal
"Done" is NOT `tsc` exiting 0. Done is `npm run smoke:mcp` returning real, dated
events over the stdio protocol. Run it after any change to the client or tools.
`npm run build && npm run smoke:mcp` is the gate. For feed work, add
`npm run smoke:feeds` (live open-feed music events). `npm test` runs the offline
unit suite (geo resolver, merge/dedup, iCal parser) — fast logic guard, not a
substitute for the live smokes.
