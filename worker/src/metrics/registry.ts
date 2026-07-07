import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const stepsClaimedTotal = new client.Counter({
  name: "pulsequeue_steps_claimed_total",
  help: "Total steps claimed for execution by this worker",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const stepsSucceededTotal = new client.Counter({
  name: "pulsequeue_steps_succeeded_total",
  help: "Total steps that completed successfully",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const stepsRetriedTotal = new client.Counter({
  name: "pulsequeue_steps_retried_total",
  help: "Total step execution attempts that failed and were scheduled for retry",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const stepsDeadLetteredTotal = new client.Counter({
  name: "pulsequeue_steps_dead_lettered_total",
  help: "Total steps that exhausted retries or hit a permanent error",
  labelNames: ["type", "reason"] as const, // reason: "permanent" | "retries_exhausted"
  registers: [registry],
});

export const stepExecutionDurationSeconds = new client.Histogram({
  name: "pulsequeue_step_execution_duration_seconds",
  help: "Time spent executing a single step (one attempt), by step type",
  labelNames: ["type", "outcome"] as const, // outcome: "success" | "failure"
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const runsFinalizedTotal = new client.Counter({
  name: "pulsequeue_runs_finalized_total",
  help: "Total runs that reached a terminal state",
  labelNames: ["status"] as const, // "SUCCEEDED" | "FAILED"
  registers: [registry],
});

/**
 * A gauge rather than a counter because queue depth is a point-in-time
 * snapshot, not a monotonically increasing count. It's set (not incremented)
 * on a periodic sweep -- see worker/src/index.ts -- so Grafana can chart
 * "how much work is backed up right now" over time, the single most useful
 * signal for deciding whether to scale the worker pool up.
 */
export const queueDepthGauge = new client.Gauge({
  name: "pulsequeue_queue_depth",
  help: "Number of steps currently PENDING or RETRYING across all runs",
  labelNames: ["status"] as const, // "PENDING" | "RETRYING"
  registers: [registry],
});
