import { redis } from "./redis";

// Stream used to fan out "a run needs work" events to the worker pool.
// We deliberately publish a *thin* event (just IDs) rather than the full
// DAG/run payload -- workers always re-read current state from Postgres
// before acting, so a stale/duplicate/replayed event can never cause a
// worker to act on outdated data. The stream is just a "wake up and look" signal.
export const WORKFLOW_STREAM = "workflow-events";

export async function publishRunTriggered(params: {
  runId: string;
  workflowId: string;
  tenantId: string;
}) {
  await redis.xadd(
    WORKFLOW_STREAM,
    "*",
    "type", "workflow.triggered",
    "runId", params.runId,
    "workflowId", params.workflowId,
    "tenantId", params.tenantId
  );
}
