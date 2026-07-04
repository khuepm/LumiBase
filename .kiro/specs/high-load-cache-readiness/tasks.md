# Implementation Plan — High-Load & Cache Readiness

## Overview

Kế hoạch triển khai theo 4 phase tuần tự (0 → P0 → P1 → P2) khớp `roadmap.md`. Mỗi task gắn ref requirement (`requirements.md`) và section design (`design.md`). Trong một phase, các task đánh số khác nhau độc lập và làm song song được trừ khi ghi rõ phụ thuộc. Mọi task hoàn thành phải qua DoD (`.kiro/steering/definition-of-done.md`) — đặc biệt 2b (multi-tenant) cho mọi task đụng cache/queue/lock key.

## Tasks

### Phase 0 — Baseline (tiên quyết, chặn mọi phase sau)

- [ ] 0. Baseline đo đạc
  - [ ] 0.1 Viết k6 scenario `apps/cms/k6/load-deliver.js`: 90% GET `/deliver/page/:site/:slug` phân phối zipf trên ≥50 slug seed, 10% list items; xuất summary JSON (Req 0.2; design §13.3)
  - [ ] 0.2 Dựng dataset seed chuẩn (script `apps/cms/k6/seed.ts`): 2 site × 5 collection × 100k items site chính — dùng luôn cho EXPLAIN ở task 14.1 (Req 0.1, 16.2)
  - [ ] 0.3 Chạy `smoke.js`, `load-items.js`, `load-realtime.js`, `load-deliver.js` trên docker-compose chuẩn; lưu kết quả + mô tả cấu hình vào `.kiro/specs/high-load-cache-readiness/baseline/` (Req 0.1)
  - [ ] 0.4 Điền cột Baseline bảng `roadmap.md` §2 bằng số đo thực (Req 0.3)

### Phase P0 — Vá nhanh & quick wins (v0.18.x)

- [ ] 1. HTTP caching cho Delivery API
  - [x] 1.1 Thêm helper ETag (`apps/cms/src/services/delivery-cache.ts`): weak ETag SHA-256 từ fingerprint (siteId + slug + provenance + page.updatedAt + max(items.updatedAt) + visibleCount có publish-window); unit test ổn định + đổi khi input đổi (Req 1.2; design §3.2) — `services/__tests__/delivery-cache.test.ts`
  - [x] 1.2 Sửa `routes/deliver.ts`: phân loại cacheable/non-cacheable (Authorization); set `Cache-Control` theo env `LUMIBASE_DELIVER_SMAXAGE`/`LUMIBASE_DELIVER_SWR` (default 60/300, `0` tắt), `ETag`, `Vary: X-Lumi-Site`; `If-None-Match` → 304 KHÔNG hydrate sections (Req 1.1–1.5; design §3.1)
  - [ ] 1.3 Thêm `runtime.edgeCache` adapter mỏng (CF: `caches.default` match/put; Docker: no-op) trong `packages/runtime`; wire vào deliver route qua abstraction, không import binding trong route (Req 1.6; design §3.1)
  - [x] 1.4 Route-level test matrix: same-ETag, 304 + đếm query, ETag đổi khi content đổi, no-store khi có Authorization, 404 no-store (Req 1.7; design §13.2) — `__tests__/deliver-http-cache.test.ts` (Properties P1–P3)
  - [x] 1.5 Cập nhật `docs/en/api/hono-api-spec.md` (bảng header, hành vi 304, env knobs) (DoD mục 4)

- [ ] 2. Permission cache invalidation (key versioning)
  - [x] 2.1 Refactor `services/permission-service.ts`: key `perm:${siteId}:v${n}:${principal}`, đọc version từ `perm-ver:${siteId}` (vắng → 1); thêm static `PermissionService.bumpVersion(cache, siteId)`; xoá `invalidate()` cũ (dead code) (Req 2.2, 2.6; design §5.1)
  - [x] 2.2 Gọi bump sau commit tại mutation quyền: `roles.ts` (7 handler), `policies.ts` (8), `api-keys.ts` (rotate/revoke/roles±/policies±), `users.ts` (invite/patch-role/remove), `access.ts` (config import), `AccessService` (AI-harness skills, nhận `cache` dep, wire tại `mcp.ts`). CỐ Ý bỏ qua: SCIM userSites insert (membership không roleId → bundle không đổi), `auth.ts` self-provision (user mới, chưa có bundle cache) (Req 2.1, 2.3)
  - [ ] 2.3 Integration test với Postgres thật: thu hồi quyền API key → request kế tiếp 403 ngay, không chờ TTL (Req 2.5; design §13.1) — cần môi trường DB; unit-level đã phủ bằng `permission-cache-versioning.test.ts` (bump → recompile, two-site isolation)
  - [x] 2.4 Giữ TTL 60s làm safety net; bump lỗi/cache vắng không fail mutation (test tolerance) (Req 2.4)

- [ ] 3. API-key lastUsed debounce
  - [ ] 3.1 Sửa `middleware/auth.ts` API-key path: chỉ schedule UPDATE khi `lastUsedAt` cũ hơn `LUMIBASE_APIKEY_TOUCH_INTERVAL` (default 60s); ghi ngoài response path (waitUntil/fire-and-forget có catch) (Req 3.1–3.2; design §6.2)
  - [ ] 3.2 Unit test: 100 request/60s cùng key = 1 UPDATE; sự kiện security denied vẫn ghi đồng bộ (Req 3.3–3.4)

- [ ] 4. Setup-state process cache
  - [ ] 4.1 Extract helper `createProcessCache(ttlMs)` dùng chung với pattern `admin-path-guard`; áp vào `middleware/setup-required.ts` — `initialized` cache vĩnh viễn, `uninitialized` TTL 5s (Req 4.1–4.3; design §6.3)
  - [ ] 4.2 Chạy lại toàn bộ setup-flow test hiện có, không sửa assertion (Req 4.4)

- [ ] 5. Count opt-in trên list
  - [ ] 5.1 Thêm query param `meta=total_count|none` vào items list route + `ItemService.list` (`wantTotal`); default `total_count` (Req 5.1–5.3; design §6.1)
  - [ ] 5.2 Test khoá hành vi: delivery route không bao giờ count (Req 5.4)
  - [ ] 5.3 SDK: option `meta` trên list; Studio: các list view không hiển thị tổng chuyển sang `meta=none` (Req 5.5–5.6)
  - [ ] 5.4 Docs `hono-api-spec.md` + rà tutorial compatibility (default không đổi → dự kiến không đụng tutorial; ghi kết luận rà soát vào PR) (DoD mục 5)

- [ ] 6. Proxy & body limits
  - [ ] 6.1 Caddyfile: `request_body max_size` global 10MB + matcher media dùng `FILE_UPLOAD_MAX_BYTES`; comment tuning (Req 6.1; design §11)
  - [ ] 6.2 App-level JSON body limit middleware (`LUMIBASE_MAX_JSON_BODY` default 1MB, 413 envelope chuẩn) — chốt open question §21.3 (Caddy plugin hay app-level) trước khi làm phần rate limit Caddy (Req 6.2–6.3)
  - [ ] 6.3 Docs `docs/en/deployment/docker.md`: knob mới + khuyến nghị theo kích thước deploy (Req 6.4)

- [ ] 7. Chốt phase P0
  - [ ] 7.1 Re-run k6 suite, điền bảng roadmap §2 cột "Sau P0" (Req 0.3)
  - [ ] 7.2 Rà DoD theo `dod-review.md`: typecheck, test toàn workspace, Setup Impact Registry (dòng rà soát cho các thay đổi P0), tutorial impact (dod-review §5), CHANGELOG

### Phase P1 — Nền tảng cache (v0.19.x)

- [ ] 8. Cache Provider v2 (chặn task 9, 10)
  - [ ] 8.1 Mở rộng interface `packages/runtime/src/interfaces/cache.ts`: `CacheSetOptions{ttl,tags}`, `invalidateByTag`, hook `onEvent` (Req 7.1, 13.1; design §4.1)
  - [ ] 8.2 Redis adapter: tag qua `SADD lumi:tag:{tag}` + pipeline DEL khi invalidate; emit `onEvent` mọi op kể cả error (hết nuốt lỗi im lặng) (Req 7.2, 13.2; design §4.2)
  - [ ] 8.3 KV adapter: tag-index entry JSON; docs ghi rõ eventual consistency ~60s (Req 7.3; design §4.3)
  - [ ] 8.4 Thay `InMemoryCacheProvider` (Map không TTL trong `cdc/cache-invalidator.ts`) bằng LRU provider đúng contract tại `packages/runtime` (max entries cấu hình, tôn trọng TTL) (Req 7.6)
  - [ ] 8.5 Contract test suite chạy chung 2 adapter + LRU (set/tags/invalidateByTag/ttl); unit test quét codebase: mọi tag literal chứa `${siteId}` (Req 7.4, 7.8; design §13.1)
  - [ ] 8.6 Endpoint `POST /api/v1/utils/cache/purge` admin-only, thêm vào `CONTROL_PLANE_PATHS`, ép tiền tố site; test guard wiring (Req 7.5; design §4.4; DoD 2c)
  - [ ] 8.7 Cập nhật ADR-004 trạng thái implemented, khớp code (Req 7.7)

- [ ] 9. Content invalidation + revalidation (cần task 8)
  - [ ] 9.1 `ItemService` create/patch/softDelete: sau commit gọi `invalidateByTag('items:'+siteId+':'+collection)`; lỗi → metric + warn, không fail request (Req 8.1; design §3.3)
  - [ ] 9.2 App-cache cho deliver page: key `deliver:${siteId}:${slug}:${variantHash}`, tags theo collections cấu thành, TTL 300s; wire vào route trước DB query (Req 8.2; design §3.1)
  - [ ] 9.3 Schema apply purge thêm tag `deliver:${siteId}` (Req 8.5)
  - [ ] 9.4 Auto revalidation: item mutation → enqueue `revalidation-dispatch` (fallback waitUntil/fire-and-forget); sửa `revalidation.ts` sang `Promise.allSettled` + metric per target (Req 8.3–8.4)
  - [ ] 9.5 Two-site isolation test: mutation site A không purge entry site B (Req 8.6; DoD 2b two-site smoke)

- [ ] 10. Single-flight + SWR (cần task 8)
  - [ ] 10.1 Helper `createSwrCache` trong `packages/runtime/src/cache-helpers.ts` (soft/hard TTL, in-flight map, schedule hook) + JSDoc phạm vi per-instance (Req 9.1–9.2, 9.4; design §5.2)
  - [ ] 10.2 Chuyển `SchemaService.getCompiled` (300/900) và `PermissionService.bundle` (30/60) sang helper; sửa comment "SWR-style" sai (Req 9.2)
  - [ ] 10.3 Unit test fake-timer: 50 concurrent get = 1 compute; stale-serve trong soft-hard; blocking sau hard (Req 9.3; design §13.1)

- [ ] 11. Middleware consolidation
  - [ ] 11.1 Viết TRƯỚC behavioural matrix test (principal × route → status) chạy trên code hiện tại, merge riêng (Req 10.3; design §6.4)
  - [ ] 11.2 Refactor: `withAuth` set Request_Context_Bundle; `withSiteMembership`/`withStudioAccess` đọc từ context, chỉ query khi vắng; tripwire `security-guards.wiring.test.ts` giữ nguyên (Req 10.1–10.2)
  - [ ] 11.3 Query-count test: đếm query qua logger postgres-js, assert ≤3/request content-plane điển hình (Req 10.4)

- [ ] 12. Async audit
  - [ ] 12.1 Topic `audit-log` + worker batch (100 event/1s, multi-row INSERT, uuidv7) (Req 11.1; design §7)
  - [ ] 12.2 `AuditLogger`: ưu tiên enqueue; fallback sync bỏ race-1000ms (await trọn), fallback stderr + counter giữ nguyên (Req 11.2, 11.4)
  - [ ] 12.3 Field-access log (PII/PHI) đi cùng topic (Req 11.3)
  - [ ] 12.4 Integration test: 100 mutation = 100 row ≤5s; kill queue giữa chừng không mất event (Req 11.5)

- [ ] 13. Distributed rate limiter
  - [ ] 13.1 Interface `RateLimiterProvider` + adapter Redis (INCR+EXPIRE NX) + adapter CF (binding, fallback memory + warn) trong `packages/runtime` (Req 12.1; design §8)
  - [ ] 13.2 Middleware `/api/v1`: key `rl:${siteId}:${principal}`, default 600/phút (`LUMIBASE_API_RATE_LIMIT`), 429 + `Retry-After`; skip health/metrics/deliver (Req 12.3)
  - [ ] 13.3 Migrate recovery limiter + setup `/state` limiter; cập nhật docstring (Req 12.2)
  - [ ] 13.4 Login-guard counter backend Redis qua provider, Postgres fallback (Req 12.4)
  - [ ] 13.5 Two-instance test chia sẻ budget (Req 12.5; design §13.1)

- [ ] 14. Cache observability
  - [ ] 14.1 Wire `onEvent` → `cacheOperationsTotal` Prometheus (Req 13.1)
  - [ ] 14.2 Health cache probe 3 trạng thái ok/degraded/down; `/health/ready` degraded khi error >50%/60s (Req 13.3)
  - [ ] 14.3 Grafana panels (hit-rate, error-rate, invalidation theo tag prefix) + Prometheus alert rules mẫu (Req 13.4–13.5)

- [ ] 15. Chốt phase P1
  - [ ] 15.1 Re-run k6; kiểm origin offload delivery ≥90% trên `load-deliver.js`; điền roadmap §2
  - [ ] 15.2 Rà DoD đầy đủ theo `dod-review.md` (2b two-site smoke cho toàn bộ cache/tag/rl key mới; Setup Impact Registry; CHANGELOG; docs; viết mục Multi-tenancy trong `docs/en/features/caching.md`)
  - [ ] 15.3 DoD evolution (dod-review §6): đề xuất thêm dòng checklist "ghi dữ liệu được cache theo tag → phải purge + test stale" vào DoD 2b trong cùng PR đóng phase, kèm blockquote sự cố invalidate-dead-code; maintainer chốt nhận hay ghi lý do từ chối

### Phase P2 — Scale-out (v0.20.x)

- [ ] 16. Worker role + leader lock (chặn task 17)
  - [ ] 16.1 `serve.ts` đọc `LUMIBASE_PROCESS_ROLE` (web/worker/all, default all); worker mở health port riêng (Req 14.1; design §10.1)
  - [ ] 16.2 `withLeaderLock(jobName, ttl, fn)` — Redis SET NX PX + renew cho job dài; không Redis → chạy thẳng + warn một-lần (Req 14.2–14.3; design §10.2)
  - [ ] 16.3 Compose profile `cms-web` + `cms-worker`; cập nhật `DEPLOYMENT-CHECKLIST.md` thay khuyến nghị `--scale cms=3` (Req 14.4)
  - [ ] 16.4 Test: 2 process × 3 tick cron test = 3 side-effect (Req 14.5; design §13.2)

- [ ] 17. Flow/AI async (cần task 16)
  - [ ] 17.1 Migration bảng `flow_runs` (nanoid, siteId NOT NULL, status, result, error, timestamps; index `(siteId, flowId, createdAt)`; RLS site_isolation) (Req 15.2; design §10.3; DoD 2b)
  - [ ] 17.2 `POST /flows/:id/run` → 202 + enqueue khi có queue; worker consumer chạy engine, update row; `GET /flows/runs/:runId` site-scoped (Req 15.1–15.2)
  - [ ] 17.3 Sync fallback bọc `AbortSignal.timeout(LUMIBASE_FLOW_SYNC_TIMEOUT=30s)`; op `sleep`/`http` nhận signal (Req 15.3)
  - [ ] 17.4 AI chat `Prefer: respond-async` (chốt open question §21.5: tái dùng flow_runs hay bảng riêng); HITL semantics không đổi — test approvals vẫn chặn (Req 15.4, 15.6)
  - [ ] 17.5 Studio: flow builder + AI panel poll/SSE (Req 15.5)

- [ ] 18. DB index + transactional writes
  - [ ] 18.1 Spike xác nhận tương tác transaction tường minh ↔ `withRls` set_config trên cả 3 connection path (open question §21.4); test RLS-trong-tx (design §12, Property 16)
  - [ ] 18.2 EXPLAIN ANALYZE trên dataset seed 100k (task 0.2) cho list default-sort và deliver publish-window; chốt cột index (Req 16.2)
  - [ ] 18.3 Migration: `items_site_coll_updated_idx` + `items_deliver_idx` (partial); ghi chú CONCURRENTLY trong CHANGELOG upgrade steps (Req 16.1–16.3)
  - [ ] 18.4 `bulk()`: transaction + multi-row insert chunk ≤100 + side-effect gom sau commit + `LUMIBASE_BULK_MAX=500` → 413 (Req 16.4)
  - [ ] 18.5 Create/patch đơn: transaction bao item+revision+activity (audit ở ngoài, đi queue) (Req 16.5)
  - [ ] 18.6 Docs `docs/en/deployment/performance.md`: hướng dẫn operator tự tạo expression index cho `data->>field` nóng, kèm SQL mẫu (Req 16.6)

- [ ] 19. CDC CacheInvalidator resolution
  - [ ] 19.1 Xác nhận phương án B (remove) với maintainer — open question §21.1 (Req 17.1, 17.3)
  - [ ] 19.2 Nếu B: xoá `cache-invalidator.ts` + property test + barrel export; ADR ngắn ghi lý do + điều kiện tái mở. Nếu A: viết lại key derive có siteId + wire vào pipeline + two-site test (Req 17.1–17.2)

- [ ] 20. CI perf gate
  - [ ] 20.1 Workflow nightly/label-triggered: compose up → k6 smoke + load-deliver với thresholds = baseline×1.2 → upload summary artifact (Req 18.1–18.3; design §13.3)
  - [ ] 20.2 Docs contributing: chạy local, quy trình đổi threshold có chủ đích (Req 18.4)

- [ ] 21. Chốt chương trình
  - [ ] 21.1 Re-run toàn bộ k6, hoàn tất bảng roadmap §2; so sánh với target — chênh lệch ghi nhận công khai, không sửa số
  - [ ] 21.2 Rà DoD lần cuối toàn chương trình theo `dod-review.md`; Setup Impact Registry dòng tổng (dự kiến `n/a` + ghi chú migration index); tutorial impact cho flow 202-contract (dod-review §5); CHANGELOG + README release policy
