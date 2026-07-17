import type { Request, Response, NextFunction } from "express";
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
 */
export type LoggedRequest = Request & { requestId?: string; principal?: Principal };

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  // Mint unconditionally. An inbound X-Request-Id is ignored, never reflected.
  const id = mintRequestId();
  (req as LoggedRequest).requestId = id;
  res.setHeader("X-Request-Id", id);

  // Path only — originalUrl carries /authorize OAuth params. Captured at
  // mint time: inside an app.use('/mcp', ...) layer Express strips the mount
  // from req.path, so reading it at finish-time logs '/' instead of '/mcp'.
  const path = req.path;

  const emit = (status: number | string, code?: string, flow?: string): void => {
    logLine({
      req: id,
      method: req.method,
      path,
      status,
      code: code ?? (res.locals.logCode as string | undefined),
      flow,
      origin: req.headers.origin, // sanitized inside logLine
      principal: (req as LoggedRequest).principal ?? "anon",
    });
  };

  res.on("finish", () => {
    const s = res.statusCode;
    if (s >= 400) {
      emit(s);
      return;
    }
    if (s >= 300 && s < 400) {
      if (path === "/authorize") {
        const loc = String(res.getHeader("location") ?? "");
        const isOAuthError = /[?&#]error=/.test(loc);
        emit(s, isOAuthError ? "oauth-redirect-error" : undefined, "authorize");
        return;
      }
      if (path === "/token") {
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
