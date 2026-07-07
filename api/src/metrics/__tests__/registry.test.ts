import { describe, it, expect, beforeEach } from "vitest";
import {
  registry,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  wsConnectionsActive,
} from "../registry";

describe("API metrics registry", () => {
  beforeEach(() => {
    httpRequestsTotal.reset();
    httpRequestDurationSeconds.reset();
    wsConnectionsActive.set(0);
  });

  it("registers the expected metric names", async () => {
    const metrics = await registry.getMetricsAsJSON();
    const names = metrics.map((m) => m.name);
    expect(names).toContain("pulsequeue_http_requests_total");
    expect(names).toContain("pulsequeue_http_request_duration_seconds");
    expect(names).toContain("pulsequeue_ws_connections_active");
  });

  it("increments http_requests_total with the correct labels", async () => {
    httpRequestsTotal.inc({ method: "GET", route: "/api/v1/workflows", status: "200" });
    const value = await httpRequestsTotal.get();
    const match = value.values.find(
      (v) => v.labels.method === "GET" && v.labels.route === "/api/v1/workflows" && v.labels.status === "200"
    );
    expect(match?.value).toBe(1);
  });

  it("tracks ws connection count as a gauge that can go up and down", async () => {
    wsConnectionsActive.inc();
    wsConnectionsActive.inc();
    wsConnectionsActive.dec();
    const value = await wsConnectionsActive.get();
    expect(value.values[0].value).toBe(1);
  });
});
