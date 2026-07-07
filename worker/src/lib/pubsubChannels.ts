// Channel pattern: run:<runId>:events -- matches runUpdateChannel() in
// lib/pubsubChannels.ts, which both this gateway and the worker's publisher
// derive from so the two sides can never drift out of sync on naming.
export function runUpdateChannel(runId: string): string {
  return `run:${runId}:events`;
}
