import { Prisma, PrismaClient, Step } from "@prisma/client";
import { Dag } from "./dagTypes";
import { publishStepUpdate } from "./publish";

/**
 * Given the full set of steps for a run and the workflow's DAG definition,
 * returns the keys of steps that are ready to execute right now. A step is
 * ready if:
 *   - it has never been attempted (status PENDING), OR
 *   - it failed a previous attempt and its backoff window has elapsed
 *     (status RETRYING and nextAttemptAt <= now)
 * ...and every dependency step has already SUCCEEDED.
 */
export function computeReadyStepKeys(dag: Dag, steps: Step[]): string[] {
  const now = Date.now();
  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  const ready: string[] = [];

  for (const stepDef of dag.steps) {
    const step = byKey.get(stepDef.key);
    if (!step) continue;

    const isPending = step.status === "PENDING";
    const isDueRetry =
      step.status === "RETRYING" &&
      (!step.nextAttemptAt || new Date(step.nextAttemptAt).getTime() <= now);

    if (!isPending && !isDueRetry) continue;

    const depsSatisfied = stepDef.dependsOn.every((dep) => byKey.get(dep)?.status === "SUCCEEDED");
    if (depsSatisfied) ready.push(stepDef.key);
  }
  return ready;
}

/**
 * Atomically claims a batch of ready steps so that if two worker replicas
 * both wake up for the same run at the same time, each PENDING step is only
 * ever claimed by exactly one of them.
 *
 * `FOR UPDATE SKIP LOCKED` is the key primitive: instead of blocking on a row
 * another worker already has locked (which would just serialize workers for
 * no reason), this worker skips it and claims whatever is left unlocked.
 * This is the standard Postgres pattern for a multi-consumer work queue and
 * is the reason we chose raw SQL here instead of Prisma's query builder,
 * which has no way to express SKIP LOCKED.
 */
export async function claimSteps(
  prisma: PrismaClient,
  runId: string,
  stepKeys: string[]
): Promise<Step[]> {
  if (stepKeys.length === 0) return [];

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const lockedRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM steps
      WHERE run_id = ${runId}
        AND step_key = ANY(${stepKeys})
        AND (
          status = 'PENDING'
          OR (status = 'RETRYING' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
        )
      FOR UPDATE SKIP LOCKED
    `;

    if (lockedRows.length === 0) return [];

    const ids = lockedRows.map((r: { id: string }) => r.id);

    await tx.step.updateMany({
      where: { id: { in: ids } },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        attemptCount: { increment: 1 },
      },
    });

    return tx.step.findMany({ where: { id: { in: ids } } });
  }).then(async (claimed: Step[]) => {
    for (const step of claimed) {
      await publishStepUpdate(runId, step);
    }
    return claimed;
  });
}
