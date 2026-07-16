# Concert Bloodhound 🐾🎸

An MCP server that helps you find upcoming concerts in any city — by city, genre,
date, budget, artist, or venue. It returns **real listings only**, sourced live
from the [Ticketmaster Discovery API](https://developer.ticketmaster.com/). It
never invents prices, times, availability, or links: missing fields are reported
plainly as "not listed."

Drop it into any Claude surface (Claude Code, Claude Desktop) and ask:

> "Find indie concerts in Chicago under $50 this weekend."

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
        "--env-file=/Users/bryanduplantis/Projects/concert-bloodhound/.env",
        "/Users/bryanduplantis/Projects/concert-bloodhound/dist/index.js"
      ]
    }
  }
}
```
Restart Claude Desktop.

### Claude Code
```bash
claude mcp add concert-bloodhound -- \
  node --env-file=/Users/bryanduplantis/Projects/concert-bloodhound/.env \
       /Users/bryanduplantis/Projects/concert-bloodhound/dist/index.js
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
  Ticketmaster plus the metro's feeds. **`search_by_artist` is Ticketmaster-only** — so
  for an artist playing only a JamBase- or feed-sourced show, it can report nothing while
  `search_concerts` finds it.
- US-centric defaults (`countryCode` defaults to `US`; override per call). Built-in
  metro coordinate resolution covers major US metros only; elsewhere, pass `latlong`.
- Relative dates ("this weekend") are resolved by the *calling* assistant into
  `startDate`/`endDate`, not by the server.
- No resale pricing, seat maps, or fine-grained inventory.

See `CLAUDE.md` for architecture and contributor conventions.
