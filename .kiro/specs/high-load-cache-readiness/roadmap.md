# Roadmap — High-Load & Cache Readiness

> Trạng thái: **draft** · Phiên bản đích: v0.18.x → v0.20.x · Ngày lập: 2026-07-04
>
> Nguồn: audit codebase trên nhánh `claude/cms-high-load-evaluation-48fpij` (đọc trực tiếp source, có file:line cho mọi phát hiện). Các nhận định về hành vi dưới tải là [Inference] từ code path — cần xác nhận lại bằng k6 baseline (Phase 0, task đầu tiên) trước khi tối ưu.
>
> Bộ spec: `requirements.md` (Req 0–19, EARS) · `design.md` (kiến trúc, traceability, API contracts, properties P1–P20) · `tasks.md` (kế hoạch 4 phase + nhóm bổ sung 22) · `dod-review.md` (rà soát Definition of Done từng mục, rà lại khi đóng mỗi phase).
>
> **Bổ sung 2026-07-27:** audit vòng hai về *cache penetration* (khoá không tồn tại ở cả cache lẫn DB) → Req 19 + design §14 + tasks 22.x. Spec gốc phủ *cache breakdown* (Req 9, khoá nóng hết hạn) nhưng không phủ penetration; ba lỗ hổng mới ghi trong bảng §1 dưới.

## 1. Bối cảnh — hiện trạng đã audit

### Điểm mạnh sẵn có

- Cache abstraction `CacheProvider` với 2 adapter: Workers KV (CF) và Redis/ioredis (Docker) — `packages/runtime/src/adapters/{cloudflare,docker}/cache.ts`.
- Cache key đã có `siteId` cho schema (`schema:${siteId}:${name}`) và permission (`perm:${siteId}:${principal}`).
- Queue abstraction (BullMQ + Cloudflare Queues), Prometheus metrics (`routes/metrics.ts`), pressure limiter chống quá tải event-loop trên Node (`pressure-limiter.ts`), k6 suite (`apps/cms/k6/`).

### Lỗ hổng chính (tóm tắt — chi tiết trong `requirements.md`)

| Nhóm | Vấn đề | Vị trí |
|------|--------|--------|
| Cache | Delivery API không có cache ở bất kỳ tầng nào (không Cache-Control/ETag/304, không app-cache) | `routes/deliver.ts:345-374` |
| Cache | `PermissionService.invalidate()` là dead code — đổi quyền chỉ "ăn" sau TTL 60s | `services/permission-service.ts:145-154` |
| Cache | ADR-004 (tag-based invalidation) chưa implement; doc mâu thuẫn code | `interfaces/cache.ts` vs ADR-004 |
| Cache | Ghi item không invalidate cache, không dispatch ISR revalidation | `services/item-service.ts` |
| Cache | Không có single-flight/SWR — miss đồng thời dồn hết xuống DB | `schema-service.ts:966-972` |
| Cache | CDC `CacheInvalidator` viết xong nhưng không wire; key thiếu `siteId` | `modules/cdc/cache-invalidator.ts` |
| Cache | Redis adapter nuốt lỗi im lặng — Redis chết = tắt cache không cảnh báo | `docker/cache.ts:33-58` |
| Cache | **Penetration:** `CacheProvider.get` trả `null` cho *miss*, *giá trị null* và *lỗi backend* như nhau → không caller nào cache được kết quả âm dù muốn | `interfaces/cache.ts:2`, `docker/cache.ts:28-37`, `cloudflare/cache.ts:34-36` |
| Cache | **Penetration:** slug/collection không tồn tại → query DB mỗi request, không tombstone; `getCompiled` miss trả `null` và không ghi gì; `resolveCollection` bỏ qua cache hoàn toàn | `deliver.ts:411-420`, `schema-service.ts:1074-1080`, `item-service.ts:642-652` |
| Infra | **Penetration:** `/api/v1/deliver/*` mount **chỉ** `withDb()` — surface public, không xác thực, không rate limit; định danh từ URL và header `X-Lumi-Site` không kiểm hình dạng trước khi vào query | `index.ts:367-368`, `deliver.ts:398`, `tenant.ts:25-29` |
| DB | `count(*)` vô điều kiện trên mọi request list | `item-service.ts:577-581` |
| DB | `UPDATE apiKeys.lastUsedAt` trên MỌI request dùng API key | `middleware/auth.ts:200-208` |
| DB | `requireSetupComplete` query DB mọi request authenticated | `middleware/setup-required.ts:12-19` |
| DB | Lookup `users`/`userSites`/`bundle()` trùng lặp trong middleware chain | `auth.ts`, `site-membership.ts`, `studio-access.ts` |
| DB | `bulk()` write tuần tự N+1, không transaction | `item-service.ts:1079-1097` |
| DB | Thiếu index: `updatedAt` sort, filter trên `data->>field` | `packages/database/src/schema/cms.ts:227-241` |
| Infra | Không có rate limit toàn cục; limiter hiện có là in-memory per-process | `recovery/rate-limit.ts:97` |
| Infra | Flow/LLM chạy synchronous trong request (flow có thể block nhiều phút) | `flow-service.ts:108-126`, `routes/ai.ts` |
| Infra | `--scale cms=3` chạy N bản mọi cron — không leader election | `serve.ts:98-201` |
| Infra | Audit log ghi synchronous trên request thread, có thể double-write | `modules/audit/logger.ts:448-520` |

## 2. Mục tiêu (targets — không phải cam kết; xác nhận bằng k6)

| Chỉ số | Baseline | Sau P0 | Sau P1 | Sau P2 |
|--------|----------|--------|--------|--------|
| Delivery API p95 (cache hit) | p50 1,819ms / p95 2,728ms / p99 3,096ms @ 9.55 RPS (k6, 2026-08-02) | ≤ 50ms tại edge/proxy | ≤ 30ms | ≤ 30ms |
| Origin offload cho delivery đọc lặp | chưa đo (Phase 0 chưa có cache-hit/origin counter) | ≥ 70% (HTTP cache) | ≥ 90% (app + edge cache) | ≥ 90% |
| DB round-trip / request authenticated | chưa đo (k6 chưa xuất DB query metric) | 4–5 | ≤ 3 | ≤ 3 |
| Cửa sổ stale sau khi đổi quyền | chưa đo (không thuộc workload Phase 0) | ≤ 5s | ≤ 1s (event-driven) | ≤ 1s |
| Cửa sổ stale nội dung sau ghi | chưa đo (không invalidation trong workload Phase 0) | n/a | ≤ 5s (tag purge + revalidate) | ≤ 5s |
| Scale ngang Docker | chưa đo (baseline chạy 1 CMS process) | không đổi | không đổi | an toàn với N replica |
| k6 `load-items` throughput | list 45.34 RPS, p50 187ms / p95 552ms / p99 784ms; detail 10.39 RPS, p50 109ms / p95 286ms / p99 409ms; create 18.01 RPS, p50 304ms / p95 679ms / p99 800ms (2026-08-02) | +x% (đo) | +x% (đo) | +x% (đo) |
| DB query / request 404 (slug rác) | 1 (mọi request chạm DB) | ≤ 1 (guard hình dạng chặn phần rác thô) | **0.0308** (k6 `load-penetration.js` 2026-08-01, MISS_POOL=40, 50 RPS × 2m, docker postgres+redis; ≤ 0.05 ✓ — xem `baseline/2026-08-01-penetration-docker-notes.json`) | ≤ 0.05 |

## 3. Các phase

### Phase 0 — Baseline đo đạc (điều kiện tiên quyết, ~1–2 ngày)

- Chạy và lưu kết quả `apps/cms/k6/{smoke,load-items,load-realtime}.js` trên môi trường chuẩn (docker-compose, cấu hình ghi lại trong spec).
- Bật Grafana dashboard sẵn có; chốt số baseline vào bảng §2.
- **Exit:** có số liệu p50/p95/p99 + RPS cho items list/detail/deliver, làm mốc so sánh cho mọi phase sau.

### Phase P0 — Vá nhanh & quick wins (v0.18.x, ~1 sprint)

Nguyên tắc: chỉ các thay đổi nhỏ, rủi ro thấp, không đổi kiến trúc.

| # | Hạng mục | Req |
|---|----------|-----|
| P0.1 | HTTP caching cho Delivery API: ETag + `Cache-Control: s-maxage` + 304 | Req 1 |
| P0.2 | Gọi `PermissionService.invalidate()` tại mọi mutation quyền (roles/policies/api-keys/user-roles) | Req 2 |
| P0.3 | Debounce `UPDATE apiKeys.lastUsedAt` (chỉ ghi khi cũ hơn 60s) | Req 3 |
| P0.4 | Cache process-level cho `requireSetupComplete` (mẫu `adminPathGuard` 5s TTL) | Req 4 |
| P0.5 | `meta` query param cho list — cho phép bỏ `count(*)`; delivery không bao giờ count | Req 5 |
| P0.6 | Body-size limit toàn cục + rate limit cơ bản tầng Caddy | Req 6 |
| P0.7 | Shape guard định danh (nanoid/slug/collection + `X-Lumi-Site`) — chặn khoá rác trước khi chạm DB | Req 19.1–19.3 |

**Exit:** k6 re-run cho thấy cải thiện đo được trên `load-items` và deliver; không regression test suite; cửa sổ stale quyền ≤ 5s (test tự động).

### Phase P1 — Nền tảng cache đúng (v0.19.x, ~2 sprint)

Nguyên tắc: đầu tư kiến trúc cache một lần, dùng lâu dài. Đây là phase trọng tâm.

| # | Hạng mục | Req |
|---|----------|-----|
| P1.1 | Implement ADR-004: `CacheProvider` v2 với `tags` + `invalidateByTag` (Redis SET, KV tag-index), endpoint `POST /api/v1/utils/cache/purge` | Req 7 |
| P1.2 | Content-write invalidation: item create/patch/delete → purge tag + auto `dispatchRevalidation` | Req 8 |
| P1.3 | Single-flight + SWR thật cho schema/permission cache | Req 9 |
| P1.4 | Hợp nhất middleware chain: mỗi request tối đa 1 lần lookup user/membership/bundle | Req 10 |
| P1.5 | Audit log + field-access log chuyển qua queue (giữ fallback sync khi không có queue) | Req 11 |
| P1.6 | Rate limiter phân tán (Redis trên Docker / CF-native trên Workers) cho API surface | Req 12 |
| P1.7 | Cache observability: hit/miss/error metrics wired vào adapter, health degraded khi cache backend lỗi | Req 13 |
| P1.8 | Application-level cache cho delivery page (tag-based, đứng sau HTTP cache) | Req 8 |
| P1.9 | Negative cache (tombstone) + rate limit theo IP cho `/deliver/*` — cần P1.1 vì interface hiện tại không biểu diễn được "đã biết là không có" | Req 19.4–19.15 |

**Exit:** hai-site smoke test cache isolation pass (DoD 2b); purge-by-tag round-trip test pass trên cả 2 adapter; k6 cho thấy origin offload ≥ 90% cho delivery đọc lặp; cache error rate có alert.

### Phase P2 — Scale-out an toàn (v0.20.x, ~2 sprint)

| # | Hạng mục | Req |
|---|----------|-----|
| P2.1 | Tách worker role: `serve.ts --role=web\|worker\|all`; cron/queue consumer chỉ chạy ở worker; leader election bằng Redis lock cho cron | Req 14 |
| P2.2 | Flow & AI chat chạy async qua queue + endpoint trạng thái (poll/SSE) | Req 15 |
| P2.3 | Index bổ sung (`updatedAt` composite, expression index JSONB); `bulk()` batch + transaction; write path item+revision+activity transactional | Req 16 |
| P2.4 | Quyết định CDC `CacheInvalidator`: wire đúng (key có siteId, namespace khớp) hoặc xoá | Req 17 |
| P2.5 | k6 thresholds vào CI (perf regression gate) | Req 18 |

**Exit:** chạy `--scale cms=3` không nhân bản cron (test bằng counter side-effect); flow dài không giữ HTTP connection; k6 gate xanh trong CI.

## 4. Thứ tự phụ thuộc

```
Phase 0 (baseline)
   │
   ▼
P0.1─P0.6 (độc lập nhau, làm song song được)
   │
   ▼
P1.1 (CacheProvider v2) ──► P1.2, P1.8 (cần tags)
P1.3, P1.4, P1.5, P1.6, P1.7 (độc lập với P1.1, song song được)
   │
   ▼
P2.1 ──► P2.2 (flow async cần worker process rõ ràng)
P2.3, P2.4, P2.5 (độc lập)
```

## 5. Rủi ro & giảm thiểu

| Rủi ro | Giảm thiểu |
|--------|-----------|
| Đổi default `meta` trên list làm gãy Studio/SDK | Req 5 giữ default cũ, chỉ thêm opt-out; Studio/SDK cập nhật dùng param mới |
| Tag-index trên KV eventually-consistent (~60s) → purge chậm trên CF | Chấp nhận + ghi rõ trong docs; delivery dùng `s-maxage` ngắn (60s) làm chặn trên; Redis path purge tức thời |
| HTTP cache trả nội dung draft/preview | Req 1: chỉ cache response public đã publish; request có Authorization/preview → `Cache-Control: private, no-store` |
| Queue không được cấu hình (minimal deploy) | Mọi async path giữ fallback synchronous hiện có; spec chỉ đổi đường ưu tiên |
| Middleware refactor (P1.4) đụng security guard | Tripwire `security-guards.wiring.test.ts` phải giữ nguyên; thêm behavioural test trước khi refactor (DoD 2c) |
| Leader-election lock chết giữa chừng | Lock TTL + renew; cron tick vốn được thiết kế idempotent (`serve.ts:166-201`) làm lưới an toàn thứ hai |
| Tombstone làm tài nguyên vừa tạo "biến mất" tới 30s | Req 19.7: write path xoá tombstone sau commit — TTL chỉ là lưới an toàn; test P19 chặn regression |
| Tombstone hết hạn hàng loạt → penetration biến thành avalanche | Jitter ±20% trên TTL (design §14.4); tombstone không bao giờ TTL cố định |
| Guard hình dạng chặn nhầm slug hợp lệ của user hiện có | Regex chốt từ dữ liệu thật trước khi bật; slug ngoài `[a-z0-9/_-]` phải được khảo sát trên DB production-like ở task 22.1, không suy đoán |
| Rate limit theo IP vô dụng khi traffic đến sau CDN (ít IP egress) | **§21.6 CHỐT:** giữ 1200; tầng 1+2 vẫn hiệu lực; synthetic single-IP load test dùng `LUMIBASE_DELIVER_RATE_LIMIT=0` |

## 6. Ngoài phạm vi (non-goals)

- Không đổi database engine / không thêm read-replica routing (theo dõi riêng nếu cần sau P2).
- Không xây CDN configuration cho khách hàng (chỉ phát đúng header để CDN bất kỳ hoạt động).
- Không đổi realtime hub architecture (adapter pub/sub được đánh giá riêng).
- Không tối ưu Studio (frontend) — spec này chỉ phủ CMS backend + proxy.
