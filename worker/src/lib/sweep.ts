import { PrismaClient } from "@prisma/client";

/**
 * Redis Streams only wakes a worker on a NEW event (workflow.triggered).
 * A step scheduled for retry 30 seconds from now has no future event to
 * wake anyone up -- so every worker also sweeps Postgres directly for any
 * run with a step whose backoff window has elapsed. This runs on every
 * iteration of the main loop (including XREADGROUP block-timeouts), so a
 * due retry is picked up within one loop cycle (a few seconds) by whichever
 * worker happens to poll first.
 */
export async function findRunsWithDueRetries(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ run_id: string }[]>`
    SELECT DISTINCT s.run_id
    FROM steps s
    JOIN runs r ON r.id = s.run_id
    WHERE s.status = 'RETRYING'
      AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= NOW())
      AND r.status = 'RUNNING'
  `;
  return rows.map((r: { run_id: string }) => r.run_id);
}
