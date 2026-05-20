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

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:8787` | CMS base URL (use `ws://` for realtime) |
| `SITE_ID` | `site_test` | Site ID for `X-Lumi-Site` header |
| `TOKEN` | `dev:user123` | Bearer token |
| `COLLECTION` | `articles` | Collection name for items/realtime tests |

## Running

```bash
# Smoke test (quick sanity check)
k6 run --env BASE_URL=http://localhost:8787 \
       --env SITE_ID=my-site \
       --env TOKEN=dev:myuser \
       apps/cms/k6/smoke.js

# Item load test
k6 run --env BASE_URL=http://localhost:8787 \
       --env SITE_ID=my-site \
       --env TOKEN=dev:myuser \
       --env COLLECTION=articles \
       apps/cms/k6/load-items.js

# Realtime WebSocket test
k6 run --env BASE_URL=ws://localhost:8787 \
       --env SITE_ID=my-site \
       --env TOKEN=dev:myuser \
       apps/cms/k6/load-realtime.js
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

## CI Integration

```yaml
# .github/workflows/load-test.yml (run manually or on schedule)
- name: Run smoke test
  run: k6 run apps/cms/k6/smoke.js
  env:
    BASE_URL: ${{ secrets.PREVIEW_API_URL }}
    TOKEN: ${{ secrets.LOAD_TEST_TOKEN }}
    SITE_ID: ${{ secrets.LOAD_TEST_SITE }}
```
