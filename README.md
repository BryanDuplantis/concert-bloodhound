# Concert Bloodhound 🐾🎸

An MCP server that finds upcoming concerts in any city, by city, genre, date,
budget, artist, or venue, and returns **real listings only**. It never invents
prices, times, availability, or links: a missing field is reported plainly as
"not listed."

Nothing out there listed everything from arena tours down to a free civic show,
so it queries several sources at once, merges the results, and drops the
duplicates:

- [Ticketmaster Discovery API](https://developer.ticketmaster.com/): the base catalog.
- [JamBase](https://www.jambase.com/) Data API v3: clubs, festivals and free shows Ticketmaster misses (shown with `Powered by JamBase`).
- Open feeds for Atlanta venues and civic calendars (iCal, RSS, and a few small HTML parsers).

Every source is fetched independently, so one failing source degrades the answer
instead of breaking it. Ticketmaster wins on price and ticket links when a show
appears in more than one place.

Drop it into any MCP client (Claude Code, Claude Desktop) and ask:

> "Find indie concerts in Chicago under $50 this weekend."

## How it's verified

- `npm test`: offline unit suite for the metro resolver, merge and
  dedup rules, the date-window trim, and each feed parser.
- Live smoke tests (`npm run smoke`, `smoke:mcp`, `smoke:feeds`) exit non-zero
  unless real, dated events come back, so a green run means data, not just rc=0.
- Feed parsers throw on a zero-event parse of a page that should have events, so
  a site redesign shows up as an error rather than as a confident empty answer.

## Tools

| Tool | What it does |
|------|--------------|
| `search_concerts` | Search by city, genre, date range, and/or max price |
| `search_by_artist` | Upcoming shows for an artist, optionally near a city |
| `search_by_venue`  | Looks a venue up by name, then lists its upcoming events |

### Location coverage

For `search_concerts` and `search_by_artist`, a city in the built-in metro list
(most major US metros) resolves to its coordinates and is searched as a
`latlong` + `radius` (default 30 mi) query — so "Atlanta" returns the whole
**metro** (suburban venues like Peachtree City, Marietta, and the Cobb venues
included), not just venues whose listing text reads "Atlanta". Cities outside the
list fall back to a plain city text match; pass an explicit `latlong`
(e.g. `"33.749,-84.388"`) to force metro coverage for any city. Like relative
dates, coordinate resolution can also be done by the calling assistant.

## Status

Runs locally as a stdio MCP server (Claude Code, Claude Desktop). It used to also
run as a hosted HTTP service on a Raspberry Pi behind OAuth; that deployment was
retired 2026-10-29 because its sources need no always-on host (Ticketmaster is now
a native claude.ai connector, and the rest are public web pages). The hosting kit
was removed from this repo, and the HTTP transport and OAuth stack live on in a
separate private project. Ticketmaster, JamBase and feed logic are unchanged.

## Setup

### 1. Get a free Ticketmaster API key
1. Sign up at <https://developer.ticketmaster.com/>
2. Create an app and copy its **Consumer Key**.

### 2. Configure the key (never commit it)
```bash
cp .env.example .env
# open .env and paste your Consumer Key after TICKETMASTER_API_KEY=
```
`.env` is gitignored. The key never enters version control or the chat.

### 3. Install and build
```bash
npm install
npm run build
```

### 4. Verify it works (the positive signal)
```bash
npm run smoke       # direct API: real NYC events + an Atlanta metro geospatial search
npm run smoke:mcp   # full protocol: spawns the server, lists tools, returns live concerts
npm run smoke:feeds # open feeds: live Atlanta music events TM doesn't carry (Cobb + Red Light)
npm test            # offline unit suite: geo resolver, merge/dedup, iCal parser
```
The smokes exit non-zero on failure — a green check means real events came back, not just rc=0.

## Use it in Claude

Both setups point at `--env-file` so the key **stays only in `.env`** — it never
enters the Claude config file or your shell history.

### Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "concert-bloodhound": {
      "command": "node",
      "args": [
        "--env-file=/path/to/concert-bloodhound/.env",
        "/path/to/concert-bloodhound/dist/index.js"
      ]
    }
  }
}
```
Restart Claude Desktop.

### Claude Code
```bash
claude mcp add concert-bloodhound -- \
  node --env-file=/path/to/concert-bloodhound/.env \
       /path/to/concert-bloodhound/dist/index.js
```
No key on the command line — `--env-file` loads it from `.env`, so nothing
secret lands in shell history.

## How it stays honest

- **Price** comes only from the event's `priceRanges`. No range listed → `Price unavailable`.
  A `maxPrice` filter excludes events whose *listed minimum* is over budget; events
  with no listed price are kept (we can't confirm they're over budget) and the count
  is flagged in the summary.
- **Availability** is mapped from the event's on-sale status (`On sale`, `Off sale`,
  `Cancelled`, `Postponed`, `Rescheduled`, or `Availability unknown`). The Discovery
  API doesn't expose granular "limited"/"sold out" inventory, so the server doesn't claim it.
- **Date / time / venue / genre / link** render as "not listed" / "Date TBD" / "Time not
  listed" when the API omits them.

## Limitations (v0.1, MVP)

- Primary source is Ticketmaster. `search_concerts` merges Ticketmaster, JamBase, and
  open civic/indie feeds for metros that have them (currently Atlanta — Cobb Travel &
  Tourism and Red Light Café, the free/civic and indie shows TM doesn't carry); other
  metros are TM + JamBase until their feeds are added. `search_by_venue` covers
  Ticketmaster plus the metro's feeds. `search_by_artist` covers all three. Its JamBase
  and feed legs are skipped for a location we can't map to a metro (they would otherwise
  return shows outside the area you asked about).
- Artist search matches loosely, deliberately, across all three sources. "Eagles" surfaces
  Eagles of Death Metal and Eagles tribute acts; Ticketmaster also matches venue names, so
  it can return a show at Atlanta Eagles Arena; and open-feed listings match on the event's
  title, which often names a tribute's subject or a presenter rather than who is actually
  playing — searching "Prince" finds a Prince tribute night. **Every row carries its real
  billing, and results are described as "events matching X", never as that artist's
  concerts.** Read the billing before buying a ticket.
- US-centric defaults (`countryCode` defaults to `US`; override per call). Built-in
  metro coordinate resolution covers major US metros only; elsewhere, pass `latlong`.
- Relative dates ("this weekend") are resolved by the *calling* assistant into
  `startDate`/`endDate`, not by the server.
- No resale pricing, seat maps, or fine-grained inventory.

See `CLAUDE.md` for architecture and contributor conventions.
