import { StepExecutor, PermanentExecutionError } from "./types";
import { executeHttpStep } from "./http";
import { executeScriptStep } from "./script";
import { executeAiEnrichmentStep } from "./aiEnrichment";
import { executeWebhookStep } from "./webhook";

const EXECUTORS: Record<string, StepExecutor> = {
  HTTP: executeHttpStep,
  SCRIPT: executeScriptStep,
  AI_ENRICHMENT: executeAiEnrichmentStep,
  WEBHOOK: executeWebhookStep,
};

export function getExecutor(stepType: string): StepExecutor {
  const executor = EXECUTORS[stepType];
  if (!executor) {
    throw new PermanentExecutionError(`no executor registered for step type "${stepType}"`);
  }
  return executor;
}

export * from "./types";
