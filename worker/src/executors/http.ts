import { StepExecutor, RetryableExecutionError, PermanentExecutionError } from "./types";

interface HttpStepConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * Executes an HTTP step. Classifies failures deliberately:
 * - Network errors / timeouts / 5xx -> retryable (the downstream service or
 *   network is likely transiently broken)
 * - 4xx -> permanent (retrying "bad request" with the same payload will
 *   never succeed and just wastes attempts / hammers the target)
 *
 * The idempotency key is sent as a header so a well-behaved downstream API
 * can dedupe on its side too if this step is ever retried after a response
 * was actually received but lost in transit (classic "did my write happen"
 * problem in distributed systems).
 */
export const executeHttpStep: StepExecutor = async (ctx) => {
  const config = ctx.config as unknown as HttpStepConfig;

  if (!config.url) {
    throw new PermanentExecutionError(`HTTP step "${ctx.stepKey}" is missing required "url" in config`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);

  try {
    const response = await fetch(config.url, {
      method: config.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": ctx.idempotencyKey,
        ...(config.headers ?? {}),
      },
      body: config.body ? JSON.stringify(config.body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON response body is fine, keep as raw text
    }

    if (response.status >= 500) {
      throw new RetryableExecutionError(`HTTP ${response.status} from ${config.url}`);
    }
    if (response.status >= 400) {
      throw new PermanentExecutionError(`HTTP ${response.status} from ${config.url}: ${text.slice(0, 200)}`);
    }

    return { output: { status: response.status, body: parsed } };
  } catch (err) {
    if (err instanceof RetryableExecutionError || err instanceof PermanentExecutionError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new RetryableExecutionError(`HTTP step "${ctx.stepKey}" timed out`);
    }
    // Unknown network-level errors (DNS failure, connection refused, etc.)
    // are treated as retryable -- they're almost always transient.
    throw new RetryableExecutionError(`HTTP step "${ctx.stepKey}" failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
};
