/**
 * Approximate USD cost for an LLM call given token usage. Pricing is kept in
 * a small table rather than hardcoded inline so it's a single place to update
 * as providers change prices, and so it can be swapped for a real pricing API
 * later without touching the executor. Prices are per-million-tokens, in USD,
 * as of this project's build date -- deliberately approximate, this is for
 * operational cost visibility on a dashboard, not for billing.
 */
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-3-5-haiku-latest": { input: 0.8, output: 4 },
  "claude-3-5-sonnet-latest": { input: 3, output: 15 },
  "claude-3-opus-latest": { input: 15, output: 75 },
};

const DEFAULT_PRICING = { input: 1, output: 5 };

export function estimateCostUsd(
  model: string,
  usage: { input_tokens?: number; output_tokens?: number } | null | undefined
): number | null {
  if (!usage || usage.input_tokens == null || usage.output_tokens == null) return null;

  const pricing = PRICING_PER_MILLION_TOKENS[model] ?? DEFAULT_PRICING;
  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;

  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // round to 6 decimals
}
