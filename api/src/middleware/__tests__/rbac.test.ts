import { describe, it, expect, vi } from "vitest";
import { requireRole } from "../rbac";
import type { Request, Response } from "express";

function mockReq(role?: "ADMIN" | "MEMBER" | "VIEWER"): Partial<Request> {
  return role ? { auth: { userId: "u1", tenantId: "t1", role } } : {};
}

function mockRes(): Partial<Response> {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("requireRole", () => {
  it("allows ADMIN through a MEMBER-gated route", () => {
    const req = mockReq("ADMIN") as Request;
    const res = mockRes() as Response;
    const next = vi.fn();
    requireRole("MEMBER")(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("blocks VIEWER from a MEMBER-gated route with 403", () => {
    const req = mockReq("VIEWER") as Request;
    const res = mockRes() as Response;
    const next = vi.fn();
    requireRole("MEMBER")(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("blocks unauthenticated requests with 401", () => {
    const req = mockReq() as Request;
    const res = mockRes() as Response;
    const next = vi.fn();
    requireRole("VIEWER")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
