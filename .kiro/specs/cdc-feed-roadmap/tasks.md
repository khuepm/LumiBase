# Change Feed Roadmap — Tasks

> Trạng thái: **chưa khởi động** (backlog). Mỗi nhóm là một PR/spec con độc lập;
> thứ tự đề xuất theo giá trị/độ rủi ro. Tick khi bắt tay từng nhóm.

## Nhóm A — Settings capture (D2) · nhỏ, giá trị cao, ít rủi ro nhất

- [ ] A1. Audit mọi call site ghi `settings` (`insert(settings)`/`update(settings)`/
  `delete(settings)`); xác nhận (hoặc refactor) tất cả đi qua `ConfigService`.
- [ ] A2. Danh mục key nhạy cảm (regex) → helper mask giá trị settings.
- [ ] A3. Hook `resource: 'setting'` trong ConfigService (best-effort, never-throw,
  enqueue dispatch) — tái dụng `OutboxWriter`.
- [ ] A4. Test: capture đủ mọi đường ghi; mask key nhạy cảm; envelope `settings.*`.
- [ ] A5. Docs: mở phần `settings.*` trong `cdc-change-feed.md` §2.

## Nhóm B — Realtime fan-out (D1) · trung bình

- [ ] B1. Publish envelope reference lên `RealtimeProvider` sau outbox insert
  (best-effort, backpressure-safe).
- [ ] B2. Cổng subscribe WS: tái dụng `authorizeFeedRead` (capability + reject aud).
- [ ] B3. Adapter DO `SITE_ROOM` + WS Docker: room `cdc:<siteId>:<collection>`.
- [ ] B4. Test dual-runtime (fake RealtimeProvider) + property: mất realtime không
  mất delivery (cursor vẫn gap-free).
- [ ] B5. Docs + Studio: badge "realtime" trên subscription pull.

## Nhóm C — Consumer-group / parallel delivery (D3) · trung bình

- [ ] C1. Thêm `concurrency` + `partitionKey` vào subscription schema + Zod + SDK.
- [ ] C2. Dispatcher: chia lane theo `hash(partitionKey)`, giữ thứ tự per partition.
- [ ] C3. High-water-mark checkpoint (gap-free) + lock per (sub, lane).
- [ ] C4. Property test: ordering per partition + gap-free dưới lane chậm/chết.
- [ ] C5. Giới hạn v1: chỉ `kind: 'pull'` (webhook/extension giữ tuần tự).

## Nhóm D — Inbound CDC / two-way sync (D4) · lớn → tách spec riêng

- [ ] D0. Tách `.kiro/specs/cdc-inbound-sync/` (requirements/design/tasks đầy đủ).
- [ ] D1. Route/connector inbound + chuẩn hoá payload → ItemService.
- [ ] D2. Bảng map `external_id → itemId` + version (idempotency).
- [ ] D3. Echo suppression (`source: 'sync'` + `syncConnectorId`).
- [ ] D4. Conflict-resolution (LWW mặc định; option HITL).
- [ ] D5. Test loop-prevention + conflict + idempotency.

## Nhóm E — Partition outbox (D5) · nhỏ (DDL), chỉ khi cần

- [ ] E1. Đo: kích thước bảng, thời gian prune hiện tại (ngưỡng khởi động).
- [ ] E2. Migration `PARTITION BY RANGE (occurred_at)` + job tạo partition tháng.
- [ ] E3. Đổi prune sang `DROP PARTITION`; xác nhận keyset pruning.
- [ ] E4. Test migration swap an toàn + reader không đổi hành vi.

## Đã ship (thuộc spec gốc `cdc-extension-integration`)

- [x] Capture `collections.*` / `fields.*` (SchemaService hooks; migration `0008`
  thêm cột `resource`; `cdcEventType`/`CDC_RESOURCE_TYPE_PREFIX`; mask item-only).
- [x] Long-polling `wait` (≤25s) trên `GET /cdc/events`.
- [x] openapi.yaml + `@lumibase/sdk` typed resources cho toàn bộ surface.
