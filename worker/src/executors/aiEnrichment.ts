import { StepExecutor, RetryableExecutionError, PermanentExecutionError } from "./types";
import { logger } from "../lib/logger";
import { estimateCostUsd } from "../lib/costEstimate";

interface AiEnrichmentConfig {
  prompt: string;
  inputText?: string;
  model?: string;
  maxTokens?: number;
}

/**
 * This is the one place AI touches the product, and deliberately so: it's a
 * single step type among four, used only where an LLM call is genuinely the
 * right tool (summarizing/classifying/enriching unstructured text mid-pipeline)
 * -- not the entire product wrapped around a chat API.
 *
 * We track latency and (approximate) token usage on every call, because in
 * a real system "the AI step is slow/expensive" is itself an operational
 * concern the platform needs visibility into, same as any other step type.
 *
 * If no ANTHROPIC_API_KEY is configured, we return a clearly-labeled mock
 * result instead of failing -- so the whole pipeline is demoable without
 * requiring the person running it to have a paid API key on hand.
 */
export const executeAiEnrichmentStep: StepExecutor = async (ctx) => {
  const config = ctx.config as unknown as AiEnrichmentConfig;

  if (!config.prompt) {
    throw new PermanentExecutionError(`AI_ENRICHMENT step "${ctx.stepKey}" is missing required "prompt" in config`);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const startedAt = Date.now();

  if (!apiKey) {
    logger.warn({ stepKey: ctx.stepKey }, "ANTHROPIC_API_KEY not set, returning mock AI output");
    return {
      output: {
        mock: true,
        result: `[mock enrichment] ${config.prompt}`,
        latencyMs: 0,
      },
    };
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model ?? "claude-3-5-haiku-latest",
        max_tokens: config.maxTokens ?? 512,
        messages: [
          {
            role: "user",
            content: config.inputText ? `${config.prompt}\n\n${config.inputText}` : config.prompt,
          },
        ],
      }),
    });

    const latencyMs = Date.now() - startedAt;

    if (response.status >= 500 || response.status === 429) {
      throw new RetryableExecutionError(`AI provider returned ${response.status}`);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new PermanentExecutionError(`AI provider error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data: any = await response.json();
    const textOutput = data.content?.map((b: any) => b.text ?? "").join("\n") ?? "";
    const model = config.model ?? "claude-3-5-haiku-latest";

    return {
      output: {
        mock: false,
        result: textOutput,
        latencyMs,
        usage: data.usage ?? null,
        model,
        estimatedCostUsd: estimateCostUsd(model, data.usage ?? null),
      },
    };
  } catch (err) {
    if (err instanceof RetryableExecutionError || err instanceof PermanentExecutionError) throw err;
    throw new RetryableExecutionError(`AI_ENRICHMENT step "${ctx.stepKey}" failed: ${(err as Error).message}`);
  }
};
