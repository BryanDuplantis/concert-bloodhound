import { randomUUID } from "node:crypto";

/**
 * Request-scoped structured logging for the HTTP transport, ported from
 * brain-mcp (its binding invariants travel with the code):
 *   - every attacker-influenced string passes sanitize() — single-line, capped
 *   - req.path only — NEVER originalUrl, query strings, or Location values
 *   - error class/code only — NEVER err.message (categorical)
 *   - request ids are always minted — never reflected from inbound headers
 *
 * stderr, NOT stdout: the stdio transport uses stdout as the JSON-RPC channel —
 * a stdout log line there corrupts the protocol stream. journald captures
 * stderr from the systemd unit identically.
 */

const MAX_FIELD = 300;

export type Principal = "full-secret" | "oauth" | "anon";

/** Always mint. There is deliberately no function that accepts an inbound id. */
export function mintRequestId(): string {
  return randomUUID().slice(0, 8);
}

/** Strip control chars/newlines, cap length. Applied to EVERY string we didn't author. */
export function sanitize(v: unknown): string {
  if (v === undefined || v === null || v === "") return "-";
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}...` : s;
}

/** Loggable class/code from an unknown error. The message never escapes this function. */
export function errClass(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return sanitize(code ? `${err.constructor.name}:${code}` : err.constructor.name);
  }
  return sanitize(typeof err);
}

export interface LogFields {
  req: string;
  method: string;
  path: string; // caller passes req.path — never originalUrl
  status: number | string;
  code?: string;
  flow?: string; // /authorize 3xx flow-trace label only
  mcpVersion?: string; // /mcp only; pre-validated date shape or "other"
  origin?: unknown;
  principal?: Principal;
}

export function logLine(f: LogFields): void {
  const parts = [
    "[concert-bloodhound]",
    `req=${f.req}`,
    sanitize(f.method),
    sanitize(f.path),
    String(f.status),
  ];
  if (f.flow) parts.push(`flow=${sanitize(f.flow)}`);
  if (f.code) parts.push(`code=${sanitize(f.code)}`);
  if (f.mcpVersion) parts.push(`mcpver=${sanitize(f.mcpVersion)}`);
  parts.push(`origin=${sanitize(f.origin)}`);
  parts.push(`principal=${f.principal ?? "anon"}`);
  console.error(parts.join(" "));
}
