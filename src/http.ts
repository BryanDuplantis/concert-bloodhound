import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import express, { type Request, type Response, type NextFunction } from "express";

import { buildServer } from "./build-server.js";
import { FileOAuthProvider } from "./auth/provider.js";
import { FileClientStore, parseAllowedRedirectUris } from "./auth/store.js";
import { combinedAuthMiddleware } from "./auth/gate.js";
import { createConsentHandlers } from "./auth/consent.js";
import { createRegisterRateLimit } from "./auth/rate-limit.js";
import { requestLog, type LoggedRequest } from "./middleware/request-log.js";

function parseAllowedOrigins(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// Distinct browser Origins that passed while the allowlist was empty — logged
// once each so the off-state is observable (not silent) and we can learn the
// real client Origins before populating MCP_ALLOWED_ORIGINS to enforce.
const seenUnvalidatedOrigins = new Set<string>();

/**
 * Origin allowlist for /mcp — "enforce when set, loud when empty"; never
 * crash-boots, never silent:
 *
 *  - allowlist EMPTY  → origin validation is OFF, but LOUD: each distinct browser
 *    Origin that passes is logged once (`origin-unvalidated`). Populate the env
 *    var to switch to enforcement — no code change needed.
 *  - allowlist SET    → present-but-unlisted Origin is rejected (the DNS-rebinding
 *    / browser cross-site defense). Present-and-listed passes.
 *
 * A MISSING Origin always passes: non-browser MCP clients (native iOS/macOS apps,
 * the SDK HTTP client, Claude Code) don't send one and can't mount a browser
 * cross-site attack; they stay gated by combinedAuthMiddleware (Bearer/OAuth)
 * mounted immediately after. A duplicated Origin header (array) is abnormal and
 * falls through to the 403 when the allowlist is set.
 */
function originMiddleware(allowed: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers["origin"];
    if (!origin) {
      next();
      return;
    }
    if (allowed.size === 0) {
      if (typeof origin === "string" && !seenUnvalidatedOrigins.has(origin)) {
        seenUnvalidatedOrigins.add(origin);
        console.warn(
          `[concert-bloodhound] origin-unvalidated: MCP_ALLOWED_ORIGINS empty — passed Origin=${origin}. ` +
            "Add it (and any others) to MCP_ALLOWED_ORIGINS to enforce.",
        );
      }
      next();
      return;
    }
    if (typeof origin === "string" && allowed.has(origin)) {
      next();
      return;
    }
    res.locals.logCode = "origin-forbidden";
    res.status(403).json({
      error: "Origin not allowed",
      request_id: (req as LoggedRequest).requestId,
    });
  };
}

/**
 * HTTP transport requires the full auth stack. Fail fast — never boot into a
 * partially-configured or open state.
 */
interface HttpConfig {
  secret: string;
  publicBaseUrl: string;
  authorizePassword: string;
  allowedOrigins: Set<string>;
}

function loadHttpConfig(): HttpConfig {
  const secret = process.env.MCP_SECRET;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  const authorizePassword = process.env.OAUTH_AUTHORIZE_PASSWORD;
  const allowedRedirects = process.env.OAUTH_ALLOWED_REDIRECT_URIS;
  const allowedOrigins = process.env.MCP_ALLOWED_ORIGINS;

  const missing: string[] = [];
  if (!secret || !secret.trim()) missing.push("MCP_SECRET");
  if (!publicBaseUrl || !publicBaseUrl.trim()) missing.push("PUBLIC_BASE_URL");
  if (!authorizePassword || !authorizePassword.trim()) missing.push("OAUTH_AUTHORIZE_PASSWORD");
  if (!allowedRedirects || !allowedRedirects.trim()) missing.push("OAUTH_ALLOWED_REDIRECT_URIS");
  // MCP_ALLOWED_ORIGINS is NOT required: an empty value means origin validation
  // is off — surfaced loudly at boot + per-Origin, not fatal. The Bearer/OAuth
  // gate is the real boundary; origin checks are defense-in-depth.

  if (missing.length > 0) {
    console.error(
      `[concert-bloodhound] FATAL: HTTP transport requires ${missing.join(", ")}. ` +
        "Refusing to start — there is no open mode.",
    );
    process.exit(1);
  }

  // Validated above.
  return {
    secret: secret as string,
    publicBaseUrl: (publicBaseUrl as string).replace(/\/+$/, ""),
    authorizePassword: authorizePassword as string,
    allowedOrigins: parseAllowedOrigins(allowedOrigins ?? ""),
  };
}

export async function runHttp(): Promise<void> {
  const config = loadHttpConfig();

  // Validate the redirect_uri allowlist at BOOT, not lazily on the first DCR.
  // A loopback / non-HTTPS entry crash-stops startup (fail-closed, LOUD) instead
  // of silently accepting a code-capture foot-gun until the first registration.
  // Empty allowlist is a valid state (DCR disabled) — only malformed entries throw.
  try {
    parseAllowedRedirectUris();
  } catch (err) {
    console.error(`[concert-bloodhound] FATAL: ${(err as Error).message}`);
    throw err;
  }

  if (config.allowedOrigins.size === 0) {
    console.warn(
      "[concert-bloodhound] WARNING: MCP_ALLOWED_ORIGINS is empty — browser-Origin requests " +
        "pass UNVALIDATED (each distinct Origin logged once). Non-browser clients always " +
        "pass. Populate MCP_ALLOWED_ORIGINS to enforce the DNS-rebinding defense.",
    );
  } else if (!config.allowedOrigins.has("https://claude.com")) {
    // claude.com-migration latent trap (carried from brain-mcp): an allowlist
    // missing claude.com breaks the connector the same way a redirect-URI gap
    // does. LOUD at boot, enforce-when-set.
    console.warn(
      "[concert-bloodhound] LOUD WARNING: MCP_ALLOWED_ORIGINS is set but missing https://claude.com — " +
        "the claude.com migration will break this connector. Add it alongside https://claude.ai.",
    );
  }
  const app = express();

  // Request-id mint + non-2xx logging hook — FIRST, before the body parsers,
  // so parser 400/413 rejections carry a request id and log.
  app.use(requestLog);

  // Tool-call payloads are small (search args), but keep the /mcp parser
  // separate from the OAuth routes: /token and DCR /register take tiny
  // payloads — cap them at 64KB so an oversized auth-endpoint body can't tie
  // up the Pi's single event loop. express.json is a no-op once req._body is
  // set, so the /mcp-scoped 1MB parser wins for /mcp and the 64KB default
  // applies to everything else.
  app.use("/mcp", express.json({ limit: "1mb" }));
  app.use(express.json({ limit: "64kb" }));

  const allowed = config.allowedOrigins;
  const issuerUrl = new URL(config.publicBaseUrl);
  const resourceServerUrl = new URL(`${config.publicBaseUrl}/mcp`);
  const secureCookie = issuerUrl.protocol === "https:";

  // OAuth authorization server. Provider + persistent client/refresh store —
  // bloodhound's OWN store path (never shared with brain-mcp; see store.ts).
  const provider = new FileOAuthProvider(new FileClientStore());

  // Consent gate — the single-user password that keeps the service closed under OAuth.
  const consent = createConsentHandlers({
    password: config.authorizePassword,
    cookieKey: config.secret,
    secureCookie,
  });
  // MUST precede mcpAuthRouter so /authorize is gated before the SDK handler runs.
  app.all("/authorize", consent.gate);
  app.post("/authorize/consent", express.urlencoded({ extended: false }), consent.submit);

  // Global sliding-window rate limit on DCR /register, mounted BEFORE the SDK
  // router so it runs first. Bounds unbounded client-registration growth of
  // clients.json. 429 + Retry-After on cap.
  app.post("/register", createRegisterRateLimit());

  // SDK OAuth router: /token, DCR /register, /.well-known/* discovery.
  // clientSecretExpirySeconds:0 — non-expiring; the 30-day default would silently
  // kill the connector in a month (designed-vs-deployed landmine).
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      baseUrl: issuerUrl,
      resourceServerUrl,
      scopesSupported: ["mcp:tools"],
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "concert-bloodhound", version: "0.1.0" });
  });

  // RFC 9728 discovery: the 401 points OAuth clients at the protected-resource
  // metadata, which the SDK mounts at /.well-known/oauth-protected-resource<rsPath>.
  const resourceMetadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource${resourceServerUrl.pathname}`;
  app.use("/mcp", originMiddleware(allowed));
  app.use("/mcp", combinedAuthMiddleware(config.secret, provider, resourceMetadataUrl));

  app.post("/mcp", async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.MCP_PORT ?? "3003", 10) || 3003;
  app.listen(port, () => {
    console.log(`[concert-bloodhound] HTTP server listening on port ${port} (Bearer + OAuth)`);
  });
}
