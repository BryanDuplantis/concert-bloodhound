@~/.claude/CLAUDE.md

---
## ✅ JamBase — root cause RESOLVED 2026-05-25 (was a client v1→v3 migration gap)
The two-day "blocked" JamBase saga was **our bug, not JamBase's.** Two earlier
diagnoses (5/23 "account-side provisioning", 5/25 "backend bug → support ticket")
were BOTH reached without reading the vendor's API docs — and both wrong. Real cause:
the client never migrated to the v3 Data API. **Proven fixed 5/25**: a correct v3
request returns 40 real Atlanta events incl. the free Atlanta Jazz Festival.

**Working recipe** (full detail + event shape in `BACKLOG.md`):
- Origin `https://api.data.jambase.com/v3` · auth `Authorization: Bearer <key>` ·
  send `Accept`+`User-Agent` · two-step geo (`/geographies/metros` → `geoMetroId` →
  `/events?geoMetroId=jambase:10`) · NO `perPage` query param (use `?page=N`).
- Support ticket is **obsolete/do-not-send** (`docs/jambase-support-ticket.md`).
- **Lesson logged:** read the vendor's current API docs BEFORE theorizing about why
  auth fails — a control test proves the key is unrecognized but NOT *why*.

**Remaining (the actual wireup):** migrate `src/jambase.ts` to the recipe above,
re-validate `normalizeJamBaseEvent` against the live shape, and merge JamBase into
`search_concerts` (parallel w/ TM, dedupe, "Powered by JamBase" attribution). The
positive signal is `npm run smoke:jambase` returning a real dated Atlanta event.
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

## Architecture
- `src/index.ts` — MCP server; registers the three tools. Orchestrates TM + feeds.
- `src/ticketmaster.ts` — Discovery API client + event/venue normalization. The api
  key is attached here and never logged.
- `src/feeds/` — federated open-feed layer (`ical.ts` parser, `registry.ts` metro→
  source map, `index.ts` fetch/cache/normalize). Closes the long-tail (free civic/
  indie shows) TM misses, on demand, without leaving the stateless model.
- **Network invariant:** I/O is isolated to `ticketmaster.ts` and `feeds/*` (the
  source clients). No other module fetches — `geo.ts`, `merge.ts`, `format.ts`,
  `types.ts` are all pure.
- `src/geo.ts` — PURE city→latlong metro table + resolver (+ nearest-metro). Lets a
  `city` search auto-upgrade to a geospatial `latlong`+`radius` query, and tags the
  resolved metro key so feeds for that metro are picked up.
- `src/merge.ts` — PURE result shaping: TM↔feed dedup, date sort, max-price filter.
- `src/types.ts` — Zod `Concert` schema = the typed output contract.
- `src/format.ts` — pure formatters (price/date/time/result + source attribution).
- `src/smoke.ts`, `src/smoke-mcp.ts`, `src/smoke-feeds.ts` — live verification
  harnesses (exit non-zero on failure). Unit tests: `*.test.ts` via `npm test`.

## Tools
- `search_concerts` — city / genre / date range / max price.
- `search_by_artist` — artist (+ optional location / dates / price).
- `search_by_venue` — venue lookup → its upcoming events.

`search_concerts` and `search_by_artist` resolve a known metro (or an explicit
`latlong`) to a geospatial `latlong`+`radius` search (default 30 mi) covering the
whole metro; unknown cities fall back to the `city` text match. When coords are
used the `city` text param is dropped (it would narrow back to the city proper).
Coordinate resolution mirrors how relative dates are handled — the calling
assistant can pass `latlong` for any city not in the built-in table.

`search_concerts` also merges open-feed listings for a resolved metro (Atlanta has
Cobb Travel & Tourism live; see `src/feeds/registry.ts`) — deduped against TM,
attributed per source. Feeds are skipped when a `genre` filter is set (they carry
no per-event genre). A TM outage degrades to feed-only rather than failing.

## Secrets
`TICKETMASTER_API_KEY` lives only in `.env` (gitignored). Never commit it, never
echo it, never pass it as a CLI arg that lands in shell history. Local runs load
it via `node --env-file=.env`; Claude integration passes it via the mcpServers
`env` block.

## Verification — the positive signal
"Done" is NOT `tsc` exiting 0. Done is `npm run smoke:mcp` returning real, dated
events over the stdio protocol. Run it after any change to the client or tools.
`npm run build && npm run smoke:mcp` is the gate. For feed work, add
`npm run smoke:feeds` (live open-feed music events). `npm test` runs the offline
unit suite (geo resolver, merge/dedup, iCal parser) — fast logic guard, not a
substitute for the live smokes.
