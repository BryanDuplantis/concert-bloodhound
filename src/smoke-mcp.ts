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

  await client.close();

  if (failed(chicago) || failed(atlanta)) {
    console.error("❌ MCP smoke failed: a tool call did not return live concerts.");
    process.exit(1);
  }
  console.error(
    "✅ MCP smoke passed: tools registered; city text + metro-geospatial searches both returned live concerts over stdio.",
  );
}

main().catch((e) => {
  console.error("❌ MCP smoke failed:", e?.message ?? e);
  process.exit(1);
});
