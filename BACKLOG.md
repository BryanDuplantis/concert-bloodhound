# Concert Bloodhound — Backlog

Deferred work, newest at top. The live MVP runs on Ticketmaster; items here are
not blocking it.

---

## JamBase 2nd source — BLOCKED on JamBase-side key provisioning
_Parked 2026-05-23. Scaffolded & committed (`daa4da4`); NOT wired into the live tools._

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

**Resolve (on the JamBase account/dashboard):**
1. ~~Re-copy the exact API key → update `.env`.~~ ✅ DONE 2026-05-23 — key string
   verified byte-identical; eliminated as a cause.
2. Verify the account has an **active API plan/subscription**, distinct from the
   key's "Active" toggle. Confirm the field copied is the API key, not an
   account / client / app ID.
3. If both look right and it still returns `api_key_inactive` → JamBase support
   (dashboard and API state are out of sync on their side).

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
