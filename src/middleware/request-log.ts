import type { Request, Response, NextFunction, RequestHandler } from "express";
import { mintRequestId, logLine, type Principal } from "../log.js";

/**
 * Request-id mint + non-2xx finish/close logging hook (ported from brain-mcp).
 *
 * Registered BEFORE the express.json mounts so body-parser 400/413 rejections
 * carry a request id and log.
 *
 * Rejection sites do NOT call logLine directly — they set `res.locals.logCode`
 * and this hook emits ONE line carrying that class. Same information, no
 * double-logging.
 *
 * >=400 always logs. /authorize 3xx logs as flow=authorize (an OAuth error
 * redirect is tagged code=oauth-redirect-error by INSPECTING Location — the
 * Location value itself is never logged). A /token 3xx should not exist
 * (RFC 6749: token errors are 400-level JSON) — logged as an anomaly.
 *
 * Route identity comes from res.locals.logRoute, set by tagRoute() at each
 * route's own mount, so Express's matcher (prefix, case, trailing slash) is the
 * only thing deciding which route ran. A path-string compare here once missed
 * the /bloodhound prefix and flow=authorize never logged (0 lines in 10 weeks,
 * 18 re-auths); re-deriving routing in the logger is that bug's shape.
 * A /authorize/consent 3xx logs as flow=consent: the human-typed-the-password
 * step, which tells a full consent round-trip apart from a silent re-authorize.
 *
 * Rejections from SDK handlers (/token, /register, /mcp transport) never set
 * logCode, so a >=400 without one is classified from the ERROR BODY: the OAuth
 * `error` enum, or a fixed class mapped from the JSON-RPC message. Only a
 * value from a closed vocabulary reaches the log — never the message text.
 * Bodies are only buffered once status is already >=400, so a 200 /token
 * response (which carries tokens) is never read.
 */
export type LoggedRequest = Request & { requestId?: string; principal?: Principal };

const BODY_CAP = 4096;

// Prefix → class for the 4xx messages the STATELESS StreamableHTTP transport
// can return (sdk webStandardStreamableHttp.js; session-validation messages are
// unreachable with sessionIdGenerator undefined). Each entry is pinned by a
// real-transport test, so an SDK rewording fails npm test instead of silently
// degrading to jsonrpc<code>.
const JSONRPC_CLASSES: ReadonlyArray<[string, string]> = [
  ["Bad Request: Unsupported protocol version", "unsupported-protocol-version"],
  ["Invalid Request: Only one initialization request", "multiple-initialize"],
  ["Not Acceptable", "not-acceptable"],
  ["Unsupported Media Type", "unsupported-media-type"],
  ["Parse error", "parse-error"],
];

export type LogRoute = "authorize" | "consent" | "token" | "mcp";

/** Mount with app.all(<exact route path>, tagRoute(...)) ahead of the route's handlers. */
export function tagRoute(route: LogRoute): RequestHandler {
  return (_req, res, next) => {
    res.locals.logRoute = route;
    next();
  };
}

/** Closed-vocabulary class from a 4xx/5xx body, or undefined. Exported for tests. */
export function classifyErrorBody(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const err = (parsed as { error?: unknown }).error;
  if (typeof err === "string") {
    // RFC 6749 §5.2 / RFC 7591 error codes are lowercase snake_case.
    return /^[a-z_]{1,40}$/.test(err) ? `oauth-${err}` : "oauth-other";
  }
  if (err && typeof err === "object") {
    const { code, message } = err as { code?: unknown; message?: unknown };
    if (typeof message === "string") {
      for (const [prefix, cls] of JSONRPC_CLASSES) {
        if (message.startsWith(prefix)) return cls;
      }
    }
    return typeof code === "number" && Number.isInteger(code) ? `jsonrpc${code}` : "jsonrpc-other";
  }
  return undefined;
}

/** MCP-Protocol-Version is date-shaped; anything else collapses to "other". */
function protocolVersion(req: Request): string | undefined {
  const v = req.headers["mcp-protocol-version"];
  if (typeof v !== "string") return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "other";
}

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  // Mint unconditionally. An inbound X-Request-Id is ignored, never reflected.
  const id = mintRequestId();
  (req as LoggedRequest).requestId = id;
  res.setHeader("X-Request-Id", id);

  // Path only — originalUrl carries /authorize OAuth params. Captured at
  // mint time: inside an app.use('/mcp', ...) layer Express strips the mount
  // from req.path, so reading it at finish-time logs '/' instead of '/mcp'.
  const path = req.path;
  const route = (): LogRoute | undefined => res.locals.logRoute as LogRoute | undefined;

  const chunks: Buffer[] = [];
  let buffered = 0;
  const capture = (chunk: unknown, encoding?: unknown): void => {
    if (res.statusCode < 400 || buffered >= BODY_CAP || chunk == null || typeof chunk === "function") return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : Buffer.from(String(chunk), typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
    const slice = buf.subarray(0, BODY_CAP - buffered);
    chunks.push(slice);
    buffered += slice.length;
  };
  const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
  const origEnd = res.end.bind(res) as (...a: unknown[]) => Response;
  // Diagnostics must never cost a response: a capture bug is swallowed so the
  // real write/end always runs.
  const safeCapture = (chunk: unknown, encoding: unknown): void => {
    try {
      capture(chunk, encoding);
    } catch {
      chunks.length = 0;
      buffered = BODY_CAP;
    }
  };
  res.write = ((...args: unknown[]) => {
    safeCapture(args[0], args[1]);
    return origWrite(...args);
  }) as Response["write"];
  res.end = ((...args: unknown[]) => {
    safeCapture(args[0], args[1]);
    return origEnd(...args);
  }) as Response["end"];

  const emit = (status: number | string, code?: string, flow?: string): void => {
    logLine({
      req: id,
      method: req.method,
      path,
      status,
      code: code ?? (res.locals.logCode as string | undefined),
      flow,
      mcpVersion: route() === "mcp" ? protocolVersion(req) : undefined,
      origin: req.headers.origin, // sanitized inside logLine
      principal: (req as LoggedRequest).principal ?? "anon",
    });
  };

  res.on("finish", () => {
    const s = res.statusCode;
    if (s >= 400) {
      const fromBody =
        res.locals.logCode === undefined && chunks.length
          ? classifyErrorBody(Buffer.concat(chunks).toString("utf8"))
          : undefined;
      emit(s, fromBody);
      return;
    }
    if (s >= 300 && s < 400) {
      const r = route();
      if (r === "authorize") {
        const loc = String(res.getHeader("location") ?? "");
        const isOAuthError = /[?&#]error=/.test(loc);
        emit(s, isOAuthError ? "oauth-redirect-error" : undefined, "authorize");
        return;
      }
      if (r === "consent") {
        emit(s, undefined, "consent");
        return;
      }
      if (r === "token") {
        emit(s, "anomalous-redirect");
      }
    }
  });

  // 'finish' never fires on client aborts. writableFinished guards the
  // double-fire ('close' also follows a normal 'finish').
  res.on("close", () => {
    if (!res.writableFinished) emit("aborted", "client-abort");
  });

  next();
}
