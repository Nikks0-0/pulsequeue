import { Dag } from "./schema";

export class DagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagValidationError";
  }
}

/**
 * Validates DAG structural integrity and returns a topological execution order.
 * This is deliberately separate from the zod schema check (schema.ts) because
 * these are graph-shape invariants, not per-field shape invariants — and this
 * same function is reused by the worker's executor (Day 5) to decide run order,
 * so it must be pure and side-effect free.
 */
export function validateDagStructure(dag: Dag): string[] {
  const keys = dag.steps.map((s) => s.key);
  const keySet = new Set(keys);

  // 1. No duplicate step keys
  if (keySet.size !== keys.length) {
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    throw new DagValidationError(`duplicate step key(s): ${[...new Set(dupes)].join(", ")}`);
  }

  // 2. Every dependsOn must reference a key that exists in this DAG
  for (const step of dag.steps) {
    for (const dep of step.dependsOn) {
      if (!keySet.has(dep)) {
        throw new DagValidationError(`step "${step.key}" depends on unknown step "${dep}"`);
      }
      if (dep === step.key) {
        throw new DagValidationError(`step "${step.key}" cannot depend on itself`);
      }
    }
  }

  // 3. Cycle detection + topological order via Kahn's algorithm.
  //    inDegree[k] = number of unresolved dependencies for step k.
  const inDegree = new Map<string, number>(keys.map((k) => [k, 0]));
  const dependents = new Map<string, string[]>(keys.map((k) => [k, []]));

  for (const step of dag.steps) {
    inDegree.set(step.key, step.dependsOn.length);
    for (const dep of step.dependsOn) {
      dependents.get(dep)!.push(step.key);
    }
  }

  const queue: string[] = keys.filter((k) => inDegree.get(k) === 0);
  const order: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const dependent of dependents.get(current)!) {
      const newDegree = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  if (order.length !== keys.length) {
    const cyclic = keys.filter((k) => !order.includes(k));
    throw new DagValidationError(`cycle detected involving step(s): ${cyclic.join(", ")}`);
  }

  return order;
}
