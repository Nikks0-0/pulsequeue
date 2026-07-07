export interface StepExecutionContext {
  runId: string;
  stepId: string;
  stepKey: string;
  idempotencyKey: string;
  config: Record<string, unknown>;
}

export interface StepExecutionResult {
  output: unknown;
}

/**
 * Thrown by executors for failures that SHOULD be retried (network blips,
 * 5xx responses, timeouts). Distinguishing this from a plain Error lets the
 * run processor decide "retry with backoff" vs "fail permanently" without
 * string-matching error messages -- executors declare intent explicitly.
 */
export class RetryableExecutionError extends Error {}

/**
 * Thrown for failures that will never succeed no matter how many times we
 * retry (e.g. a 4xx "bad request", invalid config). Skips straight to
 * DEAD_LETTER instead of burning retry attempts on something that can't work.
 */
export class PermanentExecutionError extends Error {}

export type StepExecutor = (ctx: StepExecutionContext) => Promise<StepExecutionResult>;
