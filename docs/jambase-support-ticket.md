# JamBase Support Ticket — issued API keys rejected as `api_key_inactive`

> ## ❌ OBSOLETE — DO NOT SEND (resolved 2026-05-25)
> Premise was wrong. There is no JamBase backend bug. The `api_key_inactive` was the
> **legacy endpoint rejecting a new-platform key** — our client never migrated to the
> v3 Data API. A correctly-formed v3 request (`https://api.data.jambase.com/v3` +
> `Authorization: Bearer <key>`) authenticates fine and returns real events (verified
> 5/25). Kept only as a record of the misdiagnosis. See `BACKLOG.md` for the fix.

_Drafted 2026-05-25. Keys are redacted to last-4; supply full values only if support
requests them through a secure channel — never in a public form or email body._

---

**Subject:** Active API plan, but every issued key returns `api_key_inactive` (incl. a freshly rotated key)

**Account email:** duplantis@gmail.com

**Summary:**
Every API key issued under my account is rejected by the Data API v3 as
`api_key_inactive`, even though my dashboard shows an active API plan with quota
remaining. This includes a key I rotated to today — a brand-new key fails
identically to my previous one. This looks like a backend sync issue between key
provisioning and the API's auth layer, not a client error.

**My plan (from the dashboard, API Usage panel):**
- Quota: 1,000
- Used so far: 0 (0%)
- Started: May 23, 2026 UTC
- Resets: Jun 22, 2026 UTC

**Keys affected:**
- Original key ending `…LjzS` — `api_key_inactive` (now rotated out)
- Rotated key ending `…BwF2` (generated today) — `api_key_inactive`

**Request (exact):**
```
GET https://www.jambase.com/jb-api/v3/events?apikey=<my-key>&geoCityName=Atlanta&perPage=1
Accept: application/json
```

**Response (both keys):**
```
HTTP 403
{"success":false,"errors":[{"code":"api_key_inactive","message":"The provided API key `…` is inactive."}]}
```

**Why this points to your side, not mine — control test:**
| apikey sent | HTTP | response code |
|---|---|---|
| my real key (`…LjzS`, then rotated `…BwF2`) | 403 | `api_key_inactive` |
| a deliberately fake/garbage string | 403 | `api_key_inactive` |
| empty / omitted | 400 | `missing_api_key` |

My real keys get the **exact same response as a string I made up**, while an empty
key correctly returns `missing_api_key`. So the request format and `apikey`
query-param auth are correct (the API parses and evaluates the param) — the API
auth store simply does not recognize any key your dashboard issues to me. The
`0 used` on an active plan confirms no key has ever successfully authenticated.

**What I've already verified on my end (so we can skip it):**
- Key string copied byte-for-byte from the dashboard (54 chars, no whitespace/truncation).
- Confirmed I'm using the API key field, not an account/client/app ID.
- Rotated the key — the new key fails identically.

**Ask:** Please check the plan↔key binding / key provisioning for this account so
that issued keys authenticate against the active plan. Happy to provide full key
values through a secure channel if needed.
