import { Request, Response, NextFunction } from "express";

type Role = "ADMIN" | "MEMBER" | "VIEWER";

// Role hierarchy: ADMIN can do everything MEMBER can, MEMBER everything VIEWER can.
// requireRole("MEMBER") therefore also allows ADMIN, matching how most real RBAC
// systems behave (permissions are additive up the hierarchy, not siloed by exact role).
const HIERARCHY: Record<Role, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
};

export function requireRole(minRole: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const userLevel = HIERARCHY[req.auth.role];
    const requiredLevel = HIERARCHY[minRole];
    if (userLevel < requiredLevel) {
      return res.status(403).json({ error: "insufficient_permissions" });
    }
    next();
  };
}
