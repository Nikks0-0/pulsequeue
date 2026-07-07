import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { redis } from "./lib/redis";
import { authRouter } from "./routes/auth";
import { workflowsRouter } from "./routes/workflows";
import { runsRouter } from "./routes/runs";
import { authenticate } from "./middleware/authenticate";
import { rateLimit } from "./middleware/rateLimit";
import { requestId } from "./middleware/requestId";
import { metricsMiddleware } from "./middleware/metrics";
import { registry } from "./metrics/registry";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(requestId);
app.use(metricsMiddleware);
app.use(
  pinoHttp({
    logger,
    // Every log line for this request carries requestId, so a support
    // question ("call at 14:32 failed") can be grepped straight to every
    // log line involved, across handler code, not just the access log.
    customProps: (req) => ({ requestId: (req as express.Request).requestId }),
  })
);

// Liveness/readiness check: also verifies Postgres + Redis are reachable,
// which is what a Docker HEALTHCHECK / orchestrator readiness probe should test —
// not just "is the process running" but "can it actually serve traffic".
app.get("/health", async (_req, res) => {
  const status: Record<string, string> = { api: "ok" };
  try {
    await prisma.$queryRaw`SELECT 1`;
    status.postgres = "ok";
  } catch {
    status.postgres = "down";
  }
  try {
    await redis.ping();
    status.redis = "ok";
  } catch {
    status.redis = "down";
  }
  const healthy = Object.values(status).every((v) => v === "ok");
  res.status(healthy ? 200 : 503).json(status);
});

app.get("/", (_req, res) => {
  res.json({ service: "pulsequeue-api", version: "1.0.0" });
});

// Prometheus scrape endpoint. Deliberately NOT behind auth: in a real
// deployment this port/path would sit on an internal-only network Prometheus
// reaches but the public internet doesn't (a NetworkPolicy in k8s, or simply
// not exposing this port on the load balancer) rather than being protected
// by application-level auth, which is the standard pattern for metrics
// endpoints -- noted here so it's clear this is a deliberate choice, not an
// oversight.
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});

// Public auth routes (register/login/refresh have their own logic; no global auth here)
app.use("/api/v1/auth", authRouter);

// Everything mounted below this line requires a valid access token,
// and is rate-limited per-tenant (100 req / 60s window as a sane default).
const tenantLimiter = rateLimit({ windowSeconds: 60, maxRequests: 100 });
app.use("/api/v1", authenticate, tenantLimiter);

app.use("/api/v1/workflows", workflowsRouter);
app.use("/api/v1", runsRouter);

// Simple authenticated sanity-check route (kept for quick manual testing).
app.get("/api/v1/ping", (req, res) => {
  res.json({ pong: true, auth: req.auth });
});
