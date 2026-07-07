import client from "prom-client";

/**
 * A dedicated registry (rather than the global default) so this module is
 * self-contained and testable in isolation -- importing it twice in tests
 * never causes "metric already registered" collisions.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry }); // process CPU, memory, event loop lag, etc.

export const httpRequestsTotal = new client.Counter({
  name: "pulsequeue_http_requests_total",
  help: "Total HTTP requests handled by the API",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: "pulsequeue_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  // Buckets tuned for an API that's mostly fast DB-backed reads/writes with
  // an occasional slower path (e.g. trigger, which does a multi-row insert).
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const wsConnectionsActive = new client.Gauge({
  name: "pulsequeue_ws_connections_active",
  help: "Number of currently connected WebSocket clients watching a run",
  registers: [registry],
});
