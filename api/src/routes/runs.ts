import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/rbac";
import { publishRunTriggered } from "../lib/redisStreams";
import { Dag } from "../dag/schema";

export const runsRouter = Router();

// POST /api/v1/workflows/:id/trigger  (MEMBER+)
// Creates a Run row plus one Step row per DAG node (all PENDING), then
// publishes a single lightweight event to Redis Streams so a worker picks
// it up. Run + Step creation happens in one transaction so the API never
// leaves a partially-created run behind if something fails mid-write.
runsRouter.post("/workflows/:id/trigger", authenticate, requireRole("MEMBER"), async (req, res) => {
  const workflow = await prisma.workflow.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!workflow) return res.status(404).json({ error: "workflow_not_found" });

  const dag = workflow.dagJson as unknown as Dag;

  const run = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const run = await tx.run.create({
      data: {
        workflowId: workflow.id,
        status: "PENDING",
        triggeredBy: req.auth!.userId,
      },
    });

    await tx.step.createMany({
      data: dag.steps.map((s) => ({
        runId: run.id,
        stepKey: s.key,
        type: s.type,
        status: "PENDING",
        // Idempotency key is deterministic per (run, step) -- if this trigger
        // request is ever retried by a client, re-running createMany would
        // violate the unique constraint instead of silently duplicating steps.
        idempotencyKey: `${run.id}:${s.key}`,
        input: s.config,
      })),
    });

    return run;
  });

  await publishRunTriggered({ runId: run.id, workflowId: workflow.id, tenantId: req.auth!.tenantId });

  res.status(202).json({ runId: run.id, status: run.status });
});

// POST /api/v1/runs/:id/replay  (MEMBER+)
// Resets every DEAD_LETTER step in this run back to PENDING (fresh attempt
// count, cleared error/backoff state) and re-publishes a wake-up event.
// Downstream steps that were blocked need no special handling: they're
// already sitting in PENDING waiting on their dependency, so the instant
// the replayed step succeeds, the normal readiness check in the worker
// picks them up -- replay only ever needs to touch the dead-lettered steps
// themselves, never their dependents.
runsRouter.post("/runs/:id/replay", authenticate, requireRole("MEMBER"), async (req, res) => {
  const run = await prisma.run.findFirst({
    where: { id: req.params.id, workflow: { tenantId: req.auth!.tenantId } },
  });
  if (!run) return res.status(404).json({ error: "run_not_found" });

  const deadLetterSteps = await prisma.step.findMany({
    where: { runId: run.id, status: "DEAD_LETTER" },
  });

  if (deadLetterSteps.length === 0) {
    return res.status(400).json({ error: "no_dead_letter_steps", message: "this run has no dead-lettered steps to replay" });
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.step.updateMany({
      where: { id: { in: deadLetterSteps.map((s: { id: string }) => s.id) } },
      data: {
        status: "PENDING",
        attemptCount: 0,
        error: null,
        nextAttemptAt: null,
        startedAt: null,
        finishedAt: null,
      },
    });

    await tx.run.update({
      where: { id: run.id },
      data: { status: "RUNNING", finishedAt: null },
    });
  });

  await publishRunTriggered({ runId: run.id, workflowId: run.workflowId, tenantId: req.auth!.tenantId });

  res.status(202).json({
    runId: run.id,
    replayedSteps: deadLetterSteps.map((s: { stepKey: string }) => s.stepKey),
  });
});
runsRouter.get("/runs/:id", authenticate, requireRole("VIEWER"), async (req, res) => {
  const run = await prisma.run.findFirst({
    where: { id: req.params.id, workflow: { tenantId: req.auth!.tenantId } },
    include: { workflow: { select: { id: true, name: true } } },
  });
  if (!run) return res.status(404).json({ error: "run_not_found" });
  res.json(run);
});

// GET /api/v1/runs/:id/steps  (VIEWER+)
runsRouter.get("/runs/:id/steps", authenticate, requireRole("VIEWER"), async (req, res) => {
  const run = await prisma.run.findFirst({
    where: { id: req.params.id, workflow: { tenantId: req.auth!.tenantId } },
  });
  if (!run) return res.status(404).json({ error: "run_not_found" });

  const steps = await prisma.step.findMany({
    where: { runId: run.id },
    orderBy: { startedAt: "asc" },
  });
  res.json({ runId: run.id, status: run.status, steps });
});
