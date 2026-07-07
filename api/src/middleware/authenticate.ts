import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/jwt";

// Verifies the Bearer access token on every protected route and
// attaches { userId, tenantId, role } to req.auth for downstream
// tenant-scoping and RBAC checks. This is the single choke point
// that guarantees no route can accidentally skip auth.
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_token" });
  }

  const token = header.slice("Bearer ".length);

  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "invalid_or_expired_token" });
  }
}
