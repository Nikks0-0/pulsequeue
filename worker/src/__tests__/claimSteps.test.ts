import { describe, it, expect } from "vitest";
import { computeReadyStepKeys } from "../lib/claimSteps";
import { Dag } from "../lib/dagTypes";
import { Step } from "@prisma/client";

function dag(steps: { key: string; dependsOn?: string[] }[]): Dag {
  return {
    steps: steps.map((s) => ({
      key: s.key,
      type: "HTTP",
      dependsOn: s.dependsOn ?? [],
      config: {},
      maxRetries: 3,
    })),
  };
}

function step(key: string, status: string): Step {
  return {
    id: key,
    runId: "run-1",
    stepKey: key,
    type: "HTTP",
    status: status as any,
    attemptCount: 0,
    input: null,
    output: null,
    error: null,
    idempotencyKey: `run-1:${key}`,
    startedAt: null,
    finishedAt: null,
  } as Step;
}

function stepFull(key: string, status: string, nextAttemptAt: Date | null = null): Step {
  return {
    id: key,
    runId: "run-1",
    stepKey: key,
    type: "HTTP",
    status: status as any,
    attemptCount: 1,
    input: null,
    output: null,
    error: null,
    idempotencyKey: `run-1:${key}`,
    nextAttemptAt,
    startedAt: null,
    finishedAt: null,
  } as Step;
}

describe("computeReadyStepKeys - retry backoff", () => {
  it("does not offer a RETRYING step before its backoff window elapses", () => {
    const d = dag([{ key: "a" }]);
    const future = new Date(Date.now() + 60_000);
    expect(computeReadyStepKeys(d, [stepFull("a", "RETRYING", future)])).toEqual([]);
  });

  it("offers a RETRYING step once its backoff window has elapsed", () => {
    const d = dag([{ key: "a" }]);
    const past = new Date(Date.now() - 1000);
    expect(computeReadyStepKeys(d, [stepFull("a", "RETRYING", past)])).toEqual(["a"]);
  });

  it("treats a RETRYING step with no nextAttemptAt as immediately due", () => {
    const d = dag([{ key: "a" }]);
    expect(computeReadyStepKeys(d, [stepFull("a", "RETRYING", null)])).toEqual(["a"]);
  });
});

describe("computeReadyStepKeys", () => {
  it("returns root steps with no dependencies as ready when PENDING", () => {
    const d = dag([{ key: "a" }, { key: "b", dependsOn: ["a"] }]);
    const steps = [step("a", "PENDING"), step("b", "PENDING")];
    expect(computeReadyStepKeys(d, steps)).toEqual(["a"]);
  });

  it("unlocks a dependent step once its dependency succeeds", () => {
    const d = dag([{ key: "a" }, { key: "b", dependsOn: ["a"] }]);
    const steps = [step("a", "SUCCEEDED"), step("b", "PENDING")];
    expect(computeReadyStepKeys(d, steps)).toEqual(["b"]);
  });

  it("does not re-offer a step that is already RUNNING or SUCCEEDED", () => {
    const d = dag([{ key: "a" }]);
    expect(computeReadyStepKeys(d, [step("a", "RUNNING")])).toEqual([]);
    expect(computeReadyStepKeys(d, [step("a", "SUCCEEDED")])).toEqual([]);
  });

  it("keeps a fan-in step blocked until ALL dependencies succeed", () => {
    const d = dag([{ key: "a" }, { key: "b" }, { key: "c", dependsOn: ["a", "b"] }]);
    const partial = [step("a", "SUCCEEDED"), step("b", "PENDING"), step("c", "PENDING")];
    expect(computeReadyStepKeys(d, partial)).toEqual(["b"]);

    const complete = [step("a", "SUCCEEDED"), step("b", "SUCCEEDED"), step("c", "PENDING")];
    expect(computeReadyStepKeys(d, complete)).toEqual(["c"]);
  });

  it("a step blocked by a FAILED dependency is never marked ready", () => {
    const d = dag([{ key: "a" }, { key: "b", dependsOn: ["a"] }]);
    const steps = [step("a", "FAILED"), step("b", "PENDING")];
    expect(computeReadyStepKeys(d, steps)).toEqual([]);
  });
});
