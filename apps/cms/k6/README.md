# k6 Load Tests — LumiBase CMS

Load test scripts for LumiBase delivery API and realtime WebSocket endpoints.

## Prerequisites

Install [k6](https://k6.io/docs/getting-started/installation/):

```bash
# macOS
brew install k6

# Docker
docker pull grafana/k6
```

## Scripts

| Script | Scenario | Target |
|---|---|---|
| `smoke.js` | Quick sanity — 1 VU, 30 s | All main endpoints |
| `load-items.js` | Item list throughput + create burst | 50 VU ramp + 30 VU burst |
| `load-realtime.js` | WebSocket subscription ramp | 100 concurrent WS connections |
| `load-penetration.js` | 95% missing-slug probes + 5% good page (Req 19) | DB-query-per-404 ≤ 0.05 |
| `load-deliver.js` | 90% deliver page (Zipf slugs) + 10% item list | Delivery p95, origin offload baseline |
| `login-brute-force.js` | 50 VU login spam + baseline traffic | `/api/v1/auth/login` IP block (Req 8.2/8.3) |
| `cross-site-leak.js` | Cross-tenant isolation probe | Multi-site data + auth + realtime isolation |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:1989` | CMS base URL (use `ws://` for realtime) |
| `SITE_ID` | `site_test` | Site ID for `X-Lumi-Site` header |
| `TOKEN` | `dev:user123` | Bearer token |
| `COLLECTION` | `articles` | Collection name for items/realtime/deliver list leg |
| `SLUG_COUNT` | `60` | Number of deliver slugs in the Zipf pool (`load-deliver.js`) |
| `RATE` | `30` | Arrival rate per second (`load-deliver.js`) |
| `DURATION` | `2m` | Scenario duration (`load-deliver.js`) |
| `SEED_ITEMS` | `1000` | Items per collection in `seed.ts` (use `100000` for full baseline) |

### `login-brute-force.js` extra env

| Variable | Default | Description |
|---|---|---|
| `LOGIN_EMAIL` | `bruteforce-target@example.test` | Email used in the wrong-password POSTs. Need not exist; the LoginGuard counts both known and unknown emails toward the IP rate-limit. |
| `WRONG_PASSWORD` | `definitely-not-the-password` | Password sent on every attempt. Must not match a real account. |
| `IP_MAX_FAILED_ATTEMPTS` | `20` | The `ipMaxFailedAttempts` configured in `Lockout_Policy` (Standard preset = 20). |
| `IP_BLOCK_HEADROOM` | `10` | Extra attempts tolerated before the first observed 429 (race between 50 VUs and the server-side counter). Sets the `attempts_before_first_block` p95 threshold. |
| `BASELINE_P95_MS` | `800` | p95 latency budget for the `baseline_traffic` scenario. Test fails if `/health` or `/api/v1/setup/state` exceeds this while login is being spammed. |
| `DURATION` | `2m` | Duration of both scenarios. |

## Running

```bash
# Smoke test (quick sanity check)
k6 run --env BASE_URL=http://localhost:1989 \
       --env SITE_ID=my-site \
       --env TOKEN=dev:myuser \
       apps/cms/k6/smoke.js

# Item load test
k6 run --env BASE_URL=http://localhost:1989 \
       --env SITE_ID=my-site \
       --env TOKEN=dev:myuser \
       --env COLLECTION=articles \
       apps/cms/k6/load-items.js

# Realtime WebSocket test
k6 run --env BASE_URL=ws://localhost:1989 \
       --env SITE_ID=my-site \
       --env TOKEN=dev:myuser \
       apps/cms/k6/load-realtime.js

# Login brute-force defence (Req 8.2, 8.3 — IP block under 50 VU spam)
# Assumes a running CMS instance with system_state='initialized'.
# Test is on-demand, not part of CI.
k6 run --env BASE_URL=http://localhost:1989 \
       --env LOGIN_EMAIL=bruteforce-target@example.test \
       apps/cms/k6/login-brute-force.js

# Cache penetration (Req 19 — tombstone + shape guard)
# Seed a published page first. For DB-query-per-404 measurement from one IP,
# set LUMIBASE_DELIVER_RATE_LIMIT=0 (default 1200/min trips at 50 RPS).
k6 run --env BASE_URL=http://localhost:1989 \
       --env SITE_ID=site_test \
       --env GOOD_SLUG=home \
       --env MISS_POOL=40 \
       apps/cms/k6/load-penetration.js

# Delivery read-mix baseline (task 0 — seed first, then run)
DATABASE_URL=postgres://lumibase:lumibase_dev@localhost:5432/lumibase \
  tsx apps/cms/k6/seed.ts
k6 run --env BASE_URL=http://localhost:1989 \
       --env SITE_ID=site_load_a \
       --env COLLECTION=articles \
       apps/cms/k6/load-deliver.js
```

## Thresholds

### smoke.js
- `http_req_failed` < 1%
- `http_req_duration` p95 < 500 ms

### load-items.js
- List: `http_req_failed` < 1%, p95 < 800 ms
- Create: `http_req_failed` < 2%, p95 < 1200 ms

### load-realtime.js
- WS connect: p95 < 500 ms
- `realtime_errors` < 5

### login-brute-force.js
- `login_blocked_responses` count > 0 — at least one HTTP 429 IP_BLOCKED observed (Req 8.3)
- `attempts_before_first_block` p95 ≤ `IP_MAX_FAILED_ATTEMPTS + IP_BLOCK_HEADROOM` (default 30) — block kicks in close to the configured `ipMaxFailedAttempts` (Req 8.2)
- `http_req_failed{scenario:baseline_traffic}` < 1% — `/health` and `/api/v1/setup/state` keep returning 2xx during the spam
- `http_req_duration{scenario:baseline_traffic}` p95 ≤ `BASELINE_P95_MS` (default 800 ms) — non-login routes do not degrade
- `login_unexpected_responses` count < 10 — login responses stay within the expected 401 / 423 / 429 set

### load-deliver.js
- `http_req_failed` < 2%
- `deliver_ok_rate` > 85% (200/304 on seeded slugs)
- `list_ok_rate` > 90%
- `deliver_duration_ms` p95 < 800 ms
- `list_duration_ms` p95 < 1200 ms

## CI integration

Nightly/label perf gate: `.github/workflows/perf-k6.yml` (validates scripts on every path; full smoke + `load-deliver` when `PERF_K6_FULL_RUN=true`, on `workflow_dispatch`, or PR label `perf-k6`). See [Testing guide — k6 performance tests](../../docs/en/contributing/testing.md#k6-performance-tests).

```yaml
# .github/workflows/load-test.yml (run manually or on schedule)
- name: Run smoke test
  run: k6 run apps/cms/k6/smoke.js
  env:
    BASE_URL: ${{ secrets.PREVIEW_API_URL }}
    TOKEN: ${{ secrets.LOAD_TEST_TOKEN }}
    SITE_ID: ${{ secrets.LOAD_TEST_SITE }}
```
