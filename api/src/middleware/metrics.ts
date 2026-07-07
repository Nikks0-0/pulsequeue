import { Request, Response, NextFunction } from "express";
import { httpRequestsTotal, httpRequestDurationSeconds } from "../metrics/registry";

/**
 * Uses req.route?.path (set by Express AFTER routing matches) rather than
 * req.path/req.originalUrl, specifically to avoid a cardinality explosion:
 * "/api/v1/workflows/:id" should be one label value, not a new one per
 * workflow UUID ever requested. Falls back to "unmatched" for 404s, which
 * never have a matched route.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { method: req.method, route, status: String(res.statusCode) };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
  });

  next();
}
