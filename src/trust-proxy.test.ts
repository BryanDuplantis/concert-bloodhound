/**
 * Pins the proxy-trust setting against the REAL SDK token limiter
 * (express-rate-limit inside tokenHandler), offline on an ephemeral loopback
 * port. In production the socket peer is always tailscaled on 127.0.0.1 and it
 * writes X-Forwarded-For; these tests stand in for that hop. They build their
 * own app, so they pin what TRUST_PROXY means, not that runHttp applies it:
 * smoke:http step 8 covers the wiring.
 *
 * The trust-proxy-false case is the positive control: it proves the detector
 * (the ERR_ERL warning + one shared bucket) actually fires, so the zero-warning
 * pass under TRUST_PROXY is not a check that could never fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import type { AddressInfo } from "node:net";
import express from "express";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { TRUST_PROXY } from "./http.js";

const stubProvider = {
  clientsStore: { getClient: async () => undefined },
} as unknown as OAuthServerProvider;

async function withApp(
  trust: string | false,
  fn: (base: string) => Promise<void>,
): Promise<string[]> {
  const app = express();
  app.set("trust proxy", trust);
  app.get("/ip", (req, res) => {
    res.json({ ip: req.ip });
  });
  app.use("/token", tokenHandler({ provider: stubProvider }));

  const logged: string[] = [];
  const origError = console.error;
  const server = app.listen(0, "127.0.0.1");
  try {
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => inspect(a)).join(" "));
    };
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    console.error = origError;
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  return logged;
}

async function ipFor(base: string, xff?: string): Promise<string> {
  const headers: Record<string, string> = xff === undefined ? {} : { "x-forwarded-for": xff };
  const body = (await (await fetch(`${base}/ip`, { headers })).json()) as { ip: string };
  return body.ip;
}

async function remaining(base: string, xff: string): Promise<number> {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "x-forwarded-for": xff },
  });
  await res.arrayBuffer();
  const value = res.headers.get("ratelimit-remaining");
  assert.ok(value !== null, "limiter did not run: no RateLimit-Remaining header");
  return Number(value);
}

test("req.ip is the forwarded client from a loopback peer, and the socket without XFF", async () => {
  await withApp(TRUST_PROXY, async (base) => {
    assert.equal(await ipFor(base, "203.0.113.7"), "203.0.113.7");
    assert.equal(await ipFor(base, "2001:db8::1"), "2001:db8::1");
    assert.equal(await ipFor(base, "::ffff:203.0.113.9"), "::ffff:203.0.113.9");
    assert.equal(await ipFor(base), "127.0.0.1");
  });
});

test("req.ip is the rightmost hop, never a forged hop to its left (the guard against `true`)", async () => {
  await withApp(TRUST_PROXY, async (base) => {
    assert.equal(await ipFor(base, "6.6.6.6, 203.0.113.7"), "203.0.113.7");
  });
});

test("SDK token limiter keys per forwarded client and logs no XFF warning", async () => {
  const logged = await withApp(TRUST_PROXY, async (base) => {
    const a1 = await remaining(base, "203.0.113.7");
    const a2 = await remaining(base, "203.0.113.7");
    const b1 = await remaining(base, "198.51.100.9");
    assert.equal(a2, a1 - 1, "same client should share a bucket");
    assert.equal(b1, a1, "a different client should get a fresh bucket");

    const v6 = await remaining(base, "2001:db8::1");
    assert.equal(v6, a1, "an IPv6 client should get its own bucket");
    const mapped = await remaining(base, "::ffff:198.51.100.9");
    assert.equal(mapped, b1 - 1, "an IPv4-mapped address should share its IPv4 client's bucket");
  });
  assert.deepEqual(
    logged.filter((l) => l.includes("ERR_ERL_")),
    [],
  );
});

test("control: with trust proxy off, clients share one bucket and the limiter warns", async () => {
  const logged = await withApp(false, async (base) => {
    const a1 = await remaining(base, "203.0.113.7");
    const b1 = await remaining(base, "198.51.100.9");
    assert.equal(b1, a1 - 1, "without trust, both clients key on 127.0.0.1");
  });
  assert.ok(
    logged.some((l) => l.includes("ERR_ERL_UNEXPECTED_X_FORWARDED_FOR")),
    "detector never fired, so the zero-warning assertion above proves nothing",
  );
});
