# PulseQueue Architecture

## High-level architecture

```mermaid
flowchart TB
    subgraph Client
        FE[React Dashboard]
    end

    subgraph API_Service["API Service"]
        API[Express API]
        WS[WebSocket Gateway]
    end

    subgraph Data["Data Layer"]
        PG[(PostgreSQL)]
        REDIS[(Redis)]
    end

    subgraph Workers["Worker Pool (horizontally scalable)"]
        W1[Worker Replica 1]
        W2[Worker Replica 2]
        W3[Worker Replica N]
    end

    subgraph Observability
        PROM[Prometheus]
        GRAF[Grafana]
    end

    FE -- REST --> API
    FE -- WebSocket --> WS
    API -- reads/writes --> PG
    API -- rate limit + publish trigger --> REDIS
    WS -- PSUBSCRIBE run:*:events --> REDIS

    REDIS -- Streams: workflow-events --> W1
    REDIS -- Streams: workflow-events --> W2
    REDIS -- Streams: workflow-events --> W3

    W1 -- SELECT FOR UPDATE SKIP LOCKED --> PG
    W2 -- SELECT FOR UPDATE SKIP LOCKED --> PG
    W3 -- SELECT FOR UPDATE SKIP LOCKED --> PG

    W1 -- PUBLISH run:id:events --> REDIS
    W2 -- PUBLISH run:id:events --> REDIS
    W3 -- PUBLISH run:id:events --> REDIS

    API -. scraped by .-> PROM
    W1 -. scraped by .-> PROM
    PROM --> GRAF
```

**Why two Redis primitives (Streams AND Pub/Sub) instead of one:**
Streams give durable, consumer-group, at-least-once delivery — required for
"a worker must execute this step exactly once, even if a worker crashes
mid-processing." Pub/Sub is fire-and-forget "tell whoever's listening right
now" — perfect for live dashboard updates, wrong for anything that must not
be lost. Using Streams for both would mean the dashboard misses updates
whenever nobody's connected (fine); using Pub/Sub for both would mean a
worker crash silently drops a step forever (not fine). One primitive per
delivery guarantee, not one primitive for everything.

## Trigger -> execution sequence

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant PG as Postgres
    participant R as Redis
    participant W as Worker

    C->>A: POST /workflows/:id/trigger
    A->>PG: INSERT run (PENDING) + steps (PENDING) [transaction]
    A->>R: XADD workflow-events (runId, workflowId, tenantId)
    A-->>C: 202 { runId, status: PENDING }

    R-->>W: XREADGROUP (consumer group, new event)
    W->>PG: SELECT ready steps FOR UPDATE SKIP LOCKED
    W->>PG: UPDATE claimed steps -> RUNNING
    W->>W: execute step (HTTP / SCRIPT / AI_ENRICHMENT / WEBHOOK)
    alt success
        W->>PG: UPDATE step -> SUCCEEDED
    else retryable failure
        W->>PG: UPDATE step -> RETRYING (nextAttemptAt = now + backoff)
    else permanent failure / retries exhausted
        W->>PG: UPDATE step -> DEAD_LETTER
    end
    W->>R: PUBLISH run:<id>:events (step update)
    R-->>A: pmessage (WS gateway subscriber)
    A-->>C: WebSocket push (live step update)
    W->>R: XACK workflow-events

    Note over W: loop continues, claiming newly-unblocked<br/>steps until nothing is ready, then finalizes run
```

## Step state machine

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> RUNNING: claimed by a worker
    RUNNING --> SUCCEEDED: executor returns
    RUNNING --> RETRYING: retryable error, attempts remain
    RUNNING --> DEAD_LETTER: permanent error, or retries exhausted
    RETRYING --> RUNNING: backoff window elapsed, re-claimed
    DEAD_LETTER --> PENDING: POST /runs/:id/replay
    SUCCEEDED --> [*]
    DEAD_LETTER --> [*]
```

## Entity-relationship diagram

```mermaid
erDiagram
    TENANT ||--o{ USER : has
    TENANT ||--o{ WORKFLOW : owns
    TENANT ||--o{ API_KEY : issues
    USER ||--o{ WORKFLOW : creates
    WORKFLOW ||--o{ RUN : triggers
    RUN ||--o{ STEP : contains

    TENANT {
        uuid id PK
        string name
        string plan
    }
    USER {
        uuid id PK
        uuid tenant_id FK
        string email
        string role
        int token_version
    }
    WORKFLOW {
        uuid id PK
        uuid tenant_id FK
        string name
        json dag_json
        uuid created_by FK
    }
    RUN {
        uuid id PK
        uuid workflow_id FK
        string status
        timestamp started_at
        timestamp finished_at
    }
    STEP {
        uuid id PK
        uuid run_id FK
        string step_key
        string type
        string status
        int attempt_count
        string idempotency_key
        timestamp next_attempt_at
    }
    API_KEY {
        uuid id PK
        uuid tenant_id FK
        string key_hash
        int rate_limit
    }
```

## Why `SELECT ... FOR UPDATE SKIP LOCKED`

This is the most performance-critical query in the system. When
multiple worker replicas wake up for the same run simultaneously (a common
case: `docker compose up --scale worker=3`), they all query for the same set
of "ready" step keys. Without `SKIP LOCKED`, the second worker's `SELECT ...
FOR UPDATE` would **block** waiting for the first worker's row lock to
release — serializing workers for no reason, and in the worst case
deadlocking if lock order differs. With `SKIP LOCKED`, the second worker
simply skips whatever's already locked and claims whatever's left. Net
effect: N workers can claim N different ready steps from the same batch in
parallel, safely, with zero coordination beyond what Postgres already gives
you for free. No distributed lock service, no Redis-based mutex, no
application-level coordination logic required.

## Known limitations (said out loud, not hidden)

- **Prisma schema is duplicated** between `api/` and `worker/` rather than
  living in a shared package — a documented tradeoff for project scope, not
  an oversight. At real scale this would move to a shared `packages/db`.
- **Prometheus scraping the worker doesn't survive `--scale worker=N`
  cleanly** — Docker's internal DNS round-robins the `worker` hostname, so
  only one replica ever gets scraped. A real deployment would use
  Kubernetes-native service discovery (or Consul, or ECS service discovery)
  so every replica is discovered and scraped individually.
- **SCRIPT steps are a whitelisted transform registry, not arbitrary code
  execution** — a deliberate security boundary. Supporting genuinely
  arbitrary user code safely would need microVM sandboxing (Firecracker,
  gVisor) or a WASM runtime with no host syscall access, both well beyond
  this project's scope.
- **WebSocket auth token travels as a query parameter** — necessary because
  browsers can't set custom headers on the WS handshake. A production
  system might mint a short-lived, single-use "connection ticket" via a REST
  call just before connecting, so the long-lived access token itself never
  appears in a URL (which can end up in server access logs).
