import { z } from "zod";

// A workflow is a DAG of steps. Each step has a unique key within the workflow,
// a type (which executor handles it), a config blob specific to that type,
// and a list of step keys it depends on (must complete before this step runs).
export const stepTypeEnum = z.enum(["HTTP", "SCRIPT", "AI_ENRICHMENT", "WEBHOOK"]);

export const dagStepSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, "key must be alphanumeric/dash/underscore"),
  type: stepTypeEnum,
  dependsOn: z.array(z.string()).default([]),
  config: z.record(z.any()).default({}),
  maxRetries: z.number().int().min(0).max(10).default(3),
});

export const dagSchema = z.object({
  steps: z.array(dagStepSchema).min(1, "a workflow must have at least one step"),
});

export const createWorkflowSchema = z.object({
  name: z.string().min(2).max(100),
  dag: dagSchema,
});

export const updateWorkflowSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  dag: dagSchema.optional(),
});

export type DagStep = z.infer<typeof dagStepSchema>;
export type Dag = z.infer<typeof dagSchema>;
