#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./build-server.js";

/**
 * Entry point. Default transport is stdio — the local Claude Code config
 * spawns dist/index.js with no args and must keep working unchanged. The Pi
 * systemd unit passes `--transport http` to run the OAuth-gated HTTP server
 * (see http.ts). http.ts is imported lazily so the stdio path never loads
 * express or the auth stack.
 */
function shouldUseHttp(argv: string[]): boolean {
  const i = argv.indexOf("--transport");
  if (i === -1) return false;
  return argv[i + 1] === "http";
}

async function main() {
  if (shouldUseHttp(process.argv)) {
    const { runHttp } = await import("./http.js");
    await runHttp();
    return;
  }
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  console.error("Concert Bloodhound MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal error in main():", e);
  process.exit(1);
});
