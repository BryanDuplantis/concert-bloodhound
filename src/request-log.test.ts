/**
 * Pins requestLog + tagRoute against a PREFIXED deployment (basePath
 * "/bloodhound", as on the Pi) and against the REAL SDK handlers whose
 * rejections carry no logCode: tokenHandler (OAuth error JSON) and the
 * stateless StreamableHTTP transport (JSON-RPC error JSON). Offline, ephemeral
 * loopback port. The app below mirrors http.ts's tag mounts.
 *
 * Positive control: an /authorize route mounted WITHOUT its tag must not log
 * flow=authorize — that proves route identity comes from the tag, and that the
 * flow=authorize assertions can fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requestLog, tagRoute, classifyErrorBody } from "./middleware/request-log.js";

const BASE = "/bloodhound";
const SECRET = "tok_SHOULD_NEVER_BE_LOGGED";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

const stubProvider = {
  clientsStore: { getClient: async () => undefined },
} as unknown as OAuthServerProvider;

function buildApp({ tagged = true } = {}): express.Express {
  const app = express();
  app.use(requestLog);
  if (tagged) {
    app.all(`${BASE}/authorize`, tagRoute("authorize"));
    app.all(`${BASE}/authorize/consent`, tagRoute("consent"));
    app.all(`${BASE}/token`, tagRoute("token"));
    app.all(`${BASE}/mcp`, tagRoute("mcp"));
  }
  app.use(`${BASE}/mcp`, express.json({ limit: "1mb" }));
  app.get(`${BASE}/authorize`, (req, res) => {
    res.redirect(302, req.query.deny ? `${CALLBACK}?error=access_denied` : `${CALLBACK}?code=abc`);
  });
  app.post(`${BASE}/authorize/consent`, (_req, res) => {
    res.redirect(302, `${BASE}/authorize?client_id=c`);
  });
  app.use(`${BASE}/token`, tokenHandler({ provider: stubProvider }));
  app.get(`${BASE}/ok`, (_req, res) => {
    res.status(200).json({ access_token: SECRET });
  });
  app.get(`${BASE}/coded`, (_req, res) => {
    res.locals.logCode = "bad-auth-header";
    res.status(401).json({ error: "invalid_token" });
  });
  app.post(`${BASE}/mcp`, async (req, res) => {
    const server = new McpServer({ name: "t", version: "0" });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return app;
}

/**
 * Log lines land from the server's 'finish' handler, after the client already
 * has its response — so wait for `expect` lines (bounded), never a fixed sleep.
 * For expect 0 the settle window is what gives a stray line the chance to show.
 */
async function withApp(
  expect: number,
  fn: (base: string) => Promise<void>,
  app: express.Express = buildApp(),
): Promise<string[]> {
  const logged: string[] = [];
  const origError = console.error;
  const server = app.listen(0, "127.0.0.1");
  const ours = () => logged.filter((l) => l.startsWith("[concert-bloodhound]"));
  try {
    await new Promise<void>((r) => server.once("listening", () => r()));
    const { port } = server.address() as AddressInfo;
    console.error = (...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    };
    await fn(`http://127.0.0.1:${port}${BASE}`);
    const deadline = Date.now() + (expect === 0 ? 150 : 2000);
    while (Date.now() < deadline && (expect === 0 || ours().length < expect)) {
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    console.error = origError;
    await new Promise<void>((r) => server.close(() => r()));
  }
  const lines = ours();
  assert.equal(lines.length, expect, lines.join("\n"));
  return lines;
}

const mcpPost = (url: string, opts: { version?: string; accept?: string; type?: string; body?: string } = {}) =>
  fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": opts.type ?? "application/json",
      accept: opts.accept ?? "application/json, text/event-stream",
      ...(opts.version ? { "mcp-protocol-version": opts.version } : {}),
    },
    body: opts.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

const initialize = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

test("prefixed /authorize 302 logs flow=authorize, Location never logged", async () => {
  const [line] = await withApp(1, async (u) => {
    await fetch(`${u}/authorize`, { redirect: "manual" });
  });
  assert.match(line, / GET \/bloodhound\/authorize 302 flow=authorize /);
  assert.doesNotMatch(line, /code=|auth_callback/);
});

test("trailing-slash and case variants Express routes to /authorize still log flow=authorize", async () => {
  const lines = await withApp(2, async (u) => {
    await fetch(`${u}/authorize/`, { redirect: "manual" });
    await fetch(`${u.replace(BASE, BASE.toUpperCase())}/AUTHORIZE`, { redirect: "manual" });
  });
  for (const l of lines) assert.match(l, / 302 flow=authorize /);
});

test("positive control: an untagged /authorize route does not log flow=authorize", async () => {
  await withApp(
    0,
    async (u) => {
      await fetch(`${u}/authorize`, { redirect: "manual" });
    },
    buildApp({ tagged: false }),
  );
});

test("an /authorize redirect carrying error= is tagged oauth-redirect-error", async () => {
  const [line] = await withApp(1, async (u) => {
    await fetch(`${u}/authorize?deny=1`, { redirect: "manual" });
  });
  assert.match(line, / 302 flow=authorize code=oauth-redirect-error /);
  assert.doesNotMatch(line, /access_denied/);
});

test("a successful consent submit logs flow=consent", async () => {
  const [line] = await withApp(1, async (u) => {
    await fetch(`${u}/authorize/consent`, { method: "POST", redirect: "manual" });
  });
  assert.match(line, / POST \/bloodhound\/authorize\/consent 302 flow=consent /);
});

test("/token 400 from the real SDK handler carries the OAuth error code", async () => {
  const [line] = await withApp(1, async (u) => {
    const r = await fetch(`${u}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "r", client_id: "nope" }),
    });
    assert.equal(r.status, 400);
  });
  assert.match(line, /POST \/bloodhound\/token 400 code=oauth-invalid_client /);
  assert.doesNotMatch(line, /Invalid client_id|mcpver=/);
});

// One case per JSONRPC_CLASSES entry, through the real stateless transport.
const mcpCases: Array<[string, Parameters<typeof mcpPost>[1], number, string]> = [
  ["unsupported version", { version: "2099-01-01" }, 400, "code=unsupported-protocol-version mcpver=2099-01-01"],
  ["malformed version", { version: "not-a-date" }, 400, "code=unsupported-protocol-version mcpver=other"],
  ["two initialize requests", { body: JSON.stringify([initialize(1), initialize(2)]) }, 400, "code=multiple-initialize"],
  ["JSON that is not JSON-RPC", { body: JSON.stringify({ foo: 1 }) }, 400, "code=parse-error"],
  ["Accept without event-stream", { accept: "application/json" }, 406, "code=not-acceptable"],
  ["non-JSON content type", { type: "text/plain" }, 415, "code=unsupported-media-type"],
];
for (const [name, opts, status, expected] of mcpCases) {
  test(`/mcp ${status} (${name}) is classified`, async () => {
    const [line] = await withApp(1, async (u) => {
      const r = await mcpPost(u, opts);
      assert.equal(r.status, status);
      await r.text();
    });
    assert.ok(line.includes(`POST /bloodhound/mcp ${status} ${expected} `), line);
    assert.doesNotMatch(line, /supported versions|Invalid JSON|Client must/);
  });
}

test("/mcp with a supported version does not log", async () => {
  await withApp(0, async (u) => {
    const r = await mcpPost(u, { version: "2025-06-18" });
    assert.ok(r.status < 400, `status ${r.status}`);
    await r.text();
  });
});

test("an explicit logCode wins over the body; a 200 body is never logged", async () => {
  const lines = await withApp(1, async (u) => {
    await (await fetch(`${u}/coded`)).text();
    await (await fetch(`${u}/ok`)).text();
  });
  assert.match(lines[0], /GET \/bloodhound\/coded 401 code=bad-auth-header /);
  assert.ok(!lines.join("\n").includes(SECRET));
});

test("classifyErrorBody only emits closed-vocabulary values", () => {
  assert.equal(classifyErrorBody('{"error":"invalid_grant","error_description":"x"}'), "oauth-invalid_grant");
  assert.equal(classifyErrorBody('{"error":"Evil Value\\nInjected"}'), "oauth-other");
  assert.equal(
    classifyErrorBody('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Something new"},"id":null}'),
    "jsonrpc-32000",
  );
  assert.equal(classifyErrorBody("<html>not json</html>"), undefined);
});
