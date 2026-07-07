# PulseQueue

**A self-hosted, distributed, multi-tenant workflow orchestration platform** —
think a lightweight Temporal/Inngest. Define a multi-step pipeline as a DAG,
trigger it via API, and watch it execute reliably in real time: automatic
retries with exponential backoff, dead-letter recovery, horizontal worker
scaling, and full observability.

📘 [**Complete Project Report & User Manual**](docs/PROJECT_REPORT.md) ·
📄 [Architecture deep-dive with diagrams](docs/ARCHITECTURE.md) ·

## What it does

Define a workflow as a DAG of steps (HTTP calls, data transforms, AI
enrichment, webhooks), each with its own dependencies and retry policy.
Trigger it, and a pool of worker replicas executes it — claiming steps
safely across concurrent workers, retrying transient failures with backoff,
dead-lettering permanent ones, and streaming live status to a dashboard over
WebSocket. Every execution is instrumented: Prometheus metrics, Grafana
dashboards, structured logs correlated by request/run ID.

## Why it exists

Nearly every backend system eventually needs reliable async execution — the
difference between "fire an HTTP request and hope" and a system that
survives crashes, retries intelligently, and tells you _why_ something
failed. This project builds that core, end to end, using real distributed-
systems primitives rather than a framework that hides them.

## Architecture at a glance

```
React Dashboard --REST/WebSocket--> API --> Postgres
                                      |
                                      v
                              Redis (Streams + Pub/Sub)
                                      |
                        -----------------------------
                        |             |              |
                   Worker #1     Worker #2      Worker #N
                        |             |              |
                        -------- Postgres (SELECT FOR UPDATE SKIP LOCKED) ------
                                      |
                          Prometheus --> Grafana
```

Full diagrams (sequence flow, ER diagram, state machine) in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tech stack

| Layer           | Choice                                                               |
| --------------- | -------------------------------------------------------------------- |
| API             | Node.js, Express, TypeScript, Prisma, JWT auth, WebSocket (`ws`)     |
| Worker          | Node.js, TypeScript, Redis Streams consumer groups                   |
| Database        | PostgreSQL                                                           |
| Queue / Pub-Sub | Redis (Streams for work dispatch, Pub/Sub for live UI updates)       |
| Frontend        | React, TypeScript, Vite, Tailwind                                    |
| Observability   | Prometheus, Grafana, structured JSON logs (pino)                     |
| CI/CD           | GitHub Actions (unit + integration tests, Docker build/push, deploy) |
| Infra           | Docker Compose (dev), pre-built registry images (prod)               |

## What's implemented

- **Auth & multi-tenancy**: JWT access + rotating refresh tokens, RBAC
  (ADMIN/MEMBER/VIEWER hierarchy), per-tenant Redis rate limiting
- **Workflow engine**: DAG validation with cycle detection (Kahn's
  algorithm), topological execution order, per-step retry policy
- **Distributed execution**: Redis Streams consumer groups, Postgres
  `SELECT ... FOR UPDATE SKIP LOCKED` for safe concurrent step claiming
  across horizontally-scaled worker replicas
- **Reliability**: per-type executors (HTTP, whitelisted data-transform
  scripts, AI enrichment, webhooks) with explicit retryable-vs-permanent
  error classification, exponential backoff with full jitter, dead-letter
  queue with a replay endpoint
- **Live dashboard**: WebSocket-authenticated live run view, no polling
- **Observability**: Prometheus metrics on both services, a provisioned
  Grafana dashboard, request-correlated structured logging
- **Testing**: 31 unit tests (dependency resolution, cycle detection,
  backoff bounds, RBAC, metrics) + a real end-to-end integration test
  against live Postgres/Redis/worker
- **CI/CD**: GitHub Actions running the full test suite plus Docker
  build/push to GHCR, and a manually-triggered deploy workflow to a VPS

## Quickstart

```bash
cd api && cp .env.example .env && cd ..
cd worker && cp .env.example .env && cd ..
docker compose up --build
```

| Service    | URL                                                            |
| ---------- | -------------------------------------------------------------- |
| Dashboard  | http://localhost:3000                                          |
| API        | http://localhost:4000 (health: `/health`, metrics: `/metrics`) |
| Prometheus | http://localhost:9090                                          |
| Grafana    | http://localhost:3001 (`admin` / `admin`)                      |

Register an account, create a workflow, trigger it, and watch the run detail
page update live. Try a workflow with a step pointed at
`https://httpstat.us/500` and `maxRetries: 2` to see retry -> dead-letter ->
replay in action.

**See it scale**: `docker compose up --build --scale worker=3` — trigger a
few workflows and check `docker compose logs -f worker`, you'll see
different replicas claiming different steps, none of them ever claiming the
same step twice.

## Testing

```bash
cd api && npm test                  # 13 unit tests, zero external deps
cd api && npm run test:integration  # needs postgres+redis+worker running
cd worker && npm test               # 18 unit tests
k6 run load-test/trigger-workflow.js  # load test, see load-test/README.md
```

## CI/CD

Every push runs unit tests, an integration test against real Postgres/Redis
service containers with the actual worker process running, and a frontend
build check. On `main`, a Docker build/push to GHCR follows if everything's
green. Deploys are a manually-triggered GitHub Actions workflow that SSHs
into a VPS and pulls the freshly-built images — see
[`.github/workflows/`](.github/workflows/) and
[`deploy/`](deploy/) for the full setup.

## Project structure

```
pulsequeue/
├── api/              Express API: auth, workflow CRUD, triggers, WebSocket gateway
├── worker/           Consumes Redis Streams, executes DAG steps, retry/backoff logic
├── frontend/         React dashboard (Vite + Tailwind)
├── monitoring/       Prometheus config + provisioned Grafana dashboard
├── deploy/           Production docker-compose (pulls pre-built images)
├── load-test/        k6 load test
├── docs/             Architecture and design notes
└── .github/workflows/  CI + deploy pipelines
```

## Known limitations

Documented honestly, not hidden — see the bottom of
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full list (Prisma
schema duplication between services, Prometheus scraping under scaled
workers, the security rationale for not supporting arbitrary code in
SCRIPT steps, and the WebSocket auth token tradeoff).

## Running migrations

```bash
docker compose exec api npx prisma migrate deploy
# or for local dev iteration:
cd api && npx prisma migrate dev --name init
```
