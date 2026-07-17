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
(2) Date window last-day omission — **FIXED 2026-07-16** (`toEnd` pads +1 day, the trim
reels it back; see `merge.ts`). It was far worse than "a late-night show": EDT is UTC-4,
so on the window's last local day every show from 20:00 on was dropped server-side —
a single-day Eddie's Attic query returned 1 of 3 shows. Residual: the mirror case at a
positive-offset venue (UTC+14 via explicit latlong) is unfixed and has no live specimen.
(3) Genre-aware JamBase page-1 limit + taxonomy gap — **FIXED 2026-07-17 via
server-side `genreSlug`.** Same unknown-param-oracle probe that found `artistName`:
`genreSlug` filters server-side (Atlanta baseline 1128 → jazz 41), validates its value
loudly (unknown slug = 400, never a silent empty), and the vocabulary is a CLOSED set of
20 (`GET /v3/genres`, static `JAMBASE_GENRES` table). `resolveGenreSlug` maps the request
to a slug — exact vocab hit first ("blues" is Blues, never R&B/Soul), else UNIQUE subset
match over identifier+display-name tokens (display names are the bridge: "R&B" reaches
"rhythm-and-blues-soul" through "R&B / Soul"); ambiguous or unknown → null → param
withheld, old client-side path unchanged. Server matches ANY performer in the lineup
(6/40 jazz rows matched via an opener only), so the headliner-only client filter stays —
now over the server-FILTERED set, paged to 3 pages max. Live: "R&B" Atlanta = 86 concerts
(structurally 0 before). **Lesson logged:**
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
  intra-source dedup (`dedupeWithinSource`, artist|date|**time**), the TM query
  bounds (`toStart`/`toEnd`) paired with `applyDateWindow`, date sort, max-price
  filter, plus `canonical()` (the shared name-folding used by both dedup keys and
  both matchers), `venueMatches()`, and `artistMatches()` (feed leg only).
  **The date-window invariant: fetch generously in UTC, trim precisely in local.**
  TM filters on a UTC instant; a Concert's `date` is the event's LOCAL date, and the
  two disagree by the venue's offset — so any bound exact in UTC is wrong in local
  time. `toEnd` overshoots a day and `applyDateWindow` reels it back. Keep the three
  together; widening a bound without the trim leaks, tightening one without the other
  drops real shows. `toStart` is unpadded on purpose — the asymmetry is documented at
  the source.
  **The two dedup keys differ on time, deliberately — don't unify them.** Across
  sources, time is dropped: two sources describing one show format or omit it
  inconsistently. Within one source, time is the whole point: a source listing the
  same artist twice on a date at different times is usually two REAL shows (Eddie's
  Attic runs a separate early and late show most nights — John Berry, 2026-07-25,
  6:00 PM and 8:00 PM, two event ids). Dropping time there would collapse a
  double-header and hide a bookable show. Run `dedupeWithinSource` on each source's
  list BEFORE `mergeConcerts`, which assumes self-consistent inputs.
- `src/types.ts` — Zod `Concert` schema = the typed output contract. Includes
  `description: string | null` (shipped 2026-07-17, closing BACKLOG item 4) —
  the source's own raw free text (Red Light RSS, Cobb iCal only; TM/JamBase/
  Freshtix carry no extra prose beyond their structured fields), hardened by
  `sanitizeDescription` (like `sanitizeText` but preserves line breaks — a
  description's lines are structure, not noise — and caps at 600 chars, not
  256). Never parsed into `priceMin`/`priceMax`/`time`: multi-tier,
  inconsistently formatted price text ("GA: $15 Adv – $20 Door / VIP: $25...")
  is exactly the fragile extraction the original diagnosis deferred — this
  passes the words through instead of guessing structure from them.
- `src/format.ts` — pure formatters (price/date/time/result + source attribution,
  incl. the required `Powered by JamBase` line).
- `src/smoke.ts`, `src/smoke-mcp.ts`, `src/smoke-feeds.ts`, `src/smoke-jambase.ts` —
  live verification harnesses (exit non-zero on failure). Unit tests: `*.test.ts`
  via `npm test`.

## Tools
- `search_concerts` — city / genre / date range / max price.
- `search_by_artist` — artist (+ optional location / dates / price). Ticketmaster **and**
  JamBase (2026-07-16); open feeds still out. JamBase uses the server-side `artistName`
  filter — server-side is the point, since the client-side genre filter only sees page 1
  and a targeted lookup can't miss anyone past the first 40 events.
  - **JamBase fires scoped to a mapped metro, or nationwide when no place is named** —
    "where is this artist playing?" is a meaningful nationwide question, unlike a browse.
    It sits out when a place is named that we CAN'T map (unknown city, raw latlong, state
    or country code): going nationwide there answers a Boise question with Nashville shows.
    Verified live — no place returns Grand Ole Opry + Princess Theater nights TM lacks;
    `city: "Boise"` returns nothing rather than out-of-area rows.
  - **Feeds wired 2026-07-17 via `artistMatches`, on a settled product call.** Feeds carry
    the post TITLE as the artist (both normalizers copy it into `artists`), so the only
    thing to match is a marketing headline holding four unlabeled kinds of name: the
    performer ("Boom! Trio"), a performer buried after "w/", a **presenter** ("Keena Graham
    presents…"), and a tribute's **subject** ("Sade vs Prince JAM", "…John Coltrane 100th
    Birthday Celebration"). **Bryan's call: tribute and presenter are BOTH matches, and the
    buried performer is worth the false positives.** So containment, one-directional (title
    contains query) — NOT `venueMatches`'s bidirectional form, which is right only because
    both its sides name a room.
  - **The summary carries the honesty, not the matcher.** A row is honest on its own —
    `artists` holds the real billing, so it never claims Prince performs. The old
    `"Here are upcoming {artist} concerts"` line was the only thing asserting he does, over
    a tribute for a man who died in 2016. That is inventing a performer. It now reads
    `upcoming events matching "{artist}" — check each billing`. If you ever tighten the
    match, this line can tighten with it; never the reverse.
  - **Feed scoping mirrors JamBase by a different route.** Feeds are metro-keyed with no
    artist filter, so nationwide = fetch each registered metro (`feedMetros()`) and match
    client-side. Cheap at one metro; cap it if the registry grows to dozens. Named-but-
    unmappable place still sits feeds out.
  - **`artistMatches` runs on the FEED leg only.** TM and JamBase filter server-side;
    re-filtering their rows would second-guess a match they already made (PM-47) and could
    turn an alias hit into a false absence. Filter the leg with no filter, nothing else.
  - **TM is ATTRACTION-routed (2026-07-17), not keyword-routed.** `keyword` is a text
    search over the whole record: it matched VENUE names and could not find the act —
    "Eagles" near Atlanta returned Eagles of Death Metal, a Deorro show at *Atlanta Eagles
    Arena*, and a church event, and zero Eagles. `findAttractions()` resolves the name to
    TM artist entities, then the handler fans out `events?attractionId=` per entity
    (`allSettled`, so one bad attraction costs that act's shows and nothing else).
    `keyword` remains ONLY as the fallback when TM has no attraction for a name.
    **The filter everyone reaches for first was a dead end** — dropping Deorro/CAIN leaves
    you with fewer rows, still not the Eagles.
  - **TM's `keyword` resolves NO aliases** — `keyword="machine gun kelly"` returns 0 events
    while the ATTRACTION `mgk` carries `aliases: ["machine gun kelly"]`. Ask the entity
    endpoint, not the event endpoint.
  - **Never trust `segmentName` on `/attractions`** — it still returns "Philadelphia Eagles"
    (NFL) and "Colorado Eagles" (hockey). Gate on each attraction's own
    `classifications[0].segment.name`, which is correct. That is reading TM's label, the
    inverse of PM-47.
  - JamBase's `artistName` remains a substring match (returns tributes) and is not filtered.
    Rows are honestly labelled with their real billing; the summary says "matching".
- `search_by_venue` — venue lookup → its upcoming events, from Ticketmaster **and**
  the metro's open feeds (2026-07-16). The feed leg is not optional: a feed-only
  room (Red Light Café, The EARL) has no TM venue id, so a TM miss or outage must
  not decide the answer — it previously reported a confident "no upcoming concerts
  listed" for a venue whose shows the feeds held. Feed events are matched to the
  query via `venueMatches` (canonical fold + containment): the query is a human's
  typed name, which is intent resolution, NOT the cross-source venue reconciliation
  `mergeConcerts` deliberately refuses.
  - **The EARL (Freshtix) source — shipped 2026-07-17** (`src/feeds/freshtix.ts`).
    Closes the exact gap filed `2026-07-09` (task
    `~/.second-brain-data/tasks/2026-07-09-bloodhound-earl-freshtix-feed.md`):
    badearl.freshtix.com carries no RSS/iCal, only a server-rendered HTML list
    page. Two things make this source different from Cobb/Red Light: (1) its day
    headers carry **no year** ("Friday July 17th") — `assignYears` infers it by
    walking the page in document order (already forward-chronological) and
    bumping the year on any month decrease, anchoring the first group against
    the fetch date so a December fetch whose list opens in January starts next
    year, not this one; (2) `href`/title text is HTML-entity-escaped in the raw
    markup (`&amp;`), so both must run through the same entity decoder — a URL
    escaped in the title only would leak a literal `&amp;` into the ticket link
    (caught live 2026-07-17, fixed same session). 403s a bare/urllib UA, 200s a
    browser UA (PM-37 mechanism A). Throws (never returns `[]`) on a zero-day or
    zero-event parse — the structural-drift alarm the Phase-3 pattern requires;
    a genuine dark stretch at a working touring venue is implausible, so an
    empty parse of a 200 means the markup moved, not "no shows."
  - **Feed-horizon coverage caveat — shipped 2026-07-17** (`fetchMetroFeedsDetailed`,
    `FeedFetchResult.horizon` in `src/feeds/registry.ts`). A zero-result answer for a
    venue that's ALSO a registered rolling-window feed source (Red Light Café's
    ~20-post RSS, The EARL's HTML page) can't be read as "confirmed dark" past that
    source's own reach — every RSS/HTML fetcher now also returns `horizon`, the
    latest date in its FULL unfiltered parse (computed free from data already in
    memory, no extra network call). `search_by_venue` alone consumes it: on zero
    results for a venue matching a registered source name, if the query's `endDate`
    (or its absence, since an unbounded ask implicitly asks past any finite horizon)
    extends past that source's horizon, the summary appends a coverage caveat rather
    than reading as confirmed silence. A window entirely inside confirmed coverage —
    or a query naming a non-feed venue — gets no caveat; `fetchMetroFeeds` stays the
    concerts-only wrapper `search_concerts`/`search_by_artist` use, unchanged.

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
