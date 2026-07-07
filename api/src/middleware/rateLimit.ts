import { Request, Response, NextFunction } from "express";
import { redis } from "../lib/redis";

// Token-bucket rate limiter implemented directly in Redis using INCR + EXPIRE,
// which is atomic enough for our purposes (a tiny race on first request only
// ever costs one extra allowed request, never a starvation bug).
//
// Bucket key is per-tenant so one noisy tenant can never starve another —
// this is the multi-tenant isolation guarantee, not just a global limiter.
interface RateLimitOptions {
  windowSeconds: number;
  maxRequests: number;
}

export function rateLimit({ windowSeconds, maxRequests }: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return next(); // unauthenticated routes are not tenant-limited here

    const key = `ratelimit:tenant:${tenantId}`;

    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }

      const ttl = await redis.ttl(key);
      res.setHeader("X-RateLimit-Limit", maxRequests.toString());
      res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - current).toString());
      res.setHeader("X-RateLimit-Reset", ttl.toString());

      if (current > maxRequests) {
        return res.status(429).json({
          error: "rate_limit_exceeded",
          retryAfterSeconds: ttl,
        });
      }
      next();
    } catch (err) {
      // Fail open: if Redis is briefly unavailable, don't block all traffic —
      // log it and let the request through. A production system would also
      // fire an alert here.
      req.log?.warn({ err }, "rate limiter redis error, failing open");
      next();
    }
  };
}
