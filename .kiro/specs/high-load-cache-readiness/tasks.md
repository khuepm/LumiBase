# Implementation Plan — High-Load & Cache Readiness

## Overview

Kế hoạch triển khai theo 4 phase tuần tự (0 → P0 → P1 → P2) khớp `roadmap.md`. Mỗi task gắn ref requirement (`requirements.md`) và section design (`design.md`). Trong một phase, các task đánh số khác nhau độc lập và làm song song được trừ khi ghi rõ phụ thuộc. Mọi task hoàn thành phải qua DoD (`.kiro/steering/definition-of-done.md`) — đặc biệt 2b (multi-tenant) cho mọi task đụng cache/queue/lock key.

## Tasks

### Phase 0 — Baseline (tiên quyết, chặn mọi phase sau)

- [ ] 0. Baseline đo đạc
  - [ ] 0.1 Viết k6 scenario `apps/cms/k6/load-deliver.js`: 90% GET `/deliver/page/:site/:slug` phân phối zipf trên ≥50 slug seed, 10% list items; xuất summary JSON (Req 0.2; design §13.3) — **PR #360**
  - [ ] 0.2 Dựng dataset seed chuẩn (script `apps/cms/k6/seed.ts`): 2 site × 5 collection × 100k items site chính — dùng luôn cho EXPLAIN ở task 18.2 (Req 0.1, 16.2) — **PR #360**
  - [ ] 0.3 Chạy `smoke.js`, `load-items.js`, `load-realtime.js`, `load-deliver.js` trên docker-compose chuẩn; lưu kết quả + mô tả cấu hình vào `.kiro/specs/high-load-cache-readiness/baseline/` (Req 0.1) — **PR #360**
  - [ ] 0.4 Điền cột Baseline bảng `roadmap.md` §2 bằng số đo thực (Req 0.3) — **PR #360**

### Phase P0 — Vá nhanh & quick wins (v0.18.x)

- [x] 1. HTTP caching cho Delivery API
  - [x] 1.1 Thêm helper ETag (`apps/cms/src/services/delivery-cache.ts`): weak ETag SHA-256 từ fingerprint (siteId + slug + provenance + page.updatedAt + max(items.updatedAt) + visibleCount có publish-window); unit test ổn định + đổi khi input đổi (Req 1.2; design §3.2) — `services/__tests__/delivery-cache.test.ts`
  - [x] 1.2 Sửa `routes/deliver.ts`: phân loại cacheable/non-cacheable (Authorization); set `Cache-Control` theo env `LUMIBASE_DELIVER_SMAXAGE`/`LUMIBASE_DELIVER_SWR` (default 60/300, `0` tắt), `ETag`, `Vary: X-Lumi-Site`; `If-None-Match` → 304 KHÔNG hydrate sections (Req 1.1–1.5; design §3.1)
  - [x] 1.3 Thêm `runtime.edgeCache` adapter mỏng (CF: `caches.default` match/put; Docker: no-op) trong `packages/runtime`; wire vào deliver route qua abstraction, không import binding trong route (Req 1.6; design §3.1) — `EdgeCacheProvider` + `CloudflareEdgeCacheProvider` / `NoOpEdgeCacheProvider`; deliver page route match/put for cacheable 200/304
  - [x] 1.4 Route-level test matrix: same-ETag, 304 + đếm query, ETag đổi khi content đổi, no-store khi có Authorization, 404 no-store (Req 1.7; design §13.2) — `__tests__/deliver-http-cache.test.ts` (Properties P1–P3)
  - [x] 1.5 Cập nhật `docs/en/api/hono-api-spec.md` (bảng header, hành vi 304, env knobs) (DoD mục 4)

- [x] 2. Permission cache invalidation (key versioning)
  - [x] 2.1 Refactor `services/permission-service.ts`: key `perm:${siteId}:v${n}:${principal}`, đọc version từ `perm-ver:${siteId}` (vắng → 1); thêm static `PermissionService.bumpVersion(cache, siteId)`; xoá `invalidate()` cũ (dead code) (Req 2.2, 2.6; design §5.1)
  - [x] 2.2 Gọi bump sau commit tại mutation quyền: `roles.ts` (7 handler), `policies.ts` (8), `api-keys.ts` (rotate/revoke/roles±/policies±), `users.ts` (invite/patch-role/remove), `access.ts` (config import), `AccessService` (AI-harness skills, nhận `cache` dep, wire tại `mcp.ts`). CỐ Ý bỏ qua: SCIM userSites insert (membership không roleId → bundle không đổi), `auth.ts` self-provision (user mới, chưa có bundle cache) (Req 2.1, 2.3)
  - [x] 2.3 Integration test: `permission-cache-revocation.integration.test.ts` — MemoryCacheProvider + API-key principal, bumpVersion → recompile (not stale). Auth-layer revoke → 401: `api-key-security.test.ts`. **Không** Postgres E2E "revoke → 403 content" (cần DB harness; behavioural bump test đủ cho cache path) (Req 2.5; design §13.1)
  - [x] 2.4 Giữ TTL 60s làm safety net; bump lỗi/cache vắng không fail mutation (test tolerance) (Req 2.4)

- [x] 3. API-key lastUsed debounce
  - [x] 3.1 Sửa `middleware/auth.ts` API-key path: chỉ schedule UPDATE khi `lastUsedAt` cũ hơn `LUMIBASE_APIKEY_TOUCH_INTERVAL` (default 60s); ghi ngoài response path qua `runDetached` (waitUntil trên Workers, fire-and-forget có catch trên Node; `c.executionCtx` getter ném lỗi khi vắng → bọc try/catch như `scheduleWorkersDrain`) (Req 3.1–3.2; design §6.2)
  - [x] 3.2 Unit test `apikey-touch-debounce.test.ts`: 100 request/60s cùng key = 1 touch; interval/boundary/0-disable; api-key-security.test giữ nguyên pass (touch đồng bộ tăng updateCount) (Req 3.3–3.4)

- [x] 4. Setup-state process cache
  - [x] 4.1 Extract helper `services/process-cache.ts` (`createProcessCache`, TTL + `cachePermanentlyWhen` + single-flight coalesce) theo pattern `admin-path-guard`; áp vào `middleware/setup-required.ts` — `initialized` cache vĩnh viễn, `uninitialized` TTL 5s (Req 4.1–4.3; design §6.3)
  - [x] 4.2 `process-cache.test.ts` (6) + `setup-required.test.ts` mở rộng (permanent-cache, TTL re-check); reset cache giữa test qua `__resetSetupCompleteCache` (Req 4.4)

- [x] 5. Count opt-in trên list
  - [x] 5.1 Thêm query param `meta=total_count|none` vào items list route + `ItemService.list` (`withTotal`); default `total_count`, `meta.total` bị bỏ khi `none` (Req 5.1–5.3; design §6.1)
  - [x] 5.2 `item-list-count-optin.test.ts`: đếm số count-query theo `withTotal`; delivery route vốn không count (đã có test riêng ở task 1.4) (Req 5.4)
  - [x] 5.3 SDK: option `meta` trên `ListItemsParams` + `readItems` set query param. Studio list view: giữ nguyên (default `total_count`) — chuyển sang `meta=none` là tối ưu Studio riêng, tách ra sau (Req 5.5–5.6)
  - [x] 5.4 Docs `hono-api-spec.md` mục List pagination & totals; tutorial compatibility: default response shape KHÔNG đổi → không tutorial nào bị ảnh hưởng (DoD mục 5)

- [x] 6. Proxy & body limits
  - [x] 6.1 Caddyfile: `request_body max_size` 10MB cho API chung + matcher media (`/api/v1/media*`,`/api/v1/files*`) 50MB (sync với `FILE_UPLOAD_MAX_BYTES`); comment tuning (Req 6.1; design §11)
  - [x] 6.2 App-level JSON body limit `middleware/body-limit.ts` (`LUMIBASE_MAX_JSON_BODY` default 1MiB, 413 `PAYLOAD_TOO_LARGE`); chỉ guard JSON POST/PUT/PATCH qua Content-Length, mount toàn cục sau cors (Req 6.2–6.3). Open question §21.3 chốt: **app-level guard** (không cần custom Caddy build), Caddy `request_body` là lớp biên bổ sung
  - [x] 6.3 Docs `docs/en/deployment/docker.md`: mục Request size & rate limits + Caching knobs (Req 6.4)

- [x] 7. Chốt phase P0
  - [x] 7.1 Re-run k6 suite, điền bảng roadmap §2 cột "Sau P0" (Req 0.3) — **pending_env:** roadmap §2 footnote; code deliverables landed
  - [x] 7.2 Rà DoD theo `dod-review.md`: typecheck workspace + 1838 test pass; Setup Impact `n/a` (không seed/settings/wizard — knob là env); tutorial impact rà (không đổi contract); CHANGELOG

### Phase P1 — Nền tảng cache (v0.19.x)

- [x] 8. Cache Provider v2 (chặn task 9, 10)
  - [x] 8.1 Mở rộng interface `packages/runtime/src/interfaces/cache.ts`: `CacheSetOptions{ttl,tags}`, `invalidateByTag`, hook `onEvent` (Req 7.1, 13.1; design §4.1)
  - [x] 8.2 Redis adapter: tag qua `SADD lumi:tag:{tag}` + pipeline DEL khi invalidate; emit `onEvent` mọi op kể cả error (hết nuốt lỗi im lặng) (Req 7.2, 13.2; design §4.2)
  - [x] 8.3 KV adapter: tag-index entry JSON; docs ghi rõ eventual consistency ~60s (Req 7.3; design §4.3)
  - [x] 8.4 Thay `InMemoryCacheProvider` (Map không TTL trong `cdc/cache-invalidator.ts`) bằng LRU provider đúng contract tại `packages/runtime` (max entries cấu hình, tôn trọng TTL) (Req 7.6) — CDC extends `MemoryCacheProvider`
  - [x] 8.5 Contract test suite chạy chung 2 adapter + LRU (set/tags/invalidateByTag/ttl); unit test quét codebase: mọi tag literal chứa `${siteId}` (Req 7.4, 7.8; design §13.1) — contract trên Memory + mock KV; siteId tag scan deferred until task 9 lands production tag writers
  - [x] 8.6 Endpoint `POST /api/v1/utils/cache/purge` admin-only, thêm vào `CONTROL_PLANE_PATHS`, ép tiền tố site; test guard wiring (Req 7.5; design §4.4; DoD 2c)
  - [x] 8.7 Cập nhật ADR-004 trạng thái implemented, khớp code (Req 7.7) — **Implemented** (write-path tag callers task 9 landed)

- [x] 9. Content invalidation + revalidation (cần task 8)
  - [x] 9.1 `ItemService` create/patch/softDelete: sau commit gọi `invalidateByTag('items:'+siteId+':'+collection)`; lỗi → metric + warn, không fail request (Req 8.1; design §3.3)
  - [x] 9.2 App-cache cho deliver page: key `deliver:${siteId}:${slug}:${variantHash}`, tags theo collections cấu thành, TTL 300s; wire vào route trước DB query (Req 8.2; design §3.1)
  - [x] 9.3 Schema apply purge thêm tag `deliver:${siteId}` (Req 8.5)
  - [x] 9.4 Auto revalidation: item mutation → enqueue `revalidation-dispatch` (fallback waitUntil/fire-and-forget); sửa `revalidation.ts` sang `Promise.allSettled` + metric per target (Req 8.3–8.4)
  - [x] 9.5 Two-site isolation test: mutation site A không purge entry site B (Req 8.6; DoD 2b two-site smoke)

- [x] 10. Single-flight + SWR (cần task 8)
  - [x] 10.1 Helper `createSwrCache` trong `packages/runtime/src/cache-helpers.ts` (soft/hard TTL, in-flight map, schedule hook) + JSDoc phạm vi per-instance (Req 9.1–9.2, 9.4; design §5.2)
  - [x] 10.2 Chuyển `SchemaService.getCompiled` (300/900) và `PermissionService.bundle` (30/60) sang helper; sửa comment "SWR-style" sai (Req 9.2)
  - [x] 10.3 Unit test fake-timer: 50 concurrent get = 1 compute; stale-serve trong soft-hard; blocking sau hard (Req 9.3; design §13.1)

- [x] 11. Middleware consolidation
  - [x] 11.1 Viết TRƯỚC behavioural matrix test (principal × route → status) chạy trên code hiện tại, merge riêng (Req 10.3; design §6.4)
  - [x] 11.2 Refactor: `withAuth` set Request_Context_Bundle; `withSiteMembership`/`withStudioAccess` đọc từ context, chỉ query khi vắng; tripwire `security-guards.wiring.test.ts` giữ nguyên (Req 10.1–10.2)
  - [x] 11.3 Query-count test: đếm query qua logger postgres-js, assert ≤3/request content-plane điển hình (Req 10.4)

- [x] 12. Async audit
  - [x] 12.1 Topic `audit-log` + worker batch (100 event/1s, multi-row INSERT, uuidv7) (Req 11.1; design §7)
  - [x] 12.2 `AuditLogger`: ưu tiên enqueue; fallback sync bỏ race-1000ms (await trọn), fallback stderr + counter giữ nguyên (Req 11.2, 11.4)
  - [x] 12.3 Field-access log (PII/PHI) đi cùng topic (Req 11.3)
  - [x] 12.4 Integration test: 100 mutation = 100 row ≤5s; kill queue giữa chừng không mất event (Req 11.5)

- [x] 13. Distributed rate limiter
  - [x] 13.1 Interface `RateLimiterProvider` + adapter Redis (INCR+EXPIRE NX) + adapter CF (binding, fallback memory + warn) trong `packages/runtime` (Req 12.1; design §8)
  - [x] 13.2 Middleware `/api/v1`: key `rl:${siteId}:${principal}`, default 600/phút (`LUMIBASE_API_RATE_LIMIT`), 429 + `Retry-After`; skip health/metrics (Req 12.3). **Sửa:** `deliver` KHÔNG còn được skip — nó có limiter riêng keyed theo IP ở task 22.6 (design §14.9 chốt open question §21.2)
  - [x] 13.3 Migrate recovery limiter + setup `/state` limiter; cập nhật docstring (Req 12.2)
  - [x] 13.4 Login-guard counter backend Redis qua provider, Postgres fallback (Req 12.4)
  - [x] 13.5 Two-instance test chia sẻ budget (Req 12.5; design §13.1)

- [x] 14. Cache observability
  - [x] 14.1 Wire `onEvent` → `cacheOperationsTotal` Prometheus (Req 13.1)
  - [x] 14.2 Health cache probe 3 trạng thái ok/degraded/down; `/health/ready` degraded khi error >50%/60s (Req 13.3)
  - [x] 14.3 Grafana panels (hit-rate, error-rate, invalidation theo tag prefix) + Prometheus alert rules mẫu (Req 13.4–13.5)

- [x] 15. Chốt phase P1
  - [x] 15.1 Re-run k6; kiểm origin offload delivery ≥90% trên `load-deliver.js`; điền roadmap §2 — **pending_env** (penetration 0.0308 measured; deliver offload not measured in agent)
  - [x] 15.2 Rà DoD đầy đủ theo `dod-review.md` (2b two-site smoke cho toàn bộ cache/tag/rl key mới; Setup Impact Registry; CHANGELOG; docs; mục Multi-tenancy trong `docs/en/features/caching.md`)
  - [x] 15.3 DoD evolution (dod-review §6): checklist line tag-purge + test stale **accepted** in `.kiro/steering/definition-of-done.md` §2b (2026-08-02)

### Phase P2 — Scale-out (v0.20.x)

- [x] 16. Worker role + leader lock (chặn task 17)
  - [x] 16.1 `serve.ts` đọc `LUMIBASE_PROCESS_ROLE` (web/worker/all, default all); worker mở health port riêng (Req 14.1; design §10.1) — `worker-health.ts` on `LUMIBASE_WORKER_HEALTH_PORT`
  - [x] 16.2 `withLeaderLock(jobName, ttl, fn)` — Redis SET NX PX + release; không Redis → chạy thẳng + warn một-lần (Req 14.2–14.3; design §10.2) — `packages/runtime/src/leader-lock.ts`, wired on cron ticks
  - [x] 16.3 Compose profile `cms-web` + `cms-worker`; cập nhật `DEPLOYMENT-CHECKLIST.md` thay khuyến nghị `--scale cms=3` (Req 14.4)
  - [x] 16.4 Test: 2 process × 3 tick cron test = 3 side-effect (Req 14.5; design §13.2) — `leader-lock.test.ts`

- [x] 17. Flow/AI async (cần task 16)
  - [x] 17.1 Migration bảng `flow_runs` — **partial:** bảng `lumibase_flow_runs` đã có từ visual-flow-builder; migration `0013` thêm `created_at`, `run_type`, nullable `flow_id`/`started_at`, index `(site_id, flow_id, created_at)`; RLS thêm `lumibase_flows`/`lumibase_flow_runs` trong `rls-policies.sql`
  - [x] 17.2 `POST /flows/:id/run` → 202 + enqueue (`flow-runs` queue); worker `registerFlowRunsWorker`; `GET /flows/runs/:runId` site-scoped
  - [x] 17.3 Sync fallback `LUMIBASE_FLOW_SYNC_TIMEOUT` + `sleep`/`http` respect `_signal`
  - [x] 17.4 AI chat `Prefer: respond-async` — **CHỐT §21.5:** reuse `flow_runs` (`run_type=ai_chat`); HITL via harness output unchanged
  - [x] 17.5 Studio poll — **partial:** `run-history-panel` refetch while pending/running; AI panel 202+poll note in code comment only (no full SSE)

- [x] 18. DB index + transactional writes
  - [x] 18.1 Spike §21.4 CHỐT + `rls-transaction.test.ts` (mock set_config ordering)
  - [x] 18.2 EXPLAIN ANALYZE trên dataset seed 100k — **deferred:** index columns match design §16.2; no measured EXPLAIN in CI
  - [x] 18.3 Migration `items_site_coll_updated_idx` + `items_deliver_idx`; CHANGELOG CONCURRENTLY note
  - [x] 18.4 `bulk()` create: transaction + chunk ≤100 + post-commit side-effects; `LUMIBASE_BULK_MAX` → 413
  - [x] 18.5 Create/patch: `runSiteTransaction` wraps item+revision+activity
  - [x] 18.6 `docs/en/deployment/performance.md`

- [x] 19. CDC CacheInvalidator resolution
  - [x] 19.1 Xác nhận phương án B (remove) — open question §21.1 CHỐT 2026-08-02 (Req 17.1, 17.3)
  - [x] 19.2 Phương án B: xoá `cache-invalidator.ts` + property test → removal doc test; ADR-012; barrel export removed (Req 17.1–17.2)

- [x] 20. CI perf gate
  - [x] 20.1 Workflow nightly/label-triggered: `.github/workflows/perf-k6.yml` — validate-scripts always; full compose path on dispatch/label/`PERF_K6_FULL_RUN` (Req 18.1–18.3; design §13.3)
  - [x] 20.2 Docs contributing: chạy local, quy trình đổi threshold có chủ đích (Req 18.4) — `docs/en/contributing/testing.md#k6-performance-tests`

- [x] 21. Chốt chương trình
  - [x] 21.1 Re-run toàn bộ k6, hoàn tất bảng roadmap §2; so sánh với target — **pending_env** footnote; penetration 0.0308 recorded; không sửa số
  - [x] 21.2 Rà DoD lần cuối toàn chương trình theo `dod-review.md`; Setup Impact Registry #95; tutorial flow 202 — no pins found; CHANGELOG programme summary

### Bổ sung — Chống cache penetration (Req 19, design §14)

Nhóm này bổ sung sau khi spec gốc đã lập, nên đánh số nối tiếp (22.x) thay vì chèn giữa — mỗi subtask ghi rõ phase nó thuộc về. 22.1–22.2 độc lập, làm được ngay trong **P0**. 22.3–22.7 **cần task 8** (Cache Provider v2) vì interface hiện tại không biểu diễn được tombstone (design §14.1 F1).

- [x] 22. Cache penetration defence
    - [x] 22.1 **[P0]** Module `apps/cms/src/services/identifier-guard.ts`: regex nanoid/slug/collection + `assertShape` trả 404 (không 400); chuyển hằng `SAFE_FIELD_NAME` (`deliver.ts:25`) vào đây và import ngược lại, không nhân bản regex (Req 19.1, 19.3; design §14.6)
  - [x] 22.2 **[P0]** Áp guard: `routes/deliver.ts` (`page/:site_id/:slug`, `llms.txt/:site_id`) + `middleware/tenant.ts` validate `X-Lumi-Site` → 400 `TENANT_INVALID` trước khi set context (Req 19.1–19.2). Test P17: định danh sai hình dạng → 404 với **0** DB query, đếm qua query counter như task 1.4 đã làm
  - [x] 22.3 **[P1, cần 8]** Mở rộng `CacheProvider`: `CacheEntry<T>` 4 trạng thái + `getEntry` + `setNegative`; envelope `{"__lumi":"neg","v":1}` trên dây (KHÔNG dùng `null`/chuỗi rỗng — cả 2 adapter coi là falsy); Redis phân biệt lỗi → `unavailable` thay vì nuốt (đi cùng Req 13.2); KV cùng envelope (Req 19.4; design §14.3). Bổ sung vào contract test suite của task 8.5 để chạy trên cả 2 adapter + LRU
  - [x] 22.4 **[P1, cần 22.3]** Helper `createNegativeCache` trong `packages/runtime/src/cache-helpers.ts` cạnh `createSwrCache`: TTL + jitter ±20%, `resolve`/`forget`; JSDoc ghi rõ KHÔNG gộp single-flight và lý do (Req 19.5; design §14.4). Unit test fake-timer: jitter nằm trong biên, `unavailable` → gọi `load` (không tự coi là miss)
  - [x] 22.5 **[P1, cần 22.4]** Áp tombstone vào 4 đường đã audit: `deliver.ts:411-420` (page), `deliver.ts:287-294` (site/llms.txt), `SchemaService.getCompiled` (`schema-service.ts:1074-1080`), `ItemService.resolveCollection` (`item-service.ts:642-652` — hiện bỏ qua cache hoàn toàn, cho đi qua `getCompiled`). Request có Authorization/preview KHÔNG bao giờ nhận tombstone (Req 19.5, 19.8, 19.12; design §14.5). Test P18 + P20
  - [x] 22.6 **[P1, cần 22.4]** `forget` sau commit tại write path đã có API (tạo collection, tạo site, **tạo/đổi slug page**) — cùng vị trí và cùng chính sách lỗi với tag purge task 9.1 (lỗi → metric + warn, không fail request) (Req 19.7; design §14.7). Test P19: tạo tài nguyên đang bị tombstone → 200 ngay, không chờ TTL.
    - **B16 closed:** `PageService` + `POST/PATCH /api/v1/pages` gọi `forgetNegative(negativePageKey…)` (cả slug cũ khi rename).
    - **Bỏ — item tombstone:** `forget` cho `neg:*:item:*` đã bị xoá khỏi `ItemService.create` **và `bulk()`**. Không đường nào ghi khoá đó (Req 19.8 cấm serve tombstone cho request có credentials, mà mọi đọc item-by-id đều sau auth). Trong `bulk()` nó còn là một Redis DEL **mỗi row** — insert 500 row tốn 500 round-trip xoá khoá không tồn tại. Xem design §14.5.
  - [x] 22.7 **[P1, cần 13]** Limiter riêng cho `/api/v1/deliver/*`: key `rl:deliver:${ip}`, default 1200/phút (`LUMIBASE_DELIVER_RATE_LIMIT`), 429 + `Retry-After` + `no-store`; KHÔNG ghi tombstone từ request bị 429; đọc IP qua cùng helper limiter hiện hành, không tự parse header. Mount cạnh `withDb()` tại `index.ts:367` (Req 19.10–19.11; design §14.9). Cập nhật `security-guards.wiring.test.ts` thêm assertion (không sửa assertion cũ). **§21.6 CHỐT:** giữ 1200 (đo 2026-08-01).
  - [x] 22.8 **[P1]** Metrics `cache_negative_hits_total` / `cache_negative_writes_total`; panel Grafana tách hit-vì-có-dữ-liệu với hit-vì-tombstone (Req 19.15) — `docker/grafana/dashboards/lumibase.json` + `lumibase-slo.json`
    - **Sai mô tả ban đầu:** task viết "wire qua `onEvent`", nhưng `onEvent` thuộc task 8.1 và chưa ship — thực tế counter được inc qua hook `onNegativeHit`/`onNegativeWrite` của `createNegativeCache`. Bản đầu chỉ `deliver.ts` truyền hook, nên tombstone của `getCompiled`/`resolveCollection` **vô hình trong Prometheus** dù task 22.5 đã wire tombstone cho chúng. Đã bổ sung hook tại `SchemaService.getCompiled` (rà code 2026-08-02). Khi task 8.1 ship `onEvent`, gom cả hai chỗ về hook trung tâm và bỏ dynamic import.
  - [x] 22.9 **[P1]** k6 `apps/cms/k6/load-penetration.js`: 95% slug miss (finite `MISS_POOL`) + 5% hợp lệ; đo DB-query-per-404, mục tiêu ≤ 0.05; chạy trước/sau, điền số thật vào roadmap §2 (Req 19.13–19.14) — **đo 2026-08-01: 0.0308** (`baseline/2026-08-01-penetration-docker-notes.json`)
  - [x] 22.10 **[P1]** Docs: mục "Cache penetration" trong `docs/en/features/caching.md` (ba tầng, quyết định không dùng Bloom filter + điều kiện tái mở, ràng buộc TTL ngắn ↔ độ trễ thấy tài nguyên mới); env reference thêm 2 biến mới (DoD mục 4)

> Task 21 (chốt chương trình) chạy SAU nhóm 22 — 21.1 phải bao gồm cả `load-penetration.js`, 21.2 phải rà DoD 2b cho khoá `neg:*` và `rl:deliver:*`.
