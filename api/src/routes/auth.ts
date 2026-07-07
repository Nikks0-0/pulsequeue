import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { hashPassword, comparePassword } from "../utils/password";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { validateBody } from "../middleware/validate";
import { registerSchema, loginSchema, refreshSchema } from "../utils/validation";
import { authenticate } from "../middleware/authenticate";

export const authRouter = Router();

// POST /auth/register
// Creates a brand new tenant (organization) plus its first user as ADMIN.
// This is the only endpoint that creates a tenant — every subsequent user
// is invited into an existing tenant (not implemented yet, Day 3+ scope).
authRouter.post("/register", validateBody(registerSchema), async (req, res) => {
  const { tenantName, email, password } = req.body;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "email_already_registered" });
  }

  const passwordHash = await hashPassword(password);

  const { tenant, user } = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const tenant = await tx.tenant.create({ data: { name: tenantName } });
    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email,
        passwordHash,
        role: "ADMIN",
      },
    });
    return { tenant, user };
  });

  const accessToken = signAccessToken({ userId: user.id, tenantId: tenant.id, role: user.role });
  const refreshToken = signRefreshToken({ userId: user.id, tokenVersion: user.tokenVersion });

  res.status(201).json({
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, role: user.role },
    tenant: { id: tenant.id, name: tenant.name },
  });
});

// POST /auth/login
authRouter.post("/login", validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  const accessToken = signAccessToken({ userId: user.id, tenantId: user.tenantId, role: user.role });
  const refreshToken = signRefreshToken({ userId: user.id, tokenVersion: user.tokenVersion });

  res.json({
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, role: user.role },
  });
});

// POST /auth/refresh
// Implements refresh-token rotation: every refresh both issues a new pair
// AND bumps tokenVersion, which invalidates every refresh token issued
// before this one. This means a stolen refresh token becomes useless the
// moment the legitimate user refreshes again.
authRouter.post("/refresh", validateBody(refreshSchema), async (req, res) => {
  const { refreshToken } = req.body;

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    return res.status(401).json({ error: "invalid_or_expired_refresh_token" });
  }

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || user.tokenVersion !== payload.tokenVersion) {
    return res.status(401).json({ error: "refresh_token_revoked" });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { tokenVersion: { increment: 1 } },
  });

  const accessToken = signAccessToken({ userId: user.id, tenantId: user.tenantId, role: user.role });
  const newRefreshToken = signRefreshToken({ userId: user.id, tokenVersion: updated.tokenVersion });

  res.json({ accessToken, refreshToken: newRefreshToken });
});

// POST /auth/logout
// Bumps tokenVersion so any outstanding refresh tokens (this device or others)
// are immediately invalidated. Access tokens remain valid until they naturally
// expire (15m) -- a tradeoff documented here rather than hidden.
authRouter.post("/logout", authenticate, async (req, res) => {
  await prisma.user.update({
    where: { id: req.auth!.userId },
    data: { tokenVersion: { increment: 1 } },
  });
  res.status(204).send();
});

// GET /auth/me
authRouter.get("/me", authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { id: true, email: true, role: true, tenantId: true, createdAt: true },
  });
  res.json(user);
});
