# Design Document — High-Load & Cache Readiness

## Overview

Thiết kế cho chương trình High-Load & Cache Readiness (xem `requirements.md` Req 0–18, `roadmap.md` cho phase). Nguyên tắc xuyên suốt:

1. **Cache là kiến trúc nhiều tầng, invalidation là first-class.** Thứ tự chạm: edge/proxy HTTP cache → application cache (Cache_Provider) → single-flight/SWR → DB. Mỗi tầng có cơ chế vô hiệu hoá rõ ràng, kích hoạt từ write path.
2. **Dual-runtime bắt buộc.** Mọi cơ chế có hai adapter (KV/Redis, CF-rate-limit/Redis, Queues/BullMQ) sau runtime abstraction; business logic không import binding (non-negotiable #3).
3. **Degrade an toàn, không degrade im lặng.** Backend phụ trợ (Redis, queue) chết → hệ chạy chậm hơn nhưng đúng, VÀ phát tín hiệu (metric, health degraded).
4. **Tenant trong mọi khoá.** Cache key, tag, rate-limit key, lock key đều mang `siteId` (DoD 2b); ngoại lệ duy nhất là khoá hạ tầng cấp deployment (cron leader lock) — không chứa dữ liệu tenant.

## 1. Kiến trúc tổng quan

```
                 Reader (website/app)                    Editor/Agent (Studio/API)
                        │                                        │
                        ▼                                        ▼
        ┌──────────── Edge / Proxy ────────────┐   ┌────────────────────────────┐
        │ CF edge cache (caches.default) /     │   │  Caddy: body-size limit,   │
        │ Caddy: honor Cache-Control, s-maxage │   │  IP rate limit (Req 6)     │
        │ (Req 1)                              │   └──────────────┬─────────────┘
        └──────────────┬───────────────────────┘                  │
                       ▼ miss                                     ▼
┌───────────────────────────── CMS (Hono) ─────────────────────────────────────┐
│ middleware: logger → runtime → cors → tenant → db → auth ─┐                  │
│           (Request_Context_Bundle: 1× user+membership+bundle — Req 10)       │
│           rate-limit middleware (RateLimiterProvider — Req 12)               │
│                                                                              │
│  GET /deliver/* ── ETag/304 (Req 1) ── app cache deliver:* (Req 8.2)         │
│                                              │ miss                          │
│  ItemService.list/detail  ◄──────────────────┘                               │
│      │ write path (create/patch/delete):                                     │
│      │   tx[item+revision+activity] (Req 16.5)                               │
│      │   → invalidateByTag(items:site:coll) (Req 8.1)                        │
│      │   → enqueue: audit batch (Req 11), revalidation (Req 8.3),            │
│      │              search-index, lastUsed touch (Req 3)                     │
│                                                                              │
│  Schema/Permission cache: single-flight + SWR (Req 9),                       │
│      perm key versioning perm:site:vN:principal (Req 2)                      │
└───────────┬──────────────────────────────┬───────────────────────────────────┘
            ▼                              ▼
   Cache_Provider v2 (Req 7)        QueueProvider (sẵn có)
   KV+tag-index / Redis+SET         CF Queues / BullMQ
            │                              │
            ▼                              ▼
        Postgres ◄──────────── Worker process (LUMIBASE_PROCESS_ROLE=worker,
                                Req 14: cron + consumers + leader lock;
                                flow/AI async run — Req 15)
```

## 2. Traceability Matrix

| Req | Tiêu đề ngắn | Section thiết kế chính |
|-----|--------------|------------------------|
| 0 | Baseline đo đạc | §13 (testing/benchmark) |
| 1 | HTTP caching delivery | §3 (delivery cache stack) |
| 2 | Permission invalidation | §5 (key versioning) |
| 3 | API-key touch debounce | §6.2 |
| 4 | Setup-state cache | §6.3 |
| 5 | Count opt-in | §6.1 |
| 6 | Proxy limits | §11 |
| 7 | Cache Provider v2 | §4 (interface + adapters + purge API) |
| 8 | Content invalidation + revalidation | §3.3, §4.4 |
| 9 | Single-flight + SWR | §5.2 |
| 10 | Middleware consolidation | §6.4 |
| 11 | Async audit | §7 |
| 12 | Distributed rate limiter | §8 |
| 13 | Cache observability | §9 |
| 14 | Worker role + leader lock | §10 |
| 15 | Flow/AI async | §10.3 |
| 16 | DB index + transactional writes | §12 |
| 17 | CDC invalidator | §4.5 |
| 18 | CI perf gate | §13.3 |
| 19 | Chống cache penetration | §14 (validate + tombstone + deliver rate limit) |

Cross-cutting: §15 API contracts (Req 1, 5, 7, 12, 15) · §16 schema chi tiết (Req 15, 16) · §17 multi-tenancy review (DoD 2b) · §18 route-guard security (DoD 2c) · §19 env vars · §13.4 properties đánh số P1–P20.

## 3. Delivery cache stack (Req 1, 8)

### 3.1 Ba tầng cho `GET /deliver/*`

1. **HTTP/edge** — header do CMS phát; mọi CDN/proxy chuẩn hoạt động không cần cấu hình riêng:
   - Cacheable (published, không credentials): `Cache-Control: public, s-maxage=${SMAXAGE}, stale-while-revalidate=${SWR}` + `ETag: W/"…"` + `Vary: X-Lumi-Site`.
   - Non-cacheable (Authorization/preview): `Cache-Control: private, no-store`.
   - Trên CF Workers: `runtime.edgeCache` (adapter mỏng quanh `caches.default`; Docker adapter = no-op) match trước handler, put sau handler cho response cacheable.
2. **Application cache** — key `deliver:${siteId}:${slug}:${variantHash}` (variantHash = hash của locale + các query param ảnh hưởng nội dung), value = body đã serialize + ETag, TTL 300s, tags = `['deliver:'+siteId, ...collections.map(c => 'items:'+siteId+':'+c)]`.
3. **DB** — query hiện tại của `deliver.ts:198-241`, hưởng thêm index Req 16.2.

### 3.2 ETag

`W/"<sha1(siteId + schemaVersion + max(items.updatedAt) + count)>"`. Lấy từ app-cache entry khi hit; khi miss tính sau khi build page. Với `If-None-Match` khớp → 304 không body. Chọn weak ETag vì so sánh semantic (nội dung), không byte-exact.

### 3.3 Invalidation chuỗi đầy đủ khi ghi item

```
ItemService.patch(item) commit thành công
 ├─ invalidateByTag(`items:${siteId}:${collection}`)   ← app cache (deliver + list nếu sau này cache)
 ├─ enqueue revalidation-dispatch {siteId, collection} ← Next.js ISR targets
 └─ (HTTP tầng edge tự hết hạn theo s-maxage=60 — chấp nhận stale ≤60s ở edge;
     CF có thể thêm cache.delete theo URL ở phase sau nếu cần chặt hơn)
```

Cửa sổ stale tổng = max(60s edge, ~0s app-cache sau purge, độ trễ queue revalidation). Đạt target ≤ 5s cho client đi qua origin, ≤ 60s cho client sau edge — ghi rõ trade-off này trong docs.

## 4. Cache Provider v2 (Req 7)

### 4.1 Interface (`packages/runtime/src/interfaces/cache.ts`)

```ts
export interface CacheSetOptions { ttl?: number; tags?: string[] }
export interface CacheProvider {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: string, options?: CacheSetOptions): Promise<void>
  delete(key: string): Promise<void>
  invalidateByTag(tag: string): Promise<void>
  /** hook observability — CMS tiêm callback ghi Prometheus (Req 13) */
  onEvent?: (e: { op: 'get'|'set'|'delete'|'invalidateByTag'; result: 'hit'|'miss'|'ok'|'error'; backend: string }) => void
}
```

Backward compatible: caller cũ không đổi. `tags` là opt-in per-entry.

### 4.2 Redis adapter

- `set(key, v, {ttl, tags})`: pipeline `SET/SETEX key v` + với mỗi tag `SADD lumi:tag:{tag} key` + `EXPIRE lumi:tag:{tag} max(ttl, hiện tại)`.
- `invalidateByTag(tag)`: `SMEMBERS` → chunk 500 → pipeline `DEL` → `DEL lumi:tag:{tag}`. Purge tức thời.
- Giữ nguyên degrade-to-null nhưng emit `onEvent({result:'error'})` (hết nuốt lỗi im lặng — Req 13.2).

### 4.3 KV adapter

- Tag_Index = KV entry `tag:{tag}` chứa JSON array key, cập nhật read-modify-write (chấp nhận race hiếm: index thiếu key → key đó tự hết hạn theo TTL — ghi trong docs).
- `invalidateByTag`: đọc index → `delete` từng key → xoá index. Eventual consistency ~60s của KV là chặn dưới của tốc độ purge toàn cầu; delivery bù bằng `s-maxage` ngắn.

### 4.4 Purge API

`POST /api/v1/utils/cache/purge` — control-plane (thêm vào `CONTROL_PLANE_PATHS`, DoD 2c), admin-only. Body `{ tags?: string[], keys?: string[] }`. Server ép tiền tố: tag/key không bắt đầu bằng namespace của `siteId` hiện hành → 403. Đây là endpoint ADR-004 đã hứa.

### 4.5 CDC CacheInvalidator — quyết định (Req 17)

**Chọn phương án (B) Remove** [khuyến nghị — chốt khi review design]:

- Lý do: (1) mọi đường ghi qua API đã được Req 8 phủ bằng tag purge tại nguồn; (2) invalidator hiện key `config:${table}:${recordId}` không khớp bất kỳ key nào CMS đọc và thiếu siteId — muốn dùng phải viết lại phần lõi; (3) use-case "ghi thẳng DB không qua API" chưa có yêu cầu thực.
- Hành động: xoá `modules/cdc/cache-invalidator.ts` + property test + export; ADR ngắn ghi lý do và điều kiện tái mở (khi có connector ghi ngoài API).
- `InMemoryCacheProvider` bên trong file đó được thay bằng LRU provider đúng contract trong `packages/runtime` (Req 7.6) — dùng làm test double và fallback dev.

## 5. Schema/Permission cache (Req 2, 9)

### 5.1 Permission key versioning

```
perm-ver:${siteId}            → số nguyên n (không TTL; vắng → coi là 1)
perm:${siteId}:v${n}:${principal} → bundle, TTL 60s (giữ làm safety net)
```

- `bundle()`: đọc version (cache-able trong request), rồi đọc key versioned.
- Mutation quyền (routes: roles, policies, permissions, user-roles, api-keys, user-sites) gọi `PermissionService.bumpVersion(siteId)` = `set('perm-ver:'+siteId, String(n+1))` sau commit. Một write vô hiệu hoá toàn bộ bundle của site — trade-off chấp nhận được vì mutation quyền hiếm, còn đúng-ngay quan trọng.
- Key cũ tự chết theo TTL 60s — không cần list-by-prefix (giải hạn chế KV).
- Xoá `PermissionService.invalidate()` cũ (dead code).

### 5.2 Single-flight + SWR helper (`packages/runtime/src/cache-helpers.ts`)

```ts
export function createSwrCache<T>(opts: {
  cache: CacheProvider
  softTtl: number   // giây — sau đó serve stale + refresh nền
  hardTtl: number   // giây — sau đó bắt buộc recompute (blocking, qua single-flight)
  compute: (key: string) => Promise<T>
  schedule?: (p: Promise<unknown>) => void  // waitUntil trên CF; void trên Node
}): { get(key: string): Promise<T> }
```

- Entry lưu `{ v: T, softExpiresAt }`; TTL vật lý của backend = hardTtl.
- In-flight map per-instance `Map<string, Promise<T>>`, xoá trong `finally`.
- SchemaService (`getCompiled`) và PermissionService (`bundle`) chuyển sang helper; soft/hard: schema 300/900, permission 30/60.
- JSDoc ghi rõ: single-flight là per-instance; nhiều instance vẫn có thể recompute song song (chấp nhận — mức herd giảm N_request → N_instance).

## 6. Middleware & request-path (Req 3, 4, 5, 10)

### 6.1 Count opt-in (Req 5)

`GET /api/v1/items/:collection?meta=none|total_count`. Parse trong route, truyền `wantTotal` xuống `ItemService.list`; khi false bỏ block `item-service.ts:577-581`, response `meta` chỉ còn `limit/offset`. Default `total_count` (tương thích). SDK: `client.items(c).list({ meta: 'none' })`.

### 6.2 API-key touch debounce (Req 3)

Trong `withAuth` API-key path: so `row.lastUsedAt` với `now - LUMIBASE_APIKEY_TOUCH_INTERVAL`; chỉ khi cũ hơn mới schedule UPDATE (qua `schedule` — waitUntil/fire-and-forget). Race giữa nhiều instance cùng touch: vô hại (last-write-wins trên cột thống kê).

### 6.3 Setup-state cache (Req 4)

Module-level `{ state, checkedAt }` trong `setup-required.ts`; `initialized` → cache vĩnh viễn; `uninitialized` → TTL 5s. Cùng pattern `admin-path-guard.ts:15-23` — cân nhắc extract helper chung `createProcessCache(ttlMs)`.

### 6.4 Request_Context_Bundle (Req 10)

- `withAuth` sau khi resolve user/API-key ghi `c.set('principal', {...})` gồm: user row, userSites rows, principal descriptor.
- `withSiteMembership.resolveUser` và `attachAccessBundle` đọc `c.get('principal')` trước, chỉ query khi vắng (giữ được tính độc lập của middleware khi được mount lẻ trong test).
- `withStudioAccess` nhận bundle đã attach thay vì gọi `PermissionService.bundle()` lần hai.
- Guard semantics không đổi; viết behavioural matrix test TRƯỚC refactor (Req 10.3), giữ tripwire.

## 7. Async audit (Req 11)

- Queue `audit-log` (tên topic mới trên QueueProvider sẵn có). Payload = event đã chuẩn hoá + `siteId`.
- Worker: gom theo `max(100 events, 1s)` → một multi-row INSERT `audit_log` (uuidv7 giữ nguyên — rule #1).
- Fallback chain: enqueue fail → INSERT đồng bộ → fail nữa → stderr JSON (giữ fallback hiện có) + counter.
- Bỏ race-1000ms (`logger.ts:14-25`): với đường queue không còn cần; đường sync fallback dùng await trọn (chấp nhận latency hiếm khi queue chết — lý do: race hiện tại có thể double-write, tệ hơn chậm).
- Field-access log (PII/PHI) đi cùng topic, type khác. Thứ tự bảo toàn trong batch (queue FIFO per-partition ở BullMQ mặc định đủ dùng; ghi rõ không cam kết total order giữa instance).

## 8. RateLimiterProvider (Req 12)

```ts
export interface RateLimiterProvider {
  consume(key: string, limit: number, windowSeconds: number):
    Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }>
}
```

- **Redis**: fixed-window `INCR key` + `EXPIRE NX` (đủ cho mục tiêu; sliding-window sorted-set là tối ưu sau nếu cần).
- **Cloudflare**: Workers Rate Limiting binding khi có (`env.RATE_LIMITER`); vắng binding → per-isolate memory + warn một-lần (không chặn deploy).
- Middleware `/api/v1`: key `rl:${siteId}:${principalKey}`; skip cho `/health`, `/metrics`, `/deliver` (delivery bảo vệ bằng cache, không bằng limiter — tránh 429 cho reader hợp lệ; xem lại sau baseline).
- Migrate recovery + setup limiter; login-guard counter thêm backend Redis qua cùng provider (Postgres giữ làm fallback + nguồn audit `login_attempts` không đổi).

## 9. Cache observability (Req 13)

- `onEvent` hook (§4.1) → CMS wire vào `cacheOperationsTotal` (đã khai báo `routes/metrics.ts`).
- Health: probe cache hiện có nâng cấp trả `ok|degraded|down`; `/health/ready` degraded khi error-rate cache > 50%/60s (tính trong process bằng cửa sổ đếm đơn giản).
- Grafana: panel hit-rate, error-rate, invalidation theo tag prefix. Alert rules mẫu trong `docker/prometheus/alerts.yml`.

## 10. Worker role & async execution (Req 14, 15)

### 10.1 Role split (`serve.ts`)

```
LUMIBASE_PROCESS_ROLE=web    → HTTP only (pressure limiter giữ nguyên)
LUMIBASE_PROCESS_ROLE=worker → queue consumers + node-cron + health port riêng
LUMIBASE_PROCESS_ROLE=all    → như hiện tại (default, deploy đơn giản không đổi)
```

Compose ví dụ: `cms-web` (replicas N) + `cms-worker` (replicas 1..M, cron được lock). Cloudflare không đổi (Queues consumer + scheduled handler đã là mô hình tách sẵn).

### 10.2 Leader lock cho cron

`withLeaderLock(jobName, ttlMs, fn)`: `SET lumi:cron-lock:${jobName} ${instanceId} NX PX ttl` → chạy fn → best-effort release (compare-and-del bằng Lua hoặc chấp nhận chờ TTL). Lock key KHÔNG mang siteId (job cấp deployment; job bên trong tự fan-out theo site từ DB — DoD 2b mục background context). Không Redis → chạy thẳng + warn một-lần.

### 10.3 Flow/AI async (Req 15)

- Bảng `flow_runs` (nanoid, siteId, flowId, status: queued|running|succeeded|failed, result jsonb, error text, startedAt, finishedAt; index `(siteId, flowId, createdAt)`; RLS site_isolation).
- `POST /flows/:id/run` → insert `queued` + enqueue `{runId, siteId}` → 202. Worker consumer load flow, chạy engine hiện tại, update row. Client poll `GET /flows/runs/:runId` (site-scoped).
- Sync fallback (không queue): chạy inline nhưng bọc `AbortSignal.timeout(LUMIBASE_FLOW_SYNC_TIMEOUT)`; `sleep`/`http` op nhận signal.
- AI chat: `Prefer: respond-async` → cùng mô hình với bảng `ai_chat_runs` hoặc tái dùng `flow_runs` với type — chốt lúc implement, ưu tiên tái dùng.

## 11. Proxy limits (Req 6)

Caddyfile: `request_body max_size 10MB` global; matcher riêng cho `/api/v1/media` dùng `FILE_UPLOAD_MAX_BYTES`. Rate limit: plugin `caddy-ratelimit` (ghi chú build image kèm plugin) hoặc để CMS-level limiter (Req 12) làm lớp chính nếu không muốn custom Caddy build — quyết định khi implement, docs mô tả cả hai. App-level JSON limit: middleware đọc `Content-Length` + stream guard, 413 envelope chuẩn.

## 12. DB (Req 16)

- Migration index (Drizzle): 
  - `items_site_coll_updated_idx (site_id, collection_id, updated_at DESC)`
  - `items_deliver_idx (site_id, collection_id, status, publish_at, unpublish_at) WHERE deleted_at IS NULL` — xác nhận bằng EXPLAIN trên dataset seed 100k trước khi chốt cột/thứ tự.
  - Ghi chú CHANGELOG: chạy `CONCURRENTLY` cho instance lớn (Drizzle generate ra file SQL — chỉnh tay thêm CONCURRENTLY + `--no-transaction` note).
- `bulk()`: `db.transaction` bao chunk; insert values array; side-effect gom sau commit (một lần indexItem batch, một lần revalidation per collection touched).
- Create/patch đơn: `db.transaction` bao item+revision+activity. Chú ý RLS `set_config(..., true)` là transaction-local — với transaction tường minh, set_config phải thực hiện trong cùng transaction; kiểm tra tương tác với `withRls` hiện tại (`rls.ts:53`) và cập nhật nếu cần (test RLS còn hiệu lực trong tx là bắt buộc).

## 13. Testing & benchmark

### 13.1 Unit/contract

- Cache contract suite chạy trên cả 2 adapter (Req 7.8): set/get/delete/ttl/tags/invalidateByTag/tenant-prefix.
- SWR helper: fake timers — 50 concurrent get = 1 compute (Req 9.3); stale-serve trong soft-hard window; blocking sau hard.
- Version-bump permission: mutation → bundle mới trong cùng giây (Req 2.5).
- Rate limiter: 2 provider chung Redis chia sẻ budget (Req 12.5).

### 13.2 Integration

- Delivery ETag/304/no-store matrix (Req 1.7).
- Two-site cache isolation: mutation site A không purge site B (Req 8.6) — thêm vào `cross-site-leak` k6 hoặc vitest integration.
- Leader lock: 2 process × 3 tick = 3 side-effect (Req 14.5).
- Audit qua queue: đủ 100 row, mất queue không mất event (Req 11.5).
- Query-count-per-request assert ≤3 (Req 10.4).

### 13.3 Benchmark (Req 0, 18)

- `load-deliver.js` mới: hỗn hợp 90% GET page (zipf slug) + 10% khác; thresholds p95.
- Baseline lưu `baseline/<date>-<config>.json`; CI nightly chạy smoke+load-deliver với thresholds = baseline×1.2.

### 13.4 Properties tổng hợp (đánh số để trace từ tasks)

| # | Property | Req | Loại |
|---|----------|-----|------|
| P1 | Cùng nội dung → cùng ETag; nội dung đổi (item patch / schema apply) → ETag đổi | 1.2, 1.7 | integration |
| P2 | Request `If-None-Match` khớp → 304, KHÔNG thực thi query items (assert qua query counter) | 1.3 | integration |
| P3 | Request mang Authorization/preview → `private, no-store`, không ETag chia sẻ | 1.4 | integration |
| P4 | Mọi cache tag literal trong codebase chứa `${siteId}` (source-scan tripwire) | 7.4 | tripwire |
| P5 | set(tags) → invalidateByTag → get trả null — pass trên CẢ HAI adapter + LRU | 7.8 | contract |
| P6 | Mutation site A không xoá entry cùng collection-name của site B | 8.6 | integration two-site |
| P7 | 50 concurrent get trên key hết hạn → đúng 1 recompute | 9.3 | unit fake-timer |
| P8 | Trong cửa sổ soft→hard: get trả giá trị stale ngay (không chờ compute); sau hard: blocking | 9.2 | unit fake-timer |
| P9 | Thu hồi quyền → request kế tiếp 403 trong cùng giây (không chờ TTL 60s) | 2.5 | integration |
| P10 | 2 instance chung Redis: tổng request được phép = limit, không phải limit×2 | 12.5 | integration |
| P11 | 2 process role=all × 3 cron tick = đúng 3 side-effect | 14.5 | integration |
| P12 | 100 mutation → đủ 100 audit row ≤5s; kill queue giữa chừng → 0 event mất (fallback sync) | 11.5 | integration |
| P13 | Request content-plane authenticated điển hình ≤ 3 DB query (không tính cache miss) | 10.4 | integration |
| P14 | 100 request/60s cùng API key → đúng 1 UPDATE `lastUsedAt` | 3.4 | unit |
| P15 | Behavioural matrix (principal × route → status) cho kết quả giống nhau trước/sau refactor middleware | 10.3 | integration |
| P16 | RLS còn hiệu lực bên trong transaction tường minh trên cả 3 connection path | 16.5 | spike/integration |
| P17 | Định danh sai hình dạng (siteId/slug/collection) → 404 với **0** DB query (assert qua query counter) | 19.1, 19.3 | integration |
| P18 | N request liên tiếp cùng slug không tồn tại → đúng **1** DB query; N−1 request còn lại serve từ tombstone | 19.5 | integration |
| P19 | Tạo tài nguyên đang bị tombstone → request kế tiếp trả 200, KHÔNG phải chờ TTL hết hạn | 19.7 | integration |
| P20 | Tombstone site A không ảnh hưởng cùng slug ở site B; request có Authorization không bao giờ nhận tombstone | 19.6, 19.8 | integration two-site |

## 14. Chống cache penetration (Req 19)

> Section §14 trước đây bỏ trống (đánh số nhảy §13 → §15); requirement này lấp vào đó.

### 14.1 Vấn đề — vì sao ba tầng cache hiện tại đều không hấp thụ được

Toàn bộ §3–§5 là cache **positive**: điền entry khi có dữ liệu. Khoá không tồn tại thì không có gì để điền, nên mỗi tầng chỉ chuyển tiếp xuống tầng dưới và request luôn kết thúc ở Postgres:

```
GET /deliver/page/{siteId}/{slug-rác}
  edge/HTTP   → miss (và 404 hiện phát `no-store` → CDN không được phép giữ lại)
  app cache   → miss (§3.1 chỉ ghi khi build được payload)
  single-flight/SWR (§5.2) → không giúp: coalesce các miss ĐỒNG THỜI trên CÙNG khoá;
                             kẻ tấn công dùng khoá KHÁC NHAU nên mỗi request là một khoá mới
  DB          → 1 query `pages` (routes/deliver.ts:411-415) → 404
```

Ba sự thật từ audit làm vấn đề nặng hơn:

| # | Phát hiện | Vị trí |
|---|-----------|--------|
| F1 | `CacheProvider.get` trả `null` cho *miss*, *giá trị null* và *lỗi backend* như nhau → **không thể** biểu diễn tombstone dù caller muốn | `interfaces/cache.ts:2`; `docker/cache.ts:28-37`; `cloudflare/cache.ts:34-36` |
| F2 | `/api/v1/deliver/*` mount **chỉ** `withDb()` — không có rate limit nào; đây là surface public, không xác thực | `index.ts:367-368` |
| F3 | `site_id`/`slug`/tên collection đi thẳng từ URL vào query, không kiểm hình dạng; `X-Lumi-Site` được tin tuyệt đối | `deliver.ts:398`; `tenant.ts:25-29` |

F1 là blocker cấp interface: phải sửa `CacheProvider` trước, nên tầng 2 phụ thuộc task 8 (Cache Provider v2).

Đối chiếu: `resolveUploadPolicy` (`upload-policy-service.ts:50-82`) đã làm đúng một biến thể của việc này — khi settings row vắng, nó vẫn cache **fallback config** thay vì bỏ trống. Pattern "cache cả kết quả rỗng" đã tồn tại trong codebase, chỉ chưa được áp cho đường đọc theo định danh.

### 14.2 Ba tầng phòng thủ

```
request
  │
  ├─[1] shape guard      ── sai hình dạng ────────────► 404, 0 query, 0 cache op
  │        rẻ nhất, thuần regex, không tra cứu
  ├─[2] tombstone lookup ── neg:{siteId}:{kind}:{id} ─► 404 từ cache, 0 query
  │        TTL 30s ± jitter 20%
  ├─[3] rate limit IP    ── vượt ngưỡng ──────────────► 429, no-store, KHÔNG ghi tombstone
  │
  ▼ DB (đường duy nhất còn lại) → không có → ghi tombstone → 404
```

Thứ tự cố ý: guard hình dạng đứng trước cả cache vì nó không tốn round-trip nào. Rate limit đứng **sau** tombstone lookup để traffic hợp lệ-hình-dạng-nhưng-không-tồn-tại (crawler cũ, link chết) vẫn được phục vụ rẻ thay vì bị 429.

### 14.3 Interface — phân biệt miss với tombstone

Mở rộng `CacheProvider` v2 (§4.1), giữ nguyên `get` cũ để mọi caller hiện tại không phải đổi:

```ts
export type CacheEntry<T> =
  | { state: 'hit'; value: T }
  | { state: 'negative' }        // đã xác nhận không tồn tại (tombstone)
  | { state: 'miss' }            // chưa biết
  | { state: 'unavailable' }     // backend lỗi — caller PHẢI fallback DB (Req 19.9)

export interface CacheProvider {
  // …§4.1…
  /** Đọc phân biệt bốn trạng thái. `get()` cũ = hit→value, còn lại→null. */
  getEntry<T>(key: string): Promise<CacheEntry<T>>
  /** Ghi tombstone. Value trên dây là sentinel, không phải `null` JSON. */
  setNegative(key: string, options?: { ttl?: number }): Promise<void>
}
```

**Encoding trên dây.** Không dùng `null`/chuỗi rỗng làm sentinel — cả hai adapter đã coi chúng là falsy. Dùng envelope tường minh:

- Redis: `SETEX key ttl '{"__lumi":"neg","v":1}'`; `getEntry` phân biệt `null` từ `GET` (miss) với envelope parse được (negative). Lỗi/`catch` → `unavailable`, **không** phải `miss` — đây là chỗ adapter hiện tại đang nuốt lỗi (`docker/cache.ts:33-36`) và Req 13.2 cũng đã yêu cầu sửa.
- KV: cùng envelope, `kv.get(key, 'json')`. KV không phân biệt được lỗi với vắng mặt ở mức API → `unavailable` chỉ phát khi `get` ném; chấp nhận và ghi vào docs.

`setNegative` không nhận `value` để không ai vô tình cache một payload rỗng thay vì cờ "không tồn tại".

### 14.4 Helper (`packages/runtime/src/cache-helpers.ts`, cạnh `createSwrCache`)

```ts
export function createNegativeCache(opts: {
  cache: CacheProvider
  ttl: number                    // giây, base
  jitterRatio?: number           // default 0.2 → TTL thực ∈ [0.8·ttl, 1.2·ttl]
}): {
  /** miss/unavailable → gọi load; load trả null → ghi tombstone rồi trả null. */
  resolve<T>(key: string, load: () => Promise<T | null>): Promise<T | null>
  forget(key: string): Promise<void>   // gọi sau khi tạo tài nguyên (Req 19.7)
}
```

Jitter dùng nguồn ngẫu nhiên của runtime; mục đích là tránh biến penetration thành *avalanche* — 100k tombstone ghi trong một burst sẽ hết hạn cùng lúc nếu TTL cố định, và burst thứ hai đi thẳng xuống DB y như lần đầu.

`resolve` cố ý **không** gộp single-flight: hai cơ chế giải hai bài toán khác nhau (§5.2 lo khoá nóng chung, cái này lo khoá rác phân tán). Ai cần cả hai thì bọc `createSwrCache` bên trong `load`.

**TTL phải được caller truyền vào, service không tự đọc `process.env`.** Trên Cloudflare Workers `process.env` không mang biến của wrangler, nên đọc trực tiếp trong service là bỏ qua knob `LUMIBASE_NEGATIVE_CACHE_TTL` trên đúng một trong hai runtime được hỗ trợ — kể cả `0` (tắt tombstone) cũng không có tác dụng (vi phạm non-negotiable rule #3). Đường đi: `resolveNegativeTtl(c.env)` tại biên request → `ItemServiceDeps.negativeCacheTtl` → `SchemaServiceDeps.negativeCacheTtl`. Route `deliver.ts` đã đọc `c.env` trực tiếp nên không cần thread. Các construction site không có `c` (worker, config-import, rewrap) giữ fallback `process.env` — chúng chạy trên Node và không phải mục tiêu penetration.

### 14.5 Key namespace (DoD 2b)

```
neg:${siteId}:page:${slug}          ← deliver page 404
neg:${siteId}:collection:${name}    ← SchemaService.getCompiled / ItemService.resolveCollection
neg:site:${siteId}                  ← site không tồn tại (llms.txt); không có siteId cha nên
                                       namespace phẳng — đây là ngoại lệ duy nhất, xem §17
```

**Đã bỏ `neg:${siteId}:item:${collection}:${id}` (rà code 2026-08-02).** Mọi đường đọc item-by-id đều nằm sau auth, và Req 19.8 cấm serve tombstone cho request có credentials — nên phía đọc không bao giờ wire được. Bản implement đầu tiên vẫn gọi `forget` cho khoá này ở `ItemService.create`, tức mỗi lần tạo item tốn một round-trip Redis để xoá thứ không đường nào ghi. Đã xoá cả helper lẫn call-site. Mở lại chỉ khi có surface item-by-id công khai, không xác thực.

`slug`, tên collection và mọi thành phần khoá chịu ảnh hưởng từ input đều được cắt tại `LUMIBASE_NEGATIVE_KEY_MAXLEN` = 256 ký tự (slug thêm lowercase + trim). Lý do cắt cả tên collection: `SAFE_FIELD_NAME` giới hạn **alphabet** nhưng không giới hạn **độ dài**, nên `GET /items/<tên 10KB>` sẽ sinh khoá Redis 10KB. Cắt an toàn cho key material — hai tên trùng 256 ký tự đầu dồn vào một tombstone chỉ khiến tên dài hơn tốn thêm một lần probe DB, và không tên collection thật nào tới gần mức đó (schema create cap 63 ký tự).

### 14.6 Shape guard (`apps/cms/src/services/identifier-guard.ts` — module mới)

```ts
const NANOID = /^[A-Za-z0-9_-]{21}$/          // khớp nanoid() mặc định (rule #1)
const SLUG   = /^[a-z0-9]+(?:[/_-][a-z0-9]+)*$/   // ≤200 ký tự
const COLL   = /^[A-Za-z_][A-Za-z0-9_]*$/     // đã tồn tại inline tại deliver.ts:25
```

- Sai hình dạng → **404**, không phải 400: 400 nói với kẻ dò rằng "hình dạng này đúng nhưng không có", biến endpoint thành oracle. Ngoại lệ: `X-Lumi-Site` sai hình dạng → 400 `TENANT_INVALID`, vì đây là lỗi client tường minh trên header do client tự đặt, không phải đường dò tài nguyên.
- Guard **không** tra DB. Một siteId đúng hình dạng nhưng không tồn tại vẫn xuống tầng 2 — đó là việc của tombstone.
- `COLL` hiện là hằng `SAFE_FIELD_NAME` cục bộ trong `deliver.ts:25`; chuyển vào module chung, `deliver.ts` import lại (không nhân bản regex).

### 14.7 Xoá tombstone khi tài nguyên xuất hiện (Req 19.7)

TTL 30s là lưới an toàn, không phải cơ chế chính — một tác giả tạo page rồi F5 ngay không được nhìn thấy 404 tồn dư.

| Write path | Gọi sau commit |
|---|---|
| Tạo page / đổi `pages.slug` | `forget('neg:'+siteId+':page:'+slug)` cho slug mới (và slug cũ nếu đổi) |
| Tạo collection | `forget('neg:'+siteId+':collection:'+name)` |
| Tạo site | `forget('neg:site:'+siteId)` |
| ~~Tạo item~~ | ~~`forget('neg:…:item:…')`~~ — bỏ, xem §14.5 (khoá item không tồn tại) |

Cùng vị trí và cùng chính sách lỗi với tag purge của Req 8.1: lỗi → metric + warn, **không** fail request.

**Thứ tự tra cứu ở `SchemaService.getCompiled`: positive cache TRƯỚC, tombstone SAU.** Bản đầu tiên probe tombstone trước, nên mọi request tới collection *có thật* phải trả thêm một round-trip cache — mà `resolveCollection` chạy trên mọi item list/detail/patch, tức đường nóng nhất của content plane. Đảo lại: hit dương = 1 op (trước là 2); traffic penetration vẫn **không** chạm Postgres, chỉ trả thêm một lần đọc cache — đúng phía rẻ của trade-off. Nguyên tắc chung cho các call-site sau: tombstone là lớp bảo vệ cho đường *lạnh*, không được nằm chắn trước đường nóng.

### 14.8 Bloom filter — quyết định (Req 19.16)

**Không dùng ở P0/P1.** Lý do:

1. **Dual-runtime chặn.** RedisBloom là module Redis (`BF.ADD`/`BF.EXISTS`), không có tương đương trên Cloudflare KV. Tự cài bitmap trong KV nghĩa là read-modify-write một blob lớn mỗi lần thêm khoá — đắt hơn hẳn thứ nó thay thế, và eventually-consistent ~60s làm false-negative xuất hiện (filter nói "không có" cho tài nguyên vừa tạo → 404 sai). False-negative là lỗi *correctness*, khác hẳn false-positive vô hại của Bloom filter đúng nghĩa.
2. **Chi phí rebuild.** Bloom filter chuẩn không xoá được phần tử; xoá một page buộc rebuild toàn bộ filter của site. Counting/cuckoo filter xoá được nhưng phải tự hiện thực trên KV.
3. **Lợi ích biên nhỏ.** Bloom chỉ hơn tombstone khi *key space rác quá lớn để tombstone hết* — mỗi khoá rác vẫn tốn một entry Redis 30s. Với 1200 req/phút/IP (§14.9) và TTL 30s, chặn trên số tombstone sống của một IP là ~600 entry ≈ vài chục KB. Ngân sách này chưa đủ đau để đánh đổi lấy độ phức tạp trên.

**Điều kiện tái mở** (ghi để phase sau không phải tranh luận lại): (a) đo được bộ nhớ tombstone > 5% maxmemory Redis trên môi trường thật, HOẶC (b) triển khai Docker-only cho phép bỏ ràng buộc KV, HOẶC (c) xuất hiện use-case tra cứu tồn tại trên tập > 10⁷ khoá.

### 14.9 Rate limit cho Delivery API (Req 19.10; chốt open question §21.2)

Chốt theo hướng **CÓ**. Sửa quyết định "skip health/metrics/deliver" ở `tasks.md` task 13.2 — riêng `deliver` vào phạm vi, `health`/`metrics` vẫn ngoài.

- Keying: `rl:deliver:${ip}` — đường này chưa xác thực nên không có principal. **Không** đưa `siteId` vào khoá: ngân sách theo IP là để bảo vệ *origin*, và nếu chia theo site thì một IP đánh N site sẽ có N lần ngân sách. Đây là ngoại lệ có chủ ý với quy tắc "mọi khoá hạ tầng mang siteId" — ghi vào §17 cùng nhóm với `rl:recovery:${ip}` đã có tiền lệ.
- Ngưỡng mặc định 1200/phút/IP: cao gấp 4 lần `LUMIBASE_API_RATE_LIMIT` vì delivery là đường một-frontend-nhiều-request, và traffic thật thường đến sau CDN (nhiều người dùng chung một IP egress). Đây là lưới chống lạm dụng, không phải quota. **Chốt 2026-08-01 (§21.6):** giữ 1200 sau đo `load-penetration.js` (50 RPS một IP → 429 sau ~24s).
- Fail-open theo cùng chính sách `middleware/rate-limit.ts` hiện hành (`LUMIBASE_RATE_LIMIT_FAIL_CLOSED` áp dụng chung).
- Nguồn IP phải đọc qua cùng helper mà limiter hiện tại dùng (tôn trọng `X-Forwarded-For` sau Caddy) — không tự parse header trong route.

### 14.10 Chi phí một lần chạm DB — vì sao đáng chặn

`GET /deliver/page` không cache mất **2** query trên đường 200 và **1** trên đường 404, nhưng query cache-hit-path `contentFingerprint` (`deliver.ts:386-395`) là một aggregate `count(*) filter (…)` quét theo `siteId` trên bảng `items`. Trên site 100k item (dataset seed task 0.2) đây không phải index lookup. Nghĩa là: chi phí biên của một request rác không phải "một primary-key lookup rẻ" — càng đáng chặn trước khi tới DB. Index của Req 16.2 giảm chi phí này nhưng không xoá nó.

## 15. API contracts (endpoint mới / thay đổi)

Mọi response tuân thủ non-negotiable rule #5: `{ data: T, meta?: PaginationMeta }` hoặc `{ errors: [...] }`.

### 15.1 `POST /api/v1/utils/cache/purge` (Req 7.5)

- **Guard:** `withAuth` + control-plane backstop (prefix vào `CONTROL_PLANE_PATHS`) + `adminOnly` per-route (hai lớp, xem §18).
- **Request:** `{ "tags"?: string[] (1..50), "keys"?: string[] (1..200) }` — ít nhất một trường; Zod validate.
- **Scope enforcement:** server chuẩn hoá và từ chối mọi tag/key không thuộc namespace của `siteId` hiện hành (`items:${siteId}:…`, `deliver:${siteId}…`, `schema:${siteId}…`, `perm:${siteId}…`).
- **200:** `{ "data": { "purged": { "tags": number, "keys": number } } }`
- **Lỗi:** 400 `VALIDATION` (body rỗng/quá giới hạn) · 403 `TAG_OUT_OF_SCOPE` (kèm tag vi phạm đầu tiên, không echo toàn bộ) · 401/403 theo guard chuẩn.

### 15.2 `GET /api/v1/items/:collection?meta=` (Req 5)

- `meta=total_count` (default, giữ tương thích): `{ data, meta: { total, limit, offset } }`.
- `meta=none`: `{ data, meta: { limit, offset } }` — không chạy `count(*)`.
- Giá trị khác → 400 `VALIDATION`.

### 15.3 Flow runs (Req 15)

```
POST /api/v1/flows/:id/run
  → 202 { "data": { "runId": "<nanoid>", "status": "queued" } }        (async, có queue)
  → 200 { "data": { "runId": "...", "status": "succeeded", "result": … } }  (sync fallback)
  → 408 { "errors": [{ "code": "FLOW_SYNC_TIMEOUT", "message": "…enable a worker…" }] }

GET /api/v1/flows/runs/:runId
  → 200 { "data": { "id", "flowId", "status", "result"?, "error"?, "startedAt"?, "finishedAt"? } }
  → 404 khi runId không tồn tại HOẶC thuộc site khác (không phân biệt được — không leak tồn tại)
```

### 15.4 Delivery response headers (Req 1) — ma trận

| Điều kiện request | Cache-Control | ETag | Vary | 304 |
|---|---|---|---|---|
| Published, không credentials | `public, s-maxage=60, stale-while-revalidate=300` | `W/"…"` | `X-Lumi-Site` | có (`If-None-Match`) |
| Có `Authorization` | `private, no-store` | không | `X-Lumi-Site` | không |
| Preview/draft token | `private, no-store` | không | `X-Lumi-Site` | không |
| Lỗi 4xx/5xx | `no-store` | không | — | không |

### 15.5 Rate limit 429 (Req 12)

```
429
Retry-After: <seconds>
{ "errors": [{ "code": "RATE_LIMITED", "message": "Too many requests",
               "meta": { "retryAfterSeconds": n, "limit": l, "windowSeconds": w } }] }
```

Không kèm thông tin về resource đích (không leak tồn tại qua limiter).

## 16. Schema chi tiết (Req 15.2, 16)

Bảng mới mang tiền tố `lumibase_` như toàn bộ schema (ADR-010, registry #36). ID `nanoid()` — rule #1.

### 16.1 `flow_runs` (`packages/database/src/schema/cms.ts` hoặc file mới `flows.ts`)

```ts
export const flowRuns = pgTable('flow_runs', {
  id: text('id').primaryKey(),                                   // nanoid()
  siteId: text('site_id').notNull(),
  flowId: text('flow_id').notNull(),
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] })
    .notNull().default('queued'),
  triggeredBy: text('triggered_by').notNull(),                   // principal descriptor
  input: jsonb('input'),
  result: jsonb('result'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  index('flow_runs_site_flow_idx').on(t.siteId, t.flowId, t.createdAt),
  index('flow_runs_site_status_idx').on(t.siteId, t.status),
])
```

Thêm policy `site_isolation` vào `rls-policies.sql` (DoD 2b). Retention: worker dọn row `finishedAt` cũ hơn 30 ngày trong retention sweep sẵn có.

### 16.2 Index mới trên `items` (Req 16.1–16.3)

```sql
-- chốt cột cuối cùng sau EXPLAIN ANALYZE trên dataset seed (task 18.2)
CREATE INDEX CONCURRENTLY items_site_coll_updated_idx
  ON lumibase_items (site_id, collection_id, updated_at DESC);

CREATE INDEX CONCURRENTLY items_deliver_idx
  ON lumibase_items (site_id, collection_id, status, publish_at, unpublish_at)
  WHERE deleted_at IS NULL;
```

Lưu ý migration: `CONCURRENTLY` không chạy được trong transaction — file SQL sinh từ Drizzle cần tách riêng + ghi chú trong CHANGELOG upgrade steps.

## 17. Multi-tenancy review (DoD 2b — phân loại tài nguyên)

| Tài nguyên | Phạm vi | Khoá / cơ chế | Lý do nếu shared | Verify |
|---|---|---|---|---|
| Cache entry schema/perm/deliver | Cô lập tenant | `schema:${siteId}:…`, `perm:${siteId}:v${n}:…`, `deliver:${siteId}:…` | — | P5, P6 |
| Cache tag + tag-index | Cô lập tenant | tag luôn chứa `siteId` → key index `tag:items:${siteId}:…` cũng chứa | — | P4 (tripwire), P6 |
| Edge/HTTP cache | Cô lập tenant | `Vary: X-Lumi-Site` + URL chứa `site_id` | — | test header matrix (P1–P3) |
| Rate-limit key API | Cô lập tenant | `rl:${siteId}:${principal}` | — | P10 |
| Rate-limit recovery/setup | **Shared theo IP** | `rl:recovery:${ip}` | Pre-auth: chưa xác định được tenant; chỉ chứa IP, không chứa dữ liệu tenant | review + unit test key shape |
| Tombstone (negative cache) | Cô lập tenant | `neg:${siteId}:${kind}:${id}` | — | P20 |
| Tombstone site-không-tồn-tại | **Namespace phẳng** | `neg:site:${siteId}` | Không có siteId cha để lồng vào — khoá LÀ siteId; giá trị là cờ rỗng, không chứa dữ liệu tenant nào | review key shape; P17 |
| Rate-limit delivery | **Shared theo IP** | `rl:deliver:${ip}` | Public, chưa xác thực; cố ý không chia theo site để một IP đánh N site không có N lần ngân sách (§14.9) | review + unit test key shape |
| Cron leader lock | **Shared deployment** | `lumi:cron-lock:${jobName}` | Job cấp deployment (audit rotation, retention…); job tự fan-out theo site từ DB — không "rò" site của request gần nhất | P11 + code review job payload |
| Queue topic audit/revalidation/flow | **Topic shared, payload cô lập** | mọi payload bắt buộc mang `siteId`; worker resolve site từ payload, không từ context | Topic là hạ tầng; dữ liệu nằm trong payload đã gắn site | schema Zod payload có `siteId` required + test worker |
| Bảng `flow_runs` | Cô lập tenant | cột `site_id NOT NULL` + RLS `site_isolation` + mọi query `.where(eq(siteId))` | — | RLS test + P16 |
| Prometheus metrics | **Shared** (label không chứa siteId) | path normalize sẵn có | Metric vận hành, tránh cardinality explosion; KHÔNG đưa siteId vào label | review |

Two-site smoke bắt buộc trước khi đóng mỗi phase: chạy P6 + kịch bản k6 `cross-site-leak.js` mở rộng thêm bước purge/tag.

## 18. Route-guard security (DoD 2c — phân loại surface mới)

| Surface | Plane | Guard |
|---|---|---|
| `POST /utils/cache/purge` | **Control plane** | prefix vào `CONTROL_PLANE_PATHS` (backstop) + `adminOnly` per-route (lớp trong) |
| `GET /flows/runs/:runId` | Content/Studio plane (theo `/flows` hiện hành) | chuỗi auth chuẩn + query site-scoped; 404 đồng nhất cho cross-site |
| `POST /flows/:id/run` (202 mode) | Không đổi plane so với hiện tại | giữ nguyên guard hiện hành |
| Rate-limit middleware | — | đặt SAU `withAuth` (cần principal); không đổi thứ tự guard phía trước; không thêm path nào vào `PUBLIC_AUTH_PATHS`/bypass |
| Delivery rate limit (Req 19.10) | **Public plane** (không đổi plane) | Limiter riêng keyed theo IP, mount trên `/api/v1/deliver/*` cùng chỗ `withDb()` (`index.ts:367`); KHÔNG dùng limiter authenticated (không có principal ở đây); không thêm/bớt guard nào khác trên chuỗi delivery |
| Shape guard + tombstone (Req 19.1–19.8) | **Public plane** | Không phải guard bảo mật — chỉ giảm tải; 404 hình-dạng-sai và 404 không-tồn-tại phải **không phân biệt được** từ ngoài (cùng body, cùng `Cache-Control`) để endpoint không thành oracle liệt kê khoá hợp lệ |
| Cache/queue/lock | — | không expose endpoint mới nào ngoài purge; worker không nhận lệnh từ request context |

Tripwire: `security-guards.wiring.test.ts` THÊM assertion cho `/utils/cache/purge` (không sửa/xoá assertion cũ). Middleware refactor (Req 10) chỉ merge sau khi behavioural matrix (P15) merge trước và pass trên code cũ.

## 19. Env vars mới (tổng hợp — cập nhật docs env reference khi ship)

| Biến | Default | Phase | Req | Ghi chú |
|---|---|---|---|---|
| `LUMIBASE_DELIVER_SMAXAGE` | `60` | P0 | 1.1 | giây; `0` = tắt public cache |
| `LUMIBASE_DELIVER_SWR` | `300` | P0 | 1.1 | giây |
| `LUMIBASE_APIKEY_TOUCH_INTERVAL` | `60` | P0 | 3.1 | giây |
| `LUMIBASE_MAX_JSON_BODY` | `1048576` | P0 | 6.2 | bytes |
| `LUMIBASE_API_RATE_LIMIT` | `600` | P1 | 12.3 | req/phút/(site,principal); `0` = tắt |
| `LUMIBASE_PROCESS_ROLE` | `all` | P2 | 14.1 | `web`\|`worker`\|`all` |
| `LUMIBASE_FLOW_SYNC_TIMEOUT` | `30000` | P2 | 15.3 | ms, chỉ áp cho sync fallback |
| `LUMIBASE_BULK_MAX` | `500` | P2 | 16.4 | items/batch |
| `LUMIBASE_NEGATIVE_CACHE_TTL` | `30` | P1 | 19.5 | giây, base trước jitter ±20%; `0` = tắt tombstone |
| `LUMIBASE_DELIVER_RATE_LIMIT` | `1200` | P1 | 19.10 | req/phút/IP trên `/deliver/*`; `0` = tắt |

Nguyên tắc: mọi knob là env (không settings row) → không đụng setup wizard (xem setup-impact trong `requirements.md`).

## 20. Rollout sketch

1. **P0** (Req 1–6): mỗi hạng mục một PR độc lập; delivery HTTP cache sau cùng trong P0 (cần test matrix đầy đủ nhất).
2. **P1**: PR1 = Cache Provider v2 + contract tests (không caller mới) → PR2 = delivery app-cache + item invalidation + revalidation → PR3 = SWR/single-flight + perm versioning → PR4 = middleware consolidation (sau khi behavioural matrix test merge trước) → PR5 = audit queue → PR6 = rate limiter → PR7 = observability.
3. **P2**: PR1 = role split + leader lock → PR2 = flow async → PR3 = index + transactional writes → PR4 = CDC remove/wire → PR5 = CI gate.
4. Mỗi phase kết thúc: chạy k6, điền bảng roadmap §2, rà DoD (đặc biệt 2b two-site smoke + Setup Impact Registry).

## 21. Open questions (chốt trước khi code phase liên quan)

1. §4.5 phương án B (remove CDC invalidator) — cần maintainer xác nhận không có roadmap ghi-ngoài-API.
2. ~~§8 delivery có nằm trong rate limiter không (hiện: không) — xem lại sau baseline.~~ **CHỐT: có** — §14.9 (Req 19.10), limiter riêng keyed theo IP. Sửa "skip deliver" ở tasks task 13.2.
3. §11 Caddy plugin ratelimit vs app-level only — phụ thuộc chấp nhận custom Caddy build.
4. §12 tương tác transaction tường minh với `withRls` set_config — cần spike xác nhận trên cả 3 connection path (`db.ts:19-65`) trước khi viết Req 16.5.
5. §10.3 AI chat async tái dùng `flow_runs` hay bảng riêng.
6. ~~§14.9 ngưỡng `LUMIBASE_DELIVER_RATE_LIMIT` = 1200/phút/IP là ước lượng chưa đo.~~ **CHỐT (2026-08-01):** giữ **1200/phút/IP**. Đo bằng `load-penetration.js` (50 RPS ≈ 3000/phút, một IP, cửa sổ 40s): sau ~24s limiter trả **429** (~40% request trong mẫu) — đúng vai trò lưới chống lạm dụng origin, không phải quota CDN. Synthetic single-IP load test đo DB-query-per-404 nên đặt `LUMIBASE_DELIVER_RATE_LIMIT=0` (hoặc nâng tạm). IP đã lấy qua helper XFF/`CF-Connecting-IP` sẵn có; nếu CDN gộp nhiều user vào ít IP egress thì tầng 3 kém hiệu quả — tầng 1+2 (guard + tombstone) vẫn độc lập. Không hạ default dưới 1200 sau phép đo này.
7. ~~§14.3 `unavailable` trên KV chỉ phát khi `get` ném.~~ **CHỐT (2026-08-01, spike Workers KV docs):** `KVNamespace.get` **trả `null` khi miss** (không ném). Platform docs khuyến nghị `try/catch` cho lỗi hạ tầng/runtime — khi `get` thực sự ném, adapter map sang `unavailable` (đúng). Soft failure nếu surface như `null` sẽ sụp về `miss` → gọi `load`/DB (Req 19.9 degrade an toàn, không 5xx giả). **`unavailable` quan sát được chủ yếu trên Docker/Redis**; trên CF nó là đường hiếm (throw thật), không phải tín hiệu miss.
