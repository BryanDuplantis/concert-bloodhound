import crypto from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { errClass } from "../log.js";
import type { LoggedRequest } from "../middleware/request-log.js";

/**
 * Combined `/mcp` auth gate — Bearer OR OAuth, no fail-open. Ported from
 * brain-mcp, minus its restricted-principal machinery: every bloodhound tool is
 * read-only, so there is exactly one privilege level and nothing to scope.
 *
 * Two surfaces, two credentials, one endpoint:
 *   - iOS / Claude Code send the static `Bearer ${MCP_SECRET}` (timing-safe).
 *   - claude.ai sends an OAuth access token (verified via the provider).
 *
 * Hand-rolled rather than the SDK's `requireBearerAuth`, which only knows
 * `verifyAccessToken` and cannot honor the static MCP_SECRET path.
 *
 * CRITICAL: there is NO `next()`-without-auth branch. MCP_SECRET is required;
 * the server refuses to start without it (see http.ts).
 *
 * `resourceMetadataUrl` (optional) is emitted on the 401 via `WWW-Authenticate:
 * Bearer ... resource_metadata="..."` (RFC 9728). This is the discovery hop an
 * OAuth client (claude.ai) follows from an unauthenticated /mcp request to find
 * the authorization server — omit it and live DCR discovery silently 404s.
 */
export function combinedAuthMiddleware(
  secret: string,
  verifier: OAuthTokenVerifier,
  resourceMetadataUrl?: string,
): RequestHandler {
  // Precompute the expected header BYTES once. Comparing byte length (not JS
  // string .length) before timingSafeEqual matters: a multibyte token can share
  // an expected token's string length while differing in Buffer length, and
  // timingSafeEqual THROWS on unequal-length buffers — that throw in async
  // middleware becomes a 500/hang instead of a clean 401. Byte-length guard first.
  const expectedBuf = Buffer.from(`Bearer ${secret}`);
  // Constant-time credential match: byte-length guard, then timingSafeEqual. The
  // length branch is not a timing leak — it reveals only whether the inbound
  // token is the right size, never which bytes differ.
  const bearerMatches = (authBuf: Buffer, candidate: Buffer): boolean =>
    authBuf.length === candidate.length && crypto.timingSafeEqual(authBuf, candidate);
  const wwwAuth = (errorCode: string, description: string): string => {
    let header = `Bearer error="${errorCode}", error_description="${description}"`;
    if (resourceMetadataUrl) header += `, resource_metadata="${resourceMetadataUrl}"`;
    return header;
  };
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.headers["authorization"];
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
      res.set("WWW-Authenticate", wwwAuth("invalid_token", "Missing or malformed Authorization header"));
      res.locals.logCode = "bad-auth-header";
      res.status(401).json({ error: "Unauthorized", request_id: (req as LoggedRequest).requestId });
      return;
    }

    const authBuf = Buffer.from(auth);

    // 1. Static MCP_SECRET path (cheap, constant-time, no async).
    if (bearerMatches(authBuf, expectedBuf)) {
      (req as LoggedRequest).principal = "full-secret";
      next();
      return;
    }

    // 2. OAuth access token path (only reached when the static path misses).
    const token = auth.slice("Bearer ".length);
    try {
      const info = await verifier.verifyAccessToken(token);
      (req as Request & { auth?: unknown }).auth = info;
      (req as LoggedRequest).principal = "oauth";
      next();
      return;
    } catch (err) {
      // Error CLASS only — verify-library messages can embed token fragments.
      res.locals.logCode = errClass(err);
      res.set("WWW-Authenticate", wwwAuth("invalid_token", "Invalid or expired access token"));
      res.status(401).json({ error: "Unauthorized", request_id: (req as LoggedRequest).requestId });
      return;
    }
  };
}
