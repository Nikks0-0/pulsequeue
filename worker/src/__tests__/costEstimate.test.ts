import { describe, it, expect } from "vitest";
import { estimateCostUsd } from "../lib/costEstimate";

describe("estimateCostUsd", () => {
  it("returns null when usage data is missing", () => {
    expect(estimateCostUsd("claude-3-5-haiku-latest", null)).toBeNull();
    expect(estimateCostUsd("claude-3-5-haiku-latest", undefined)).toBeNull();
  });

  it("computes cost correctly for a known model", () => {
    // haiku: $0.80/M input, $4/M output
    const cost = estimateCostUsd("claude-3-5-haiku-latest", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.8 + 4, 5);
  });

  it("falls back to default pricing for an unknown model", () => {
    const cost = estimateCostUsd("some-future-model", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(1 + 5, 5);
  });

  it("scales linearly with token count", () => {
    const half = estimateCostUsd("claude-3-5-sonnet-latest", { input_tokens: 500_000, output_tokens: 0 });
    const full = estimateCostUsd("claude-3-5-sonnet-latest", { input_tokens: 1_000_000, output_tokens: 0 });
    expect(full).toBeCloseTo((half as number) * 2, 5);
  });
});
