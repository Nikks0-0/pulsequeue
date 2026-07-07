import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { app } from "../../app";

/**
 * This is a TRUE end-to-end test: it hits the real Express app (via
 * supertest, no mocking) backed by a real Postgres and Redis, and expects
 * an actual worker process to be running and consuming the stream to move
 * the triggered run to completion. Unit tests validate logic in isolation;
 * this validates that all the pieces are wired together correctly, which is
 * the class of bug unit tests structurally cannot catch (e.g. a route
 * mounted at the wrong path, an env var name mismatch between services).
 *
 * Requires DATABASE_URL and REDIS_URL to point at real services, and a
 * worker consuming the same Redis stream -- see .github/workflows/ci.yml
 * for how CI provisions this, or run `docker compose up -d postgres redis`
 * and `npm run dev` in worker/ locally before running this file directly.
 */
describe("full workflow lifecycle (integration)", () => {
  let accessToken: string;

  beforeAll(async () => {
    const email = `integration-${Date.now()}@example.com`;
    const res = await request(app).post("/api/v1/auth/register").send({
      tenantName: "Integration Test Tenant",
      email,
      password: "password123",
    });
    expect(res.status).toBe(201);
    accessToken = res.body.accessToken;
  });

  it("registers, creates a workflow, triggers it, and reaches a terminal run status", async () => {
    const createRes = await request(app)
      .post("/api/v1/workflows")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        name: "integration test workflow",
        dag: {
          steps: [
            {
              key: "transform",
              type: "SCRIPT",
              dependsOn: [],
              config: { transform: "uppercase", input: "hello" },
            },
          ],
        },
      });
    expect(createRes.status).toBe(201);
    const workflowId = createRes.body.id;

    const triggerRes = await request(app)
      .post(`/api/v1/workflows/${workflowId}/trigger`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(triggerRes.status).toBe(202);
    const runId = triggerRes.body.runId;

    // Poll for completion -- a worker must be running to ever leave PENDING.
    let status = "PENDING";
    for (let i = 0; i < 20 && !["SUCCEEDED", "FAILED"].includes(status); i++) {
      await new Promise((r) => setTimeout(r, 500));
      const runRes = await request(app)
        .get(`/api/v1/runs/${runId}`)
        .set("Authorization", `Bearer ${accessToken}`);
      status = runRes.body.status;
    }

    expect(status).toBe("SUCCEEDED");

    const stepsRes = await request(app)
      .get(`/api/v1/runs/${runId}/steps`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(stepsRes.body.steps[0].status).toBe("SUCCEEDED");
    expect(stepsRes.body.steps[0].output.output).toBe("HELLO");
  });

  it("rejects a cyclic DAG at creation time with 400, never reaching a worker", async () => {
    const res = await request(app)
      .post("/api/v1/workflows")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        name: "broken",
        dag: { steps: [{ key: "a", type: "HTTP", dependsOn: ["b"] }, { key: "b", type: "HTTP", dependsOn: ["a"] }] },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_dag");
  });

  it("enforces tenant isolation: a second tenant cannot see the first tenant's workflow", async () => {
    const otherEmail = `other-tenant-${Date.now()}@example.com`;
    const otherRegister = await request(app).post("/api/v1/auth/register").send({
      tenantName: "Other Tenant",
      email: otherEmail,
      password: "password123",
    });
    const otherToken = otherRegister.body.accessToken;

    const listRes = await request(app)
      .get("/api/v1/workflows")
      .set("Authorization", `Bearer ${otherToken}`);

    expect(listRes.body.data).toHaveLength(0); // sees none of tenant one's workflows
  });
});
