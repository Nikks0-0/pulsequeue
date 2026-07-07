import "dotenv/config";
import { prisma } from "./lib/prisma";
import { logger } from "./lib/logger";
import {
  createStreamConnection,
  ensureConsumerGroup,
  readNextEvents,
  ackEvent,
} from "./lib/streams";
import { processRun } from "./lib/runProcessor";
import { findRunsWithDueRetries } from "./lib/sweep";
import { startMetricsServer } from "./metrics/server";
import { queueDepthGauge } from "./metrics/registry";

const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
const METRICS_PORT = process.env.METRICS_PORT ? parseInt(process.env.METRICS_PORT, 10) : 9100;

/**
 * Refreshes the queue-depth gauge from Postgres. Run once per main-loop
 * iteration (every few seconds) rather than on every single step
 * transition -- queue depth is a dashboard/alerting signal, not something
 * that needs sub-second precision, so we trade a little staleness for far
 * fewer COUNT queries under load.
 */
async function updateQueueDepthGauge(prisma: import("@prisma/client").PrismaClient) {
  const [pending, retrying] = await Promise.all([
    prisma.step.count({ where: { status: "PENDING" } }),
    prisma.step.count({ where: { status: "RETRYING" } }),
  ]);
  queueDepthGauge.set({ status: "PENDING" }, pending);
  queueDepthGauge.set({ status: "RETRYING" }, retrying);
}

let shuttingDown = false;

async function main() {
  logger.info({ workerId: WORKER_ID }, "starting PulseQueue worker");

  startMetricsServer(METRICS_PORT);

  const conn = createStreamConnection();
  await ensureConsumerGroup(conn);

  logger.info({ workerId: WORKER_ID }, "worker ready, waiting for events");

  while (!shuttingDown) {
    try {
      const events = await readNextEvents(conn, WORKER_ID);

      for (const event of events) {
        logger.info({ event }, "received event");
        try {
          await processRun(prisma, event.runId);
        } catch (err) {
          // A failure processing this event should not crash the worker or
          // block the loop -- log it, leave the event un-ACKed (it will show
          // up in XPENDING for crash-recovery / manual replay), and move on.
          logger.error({ err, event }, "failed to process run, leaving un-acked for retry");
          continue;
        }
        await ackEvent(conn, event.id);
      }

      // Every iteration (including block-timeouts with zero new events),
      // also check for runs with a step whose retry backoff has elapsed.
      const dueRunIds = await findRunsWithDueRetries(prisma);
      for (const runId of dueRunIds) {
        try {
          await processRun(prisma, runId);
        } catch (err) {
          logger.error({ err, runId }, "failed to process due retry");
        }
      }

      await updateQueueDepthGauge(prisma);
    } catch (err) {
      logger.error({ err }, "error in worker loop, backing off");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await conn.quit();
  await prisma.$disconnect();
  logger.info("worker shut down cleanly");
}

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down after current batch");
  shuttingDown = true;
});
process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down after current batch");
  shuttingDown = true;
});

main().catch((err) => {
  logger.error({ err }, "worker crashed");
  process.exit(1);
});
