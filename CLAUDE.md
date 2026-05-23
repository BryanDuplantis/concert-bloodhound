@~/.claude/CLAUDE.md

---
## ⏸ REMINDER — JamBase 2nd source is PARKED (since 2026-05-23)
**Surface this at the start of any session on this project.** The JamBase
integration is parked, blocked on JamBase **account-side key provisioning** — NOT
a code or config problem. The key string is verified byte-correct and the
base/auth are confirmed; the API still returns `api_key_inactive` (a fake key
returns the identical error). **Do not re-debug the key or revisit the
"rotation-grace / wait for expiry" theory — both are dead ends.** The only
unblock is JamBase provisioning an active API *plan* behind the key (or a support
ticket). Full diagnosis + resolve steps: `BACKLOG.md`. Concert Bloodhound runs on
Ticketmaster meanwhile — when the key activates, `npm run smoke:jambase`
returning a real event resumes the wire-up with no re-diagnosis needed.
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
- `src/index.ts` — MCP server; registers the three tools. Filtering/summary logic.
- `src/ticketmaster.ts` — Discovery API client + event/venue normalization. The
  ONLY module that touches the network. The api key is attached here and never logged.
- `src/types.ts` — Zod `Concert` schema = the typed output contract.
- `src/format.ts` — pure formatters (price/date/time/result). No I/O.
- `src/smoke.ts`, `src/smoke-mcp.ts` — verification harnesses (exit non-zero on failure).

## Tools
- `search_concerts` — city / genre / date range / max price.
- `search_by_artist` — artist (+ optional location / dates / price).
- `search_by_venue` — venue lookup → its upcoming events.

## Secrets
`TICKETMASTER_API_KEY` lives only in `.env` (gitignored). Never commit it, never
echo it, never pass it as a CLI arg that lands in shell history. Local runs load
it via `node --env-file=.env`; Claude integration passes it via the mcpServers
`env` block.

## Verification — the positive signal
"Done" is NOT `tsc` exiting 0. Done is `npm run smoke:mcp` returning real, dated
events over the stdio protocol. Run it after any change to the client or tools.
`npm run build && npm run smoke:mcp` is the gate.
