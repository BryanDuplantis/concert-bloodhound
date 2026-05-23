#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findVenue, searchEvents, TicketmasterError } from "./ticketmaster.js";
import { resultShape, type Concert } from "./types.js";
import { formatResults } from "./format.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toStart = (d?: string) => (d ? `${d}T00:00:00Z` : undefined);
const toEnd = (d?: string) => (d ? `${d}T23:59:59Z` : undefined);

/**
 * Drop events whose listed minimum exceeds the budget. Events with no listed
 * price are kept (we can't confirm they're over budget) and flagged downstream
 * — honoring the spec's "don't invent, don't silently exclude" rule.
 */
function applyMaxPrice(concerts: Concert[], maxPrice?: number): Concert[] {
  if (maxPrice == null) return concerts;
  return concerts.filter((c) => c.priceMin == null || c.priceMin <= maxPrice);
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
      city: z.string().optional().describe("City name, e.g. 'Chicago'"),
      stateCode: z.string().length(2).optional().describe("US two-letter state code, e.g. 'IL'"),
      countryCode: z.string().length(2).optional().describe("Two-letter country code; defaults to US"),
      genre: z.string().optional().describe("Genre/classification, e.g. 'Rock', 'Jazz', 'Hip-Hop'"),
      keyword: z.string().optional().describe("Free-text search, e.g. festival or artist name"),
      startDate: z.string().regex(DATE_RE).optional().describe("Earliest date, YYYY-MM-DD"),
      endDate: z.string().regex(DATE_RE).optional().describe("Latest date, YYYY-MM-DD"),
      maxPrice: z.number().positive().optional().describe("Max ticket price; events with a higher listed minimum are excluded"),
      radius: z.number().positive().optional().describe("Search radius in miles around the city"),
      size: z.number().int().min(1).max(50).optional().describe("Results to return (default 10)"),
    },
    outputSchema: resultShape,
    annotations: readOnly,
  },
  async (args) => {
    if (!args.city && !args.stateCode && !args.keyword) {
      return fail("Please provide a location to search: a city, a state code, or a keyword.");
    }
    const want = args.size ?? 10;
    const fetchSize = args.maxPrice != null ? Math.min(Math.max(want * 2, 20), 50) : want;
    try {
      const raw = await searchEvents({
        city: args.city,
        stateCode: args.stateCode,
        countryCode: args.countryCode,
        classificationName: args.genre,
        keyword: args.keyword,
        startDateTime: toStart(args.startDate),
        endDateTime: toEnd(args.endDate),
        radius: args.radius,
        size: fetchSize,
      });
      const results = applyMaxPrice(raw, args.maxPrice).slice(0, want);
      const where = args.city ?? args.stateCode ?? "your search";

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
      if (unknownPrice > 0) {
        summary += ` (${unknownPrice} have no listed price and were kept rather than filtered out.)`;
      }
      return ok(results, summary);
    } catch (e) {
      return fail(errMsg(e));
    }
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
      city: z.string().optional().describe("Optional city to focus the search"),
      stateCode: z.string().length(2).optional(),
      countryCode: z.string().length(2).optional().describe("Defaults to US"),
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
      const raw = await searchEvents({
        keyword: args.artist,
        city: args.city,
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
            args.city ? ` near ${args.city}` : ""
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
