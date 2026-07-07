import { describe, it, expect, beforeEach } from "vitest";
import {
  registry,
  stepsSucceededTotal,
  stepsDeadLetteredTotal,
  stepExecutionDurationSeconds,
  queueDepthGauge,
} from "../registry";

describe("worker metrics registry", () => {
  beforeEach(() => {
    stepsSucceededTotal.reset();
    stepsDeadLetteredTotal.reset();
    stepExecutionDurationSeconds.reset();
    queueDepthGauge.reset();
  });

  it("registers the expected metric names", async () => {
    const metrics = await registry.getMetricsAsJSON();
    const names = metrics.map((m) => m.name);
    expect(names).toContain("pulsequeue_steps_succeeded_total");
    expect(names).toContain("pulsequeue_steps_dead_lettered_total");
    expect(names).toContain("pulsequeue_step_execution_duration_seconds");
    expect(names).toContain("pulsequeue_queue_depth");
  });

  it("labels dead-lettered steps by type and reason distinctly", async () => {
    stepsDeadLetteredTotal.inc({ type: "HTTP", reason: "permanent" });
    stepsDeadLetteredTotal.inc({ type: "HTTP", reason: "retries_exhausted" });
    const value = await stepsDeadLetteredTotal.get();
    expect(value.values).toHaveLength(2);
  });

  it("queue depth gauge reflects the last value set, per status label", async () => {
    queueDepthGauge.set({ status: "PENDING" }, 5);
    queueDepthGauge.set({ status: "RETRYING" }, 2);
    queueDepthGauge.set({ status: "PENDING" }, 3); // overwrite, not additive
    const value = await queueDepthGauge.get();
    const pending = value.values.find((v) => v.labels.status === "PENDING");
    expect(pending?.value).toBe(3);
  });
});
