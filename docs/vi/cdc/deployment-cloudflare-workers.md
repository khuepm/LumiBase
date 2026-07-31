---
title: Deployment — Cloudflare Workers (Edge Components Only)
version: 2
lastUpdated: 2026-07-31T19:47:41.911Z
sourceLang: en
translatedFrom: en
sourceHash: ab6a86693d7baf0e
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-31T19:47:41.911Z
codeVerifiedHash: ab6a86693d7baf0e
codeVerifiedClaims: 10
---

# Hướng dẫn deploy: Cloudflare Workers (chỉ các thành phần edge)

Hướng dẫn này deploy **chỉ các thành phần edge nhẹ** của hệ thống CDC lên Cloudflare Workers: các **endpoint CDC API / control-plane** và **Cache_Invalidator**. Nó tương ứng với deployment target `cloudflare_workers` và đáp ứng phần thành phần edge của **Requirement 9.4**.

> **Bản deploy này không tự đứng một mình được.** Cloudflare Workers không thể host các CDC connector có state, message bus Kafka, hay các engine replication PostgreSQL/ClickHouse (do giới hạn CPU/memory của V8 isolate và việc không có kết nối TCP sống lâu). Runtime Workers nói chuyện với stack có state qua HTTPS, nên một bản deploy `cloudflare_workers` **luôn phụ thuộc vào một bản deploy có state đi kèm**. Hãy provision stack có state trước, dùng [hướng dẫn deploy Docker Compose / managed services](./deployment-docker-compose.md), rồi quay lại đây.

## Điều kiện tiên quyết

- Một [bản deploy Docker Compose / managed services](./deployment-docker-compose.md) đã hoàn tất cho stack có state, kết nối được qua HTTPS. Hãy ghi lại base URL của nó — đó là `CDC_STATEFUL_STACK_URL`.
- Một [account Cloudflare](https://dash.cloudflare.com/sign-up) (khuyến nghị plan Workers Paid).
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) v3+.
- Node.js 22+ và pnpm.
- Một instance Redis kết nối được cho Cache_Invalidator (ví dụ Upstash) — đó là `REDIS_URL`.
- Một bearer token mạnh để bảo vệ control-plane API — đó là `CDC_API_AUTH_TOKEN`.

## Bước 1: Xác thực Wrangler

```bash
pnpm add -g wrangler
wrangler login
wrangler whoami
```

## Bước 2: Cấu hình biến môi trường

Bản deploy edge chỉ dùng các biến chung cộng các biến edge (không có biến kết nối của phần có state). Xem [Environment Variables — thành phần edge](./environment-variables.md#edge-components-cloudflare_workers).

Đặt các giá trị không phải secret trong `wrangler.toml`:

```toml
name = "lumibase-cdc-edge"
main = "src/index.ts"
compatibility_date = "2024-10-01"
compatibility_flags = ["nodejs_compat"]

[vars]
CDC_APPROACH = "debezium_kafka"          # phải khớp với stack có state đi kèm
CDC_DEPLOYMENT_TARGET = "cloudflare_workers"
CDC_PIPELINE_NAME = "orders-analytics"
CACHE_KEY_NAMESPACE = "lumibase"
CACHE_INVALIDATOR_QUEUE_MAX = "10000"
CACHE_INVALIDATOR_DEDUP_WINDOW_MS = "1000"
```

Đặt secret bằng `wrangler secret put` (đừng bao giờ commit chúng):

```bash
wrangler secret put CDC_STATEFUL_STACK_URL   # endpoint https của stack có state
wrangler secret put CDC_API_AUTH_TOKEN       # bearer token cho control-plane API
wrangler secret put REDIS_URL                # connection string redis:// hoặc rediss://
```

## Bước 3: Validate cấu hình edge

Hãy validate các biến edge theo schema trước khi deploy (Requirements 7.4, 7.5):

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy/validate-env \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "approach": "debezium_kafka",
    "target": "cloudflare_workers",
    "env": {
      "CDC_PIPELINE_NAME": "orders-analytics",
      "CDC_STATEFUL_STACK_URL": "https://cdc-stack.internal.example.com",
      "CDC_API_AUTH_TOKEN": "replace-with-a-strong-random-token",
      "REDIS_URL": "rediss://default:token@us1-abc-12345.upstash.io:6379"
    }
  }'
```

Output mong đợi:

```json
{ "data": { "valid": true } }
```

## Bước 4: Deploy các thành phần edge

Bạn có thể deploy trực tiếp bằng Wrangler:

```bash
wrangler deploy
```

Hoặc điều khiển qua AI Flow Engine, nó giới hạn phạm vi deploy vào **chỉ các thành phần edge** — nó sẽ không cố provision các connector có state, message bus, hay engine replication trên Workers (Requirement 7.2):

```bash
curl -sS -X POST https://your-cms-host/api/v1/cdc/deploy \
  -H "Authorization: Bearer $LUMI_ADMIN_TOKEN" \
  -H "X-Lumi-Site: $SITE_ID" \
  -H "Content-Type: application/json" \
  -d '{ "approach": "debezium_kafka", "target": "cloudflare_workers" }'
```

Bản deploy tạo ra đúng hai service: `cdc_api` (CDC API / control plane) và `cache_invalidator`.

## Verification

### Lệnh verify

```bash
curl -sS https://lumibase-cdc-edge.<your-subdomain>.workers.dev/api/v1/cdc/health \
  -H "Authorization: Bearer $CDC_API_AUTH_TOKEN"
```

### Output mong đợi

Các thành phần edge báo healthy và xác nhận kết nối tới stack có state đi kèm cùng Redis:

```json
{
  "data": {
    "status": "healthy",
    "target": "cloudflare_workers",
    "components": [
      { "service": "cdc_api", "reachable": true },
      { "service": "cache_invalidator", "reachable": true }
    ],
    "dependencies": [
      { "service": "stateful_stack", "reachable": true },
      { "service": "redis", "reachable": true }
    ]
  }
}
```

Nếu `stateful_stack` không kết nối được, hãy xác nhận [bản deploy Docker Compose / managed services](./deployment-docker-compose.md) đi kèm đang chạy và `CDC_STATEFUL_STACK_URL` là đúng và dùng HTTPS.

Response `/deploy` của AI Flow Engine cho bản deploy edge:

```json
{
  "data": {
    "deploymentId": "Td9_kLm3Qa1",
    "approach": "debezium_kafka",
    "target": "cloudflare_workers",
    "status": "completed",
    "health": {
      "passed": true,
      "services": [
        { "service": "cdc_api", "reachable": true },
        { "service": "cache_invalidator", "reachable": true }
      ]
    }
  }
}
```

## Các thành phần edge hành xử thế nào

- **CDC API / control plane** — phơi ra các endpoint CDC (bị chặn ở mức admin bởi `CDC_API_AUTH_TOKEN`) và proxy các operation có state tới `CDC_STATEFUL_STACK_URL` qua HTTPS.
- **Cache_Invalidator** — tiêu thụ các CDC change event và refresh Redis (INSERT/UPDATE → SET, DELETE → DEL) trong vòng 5 giây kể từ lúc commit. Khi Redis mất kết nối, nó buffer tối đa `CACHE_INVALIDATOR_QUEUE_MAX` event và replay chúng đúng thứ tự; các UPDATE liên tiếp cho cùng một key được dedupe trong `CACHE_INVALIDATOR_DEDUP_WINDOW_MS`.

## Ghi chú bảo mật

Đây là các endpoint control-plane phơi ra mạng. Chúng bắt buộc phải được bảo vệ bởi `CDC_API_AUTH_TOKEN`; đừng deploy chúng khi chưa có nó. Hãy giữ `CDC_API_AUTH_TOKEN`, `REDIS_URL`, và `CDC_STATEFUL_STACK_URL` dưới dạng secret của Wrangler, không phải var dạng plaintext.

## Bước tiếp theo

- [Bản deploy Docker Compose / managed services](./deployment-docker-compose.md) — stack có state đi kèm bắt buộc phải có
- [Troubleshooting](./troubleshooting.md)
- [Environment Variables](./environment-variables.md)
