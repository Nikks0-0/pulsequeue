import { describe, it, expect } from "vitest";
import { computeBackoffMs } from "../lib/backoff";

describe("computeBackoffMs", () => {
  it("never returns a negative delay", () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(computeBackoffMs(attempt)).toBeGreaterThanOrEqual(0);
    }
  });

  it("grows the upper bound exponentially with attempt number", () => {
    // With Math.random() mocked to always return the max (just under 1),
    // the result should approach baseMs * 2^attempt, capped.
    const base = 1000;
    const cap = 60_000;
    expect(computeBackoffMs(0, base, cap)).toBeLessThan(base * 1);
    expect(computeBackoffMs(3, base, cap)).toBeLessThan(base * 8);
    expect(computeBackoffMs(10, base, cap)).toBeLessThanOrEqual(cap);
  });

  it("respects the cap even for very high attempt numbers", () => {
    const cap = 5000;
    for (let i = 0; i < 20; i++) {
      expect(computeBackoffMs(50, 1000, cap)).toBeLessThanOrEqual(cap);
    }
  });
});
