#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findVenue, searchEvents, TicketmasterError } from "./ticketmaster.js";
import { resolveLatLong, isLatLong, nearestMetroKey } from "./geo.js";
import { fetchMetroFeeds } from "./feeds/index.js";
import { applyMaxPrice, byDateAsc, mergeConcerts } from "./merge.js";
import { resultShape, type Concert } from "./types.js";
import { formatResults } from "./format.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toStart = (d?: string) => (d ? `${d}T00:00:00Z` : undefined);
const toEnd = (d?: string) => (d ? `${d}T23:59:59Z` : undefined);

/** Default metro radius when a city resolves to coordinates. */
const DEFAULT_RADIUS_MI = 30;

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

    // Ticketmaster is the backbone; a TM outage shouldn't suppress open-feed
    // results, so capture its error rather than throwing the whole call.
    let tm: Concert[] = [];
    let tmError: string | null = null;
    try {
      tm = await searchEvents({
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
      });
    } catch (e) {
      tmError = errMsg(e);
    }

    // Open feeds augment a resolved metro. Skipped when a genre filter is set —
    // the feeds carry no per-event genre, so we can't honor it without guessing.
    let merged = tm;
    let feedCount = 0;
    if (geo?.metroKey && !args.genre) {
      const feedEvents = await fetchMetroFeeds(geo.metroKey, {
        start: args.startDate,
        end: args.endDate,
      });
      feedCount = feedEvents.length;
      merged = mergeConcerts(tm, feedEvents);
    }

    if (tmError && merged.length === 0) return fail(tmError);

    const results = applyMaxPrice(merged, args.maxPrice).sort(byDateAsc).slice(0, want);
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
    if (tmError && feedCount > 0) {
      summary += " (Ticketmaster was unreachable — showing open-feed listings only.)";
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
    try {
      const raw = await searchEvents({
        keyword: args.artist,
        city: geo ? undefined : args.city,
        latlong: geo?.latlong,
        radius: geo ? (args.radius ?? DEFAULT_RADIUS_MI) : args.radius,
        stateCode: args.stateCode,
        countryCode: args.countryCode,
        startDateTime: toStart(args.startDate),
        endDateTime: toEnd(args.endDate),
        size: Math.min(Math.max(want, 20), 50),
      });
      const results = applyMaxPrice(raw, args.maxPrice).slice(0, want);
      const summary = results.length
        ? `Here ${results.length === 1 ? "is" : "are"} upcoming ${args.artist} concert${
            results.length === 1 ? "" : "s"
          }:`
        : `I didn't find upcoming ${args.artist} concerts${
            near ? ` near ${near}` : ""
          }. They may not be touring that window, or the dates aren't on Ticketmaster yet.`;
      return ok(results, summary);
    } catch (e) {
      return fail(errMsg(e));
    }
  },
);

server.registerTool(
  "search_by_venue",
  {
    title: "Search Concerts by Venue",
    description:
      "Find upcoming concerts at a specific venue. Looks the venue up by name (add a city to disambiguate), then lists " +
      "its upcoming events. Real listings only — absent fields are reported as 'not listed'.",
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
    try {
      const venue = await findVenue(args.venue, args.city);
      if (!venue) {
        return fail(
          `I couldn't find a venue matching "${args.venue}"${
            args.city ? ` in ${args.city}` : ""
          }. Try the full venue name or add a city.`,
        );
      }
      const raw = await searchEvents({
        venueId: venue.id,
        startDateTime: toStart(args.startDate),
        endDateTime: toEnd(args.endDate),
        size: Math.min(Math.max(want, 20), 50),
      });
      const results = applyMaxPrice(raw, args.maxPrice).slice(0, want);
      const label = venue.city ? `${venue.name} (${venue.city})` : venue.name;
      const summary = results.length
        ? `Here ${results.length === 1 ? "is" : "are"} upcoming concert${
            results.length === 1 ? "" : "s"
          } at ${label}:`
        : `I found ${label}, but no upcoming concerts are currently listed there for that window.`;
      return ok(results, summary);
    } catch (e) {
      return fail(errMsg(e));
    }
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
