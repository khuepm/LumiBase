# Design Document — Content Environments

## Overview

Thiết kế cho **Content Environments**: fork một site thành môi trường cô lập, rồi đưa schema và nội dung ngược về site gốc có phát hiện xung đột.

Quyết định trung tâm: **một Environment là một site con**, không phải một cột `environment_id` trên mọi bảng. LumiBase đã cô lập mọi thứ theo `site_id` (query, RLS, cache key, search index, tenant middleware). Thêm một chiều thứ hai sẽ buộc sửa mọi query và mọi policy; dùng lại chiều sẵn có thì cô lập đến miễn phí, và phần việc thật sự dồn vào ba chỗ khó: **ánh xạ danh tính** (Lineage), **tổ tiên chung** (Base), **viết lại tham chiếu**.

Tái sử dụng:

- `provisionSite()` (`apps/cms/src/services/site-provisioning.ts:27`) tạo site con + roles.
- `ConfigExportService.export` + `buildConfigDiff` (`config-diff.ts:218`) + `ConfigImportService.dryRun/apply` (`config-import-service.ts:79`, `:109`) cho Schema_Promote.
- `hashData()` (`content-version-service.ts:30`) cho Base_Hash.
- `ItemService.patch` (`item-service.ts:1090`) và `revertRevision` (`:1660`) cho ghi và hoàn tác.
- `QueueProvider` (`packages/runtime/src/interfaces/queue.ts`) cho job Fork/Merge; không import CF bindings.
- Pattern pre-flight của `ReleaseService` (`all_or_nothing` = kiểm mọi item trước khi ghi) vì `ItemService.patch` không nhận `tx`.

## Architecture

```
┌──────────────── Admin / Editor (Studio · REST) ────────────────┐
│ POST   /environments                    fork (async)            │
│ GET    /environments · /environments/:key                       │
│ DELETE /environments/:key                                       │
│ POST   /environments/:key/promote/schema   { dryRun }           │
│ POST   /environments/:key/promote/content  { dryRun, items? }   │
│ POST   /environments/:key/merge            { dryRun, resolutions}│
│ POST   /environments/:key/merge-runs/:id/revert                 │
└───────────────────────────────┬────────────────────────────────┘
                                ▼
┌──────────────────────────── CMS (Hono) ─────────────────────────┐
│ routes/environments.ts → EnvironmentService (scoped: Origin)    │
│                                                                  │
│  fork ──enqueue──▶ environment-fork worker (batched, resumable) │
│        provisionSite → copy schema → copy items → rewrite refs  │
│        → write lineage                                           │
│                                                                  │
│  promoteSchema: export(env) ─ remap by lineage ─ diff(origin)   │
│                 → ConfigImportService.apply(origin)             │
│                                                                  │
│  promoteContent / merge:                                         │
│     classify(item) by lineage.baseHash vs hash(origin), hash(env)│
│     threeWay(base, origin, env) → MergePlan                      │
│     preflight(all) → ItemService(origin).patch(If-Match)        │
│     → merge_runs + lineage.baseHash update                      │
└───────┬───────────────────────────────────────────┬─────────────┘
        ▼                                           ▼
  ItemService(siteId = env)                 ItemService(siteId = origin)
        └──────────── Postgres: sites · environments ·
                      environment_lineage · merge_runs ·
                      items · revisions ────────────┘
```

Hai `ItemService` instance, mỗi cái scoped một site. `EnvironmentService` là nơi **duy nhất** cầm cả hai `siteId`, và nó tự nạp cặp (Origin, Environment) từ bảng `environments` — không nhận `siteId` thứ hai từ request.

## 1. Traceability

| Requirement | Thiết kế |
|---|---|
| Req 1 (data model) | §2 |
| Req 2 (fork) | §3 |
| Req 3 (files) | §3.4 |
| Req 4 (side systems) | §4 |
| Req 5 (list/delete/limit) | §5 |
| Req 6 (write precondition) | §6 |
| Req 7 (schema promote) | §7 |
| Req 8 (content promote) | §8 |
| Req 9 (three-way merge) | §9 |
| Req 10 (atomicity/revert) | §10 |
| Req 11 (tenancy/guards) | §11 |
| Req 12 (audit) | §10.3 |
| Req 13 (HITL) | §12 |
| Req 14 (rollout) | §13 |

## 2. Data model

Ba bảng mới trong `packages/database/src/schema/cms.ts`, tất cả `id()` nanoid.

```ts
environments {
  id, siteId            // site con, unique, FK sites cascade
  parentSiteId          // Origin, FK sites cascade
  key, name             // unique (parentSiteId, key)
  status                // forking | ready | merging | merged | failed | archived
  statusReason
  contentScope          // jsonb: { mode: 'none' | 'collections' | 'all', collections?: string[] }
  forkCursor            // jsonb: tiến độ fork để resume
  forkedBy, forkedAt, mergedAt, createdAt, updatedAt
}

environment_lineage {
  id, siteId            // = site con (để RLS + scopeSite hoạt động)
  environmentId         // FK environments cascade
  kind                  // collection | field | relation | item | file | folder
  envRowId, originRowId // originRowId null cho dòng tạo mới trong env sau khi promote
  baseHash              // hash của Origin tại lúc fork / lần promote gần nhất
  baseRevisionId        // revision mới nhất (staged=false) của item Origin tại lúc fork (nullable)
  baseSnapshot          // jsonb. Decided §14.4: luôn ghi cho item, là nguồn Base duy nhất
  // kind='item': envRowId = originRowId vì giữ id (Decided §14.9, xem §2.1)
  external              // true = tham chiếu chỉ đọc tới item ngoài contentScope
  // unique (environmentId, kind, envRowId);
  // unique (environmentId, kind, originRowId) WHERE originRowId IS NOT NULL — khoá resume của §3.1
}

merge_runs {
  id, siteId            // = Origin
  environmentId
  kind                  // schema | content | merge | revert
  status                // running | succeeded | failed | reverted
  plan                  // jsonb: MergePlan đã áp dụng (không gồm nội dung item)
  outcomes              // jsonb: [{ collection, originItemId, outcome, reason?, revisionId? }]
  startedBy, startedAt, finishedAt
}
```

`sites` không cần cột mới: quan hệ cha–con nằm ở `environments`. Một site là Environment khi có dòng `environments.siteId = site.id`.

### 2.1 Khoá của item: hiện tại và sau PR #811

Bản trước của mục này viết "`lumibase_items.id` là primary key toàn cục nên Fork phải cấp id mới cho item". Điều đó đúng trên `main` nhưng **không còn đúng** khi PR #811 (branch `feature/friendly-dijkstra-dupuli`, migration `0032_items_site_scoped_pk`) merge, và #811 dự kiến merge **trước** khi feature này được code. Thiết kế nhắm vào khoá cuối cùng.

| | `main` hiện tại | Sau #811 (khoá đích) |
|---|---|---|
| Khoá `lumibase_items` | `PRIMARY KEY (id)` toàn instance: `id: id()` với `id = () => text('id')...primaryKey()` (`packages/database/src/schema/cms.ts:23`, `:187`) | `PRIMARY KEY (site_id, id)` (`0032_items_site_scoped_pk.sql`; `cms.ts:194`, `:235` trên nhánh #811) |
| FK trỏ vào item | một cột `item_id → items.id`: `revisions` (`cms.ts:261-263`), `release_items` (`cms.ts:616-618`), `content_reviews` (`regulated.ts:90`) | FK composite cùng site `(site_id, item_id) → items(site_id, id)`: `lumibase_revisions_item_fk` (cascade), `lumibase_release_items_item_fk` (cascade), `lumibase_content_reviews_item_fk` (`SET NULL (item_id)`) |
| Kiểm id trùng khi tạo | trong `(site, collection)` (`apps/cms/src/services/item-service.ts:1874-1889`); trùng với site khác → lỗi unique của PK toàn cục (500) | trong cả site, mọi collection; race/lặp id → `409 ITEM_ID_EXISTS` qua `itemIdConflict` (`item-service.ts:1883`, `:2563` trên nhánh #811) |

**Hệ quả cho id remapping.**

- Trên `main`: Fork **bắt buộc** cấp id mới cho mọi item (hai site không giữ được cùng id). Kéo theo: lượt 2 viết lại mọi tham chiếu item→item (§3.2), so sánh phải viết lại env id → origin id trước khi hash (§8.1), promote phải viết lại ngược (§8.2). Tệ hơn, collection dùng **primary key do người dùng chọn** (`resolvePrimaryKey`, `item-service.ts:2520`; `primaryKey.id ?? nanoid()` tại `:1025`) sẽ bị đổi id trong Environment — id ở đó là dữ liệu có nghĩa (slug, mã sản phẩm), đổi nó làm Environment khác hành vi với Origin.
- Sau #811: lý do "id toàn cục" biến mất. **Decided (owner, 2026-11-16), xem §14.9: Fork giữ nguyên id item** (identity mapping). Item ở Environment là `(envSiteId, id)`, ở Origin là `(originSiteId, id)`.
  - Không còn viết lại tham chiếu **item→item** (m2o, o2m, m2m/m2a qua junction — junction cũng là item). Lượt 2 ở §3.2 chỉ còn cho tham chiếu tới bảng vẫn có PK toàn cục (xem dòng dưới).
  - Item tạo mới trong Environment được promote về Origin với **cùng id**; va chạm chỉ xảy ra với id do người dùng chọn mà Origin đã tạo sau Fork → outcome `failed` với `ITEM_ID_EXISTS` (409 từ #811), không phải 500.
  - **Vẫn cần remap** cho mọi bảng còn PK nanoid toàn cục: `collections`, `fields`, `relations` (`cms.ts:23` dùng chung `id()`), `lumibase_files`/`folders` (`platform.ts:44`). Do đó: cột `items.collection_id` luôn map sang collection của Environment; giá trị trong `items.data` trỏ tới **file/folder** vẫn phải viết lại theo lineage `file`/`folder`. Lineage schema vẫn là thứ nhận ra rename (§7) — phần đó không đổi.
- **Không phụ thuộc khoá:** field mã hoá không copy byte được trong cả hai trường hợp. AAD là `"{siteId}|{collection}|{field}|{recordId}"` (`apps/cms/src/services/crypto/aad.ts:26-28`) và DEK envelope được wrap theo `(siteId, recordId)` (`crypto/record-cipher.ts:46-53`), nên đổi `siteId` đã làm ciphertext không giải được. Fork phải decrypt bằng ngữ cảnh Origin rồi encrypt lại bằng ngữ cảnh Environment (đi qua `processCrypto`, không copy thô).

**Hệ quả cho lineage.** Với identity mapping, dòng lineage `kind='item'` có `envRowId = originRowId` (giữ cả hai cột để mọi `kind` cùng một hình dạng; assert bằng nhau cho `item`). Lineage item vẫn cần vì nó mang `baseHash`/Base (§3.3), cờ `external`, và phân biệt "item fork từ Origin" với "item tạo mới trong Environment" (`originRowId` null tới khi promote). Unique dùng cho resume (§3.1) là `(environmentId, kind, originRowId)` partial `WHERE originRowId IS NOT NULL`; giữ unique `(environmentId, kind, envRowId)`.

**Rủi ro mới do identity mapping:** khi hai site giữ cùng một id, mọi query khớp item chỉ bằng `id` sẽ chạm nhầm site kia. Trên `main`, các chỗ `eq(items.id, …)` không lọc site là `scheduler-worker.ts:101`, `:154`, `:257` — đúng các chỗ #811 sửa; các join chỉ theo `item_id` (vd. `modules/data-rights/automated-decisions-service.ts`, cũng được #811 sửa) là lớp lỗi cần canh tiếp. Với id remap, các lỗi này nằm im; với identity, chúng thành lỗi rò rỉ ngay khi có Environment đầu tiên. Vì vậy test ở §2.2 là điều kiện của GB.

### 2.2 Chiến lược test theo khoá đích

Phase B **không** bắt đầu trước khi #811 merge (ghi ở G0). Không viết hai nhánh code cho hai khoá.

1. Integration test chạy trên Postgres đã áp migration `0032` (Node 24); fixture không giả định id item duy nhất toàn instance.
2. Fork giữ id: sau fork, `(origin, id)` và `(env, id)` cùng tồn tại; số dòng và `id` khớp trong phạm vi.
3. **Canary chéo site:** sửa, soft-delete, publish/unpublish theo lịch, chạy retention sweep (`sweepDuePublish`/`sweepDueUnpublish`/`sweepRetention`) trên item của Environment → hash `data`, `status`, `updated_at` của item cùng id ở Origin không đổi một byte. Đây là test bắt các query còn khớp chỉ theo `id`.
4. Ghi trong Environment tạo revision `(envSiteId, id)` hợp lệ theo FK composite; không có revision nào của Environment trỏ vào item Origin.
5. Collection có primary key do người dùng chọn: fork rồi promote giữ nguyên id; Origin tạo trùng id sau fork → outcome `failed`/`ITEM_ID_EXISTS`, không 500, không ghi.
6. Collection có field mã hoá (shared và envelope): đọc được trong Environment sau fork; ciphertext ở Environment khác ciphertext Origin (đã encrypt lại với AAD mới).
7. Tham chiếu tới file trong `data` sau fork trỏ tới dòng `lumibase_files` của Environment; sau promote trỏ về file của Origin.

Nếu owner chọn giữ id remap (không theo đề xuất), giữ nguyên §3.2/§8 như bản cũ và bỏ mục 2, 5 ở trên; mục 3, 4, 6, 7 vẫn áp dụng.

## 3. Fork

### 3.1 Luồng

1. `POST /environments`: kiểm flag, quyền admin, giới hạn `environments.maxPerSite`, không lồng (Req 1.3). Trong một transaction: `provisionSite({ organizationId: origin.organizationId, creatorUserId })` + insert `environments(status='forking')`. Sau commit: enqueue `environment-fork`.
2. Worker chạy theo pha, mỗi pha ghi `forkCursor`:
   `schema → roles/permissions → settings → side-systems (disabled) → files → items → rewrite-refs → done`.
3. Mỗi lô insert dùng `onConflictDoNothing` trên unique `(environmentId, kind, originRowId)` của lineage → chạy lại không nhân bản (Req 2.6).

### 3.2 Sao chép item

Hai lượt, vì tham chiếu có thể vòng:

- **Lượt 1**: copy item với `data` nguyên trạng (id Origin còn trong data), ghi lineage `{ baseHash: hashData(origin.data), baseRevisionId }`.
- **Lượt 2**: với mỗi collection, đọc danh sách field quan hệ từ `relations`, viết lại id trong `data` theo lineage. Id không có lineage (ngoài `contentScope`) giữ nguyên và ghi một dòng lineage `external=true`.

`baseHash` tính trên data **Origin** trước khi viết lại, để so sánh về sau luôn ở không gian id của Origin (xem §8.1).

> Theo §2.1: khi khoá đích `(site_id, id)` được dùng (identity mapping đã duyệt, §14.9), lượt 2 chỉ còn viết lại tham chiếu tới file/folder; tham chiếu item→item giữ nguyên. Field mã hoá luôn được decrypt/encrypt lại qua `processCrypto` (AAD chứa `siteId`), không copy thô.

### 3.3 Base cho merge ba chiều

> **G0 — giả định đã kiểm chứng: đúng một phần** (chi tiết + `file:line` ở `tasks.md` → Implementation status, giả định 2). Phương án thay thế đã duyệt: §14.4 (Decided).

Bản trước: "Base = `revisions.delta.after` tại `baseRevisionId`; item chưa có revision thì ghi `baseSnapshot`". Code hiện tại cho thấy điều đó **không đủ an toàn** làm Base:

- `delta.after` đúng là **toàn bộ `data`** sau khi ghi, không phải diff (`item-service.ts:1054` create, `:1252` patch, `:1596` bulk create), và `revertRevision` dùng chính nó (`:1674-1675`). Nhưng chỉ có `data` — không có `status`, `sort`, publish window.
- Giá trị field mã hoá trong `delta.after` là **ciphertext** (`after: encryptedFinal`, `:1252`). Ở chế độ envelope mỗi lần ghi sinh DEK mới (`newEnvelopeRecordCipher`, `:2097-2099`) và chỉ `items.dek_wrapped` hiện tại được lưu (`:1230`); revision không lưu DEK → field mã hoá của revision cũ không giải được sau lần ghi kế tiếp.
- Có đường ghi `items.data` **không tạo revision**: `dependents-service.ts:272-277` (`jsonb_set` khi `set_null`/`reassign`), `envelope-migration-worker.ts:122-125`, `:141-144`, `rewrap-worker.ts:114-117`. Khi đó revision mới nhất ≠ data hiện tại.
- Revision `staged` (veto window) nằm cùng bảng, `delta.after` là bản đề xuất chưa áp dụng (`veto-service.ts:163-177`, `staged: true`). "Revision mới nhất" phải lọc `staged = false` (như `veto-service.ts:496`, `review-content-access.ts:37`).
- Hiện **không có** job dọn revision theo retention: `review-run-retention.ts:44` chỉ xoá `reviewRuns`. Revision chỉ mất khi item bị hard-delete (FK cascade `cms.ts:261-263`; #811 giữ cascade qua FK composite) hoặc site bị xoá.

Vì vậy Base phải được chụp lúc fork (và cập nhật sau mỗi promote) từ chính `items.data` đã đọc, không dựng lại từ revision. Hình dạng cụ thể chờ quyết định §14.4.

### 3.4 Files

> **G0 — giả định đã kiểm chứng: đúng một phần** (`tasks.md` → giả định 5).

Copy dòng `lumibase_files`/`lumibase_folders` với id mới (PK nanoid toàn cục, `packages/database/src/schema/platform.ts:44`), **cùng giá trị `filenameDisk`**. `filenameDisk` (`platform.ts:50`) là storage key, không unique, không ràng buộc → hai dòng ở hai site trỏ cùng object được.

Sửa so với bản trước:

- Đường xoá dòng file hiện tại **không xoá object**: `DELETE /files/:id` chỉ xoá dòng DB (`apps/cms/src/routes/files.ts:161-174`). Không có "đường xoá file hiện có" nào cần sửa để đếm tham chiếu; Req 3.2 hiện được thoả một cách thụ động. Nếu sau này thêm xoá object theo dòng file thì phải đếm tham chiếu theo `filenameDisk` trên mọi site — ghi thành điều kiện cho thay đổi đó, không phải task của feature này.
- Có **hai** không gian lưu trữ. Upload qua presigned URL của `/files` ghi object ở key thô `${Date.now()}_${filename}` không tiền tố site (`files.ts:188`, `:238`) → chia sẻ giữa hai site được. Thư viện `/media` ghi và đọc ở `sites/${siteId}/media/${key}` (`apps/cms/src/routes/media.ts:89-95`; GET `:350`, DELETE `:500`) → Environment **không đọc được** object `/media` của Origin, và `DELETE /media/:key` từ Environment chỉ chạm tiền tố của chính nó (không nguy hiểm cho Origin, nhưng cũng không chia sẻ). v1: Fork chia sẻ object của `lumibase_files`; object chỉ có trong `/media` không được chia sẻ — hoặc copy byte theo tiền tố, hoặc ghi rõ là giới hạn v1 (quyết định ở Phase B, task 4.5).

### 3.5 Không sao chép

API keys, secrets, sessions, audit, revisions, agent memory, trust ledger, releases, content versions. Revisions bắt đầu lại từ đầu trong Environment; provenance của Origin không bị nhân bản.

Bổ sung sau khi đọc code (G0):

- Setting `revalidation.targets`: mỗi lần ghi item, `runRevalidationDispatch` đọc setting này theo `siteId` và gọi URL frontend (`apps/cms/src/services/content-invalidation.ts:98-110`). Copy nó cùng "settings không nhạy cảm" sẽ làm ghi trong Environment bắn revalidation vào frontend production.
- Pipeline Firebase Sync (`packages/database/src/schema/firebase-sync.ts`): `ItemService` gọi `dispatchFirebaseSync` sau mỗi ghi (`item-service.ts:2036-2053`).
- `lumibase_materialized_collections`: bảng vật lý đặt tên theo `config.id` của dòng (`materialize-service.ts:128`), refresh `TRUNCATE` bảng đó (`:149`). Không copy dòng; nếu cần, tạo lại sau fork với id mới.

## 4. Cô lập Side_System

| Hệ thống | Trạng thái sau fork |
|---|---|
| Webhooks | copy, `enabled=false`, secret rỗng |
| Flows | copy, inactive |
| CDC subscriptions / pipelines | copy, paused |
| Intents | copy, `status='paused'`, `statusReason='environment_fork'` |
| Reconciler / planner / agent runs | không tự chạy: Content OS flags của site con mặc định OFF (`feature-flags.ts`) |
| Deployments | copy cấu hình, không token, không auto-trigger |
| Email / push | tắt qua setting `environments.sideEffects.notifications=false` |
| Search index | index riêng theo `siteId` con; build lười sau fork |
| Edge cache | key đã theo `siteId`; delivery thêm `X-Robots-Tag: noindex` |

> **G0 — giả định "cache key và search index tách theo `siteId`" đã kiểm chứng: đúng** (`tasks.md` → giả định 3): index search là `${siteId}__${collection}` (`packages/runtime/src/interfaces/search.ts:52-54`, dùng ở `item-service.ts:1920`, `:1946`, `content-indexing-worker.ts:72`, `:86`, `routes/search.ts:134`, `:195`); tag cache `items:${siteId}:${collection}` và `deliver:${siteId}` (`content-invalidation.ts:20-26`); key compiled schema theo `siteId` (`schema-service.ts:1142`, `:1162`); key delivery `deliver:${siteId}:…` (`delivery-cache.ts:132-134`). Ngoại lệ cần nhớ: materialized collection đặt tên bảng theo id dòng, không theo site (§3.5). Chưa có `X-Robots-Tag` nào trong `apps/cms/src` — phải thêm (task 5.3).

> **G0 — giả định "có một điểm dispatch chung" đã kiểm chứng: sai** (`tasks.md` → giả định 4).

Không có dispatcher chung. Sau mỗi ghi, `ItemService.patch` gọi riêng từng kênh (`item-service.ts:1285-1298`), và mỗi kênh tự đọc cấu hình theo `siteId`:

| Kênh | Điểm phát | Cấu hình đọc theo `siteId` |
|---|---|---|
| Flows | `dispatchItemEvent` (`apps/cms/src/services/flow-dispatch.ts:87-111`), gọi từ `item-service.ts:2015-2026` | `findActiveEventFlows(db, siteId, …)` (`flow-dispatch.ts:93`) |
| Webhooks | outbox CDC: `writeCdcEvent` (`item-service.ts:764`) → `CdcDispatcher` (`modules/cdc/change-feed/dispatcher.ts:158`), sender `createWebhookEnvelopeSender` (`:481`); khởi tạo ở `serve.ts:350`, `cloudflare-cron-parity.ts:90`, `modules/cdc/change-feed/routes.ts:215` | `webhooks`/`cdc_subscriptions` của site (`loadWebhookTarget`, `dispatcher.ts:459`) |
| Firebase Sync | `dispatchFirebaseSync` (`item-service.ts:2036-2053`) | pipeline của site |
| ISR revalidation | `invalidateContentCache` → `dispatchItemRevalidation` (`item-service.ts:2281-2294`, `content-invalidation.ts:122`) | setting `revalidation.targets` (`content-invalidation.ts:103-106`) |
| Extension hooks | `getHookDispatcher` (`item-service.ts:707`) | extension bật của site |
| Realtime | `publishRealtimeEvent` (`item-service.ts:1968`) | room theo site (không ra ngoài hệ thống) |
| Notifications | `InProcessNotificationDispatcher` (`modules/notifications/dispatcher.ts:329`, sự kiện bảo mật), `NotificationService` (`services/notification-service.ts:40`) | không theo ghi item |

Hệ quả cho thiết kế:

1. Lớp chặn **chính** là dữ liệu: vì mọi kênh đọc cấu hình theo `siteId` của Environment, Fork chỉ cần không copy (hoặc copy ở trạng thái disabled) cấu hình của kênh đó — bảng §4 ở trên cộng các mục bổ sung ở §3.5 (`revalidation.targets`, Firebase Sync).
1a. Ngoại lệ của lớp chặn dữ liệu — **extension hooks**: tạo site mới qua `finalizeSiteProvisioning` (`apps/cms/src/services/site-provisioning.ts:48`) gọi `reconcileOfficialExtensions`, vốn chèn mọi official extension với `enabled = enabledByDefault` (`apps/cms/src/services/official-extension-reconciler.ts:96-103`). Nếu Fork đi qua đường provisioning chuẩn, Environment sẽ có extension **bật sẵn** dù Fork không copy dòng nào, và hook của chúng chạy trên mỗi lần ghi item. Fork phải bỏ qua bước reconcile, hoặc reconcile rồi ép `enabled = false` cho mọi extension của Environment; extension của Origin cũng copy ở trạng thái disabled.
2. `isEnvironment(siteId)` (cache theo request) là lớp **phòng thủ thứ hai**, đặt ở từng điểm phát có đi ra ngoài: `dispatchItemEvent`, `CdcDispatcher` (trước khi gửi), `dispatchFirebaseSync`, `runRevalidationDispatch`, và kênh email/push. Năm điểm, không phải một; task 5.2 và gate GB đếm ở từng điểm.

## 5. List / detail / delete

- `list`/`get` scoped theo Origin (`environments.parentSiteId = siteId`).
- `originChanged` và "số item đã đổi" tính bằng so sánh hash theo lô, có giới hạn; trả `null` + cờ `truncated` khi vượt ngưỡng thay vì quét toàn bộ.
- `delete`: từ chối khi `forking`/`merging`; xoá site con (cascade theo FK `site_id`), tôn trọng §3.4. Xoá chạy nền nếu site lớn.

## 6. Write_Precondition

> **G0 — giả định "ghi item là last-write-wins" đã kiểm chứng: đúng** (`tasks.md` → giả định 1). Nguồn ETag đã duyệt: cột `version`, §14.7 (Decided).

Hành vi hiện tại của `ItemService.patch` (`item-service.ts:1090`):

- Đọc dòng bằng một `SELECT` riêng (`:1110-1122`), gộp `merged = { ...currentData, ...patch.data }` trong bộ nhớ (`:1146-1148`), rồi `UPDATE ... SET data = <toàn bộ data đã gộp>` với `WHERE` chỉ gồm `site_id`, `collection_id`, `id`, `deleted_at IS NULL` và permission clause (`:1224-1245`). Không có điều kiện phiên bản nào; không có `If-Match`/`expectedRevision` ở service hay route (`routes/items.ts:285-311`).
- Hệ quả mạnh hơn "last-write-wins theo item": hai PATCH đồng thời sửa **hai field khác nhau** vẫn mất một bên, vì mỗi UPDATE ghi đè cả `data` bằng bản gộp từ lần đọc cũ.
- `replace` (PUT) chỉ là `patch` (`:1320-1322`): field không gửi lên được giữ, không bị xoá.

Thiết kế:

- `ItemService.patch` nhận thêm `expected?: { etag }`. Khi có, `WHERE` của UPDATE ở `:1237-1245` thêm điều kiện phiên bản trong **cùng câu lệnh**; 0 dòng → phân biệt "không tồn tại/không có quyền" (404 như cũ) với "lệch phiên bản" (412 `PRECONDITION_FAILED`) bằng một lần đọc sau khi UPDATE thất bại, không phải trước.
- Route đọc `If-Match`, truyền xuống. Không có header → hành vi cũ. ETag trả ở GET detail và ở response PATCH/PUT. `If-Match` dùng **strong comparison** (RFC 9110 §13.1.1), nên không tái dùng `weakEtag` (`services/delivery-cache.ts:94-103`, sinh `W/"…"`) nguyên trạng.
- Coalesced writes **không** ảnh hưởng precondition: `beginWriteCoalescing`/`flushCoalescedWrites` chỉ hoãn materialized refresh + cache invalidation (`item-service.ts:2246-2280`, `afterWriteInvalidation` `:2271-2278`); UPDATE và revision vẫn ghi ngay trong `patch`. Bản trước nói "phải bỏ qua coalescing hoặc flush trước khi so sánh" — không cần.
- Nguồn phiên bản (`updated_at` hay cột `version`): chờ §14.7.

Phần này độc lập, giao được trước và có ích ngay cho Studio (hai editor cùng mở một item).

## 7. Schema_Promote

1. `ConfigExportService(env).export()` → manifest Environment.
2. **Remap theo lineage**: mỗi collection/field trong manifest được gắn `originRowId`. Entry có lineage nhưng khác tên → `renameFrom` (`schema-service.ts:177`). Entry không có lineage → create. Entry Origin không còn đối ứng trong Environment → delete (chỉ khi `mode` cho phép).
3. `buildConfigDiff(manifest, originState)` → `ConfigDiff` với `DiffRisk`.
4. **Schema conflict**: so `hash(entry Origin hiện tại)` với `lineage.baseHash` của entry đó. Lệch + Environment cũng đổi → conflict, cần `resolutions`.
5. Apply qua `ConfigImportService(origin).apply`, mode `merge`; thay đổi rủi ro cần `confirmRiskyChange` + `migrationPlan`.
6. Sau apply: cập nhật `baseHash` của lineage schema.

`migrationPlan` chạy trên toàn bộ item Origin (Req 7.5) — đây là hành vi sẵn có của `SchemaService`, Environment không thêm đường migrate riêng.

## 8. Content_Promote

### 8.1 Phân loại

So sánh luôn ở **không gian id của Origin**: data Environment được viết lại tham chiếu (env id → origin id) trước khi hash.

| Origin vs Base | Env vs Base | Kết quả |
|---|---|---|
| = | = | unchanged |
| = | ≠ | **promote** |
| ≠ | = | origin-only (không làm gì) |
| ≠ | ≠ | **conflict** (Content_Promote bỏ qua; Merge xử lý ở §9) |
| — | không lineage | **create** |
| còn | soft-deleted | **delete** |

### 8.2 Áp dụng

- Sắp thứ tự: create trước (theo đồ thị phụ thuộc; vòng thì tạo trước, patch tham chiếu sau), rồi update, rồi delete.
- Tham chiếu tới item mới chưa promote và không nằm trong lần chạy → outcome `failed` với `DEPENDENCY_NOT_PROMOTED`.
- Mỗi ghi gọi `ItemService(origin).patch(..., { expected })` → permission, validation, editorial gate, `pinnedFields`, hooks, revision đều do `ItemService` lo.
- Schema gate: collection có diff schema chưa promote → `SCHEMA_NOT_PROMOTED`.
- Sau mỗi item thành công: `lineage.baseHash = hash(origin mới)`, `baseRevisionId = revision vừa tạo`.

## 9. Merge ba chiều

```ts
type FieldChange = { field: string; locale?: string; base: unknown; origin: unknown; env: unknown };
type MergePlan = {
  schema: ConfigDiff;
  items: Array<{
    collection: string; originItemId: string | null; envItemId: string;
    action: 'promote' | 'create' | 'delete' | 'merge' | 'conflict';
    auto: FieldChange[];        // một bên đổi → tự lấy
    conflicts: FieldChange[];   // hai bên đổi khác nhau
  }>;
  truncated: boolean;
};
```

- Đơn vị so sánh: field top-level của `data`. Field đa ngôn ngữ (theo định nghĩa field, không đoán theo hình dạng giá trị) tách tiếp theo locale.
- So sánh bằng deep-equal trên JSON đã chuẩn hoá thứ tự key. Mảng (blocks, m2m) coi là **một giá trị nguyên khối** ở v1; merge theo phần tử là open question.
- `threeWay()` là hàm thuần, không I/O → dễ property-test.
- Resolution `custom` đi qua validation của field như một lần ghi thường.
- Base không dựng được → mọi field khác nhau giữa Origin và Environment thành conflict (Req 9.7).

Studio: màn Merge liệt kê item theo nhóm action; conflict mở khung ba cột Base / Origin / Environment, tái dùng `RevisionsDiff` cho phần render diff.

## 10. Nguyên tử, khoá, hoàn tác

### 10.1 Khoá

Chuyển `environments.status` sang `merging` bằng conditional UPDATE (`status='ready'`) kèm kiểm không có Environment anh em nào đang `merging` trên cùng Origin. Không dùng advisory lock để giữ tương thích Hyperdrive/transaction pooling.

### 10.2 Pre-flight rồi mới ghi

`ItemService.patch` không nhận `tx` (đã chốt ở content-releases), nên không có rollback DB xuyên nhiều item. Thay vào đó:

1. Pre-flight toàn bộ: quyền, validation, editorial gate, schema gate, hash Origin còn khớp plan.
2. Ghi tuần tự với Write_Precondition; item lệch giữa chừng → outcome `conflict`, tiếp tục.
3. `merge_runs.outcomes` ghi từng item + `revisionId`.
4. Chạy lại sau lỗi: phân loại lại theo `baseHash` đã cập nhật → item đã áp dụng thành `unchanged`.

Kết quả là **nguyên tử theo từng item, resumable theo lần chạy**, không phải all-or-nothing tuyệt đối. Requirement 10 được viết đúng theo mức này.

### 10.3 Hoàn tác và audit

`revert` duyệt `outcomes`, với mỗi item gọi `revertRevision` về revision cha của `revisionId`, có precondition "revision mới nhất vẫn là `revisionId`"; không khớp → `conflict`. Item `created` bị soft-delete. Schema_Promote **không** hoàn tác tự động (migration dữ liệu không đảo được); UI nói rõ điều này trước khi apply.

Lưu ý từ code (G0): `revertRevision` (`item-service.ts:1660-1676`) gọi `replace` với `delta.after`, mà `replace` là merge (`:1320-1322`) → field được thêm sau revision đích **không** bị gỡ, tức không phải khôi phục đúng trạng thái. Với collection có field mã hoá, `delta.after` là ciphertext và được đưa lại vào `patch` như plaintext (bị encrypt lần nữa, `:2097`). Hoàn tác merge run không dựa thẳng vào `revertRevision` hiện tại: dùng Base/snapshot lưu trong `merge_runs` hoặc lineage (§14.4) và ghi bằng `patch` có precondition, hoặc sửa `revertRevision` trước (task riêng).

Audit qua `AuditLogger` sẵn có; revision tạo bởi merge mang `sources: [{ type: 'environment', environmentId, mergeRunId }]` (cột `revisions.sources` đã có).

## 11. Tenancy và route guard

- `EnvironmentService` constructor nhận `siteId` (Origin) từ context; nạp Environment bằng `(parentSiteId = siteId, key)` rồi mới lấy `env.siteId`. Request không bao giờ cung cấp site thứ hai.
- Assert `origin.organizationId === envSite.organizationId` trước mọi thao tác xuyên site.
- Quyền: admin Origin cho fork/delete/schema promote; với content promote/merge, kiểm quyền ghi từng collection ở Origin qua `ItemService` của chính người gọi.
- RLS: thao tác xuyên site mở hai phạm vi RLS tuần tự (mỗi `ItemService` call set `site_id` riêng), không nới policy.
- Route mount sau `auth` + `site-admin`; từ chối principal là API key. Test route-guard theo DoD §2c.
- Tenant resolution không đổi: Studio vào Environment bằng cách chọn site con (`tenant.ts`, nhánh header site).

## 12. HITL

Không đăng ký skill nào ở v1. Nếu sau này thêm, `promote_schema` mang `schema:write` và `delete_environment` bắt đầu bằng `delete` → cả hai tự rơi vào `ai_approvals` theo quy tắc sẵn có.

## 13. Rollout

- Flag theo site `environments.enabled`, mặc định OFF; route trả 404 khi OFF.
- Thứ tự giao: Write_Precondition (§6) → Fork + cô lập (§3–5) → Schema_Promote (§7) → Content_Promote (§8) → Merge + UI (§9–10). Mỗi bước tự có giá trị và dừng được.
- Setup Impact: dự kiến `n/a` cho seed/wizard (ba bảng rỗng khi init), **có** settings key mới (`environments.maxPerSite`, `environments.enabled`) với default an toàn.

## 14. Open questions (đã chốt)

Cả chín mục dưới đây đã được owner duyệt theo đúng khuyến nghị của G0 và mang nhãn `Decided (owner, 2026-11-16)`. Tên mục giữ là "Open questions" để các tham chiếu `§14.x` trong spec không đổi; không mục nào còn mở. Con số thời gian ở §14.1 là mục tiêu cần đo ở gate GB, chưa phải số đã đo. §14.9 có điều kiện: chỉ có hiệu lực sau khi PR #811 merge (hiện còn mở).

1. **Chi phí fork site lớn — giới hạn item và ngân sách thời gian.** v1 copy hàng thật, chặn bằng `contentScope` và giới hạn số item. Copy-on-write hoặc Neon branch là hướng sau, nhưng Neon branch không dùng được cho Docker.
   - *Dữ kiện:* code đã có hai mẫu batch resumable để bám theo — lô mặc định 100, tối đa 500 dòng mỗi lô theo cursor (`envelope-migration-worker.ts:52`, `rewrap-worker.ts:42`), insert item theo chunk 100 (`BULK_INSERT_CHUNK`, `item-service.ts:76`); giới hạn bulk API mặc định 500 (`bulkMaxItems`, `item-service.ts:78-82`). Queue consumer trên Workers đang cấu hình `max_batch_size` 1–10 (`apps/cms/wrangler.toml:127-172`). Fork phải decrypt/encrypt lại field mã hoá (§2.1), nên chi phí mỗi item cao hơn một `INSERT … SELECT`.
   - **Quyết định — Decided (owner, 2026-11-16):** `environments.maxItemsPerFork` mặc định **50 000** (cấu hình được theo site, vượt → từ chối khi tạo với `ENVIRONMENT_TOO_LARGE` 409, đếm trước khi `provisionSite`); lô **100** item mỗi bước; mỗi lần chạy job xử lý tối đa **10 lô hoặc ~20 giây wall-clock** rồi ghi `forkCursor` và tự enqueue lần kế (cùng mẫu `maxBatches` của `envelope-migration-worker.ts:164-177`), để mỗi invocation trên Workers ngắn và resumable; **ngân sách tổng** cho gate GB: fork 50 000 item hoàn tất trong **≤ 15 phút** trên Docker tham chiếu và trên Workers (đo ở staging, ghi kết quả vào PR Phase B; nếu Workers không đạt, hạ default chứ không nới ngân sách). `environments.maxPerSite` mặc định **3** (như Req 5.4).
   - *Trade-off:* 50k đủ cho phần lớn site biên tập và giữ dung lượng nhân đôi (data + snapshot Base, §14.4) trong giới hạn; site lớn hơn phải fork theo `collections[]`. Con số thời gian là mục tiêu cần đo, không phải số đã đo.
2. **Rebase Environment theo Origin** (kéo thay đổi production vào nhánh đang sống). Cùng thuật toán ba chiều nhưng ngược hướng; hoãn tới khi Merge ổn định.
   - **Quyết định — Decided (owner, 2026-11-16):** hoãn sau v1.
3. **Merge theo phần tử mảng** (blocks, m2m). v1 coi mảng là nguyên khối → conflict nhiều hơn cần thiết với nội dung dạng block.
   - **Quyết định — Decided (owner, 2026-11-16):** hoãn sau v1.
4. **Base an toàn với retention.** Bản trước lo `baseRevisionId` bị retention dọn.
   - *Dữ kiện (G0):* hiện **không** có job dọn revision (`review-run-retention.ts:44` chỉ xoá `reviewRuns`); revision chỉ mất theo FK cascade khi item bị hard-delete (`cms.ts:261-263`) — tức là chính item cũng mất. Rủi ro thật nằm ở chỗ khác (§3.3): revision chỉ có `data`; field mã hoá là ciphertext mà DEK envelope bị thay sau mỗi ghi (`item-service.ts:2097-2099`, `:1230`); có đường ghi `data` không tạo revision (`dependents-service.ts:272-277`, `envelope-migration-worker.ts:122-125`, `:141-144`, `rewrap-worker.ts:114-117`); revision `staged` lẫn trong cùng bảng (`veto-service.ts:163-177`). Một chính sách retention revision tương lai sẽ chỉ làm tệ thêm.
   - **Quyết định — Decided (owner, 2026-11-16):** bỏ `baseRevisionId` khỏi vai trò nguồn Base (giữ làm con trỏ provenance, nullable). **Luôn** lưu `baseSnapshot` cho mọi item fork (và cập nhật sau mỗi promote/merge thành công) = `data` Origin đã đọc trong cùng lô fork, với field mã hoá thay bằng hash per-field của plaintext (`{ "$enc": "<sha256>" }`) thay vì giá trị. Merge ba chiều so field mã hoá bằng hash: một bên đổi → lấy bên đó; hai bên đổi → conflict, resolution chỉ cho `origin`/`environment` (không `custom` hiển thị giá trị). `baseHash` đổi từ FNV-1a 32-bit của `hashData` (`content-version-service.ts:30-39`) sang SHA-256 (đã dùng qua `crypto.subtle` ở `delivery-cache.ts:94-103`) vì quyết định "không ghi đè" dựa hoàn toàn vào nó.
   - *Trade-off:* nhân đôi dung lượng `data` cho phạm vi fork (bị chặn bởi §14.1, xoá theo cascade khi xoá Environment) đổi lấy Base không phụ thuộc retention, mã hoá hay đường ghi bỏ revision; không lưu thêm plaintext của field mã hoá. Phương án rẻ hơn (giữ `baseRevisionId` + ghim revision khỏi retention) không giải quyết ba rủi ro còn lại nên không khuyến nghị. Nếu duyệt: sửa lời Req 9.7 và Glossary (Lineage/Base_Revision) từ "Base lấy từ Base_Revision" sang "Base lấy từ snapshot lưu ở Lineage".
5. **External reference** tới item ngoài `contentScope`: chỉ đọc là đủ, hay cần "kéo thêm" item vào Environment sau fork?
   - **Quyết định — Decided (owner, 2026-11-16):** v1 chỉ đọc; "kéo thêm" hoãn sau v1.
6. **Quota theo organization** thay vì theo site, khi organizations (ADR-013) có billing.
   - **Quyết định — Decided (owner, 2026-11-16):** hoãn sau v1; v1 chỉ có `environments.maxPerSite`.
7. **Nguồn ETag.**
   - *Dữ kiện (G0):* chưa có phiên bản nào trên `items` ngoài `updated_at` (`cms.ts:224`, `timestamp('updated_at')`). Giá trị được đặt từ đồng hồ ứng dụng `new Date()` (độ phân giải mili-giây; `item-service.ts:1235`), không phải `now()` của DB, nên hai ghi cùng mili-giây hoặc lệch đồng hồ giữa các worker cho cùng `updated_at`. Các đường đổi `updated_at` mà không đổi `data`: `releasePin` (`:2384-2386`), `cryptoShred` (`:1462-1463`), editorial transition (`editorial-service.ts:184-186`), scheduler (`scheduler-worker.ts:99-100`, `:147-152`, `:255-256`). Đường đổi `data` nhưng **không** đổi `updated_at`: `envelope-migration-worker.ts:122-125`, `:141-144`, `rewrap-worker.ts:114-117` (chỉ đổi ciphertext, plaintext giữ nguyên). Thành phần "id revision mới nhất" của bản trước cần thêm một query mỗi GET và không phản ánh các đường ghi không tạo revision.
   - **Quyết định — Decided (owner, 2026-11-16):** thêm cột `version integer NOT NULL DEFAULT 0` trên `lumibase_items` (`ADD COLUMN … DEFAULT` hằng số không rewrite bảng trên PG ≥ 11), tăng `version = version + 1` trong **mọi** câu UPDATE đổi `data`/`status` (`patch` `:1224`, `dependents-service.ts:273`, `editorial-service.ts:185`, `scheduler-worker.ts:99`, `:148`, `:255`, `releasePin`/`cryptoShred`). ETag strong = `"<version>"` (item id đã nằm trong URL). Precondition = `AND version = $expected` trong cùng UPDATE. Worker envelope/rewrap không tăng `version` (nội dung logic không đổi).
   - *Trade-off:* một migration trên bảng nóng (viết tay, số cấp lúc merge, cao hơn `0032` của #811) và phải chạm ~7 call site, đổi lại so sánh chính xác, không phụ thuộc đồng hồ. Phương án không migration (`updated_at` + `clock_timestamp()` phía DB) vẫn có thể trùng và buộc sửa cùng số call site, nên không khuyến nghị.
8. **Phạm vi v1: dừng ở Phase D (promote một chiều) hay đi hết Phase E (merge ba chiều + UI + hoàn tác).**
   - *Dữ kiện (G0):* Phase D an toàn tự thân — item lệch Base bị bỏ qua, không ghi đè (§8.1). Phase E phụ thuộc Base chính xác (§14.4), metadata đa ngôn ngữ theo field, và hoàn tác — mà `revertRevision` hiện là merge, không phải khôi phục, và không xử lý đúng field mã hoá (§10.3, `item-service.ts:1320-1322`, `:1660-1676`).
   - **Quyết định — Decided (owner, 2026-11-16):** v1 = Phase A–D. Phase E (task 8–10) là v1.1. Chuyển task 10.1 (màn Merge_Plan chỉ đọc) sang Phase D để người dùng xem dry-run của Content_Promote trong Studio.
   - *Trade-off:* v1 không tự hợp nhất item hai bên cùng sửa — người dùng phải sửa tay ở Origin rồi promote lại, hoặc fork mới. Đổi lại v1 không phải giao hoàn tác (vốn cần sửa `revertRevision` trước) và gate GE không chặn release.
9. **Giữ id item khi fork (sau #811).** Xem §2.1.
   - **Quyết định — Decided (owner, 2026-11-16):** giữ id (identity mapping) cho item, remap cho schema/file/folder; Phase B chỉ bắt đầu sau khi #811 merge. Kéo theo sửa lời Req 2.4 ("sinh id mới cho mọi dòng sao chép" → "trừ item"), Req 2.5 (chỉ viết lại tham chiếu file/folder), Req 8.3 và 8.6 (item mới được tạo ở Origin với cùng id), và bỏ task 7.2 phần viết lại item→item.
   - *Trade-off:* bớt hẳn một lớp viết lại tham chiếu hai chiều (nguồn lỗi chính của §3.2/§8.2) và giữ đúng primary key do người dùng chọn; đổi lại mọi query khớp item chỉ theo `id` thành lỗi rò rỉ chéo site — được canh bằng test §2.2 mục 3.
