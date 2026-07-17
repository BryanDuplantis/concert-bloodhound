# Atlanta + Cobb County Live-Music Source Map

Research dispatched 2026-05-23 (general-purpose subagent, live WebSearch/WebFetch).
Every status claim was verified against a primary source URL; fetch dates ~May 2026.
This is the build-order input for the multi-source federated aggregator (see the
web-app pivot backlog item).

The core finding: **Ticketmaster alone misses the entire long tail** — all free
civic series, all university events, all DICE/Freshtix indie venues, and the
Atlanta Jazz Festival (free admission). The reachable replacement is a small set
of open APIs + publicly published iCal/RSS feeds, not a pile of ticketing APIs
(most of those are now closed or partner-gated).

---

## Why federated — the structural argument

Two distinct gaps make a single source insufficient, and they compound:

1. **Coverage gap** — TM's catalog is bounded by what's TM-ticketed. Free civic
   series, university recitals, DIY/indie rooms, and free festivals are
   structurally absent from a TM search because they were never in TM's
   database. The Atlanta Jazz Festival is the canonical example: a free,
   high-profile Piedmont Park event TM literally does not carry, no matter
   how the query is phrased. JamBase + Tier 1 open feeds close this.

2. **Classification gap** — even when an act IS in TM's catalog, TM files it
   under a single rigid genre. JamBase tags the same act with multiple
   genres reflecting how the act is actually marketed. **Empirical case
   (2026-05-25):** a `genre=Rock` search for Atlanta — Death Angel is in
   TM's catalog but filed under Metal, so TM returns nothing. JamBase tags
   the same act both metal AND rock and surfaces it. The user gets a
   relevant result the primary source structurally couldn't produce.

The Coverage gap argues for adding sources. The Classification gap argues
that adding sources still pays off **even when the primary source has the
data** — because the primary's taxonomy is its own search-time boundary.
Together these say a federated concert search is not a long-tail luxury;
it's the only design that returns relevant results consistently for either
free events or genre-flexible acts. Everything below — Tier 1, Tier 2,
the dead ends — is downstream of that.

---

## Tier 1 — Clean to consume (open API or published feed, no legal gray)

> **Status audit 2026-07-17 — this tier is EXHAUSTED; per-row markers below are
> authoritative over the original prose.** Everything viable is already wired into
> the MCP; the rest is killed by recon or gated to fall. Kill records live in
> BACKLOG.md — a source marked ❌ must not be re-proposed from this table (that
> stale-line trap already fired once: GA Tech, re-proposed 2026-07-16 from an
> unannotated doc, three weeks after recon killed it).

| Source | Mechanism | Endpoint | Coverage / notes |
|---|---|---|---|
| ✅ WIRED 2026-05-25 — **JamBase Data API** | REST JSON | `https://data.jambase.com/v3/events?geoMetroId=[ATL-id]` | **Biggest single win.** 15+ yrs of data, touring **and** independent venues, metro geo-filter. Free Developer tier = 1,000 calls/mo, non-commercial, attribution required. Surfaces the Jazz Fest. Pricing: `data.jambase.com/pricing` |
| ✅ WIRED (latlong since 2026-05-25) — **Ticketmaster Discovery** | REST JSON | `https://app.ticketmaster.com/discovery/v2/events?latlong=33.749,-84.388&radius=30&unit=miles` | Already integrated. **Switch from `city` to `latlong`+`radius`** for true metro/Cobb coverage — `postalCode` is text-match, not geospatial. Covers Cobb Energy PAC, Mable House, Fox, Tabernacle, Masquerade, Ameris Bank Amph. |
| ❌ KILLED 2026-06-25 (amenity calendar, no music long-tail — BACKLOG) — **Battery ATL (Trumba)** | iCal/RSS/XML | `https://www.trumba.com/calendars/atlbrv.ics` | Free green-space shows at The Battery (Cobb). Verified live. |
| ❌ KILLED 2026-07-17 (feed is a general university calendar, zero music; no Schwartz-specific feed exists — BACKLOG) — **Emory / Schwartz Center (Trumba)** | iCal/RSS/XML | `https://www.trumba.com/calendars/ec-events.ics` | Classical / jazz / world. Verified live. |
| ⏳ FALL-GATED (dead in summer; revisit Aug+ — BACKLOG) — **KSU Bailey Performance Center (Localist)** | JSON API + iCal | `https://calendar.kennesaw.edu/api/2/events` | University recitals in Kennesaw (Cobb). Public read, no auth. Filter by music dept id. |
| ⏳ FALL-GATED (dead in summer; revisit Aug+ — BACKLOG) — **GSU School of Music (Localist)** | JSON API + iCal | `https://calendar.gsu.edu/api/2/events?keyword=music` | 150+ events/yr. Per-event iCal export confirmed. |
| ❌ KILLED 2026-06-25 (music a ~17% minority, no music category — BACKLOG) — **Georgia Tech Arts (Drupal RSS)** | RSS | `https://calendar.gatech.edu/taxonomy/term/12/feed` | Arts & Performance category feed confirmed. |
| ❌ KILLED 2026-06-25 (amenity calendar; 1 music event in 30 — BACKLOG) — **Piedmont Park Conservancy** | iCal (The Events Calendar) | `webcal://piedmontpark.org/?post_type=tribe_events&ical=1&eventDisplay=list` | Park concerts/festivals. Verified live. |
| ✅ WIRED 2026-05-25 — **Cobb Travel & Tourism** | iCal | `https://travelcobb.org/events/list/?shortcode=24f53d40&hide_subsequent_recurrences=1&ical=1` | County-wide curated: Glover Park, Kennesaw series, Mable House free shows. Verified live. |
| ✅ WIRED 2026-06-25 — **Red Light Café (Squarespace)** | RSS | `http://redlightcafe.com/events?format=rss` | Indie venue; Squarespace native RSS. Confirmed live. |

### Generalizable feed patterns (reuse across sources)
- **Trumba:** append `.ics` / `.rss` / `.json` to any Trumba calendar URL. (Battery + Emory confirmed; many institutions use it.)
- **Localist:** `https://calendar.<school>.edu/api/2/events` → JSON, public, no auth. Paginate `?page=N`, filter `?keyword=music`. Enumerate dept ids via `/api/2/departments`. Docs: `developer.localist.com/doc/api`.

---

## Tier 2 — Low-effort static ingest (HTML only, tiny volume)

No machine feed, but only a handful of dates/year — cheap to parse or hand-enter.

- ✅ WIRED 2026-07-17 (`src/feeds/glover.ts`) — **Marietta / Glover Park Concert Series** — `mariettaga.gov/192/Glover-Park-Concert-Series` — 6 free Friday concerts Apr–Sep. One CivicEngage lineup table, rows anchored on `data-th` attributes; season show time read from page prose.
- ✅ WIRED 2026-07-17 (`src/feeds/kennesaw.ts`, via open WP REST API — the `/concert-series/` page itself is client-rendered/unparseable) — **Kennesaw Depot Park Series** — `kennesaw-ga.gov` — PLUS the First Friday downtown series the original row missed; both parse from news posts' house `Month D – Artist<br/>blurb` format, venue routed by post title.
- ❌ KILLED 2026-07-17 (PM-56 control-test: 403 on bare AND browser UA = TLS/JA3-or-WAF block, no honest Node-fetch path; falsifier = a plain `curl -sI` returning 200 — BACKLOG) — **Smyrna Village Green / Blanket Concert Series** — `smyrnaga.gov` (CivicPlus CMS). Cobb Travel iCal partially covers Village Green events it categorizes as music.

---

## Scrape-required / legally gray (weigh case-by-case; defer)

Prefer not to build on these until Tier 1+2 are exhausted. Each carries its own ToS risk.

| Source | Why no feed | Risk |
|---|---|---|
| **DICE** (Eddie's Attic + indie) | Ticket-Holders API is partner-only GraphQL; **ToS prohibits scraping** | Higher — use a paid aggregator proxy or find the venue's Eventbrite/AXS presence instead |
| **Smith's Olde Bar** (still open), ~~The EARL~~ ✅ The EARL WIRED 2026-07-17 (Freshtix HTML parser, `src/feeds/freshtix.ts`) | Use Freshtix (no public API) | Medium — scrape venue page |
| **Aisle 5** | SeeTickets US (partner-only API) | Medium — scrape `aisle5atl.com/calendar/` |
| **Terminal West** | AXS-ticketed (no public API) | Medium |
| **Venkman's** | BigTickets (no public API) | Medium |
| **Earl Smith Strand (Marietta)** | Salesforce Commerce ticketing | Medium — scrape `earlsmithstrand.org/calendar/` |
| **Masquerade** | Mostly TM-ticketed (reachable via TM API); edge shows on AXS/Freshtix | Low-medium |
| **Bandsintown city pages** | City search not in API; **ToS prohibits crawling** | Higher — avoid |
| **Creative Loafing Atlanta** | HTML only, no RSS/API | Medium |

---

## Dead ends — do NOT design against these (verified closed)

| Source | Verified status |
|---|---|
| **Eventful** | Dead since late 2020. API gone. |
| **Eventbrite public event search** | Removed permanently 2019-12-12. Can fetch by org/venue id only; no city-wide search. |
| **Songkick API** | Partner/paid only. Page explicitly refuses student/educational/hobbyist requests. |
| **DICE public API** | Partner-only GraphQL (MIO token required). |
| **AXS API** | Partner/client-only (B2B portal). |
| **SeeTickets US API** | Private/partner-only. |
| **Resident Advisor** | No public API; embed widget only. |
| **Bandsintown (city search)** | Doesn't exist — artist-lookup only; crawling prohibited. |
| **SeatGeek Platform API** | Gated; application + likely revenue-share required. |

---

## Atlanta Jazz Festival 2026 (the canonical TM blind spot)

- **Dates:** May 23–25, 2026 (Memorial Day weekend), Piedmont Park, ~1–9 PM daily.
- **Lineup:** `https://atljazzfest.com/2026-atlanta-jazz-festival-lineup/`
  - 5/23: Kamasi Washington, Nate Smith, Christian McBride & Ursa Major
  - 5/24: The Roots, Esperanza Spalding, Donnie
  - 5/25: PJ Morton, Butcher Brown, Destin Conrad
- **Feed:** None native. Reachable via **JamBase** (`jambase.com/festival/atlanta-jazz-festival-2026`) and listed on Eventbrite. Practical path = JamBase metro query.

---

## Cobb County — best 4

1. **Ticketmaster** with `latlong=33.9526,-84.5499&radius=20&unit=miles` (Marietta center) → Cobb Energy PAC, Mable House, Coca-Cola Roxy.
2. **Cobb Travel & Tourism iCal** (above) → county-wide curated/free.
3. **Marietta Glover Park** (Tier 2 static) → 6 free concerts.
4. **KSU Bailey (Localist JSON)** (above) → university concerts in Kennesaw.
   Bonus: **Kennesaw Depot Park** (Tier 2 static) → 4 free outdoor shows.

---

## Engineering notes

- JamBase Developer ceiling (1,000/mo) is comfortable for a daily ingest pass (~60/mo). Attribution required in any UI.
- TM caching restriction still applies to TM-sourced Event Content (reasonable serving periods only); open-feed sources (Trumba/Localist/RSS) carry their publishers' terms, generally fine to consume and cache.
- This map favors a **background-fetch model** (poll iCal/RSS/JSON on a schedule into a local store) over pure on-demand — which is part of why the web-app pivot fits better than the on-demand MCP for the long tail.
