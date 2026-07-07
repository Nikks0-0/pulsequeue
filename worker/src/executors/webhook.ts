import { StepExecutor, RetryableExecutionError, PermanentExecutionError } from "./types";

interface WebhookStepConfig {
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

/**
 * Webhooks are treated as a distinct step type from generic HTTP even though
 * the underlying call is similar, because the *intent* differs: HTTP steps
 * fetch/mutate external data as part of the pipeline's logic, webhooks exist
 * purely to notify something outside the system that a run reached a point.
 * Keeping them separate means we can evolve delivery semantics (e.g. adding
 * HMAC request signing) without touching the general-purpose HTTP executor.
 */
export const executeWebhookStep: StepExecutor = async (ctx) => {
  const config = ctx.config as unknown as WebhookStepConfig;

  if (!config.url) {
    throw new PermanentExecutionError(`WEBHOOK step "${ctx.stepKey}" is missing required "url" in config`);
  }

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": ctx.idempotencyKey,
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(config.payload ?? { runId: ctx.runId, stepKey: ctx.stepKey }),
    });

    if (response.status >= 500) {
      throw new RetryableExecutionError(`webhook endpoint returned ${response.status}`);
    }
    if (response.status >= 400) {
      throw new PermanentExecutionError(`webhook endpoint returned ${response.status}`);
    }

    return { output: { delivered: true, status: response.status } };
  } catch (err) {
    if (err instanceof RetryableExecutionError || err instanceof PermanentExecutionError) throw err;
    throw new RetryableExecutionError(`WEBHOOK step "${ctx.stepKey}" failed: ${(err as Error).message}`);
  }
};
