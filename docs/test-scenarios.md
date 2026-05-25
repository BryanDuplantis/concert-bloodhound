# Concert Bloodhound — Manual Test Scenarios

Natural-language prompts to exercise the MCP through a calling assistant (Claude
Code / Desktop), each paired with the **positive signal** that proves it worked.
Run after any change to the tools, geo resolution, or feeds.

> ⚠️ **Reconnect first.** The MCP server holds whatever build was loaded when the
> session started. After a rebuild, restart the session / reconnect the server
> (or restart Claude Desktop) so it loads the current `dist/` — otherwise these
> prompts hit stale code.

## A. Geospatial metro coverage (city → latlong + radius)
- **"Find concerts around Atlanta this summer — show me 25."**
  ✅ includes suburban venues (Marietta, Mableton, Smyrna, Kennesaw, Duluth), not just "Atlanta" city.
- **"What's playing near Los Angeles next month?"**
  ✅ venues span the metro (Inglewood, Pasadena, Anaheim); footer `Source: Ticketmaster`.

## B. Open-feed merge + attribution (Phase 1 payoff)
- **"Show me free or civic concerts around Cobb County / Marietta over the next two months."**
  ✅ Cobb feed events appear (e.g. Glover Park Concert Series); footer `Sources: Ticketmaster, Cobb Travel & Tourism`.
- **"List 30 upcoming music events around Atlanta with dates and venues."**
  ✅ TM + Cobb feed mixed, deduped, multi-source footer.

## C. Honesty / never-invent
- **"What's the ticket price and start time for the Glover Park Concert Series in Marietta?"**
  ✅ `Price unavailable` / `Time not listed` / `Availability unknown` — never a fabricated value.

## D. Genre filter (feeds correctly skipped)
- **"Find jazz concerts in Chicago next month."**
  ✅ genre-filtered TM results; footer `Source: Ticketmaster` (feeds skipped — no per-event genre).

## E. Budget / maxPrice
- **"Indie rock shows in Brooklyn under $40 this month."**
  ✅ over-budget excluded; summary notes "N have no listed price and were kept rather than filtered out."

## F. Artist & venue tools
- **"When is Tyler Childers playing near Nashville?"** — ✅ `search_by_artist`, metro-scoped.
- **"What's coming up at the Tabernacle in Atlanta?"** — ✅ `search_by_venue` resolves the venue, lists shows.

## G. Fallback + aliases
- **"Find concerts in Asheville, NC this month."** — ✅ not in metro table → city text-match fallback, still returns shows.
- **"Concerts in NYC this weekend" / "shows in SF next month" / "ATL concerts"** — ✅ aliases resolve (New York / San Francisco / Atlanta).

## H. Graceful edges
- **"Find polka concerts in Honolulu this Tuesday."** — ✅ empty → friendly "try widening…" message, not an error.
- **"Find me some concerts."** (no location) — ✅ "Please provide a location: a city, a state code, coordinates, or a keyword."

## I. Cross-source dedup
- **"Is the Atlanta Opera performing at Cobb Energy, and how do I get tickets?"**
  ✅ shown once (in both TM + Cobb feed) — the TM copy wins (carries the ticket link).

---

**Highest-value checks:** A-1 (suburban venues prove the geospatial fix) and B-1
(the `Cobb Travel & Tourism` footer proves the feed merge) — the two things the
2026-05-25 session shipped.
