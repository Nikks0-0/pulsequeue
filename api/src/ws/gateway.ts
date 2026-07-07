import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { URL } from "url";
import Redis from "ioredis";
import { verifyAccessToken } from "../utils/jwt";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { wsConnectionsActive } from "../metrics/registry";

// Registry of which browser sockets care about which run. One Redis
// pub/sub connection is shared across all WS clients (PSUBSCRIBE on a
// pattern), rather than opening a Redis subscription per browser tab --
// Redis subscriber connections are relatively expensive and this keeps the
// fan-out O(1) Redis connections regardless of connected users.
//
// This channel is deliberately separate from the Redis Stream used for work
// dispatch (workflow-events): Streams are a durable, ack'd work queue for
// "a worker must do this exactly once"; Pub/Sub here is fire-and-forget
// "tell anyone listening right now" -- if no browser is connected when a
// message publishes, that's fine, the dashboard just shows the DB snapshot
// on load. Mixing these two very different delivery guarantees into one
// primitive would be a mistake worth flagging in a design review.
const runSubscribers = new Map<string, Set<WebSocket>>();

function addSubscriber(runId: string, ws: WebSocket) {
  if (!runSubscribers.has(runId)) runSubscribers.set(runId, new Set());
  runSubscribers.get(runId)!.add(ws);
}

function removeSubscriber(runId: string, ws: WebSocket) {
  const set = runSubscribers.get(runId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) runSubscribers.delete(runId);
}

export function attachWebSocketGateway(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws/runs" });

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });

  subscriber.psubscribe("run:*:events", (err) => {
    if (err) logger.error({ err }, "failed to psubscribe to run events");
    else logger.info("WS gateway subscribed to run:*:events");
  });

  subscriber.on("pmessage", (_pattern, channel, message) => {
    // channel shape: "run:<runId>:events" (see lib/pubsubChannels.ts)
    const runId = channel.split(":")[1];
    const clients = runSubscribers.get(runId);
    if (!clients) return;
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  });

  wss.on("connection", async (ws, req) => {
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const token = url.searchParams.get("token");
      const runId = url.searchParams.get("runId");

      if (!token || !runId) {
        ws.close(4000, "missing token or runId");
        return;
      }

      const payload = verifyAccessToken(token);

      // Tenant isolation check: don't let a client subscribe to a run that
      // doesn't belong to their tenant, even if they guess a valid run id.
      const run = await prisma.run.findFirst({
        where: { id: runId, workflow: { tenantId: payload.tenantId } },
      });
      if (!run) {
        ws.close(4004, "run not found");
        return;
      }

      addSubscriber(runId, ws);
      wsConnectionsActive.inc();
      ws.send(JSON.stringify({ type: "connected", runId }));

      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        removeSubscriber(runId, ws);
        wsConnectionsActive.dec();
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    } catch (err) {
      logger.warn({ err }, "WS connection rejected: invalid token");
      ws.close(4001, "invalid token");
    }
  });

  logger.info("WebSocket gateway attached at /ws/runs");
}
