import { redis } from "./redis";

// Channel naming must match the pattern the API's WS gateway subscribes to
// via PSUBSCRIBE("run:*:events") -- see api/src/ws/gateway.ts.
//
// This is deliberately separate from the Redis Stream (workflow-events) used
// for work dispatch: Streams are a durable, ack'd work queue ("a worker must
// do this exactly once"); Pub/Sub here is fire-and-forget ("tell anyone
// listening right now"). If no browser is connected when this publishes,
// that's fine -- the dashboard just shows the current DB snapshot on load.
function runEventChannel(runId: string): string {
  return `run:${runId}:events`;
}

// Payloads intentionally mirror the full REST shapes (frontend/src/lib/types.ts
// Step / Run) rather than sending a diff -- the dashboard can apply either a
// REST snapshot or a WS message through the exact same state-merge code path,
// with no separate "partial update" merge logic to keep in sync.
interface StepPayload {
  id: string;
  runId: string;
  stepKey: string;
  type: string;
  status: string;
  attemptCount: number;
  input: unknown;
  output: unknown;
  error: string | null;
  nextAttemptAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface RunPayload {
  id: string;
  workflowId: string;
  status: string;
  triggeredBy: string;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export async function publishStepUpdate(runId: string, step: StepPayload): Promise<void> {
  await redis.publish(runEventChannel(runId), JSON.stringify({ type: "step.updated", step }));
}

export async function publishRunUpdate(runId: string, run: RunPayload): Promise<void> {
  await redis.publish(runEventChannel(runId), JSON.stringify({ type: "run.updated", run }));
}
