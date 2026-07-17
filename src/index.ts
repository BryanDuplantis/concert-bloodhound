#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findAttractions, findVenue, searchEvents, TicketmasterError } from "./ticketmaster.js";
import { searchEvents as searchJamBaseEvents, jambaseMetroId } from "./jambase.js";
import { resolveLatLong, isLatLong, nearestMetroKey } from "./geo.js";
import { fetchMetroFeeds } from "./feeds/index.js";
import { feedMetros } from "./feeds/registry.js";
import {
  applyDateWindow,
  applyMaxPrice,
  artistMatches,
  byDateAsc,
  dedupeWithinSource,
  mergeConcerts,
  toEnd,
  toStart,
  venueMatches,
} from "./merge.js";
import { resultShape, type Concert } from "./types.js";
import { formatResults } from "./format.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Default metro radius when a city resolves to coordinates. */
const DEFAULT_RADIUS_MI = 30;

/**
 * Today's LOCAL date as YYYY-MM-DD. Open feeds carry their whole published
 * calendar, past events included, and unlike the Ticketmaster API they have no
 * server-side lower bound — so an undated "upcoming" search needs one applied
 * here or last week's shows surface as upcoming.
 */
const todayLocal = () => new Date().toLocaleDateString("en-CA");

/**
 * Decide whether to search geospatially. An explicit `latlong` wins; otherwise a
 * known metro name resolves to its centroid. Returns the coordinates plus an
 * optional display label, or null to fall back to Ticketmaster's `city` text
 * match (so unknown cities behave exactly as before).
 */
function resolveGeo(
  latlong: string | undefined,
  city: string | undefined,
): { latlong: string; label?: string; metroKey?: string } | null {
  if (latlong && isLatLong(latlong)) {
    const ll = latlong.trim();
    return { latlong: ll, metroKey: nearestMetroKey(ll) ?? undefined };
  }
  const metro = resolveLatLong(city);
  return metro ? { latlong: metro.latlong, label: metro.label, metroKey: metro.key } : null;
}

function errMsg(e: unknown): string {
  if (e instanceof TicketmasterError) return e.message;
  return `Unexpected error: ${(e as Error)?.message ?? String(e)}`;
}

const server = new McpServer({ name: "concert-bloodhound", version: "0.1.0" });

function ok(concerts: Concert[], summary: string) {
  return {
    content: [{ type: "text" as const, text: formatResults(concerts, summary) }],
    structuredContent: { summary, results: concerts },
  };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

server.registerTool(
  "search_concerts",
  {
    title: "Search Concerts",
    description:
      "Find upcoming concerts by city, genre, date range, and/or max ticket price via the Ticketmaster Discovery API. " +
      "Requires at least one of city, stateCode, or keyword. Returns real listings only — never invents prices, times, " +
      "availability, or links; absent fields are reported as 'not listed'. Resolve relative dates (e.g. 'this weekend') " +
      "to startDate/endDate before calling.",
    inputSchema: {
      city: z.string().optional().describe("City name, e.g. 'Chicago'. Major US metros auto-resolve to a geospatial search covering the whole metro (suburbs included)."),
      latlong: z.string().optional().describe("Geospatial center as 'lat,long' (e.g. '33.749,-84.388'). Use for cities outside the built-in metro list; overrides city and gives true metro-wide coverage with radius."),
      stateCode: z.string().length(2).optional().describe("US two-letter state code, e.g. 'IL'"),
      countryCode: z.string().length(2).optional().describe("Two-letter country code; defaults to US"),
      genre: z.string().optional().describe("Genre/classification, e.g. 'Rock', 'Jazz', 'Hip-Hop'"),
      keyword: z.string().optional().describe("Free-text search, e.g. festival or artist name"),
      startDate: z.string().regex(DATE_RE).optional().describe("Earliest date, YYYY-MM-DD"),
      endDate: z.string().regex(DATE_RE).optional().describe("Latest date, YYYY-MM-DD"),
      maxPrice: z.number().positive().optional().describe("Max ticket price; events with a higher listed minimum are excluded"),
      radius: z.number().positive().optional().describe("Search radius in miles around the city/coords (defaults to 30 when a metro or latlong is used)"),
      size: z.number().int().min(1).max(50).optional().describe("Results to return (default 10)"),
    },
    outputSchema: resultShape,
    annotations: readOnly,
  },
  async (args) => {
    if (!args.city && !args.stateCode && !args.keyword && !args.latlong) {
      return fail("Please provide a location to search: a city, a state code, coordinates, or a keyword.");
    }
    const want = args.size ?? 10;
    const fetchSize = args.maxPrice != null ? Math.min(Math.max(want * 2, 20), 50) : want;
    const geo = resolveGeo(args.latlong, args.city);

    // Open feeds augment a resolved metro only when no genre filter is set — they
    // carry no per-event genre, so honoring one would mean guessing. JamBase
    // augments any mapped metro: under a genre filter it honors the request itself
    // (matching the headliner's tags, never guessing), so it isn't gated off.
    const wantFeeds = !!geo?.metroKey && !args.genre;
    const jbId = geo?.metroKey ? jambaseMetroId(geo.metroKey) : null;

    // Fetch every source in parallel and settle each independently. Ticketmaster
    // is the backbone, but a TM outage must not suppress the supplementary
    // sources, and a JamBase/feed failure must never break TM — so no one source
    // can throw the whole call.
    const [tmRes, jbRes, feedRes] = await Promise.allSettled([
      searchEvents({
        // Geospatial wins: coords + radius cover the whole metro, so the city
        // text match is dropped — keeping it would narrow back to the city proper.
        city: geo ? undefined : args.city,
        latlong: geo?.latlong,
        radius: geo ? (args.radius ?? DEFAULT_RADIUS_MI) : args.radius,
        stateCode: args.stateCode,
        countryCode: args.countryCode,
        classificationName: args.genre,
        keyword: args.keyword,
        startDateTime: toStart(args.startDate),
        endDateTime: toEnd(args.endDate),
        size: fetchSize,
      }),
      jbId
        ? searchJamBaseEvents({
            geoMetroId: jbId,
            eventDateFrom: args.startDate,
            eventDateTo: args.endDate,
            genre: args.genre,
          })
        : Promise.resolve([] as Concert[]),
      wantFeeds
        ? fetchMetroFeeds(geo!.metroKey!, {
            start: args.startDate ?? todayLocal(),
            end: args.endDate,
          })
        : Promise.resolve([] as Concert[]),
    ]);

    let tm: Concert[] = [];
    let tmError: string | null = null;
    if (tmRes.status === "fulfilled") tm = tmRes.value;
    else tmError = errMsg(tmRes.reason);

    const jb = jbRes.status === "fulfilled" ? jbRes.value : [];
    if (jbRes.status === "rejected") console.error(`JamBase failed: ${errMsg(jbRes.reason)}`);
    const feed = feedRes.status === "fulfilled" ? feedRes.value : [];
    if (feedRes.status === "rejected") console.error(`Feeds failed: ${errMsg(feedRes.reason)}`);

    // Merge order = source priority: Ticketmaster wins (it alone carries price and
    // native ticket links), then JamBase, then open feeds. Dedup is artist|date.
    // Each source is made self-consistent first: TM can list one show twice when a
    // venue also sells through a ticketing partner, and a dupe that survives into
    // the merge would occupy two result slots and outrank a real show.
    let merged = mergeConcerts(mergeConcerts(dedupeWithinSource(tm), jb), feed);
    const extraCount = jb.length + feed.length;

    if (tmError && merged.length === 0) return fail(tmError);

    const windowed = applyDateWindow(merged, args.startDate, args.endDate);
    const results = applyMaxPrice(windowed, args.maxPrice).sort(byDateAsc).slice(0, want);
    const where = geo?.label ?? args.city ?? args.stateCode ?? "your search";

    if (results.length === 0) {
      return ok(
        results,
        `I didn't find concerts matching that search in ${where}. ` +
          `Try widening the dates, raising the price cap, a nearby city, or a different genre.`,
      );
    }
    const unknownPrice =
      args.maxPrice != null ? results.filter((c) => c.priceMin == null).length : 0;
    let summary = `Here ${results.length === 1 ? "is" : "are"} ${results.length} concert${
      results.length === 1 ? "" : "s"
    } in ${where}:`;
    if (tmError && extraCount > 0) {
      summary += " (Ticketmaster was unreachable — showing results from other sources only.)";
    } else if (unknownPrice > 0) {
      summary += ` (${unknownPrice} have no listed price and were kept rather than filtered out.)`;
    }
    return ok(results, summary);
  },
);

server.registerTool(
  "search_by_artist",
  {
    title: "Search Concerts by Artist",
    description:
      "Find upcoming concerts for a specific artist or band, optionally near a city and within a date range. " +
      "Real listings only — absent fields are reported as 'not listed'.",
    inputSchema: {
      artist: z.string().min(1).describe("Artist or band name"),
      city: z.string().optional().describe("Optional city to focus the search. Major US metros auto-resolve to a metro-wide geospatial search."),
      latlong: z.string().optional().describe("Geospatial center as 'lat,long'; overrides city for metro-wide coverage."),
      stateCode: z.string().length(2).optional(),
      countryCode: z.string().length(2).optional().describe("Defaults to US"),
      startDate: z.string().regex(DATE_RE).optional().describe("Earliest date, YYYY-MM-DD"),
      endDate: z.string().regex(DATE_RE).optional().describe("Latest date, YYYY-MM-DD"),
      maxPrice: z.number().positive().optional(),
      radius: z.number().positive().optional().describe("Search radius in miles around the city/coords (defaults to 30 when a metro or latlong is used)"),
      size: z.number().int().min(1).max(50).optional().describe("Results to return (default 10)"),
    },
    outputSchema: resultShape,
    annotations: readOnly,
  },
  async (args) => {
    const want = args.size ?? 10;
    const geo = resolveGeo(args.latlong, args.city);
    const near = geo?.label ?? args.city;

    // JamBase fires either scoped to a mapped metro, or — when the caller named no
    // place at all — nationwide, which its artistName filter supports and which is
    // what "where is this artist playing?" actually means. The one case it must sit
    // out: a place we CAN'T map (unknown city, raw latlong, a state or country
    // code). Going nationwide there would answer a Boise question with Nashville
    // shows — a wrong answer, worse than the coverage gap it closes.
    const askedForPlace = !!(args.city || args.latlong || args.stateCode || args.countryCode);
    const jbId = geo?.metroKey ? jambaseMetroId(geo.metroKey) : null;
    const wantJb = jbId != null || !askedForPlace;

    // Feeds follow the same scoping rule as JamBase, by a different route. They are
    // metro-keyed with no artist filter, so a nationwide artist search means
    // fetching each registered metro's calendar and matching client-side — cheap at
    // one metro, and the alternative is a false absence: an act playing only Red
    // Light would read "not touring" unless the caller happened to type "Atlanta".
    // A named-but-unmappable place still sits out, same as JamBase.
    const feedKeys = geo?.metroKey ? [geo.metroKey] : askedForPlace ? [] : feedMetros();

    // Ticketmaster leg: resolve the NAME to attraction entities, then query each
    // one's events. `keyword` is a text search over the whole record — it matches
    // venue names and cannot find the act: live, `keyword=Eagles` near Atlanta
    // returned Eagles of Death Metal, a Deorro show at Atlanta Eagles Arena, and a
    // church event, and zero Eagles. Filtering that output was the obvious fix and
    // the wrong one; it leaves fewer rows, not right ones.
    // Keyword survives ONLY as the fallback for an act TM has no attraction for —
    // better a loose answer than a false absence, and the summary says "matching".
    const geoArgs = {
      city: geo ? undefined : args.city,
      latlong: geo?.latlong,
      radius: geo ? (args.radius ?? DEFAULT_RADIUS_MI) : args.radius,
      stateCode: args.stateCode,
      countryCode: args.countryCode,
      startDateTime: toStart(args.startDate),
      endDateTime: toEnd(args.endDate),
      size: Math.min(Math.max(want, 20), 50),
    };
    const attractions = await findAttractions(args.artist).catch((e) => {
      console.error(`Attraction lookup failed: ${errMsg(e)}`);
      return [] as Awaited<ReturnType<typeof findAttractions>>;
    });

    const [tmRes, jbRes, feedRes] = await Promise.allSettled([
      attractions.length
        ? // allSettled, NOT all: the fan-out is several calls to one API, and
          // Promise.all makes any single failure (a rate limit, one bad id) a total
          // TM blackout — the exact degrade-per-source rule this file applies one
          // level up. One attraction failing must cost that act's shows, nothing more.
          Promise.allSettled(
            attractions.map((a) => searchEvents({ ...geoArgs, attractionId: a.id })),
          ).then((rs) => {
            rs.forEach((r, i) => {
              if (r.status === "rejected") {
                console.error(`Attraction "${attractions[i]!.name}" failed: ${errMsg(r.reason)}`);
              }
            });
            return rs.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
          })
        : searchEvents({ ...geoArgs, keyword: args.artist }),
      wantJb
        ? searchJamBaseEvents({
            artistName: args.artist,
            geoMetroId: jbId ?? undefined,
            eventDateFrom: args.startDate,
            eventDateTo: args.endDate,
          })
        : Promise.resolve([] as Concert[]),
      feedKeys.length
        ? Promise.all(
            feedKeys.map((m) =>
              fetchMetroFeeds(m, { start: args.startDate ?? todayLocal(), end: args.endDate }),
            ),
          ).then((r) => r.flat())
        : Promise.resolve([] as Concert[]),
    ]);

    const tm = tmRes.status === "fulfilled" ? tmRes.value : [];
    const tmError = tmRes.status === "rejected" ? errMsg(tmRes.reason) : null;
    const jb = jbRes.status === "fulfilled" ? jbRes.value : [];
    if (jbRes.status === "rejected") console.error(`JamBase failed: ${errMsg(jbRes.reason)}`);
    // Feeds are the only leg with no server-side artist filter, so it is filtered
    // here — and ONLY here. Running artistMatches over TM/JamBase rows would
    // second-guess a match they already made (PM-47).
    const feed = (feedRes.status === "fulfilled" ? feedRes.value : []).filter((c) =>
      artistMatches(c, args.artist),
    );
    if (feedRes.status === "rejected") console.error(`Feeds failed: ${errMsg(feedRes.reason)}`);

    // A TM outage must not decide the answer now that other sources can answer —
    // the same rule search_by_venue learned in 56fd07a. Only a total blackout fails.
    if (tmError && jb.length === 0 && feed.length === 0) return fail(tmError);

    const merged = mergeConcerts(mergeConcerts(dedupeWithinSource(tm), jb), feed);
    const windowed = applyDateWindow(merged, args.startDate, args.endDate);
    // Sort is load-bearing since JamBase joined: TM alone came back date,asc, but
    // merged rows are appended, so without this a JamBase-only show lands last
    // regardless of its date.
    const results = applyMaxPrice(windowed, args.maxPrice).sort(byDateAsc).slice(0, want);

    // "matching", not "{artist} concerts". Every leg here matches loosely — TM's
    // keyword hits venue names ("Eagles" -> a show at Atlanta Eagles Arena), and
    // feeds match a title that may name a tribute's SUBJECT rather than its
    // performer ("Sade vs Prince JAM" for a Prince search; Prince died in 2016).
    // Each row is honest on its own — artists carries the real billing — so this
    // line was the only thing asserting the artist actually plays. Promising
    // "Prince concerts" over a tribute is inventing a performer, which is the one
    // thing this product does not do. Narrow the claim, keep the results.
    let summary = results.length
      ? `Here ${results.length === 1 ? "is" : "are"} ${results.length} upcoming event${
          results.length === 1 ? "" : "s"
        } matching "${args.artist}"${near ? ` near ${near}` : ""} — check each billing, some may be tributes or other acts:`
      : `I didn't find upcoming events matching "${args.artist}"${near ? ` near ${near}` : ""}. ` +
        `They may not be touring that window${wantJb ? "" : ", and only Ticketmaster was searched for that location"}.`;
    if (tmError && results.length > 0) {
      summary += " (Ticketmaster was unreachable — showing results from other sources only.)";
    }
    return ok(results, summary);
  },
);

server.registerTool(
  "search_by_venue",
  {
    title: "Search Concerts by Venue",
    description:
      "Find upcoming concerts at a specific venue. Looks the venue up by name (add a city to disambiguate), then lists " +
      "its upcoming events from Ticketmaster plus any open calendar feeds covering that metro — so venues that exist " +
      "only in an open feed are found too. Real listings only — absent fields are reported as 'not listed'.",
    inputSchema: {
      venue: z.string().min(1).describe("Venue name, e.g. 'Red Rocks', 'The Fillmore'"),
      city: z.string().optional().describe("City to disambiguate the venue"),
      startDate: z.string().regex(DATE_RE).optional().describe("Earliest date, YYYY-MM-DD"),
      endDate: z.string().regex(DATE_RE).optional().describe("Latest date, YYYY-MM-DD"),
      maxPrice: z.number().positive().optional(),
      size: z.number().int().min(1).max(50).optional().describe("Results to return (default 10)"),
    },
    outputSchema: resultShape,
    annotations: readOnly,
  },
  async (args) => {
    const want = args.size ?? 10;

    // The venue lookup is Ticketmaster's, but the answer isn't: a feed-only room
    // (Red Light Café) has no TM venue id, so a TM miss or outage must not
    // suppress the feeds — it would report a confident "nothing listed" for a
    // venue whose shows we hold. Degrade per-source, exactly like search_concerts.
    let venue: Awaited<ReturnType<typeof findVenue>> = null;
    let venueErr: string | null = null;
    try {
      venue = await findVenue(args.venue, args.city);
    } catch (e) {
      venueErr = errMsg(e);
      console.error(`Ticketmaster venue lookup failed: ${venueErr}`);
    }

    // Feeds key off a metro, not a venue id. Prefer the caller's city; fall back
    // to whatever city TM matched.
    const geo = resolveGeo(undefined, args.city ?? venue?.city ?? undefined);

    const [tmRes, feedRes] = await Promise.allSettled([
      venue
        ? searchEvents({
            venueId: venue.id,
            startDateTime: toStart(args.startDate),
            endDateTime: toEnd(args.endDate),
            size: Math.min(Math.max(want, 20), 50),
          })
        : Promise.resolve([] as Concert[]),
      geo?.metroKey
        ? fetchMetroFeeds(geo.metroKey, {
            start: args.startDate ?? todayLocal(),
            end: args.endDate,
          })
        : Promise.resolve([] as Concert[]),
    ]);

    const tm = tmRes.status === "fulfilled" ? tmRes.value : [];
    if (tmRes.status === "rejected") console.error(`Ticketmaster failed: ${errMsg(tmRes.reason)}`);
    const feed = (feedRes.status === "fulfilled" ? feedRes.value : []).filter((c) =>
      venueMatches(c.venue, args.venue),
    );
    if (feedRes.status === "rejected") console.error(`Feeds failed: ${errMsg(feedRes.reason)}`);

    // Only now is "no such venue" honest — every source has been consulted.
    if (!venue && feed.length === 0) {
      return fail(
        venueErr ??
          `I couldn't find a venue matching "${args.venue}"${
            args.city ? ` in ${args.city}` : ""
          }. Try the full venue name or add a city.`,
      );
    }
    if (tmRes.status === "rejected" && feed.length === 0) return fail(errMsg(tmRes.reason));

    const merged = mergeConcerts(dedupeWithinSource(tm), feed);
    const windowed = applyDateWindow(merged, args.startDate, args.endDate);
    const results = applyMaxPrice(windowed, args.maxPrice).sort(byDateAsc).slice(0, want);
    const label = venue
      ? venue.city
        ? `${venue.name} (${venue.city})`
        : venue.name
      : (feed[0]?.venue ?? args.venue);
    const summary = results.length
      ? `Here ${results.length === 1 ? "is an" : "are"} upcoming concert${
          results.length === 1 ? "" : "s"
        } at ${label}:`
      : `I found ${label}, but no upcoming concerts are currently listed there for that window.`;
    return ok(results, summary);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Concert Bloodhound MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal error in main():", e);
  process.exit(1);
});
