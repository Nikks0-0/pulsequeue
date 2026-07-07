import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/rbac";
import { validateBody } from "../middleware/validate";
import { createWorkflowSchema, updateWorkflowSchema } from "../dag/schema";
import { validateDagStructure, DagValidationError } from "../dag/validate";

export const workflowsRouter = Router();

// Every route here already sits behind `authenticate` + tenant rate limiter,
// mounted in index.ts at app.use("/api/v1", authenticate, tenantLimiter).
// We still re-declare `authenticate` per-route below for clarity/defense-in-depth
// (harmless no-op if already run), and to keep this router testable in isolation.

// POST /api/v1/workflows  (MEMBER+)
workflowsRouter.post(
  "/",
  authenticate,
  requireRole("MEMBER"),
  validateBody(createWorkflowSchema),
  async (req, res) => {
    const { name, dag } = req.body;

    try {
      validateDagStructure(dag);
    } catch (err) {
      if (err instanceof DagValidationError) {
        return res.status(400).json({ error: "invalid_dag", message: err.message });
      }
      throw err;
    }

    const workflow = await prisma.workflow.create({
      data: {
        tenantId: req.auth!.tenantId,
        name,
        dagJson: dag,
        createdBy: req.auth!.userId,
      },
    });

    res.status(201).json(workflow);
  }
);

// GET /api/v1/workflows  (VIEWER+)
workflowsRouter.get("/", authenticate, requireRole("VIEWER"), async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10)));

  const [workflows, total] = await Promise.all([
    prisma.workflow.findMany({
      where: { tenantId: req.auth!.tenantId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.workflow.count({ where: { tenantId: req.auth!.tenantId } }),
  ]);

  res.json({ data: workflows, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
});

// GET /api/v1/workflows/:id  (VIEWER+)
workflowsRouter.get("/:id", authenticate, requireRole("VIEWER"), async (req, res) => {
  const workflow = await prisma.workflow.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!workflow) return res.status(404).json({ error: "workflow_not_found" });
  res.json(workflow);
});

// PUT /api/v1/workflows/:id  (MEMBER+)
workflowsRouter.put(
  "/:id",
  authenticate,
  requireRole("MEMBER"),
  validateBody(updateWorkflowSchema),
  async (req, res) => {
    const existing = await prisma.workflow.findFirst({
      where: { id: req.params.id, tenantId: req.auth!.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "workflow_not_found" });

    const { name, dag } = req.body;

    if (dag) {
      try {
        validateDagStructure(dag);
      } catch (err) {
        if (err instanceof DagValidationError) {
          return res.status(400).json({ error: "invalid_dag", message: err.message });
        }
        throw err;
      }
    }

    const updated = await prisma.workflow.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(dag !== undefined ? { dagJson: dag } : {}),
      },
    });

    res.json(updated);
  }
);

// DELETE /api/v1/workflows/:id  (ADMIN only — destructive action)
workflowsRouter.delete("/:id", authenticate, requireRole("ADMIN"), async (req, res) => {
  const existing = await prisma.workflow.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!existing) return res.status(404).json({ error: "workflow_not_found" });

  await prisma.workflow.delete({ where: { id: existing.id } });
  res.status(204).send();
});
