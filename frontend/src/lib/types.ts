export interface User {
  id: string;
  email: string;
  role: "ADMIN" | "MEMBER" | "VIEWER";
  tenantId: string;
}

export interface Workflow {
  id: string;
  tenantId: string;
  name: string;
  dagJson: { steps: DagStep[] };
  createdBy: string;
  createdAt: string;
}

export interface DagStep {
  key: string;
  type: "HTTP" | "SCRIPT" | "AI_ENRICHMENT" | "WEBHOOK";
  dependsOn: string[];
  config: Record<string, unknown>;
  maxRetries: number;
}

export type RunStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD_LETTER";
export type StepStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "RETRYING" | "DEAD_LETTER";

export interface Run {
  id: string;
  workflowId: string;
  status: RunStatus;
  triggeredBy: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  workflow?: { id: string; name: string };
}

export interface Step {
  id: string;
  runId: string;
  stepKey: string;
  type: string;
  status: StepStatus;
  attemptCount: number;
  input: unknown;
  output: unknown;
  error: string | null;
  nextAttemptAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
