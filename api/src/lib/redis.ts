import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// A dedicated connection for general commands (rate limiting, pub, etc).
// Streams consumer connections are created separately in the worker service
// because blocking XREAD calls should not share a connection with normal commands.
export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});
