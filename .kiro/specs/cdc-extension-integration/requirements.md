# Requirements Document — CDC Extension Integration (Change Feed & Connectors)

## Introduction

Tài liệu yêu cầu cho năng lực **CDC Extension Integration** — cung cấp một **Change Feed first-party** cho chính dữ liệu nội dung của LumiBase, để các hệ thống bên ngoài và các extension có thể **đăng ký nhận mọi thay đổi nội dung** (create/update/delete) một cách tin cậy, có thứ tự, có replay — và trên nền đó viết được **sink connector** đồng bộ dữ liệu LumiBase sang hệ thống khác (search index, data warehouse, Firebase, CRM, cache ngoài…).

### Vấn đề cần giải (pain point)

> *"Không có cách nào tin cậy để một hệ thống bên ngoài hoặc một extension biết 'nội dung nào vừa thay đổi' trong LumiBase. Hook extension hiện tại là sync in-process, best-effort, không có delivery guarantee, không replay được; bảng `webhooks` có schema nhưng chưa có dispatcher; module `cdc` hiện tại chỉ provisioning hạ tầng replication ngoài (Postgres → ClickHouse) chứ không phát event nội dung."*

Pain point tách thành ba nhu cầu cốt lõi:

1. **Capture** — mọi mutation nội dung phải sinh đúng một Change_Event bền vững, có thứ tự, không phụ thuộc consumer nào đang online.
2. **Deliver** — consumer nhận event qua pull (cursor API), push (webhook có chữ ký), hoặc extension subscriber trong sandbox — at-least-once, retry, replay.
3. **Connect** — extension author viết được sink connector (kiểu `lumibase-firebase-sync`) bằng SDK chính thức, gated theo capability, không cần fork core.

### Định vị trên kiến trúc hiện có

Spec này xây trực tiếp trên các lớp đã ship, không phát minh lại:

- **Module `cdc`** (`apps/cms/src/modules/cdc/`) — đã có control plane Postgres→ClickHouse (spec `clickhouse-cdc`); Change Feed là thành phần mới cùng module, mount chung namespace `/api/v1/cdc`, router con với guard riêng (feed không yêu cầu admin, chỉ capability).
- **ItemService lifecycle + HookDispatcher** (`apps/cms/src/extensions/hook-dispatcher.ts`) — điểm chèn ghi outbox ngay tại mutation; hook sync hiện có giữ nguyên hành vi.
- **Bảng `webhooks`** (`packages/database/src/schema/platform.ts:141`, tên vật lý `lumibase_webhooks` theo ADR-010) — đã có `url/actions/collections/headers/secret/status`, tái dùng làm delivery target; spec này bổ sung dispatcher còn thiếu.
- **Quy ước tên bảng (ADR-010)** — mọi bảng hệ thống mang prefix `lumibase_`; migration đã reset greenfield về `0000_lumibase_init` + `migration-guard.ts`. 3 bảng mới của spec dùng tên `lumibase_cdc_*` và thêm qua migration incremental (không sửa init).
- **Runtime abstraction** (`packages/runtime`) — `QueueProvider` (BullMQ trên Docker, CF Queues trên Workers) cho dispatch job; pattern sweep theo `scheduler-worker`.
- **Extension sandbox + capability model** (`apps/cms/src/extensions/sandbox.ts`, `docs/en/features/extensions-system.md`) — subscriber chạy trong sandbox, capability dạng `cdc:subscribe:<collection>`.
- **Auth API key → role/policy** (`middleware/auth.ts`, `PermissionService`) — machine-to-machine đọc feed bằng API key, resolve capability qua RBAC hiện có. Theo ADR-011 (tách realm), feed là control-plane: chỉ realm `studio`/API key được truy cập, token audience `frontend`/`subscriber` bị từ chối (`withStudioAccess`).
- **SSRF guard + guardedFetch** (pattern của `deployment-integrations`) — mọi outbound webhook đi qua `validateOutboundUrl` + timeout.
- **Notifications module** (`apps/cms/src/modules/notifications/`) — cảnh báo khi subscription bị pause/dead.
- **Masking theo classification** (`regulated-content-readiness`: `fields.classification` pii/phi) — payload event phải mask trước khi lưu/deliver.
- **Audit & Provenance** (`apps/cms/src/modules/audit/`) — actor của mỗi event (user / api_key / agent run) đi vào envelope.

## Glossary

- **Change_Feed**: Tổng thể năng lực mô tả trong spec này — log sự kiện thay đổi nội dung + các đường phân phối.
- **Change_Event**: Một bản ghi bất biến mô tả một mutation (create/update/delete) trên một item. Bảng `lumibase_cdc_change_events` (transactional outbox, append-only).
- **Event_Envelope**: Cấu trúc JSON chuẩn hoá, có `schemaVersion`, bao ngoài mỗi Change_Event khi deliver (CloudEvents-inspired).
- **Cursor**: Con trỏ vị trí đọc trong feed — chính là `id` (UUIDv7, k-sortable theo thời gian) của Change_Event cuối cùng đã xử lý.
- **Subscription**: Bản ghi đăng ký một consumer (pull / webhook / extension) kèm filter và checkpoint cursor. Bảng `lumibase_cdc_subscriptions`.
- **Dispatcher**: Relay đọc Change_Event sau cursor của từng Subscription và phân phối (outbox-relay pattern), chạy trên `QueueProvider` + sweep định kỳ.
- **Delivery**: Một lần thử phân phối một batch event tới một Subscription, có kết quả và attempt. Bảng `lumibase_cdc_deliveries` (append-only).
- **CDC_Subscriber_Extension**: Extension (type `hook`) đăng ký nhận Change_Event async qua sandbox, khai báo capability `cdc:subscribe:<collection>`.
- **Sink_Connector**: Extension/dịch vụ dùng Change_Feed để đồng bộ dữ liệu LumiBase sang hệ thống ngoài (mẫu tham chiếu: `modules/lumibase-firebase-sync`).
- **Payload_Mode**: Chế độ nội dung khi deliver — `reference` (chỉ id + metadata, consumer tự fetch) hoặc `snapshot` (kèm bản ghi sau mutation, đã mask).
- **Site**: Đơn vị multi-tenancy — mọi bảng mới scope theo `siteId`, RLS site-isolation.

## Requirements

### Requirement 1: Change Event Log (transactional outbox)

**User Story:** Là một lập trình viên tích hợp, tôi muốn mọi thay đổi nội dung được ghi thành sự kiện bền vững, có thứ tự ngay khi mutation commit, để consumer không bỏ lỡ thay đổi nào dù online hay offline.

#### Acceptance Criteria

1. THE Change_Feed SHALL cung cấp bảng `lumibase_cdc_change_events` với các cột: `id` (uuidv7, PK — vừa là Cursor, k-sortable theo thời gian, tuân rule #1 `CLAUDE.md` cho bảng audit/append-only), `siteId` (text, NOT NULL, FK), `collection` (text, NOT NULL), `itemId` (text, NOT NULL), `operation` (text, NOT NULL, `'create' | 'update' | 'delete'`), `payload` (jsonb, nullable — snapshot sau mutation, đã mask), `changedFields` (jsonb, nullable — danh sách field đổi với update), `schemaVersion` (integer, NOT NULL, default 1), `actorType` (text, NOT NULL, `'user' | 'api_key' | 'agent' | 'system'`), `actorId` (text, nullable), `source` (text, NOT NULL, `'api' | 'agent' | 'flow' | 'system'`), `occurredAt` (timestamptz, NOT NULL). Index theo `(siteId, id)` và `(siteId, collection, id)`.
2. WHEN một mutation item (create/update/delete) commit thành công qua ItemService và Change_Feed đang bật cho site, THE Change_Feed SHALL ghi đúng MỘT Change_Event tương ứng **trong cùng database transaction** với mutation (transactional outbox).
3. IF driver database của runtime không hỗ trợ transaction đa-statement (ví dụ HTTP driver trên Cloudflare Workers), THEN THE Change_Feed SHALL ghi Change_Event ngay sau mutation trong cùng request, và IF ghi outbox thất bại THEN ghi một audit warning (`cdc_event_write_failed`) kèm collection + itemId, KHÔNG làm fail mutation đã commit.
4. THE Change_Feed SHALL mask mọi field có `classification` `pii`/`phi` (theo `regulated-content-readiness`) trong `payload` TRƯỚC khi lưu; giá trị encrypted-at-rest không bao giờ xuất hiện plaintext trong outbox.
5. THE Change_Feed SHALL chỉ ghi outbox khi site có ít nhất một Subscription `active` HOẶC setting `cdc_feed.enabled=true` — site không dùng feed không trả chi phí ghi (cờ này được cache và invalidate khi Subscription thay đổi).
6. THE Change_Feed SHALL KHÔNG dùng serial/auto-increment cho bất kỳ cột nào; thứ tự toàn cục per site được suy từ UUIDv7 `id`.

### Requirement 2: Pull Change Feed API (cursor-based)

**User Story:** Là một hệ thống bên ngoài, tôi muốn poll một API cursor-based để lấy các thay đổi kể từ lần đọc trước, để đồng bộ dữ liệu theo nhịp của riêng tôi mà không cần hạ tầng nhận webhook.

#### Acceptance Criteria

1. THE Change_Feed SHALL cung cấp `GET /api/v1/cdc/events` với query `cursor` (uuidv7, exclusive — trả event có `id > cursor`), `collections` (CSV, optional), `operations` (CSV, optional), `limit` (default 100, max 500), trả về danh sách Change_Event theo thứ tự `id` tăng dần, response format `{ data: T[], meta: { nextCursor, hasMore } }`.
2. THE Change_Feed SHALL bảo đảm phân trang bằng `nextCursor` là **gap-free và không trùng lặp**: đọc tuần tự từ cursor bất kỳ trả về đúng tập event khớp filter, đúng thứ tự.
3. THE Change_Feed SHALL yêu cầu principal có capability `cdc:subscribe` (resolve qua PermissionService từ role/policy của user hoặc API key; `adminAccess` thoả mặc nhiên); thiếu capability → 403.
4. THE Change_Feed SHALL filter mọi truy vấn theo `siteId` của request (multi-tenancy non-negotiable) và thêm cả 3 bảng mới vào `rls-policies.sql` (site_isolation).
5. IF `cursor` không parse được thành UUID hợp lệ, THEN THE Change_Feed SHALL trả 400 `VALIDATION_ERROR`; IF `cursor` cũ hơn retention floor của site, THEN trả 410 `CURSOR_EXPIRED` kèm `earliestCursor` để consumer resync.

### Requirement 3: Subscription registry & checkpoint

**User Story:** Là một quản trị viên site, tôi muốn đăng ký và quản lý các consumer (pull client, webhook, extension) như những subscription có tên, filter và checkpoint, để theo dõi ai đang tiêu thụ feed và đang trễ bao nhiêu.

#### Acceptance Criteria

1. THE Change_Feed SHALL cung cấp bảng `lumibase_cdc_subscriptions` với các cột: `id` (nanoid, PK), `siteId` (FK, NOT NULL), `name` (text, NOT NULL — unique per site), `kind` (text, NOT NULL, `'pull' | 'webhook' | 'extension'`), `collections` (jsonb — filter, rỗng = tất cả), `operations` (jsonb — filter, rỗng = tất cả), `payloadMode` (text, NOT NULL, `'reference' | 'snapshot'`, default `'reference'`), `cursor` (uuid, nullable — checkpoint cuối đã ack/deliver thành công), `status` (text, NOT NULL, `'active' | 'paused' | 'dead' | 'stale'`, default `'active'`), `webhookId` (text, nullable, FK → `lumibase_webhooks`), `extensionName` (text, nullable), `consecutiveFailures` (integer, default 0), `lastDeliveredAt` (timestamptz, nullable), `createdAt`, `updatedAt`.
2. THE Change_Feed SHALL cung cấp REST CRUD tại `/api/v1/cdc/subscriptions` (quản trị — `requireSiteAdmin`), tối đa 50 Subscription per site; trùng `name` per site → 409.
3. THE Change_Feed SHALL cung cấp `POST /api/v1/cdc/subscriptions/:id/ack` nhận `{ cursor }` cho consumer `kind='pull'` commit checkpoint; cursor mới PHẢI ≥ cursor hiện tại (không lùi qua ack), lùi cursor chỉ được phép qua replay (Requirement 6).
4. WHEN một CDC_Subscriber_Extension được enable, THE Change_Feed SHALL tự động tạo (hoặc kích hoạt lại) Subscription `kind='extension'` tương ứng theo manifest; disable extension → Subscription chuyển `paused`.
5. THE Change_Feed SHALL tính và trả về **lag** của mỗi Subscription (số event và khoảng thời gian giữa `cursor` và head của feed) trong response list/detail.

### Requirement 4: Webhook push delivery (dispatcher + chữ ký + retry)

**User Story:** Là một lập trình viên tích hợp, tôi muốn LumiBase chủ động POST các thay đổi tới endpoint của tôi kèm chữ ký HMAC, retry khi lỗi, để tôi nhận thay đổi gần thời gian thực mà không cần poll.

#### Acceptance Criteria

1. THE Dispatcher SHALL đọc Change_Event sau `cursor` của từng Subscription `kind='webhook'` `status='active'` (theo batch, tối đa 100 event/batch) và POST Event_Envelope batch tới `webhooks.url`, kèm headers cấu hình trong `webhooks.headers`.
2. THE Dispatcher SHALL ký mỗi request bằng HMAC-SHA256 trên raw body với `webhooks.secret`, gửi header `X-Lumibase-Signature: t=<unix_ts>,v1=<hex>`; IF webhook không có `secret` THEN Subscription webhook không được tạo (400 — chữ ký là bắt buộc).
3. THE Dispatcher SHALL áp SSRF guard (`validateOutboundUrl`) và timeout 30 giây cho mọi outbound request, cùng chính sách với operation `http`/deployment providers.
4. WHEN delivery nhận HTTP 2xx, THE Dispatcher SHALL advance `cursor` của Subscription tới event cuối của batch và reset `consecutiveFailures=0`; delivery KHÔNG 2xx hoặc lỗi mạng → KHÔNG advance cursor (không mất event — at-least-once).
5. IF một batch delivery thất bại, THEN THE Dispatcher SHALL retry với exponential backoff bắt đầu 30 giây, tối đa 5 lần cho batch đó; IF `consecutiveFailures` của Subscription đạt 10, THEN chuyển Subscription sang `status='dead'` và phát notification qua notifications module.
6. THE Dispatcher SHALL ghi mỗi lần thử vào bảng `lumibase_cdc_deliveries` với các cột: `id` (uuidv7, PK), `siteId` (FK, NOT NULL), `subscriptionId` (FK, NOT NULL), `eventIdFrom` (uuid), `eventIdTo` (uuid), `eventCount` (integer), `attempt` (integer), `status` (text, `'success' | 'failed'`), `httpStatus` (integer, nullable), `errorMessage` (text, nullable — masked), `durationMs` (integer), `createdAt`. Index `(siteId, subscriptionId, createdAt)`.
7. THE Dispatcher SHALL chạy qua `QueueProvider` (BullMQ trên Docker; CF Queues/Cron Trigger trên Workers) được trigger best-effort sau mỗi mutation, VÀ một sweep định kỳ (mặc định 30 giây, pattern `scheduler-worker`) làm lưới an toàn; IF runtime không có queue adapter, THEN sweep định kỳ + `POST /api/v1/cdc/subscriptions/:id/dispatch` (on-demand, admin) vẫn bảo đảm delivery.

### Requirement 5: Extension subscriber (SDK + sandbox)

**User Story:** Là một extension author, tôi muốn khai báo "cho tôi nhận mọi thay đổi của collection X" trong manifest và viết handler async, để xây sink connector mà không đụng vào core.

#### Acceptance Criteria

1. THE Change_Feed SHALL mở rộng `@lumibase/extension-sdk` với `defineCdcSubscriber({ collections, operations?, payloadMode?, handler })`, trong đó `handler({ events, ctx })` nhận batch Event_Envelope và `HookContext` sandbox hiện có (sandboxed `fetch`, `logger`, `config`).
2. THE Change_Feed SHALL yêu cầu manifest khai báo capability `cdc:subscribe:<collection>` cho từng collection đăng ký (hoặc `cdc:subscribe:*`); sự kiện của collection không được cấp KHÔNG bao giờ tới handler (enforce ở Dispatcher, không tin extension).
3. WHEN Dispatcher phân phối cho Subscription `kind='extension'`, THE Change_Feed SHALL gọi handler qua ExtensionSandbox với timeout 5 giây mỗi batch (tái dùng cơ chế `withTimeout` của HookDispatcher); handler ném lỗi hoặc timeout → batch được coi là failed, retry theo Requirement 4.5.
4. THE Change_Feed SHALL cách ly lỗi giữa các subscriber: một extension lỗi/chậm KHÔNG chặn delivery của Subscription khác và KHÔNG ảnh hưởng mutation gốc (khác với hook sync `items.*.before`).
5. THE Change_Feed SHALL truyền `event.id` làm idempotency key và tài liệu hoá yêu cầu handler idempotent (at-least-once semantics).

### Requirement 6: Retention, replay & pruning

**User Story:** Là một quản trị viên, tôi muốn feed tự dọn event cũ theo chính sách và cho phép tua lại một subscription về một thời điểm trong cửa sổ retention, để backfill lại hệ thống đích sau sự cố.

#### Acceptance Criteria

1. THE Change_Feed SHALL giữ Change_Event trong cửa sổ retention cấu hình per site (setting `cdc_feed.retentionDays`, default 7, min 1, max 90); job prune idempotent xoá event cũ hơn cutoff, chạy theo scheduler pattern.
2. THE Change_Feed SHALL cung cấp `POST /api/v1/cdc/subscriptions/:id/replay` nhận `{ cursor }` hoặc `{ occurredAfter }` để lùi checkpoint trong phạm vi retention; replay ghi audit log với actor.
3. IF `cursor` của một Subscription cũ hơn retention floor (event đã bị prune trước khi deliver), THEN THE Change_Feed SHALL chuyển Subscription sang `status='stale'`, phát notification, và từ chối dispatch tới khi được replay/reset tường minh — KHÔNG âm thầm bỏ qua khoảng trống.
4. WHEN prune chạy, THE Change_Feed SHALL KHÔNG xoá event mà ít nhất một Subscription `active`/`paused` chưa deliver, TRỪ KHI event đã quá `retentionDays` (khi đó Subscription rơi vào 6.3).

### Requirement 7: Bảo mật, multi-tenancy & HITL

**User Story:** Là một quản trị viên bảo mật, tôi muốn feed tuân cùng chuẩn tenant-isolation, capability, masking và HITL như phần còn lại của LumiBase, để mở kênh dữ liệu ra ngoài mà không mở lỗ hổng.

#### Acceptance Criteria

1. THE Change_Feed SHALL scope mọi bảng mới (`lumibase_cdc_change_events`, `lumibase_cdc_subscriptions`, `lumibase_cdc_deliveries`) theo `siteId`, thêm vào `rls-policies.sql`, và mọi query đều `where(eq(table.siteId, siteId))`.
2. THE Change_Feed SHALL bảo đảm event của site A không bao giờ xuất hiện trong feed/delivery của site B (two-site smoke test bắt buộc theo DoD §2b).
3. THE Change_Feed SHALL định nghĩa capability mới: `cdc:subscribe` (đọc feed / nhận delivery) và `cdc:manage` (CRUD subscription, replay, dispatch on-demand); routes quản trị dùng `requireSiteAdmin` như `deployments`.
7. THE Change_Feed SHALL coi feed là realm control-plane/integration (ADR-011): chỉ chấp nhận principal realm `studio` hoặc API key — token Custom JWT audience `frontend` (role `subscriber`) PHẢI bị từ chối (nhất quán `withStudioAccess`), vì feed lộ thay đổi xuyên collection vượt quyền của một end-user frontend.
4. THE Change_Feed SHALL bổ sung AI skills: `listCdcSubscriptions`, `getCdcSubscriptionStatus` (capability `cdc:manage`), `createCdcSubscription`, `replayCdcSubscription` (capability `cdc:manage`), `deleteCdcSubscription`; THE Harness SHALL coi `deleteCdcSubscription` là skill nguy hiểm (tên bắt đầu `delete` → HITL qua `ai_approvals` theo rule #4 `CLAUDE.md`).
5. THE Change_Feed SHALL mask secret/token trong mọi log, audit, `errorMessage` của delivery; `webhooks.secret` không bao giờ trả về qua API (write-only, giống pattern `serializePipeline` của module cdc).
6. THE Change_Feed SHALL KHÔNG import CF bindings trong business logic — mọi queue/cache/schedule đi qua `c.get('runtime')` (rule #3).

### Requirement 8: Observability & Studio panel

**User Story:** Là một người vận hành, tôi muốn thấy trạng thái các subscription, lag và lịch sử delivery trong Studio, để phát hiện consumer chết/trễ trước khi hệ thống đích lệch dữ liệu.

#### Acceptance Criteria

1. THE Change_Feed SHALL cung cấp `GET /api/v1/cdc/subscriptions/:id/deliveries` (phân trang, mới nhất trước) và expose lag per subscription (Requirement 3.5).
2. WHEN một Subscription chuyển sang `dead` hoặc `stale`, THE Change_Feed SHALL phát notification qua notifications module (tái dùng dispatcher/webhook-channel hiện có) đúng một lần cho mỗi lần chuyển trạng thái.
3. THE Change_Feed SHALL cung cấp Studio panel tối giản tại Settings → Change Feed: danh sách Subscription (status, kind, lag, lastDeliveredAt), chi tiết deliveries gần nhất, nút pause/resume/replay có confirm dialog.
4. THE Change_Feed SHALL ghi audit log cho các hành động quản trị: tạo/xoá/pause/resume/replay subscription, với actor và diff cấu hình (secret masked).

### Requirement 9: Tài liệu & ví dụ connector

**User Story:** Là một lập trình viên mới tiếp cận, tôi muốn tài liệu và một connector mẫu chạy được, để viết sink connector đầu tiên trong một buổi.

#### Acceptance Criteria

1. THE Change_Feed SHALL cung cấp `docs/en/features/cdc-change-feed.md` gồm: kiến trúc, Event_Envelope reference (mọi field + schemaVersion policy), semantics (at-least-once, ordering, idempotency), hướng dẫn pull/webhook/extension, mục **Multi-tenancy** (bắt buộc theo DoD §2b), và hướng dẫn verify chữ ký HMAC kèm code mẫu.
2. THE Change_Feed SHALL cập nhật `docs/en/api/hono-api-spec.md` (endpoints mới) và `docs/en/data-model.md` (3 bảng mới) theo DoD §4.
3. THE Change_Feed SHALL cung cấp một CDC_Subscriber_Extension mẫu (sync một collection sang hệ thống ngoài qua sandboxed fetch — theo mẫu `lumibase-firebase-sync`) trong tutorial "Build your first sink connector", nêu rõ yêu cầu idempotency.
4. WHEN Event_Envelope thay đổi cấu trúc, THE Change_Feed SHALL tăng `schemaVersion` và giữ tương thích đọc cho version cũ trong ít nhất một minor release (documented policy).

## Non-functional / Constraints

- **Dual-runtime**: mọi thành phần chạy được trên cả Cloudflare Workers và Docker/Node. Workers không có long-lived connection → capture dùng transactional outbox (không WAL-tailing first-party); dispatch dùng CF Queues/Cron Trigger. WAL-based replication cho analytics đã có ở spec `clickhouse-cdc` — không trùng phạm vi.
- **Hiệu năng**: ghi outbox thêm ≤ 1 INSERT trong transaction mutation; site không có subscriber không trả chi phí (Req 1.5). Đọc feed dùng index `(siteId, id)`.
- **Semantics**: at-least-once, không exactly-once; ordering toàn cục per site theo UUIDv7; consumer chịu trách nhiệm idempotency theo `event.id`.
- **TypeScript strict**, `import type`, không `any`; Zod schemas dùng chung ở `packages/shared`.

## Out of scope (phiên bản đầu)

- Exactly-once delivery; partition/consumer-group song song per subscription (một subscription = một dòng tuần tự).
- Realtime WebSocket fan-out của change events (có thể xếp sau, ride trên `RealtimeProvider` của `realtime-audience-channels`).
- Inbound CDC (hệ thống ngoài → LumiBase) và two-way sync/conflict resolution.
- Long-polling (`waitSeconds`) trên pull API.
- Capture thay đổi schema/settings (chỉ content items ở v1; mở rộng `collections`/`fields` là follow-up).

## Setup Impact (bắt buộc theo Definition of Done)

Trả lời 6 câu hỏi của `admin-setup-wizard/setup-impact.md`:

| # | Câu hỏi | Trả lời | Diễn giải |
|---|---------|---------|-----------|
| 1 | Seed rows khi init? | **Không** | Feed off-by-default; subscription do admin/extension tạo theo nhu cầu. |
| 2 | Feature-flag/settings key mới? | **Có (tùy chọn)** | Settings per site `cdc_feed` (`enabled`, `retentionDays`) — vắng thì dùng default (off / 7 ngày); không bắt buộc lúc setup. |
| 3 | Default policy/grant trong DB? | **Không** | Capability resolve qua role/policy hiện có; admin (`adminAccess`) thoả mặc nhiên. |
| 4 | Bước Setup Wizard mới? | **Không** | Cấu hình sau setup ở Settings → Change Feed. |
| 5 | Capability flag mới trong `/setup/capabilities`? | **Có** | `cdc:subscribe`, `cdc:manage` — cần upgrade note CHANGELOG khi triển khai (giống `deployments:*`). |
| 6 | Backfill cho instance cũ? | **Không** | Migration incremental (`0007_cdc_change_feed`) chồng lên `0000_lumibase_init` (ADR-010), 3 bảng mới `lumibase_cdc_*` rỗng; không đổi bảng cũ. Chưa instance nào ship trước ADR-010 nên không có un-prefixed data để backfill. |

Khi triển khai: thêm row vào Registry trung tâm (đã thêm `pending` #32) và cập nhật trạng thái.
