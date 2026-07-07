import pino from "pino";

// Structured JSON logging. Every request gets a correlation id attached
// via pino-http in index.ts, so logs across api/worker can be joined by runId/requestId.
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true } },
});
