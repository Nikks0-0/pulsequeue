import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// General-purpose connection for non-blocking commands (PUBLISH). The
// blocking XREADGROUP loop uses its own dedicated connection (see streams.ts)
// -- mixing a blocking call and PUBLISH on the same connection would make
// every publish wait for the next stream message to arrive first.
export const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });

redis.on("error", (err) => {
  console.error("[worker:redis] connection error:", err.message);
});
