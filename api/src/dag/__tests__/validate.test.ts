import { describe, it, expect } from "vitest";
import { validateDagStructure, DagValidationError } from "../validate";
import { Dag } from "../schema";

function step(key: string, dependsOn: string[] = []): Dag["steps"][number] {
  return { key, type: "HTTP", dependsOn, config: {}, maxRetries: 3 };
}

describe("validateDagStructure", () => {
  it("returns a valid topological order for a linear chain", () => {
    const dag: Dag = { steps: [step("a"), step("b", ["a"]), step("c", ["b"])] };
    const order = validateDagStructure(dag);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("handles a diamond dependency (fan-out then fan-in)", () => {
    const dag: Dag = {
      steps: [step("a"), step("b", ["a"]), step("c", ["a"]), step("d", ["b", "c"])],
    };
    const order = validateDagStructure(dag);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });

  it("throws on a direct cycle (a -> b -> a)", () => {
    const dag: Dag = { steps: [step("a", ["b"]), step("b", ["a"])] };
    expect(() => validateDagStructure(dag)).toThrow(DagValidationError);
    expect(() => validateDagStructure(dag)).toThrow(/cycle detected/);
  });

  it("throws on a self-referencing step", () => {
    const dag: Dag = { steps: [step("a", ["a"])] };
    expect(() => validateDagStructure(dag)).toThrow(/cannot depend on itself/);
  });

  it("throws on a dependsOn referencing an unknown step", () => {
    const dag: Dag = { steps: [step("a", ["ghost"])] };
    expect(() => validateDagStructure(dag)).toThrow(/unknown step/);
  });

  it("throws on duplicate step keys", () => {
    const dag: Dag = { steps: [step("a"), step("a")] };
    expect(() => validateDagStructure(dag)).toThrow(/duplicate step key/);
  });

  it("detects a longer indirect cycle (a -> b -> c -> a)", () => {
    const dag: Dag = { steps: [step("a", ["c"]), step("b", ["a"]), step("c", ["b"])] };
    expect(() => validateDagStructure(dag)).toThrow(/cycle detected/);
  });
});
