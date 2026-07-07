import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { worker: process.env.WORKER_ID || "worker-unknown" },
});
