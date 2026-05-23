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

## Tier 1 — Clean to consume (open API or published feed, no legal gray)

Build these first. Each is an open REST API or a publicly published iCal/RSS/JSON feed.

| Source | Mechanism | Endpoint | Coverage / notes |
|---|---|---|---|
| **JamBase Data API** | REST JSON | `https://data.jambase.com/v3/events?geoMetroId=[ATL-id]` | **Biggest single win.** 15+ yrs of data, touring **and** independent venues, metro geo-filter. Free Developer tier = 1,000 calls/mo, non-commercial, attribution required. Surfaces the Jazz Fest. Pricing: `data.jambase.com/pricing` |
| **Ticketmaster Discovery** | REST JSON | `https://app.ticketmaster.com/discovery/v2/events?latlong=33.749,-84.388&radius=30&unit=miles` | Already integrated. **Switch from `city` to `latlong`+`radius`** for true metro/Cobb coverage — `postalCode` is text-match, not geospatial. Covers Cobb Energy PAC, Mable House, Fox, Tabernacle, Masquerade, Ameris Bank Amph. |
| **Battery ATL (Trumba)** | iCal/RSS/XML | `https://www.trumba.com/calendars/atlbrv.ics` | Free green-space shows at The Battery (Cobb). Verified live. |
| **Emory / Schwartz Center (Trumba)** | iCal/RSS/XML | `https://www.trumba.com/calendars/ec-events.ics` | Classical / jazz / world. Verified live. |
| **KSU Bailey Performance Center (Localist)** | JSON API + iCal | `https://calendar.kennesaw.edu/api/2/events` | University recitals in Kennesaw (Cobb). Public read, no auth. Filter by music dept id. |
| **GSU School of Music (Localist)** | JSON API + iCal | `https://calendar.gsu.edu/api/2/events?keyword=music` | 150+ events/yr. Per-event iCal export confirmed. |
| **Georgia Tech Arts (Drupal RSS)** | RSS | `https://calendar.gatech.edu/taxonomy/term/12/feed` | Arts & Performance category feed confirmed. |
| **Piedmont Park Conservancy** | iCal (The Events Calendar) | `webcal://piedmontpark.org/?post_type=tribe_events&ical=1&eventDisplay=list` | Park concerts/festivals. Verified live. |
| **Cobb Travel & Tourism** | iCal | `https://travelcobb.org/events/list/?shortcode=24f53d40&hide_subsequent_recurrences=1&ical=1` | County-wide curated: Glover Park, Kennesaw series, Mable House free shows. Verified live. |
| **Red Light Café (Squarespace)** | RSS | `http://redlightcafe.com/events?format=rss` | Indie venue; Squarespace native RSS. Confirmed live. |

### Generalizable feed patterns (reuse across sources)
- **Trumba:** append `.ics` / `.rss` / `.json` to any Trumba calendar URL. (Battery + Emory confirmed; many institutions use it.)
- **Localist:** `https://calendar.<school>.edu/api/2/events` → JSON, public, no auth. Paginate `?page=N`, filter `?keyword=music`. Enumerate dept ids via `/api/2/departments`. Docs: `developer.localist.com/doc/api`.

---

## Tier 2 — Low-effort static ingest (HTML only, tiny volume)

No machine feed, but only a handful of dates/year — cheap to parse or hand-enter.

- **Marietta / Glover Park Concert Series** — `mariettaga.gov/192/Glover-Park-Concert-Series` — 6 free Friday concerts May–Sep (40th-anniversary season). HTML + GovDelivery.
- **Kennesaw Depot Park Series** — `kennesaw-ga.gov` — 4 free outdoor concerts Mar–Sep at United Bankshares Amphitheater. News-release HTML only.
- **Smyrna Village Green / Blanket Concert Series** — `smyrnaga.gov` (CivicPlus CMS; 403 on direct fetch). Free; manual/scrape.

---

## Scrape-required / legally gray (weigh case-by-case; defer)

Prefer not to build on these until Tier 1+2 are exhausted. Each carries its own ToS risk.

| Source | Why no feed | Risk |
|---|---|---|
| **DICE** (Eddie's Attic + indie) | Ticket-Holders API is partner-only GraphQL; **ToS prohibits scraping** | Higher — use a paid aggregator proxy or find the venue's Eventbrite/AXS presence instead |
| **Smith's Olde Bar, The EARL** | Use Freshtix (no public API) | Medium — scrape venue page |
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
