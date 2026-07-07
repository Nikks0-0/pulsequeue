import Redis from "ioredis";
import { logger } from "./logger";

export const WORKFLOW_STREAM = "workflow-events";
export const CONSUMER_GROUP = "pulsequeue-workers";

// A dedicated Redis connection for the blocking XREADGROUP call. This must
// NOT share a connection with other Redis commands (rate limiting, pub/sub,
// etc.) because a blocking read holds the connection hostage until a message
// arrives or the block timeout elapses.
export function createStreamConnection(): Redis {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  return new Redis(url, { maxRetriesPerRequest: null });
}

/**
 * Ensures the consumer group exists. Using MKSTREAM so this also creates the
 * stream itself if no event has ever been published yet (fresh environment).
 * The BUSYGROUP error means the group already exists -- that's the expected,
 * non-error steady state on every restart after the first, so we swallow it.
 */
export async function ensureConsumerGroup(conn: Redis): Promise<void> {
  try {
    await conn.xgroup("CREATE", WORKFLOW_STREAM, CONSUMER_GROUP, "0", "MKSTREAM");
    logger.info({ group: CONSUMER_GROUP }, "created consumer group");
  } catch (err: any) {
    if (String(err.message).includes("BUSYGROUP")) {
      logger.info({ group: CONSUMER_GROUP }, "consumer group already exists");
    } else {
      throw err;
    }
  }
}

export interface StreamEvent {
  id: string;
  type: string;
  runId: string;
  workflowId: string;
  tenantId: string;
}

/**
 * Blocks (up to blockMs) waiting for new messages for this consumer.
 * Uses ">" which means "only messages never delivered to any consumer in
 * this group" -- i.e. real new work, not redelivery. Redelivery of messages
 * that were claimed but never ACKed (a crashed worker) is a separate
 * concern handled by XPENDING/XCLAIM, intentionally out of scope for Day 4
 * and revisited when we add worker crash-recovery.
 */
export async function readNextEvents(
  conn: Redis,
  consumerName: string,
  blockMs = 5000,
  count = 10
): Promise<StreamEvent[]> {
  const res = await conn.xreadgroup(
    "GROUP", CONSUMER_GROUP, consumerName,
    "COUNT", count,
    "BLOCK", blockMs,
    "STREAMS", WORKFLOW_STREAM, ">"
  );

  if (!res) return [];

  // ioredis shape: [[streamName, [[id, [field, value, field, value, ...]], ...]]]
  const [, entries] = res[0] as [string, [string, string[]][]];

  return entries.map(([id, fields]) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    return {
      id,
      type: obj.type,
      runId: obj.runId,
      workflowId: obj.workflowId,
      tenantId: obj.tenantId,
    };
  });
}

export async function ackEvent(conn: Redis, eventId: string): Promise<void> {
  await conn.xack(WORKFLOW_STREAM, CONSUMER_GROUP, eventId);
}
