/**
 * Full-protocol smoke test — spawns the built server over stdio, lists its
 * tools, and calls search_concerts twice: once with a plain city (text match)
 * and once with a metro that auto-resolves to a latlong + radius geospatial
 * search inside the server. This is the real positive signal: it exercises tool
 * registration + the stdio transport + city→coords resolution + the live API
 * together. Run: `npm run smoke:mcp` (server child loads .env via --env-file).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

const textOf = (res: ToolResult): string =>
  res.content?.find((c) => c.type === "text")?.text ?? "";

/**
 * Dates rendered as upcoming that have already passed. Open feeds publish their
 * whole calendar with no server-side lower bound (unlike the TM API), so this is
 * the guard that an undated search still never answers with a past show.
 */
const pastDatesIn = (res: ToolResult): string[] => {
  const today = new Date().toLocaleDateString("en-CA");
  return [...textOf(res).matchAll(/^\s*Date: \w+, (\w+ \d+, \d{4})$/gm)]
    .map((m) => new Date(m[1]).toLocaleDateString("en-CA"))
    .filter((d) => d < today);
};

/** A call failed unless it returned at least one real listing with a ticket link. */
const failed = (res: ToolResult): boolean => {
  const text = textOf(res);
  return !!res.isError || !text || /please provide|didn't find|error/i.test(text) || !/Ticket Link:/.test(text);
};

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--env-file=.env", "dist/index.js"],
  });
  const client = new Client({ name: "concert-bloodhound-smoke", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.error("Registered tools:", tools.map((t) => t.name).join(", "));

  // 1) Baseline city text match over the protocol.
  const chicago = (await client.callTool({
    name: "search_concerts",
    arguments: { city: "Chicago", size: 3 },
  })) as ToolResult;
  console.log("\n[Chicago — city text]\n" + textOf(chicago));

  // 2) Metro geospatial path: "Atlanta" auto-resolves to latlong + radius=30
  //    inside the server, exercising the new resolution end-to-end over stdio.
  const atlanta = (await client.callTool({
    name: "search_concerts",
    arguments: { city: "Atlanta", radius: 30, size: 3 },
  })) as ToolResult;
  console.log("\n[Atlanta — metro geospatial]\n" + textOf(atlanta));

  // 3) Feed-only venue: Red Light Café exists in the open-feed layer, not in
  //    Ticketmaster's event catalog. Guards the false-absence bug — search_by_venue
  //    once answered "no upcoming concerts listed" while the feeds held its shows.
  //    Also exercises the ASCII query → accented feed venue match ("Cafe" → "Café").
  const redlight = (await client.callTool({
    name: "search_by_venue",
    arguments: { venue: "Red Light Cafe", city: "Atlanta", size: 5 },
  })) as ToolResult;
  console.log("\n[Red Light Café — feed-only venue]\n" + textOf(redlight));

  // 4) A second feed-only venue, same failure class: The EARL sells via
  //    Freshtix, outside TM's catalog. Confirmed miss 2026-07-09, closed
  //    2026-07-17 (freshtix.ts). Locks the fix in as a regression guard —
  //    without this leg nothing catches the source going quiet again.
  const earl = (await client.callTool({
    name: "search_by_venue",
    arguments: { venue: "The Earl", city: "Atlanta", size: 5 },
  })) as ToolResult;
  console.log("\n[The EARL — feed-only venue]\n" + textOf(earl));

  await client.close();

  const redlightText = textOf(redlight);
  const staleVenue = pastDatesIn(redlight);
  const earlText = textOf(earl);
  const staleEarl = pastDatesIn(earl);
  // Atlanta is the metro with open feeds registered, so it's the leg that can
  // regress: an undated search there once returned nothing BUT past feed events.
  const staleAtlanta = pastDatesIn(atlanta);
  const redlightFailed =
    !!redlight.isError ||
    /no upcoming concerts are currently listed|couldn't find a venue/i.test(redlightText) ||
    !/Red Light/i.test(redlightText) ||
    staleVenue.length > 0;
  const earlFailed =
    !!earl.isError ||
    /no upcoming concerts are currently listed|couldn't find a venue/i.test(earlText) ||
    !/EARL/i.test(earlText) ||
    staleEarl.length > 0;

  if (failed(chicago) || failed(atlanta) || redlightFailed || earlFailed || staleAtlanta.length > 0) {
    console.error("❌ MCP smoke failed: a tool call did not return live concerts.");
    if (staleAtlanta.length > 0) {
      console.error(`   search_concerts returned past-dated shows as upcoming: ${staleAtlanta.join(", ")}`);
    }
    if (staleVenue.length > 0) {
      console.error(`   search_by_venue returned past-dated shows as upcoming: ${staleVenue.join(", ")}`);
    } else if (redlightFailed) {
      console.error("   search_by_venue returned no Red Light Café shows — the feed layer is not reaching it.");
    }
    if (staleEarl.length > 0) {
      console.error(`   search_by_venue returned past-dated EARL shows as upcoming: ${staleEarl.join(", ")}`);
    } else if (earlFailed) {
      console.error("   search_by_venue returned no EARL shows — the Freshtix feed is not reaching it.");
    }
    process.exit(1);
  }
  console.error(
    "✅ MCP smoke passed: tools registered; city text + metro-geospatial searches returned live concerts, " +
      "and search_by_venue surfaced two feed-only venues, all over stdio.",
  );
}

main().catch((e) => {
  console.error("❌ MCP smoke failed:", e?.message ?? e);
  process.exit(1);
});
