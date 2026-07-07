import jwt, { SignOptions } from "jsonwebtoken";

export interface AccessTokenPayload {
  userId: string;
  tenantId: string;
  role: "ADMIN" | "MEMBER" | "VIEWER";
}

export interface RefreshTokenPayload {
  userId: string;
  tokenVersion: number;
}

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "dev_access_secret";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "dev_refresh_secret";
const ACCESS_EXPIRY = process.env.JWT_ACCESS_EXPIRY || "15m";
const REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY || "7d";

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRY } as SignOptions);
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRY } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, REFRESH_SECRET) as RefreshTokenPayload;
}
