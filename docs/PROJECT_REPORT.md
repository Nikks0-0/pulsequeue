# PulseQueue — Complete Project Report & User Manual

**A distributed, multi-tenant workflow orchestration platform**

---

## Table of Contents

1. [Introduction & Purpose of This Document](#1-introduction--purpose-of-this-document)
2. [The Problem This Project Solves](#2-the-problem-this-project-solves)
3. [Design Philosophy & Scope Decisions](#3-design-philosophy--scope-decisions)
4. [What PulseQueue Actually Does](#4-what-pulsequeue-actually-does)
5. [System Architecture](#5-system-architecture)
6. [Technology Stack & Why Each Piece Was Chosen](#6-technology-stack--why-each-piece-was-chosen)
7. [Repository Structure](#7-repository-structure)
8. [Database Design](#8-database-design)
9. [The API Service — File by File](#9-the-api-service--file-by-file)
10. [The Worker Service — File by File](#10-the-worker-service--file-by-file)
11. [The Frontend — File by File](#11-the-frontend--file-by-file)
12. [The DAG Workflow Engine Explained](#12-the-dag-workflow-engine-explained)
13. [The Execution Engine: Claiming, Retries, Dead-Lettering](#13-the-execution-engine-claiming-retries-dead-lettering)
14. [Real-Time Updates: WebSockets & Redis Pub/Sub](#14-real-time-updates-websockets--redis-pubsub)
15. [Observability: Prometheus, Grafana, Structured Logs](#15-observability-prometheus-grafana-structured-logs)
16. [Security Model](#16-security-model)
17. [Testing Strategy](#17-testing-strategy)
18. [CI/CD Pipeline](#18-cicd-pipeline)
19. [Deployment Guide](#19-deployment-guide)
20. [Complete API Reference](#20-complete-api-reference)
21. [USER MANUAL — How to Use the Application](#21-user-manual--how-to-use-the-application)
22. [Environment Variables Reference](#22-environment-variables-reference)
23. [Known Limitations & Honest Tradeoffs](#23-known-limitations--honest-tradeoffs)
24. [What Could Be Built Next](#24-what-could-be-built-next)
25. [Glossary of Terms](#25-glossary-of-terms)

---

## 1. Introduction & Purpose of This Document

This document is a complete, from-scratch explanation of the PulseQueue
project: why it exists, how it was designed, exactly what every file in the
codebase does, how the system behaves at runtime, and how to actually use
the finished application. It is written so that **someone who has never
seen this codebase before** — a new engineer joining the project, a
technical reviewer, or the original author returning to it months later —
can read it top to bottom and come away understanding not just _what_ the
code does but _why_ it was built that way.

It doubles as a **user manual**: Section 21 walks through the running
application screen by screen, so even a non-technical reader could follow
along and use the dashboard.

If you only read one section, read Section 5 (Architecture) and Section 21
(User Manual) — together they cover how the system works and how to use it.

---

## 2. The Problem This Project Solves

Almost every non-trivial backend system eventually needs to run **multi-step
asynchronous work reliably** — for example, a signup flow that must send a
welcome email, enrich a user's profile via an external API, and notify a
downstream system, all as one logical unit of work that must survive a
crash partway through. Handling this ad hoc ("just call three APIs in a row
and hope") breaks the moment any one call is slow, flaky, or the process
restarts mid-way. Building this correctly requires a real answer to several
hard distributed-systems questions at once: how do you guarantee a step
runs even if the process that was supposed to run it crashes? How do you
avoid running the same step twice? How do you back off intelligently from a
failing dependency instead of hammering it? How do you let a human recover
gracefully once something genuinely breaks?

PulseQueue is a self-hosted, open-source workflow orchestration platform
that answers exactly this problem — a lightweight relative of tools like
**Temporal**, **Inngest**, or **Apache Airflow**. A user defines a
**workflow** as a **DAG (Directed Acyclic Graph)** of steps with
dependencies, triggers it via an API call, and a pool of worker processes
executes each step reliably: retrying transient failures with exponential
backoff, failing fast and flagging permanent failures for manual review
("dead-lettering"), and allowing failed steps to be replayed once whatever
was wrong has been fixed — all visible on a live dashboard that updates in
real time as execution happens.

---

## 3. Design Philosophy & Scope Decisions

This section explains the reasoning behind the project's scope and the
major decisions that shaped it, since understanding _why_ the system is
built the way it is provides useful context for reading the rest of this
document.

### 3.1 Why a workflow orchestration platform, specifically

A large class of backend problems — data pipelines, notification chains,
multi-step enrichment jobs, anything that chains several external calls
together — collapses to the same underlying need: reliable, observable,
retryable execution of a dependency graph of steps. Rather than solving
that need differently in every individual project, a general-purpose
orchestration layer solves it once. This project deliberately goes deep on
that one problem rather than building a broader, shallower set of features,
because the interesting engineering — atomic concurrent step claiming,
retry/backoff semantics, exactly-once-effect execution guarantees, live
observability — only shows up once you commit to solving the problem
properly rather than partially.

### 3.2 Why AI is used as one step type, not as the whole product

The system includes an `AI_ENRICHMENT` step type that calls a large
language model as part of a pipeline (for example, summarizing or
classifying data mid-workflow). This is deliberately scoped as **one step
type among four**, sitting behind the same retry/backoff/dead-letter
machinery as every other step type, with its own latency and cost tracking
— rather than being the entire product wrapped around a chat interface.
The distinction matters: an LLM call is genuinely useful as one stage in a
larger, reliable pipeline, but treating an API call to a model provider as
the whole of a "product" tends to produce something that doesn't need most
of the engineering this project is actually about.

### 3.3 A design document before implementation

Before implementation began, a full design document was produced: problem
statement, functional and non-functional requirements, high- and low-level
architecture, database schema, API design, sequence diagrams, deployment
architecture, and an implementation plan broken into discrete stages. This
mirrors how a design is typically vetted before a large feature is built in
a real engineering organization — working out the architecture on paper is
far cheaper than discovering a structural problem after the code already
exists.

### 3.4 Incremental delivery, verified at every stage

The system was built as a sequence of small, complete, independently
verifiable increments rather than as one large undifferentiated effort —
each stage produced working code with passing automated tests before the
next stage began, and the project became runnable end-to-end
(`docker compose up`) early, with every subsequent stage adding to a system
that already worked, rather than assembling many partially-finished pieces
at the very end. Section 17 (Testing) and Section 18 (CI/CD) describe how
correctness was verified throughout.

---

## 4. What PulseQueue Actually Does

At its core, PulseQueue lets a user:

1. **Register** an account, which creates a new **tenant** (organization)
   with them as its first **admin** user.
2. **Define a workflow**: a named DAG of **steps**. Each step has a type
   (`HTTP`, `SCRIPT`, `AI_ENRICHMENT`, or `WEBHOOK`), a configuration object
   specific to that type, a list of other steps it depends on, and a
   maximum retry count.
3. **Trigger** the workflow, which creates a **run** — one execution
   instance of that workflow, with one **step record** per DAG node.
4. Watch a pool of **worker processes** execute the run: each ready step
   (all its dependencies already succeeded) gets picked up by a worker,
   executed, and moved to `SUCCEEDED`, `RETRYING` (with a growing backoff
   delay), or `DEAD_LETTER` depending on the outcome.
5. Watch this happen **live**, in a browser dashboard, via a WebSocket
   connection — no manual refreshing.
6. If a step permanently fails after exhausting its retries, **replay** it
   once whatever was wrong has been fixed, without losing any of the run's
   other progress.
7. Behind the scenes, every step execution and API request is measured and
   exposed as **Prometheus metrics**, visualized in a pre-built **Grafana**
   dashboard, so operational health (queue depth, latency, error rates) is
   visible at a glance.

The whole system is designed to survive and recover from failure
gracefully: a worker process can crash mid-run and another replica will
pick up the remaining work; a flaky external API can fail transiently and
the system retries it automatically with exponential backoff; a genuinely
broken step (bad URL, bad request) fails fast instead of retrying forever
and gets flagged for a human to fix and replay.

---

## 5. System Architecture

### 5.1 The four deployable pieces

PulseQueue is **not a single application** — it is four independently
deployable pieces plus supporting infrastructure, built this way to reflect
real service boundaries rather than a monolith:

| Piece              | What it is                                 | Where it lives                       |
| ------------------ | ------------------------------------------ | ------------------------------------ |
| **API**            | Express/TypeScript REST + WebSocket server | `api/`                               |
| **Worker**         | Node/TypeScript background process pool    | `worker/`                            |
| **Frontend**       | React/TypeScript single-page dashboard     | `frontend/`                          |
| **Infrastructure** | Postgres, Redis, Prometheus, Grafana       | run as Docker images, no custom code |

### 5.2 How data flows through the system

1. A user's browser talks to the **API** over plain REST (login, create
   workflow, trigger) and over a **WebSocket** (live run status).
2. The API is the _only_ thing that talks to Postgres for writes related to
   auth, workflow definitions, and run/step creation. It **never executes a
   workflow step itself** — its job on trigger is simply: insert a `Run`
   row and one `Step` row per DAG node (all in a single database
   transaction, so a request can never leave a half-created run behind),
   then publish one small event (just IDs, no payload) onto a **Redis
   Stream** called `workflow-events`.
3. A pool of **worker** processes all subscribe to that same Redis Stream
   as a **consumer group** — Redis's built-in mechanism for "many
   consumers, each message delivered to exactly one of them." When a
   worker receives the event, it does NOT trust the event's contents beyond
   the run ID — it goes back to Postgres and reads the current, authoritative
   state of that run and its steps. This makes the event itself replay-safe:
   an event delivered twice, or delivered late, never causes incorrect
   behavior, because the worker always acts on live database state, not on
   stale event data.
4. The worker figures out which steps are **ready to run** (a step is ready
   if its status is `PENDING`, or `RETRYING` with its backoff window
   elapsed, AND every step it depends on has already reached `SUCCEEDED`).
   It then **atomically claims** those steps using a single SQL statement:
   `SELECT ... FOR UPDATE SKIP LOCKED`. This is the single most important
   line of SQL in the whole project — explained in full in Section 13.
5. The worker executes each claimed step using the executor matching its
   type (Section 12), updates its status in Postgres, and **publishes a
   second, different kind of message** — this time over **Redis Pub/Sub**,
   not Streams — announcing "this step just changed state."
6. The API's **WebSocket gateway** is subscribed to all such Pub/Sub
   messages (via a Redis pattern-subscribe on `run:*:events`) and relays
   the relevant ones to whichever connected browser is watching that
   specific run. The browser updates its UI instantly, with no polling.
7. Throughout all of this, both the API and every worker replica expose a
   `/metrics` endpoint that Prometheus scrapes every 5 seconds, and Grafana
   queries Prometheus to render live charts.

### 5.3 Why two different Redis mechanisms (Streams AND Pub/Sub)

This is a deliberate design decision worth understanding deeply, because
it reflects a real distributed-systems principle: **pick the delivery
guarantee that matches what you actually need, per use case, rather than
using one mechanism for everything.**

- **Redis Streams** (`workflow-events`) is a **durable, acknowledged, at-
  least-once** delivery mechanism. If a worker crashes after reading a
  message but before finishing (and acknowledging, "XACK"-ing) it, that
  message remains recoverable — it sits in the stream's Pending Entries
  List and can be reclaimed. This durability is required here because
  "a step must eventually execute" is a correctness requirement — losing a
  trigger event would mean a user's workflow silently never runs.
- **Redis Pub/Sub** (`run:<id>:events`) is **fire-and-forget**. If no
  browser happens to be connected when a message publishes, that message
  is simply gone — nobody receives it, and nothing re-delivers it later.
  This is fine for live UI updates, because if a dashboard isn't currently
  open, the next time it opens it just reads the current state from the
  database directly (via `GET /runs/:id/steps`) — no data is actually
  lost, only a transient notification.

Using Streams for both would work correctness-wise but adds unnecessary
overhead (consumer groups, acknowledgment bookkeeping) to something that
doesn't need durability. Using Pub/Sub for both would be a genuine bug: a
worker crash could silently drop a step's execution forever, with no way to
recover it. Matching the primitive to the guarantee is the point.

### 5.4 Why Postgres row-locking instead of a dedicated message queue for step claiming

An alternative design would give each ready step its own message in a
queue (SQS, RabbitMQ, another Redis Stream) and have workers consume from
that queue. PulseQueue does not do this — instead, workers query Postgres
directly for ready steps and claim them with `SELECT ... FOR UPDATE SKIP
LOCKED`. The reasoning: a step's readiness is _inherently_ a property of
relational state (its own status, plus every dependency's status), so
computing "what's ready" already requires talking to Postgres. Adding a
second queue just to re-announce something Postgres already knows would
duplicate a source of truth — a classic distributed-systems anti-pattern
that creates the possibility of the queue and the database disagreeing.
Using Postgres's own row-locking gives exactly the coordination needed
(safe concurrent claiming across many worker replicas) with zero additional
infrastructure and zero risk of the two stores drifting apart.

---

## 6. Technology Stack & Why Each Piece Was Chosen

| Technology                               | Used for                                                                                   | Why this and not an alternative                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript**                           | Both backend services and the frontend                                                     | Type safety catches an entire class of bugs (wrong field name, wrong argument order) at compile time rather than at runtime in production                                                                                                                 |
| **Node.js + Express**                    | The API service                                                                            | Express is minimal and unopinionated, which keeps the auth/RBAC/rate-limiting middleware chain easy to reason about — a heavier framework would obscure the exact mechanics this project is built around                                                  |
| **Prisma ORM**                           | Database schema, migrations, and queries                                                   | Gives real migrations and full TypeScript type-safety on every query, while the schema itself is still hand-designed rather than auto-generated from existing data                                                                                        |
| **PostgreSQL**                           | The single source of truth for all relational data                                         | Relational integrity (foreign keys, transactions) is exactly what tenant/user/workflow/run/step relationships need; Postgres's `SELECT ... FOR UPDATE SKIP LOCKED` is also what makes safe concurrent step-claiming possible without extra infrastructure |
| **Redis**                                | Work-queue dispatch (Streams), live UI notifications (Pub/Sub), and rate-limiting counters | One piece of infrastructure serving three distinct, well-understood roles, each using the Redis primitive actually suited to it                                                                                                                           |
| **JWT (jsonwebtoken)**                   | Authentication                                                                             | Industry-standard stateless auth, paired here with **refresh token rotation** (Section 16) to mitigate the usual "stolen long-lived token" risk                                                                                                           |
| **ws (WebSocket library)**               | Live dashboard updates                                                                     | A raw, lightweight WebSocket server mounted on the same HTTP server as Express — no heavier real-time framework needed for one use case                                                                                                                   |
| **React + TypeScript + Vite + Tailwind** | The dashboard frontend                                                                     | Vite for fast builds, Tailwind's design tokens for a deliberate dark "operational dashboard" visual style, React for component-based UI with live state updates                                                                                           |
| **Docker + Docker Compose**              | Local development and the deployable unit for every service                                | The entire stack (Postgres, Redis, API, worker(s), frontend, Prometheus, Grafana) starts with one command; the same images are what CI builds and what production runs                                                                                    |
| **Prometheus + Grafana**                 | Metrics collection and visualization                                                       | The standard open-source combination for exactly this; both are provisioned automatically (datasource + dashboard) so no manual dashboard setup is required                                                                                               |
| **pino / pino-http**                     | Structured JSON logging                                                                    | Machine-parseable logs with per-request correlation IDs, rather than unstructured strings                                                                                                                                                                 |
| **k6**                                   | Load testing                                                                               | Scriptable in JavaScript, with built-in support for staged ramp-up scenarios and pass/fail thresholds                                                                                                                                                     |
| **GitHub Actions**                       | CI/CD                                                                                      | Supports matrixed unit tests, real Postgres/Redis service containers for integration testing, and Docker image publishing                                                                                                                                 |
| **Anthropic API (Claude)**               | The one use of AI, inside the `AI_ENRICHMENT` step type                                    | Used as one step type among four, behind the same retry/dead-letter machinery as every other step type; falls back to a clearly-labeled mock result if no API key is configured, so the system remains fully demonstrable without a paid key              |

---

## 7. Repository Structure

```
pulsequeue/
├── api/                          Express API service
│   ├── prisma/
│   │   └── schema.prisma         Database schema (source of truth)
│   ├── src/
│   │   ├── app.ts                Express app definition (importable, testable)
│   │   ├── index.ts              Thin entrypoint: creates HTTP server, starts listening
│   │   ├── dag/                  DAG schema validation + cycle detection
│   │   ├── lib/                  Shared clients: Prisma, Redis, logger, pub/sub helpers
│   │   ├── metrics/              Prometheus metrics registry
│   │   ├── middleware/           Auth, RBAC, rate limiting, request ID, validation
│   │   ├── routes/               auth.ts, workflows.ts, runs.ts
│   │   ├── types/                Ambient TypeScript type augmentation
│   │   ├── utils/                JWT signing/verification, password hashing, zod schemas
│   │   ├── ws/                   WebSocket gateway
│   │   └── __tests__/            Unit tests + integration tests
│   ├── Dockerfile
│   ├── vitest.config.ts          Unit test config (excludes integration tests)
│   └── vitest.integration.config.ts
│
├── worker/                       Background execution service
│   ├── prisma/schema.prisma      Copy of api's schema (documented tradeoff, see Section 23)
│   ├── src/
│   │   ├── index.ts              Main consumer loop
│   │   ├── executors/            HTTP, SCRIPT, AI_ENRICHMENT, WEBHOOK step implementations
│   │   ├── lib/                  Claiming logic, backoff, run processor, pub/sub, sweep
│   │   ├── metrics/               Prometheus metrics registry + minimal HTTP server
│   │   └── __tests__/            Unit tests
│   └── Dockerfile
│
├── frontend/                     React dashboard
│   ├── src/
│   │   ├── pages/                Login, Register, WorkflowsList, WorkflowCreate, RunDetail
│   │   ├── components/           Nav, ProtectedRoute
│   │   ├── lib/                  API client, auth context, shared types
│   │   ├── App.tsx               Router setup
│   │   └── index.css             Design tokens, dark theme, pulse animation
│   ├── Dockerfile                Builds static assets, serves via nginx
│   └── nginx.conf                SPA routing fallback
│
├── monitoring/                   Prometheus + Grafana configuration
│   ├── prometheus.yml            Scrape targets
│   └── grafana/
│       ├── provisioning/         Auto-configured datasource + dashboard loader
│       └── dashboards/           The actual dashboard JSON
│
├── deploy/                       Production deployment
│   ├── docker-compose.prod.yml   Pulls pre-built images from GHCR (no local building)
│   └── .env.prod.example
│
├── load-test/                    k6 load testing
│   ├── trigger-workflow.js
│   └── README.md
│
├── docs/                         Project documentation
│   ├── ARCHITECTURE.md           Diagrams: system, sequence, state machine, ER
│   └── PROJECT_REPORT.md         This document
│
├── .github/workflows/
│   ├── ci.yml                    Unit tests, integration test, Docker build/push
│   └── deploy.yml                Manually-triggered VPS deployment
│
├── docker-compose.yml            Full local dev stack (builds from source)
└── README.md                     Project overview and quickstart
```

---

## 8. Database Design

All data lives in a single PostgreSQL database, defined in
`api/prisma/schema.prisma` (and mirrored in `worker/prisma/schema.prisma` —
see Section 23 for why this duplication exists and is a deliberate,
documented tradeoff rather than an oversight).

### 8.1 The six tables

**`tenants`** — one row per organization/customer. Every other table
(except `steps`, which belongs to a run which belongs to a workflow which
belongs to a tenant) is scoped to a tenant, either directly or transitively.
This is what makes the system multi-tenant: every query that returns data
to a user is filtered by that user's `tenantId`, so tenant A can never see
tenant B's workflows, runs, or steps.

**`users`** — one row per person who can log in. Belongs to exactly one
tenant. Has a `role` (`ADMIN`, `MEMBER`, or `VIEWER`) and a `tokenVersion`
integer used for refresh-token invalidation (Section 16.2).

**`workflows`** — one row per _defined_ workflow (the DAG template itself,
not an execution of it). The DAG structure is stored as a JSON column
(`dagJson`) rather than as separate relational tables for steps/edges —
this was a deliberate choice: the DAG is validated and structurally
verified (Section 12) _before_ it's ever written to the database, so
there's no risk of an invalid graph being persisted, and storing it as one
JSON blob makes reading/writing a whole workflow definition a single query
instead of a multi-table join.

**`runs`** — one row per _execution_ of a workflow. Has a `status`
(`PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `DEAD_LETTER`) and
`startedAt`/`finishedAt` timestamps.

**`steps`** — one row per DAG node _within a specific run_. This is where
almost all of the interesting state lives: `status`, `attemptCount`,
`nextAttemptAt` (when a retry becomes eligible), `idempotencyKey` (unique
per step, used to make retries safe), `input`/`output` JSON, and `error`.

**`api_keys`** — one row per API key a tenant could issue (for
programmatic access, as an alternative to logging in via the browser).
Includes a per-key `rateLimit`.

### 8.2 Why `dagJson` is a JSON column, not normalized tables

An alternative design would have separate `dag_steps` and `dag_edges`
tables. This project deliberately did not do that, for two reasons: (1)
the DAG is immutable once validated — a workflow's structure doesn't get
edited step-by-step the way, say, a to-do list gets items added one at a
time — so there's little benefit to normalizing it; and (2) reading "the
whole DAG" is by far the most common access pattern (every trigger, every
readiness check reads the entire structure), and a single JSON column
answers that in one query with no joins.

### 8.3 The `idempotencyKey` unique constraint

Every step has a globally unique `idempotencyKey`, computed deterministically
as `${runId}:${stepKey}`. This means if the API's trigger endpoint were ever
called twice for the same intended trigger (a network retry from a flaky
client, for example) in a way that tried to create the same steps twice,
the database itself would reject the duplicate at the constraint level —
correctness is enforced by the schema, not just by application logic that
could have a bug.

### 8.4 Indexes

Indexes exist on every foreign key that's queried by directly in a hot path:
`users.tenantId`, `workflows.tenantId`, `runs.workflowId`, `runs.status`,
`steps.runId`, `steps.status`, `api_keys.tenantId`. The `runs.status` and
`steps.status` indexes specifically support the worker's readiness-polling
queries and the dashboard's list views, both of which filter by status.

---

## 9. The API Service — File by File

Location: `api/`. This service is the only thing browsers and API clients
talk to directly. It never executes a workflow step — its responsibilities
are authentication, tenant/workflow/run CRUD, validating DAGs, publishing
trigger events, and relaying live updates over WebSocket.

### 9.1 `src/app.ts`

Defines the Express application itself: middleware chain, route mounting,
the `/health` and `/metrics` endpoints. Deliberately separated from
`index.ts` (which just starts the server) so that **tests can import the
app directly and drive it in-process with `supertest`**, without needing a
real running server or open port. The middleware order matters and is worth
understanding precisely:

1. `helmet()` — sets a set of security-related HTTP headers (prevents
   clickjacking, disables MIME-sniffing, etc.) as a baseline hardening step.
2. `cors()` — allows the frontend (a different origin in dev) to call the API.
3. `express.json()` — parses JSON request bodies.
4. `requestId` — generates or propagates a correlation ID (Section 15.3).
5. `metricsMiddleware` — records HTTP request count/duration (Section 15.1).
6. `pino-http` — structured request logging, tagged with the correlation ID.
7. Public routes (`/health`, `/metrics`, `/api/v1/auth/*`) are mounted
   _before_ the auth gate.
8. `authenticate` + a per-tenant `rateLimit` are applied to everything under
   `/api/v1` _except_ the auth routes already mounted above them — Express
   middleware only applies to routes registered after it, which is exactly
   how "auth routes are public, everything else needs a token" is enforced.
9. `workflowsRouter` and `runsRouter` are mounted last.

### 9.2 `src/index.ts`

The actual process entrypoint. Creates a raw Node `http.Server` wrapping the
Express `app` (rather than calling `app.listen()` directly), because the
WebSocket gateway needs to attach itself to the _same_ underlying HTTP
server (WebSocket connections start life as an HTTP "upgrade" request on
the same port). Calls `attachWebSocketGateway(server)` and then
`server.listen(PORT)`.

### 9.3 `prisma/schema.prisma`

The database schema — see Section 8 for the full explanation of every
table. This file is the single source of truth Prisma uses to generate a
fully-typed database client (`@prisma/client`) and to generate/apply SQL
migrations.

### 9.4 `src/dag/schema.ts`

Defines the **shape** a workflow's DAG must have, using `zod` (a runtime
schema validation library). A DAG is `{ steps: DagStep[] }`, where each
step has: `key` (a unique short identifier, alphanumeric/dash/underscore
only), `type` (one of the four step types), `dependsOn` (array of other
step keys), `config` (a free-form object specific to that step type), and
`maxRetries` (defaults to 3). This file only validates _shape_ — "is this
JSON structurally a valid DAG object" — not _graph correctness_ (cycles,
dangling references), which is handled separately in `dag/validate.ts`, on
purpose: shape validation and graph-correctness validation are different
concerns with different failure modes, and keeping them separate makes each
one simpler to read, test, and reuse.

### 9.5 `src/dag/validate.ts`

The graph-correctness validator. Given a DAG that has already passed shape
validation, this function checks, in order: (1) no two steps share the same
`key`; (2) every `dependsOn` reference points at a key that actually exists
in this DAG; (3) no step depends on itself; and (4) **no cycles exist**,
using **Kahn's algorithm** — a standard graph algorithm that repeatedly
removes nodes with no remaining unresolved dependencies, tracking how many
nodes get removed. If, at the end, fewer nodes were removed than exist in
the graph, the remainder must be involved in a cycle (a cycle can never be
resolved by "remove nodes with zero remaining dependencies," so those nodes
never get added to the removal queue). As a _side effect_, this function
also returns a valid **topological execution order** for the DAG — a
sequencing of steps such that every dependency appears before its
dependents. This same function is later reused conceptually by the worker's
readiness-check logic, so the definition of "is this DAG valid, and what
order can it run in" exists in exactly one place, never duplicated or
allowed to drift.

### 9.6 `src/lib/prisma.ts`

A singleton Prisma client. In development, `tsx watch` hot-reloads the
module on every file save; without a singleton, each reload would create a
brand new database connection pool, and repeated saves would eventually
exhaust Postgres's connection limit. The singleton is stashed on
`globalThis` specifically so it survives module reloads in dev, while still
being a fresh instance in production (where there's no hot-reloading to
worry about).

### 9.7 `src/lib/redis.ts`

A singleton `ioredis` client used for general-purpose commands (rate-limit
counters, etc.). Deliberately **not** the same connection instance used for
Redis Streams consumption or Pub/Sub subscriptions elsewhere in the
codebase — Redis connections in "subscribe" mode, or blocking-read mode,
cannot run ordinary commands concurrently, so mixing connection purposes is
a common source of subtle bugs this project avoids by simply never doing it.

### 9.8 `src/lib/logger.ts`

A `pino` logger instance. Emits structured JSON in production; in
development, pipes through `pino-pretty` for human-readable colorized
console output. Every other file that logs imports this one shared
instance, so logging configuration (level, format) is controlled from a
single place.

### 9.9 `src/lib/redisStreams.ts`

Contains `publishRunTriggered()`, the _only_ function in the whole codebase
that writes to the `workflow-events` Redis Stream. Deliberately publishes a
**thin event** — just `runId`, `workflowId`, `tenantId` — never the full
run/DAG payload. This is intentional: because workers always re-read
current state from Postgres before acting (Section 5.2, point 3), the event
itself can be arbitrarily stale, duplicated, or replayed without ever
causing incorrect behavior. The event's only job is "wake up and go look,"
not "here is the data to act on."

### 9.10 `src/lib/pubsubChannels.ts`

A one-function file: `runUpdateChannel(runId)` returns the Redis Pub/Sub
channel name for a given run (`run:<id>:events`). This function is
duplicated verbatim in both `api/` and `worker/` specifically so the two
services can never accidentally drift into using different channel-naming
conventions and silently fail to talk to each other.

### 9.11 `src/metrics/registry.ts`

Defines every Prometheus metric the API exposes, using `prom-client`, on a
**dedicated registry** (not the global default one) so importing this
module multiple times — as happens in tests — never causes "metric already
registered" errors. See Section 15.1 for what each metric measures and why.

### 9.12 `src/middleware/requestId.ts`

Attaches a correlation ID (`req.requestId`) to every incoming request —
either read from an incoming `X-Request-Id` header (if this API is ever
called by another internal service that already has one) or freshly
generated with `crypto.randomUUID()`. Echoed back as a response header and
threaded into every log line for that request via `pino-http`'s
`customProps`. This is what lets a specific request's full behavior be
traced by grep-ing logs for one ID, across every file involved in handling
it.

### 9.13 `src/middleware/metrics.ts`

Records an HTTP request's outcome into the Prometheus counters/histograms
defined in `metrics/registry.ts`. Critically, it labels each request by
`req.route.path` (the **matched route pattern**, e.g.
`/api/v1/workflows/:id`) rather than the raw URL — using the raw URL would
mean every distinct workflow UUID ever requested becomes its own metric
label, which is a classic Prometheus "cardinality explosion" mistake that
can make a metrics backend unusably slow or expensive at scale.

### 9.14 `src/middleware/authenticate.ts`

Reads the `Authorization: Bearer <token>` header, verifies it as a JWT
access token, and attaches the decoded payload (`userId`, `tenantId`,
`role`) to `req.auth`. Every route that needs to know "who is making this
request" reads from `req.auth`, never re-parsing the token itself — this
middleware is the single choke point through which authentication happens,
so it's impossible for a route to accidentally skip auth by parsing the
token differently or forgetting a check.

### 9.15 `src/middleware/rbac.ts`

Implements `requireRole(minRole)`. Roles form a hierarchy —
`VIEWER (0) < MEMBER (1) < ADMIN (2)` — so `requireRole("MEMBER")` also
allows an `ADMIN` through, matching how real role-based systems typically
behave (permissions are additive up the hierarchy, not siloed by exact
role match). Returns `401` if there's no authenticated user at all, `403`
if the user's role is below the required level.

### 9.16 `src/middleware/rateLimit.ts`

A per-tenant token-bucket rate limiter implemented directly with Redis
`INCR` + `EXPIRE`. Each tenant gets its own counter key
(`ratelimit:tenant:<id>`), so one noisy tenant can never exhaust another
tenant's request budget. Critically, **it fails open**: if Redis is
briefly unreachable when checking the limit, the request is allowed through
(with the error logged) rather than rejected. The reasoning: rate limiting
exists to prevent abuse, not to guarantee correctness — letting a transient
Redis blip take down the entire API's availability, just to strictly
enforce an anti-abuse policy, is the wrong tradeoff for this system.

### 9.17 `src/middleware/validate.ts`

A generic factory, `validateBody(schema)`, that wraps any `zod` schema into
Express middleware: parses `req.body` against the schema, and if it fails,
responds `400` with a structured list of field errors; if it succeeds,
replaces `req.body` with the _parsed and typed_ result. Every route that
accepts a body uses this instead of hand-rolled `if (!req.body.x)` checks.

### 9.18 `src/routes/auth.ts`

Five endpoints:

- **`POST /register`** — creates a brand-new tenant plus its first user
  (as `ADMIN`), inside a single database transaction (so a failure partway
  through never leaves an orphaned tenant with no users, or vice versa).
- **`POST /login`** — verifies email + password (bcrypt comparison), issues
  a fresh access + refresh token pair.
- **`POST /refresh`** — implements **refresh token rotation** (full
  explanation in Section 16.2): verifies the refresh token, checks it
  against the user's current `tokenVersion`, then issues a _new_ pair and
  increments `tokenVersion`, invalidating every refresh token issued before
  this moment.
- **`POST /logout`** — increments `tokenVersion`, immediately invalidating
  any outstanding refresh tokens (access tokens remain valid until their
  short natural expiry, a documented tradeoff).
- **`GET /me`** — returns the current authenticated user's profile.

### 9.19 `src/routes/workflows.ts`

Full CRUD for workflow definitions, every route tenant-scoped (a query is
never allowed to return or modify a row belonging to a different tenant)
and RBAC-protected at different strictness levels: `VIEWER`+ can read,
`MEMBER`+ can create/update, `ADMIN`-only can delete (a stricter bar for a
destructive action than for creation — a deliberate, defensible choice).
`POST` and `PUT` both run the submitted DAG through `validateDagStructure()`
(Section 9.5) before ever writing it to the database — an invalid DAG is
rejected with `400` and a specific error message (e.g. "cycle detected
involving step(s): a, b") and never gets as far as being persisted.

### 9.20 `src/routes/runs.ts`

Three endpoints:

- **`POST /workflows/:id/trigger`** — loads the workflow, creates a `Run`
  row plus one `Step` row per DAG node (all `PENDING`, all inside one
  transaction), then publishes the trigger event to Redis Streams. Returns
  `202 Accepted` (not `200` or `201`) because the work hasn't happened yet
  — only been _accepted for later processing_, which is the semantically
  correct HTTP status for "this has been queued."
- **`GET /runs/:id`** — current run status.
- **`GET /runs/:id/steps`** — every step's current status, for the
  dashboard's live view.
- **`POST /runs/:id/replay`** — resets every `DEAD_LETTER` step in a run
  back to `PENDING` (clearing its error, attempt count, and backoff
  timestamp), flips the run back to `RUNNING`, and republishes a trigger
  event. Notably requires **no special handling for steps downstream of the
  replayed one** — they're already sitting in `PENDING`, blocked on their
  dependency, so the normal readiness check picks them up automatically
  the instant the replayed step succeeds.

### 9.21 `src/ws/gateway.ts`

The WebSocket server. Full behavioral explanation in Section 14.

### 9.22 `src/utils/jwt.ts`, `src/utils/password.ts`, `src/utils/validation.ts`

Small, focused utility modules: signing/verifying access and refresh JWTs;
hashing and comparing passwords with `bcryptjs`; and the `zod` schemas used
specifically by the auth routes (register/login/refresh request shapes).

### 9.23 `src/types/express.d.ts`

An ambient TypeScript declaration that extends Express's own `Request`
interface with a `requestId: string` and `auth?: AccessTokenPayload` field,
so the rest of the codebase can write `req.auth.tenantId` with full type
safety instead of casting or using `any`.

---

## 10. The Worker Service — File by File

Location: `worker/`. This is a pure background process — it has no HTTP
API for end users (only a tiny `/metrics` and `/health` endpoint for
Prometheus). Its entire job is: consume trigger events, figure out what's
ready to run, run it, and record the outcome.

### 10.1 `src/index.ts`

The main loop. On startup: starts the metrics HTTP server (Section 15.2),
opens a dedicated Redis connection for stream consumption, and ensures the
`pulsequeue-workers` consumer group exists (creating it, and the stream
itself, if this is a totally fresh environment). Then loops forever until
told to shut down (`SIGTERM`/`SIGINT`):

1. **Blocks** (up to 5 seconds) waiting for new events via
   `XREADGROUP ... BLOCK 5000`.
2. For each event received, calls `processRun()` (Section 10.6) and, if it
   succeeds, acknowledges the event (`XACK`) so it's never redelivered. If
   processing throws, the event is deliberately **left un-acknowledged** —
   it will reappear in the stream's pending-entries list for later recovery
   or manual replay, rather than silently disappearing.
3. **Every single loop iteration — including iterations where the 5-second
   block timed out with zero new events** — also checks Postgres directly
   for any run with a step whose retry backoff window has just elapsed
   (`findRunsWithDueRetries()`, Section 10.7) and processes those too. This
   exists because a step scheduled to retry in 30 seconds has no future
   stream event to wake anyone up — Redis Streams only notify on _new_
   events, not on the passage of time — so the worker also polls Postgres
   itself as a fallback wake-up mechanism.
4. Refreshes the Prometheus queue-depth gauge from a fast Postgres count
   query.

Graceful shutdown: on `SIGTERM`/`SIGINT`, sets a flag that lets the current
iteration finish before exiting, rather than abruptly killing in-flight work.

### 10.2 `prisma/schema.prisma`

An intentional **copy** of `api/prisma/schema.prisma`. See Section 23 for
the full explanation of why this duplication exists and what the
alternative (a shared package) would look like at larger scale.

### 10.3 `src/lib/streams.ts`

Everything related to being a Redis Streams **consumer**: creating the
connection (with `maxRetriesPerRequest: null`, required for the blocking
`XREADGROUP` call to behave correctly), ensuring the consumer group exists,
reading the next batch of events (using `">"` as the special ID, meaning
"only messages never delivered to any consumer in this group before" — real
new work, not redelivery), and acknowledging processed events.

### 10.4 `src/lib/claimSteps.ts`

The heart of the concurrency-safety story. Two functions:

**`computeReadyStepKeys(dag, steps)`** — pure, side-effect-free logic (no
database access) that, given a workflow's DAG definition and the current
status of every step in a run, returns the keys of steps that are ready to
execute _right now_. A step is ready if its status is `PENDING`, or it's
`RETRYING` with its backoff window already elapsed, **and** every step it
depends on has status `SUCCEEDED`. Being pure makes this function trivially
unit-testable without any database — Section 17 describes the tests that
lock down its exact behavior for fan-out, fan-in, and blocked-by-failure
scenarios.

**`claimSteps(prisma, runId, stepKeys)`** — the function that actually talks
to Postgres, using a single raw SQL query inside a transaction:

```sql
SELECT id FROM steps
WHERE run_id = $1 AND step_key = ANY($2)
  AND (status = 'PENDING' OR (status = 'RETRYING' AND next_attempt_at <= NOW()))
FOR UPDATE SKIP LOCKED
```

Full explanation of why this exact SQL pattern matters in Section 13.

### 10.5 `src/lib/backoff.ts`

`computeBackoffMs(attempt, baseMs, capMs)` implements **exponential backoff
with full jitter** — the delay formula commonly recommended for retrying
against a service that may be under stress:
`random(0, min(cap, base * 2^attempt))`. The randomization matters: with a
fixed (non-jittered) exponential delay, if 100 steps fail at the same
instant (e.g. a downstream API has an outage), all 100 would retry at the
exact same instant again, hammering the already-struggling service with a
synchronized burst — a "thundering herd." Spreading retries randomly within
the backoff window avoids this.

### 10.6 `src/lib/runProcessor.ts`

Orchestrates one run from wherever it currently is toward completion.
`processRun(prisma, runId)`:

1. Loads the run and its workflow (for the DAG definition).
2. If the run is still `PENDING`, flips it to `RUNNING`.
3. Loops: compute ready steps → claim them → execute each one
   (`executeAndTransition`) → loop again (since a step succeeding may have
   just unblocked new steps) → stop once nothing is claimable right now.
4. Calls `finalizeRunStatus()`, which checks whether every step has reached
   a terminal state (`SUCCEEDED`, `FAILED`, or `DEAD_LETTER`); if so, marks
   the run `SUCCEEDED` (all steps succeeded) or `FAILED` (at least one
   didn't).

`executeAndTransition(prisma, step, maxRetries)` is where a single step's
outcome is decided:

- On success: step → `SUCCEEDED`, Prometheus success counter incremented,
  a Pub/Sub update published.
- On a **permanent** error, or a **retryable** error with no attempts left:
  step → `DEAD_LETTER`, with the reason (permanent vs. exhausted) recorded
  as a metric label.
- On a **retryable** error with attempts remaining: step → `RETRYING`,
  `nextAttemptAt` set to now + a computed backoff delay.

Every transition publishes a Pub/Sub update (so the dashboard reflects it
live) and records a duration/outcome in the step-execution-duration
histogram.

### 10.7 `src/lib/sweep.ts`

`findRunsWithDueRetries(prisma)` — a single query joining `steps` and
`runs` to find every run that has at least one `RETRYING` step whose
backoff window has already elapsed, restricted to runs still `RUNNING`.
Called on every main-loop iteration (Section 10.1) as the fallback
"wake up and check anyway" mechanism for retries.

### 10.8 `src/lib/publish.ts`

`publishStepUpdate()` and `publishRunUpdate()` — the _only_ two functions
in the codebase that write to the `run:<id>:events` Redis Pub/Sub channel.
Both are deliberately **fire-and-forget**: wrapped in a try/catch that
swallows any error, because a failed notification should never be allowed
to fail the actual database state transition it's describing — the
database row is always the real source of truth; Pub/Sub is a best-effort
convenience layer on top of it.

### 10.9 `src/lib/costEstimate.ts`

`estimateCostUsd(model, usage)` — converts an LLM API call's token usage
into an approximate US-dollar cost, using a small per-model pricing table
(with a sane default for unrecognized models). Attached to every
`AI_ENRICHMENT` step's output. This exists because knowing an AI-powered
step _works_ isn't enough operationally — a platform team also needs to
know what it _costs_, the same way any other resource-consuming operation
would be tracked.

### 10.10 `src/executors/` — the four step implementations

Every executor implements the same interface: given a step's config,
return `{ output }` on success, or throw either a `RetryableExecutionError`
(network blips, 5xx responses, timeouts) or a `PermanentExecutionError`
(a 4xx bad request, invalid configuration) — an explicit, typed way for an
executor to declare its own failure semantics, rather than the run
processor trying to guess from an error message string.

- **`http.ts`** — makes an outbound HTTP request as configured. Classifies
  5xx and network-level errors as retryable, 4xx as permanent (retrying an
  identical "bad request" can never succeed). Sends the step's
  `idempotencyKey` as a header, so a well-behaved downstream API can dedupe
  on its side too if a request is ever retried after a response was
  actually received but lost in transit.
- **`script.ts`** — **deliberately does not execute arbitrary code**. A
  workflow's DAG definition is attacker-controlled input in any real
  multi-tenant product; letting it run arbitrary "scripts" would build a
  remote-code-execution vector directly into the platform. Instead,
  `SCRIPT` steps select from a small, fixed registry of pure data-transform
  functions: `uppercase`, `lowercase`, `extractField`, `jsonStringify`,
  `merge`. This is a deliberate security boundary, documented in the code
  itself — see Section 16.4 for the full reasoning.
- **`aiEnrichment.ts`** — calls the real Anthropic API (if
  `ANTHROPIC_API_KEY` is set), tracking latency and estimated cost. If no
  key is configured, returns a clearly-labeled mock result instead of
  failing, so the whole pipeline remains functional without requiring a
  paid API key.
- **`webhook.ts`** — a fire-and-notify `POST` to an external URL. Kept as a
  separate step type from `HTTP` even though the underlying mechanics are
  similar, because the _intent_ differs: `HTTP` steps fetch or mutate data
  as part of the pipeline's actual logic; `WEBHOOK` steps exist purely to
  notify something external that a run reached a point. Keeping them
  separate means webhook-specific behavior (like request signing) could
  evolve later without touching the general-purpose HTTP executor.
- **`index.ts`** — the dispatch table mapping a step's `type` string to its
  executor function.

### 10.11 `src/metrics/registry.ts` and `src/metrics/server.ts`

The worker's own Prometheus metrics (Section 15.1) and a minimal
`http.createServer`-based `/metrics` + `/health` endpoint — deliberately
_not_ using Express here, since pulling in a full web framework for one
route in a process that otherwise never serves HTTP would be an
unnecessary dependency.

---

## 11. The Frontend — File by File

Location: `frontend/`. A React + TypeScript single-page application, built
with Vite and styled with Tailwind CSS plus a small hand-written CSS file
of design tokens. Served in production as static files via nginx.

### 11.1 Design decisions

The visual design is a deliberate **dark "operational dashboard" aesthetic**
— near-black background (`#0a0d12`), a teal "pulse" accent color
(`#2dd4bf`, a direct reference to the product's name), and four distinct
semantic status colors (gray/pending, teal/running, amber/retrying,
green/succeeded, red/failed) rather than one single decorative accent
color. Data-shaped values — run IDs, step keys, status badges, timestamps —
render in a **monospace font** (IBM Plex Mono), while UI chrome (buttons,
labels, navigation) uses a humanist sans-serif (Inter). This pairing is a
deliberate signal: "this is real infrastructure data," not a decorated
consumer product. The one animated flourish in the whole interface is a
**pulsing status dot** next to any `RUNNING` step — two radiating rings
that expand and fade, built with plain CSS keyframes, and disabled entirely
if the browser reports `prefers-reduced-motion`.

### 11.2 `src/main.tsx`

The React entrypoint — mounts the `App` component into the page's root DOM
node.

### 11.3 `src/App.tsx`

Defines client-side routing with `react-router-dom`: `/login`, `/register`
are public; `/`, `/workflows/new`, `/runs/:id` are wrapped in
`ProtectedRoute` (Section 11.7), which redirects to `/login` if there's no
valid session.

### 11.4 `src/lib/api.ts`

A thin `fetch`-based API client. The single most important piece of logic
here is **automatic refresh-token handling**: every request first checks if
the stored access token has expired (or is about to); if so, it silently
calls `/api/v1/auth/refresh` _once_ to get a new pair before retrying the
original request. If the refresh itself fails (refresh token also expired
or revoked), the user is redirected to log in again. This mirrors the
backend's refresh-rotation design (Section 16.2) exactly, and means a user
never sees a confusing "please log in again" in the middle of normal usage
— only when their session has genuinely and fully expired.

### 11.5 `src/lib/AuthContext.tsx`

A React Context providing `user`, `login()`, `register()`, and `logout()`
to the whole component tree, backed by tokens stored in `localStorage`.

### 11.6 `src/lib/types.ts`

Shared TypeScript types mirroring the API's response shapes (`Workflow`,
`Run`, `Step`, etc.), so every page gets full type-checking on the data it
receives, without duplicating type definitions across files.

### 11.7 `src/components/ProtectedRoute.tsx`

A wrapper component: if there's no authenticated user, redirect to
`/login`; otherwise render the requested page. Centralizes the
"is this route allowed" check in one place instead of repeating it in
every page component.

### 11.8 `src/components/Nav.tsx`

The top navigation bar: product name/logo, and (when logged in) the current
user's email and a logout button.

### 11.9 `src/pages/LoginPage.tsx` and `RegisterPage.tsx`

Simple forms calling `AuthContext`'s `login()`/`register()`. Registration
additionally asks for a tenant/organization name, since registering creates
a brand-new tenant (Section 9.18).

### 11.10 `src/pages/WorkflowsListPage.tsx`

Fetches and displays the current tenant's workflows as a card grid, each
card showing the workflow's name, step count, and step-type chips (colored
by type). Each card links to a page where it can be triggered, or to that
workflow's most recent run.

### 11.11 `src/pages/WorkflowCreatePage.tsx`

A form for defining a new workflow: a name field, and a raw JSON textarea
for the DAG definition (a visual drag-and-drop DAG builder is a natural
future enhancement, noted in Section 24) — pre-filled with a working
three-step example so a first-time user can see valid DAG syntax
immediately rather than starting from a blank textarea.

### 11.12 `src/pages/RunDetailPage.tsx`

The most important page in the application — the live dashboard. On
mount, opens a WebSocket connection to
`/ws/runs?token=<accessToken>&runId=<runId>`, and:

1. On connection, receives a `{ type: "connected" }` acknowledgment.
2. As `step.updated` and `run.updated` messages arrive (published by the
   worker, relayed by the API's gateway), merges them into local React
   state — so the step list and run status update **instantly**, with no
   polling and no manual refresh.
3. Shows a small "● live" / "○ disconnected" indicator reflecting the
   actual WebSocket connection state.
4. Renders each step as a row: a status dot (pulsing if `RUNNING`), the
   step's key (monospace), its type, attempt count, and — if it failed —
   its error message.
5. Shows a **"Replay dead-lettered steps"** button, but only when there is
   at least one `DEAD_LETTER` step to replay — the button's very presence
   is itself informative.

### 11.13 `src/index.css`

Hand-written CSS defining the design tokens described in Section 11.1:
color variables, the `.status-dot`/`.status-badge` classes for each of the
five step statuses, the pulse-ring keyframe animation, and layout classes
for the nav bar, cards, forms, and step list. Tailwind utility classes are
available and used for minor layout adjustments, but the core visual
identity lives in this file rather than being assembled purely from
Tailwind defaults.

### 11.14 `Dockerfile` and `nginx.conf`

A two-stage Docker build: stage one runs `npm run build` to produce static
HTML/CSS/JS; stage two copies only those static files into an `nginx`
image. `nginx.conf` includes a **SPA fallback** (`try_files $uri $uri/
/index.html`) — without this, a hard browser refresh on a client-side
route like `/runs/abc123` would 404 at the nginx level, since no such file
actually exists on disk; the fallback ensures nginx always serves
`index.html` and lets React Router take over from there.

---

## 12. The DAG Workflow Engine Explained

A **workflow** is defined once as a template: a name plus a DAG
(Directed Acyclic Graph) of steps. Each step declares which other steps (by
key) must complete successfully before it can start. This is exactly the
same mental model as a build system's task dependency graph, or a CI
pipeline's job dependencies.

**Validation happens in two layers, deliberately kept separate:**

1. **Shape validation** (`dag/schema.ts`, using `zod`) — is this JSON even
   structurally a valid DAG object? Does every step have a key, a
   recognized type, an array of dependency keys?
2. **Graph-correctness validation** (`dag/validate.ts`) — given a
   structurally valid DAG, is the _graph itself_ sound? No duplicate keys,
   no dependency pointing at a step that doesn't exist, no step depending
   on itself, and critically, **no cycles** (verified with Kahn's
   algorithm, explained in Section 9.5).

Both checks run **at workflow creation/update time**, before anything is
ever written to the database. This means an invalid workflow can never
exist in the system at all — the worker, when it later reads a workflow's
DAG to decide execution order, can trust it's always valid without
re-checking, because there's no code path that could have written a broken
one.

**Execution order** is determined dynamically at runtime, not fixed at
creation time: a step becomes "ready" the moment all of its dependencies
have succeeded, and multiple independent branches of the DAG can execute
concurrently (a "fan-out"), later converging when a downstream step depends
on several of them (a "fan-in"). This is genuinely more flexible than a
strictly linear pipeline — for example, an `HTTP` fetch and an unrelated
`WEBHOOK` notification could run in parallel if neither depends on the
other, and a final `notify` step could wait on both.

---

## 13. The Execution Engine: Claiming, Retries, Dead-Lettering

### 13.1 Why claiming needs to be atomic

When a workflow is triggered, a run and its steps are created, and multiple
worker replicas (in a scaled deployment) all wake up on the same event.
Every one of them independently computes "which steps are ready right
now" — and without extra care, two or more workers could compute the exact
same answer and both try to execute the exact same step, corrupting state
or wasting work (or, for a non-idempotent action like sending an email,
literally sending it twice).

### 13.2 The fix: `SELECT ... FOR UPDATE SKIP LOCKED`

PulseQueue solves this with a single SQL pattern, run inside a database
transaction:

```sql
SELECT id FROM steps
WHERE run_id = $1 AND step_key = ANY($2)
  AND (status = 'PENDING' OR (status = 'RETRYING' AND next_attempt_at <= NOW()))
FOR UPDATE SKIP LOCKED
```

`FOR UPDATE` tells Postgres "lock every row this query returns, for the
duration of this transaction — no other transaction may modify or
re-lock them until I commit." `SKIP LOCKED` is the crucial addition:
instead of a second worker's identical query **blocking**, waiting for the
first worker's lock to release (which would serialize workers for no
reason, and in the worst case risk a deadlock), the second worker's query
simply **skips** any row that's already locked and returns whatever's left
unlocked. The net effect: if three workers race to claim five ready steps,
each one gets a genuinely different, non-overlapping subset — with zero
explicit coordination code, no distributed lock service, and no Redis-based
mutex. Postgres's own row-locking, used correctly, is the entire
coordination mechanism.

Immediately after claiming, the worker updates those rows to `RUNNING` and
increments their attempt count — all inside the same transaction as the
claim itself, so the "I have claimed this" and "this is now marked running"
states can never disagree.

### 13.3 Retry classification: retryable vs. permanent

When a step's executor throws, it throws one of two distinct, explicitly
typed errors: `RetryableExecutionError` (network blips, HTTP 5xx, timeouts
— things likely to succeed if tried again shortly) or
`PermanentExecutionError` (an HTTP 4xx, invalid configuration — things that
will _never_ succeed no matter how many times they're retried). This
distinction is made by the executor itself, which is the only code that
actually knows what kind of failure just happened — the run processor
never has to guess from an error message.

### 13.4 Exponential backoff with full jitter

A retryable failure with attempts remaining moves the step to `RETRYING`
and sets `nextAttemptAt` to `now + computeBackoffMs(attemptCount)`, where
the delay is `random(0, min(cap, base * 2^attempt))` — a randomized delay
that grows exponentially with each attempt, capped at a maximum (60
seconds by default). The randomization ("jitter") specifically prevents a
"thundering herd": if a downstream service goes down and causes a hundred
steps to fail at the same instant, a _non_-jittered exponential backoff
would have all hundred retry at the exact same instant again, hammering the
already-struggling service with a synchronized spike. Random jitter spreads
those retries out across the whole backoff window.

### 13.5 Dead-lettering and replay

A step is moved to `DEAD_LETTER` — its final, non-retrying failure state —
either immediately (a permanent error) or once its retry budget is
exhausted. This is deliberately distinct from simply "failing forever
silently": a dead-lettered step is visible in the dashboard with its error
message, and can be explicitly **replayed** via
`POST /runs/:id/replay`, which resets it to `PENDING` (clean attempt count,
no error, no backoff timestamp) and re-triggers the worker. Any steps
downstream of it need no special handling — they were already sitting in
`PENDING`, blocked on this dependency, and pick up automatically the moment
the replayed step succeeds.

### 13.6 A step scheduled to retry has no future event — the "sweep"

Redis Streams only notify workers of _new_ events, never of the passage of
time. A step scheduled to retry in 30 seconds therefore has nothing that
will "wake up" a worker when that 30 seconds elapses — so every worker
also directly polls Postgres, on every iteration of its main loop
(including iterations where the stream read timed out with zero new
events), for any run with a step whose backoff window has just elapsed
(`findRunsWithDueRetries`). This is a subtle but important piece of the
design that is easy to overlook on a first pass at the problem.

---

## 14. Real-Time Updates: WebSockets & Redis Pub/Sub

### 14.1 The connection lifecycle

A browser opens a WebSocket to `/ws/runs?token=<accessToken>&runId=<id>`.
Because browsers cannot set custom HTTP headers on a WebSocket handshake,
the access token travels as a **query parameter** instead of an
`Authorization` header — a common, documented tradeoff (Section 23) rather
than an oversight. The gateway (`api/src/ws/gateway.ts`):

1. Parses the token and `runId` from the connection URL.
2. Verifies the JWT exactly as the REST `authenticate` middleware does.
3. **Checks tenant ownership** — queries Postgres to confirm this run
   actually belongs to the connecting user's tenant, so a user can never
   subscribe to another tenant's run even by guessing a valid-looking run
   ID.
4. Registers the browser's WebSocket connection in an in-memory map, keyed
   by `runId`.

### 14.2 The relay mechanism

The gateway maintains exactly **one** shared Redis subscriber connection
for the entire API process (not one per connected browser — Redis
subscriber connections are relatively expensive, and opening one per
browser tab would not scale), using `PSUBSCRIBE("run:*:events")` — a
pattern subscription matching every run's channel at once. When a message
arrives on any matching channel, the gateway looks up which browsers (if
any) are currently subscribed to that specific `runId` and forwards the
message only to them. This keeps Redis connection count at a small,
constant number regardless of how many users have a dashboard open.

### 14.3 What the worker actually publishes

Every step state transition (`SUCCEEDED`, `RETRYING`, `DEAD_LETTER`) and
every run finalization (`SUCCEEDED`/`FAILED`) triggers a publish to that
run's channel, carrying the updated row's data as JSON. The frontend
merges these messages into its local state as they arrive — there is no
polling anywhere in this flow.

---

## 15. Observability: Prometheus, Grafana, Structured Logs

### 15.1 What's actually measured

**On the API:**

- `pulsequeue_http_requests_total` — a counter, labeled by method/route/
  status.
- `pulsequeue_http_request_duration_seconds` — a histogram of request
  latency, same labels.
- `pulsequeue_ws_connections_active` — a gauge tracking how many browsers
  currently have a live dashboard open.

**On the worker:**

- `pulsequeue_steps_claimed_total`, `_succeeded_total`, `_retried_total`,
  `_dead_lettered_total` — counters, labeled by step type (and, for
  dead-lettering, by _reason_: permanent vs. retries-exhausted).
- `pulsequeue_step_execution_duration_seconds` — a histogram of how long
  each step attempt takes, labeled by type and outcome.
- `pulsequeue_runs_finalized_total` — labeled by final status.
- `pulsequeue_queue_depth` — a **gauge** (a point-in-time snapshot, not a
  monotonic counter) of how many steps are currently `PENDING` or
  `RETRYING` across the whole system. This is the single most operationally
  useful metric in the project: it's the number an operator would alert on
  to decide whether more worker replicas are needed.

Both services also expose Node.js's default process metrics (CPU, memory,
event loop lag) via `prom-client`'s built-in collector.

### 15.2 How scraping works

The API exposes `/metrics` on its normal port (4000); the worker, having no
other reason to run an HTTP server, runs a minimal one (built on Node's
raw `http` module, no Express) just for `/metrics` and `/health`, on port 9100. Prometheus (configured in `monitoring/prometheus.yml`) scrapes both
every 5 seconds. **A known, documented limitation:** if the worker is
scaled to multiple replicas (`docker compose up --scale worker=3`),
Prometheus's single static target (`worker:9100`) only ever reaches one
replica, because Docker's internal DNS round-robins the hostname across
replicas rather than exposing each one individually. A production
deployment would use proper service discovery (Kubernetes pod-level
scraping, Consul, or similar) to solve this — a limitation documented
explicitly in both the Prometheus config's own comments and here, rather
than left implicit.

### 15.3 Grafana

Grafana is fully **provisioned** — meaning it configures itself
automatically from files on startup rather than requiring manual
configuration through its UI. `monitoring/grafana/provisioning/datasources/`
points it at Prometheus automatically; `monitoring/grafana/provisioning/dashboards/`
tells it to auto-load the dashboard JSON in `monitoring/grafana/dashboards/`.
That dashboard has seven panels: queue depth, step execution latency
(p50/p95/p99), step throughput, run outcomes, API request rate, API request
latency, and active WebSocket connections.

### 15.4 Structured logging and correlation

Every log line is a JSON object (via `pino`), not a free-text string —
machine-parseable, and consistent in shape. Every API request carries a
`requestId` (generated or propagated from an incoming `X-Request-Id`
header) attached to every log line produced while handling it. Every
worker log line involving a step or run carries that step's/run's ID.
Together, this means a single failure can be traced end-to-end: given one
correlation ID, every log line touching a specific request, across both
services, can be found — without this, debugging a distributed system
means guessing which of potentially many concurrent requests a given log
line belongs to.

---

## 16. Security Model

### 16.1 Password storage

Passwords are never stored in plaintext or with a fast, reversible hash —
`bcryptjs` with a cost factor of 10 is used, a deliberately _slow_ hashing
algorithm designed specifically to make brute-force attacks on stolen
password hashes computationally expensive.

### 16.2 JWT access + refresh tokens, with rotation

Two tokens are issued on login: a short-lived **access token** (15 minutes)
carrying `userId`/`tenantId`/`role`, used to authenticate every API
request; and a longer-lived **refresh token** (7 days), used only to obtain
new access tokens without forcing the user to log in again. Every `User`
row has a `tokenVersion` integer. Every refresh **both** issues a new
token pair **and** increments `tokenVersion` — which means the _previous_
refresh token (which was signed with the old `tokenVersion` embedded in it)
immediately becomes invalid, because the server compares the token's
embedded version against the user's current one and rejects a mismatch.
The practical effect: if a refresh token is ever stolen, it becomes useless
the moment the legitimate user's client refreshes again — an attacker with
a stolen refresh token has, at most, until the legitimate user's next
normal usage to exploit it, not the full 7-day lifetime.

### 16.3 Multi-tenancy and RBAC

Every piece of tenant-owned data (workflows, runs, steps transitively) is
filtered by the requesting user's `tenantId` on every single read and
write — there is no code path that returns data without this filter. Roles
form a hierarchy (`VIEWER < MEMBER < ADMIN`); destructive actions
(deleting a workflow) require `ADMIN`, a deliberately stricter bar than
creating or triggering one (`MEMBER`).

### 16.4 Why `SCRIPT` steps don't run arbitrary code

A workflow's DAG definition — including any `SCRIPT` step's configuration
— is, in any real multi-tenant product, **attacker-controlled input**: it's
data submitted by a user, not code written by the platform's own
developers. If `SCRIPT` steps executed arbitrary code (via `eval()`, a
child process, or an unsandboxed VM context), the platform would be
building a remote-code-execution vector directly into itself — any user
could submit a "workflow" that's actually a payload to read the server's
filesystem, environment variables, or pivot to other infrastructure.
Instead, `SCRIPT` steps select from a small, fixed **registry** of pure,
safe data-transform functions. This is a deliberate scope limitation, not a
missing feature: safely supporting genuinely arbitrary user-submitted code
is a real engineering problem in its own right, solved in practice with
technologies like Firecracker/gVisor microVMs or WASM runtimes with no host
syscall access — both well beyond this project's current scope.

### 16.5 Rate limiting

Per-tenant, Redis-backed, fails open on Redis errors (Section 9.16) —
availability was prioritized over strict enforcement of an anti-abuse
policy, a deliberate and defensible tradeoff.

### 16.6 Metrics endpoints are unauthenticated

Both `/metrics` endpoints are reachable without a token. This mirrors the
standard real-world pattern: metrics endpoints are typically protected by
**network isolation** (not exposed outside an internal network or
Kubernetes cluster) rather than by application-level authentication. This
is safe in this project's Docker Compose setup, where Prometheus reaches
these endpoints over the internal Docker network, not the public internet
— but it depends on that assumption holding in any given deployment
environment, and should be verified explicitly rather than assumed.

---

## 17. Testing Strategy

Testing is deliberately split into two layers with very different
purposes, kept in separate configurations so they can never accidentally
mix.

### 17.1 Unit tests (31 total, run in under two seconds, zero external dependencies)

Run with `npm test` in `api/` or `worker/`. Cover pure logic only:

- **DAG cycle detection** (`api`) — linear chains, diamond fan-out/fan-in,
  direct cycles, indirect cycles, self-references, dangling references,
  duplicate keys (7 tests).
- **RBAC role hierarchy** (`api`) — ADMIN passes a MEMBER-gated check,
  VIEWER is blocked from one, unauthenticated requests are rejected
  (3 tests).
- **Metrics registry** (`api` and `worker`) — expected metric names are
  registered, counters/gauges behave correctly (6 tests total).
- **Step dependency readiness** (`worker`) — fan-out, fan-in, blocked-by-
  failure, and retry-backoff-timing scenarios for `computeReadyStepKeys`
  (8 tests).
- **Exponential backoff bounds** (`worker`) — never negative, respects the
  cap, grows with attempt number (3 tests).
- **AI cost estimation** (`worker`) — known model pricing, unknown-model
  fallback, linear scaling with token count, missing-usage null handling
  (4 tests).

These tests require no database, no Redis, no network — they run
identically anywhere Node is installed, and are meant to run on every
single save during development.

### 17.2 The integration test (a genuinely different class of test)

Run with `npm run test:integration` in `api/`, and requires a **real**
Postgres, Redis, and a **real running worker process** — it is not mocked
in any way. Using `supertest`, it drives the actual Express `app` (Section
9.1) through a full lifecycle: register → create a workflow → trigger it →
poll `GET /runs/:id` until the real worker moves it to `SUCCEEDED` →
verify the step's actual output. It also verifies a cyclic DAG is rejected
with `400` before ever reaching a worker, and that a second, separately
registered tenant genuinely cannot see the first tenant's workflows.

This test exists because unit tests, no matter how thorough, structurally
**cannot** catch an entire category of real bugs: a route mounted at the
wrong path, an environment variable name that doesn't match between the
API and worker, a Prisma migration that has drifted from the schema file,
or a Redis channel name typo between publisher and subscriber. Only
actually running the whole system together catches those.

### 17.3 Load testing

`load-test/trigger-workflow.js` (k6) is a third, separate kind of test:
not "is this correct" but "does this perform acceptably under concurrent
load." It ramps from 0 to 50 concurrent virtual users across a **pool of
20 separate tenants** — deliberately not one shared tenant, which would
simply trip that one tenant's own rate limiter and produce a wall of
expected-but-alarming-looking `429` responses rather than measuring real
system throughput. Thresholds: p95 trigger latency under 500ms, fewer than
1% hard failures.

---

## 18. CI/CD Pipeline

Defined in `.github/workflows/ci.yml` and `deploy.yml`.

### 18.1 `ci.yml` — runs on every push and pull request

Four jobs, with dependencies between them so nothing expensive runs until
cheaper checks have already passed:

1. **`unit-tests`** (matrixed across `api` and `worker`) — installs
   dependencies, type-checks with `tsc --noEmit`, runs the fast unit suite.
2. **`frontend-build`** — installs dependencies, runs a full Vite
   production build, catching any TypeScript or build-time error.
3. **`integration-test`** (depends on `unit-tests` passing first) — spins
   up **real Postgres and Redis service containers** provided by GitHub
   Actions, runs `prisma migrate deploy` against them, starts the actual
   worker process in the background, waits for its health endpoint, then
   runs the full integration test suite (Section 17.2) against all of it.
4. **`docker-build-push`** (depends on all three jobs above passing, and
   only runs on a push to `main`, never on a pull request) — builds
   Docker images for `api`, `worker`, and `frontend`, and pushes them to
   GitHub Container Registry (GHCR), tagged both `:latest` and with the
   commit SHA.

### 18.2 `deploy.yml` — manually triggered

Deliberately **not** automatic on every merge to `main`. An automatic
production deploy on every push removes the ability to sequence a rollout,
review what's about to ship, or hold a release in the event of a known
issue — a manual "Run workflow" trigger in the GitHub Actions tab keeps
deploys intentional, which is a reasonable default in the absence of a
staging environment and progressive rollout tooling. When triggered, it:
SSHs into a configured server, copies the production compose file and
monitoring config, pulls the freshly-built images from GHCR, restarts the
stack, runs database migrations, and finally verifies the deployed API's
`/health` endpoint responds successfully — failing loudly if it doesn't,
rather than silently leaving a broken deployment live.

---

## 19. Deployment Guide

### 19.1 Local development (the fast path)

```bash
cd api && cp .env.example .env && cd ..
cd worker && cp .env.example .env && cd ..
docker compose up --build
```

This builds every service **from source** (not from pre-built images),
which is what you want for active development — every code change is
reflected on the next `docker compose up --build`. Services become
available at:

- Dashboard: `http://localhost:3000`
- API: `http://localhost:4000`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001` (login `admin`/`admin`)

Run database migrations once, after the first startup:

```bash
docker compose exec api npx prisma migrate deploy
```

### 19.2 Production deployment

Production uses `deploy/docker-compose.prod.yml`, which **pulls pre-built
images from GHCR** rather than building from source on the server — the
same "build once, deploy the same tested artifact everywhere" principle
that makes deployments predictable rather than dependent on the state of
the server they happen to be built on.

Setup steps:

1. On the server: `mkdir -p /opt/pulsequeue`.
2. Copy `deploy/.env.prod.example` to `/opt/pulsequeue/.env` and fill in
   real secrets (`POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`,
   `JWT_REFRESH_SECRET`, `GRAFANA_ADMIN_PASSWORD`, optionally
   `ANTHROPIC_API_KEY`).
3. In the GitHub repository's settings, add three secrets:
   `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`.
4. Trigger the "Deploy" workflow from the GitHub Actions tab (or wire it to
   run automatically after a successful CI run on `main`, once a team is
   comfortable relying on the automated test suite alone as the release
   gate).

### 19.3 Scaling the worker pool

```bash
docker compose up --build --scale worker=3
```

Multiple worker replicas will all consume from the same Redis Streams
consumer group and safely claim non-overlapping steps via Postgres's
row-locking (Section 13.2) — no additional configuration required. Watch
`docker compose logs -f worker` to see different replica IDs claiming
different steps in real time.

---

## 20. Complete API Reference

All endpoints are prefixed `/api/v1` except `/health` and `/metrics`.
Authenticated endpoints require `Authorization: Bearer <accessToken>`.

### Auth

| Method & Path         | Auth required | Role | Description                                                                                                                        |
| --------------------- | ------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register` | No            | —    | Body: `{ tenantName, email, password }`. Creates a new tenant + admin user. Returns `{ accessToken, refreshToken, user, tenant }`. |
| `POST /auth/login`    | No            | —    | Body: `{ email, password }`. Returns `{ accessToken, refreshToken, user }`.                                                        |
| `POST /auth/refresh`  | No            | —    | Body: `{ refreshToken }`. Returns a new `{ accessToken, refreshToken }` pair; invalidates the old refresh token.                   |
| `POST /auth/logout`   | Yes           | any  | Invalidates all outstanding refresh tokens for the current user.                                                                   |
| `GET /auth/me`        | Yes           | any  | Returns the current user's profile.                                                                                                |

### Workflows

| Method & Path           | Auth | Role           | Description                                                                                  |
| ----------------------- | ---- | -------------- | -------------------------------------------------------------------------------------------- |
| `POST /workflows`       | Yes  | MEMBER+        | Body: `{ name, dag: { steps: [...] } }`. Validates the DAG (shape + cycles) before creating. |
| `GET /workflows`        | Yes  | VIEWER+        | Paginated list (`?page=1&pageSize=20`) of the tenant's workflows.                            |
| `GET /workflows/:id`    | Yes  | VIEWER+        | A single workflow's full definition.                                                         |
| `PUT /workflows/:id`    | Yes  | MEMBER+        | Update name and/or DAG (re-validated if DAG is included).                                    |
| `DELETE /workflows/:id` | Yes  | **ADMIN only** | Deletes a workflow.                                                                          |

### Runs

| Method & Path                 | Auth | Role    | Description                                                                                                       |
| ----------------------------- | ---- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `POST /workflows/:id/trigger` | Yes  | MEMBER+ | Creates a new run + one step per DAG node, publishes a trigger event. Returns `202 { runId, status: "PENDING" }`. |
| `GET /runs/:id`               | Yes  | VIEWER+ | Current run status.                                                                                               |
| `GET /runs/:id/steps`         | Yes  | VIEWER+ | Every step's current status for this run.                                                                         |
| `POST /runs/:id/replay`       | Yes  | MEMBER+ | Resets dead-lettered steps to `PENDING` and re-triggers execution. Returns `{ runId, replayedSteps: [...] }`.     |

### Operational endpoints

| Method & Path  | Auth | Description                                                                                           |
| -------------- | ---- | ----------------------------------------------------------------------------------------------------- |
| `GET /health`  | No   | Checks Postgres + Redis connectivity, returns `200` if both healthy, `503` otherwise.                 |
| `GET /metrics` | No   | Prometheus scrape endpoint (protected by network isolation, not application auth — see Section 16.6). |

### WebSocket

| Path                                      | Description                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ws/runs?token=<accessToken>&runId=<id>` | Live updates for one run. Verifies the token and tenant ownership before accepting the connection. Sends `{"type":"connected","runId":...}` on success, then `{"type":"step.updated",...}` / `{"type":"run.updated",...}` messages as they occur. |

### DAG definition format (used in `POST`/`PUT /workflows`)

```json
{
  "name": "My workflow",
  "dag": {
    "steps": [
      {
        "key": "fetch",
        "type": "HTTP",
        "dependsOn": [],
        "config": { "url": "https://api.example.com/data", "method": "GET" },
        "maxRetries": 3
      },
      {
        "key": "enrich",
        "type": "AI_ENRICHMENT",
        "dependsOn": ["fetch"],
        "config": { "prompt": "Summarize this data" },
        "maxRetries": 3
      },
      {
        "key": "notify",
        "type": "WEBHOOK",
        "dependsOn": ["enrich"],
        "config": { "url": "https://hooks.example.com/notify" },
        "maxRetries": 3
      }
    ]
  }
}
```

Valid `type` values: `HTTP`, `SCRIPT`, `AI_ENRICHMENT`, `WEBHOOK`.
`config` is free-form and specific to each type:

- `HTTP`: `{ url, method?, headers?, body?, timeoutMs? }`
- `SCRIPT`: `{ transform: "uppercase"|"lowercase"|"extractField"|"jsonStringify"|"merge", input?, params? }`
- `AI_ENRICHMENT`: `{ prompt, inputText?, model?, maxTokens? }`
- `WEBHOOK`: `{ url, payload?, headers? }`

---

## 21. USER MANUAL — How to Use the Application

This section assumes the full stack is already running (see Section 19.1)
and walks through the dashboard exactly as a first-time user would
experience it, screen by screen.

### 21.1 Starting the application

```bash
cd api && cp .env.example .env && cd ..
cd worker && cp .env.example .env && cd ..
docker compose up --build
```

Wait until the terminal output settles (no more "Building..." messages,
and you see log lines like `PulseQueue API listening on port 4000` and
`worker ready, waiting for events`). Then open a browser to
**http://localhost:3000**.

### 21.2 Creating an account

You'll land on the **Register** page. Fill in:

- **Organization/Tenant name** — any name for your organization (e.g. "My
  Test Org"). This creates a new, isolated tenant — nobody else's data
  will ever be visible to you, and vice versa.
- **Email** and **Password**.

Submitting creates your account as the first **Admin** user of a brand-new
tenant, and logs you straight in — no separate email verification step in
the current version.

### 21.3 The Workflows page (your home screen)

After logging in, you land on the workflow list — initially empty. This
page will show every workflow you've defined, as a grid of cards. Each
card shows the workflow's name and small colored chips indicating which
step types it uses (e.g. a teal chip for an AI enrichment step, a blue
chip for an HTTP step).

Click **"New Workflow"** to create your first one.

### 21.4 Creating a workflow

You'll see a form with:

- A **name** field.
- A **DAG definition** text area, pre-filled with a working three-step
  example (`fetch` → `enrich` → `notify`) so you can see valid syntax
  immediately rather than guessing at an empty box.

You can either use the example as-is, or edit it. Each step in the JSON
needs:

- `key` — a short unique name for this step within the workflow.
- `type` — one of `HTTP`, `SCRIPT`, `AI_ENRICHMENT`, or `WEBHOOK`.
- `dependsOn` — an array of other steps' keys that must finish first (leave
  empty `[]` for a step with no dependencies).
- `config` — settings specific to that step's type (a URL for `HTTP`/
  `WEBHOOK`, a prompt for `AI_ENRICHMENT`, a transform name for `SCRIPT`).

Click **Create**. If your DAG has a mistake — a cycle (step A depends on
B, which depends on A), or a dependency pointing at a step that doesn't
exist — you'll see a clear error message explaining exactly what's wrong,
and nothing will be saved. Fix it and resubmit.

### 21.5 Triggering a run

From the workflow list, open a workflow and click **Trigger**. This
immediately creates a new **run** and returns you to a live status page —
you do not need to refresh anything.

### 21.6 Watching a run live (the core experience)

This is the page that demonstrates the whole point of the project. You'll
see:

- The run's overall status at the top (`PENDING` → `RUNNING` →
  `SUCCEEDED`/`FAILED`).
- A list of every step in the workflow, each with a colored status dot:
  - **Gray** — waiting (`PENDING`), not started yet.
  - **Teal, pulsing** — currently executing (`RUNNING`). This is the only
    animated element in the whole interface — a small radiating pulse,
    literally referencing the product's name.
  - **Amber** — failed once and waiting to retry (`RETRYING`); the step's
    row shows which attempt number it's on.
  - **Green** — finished successfully (`SUCCEEDED`).
  - **Red** — permanently failed (`DEAD_LETTER`); the step's row shows the
    actual error message.
- A small **"● live"** indicator confirming the page is genuinely connected
  and receiving updates in real time (it will show "○ disconnected" if the
  connection drops, e.g. if you go offline).

You do not need to refresh the page at any point — every status change
appears within a fraction of a second of actually happening, pushed to
your browser over a live WebSocket connection.

### 21.7 Seeing a retry and dead-letter happen

Create a second workflow with a single step:

```json
{
  "name": "flaky demo",
  "dag": {
    "steps": [
      {
        "key": "always_fails",
        "type": "HTTP",
        "dependsOn": [],
        "config": { "url": "https://httpstat.us/500" },
        "maxRetries": 2
      }
    ]
  }
}
```

Trigger it and watch: the step will go `RUNNING` → `RETRYING` (you'll see
the attempt count climb, with a growing delay between attempts — that's
the exponential backoff in action) → eventually `DEAD_LETTER` once its 2
retries are exhausted. The run itself will show `FAILED`.

### 21.8 Replaying a failed step

Once a run has at least one dead-lettered step, a **"Replay dead-lettered
steps"** button appears on its run page — it only appears when there's
something to replay, which is itself informative. Clicking it resets those
steps and re-triggers execution; watch the status flip back to `PENDING` →
`RUNNING` and try again. (For the example above, since the URL always
returns an error, replaying will fail the same way again — try pointing a
step at a real, working URL to see a successful replay.)

### 21.9 Watching the system-level dashboard (Grafana)

Open **http://localhost:3001** (login `admin` / `admin`, or just view it —
anonymous viewing is enabled). The "PulseQueue Overview" dashboard is
already loaded with seven panels. While you trigger workflows in the main
app, watch:

- **Queue Depth** — rises as you trigger more runs, drains as the worker
  catches up.
- **Step Execution Latency** — how long each step type typically takes.
- **Step Throughput** — successes/retries/dead-letters per second.
- **Run Outcomes** — successful vs. failed runs over time.
- **API Request Rate/Latency** and **Active WebSocket Connections**.

### 21.10 Logging out

Click your email in the top navigation bar, then **Logout**. This
invalidates your session's refresh token server-side immediately (your
current page's access token remains valid for at most 15 more minutes, a
documented tradeoff — Section 16.2).

### 21.11 What each role can and cannot do

If you invite teammates into your tenant (a future enhancement — see
Section 24), roles control what they can do:

- **Viewer** — can see workflows and run status, cannot create, trigger,
  or delete anything.
- **Member** — can additionally create/edit workflows, trigger runs, and
  replay dead-lettered steps.
- **Admin** — can additionally delete workflows (a stricter, separate
  permission from creating them).

---

## 22. Environment Variables Reference

### `api/.env`

| Variable             | Purpose                                                              | Example                                                       |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `NODE_ENV`           | `development` or `production`                                        | `development`                                                 |
| `PORT`               | API listen port                                                      | `4000`                                                        |
| `DATABASE_URL`       | Postgres connection string                                           | `postgresql://pulsequeue:pulsequeue@postgres:5432/pulsequeue` |
| `REDIS_URL`          | Redis connection string                                              | `redis://redis:6379`                                          |
| `JWT_ACCESS_SECRET`  | Signing secret for access tokens                                     | (random string, 32+ chars)                                    |
| `JWT_REFRESH_SECRET` | Signing secret for refresh tokens (different from the access secret) | (random string, 32+ chars)                                    |
| `JWT_ACCESS_EXPIRY`  | Access token lifetime                                                | `15m`                                                         |
| `JWT_REFRESH_EXPIRY` | Refresh token lifetime                                               | `7d`                                                          |

### `worker/.env`

| Variable            | Purpose                                                                           | Example                    |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------- |
| `NODE_ENV`          | `development` or `production`                                                     | `development`              |
| `DATABASE_URL`      | Same Postgres instance as the API                                                 | (same as above)            |
| `REDIS_URL`         | Same Redis instance as the API                                                    | (same as above)            |
| `WORKER_ID`         | A label for this replica, shown in logs/consumer group                            | `worker-1`                 |
| `LOG_LEVEL`         | pino log level                                                                    | `info`                     |
| `METRICS_PORT`      | Port for the worker's `/metrics` server                                           | `9100`                     |
| `ANTHROPIC_API_KEY` | Optional — enables real `AI_ENRICHMENT` step calls; omit to use the mock fallback | (your key, or leave blank) |

### `frontend/.env`

| Variable       | Purpose                                       | Example                 |
| -------------- | --------------------------------------------- | ----------------------- |
| `VITE_API_URL` | Base URL the frontend calls for REST requests | `http://localhost:4000` |
| `VITE_WS_URL`  | Base URL for the WebSocket connection         | `ws://localhost:4000`   |

### `deploy/.env` (production only, on the server)

See `deploy/.env.prod.example` — adds `POSTGRES_PASSWORD`,
`GRAFANA_ADMIN_PASSWORD`, and `GITHUB_REPOSITORY_OWNER` (used to resolve
which GHCR images to pull).

---

## 23. Known Limitations & Honest Tradeoffs

Documented directly and repeatedly throughout this codebase (in code
comments, in `ARCHITECTURE.md`, and here) rather than hidden — naming a
system's real limitations precisely, rather than glossing over them, is
part of maintaining it responsibly.

1. **The Prisma schema is duplicated** between `api/prisma/schema.prisma`
   and `worker/prisma/schema.prisma`, kept in sync manually. This is
   workable for a two-service project; at larger scale, this would move
   into a shared `packages/db` workspace package that both services
   depend on, so the schema exists in exactly one place.
2. **Prometheus scraping the worker doesn't survive horizontal scaling
   cleanly.** With `docker compose up --scale worker=3`, Docker's internal
   DNS round-robins the `worker` hostname across replicas, so Prometheus's
   one static target only ever reaches one of them. A Kubernetes
   deployment (or Consul/ECS service discovery) would solve this by
   discovering and scraping every replica individually.
3. **`SCRIPT` steps intentionally do not support arbitrary code
   execution** — a small, fixed transform registry only, for the security
   reasons detailed in Section 16.4. This is a deliberate scope boundary,
   not a missing feature waiting to be finished.
4. **The WebSocket access token travels as a URL query parameter**, not a
   header, because browsers cannot set custom headers during a WebSocket
   handshake. A more hardened design might instead mint a short-lived,
   single-use "connection ticket" via a separate REST call immediately
   before opening the WebSocket, so a longer-lived access token never ends
   up in a URL (which could be logged by an intermediate proxy).
5. **Metrics endpoints are unauthenticated at the application layer**,
   relying on network isolation (not being exposed outside the Docker
   network / VPC) rather than an API key or auth token. This matches
   standard practice but depends on the actual deployment network topology
   correctly enforcing that isolation.
6. **No visual drag-and-drop DAG builder** — workflows are currently
   defined by hand-writing JSON in a text area. Functionally complete, but
   a natural usability improvement (Section 24).
7. **No email verification or password-reset flow** — registration
   creates and logs in an account immediately, with no confirmation email
   step, which is a reasonable starting point but not what a
   customer-facing product would ship long-term.
8. **Deploy is manually triggered**, not automatic on every merge to
   `main` — a deliberate current choice (Section 18.2) that would likely
   be revisited (behind stronger test coverage and perhaps a staging
   environment) as the project matures.

---

## 24. What Could Be Built Next

Roughly in order of impact-to-effort ratio:

1. **A visual DAG builder** — drag-and-drop step nodes and connect
   dependencies visually, generating the same underlying JSON, rather than
   requiring users to hand-write it.
2. **Team invitations** — currently, a tenant's only way to get a second
   user is by directly inserting one; a real "invite teammate by email"
   flow would complete the multi-tenant RBAC story.
3. **Extract the shared Prisma schema** into a proper shared package,
   removing the documented duplication between `api/` and `worker/`.
4. **Kubernetes deployment manifests** (or a Helm chart), replacing Docker
   Compose in production and solving the Prometheus multi-replica scraping
   limitation via native service discovery.
5. **Autoscaling the worker pool automatically**, driven by the existing
   `pulsequeue_queue_depth` Prometheus metric (e.g. a Kubernetes
   Horizontal Pod Autoscaler on a custom metric) instead of a human
   deciding when to run `--scale worker=N`.
6. **A proper webhook signing scheme** (HMAC signatures) for the
   `WEBHOOK` step type, so receivers can verify a notification genuinely
   came from PulseQueue.
7. **Postgres read replicas** for the dashboard's list/read endpoints,
   separating read load from the write path that auth/trigger/worker
   claiming depend on.
8. **A sandboxed "real" SCRIPT execution mode** (WASM runtime or
   microVM-based), as a genuinely secure alternative to the current
   whitelisted-transform-only approach, for use cases that need true
   user-supplied logic.

---

## 25. Glossary of Terms

| Term                                | Meaning in this project                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tenant**                          | An organization/customer account; the top-level unit of data isolation. Every user belongs to exactly one tenant.                                                                                            |
| **Workflow**                        | A named, reusable _definition_ of a DAG of steps — the template, not a specific execution of it.                                                                                                             |
| **Run**                             | One specific execution of a workflow, created each time it's triggered.                                                                                                                                      |
| **Step**                            | One node in a run's DAG — a single unit of work with its own status, retry count, and output.                                                                                                                |
| **DAG**                             | Directed Acyclic Graph — a set of steps and dependency relationships between them, with no circular dependencies allowed.                                                                                    |
| **Idempotency key**                 | A unique identifier ensuring a specific operation (here, one step's execution) can never be accidentally duplicated even if retried.                                                                         |
| **Consumer group**                  | A Redis Streams feature letting multiple worker processes share the work of consuming one stream, each message delivered to exactly one consumer in the group.                                               |
| **`SKIP LOCKED`**                   | A Postgres `SELECT ... FOR UPDATE` modifier that makes concurrent workers skip rows another transaction already has locked, instead of blocking — the core mechanism enabling safe concurrent step claiming. |
| **Retryable vs. permanent error**   | An executor's own explicit classification of a failure: retryable (try again later, e.g. a timeout) vs. permanent (retrying can never help, e.g. a malformed request).                                       |
| **Exponential backoff with jitter** | A retry-delay strategy that grows exponentially with each attempt and adds randomness, to avoid many failures retrying in a synchronized burst.                                                              |
| **Dead-letter**                     | A step's final non-retrying failure state, after exhausting retries or hitting a permanent error — visible for manual investigation and replay.                                                              |
| **RBAC**                            | Role-Based Access Control — restricting actions based on a user's assigned role (Viewer/Member/Admin here).                                                                                                  |
| **Correlation ID**                  | An identifier attached to a request (and everything it triggers) so all related log lines across services can be found together.                                                                             |
| **Fan-out / fan-in**                | DAG shapes: fan-out is one step unblocking several independent downstream steps; fan-in is several steps all needing to finish before one downstream step can start.                                         |

---
