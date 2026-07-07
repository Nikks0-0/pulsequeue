# Load testing PulseQueue

Uses [k6](https://k6.io/) to load-test the trigger endpoint under realistic
multi-tenant concurrency.

## Install k6
```bash
# macOS
brew install k6
# Linux
sudo apt install k6   # or see https://k6.io/docs/get-started/installation/
```

## Run against a local stack
```bash
docker compose up -d
k6 run load-test/trigger-workflow.js
```

## Run against a deployed instance
```bash
k6 run -e BASE_URL=https://your-domain load-test/trigger-workflow.js
```

## What it tests
- Ramps from 0 -> 10 -> 50 concurrent virtual users triggering workflows
- Uses a **pool of 20 tenants** (not one), so the test measures real system
  throughput rather than immediately tripping one tenant's own rate limit
- Thresholds: p95 trigger latency under 500ms, <1% hard failures

## What "good" looks like
- `http_req_duration{endpoint:trigger}` p95 stays under 500ms even at 50 VUs
- Check the Grafana dashboard (http://localhost:3001) during the run:
  queue depth should rise during the spike and drain back down afterward
  once the worker(s) catch up -- that drain is the thing to watch for. If
  queue depth keeps climbing and never drains, that's the signal you need
  more worker replicas (`docker compose up --scale worker=3`).

## Testing the rate limiter specifically
The pooled-tenant test above is intentionally designed to avoid tripping any
single tenant's rate limit. To verify the limiter itself works, run a
separate single-tenant variant (reuse one `accessToken` across all VUs) and
confirm you start seeing `429`s once that tenant's aggregate request rate
crosses 100 req/60s -- that's the correct, intended behavior for that
scenario, not a bug.
