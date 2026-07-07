import { PrismaClient, Step } from "@prisma/client";
import { Dag } from "./dagTypes";
import { computeReadyStepKeys, claimSteps } from "./claimSteps";
import { computeBackoffMs } from "./backoff";
import { getExecutor, PermanentExecutionError } from "../executors";
import { publishStepUpdate, publishRunUpdate } from "./publish";
import {
  stepsClaimedTotal,
  stepsSucceededTotal,
  stepsRetriedTotal,
  stepsDeadLetteredTotal,
  stepExecutionDurationSeconds,
  runsFinalizedTotal,
} from "../metrics/registry";
import { logger } from "./logger";

/**
 * Executes one claimed step and transitions it to its next state:
 *   - success                          -> SUCCEEDED
 *   - retryable error, attempts left   -> RETRYING (with computed backoff)
 *   - retryable error, attempts spent  -> DEAD_LETTER
 *   - permanent error (any attempt)    -> DEAD_LETTER immediately
 *     (no point burning retries on something that can never succeed)
 */
async function executeAndTransition(prisma: PrismaClient, step: Step, maxRetries: number): Promise<void> {
  const executor = getExecutor(step.type);
  const stopTimer = stepExecutionDurationSeconds.startTimer({ type: step.type });

  try {
    const result = await executor({
      runId: step.runId,
      stepId: step.id,
      stepKey: step.stepKey,
      idempotencyKey: step.idempotencyKey,
      config: (step.input as Record<string, unknown>) ?? {},
    });

    stopTimer({ outcome: "success" });
    stepsSucceededTotal.inc({ type: step.type });

    const updated = await prisma.step.update({
      where: { id: step.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), output: result.output as any, error: null },
    });
    await publishStepUpdate(step.runId, updated);
    logger.info({ stepId: step.id, stepKey: step.stepKey }, "step succeeded");
  } catch (err) {
    stopTimer({ outcome: "failure" });
    const isPermanent = err instanceof PermanentExecutionError;
    const attemptsExhausted = step.attemptCount >= maxRetries;

    if (isPermanent || attemptsExhausted) {
      stepsDeadLetteredTotal.inc({ type: step.type, reason: isPermanent ? "permanent" : "retries_exhausted" });

      const updated = await prisma.step.update({
        where: { id: step.id },
        data: {
          status: "DEAD_LETTER",
          finishedAt: new Date(),
          error: (err as Error).message,
        },
      });
      await publishStepUpdate(step.runId, updated);
      logger.warn(
        { stepId: step.id, stepKey: step.stepKey, permanent: isPermanent, attempts: step.attemptCount },
        "step dead-lettered"
      );
      return;
    }

    stepsRetriedTotal.inc({ type: step.type });
    const delayMs = computeBackoffMs(step.attemptCount);
    const updated = await prisma.step.update({
      where: { id: step.id },
      data: {
        status: "RETRYING",
        error: (err as Error).message,
        nextAttemptAt: new Date(Date.now() + delayMs),
      },
    });
    await publishStepUpdate(step.runId, updated);
    logger.info(
      { stepId: step.id, stepKey: step.stepKey, attempt: step.attemptCount, delayMs },
      "step failed, scheduled for retry"
    );
  }
}

/**
 * Drives one run to completion (or as far as it can currently go).
 * Loops: claim whatever is ready -> execute it -> that may unlock new steps
 * (on success) or schedule a future retry (on failure) -> claim again -> ...
 * until nothing is immediately claimable. Retries whose backoff window
 * hasn't elapsed yet are picked up on a later sweep (see worker/src/index.ts).
 */
export async function processRun(prisma: PrismaClient, runId: string): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { workflow: true },
  });
  if (!run) {
    logger.warn({ runId }, "run not found, skipping");
    return;
  }

  if (run.status === "PENDING") {
    const updated = await prisma.run.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: new Date() } });
    await publishRunUpdate(runId, updated);
  }

  const dag = run.workflow.dagJson as unknown as Dag;
  const maxRetriesByKey = new Map(dag.steps.map((s) => [s.key, s.maxRetries]));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const steps = await prisma.step.findMany({ where: { runId } });
    const readyKeys = computeReadyStepKeys(dag, steps);

    if (readyKeys.length === 0) break;

    const claimed = await claimSteps(prisma, runId, readyKeys);
    if (claimed.length === 0) break; // another worker claimed them first -- normal under concurrency

    for (const step of claimed) {
      stepsClaimedTotal.inc({ type: step.type });
      const maxRetries = maxRetriesByKey.get(step.stepKey) ?? 3;
      await executeAndTransition(prisma, step, maxRetries);
    }
  }

  await finalizeRunStatus(prisma, runId);
}

async function finalizeRunStatus(prisma: PrismaClient, runId: string): Promise<void> {
  const steps = await prisma.step.findMany({ where: { runId } });
  const allTerminal = steps.every((s: { status: string }) =>
    ["SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(s.status)
  );
  if (!allTerminal) return; // some steps are still pending, running, or awaiting a retry window

  const anyFailed = steps.some((s: { status: string }) => ["FAILED", "DEAD_LETTER"].includes(s.status));

  const updated = await prisma.run.update({
    where: { id: runId },
    data: {
      status: anyFailed ? "FAILED" : "SUCCEEDED",
      finishedAt: new Date(),
    },
  });
  await publishRunUpdate(runId, updated);
  runsFinalizedTotal.inc({ status: anyFailed ? "FAILED" : "SUCCEEDED" });

  logger.info({ runId, status: anyFailed ? "FAILED" : "SUCCEEDED" }, "run finalized");
}
