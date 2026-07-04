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

## 14. Rollout sketch

1. **P0** (Req 1–6): mỗi hạng mục một PR độc lập; delivery HTTP cache sau cùng trong P0 (cần test matrix đầy đủ nhất).
2. **P1**: PR1 = Cache Provider v2 + contract tests (không caller mới) → PR2 = delivery app-cache + item invalidation + revalidation → PR3 = SWR/single-flight + perm versioning → PR4 = middleware consolidation (sau khi behavioural matrix test merge trước) → PR5 = audit queue → PR6 = rate limiter → PR7 = observability.
3. **P2**: PR1 = role split + leader lock → PR2 = flow async → PR3 = index + transactional writes → PR4 = CDC remove/wire → PR5 = CI gate.
4. Mỗi phase kết thúc: chạy k6, điền bảng roadmap §2, rà DoD (đặc biệt 2b two-site smoke + Setup Impact Registry).

## 15. Open questions (chốt trước khi code phase liên quan)

1. §4.5 phương án B (remove CDC invalidator) — cần maintainer xác nhận không có roadmap ghi-ngoài-API.
2. §8 delivery có nằm trong rate limiter không (hiện: không) — xem lại sau baseline.
3. §11 Caddy plugin ratelimit vs app-level only — phụ thuộc chấp nhận custom Caddy build.
4. §12 tương tác transaction tường minh với `withRls` set_config — cần spike xác nhận trên cả 3 connection path (`db.ts:19-65`) trước khi viết Req 16.5.
5. §10.3 AI chat async tái dùng `flow_runs` hay bảng riêng.
