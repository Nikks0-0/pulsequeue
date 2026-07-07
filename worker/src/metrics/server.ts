import http from "http";
import { registry } from "./registry";
import { logger } from "../lib/logger";

/**
 * The worker has no other reason to run an HTTP server -- it's a pure
 * consumer of Redis Streams. Pulling in Express for one /metrics route
 * would be a needless dependency; Node's built-in http module is enough.
 */
export function startMetricsServer(port: number) {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await registry.metrics());
      return;
    }
    if (req.url === "/health") {
      res.statusCode = 200;
      res.end("ok");
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  server.listen(port, () => {
    logger.info({ port }, "worker metrics server listening");
  });

  return server;
}
