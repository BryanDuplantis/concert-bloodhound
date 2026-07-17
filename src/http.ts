import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
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

  const allowed = config.allowedOrigins;
  const issuerUrl = new URL(config.publicBaseUrl);
  const resourceServerUrl = new URL(`${config.publicBaseUrl}/mcp`);
  const secureCookie = issuerUrl.protocol === "https:";

  // Path-prefixed deployment (Option A fallback, gate cross-surface/bloodhound-
  // remote-mcp): PUBLIC_BASE_URL may carry a path (https://<host>/bloodhound).
  // Tailscale serve strips a mount prefix but re-appends the proxy TARGET's path
  // (verified on the Pi 2026-07-17), so with mount path == target path the app
  // sees the exact public path. Every route below mounts under basePath; the
  // RFC well-knowns insert it per RFC 8414/9728. basePath "" = root deployment,
  // identical to the pre-rework layout.
  const basePath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname;

  // Tool-call payloads are small (search args), but keep the /mcp parser
  // separate from the OAuth routes: /token and DCR /register take tiny
  // payloads — cap them at 64KB so an oversized auth-endpoint body can't tie
  // up the Pi's single event loop. express.json is a no-op once req._body is
  // set, so the /mcp-scoped 1MB parser wins for /mcp and the 64KB default
  // applies to everything else.
  app.use(`${basePath}/mcp`, express.json({ limit: "1mb" }));
  app.use(express.json({ limit: "64kb" }));

  // OAuth authorization server. Provider + persistent client/refresh store —
  // bloodhound's OWN store path (never shared with brain-mcp; see store.ts).
  const provider = new FileOAuthProvider(new FileClientStore());

  // Consent gate — the single-user password that keeps the service closed under OAuth.
  const consent = createConsentHandlers({
    password: config.authorizePassword,
    cookieKey: config.secret,
    secureCookie,
    basePath,
  });
  // MUST precede the SDK authorize handler so /authorize is gated before it runs.
  app.all(`${basePath}/authorize`, consent.gate);
  app.post(`${basePath}/authorize/consent`, express.urlencoded({ extended: false }), consent.submit);

  // Global sliding-window rate limit on DCR /register, mounted BEFORE the SDK
  // handler so it runs first. Bounds unbounded client-registration growth of
  // clients.json. 429 + Retry-After on cap.
  app.post(`${basePath}/register`, createRegisterRateLimit());

  // SDK OAuth endpoints, composed by hand instead of mcpAuthRouter: the router's
  // createOAuthMetadata builds endpoints with root-relative `new URL("/authorize",
  // base)`, which STRIPS a path-carrying issuer's prefix — the exact breakage the
  // parent resolution named. Same SDK handlers, same defaults (built-in rate
  // limits included); only the metadata strings and mount paths are prefix-aware.
  // clientSecretExpirySeconds:0 — non-expiring; the 30-day default would silently
  // kill the connector in a month (designed-vs-deployed landmine). No /revoke:
  // FileOAuthProvider implements no revokeToken (unchanged from the router, which
  // mounted it conditionally).
  const oauthMetadata: OAuthMetadata = {
    issuer: issuerUrl.href,
    authorization_endpoint: `${config.publicBaseUrl}/authorize`,
    token_endpoint: `${config.publicBaseUrl}/token`,
    registration_endpoint: `${config.publicBaseUrl}/register`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: ["mcp:tools"],
  };
  app.use(`${basePath}/authorize`, authorizationHandler({ provider }));
  app.use(`${basePath}/token`, tokenHandler({ provider }));
  app.use(
    `${basePath}/register`,
    clientRegistrationHandler({
      clientsStore: provider.clientsStore,
      clientSecretExpirySeconds: 0,
    }),
  );

  // Discovery documents. RFC 8414/9728 insert well-known between host and the
  // issuer/resource path, so these live at the HOST root — on the Pi each gets
  // its own tailscale mount alongside ${basePath}. The appended-form fallbacks
  // (issuer + /.well-known/...) ride the ${basePath} mount for clients that
  // don't implement the insertion rule; skipped at root where they'd duplicate.
  const protectedResourceMetadata = {
    resource: resourceServerUrl.href,
    authorization_servers: [issuerUrl.href],
    scopes_supported: ["mcp:tools"],
  };
  app.use(
    `/.well-known/oauth-protected-resource${resourceServerUrl.pathname}`,
    metadataHandler(protectedResourceMetadata),
  );
  app.use(`/.well-known/oauth-authorization-server${basePath}`, metadataHandler(oauthMetadata));
  if (basePath) {
    app.use(
      `${basePath}/.well-known/oauth-protected-resource/mcp`,
      metadataHandler(protectedResourceMetadata),
    );
    app.use(`${basePath}/.well-known/oauth-authorization-server`, metadataHandler(oauthMetadata));
  }

  app.get(`${basePath}/health`, (_req, res) => {
    res.json({ status: "ok", service: "concert-bloodhound", version: "0.1.0" });
  });

  // RFC 9728 discovery: the 401 points OAuth clients at the protected-resource
  // metadata (host-root insertion form — the same URL mounted above).
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  app.use(`${basePath}/mcp`, originMiddleware(allowed));
  app.use(`${basePath}/mcp`, combinedAuthMiddleware(config.secret, provider, resourceMetadataUrl));

  app.post(`${basePath}/mcp`, async (req, res) => {
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
