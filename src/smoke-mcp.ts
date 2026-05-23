/**
 * Full-protocol smoke test — spawns the built server over stdio, lists its
 * tools, and calls search_concerts. This is the real positive signal: it
 * exercises tool registration + the stdio transport + the live API together.
 * Run: `npm run smoke:mcp` (server child loads .env via --env-file).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--env-file=.env", "dist/index.js"],
  });
  const client = new Client({ name: "concert-bloodhound-smoke", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.error("Registered tools:", tools.map((t) => t.name).join(", "));

  const res = (await client.callTool({
    name: "search_concerts",
    arguments: { city: "Chicago", size: 3 },
  })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  console.log("\n" + text);
  await client.close();

  const failed =
    res.isError ||
    !text ||
    /please provide|didn't find|error/i.test(text) ||
    !/Ticket Link:/.test(text);
  if (failed) {
    console.error("❌ MCP smoke failed: tool call did not return live concerts.");
    process.exit(1);
  }
  console.error("✅ MCP smoke passed: tools registered and live concerts returned over stdio.");
}

main().catch((e) => {
  console.error("❌ MCP smoke failed:", e?.message ?? e);
  process.exit(1);
});
