/**
 * Exponential backoff with "full jitter" (AWS's recommended strategy):
 * delay = random(0, min(cap, base * 2^attempt))
 *
 * Full jitter (rather than a fixed exponential delay) matters at scale:
 * if 100 steps fail at the same instant, fixed backoff makes all 100 retry
 * at the same instant again (a thundering herd against whatever they're
 * calling). Randomizing within the window spreads retries out.
 */
export function computeBackoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}
