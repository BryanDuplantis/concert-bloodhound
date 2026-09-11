/**
 * Live behavioral smoke for the HTTP transport + OAuth stack (constraint 6 of
 * the bloodhound-remote-mcp gate: compile success on ported auth code is not
 * proof — the consent, token, and 401-discovery flows must be exercised).
 *
 * Boots `dist/index.js --transport http` as a child on a scratch port with a
 * scratch OAuth state dir, then walks:
 *   1. /health
 *   2. POST /mcp unauthenticated → 401 + WWW-Authenticate resource_metadata (RFC 9728)
 *   3. /.well-known/oauth-authorization-server discovery
 *   4. DCR /register: allowlisted redirect_uri accepted, foreign one rejected
 *   5. Consent: GET /authorize → password form; wrong password → 401;
 *      right password → 302 + cookie; cookied /authorize → code on redirect
 *   6. /token: PKCE code exchange → access + refresh; refresh grant re-mints
 *   7. MCP over HTTP via the real SDK client: initialize + tools/list under
 *      the static Bearer secret AND under the OAuth access token; tools/call
 *      (search_concerts Atlanta) asserting structuredContent is present when
 *      TICKETMASTER_API_KEY is available (skipped, loudly, when not).
 *   8. (runs right after /health) Proxy trust on the REAL app: two forwarded
 *      clients get independent SDK /token rate-limit buckets, and the child
 *      logs no ERR_ERL_ warning. Unit tests build their own app, so only this
 *      step fails if runHttp stops applying TRUST_PROXY.
 *
 * Exit non-zero on any failure. Run: npm run build && npm run smoke:http
 * (pass API keys via --env-file=.env for the tools/call leg).
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 3013;
const BASE = `http://127.0.0.1:${PORT}`;
// Path-prefixed config — the production shape on the Pi (Option A: /bloodhound
// under the shared 443 Funnel). The smoke exercises the SAME prefix so the
// prefix-aware mounts, metadata strings, and consent form action are what get
// behaviorally proven, not the root layout production no longer runs.
const PREFIX = "/bloodhound";
const PUB = `${BASE}${PREFIX}`;
const SECRET = "smoke-test-secret-not-a-real-credential";
const PASSWORD = "smoke-test-password";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitForHealth(deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${PUB}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become healthy in time");
}

async function mcpRoundTrip(label: string, token: string, withToolCall: boolean): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(`${PUB}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "smoke-http", version: "0.0.1" });
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check(
    `${label}: tools/list returns the three tools`,
    JSON.stringify(names) === JSON.stringify(["search_by_artist", "search_by_venue", "search_concerts"]),
    JSON.stringify(names),
  );
  const declaresOutput = tools.tools.every((t) => t.outputSchema != null);
  check(`${label}: every tool declares outputSchema`, declaresOutput);
  if (withToolCall) {
    const res = await client.callTool({
      name: "search_concerts",
      arguments: { city: "Atlanta", size: 3 },
    });
    const sc = (res as { structuredContent?: { results?: unknown[] } }).structuredContent;
    check(
      `${label}: tools/call returns structuredContent with results[]`,
      sc != null && Array.isArray(sc.results),
      JSON.stringify(res).slice(0, 200),
    );
  }
  await client.close();
}

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bloodhound-smoke-oauth-"));
  const haveTmKey = !!process.env.TICKETMASTER_API_KEY;

  const child: ChildProcess = spawn(
    process.execPath,
    ["dist/index.js", "--transport", "http"],
    {
      env: {
        ...process.env,
        MCP_PORT: String(PORT),
        MCP_SECRET: SECRET,
        PUBLIC_BASE_URL: PUB,
        OAUTH_AUTHORIZE_PASSWORD: PASSWORD,
        OAUTH_ALLOWED_REDIRECT_URIS: CALLBACK,
        MCP_ALLOWED_ORIGINS: "https://claude.ai,https://claude.com",
        BLOODHOUND_OAUTH_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let childStderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    childStderr += d.toString();
    process.stderr.write(`  [child] ${d}`);
  });

  try {
    await waitForHealth(10_000);

    // 1. /health
    const health = (await (await fetch(`${PUB}/health`)).json()) as { service?: string };
    check("health names the service", health.service === "concert-bloodhound");

    // 8 (runs here, not last). express-rate-limit validates only a limiter's
    // FIRST request, so these must be the first /token hits for the ERR_ERL
    // check at the end to be able to fail. Without trust, all three calls
    // share the 127.0.0.1 bucket and B lands at A2 - 1.
    const tokenRemaining = async (xff: string): Promise<number | null> => {
      const r = await fetch(`${PUB}/token`, { method: "POST", headers: { "X-Forwarded-For": xff } });
      await r.arrayBuffer();
      const v = r.headers.get("ratelimit-remaining");
      return v === null ? null : Number(v);
    };
    const a1 = await tokenRemaining("198.51.100.1");
    const a2 = await tokenRemaining("198.51.100.1");
    const b1 = await tokenRemaining("198.51.100.2");
    check("SDK /token limiter ran (RateLimit-Remaining present)", a1 !== null && a2 !== null && b1 !== null);
    check(
      "same forwarded client shares a bucket, a different one gets a fresh bucket",
      a1 !== null && a2 === a1 - 1 && b1 === a1,
      `a1=${a1} a2=${a2} b1=${b1}`,
    );

    // 2. Unauthenticated /mcp → 401 with RFC 9728 discovery pointer
    const unauth = await fetch(`${PUB}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    check("unauthenticated /mcp is 401", unauth.status === 401);
    const www = unauth.headers.get("www-authenticate") ?? "";
    check(
      "401 carries resource_metadata discovery (RFC 9728 insertion form)",
      www.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource${PREFIX}/mcp"`),
      www,
    );

    // 3. AS discovery — RFC 8414 insertion form, plus the appended-form fallback
    const disco = (await (
      await fetch(`${BASE}/.well-known/oauth-authorization-server${PREFIX}`)
    ).json()) as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string };
    check(
      "AS discovery advertises prefixed authorize+token",
      disco.authorization_endpoint === `${PUB}/authorize` && disco.token_endpoint === `${PUB}/token`,
      JSON.stringify(disco),
    );
    const discoAppended = (await (
      await fetch(`${PUB}/.well-known/oauth-authorization-server`)
    ).json()) as { issuer?: string };
    check(
      "appended-form AS discovery serves the same issuer",
      discoAppended.issuer === disco.issuer && !!disco.issuer,
      JSON.stringify(discoAppended),
    );

    // 4. DCR — foreign redirect_uri rejected, allowlisted accepted
    const badReg = await fetch(`${PUB}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }),
    });
    check("DCR rejects foreign redirect_uri", badReg.status === 400, String(badReg.status));

    const reg = await fetch(`${PUB}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "client_secret_post" }),
    });
    const client = (await reg.json()) as { client_id?: string; client_secret?: string };
    check(
      "DCR registers the allowlisted client",
      reg.status === 201 && !!client.client_id && !!client.client_secret,
      String(reg.status),
    );

    // 5. Consent flow
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const authzQs = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id!,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "smoke-state",
    });

    const form = await fetch(`${PUB}/authorize?${authzQs}`, { redirect: "manual" });
    const formHtml = await form.text();
    check(
      "no-cookie /authorize renders the password form with a prefixed action",
      form.status === 200 && formHtml.includes(`action="${PREFIX}/authorize/consent"`),
      String(form.status),
    );

    const consentBody = (pw: string) =>
      new URLSearchParams({ password: pw, ...Object.fromEntries(authzQs) });
    const badPw = await fetch(`${PUB}/authorize/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: consentBody("wrong-password"),
      redirect: "manual",
    });
    check("wrong consent password is 401", badPw.status === 401, String(badPw.status));

    const goodPw = await fetch(`${PUB}/authorize/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: consentBody(PASSWORD),
      redirect: "manual",
    });
    const setCookie = goodPw.headers.get("set-cookie") ?? "";
    check(
      "right password 302s with consent cookie",
      goodPw.status === 302 && setCookie.includes("bloodhound_oauth_consent="),
      `${goodPw.status} ${setCookie.slice(0, 60)}`,
    );
    const cookie = setCookie.split(";")[0]!;

    const authz = await fetch(`${PUB}/authorize?${authzQs}`, {
      redirect: "manual",
      headers: { Cookie: cookie },
    });
    const loc = authz.headers.get("location") ?? "";
    const code = loc.startsWith(CALLBACK) ? new URL(loc).searchParams.get("code") : null;
    check(
      "cookied /authorize mints a code to the registered callback",
      authz.status === 302 && !!code && new URL(loc).searchParams.get("state") === "smoke-state",
      `${authz.status} ${loc.slice(0, 80)}`,
    );

    // 6. Token exchange + refresh
    const tokenRes = await fetch(`${PUB}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: verifier,
        redirect_uri: CALLBACK,
        client_id: client.client_id!,
        client_secret: client.client_secret!,
      }),
    });
    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    check(
      "PKCE code exchange returns access+refresh tokens",
      tokenRes.status === 200 && !!tokens.access_token && !!tokens.refresh_token,
      String(tokenRes.status),
    );

    const refreshRes = await fetch(`${PUB}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token!,
        client_id: client.client_id!,
        client_secret: client.client_secret!,
      }),
    });
    const refreshed = (await refreshRes.json()) as { access_token?: string };
    check(
      "refresh grant re-mints an access token",
      refreshRes.status === 200 && !!refreshed.access_token && refreshed.access_token !== tokens.access_token,
      String(refreshRes.status),
    );

    // 7. Real MCP over HTTP — static secret and OAuth token paths
    if (!haveTmKey) {
      console.log("  SKIP tools/call legs — TICKETMASTER_API_KEY not set (run with --env-file=.env)");
    }
    await mcpRoundTrip("bearer-secret", SECRET, haveTmKey);
    await mcpRoundTrip("oauth-token", tokens.access_token!, false);

    // Bad token still 401s
    const badTok = await fetch(`${PUB}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer not-a-real-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    check("garbage bearer token is 401", badTok.status === 401, String(badTok.status));

    check(
      "no ERR_ERL_ warning from the real app",
      !childStderr.includes("ERR_ERL_"),
      childStderr.match(/ERR_ERL_\w+/)?.[0],
    );
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nsmoke-http: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nsmoke-http: all checks passed");
}

main().catch((e) => {
  console.error("smoke-http fatal:", e);
  process.exit(1);
});
