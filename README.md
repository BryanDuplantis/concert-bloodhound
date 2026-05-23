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
npm run smoke       # direct API: real NYC events in the next 30 days
npm run smoke:mcp   # full protocol: spawns the server, lists tools, returns live Chicago concerts
```
Both exit non-zero on failure — a green check means real events came back, not just rc=0.

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

- Single source (Ticketmaster). Indie/DIY shows not listed there won't appear.
- US-centric defaults (`countryCode` defaults to `US`; override per call).
- Relative dates ("this weekend") are resolved by the *calling* assistant into
  `startDate`/`endDate`, not by the server.
- No resale pricing, seat maps, or fine-grained inventory.

See `CLAUDE.md` for architecture and contributor conventions.
