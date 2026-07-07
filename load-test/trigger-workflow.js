import http from "k6/http";
import { check, sleep } from "k6";

/**
 * Load test strategy: a POOL of tenants (created once in setup(), which
 * runs regardless of VU count), each VU pinned to one tenant by
 * (__VU % poolSize). This deliberately mirrors realistic traffic --  many
 * different customers, not one customer hammering the API -- rather than
 * funneling every VU through a single tenant, which would just trip that
 * one tenant's own rate limit and produce a wall of expected 429s that
 * look like a bug but are actually the rate limiter correctly doing its job.
 * (If you specifically want to verify the limiter engages under load, see
 * the single-tenant variant note at the bottom of this file.)
 *
 * Run with: k6 run load-test/trigger-workflow.js
 * Against a deployed instance: k6 run -e BASE_URL=https://your-domain load-test/trigger-workflow.js
 */
export const options = {
  scenarios: {
    ramping_triggers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 10 }, // ramp up
        { duration: "1m", target: 10 }, // sustain
        { duration: "30s", target: 50 }, // spike
        { duration: "1m", target: 50 }, // sustain spike
        { duration: "30s", target: 0 }, // ramp down
      ],
    },
  },
  thresholds: {
    // p95 trigger latency under 500ms is the bar: trigger only does an
    // insert + a stream publish, it should never be slow even under load.
    "http_req_duration{endpoint:trigger}": ["p(95)<500"],
    http_req_failed: ["rate<0.01"], // fewer than 1% hard failures
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";
const TENANT_POOL_SIZE = 20;

const TEST_DAG = {
  name: "load-test workflow",
  dag: {
    steps: [
      { key: "transform", type: "SCRIPT", dependsOn: [], config: { transform: "uppercase", input: "load test" } },
    ],
  },
};

export function setup() {
  const tenants = [];
  for (let i = 0; i < TENANT_POOL_SIZE; i++) {
    const email = `loadtest-${Date.now()}-${i}@example.com`;
    const registerRes = http.post(
      `${BASE_URL}/api/v1/auth/register`,
      JSON.stringify({ tenantName: `Load Test Tenant ${i}`, email, password: "password123" }),
      { headers: { "Content-Type": "application/json" } }
    );
    check(registerRes, { "setup: register succeeded": (r) => r.status === 201 });
    const accessToken = registerRes.json("accessToken");

    const createRes = http.post(`${BASE_URL}/api/v1/workflows`, JSON.stringify(TEST_DAG), {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    });
    check(createRes, { "setup: workflow created": (r) => r.status === 201 });

    tenants.push({ accessToken, workflowId: createRes.json("id") });
  }
  return { tenants };
}

export default function (data) {
  const tenant = data.tenants[__VU % data.tenants.length];

  const res = http.post(
    `${BASE_URL}/api/v1/workflows/${tenant.workflowId}/trigger`,
    null,
    {
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
      tags: { endpoint: "trigger" },
    }
  );

  check(res, { "trigger accepted (202)": (r) => r.status === 202 });

  sleep(1);
}

// To specifically verify the per-tenant rate limiter engages correctly
// under load (a legitimate, separate test from throughput testing), run a
// single-tenant variant: reuse ONE tenant across all VUs and expect to see
// 429s appear once aggregate request rate crosses 100 req/60s for that
// tenant -- that is the CORRECT outcome for that scenario, not a failure.

