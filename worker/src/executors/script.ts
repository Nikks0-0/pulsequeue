import { StepExecutor, PermanentExecutionError } from "./types";

/**
 * SECURITY NOTE: a "SCRIPT" step does NOT execute arbitrary user-supplied
 * code (no eval, no child_process, no vm module sandbox-escape surface).
 * Running arbitrary code from workflow definitions -- which in a real
 * multi-tenant product are attacker-controlled input -- is a remote code
 * execution vector. Instead, SCRIPT steps select from a small, fixed
 * registry of safe, pure data transforms. This is a deliberate scope
 * limitation, not an oversight: the interview answer to "how would you let
 * users run custom code safely" is "gVisor/Firecracker microVM sandboxing
 * or a WASM runtime with no host syscalls" -- out of scope for this project
 * but worth being able to name if asked.
 */
type TransformFn = (input: unknown, params: Record<string, unknown>) => unknown;

const TRANSFORM_REGISTRY: Record<string, TransformFn> = {
  uppercase: (input) => (typeof input === "string" ? input.toUpperCase() : input),
  lowercase: (input) => (typeof input === "string" ? input.toLowerCase() : input),
  extractField: (input, params) => {
    const path = String(params.path ?? "");
    return path.split(".").reduce<any>((acc, key) => (acc == null ? acc : acc[key]), input);
  },
  jsonStringify: (input) => JSON.stringify(input),
  merge: (input, params) =>
    typeof input === "object" && input !== null ? { ...input, ...(params.with as object) } : input,
};

interface ScriptStepConfig {
  transform: keyof typeof TRANSFORM_REGISTRY | string;
  input?: unknown;
  params?: Record<string, unknown>;
}

export const executeScriptStep: StepExecutor = async (ctx) => {
  const config = ctx.config as unknown as ScriptStepConfig;

  const fn = TRANSFORM_REGISTRY[config.transform];
  if (!fn) {
    throw new PermanentExecutionError(
      `unknown transform "${config.transform}" for step "${ctx.stepKey}". Available: ${Object.keys(TRANSFORM_REGISTRY).join(", ")}`
    );
  }

  const output = fn(config.input, config.params ?? {});
  return { output };
};
