import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Every request gets a correlation ID -- either propagated from an upstream
 * caller (X-Request-Id header, e.g. if this API sits behind a gateway or is
 * called by another internal service) or freshly generated here. It's
 * attached to req.requestId (picked up by pino-http's customProps in
 * index.ts so every log line for this request carries it), and echoed back
 * as a response header so the client can quote it back when reporting an
 * issue ("this failed, requestId=...").
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers["x-request-id"];
  req.requestId = (typeof incoming === "string" && incoming) || randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
}
