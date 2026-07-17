import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { LoggedRequest } from "../middleware/request-log.js";

/**
 * Global sliding-window rate limit for the DCR `/register` endpoint (ported
 * from brain-mcp).
 *
 * `/register` is unauthenticated by design (the consent gate at `/authorize` is
 * what keeps the service closed — a registered client still cannot mint a token
 * without a human passing the password). But an open `/register` lets anyone
 * repeatedly mint clients using the allowlisted redirect_uri, growing the
 * persistent clients.json store unbounded — a slow disk/write-chain DoS.
 *
 * GLOBAL, not per-IP: this is a single-user service behind the Tailscale
 * Funnel, which collapses source IPs to loopback. Per-IP keying would require
 * trusting X-Forwarded-For, which is spoofable if the hop count is wrong. A
 * global cap needs no IP trust, cannot be spoofed, and directly bounds
 * clients.json growth. Legitimate `/register` happens only on a rare connector
 * re-link, so a global window does not impede real use.
 */

const REGISTER_WINDOW_MS = 15 * 60_000; // 15 min
const REGISTER_MAX = 10; // accepted registrations per window before 429

/**
 * In-memory sliding window of hit timestamps. `atCapacity` prunes expired hits
 * then reports whether the window is already full. Single-threaded JS execution
 * makes the check-then-record in the middleware atomic — no interleave.
 */
export class SlidingWindow {
  private hits: number[] = [];
  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  atCapacity(now: number = Date.now()): boolean {
    this.hits = this.hits.filter((t) => t > now - this.windowMs);
    return this.hits.length >= this.max;
  }

  record(now: number = Date.now()): void {
    this.hits.push(now);
  }
}

export function createRegisterRateLimit(
  windowMs: number = REGISTER_WINDOW_MS,
  max: number = REGISTER_MAX,
): RequestHandler {
  const window = new SlidingWindow(windowMs, max);
  const retryAfter = Math.ceil(windowMs / 1000).toString();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (window.atCapacity()) {
      // Do NOT record a rejected request: counting only accepted registrations
      // (a) drains the window under a sustained flood instead of pinning it full
      // forever, and (b) makes the counter track the exact DoS metric — persisted
      // clients — rather than raw request volume. 429 + Retry-After, never silent.
      res.locals.logCode = "register-rate-limit";
      res.status(429);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", retryAfter);
      res.json({
        error: "rate_limited",
        error_description: `Too many client registrations. Try again later. (req ${
          (req as LoggedRequest).requestId ?? "-"
        })`,
      });
      return;
    }
    window.record();
    next();
  };
}
