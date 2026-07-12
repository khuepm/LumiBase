# Change Feed Roadmap — Design

> Bản phác kiến trúc cho các mở rộng ở `requirements.md`. Mỗi mục kèm quyết
> định then chốt + rủi ro, đủ để mở PR/spec con mà không thiết kế lại từ đầu.

## D1 — Realtime fan-out (R1)

**Cơ chế**: tái dụng seam enqueue đã có. Ở `writeCdcEvent`/`OutboxWriter`, sau khi
insert thành công, ngoài `enqueue(CDC_DISPATCH_QUEUE)` thì publish thêm một
message lên `RealtimeProvider.publish('cdc:<siteId>:<collection>', envelope)`.

- **Audience/RBAC (R1.2)**: cổng subscribe realtime nằm ở WS handshake — tái dụng
  `authorizeFeedRead` (capability `cdc:subscribe`, reject frontend aud). Client
  chỉ join được room `cdc:<siteId>:<collection>` mình được phép.
- **Không thay at-least-once (R1.3)**: realtime chỉ đẩy envelope *reference*
  (không data); client vẫn phải ack qua pull subscription để có checkpoint. Mất
  message → client bắt kịp ở lần poll/backstop kế.
- **Dual-runtime (R1.4)**: `RealtimeProvider` đã có adapter DO (`SITE_ROOM`) và
  WS Docker; business logic chỉ gọi `c.get('runtime').realtime.publish(...)`.
- **Backpressure (R1.5)**: publish bọc trong try/catch best-effort (như enqueue),
  có thể drop khi provider báo quá tải; không bao giờ chặn mutation.

**Rủi ro**: fan-out theo collection có thể ồn với site nhiều write; cân nhắc
throttle/coalesce theo cửa sổ. Không đưa vào v1 realtime.

## D2 — Settings capture (R2)

**Vấn đề cốt lõi**: settings có nhiều đường ghi (REST `/settings`, `ConfigService`,
setup wizard) → không thể hook rời rạc như collections/fields (một đường
`SchemaService`).

**Quyết định**: gom mọi write settings về **một** điểm — hoặc (a) route đi qua
`ConfigService.upsertSetting/deleteSetting` (refactor các call site trực tiếp), rồi
hook outbox trong ConfigService; hoặc (b) một DB trigger/`AFTER`-hook ở tầng thấp.
Ưu tiên (a) để giữ mask + provenance trong app layer.

- `resource: 'setting'`, `collection = '$settings'` (sentinel), `itemId = key`.
- **Mask (R2.3)**: danh mục key nhạy cảm (regex `*_secret`, `*_key`, `smtp_*`…)
  → mask giá trị trước khi ghi, tái dụng `maskChangeEventPayload` với set field
  suy từ key. Chi tiết danh mục chốt khi làm.

**Phụ thuộc**: cần audit các call site ghi `settings` (grep `insert(settings)` /
`update(settings)`), đảm bảo tất cả qua ConfigService trước khi bật capture (nếu
không sẽ vi phạm R2.2).

## D3 — Consumer-group / parallel delivery (R3)

**Hiện trạng**: dispatcher chạy *một lane tuần tự per subscription* (an toàn thứ
tự tuyệt đối). Để song song mà vẫn gap-free:

- Thêm `concurrency` + `partitionKey` (mặc định `itemId`) vào subscription.
- Dispatcher chia batch theo `hash(partitionKey) % concurrency` → N lane; mỗi lane
  giữ thứ tự nội bộ.
- **Checkpoint gap-free (R3.3)**: cursor tiến tới *high-water mark* = keyset nhỏ
  nhất mà mọi lane đã vượt qua (min của max-đã-ack mỗi lane) — không tiến quá một
  event chưa deliver ở lane chậm.

**Rủi ro**: phức tạp hoá recovery khi một lane chết; cần lock per (subscription,
lane). Cân nhắc chỉ mở cho `kind: 'pull'` trước (consumer tự quản song song),
webhook/extension giữ tuần tự.

## D4 — Inbound CDC / two-way sync (R4)

**Kiến trúc**: connector inbound (extension `type: 'hook'` hoặc route
`POST /cdc/inbound/:connector`) nhận payload ngoài → chuẩn hoá → gọi ItemService.

- **Idempotency (R4.2)**: bảng map `external_id → itemId` + `external_version`;
  bỏ qua nếu version ≤ đã áp.
- **Loop-prevention (R4.3)**: mutation do inbound tạo mang `source: 'sync'` +
  `syncConnectorId`; outbox vẫn ghi (để consumer *khác* thấy) nhưng connector
  nguồn lọc bỏ event có `syncConnectorId` của chính nó (echo suppression).
- **Conflict (R4.4)**: so `updatedAt`/version hai phía; LWW mặc định; tuỳ chọn
  đẩy vào `ai_approvals` (HITL) khi cấu hình.

**Đây là feature lớn nhất** — nên tách spec riêng `.kiro/specs/cdc-inbound-sync/`
khi khởi động; mục này chỉ ghim quyết định nền.

## D5 — Partition outbox theo tháng (R5)

- Chuyển `lumibase_cdc_change_events` sang `PARTITION BY RANGE (occurred_at)`, tạo
  partition theo tháng (job tạo trước 1 tháng). Prune = `DROP PARTITION` (rẻ hơn
  `DELETE` + vacuum hiện tại).
- Keyset query `(occurred_at, id)` sẵn hợp partition-pruning theo `occurred_at`.
- **Migration (R5.2)**: tạo bảng partitioned mới + copy dữ liệu + swap, hoặc dùng
  `pg_partman`. Chỉ làm khi số đo (R5.3) cho thấy cần.

## Ma trận rủi ro tổng

| Mục | Độ lớn | Rủi ro chính | Điều kiện khởi động |
|---|---|---|---|
| D1 realtime | Trung bình | audience RBAC, ồn fan-out | có nhu cầu latency < 1s |
| D2 settings | Nhỏ–TB | bắt thiếu đường ghi (R2.2) | audit call site settings xong |
| D3 consumer-group | TB | recovery per-lane, gap-free | subscription tải lớn |
| D4 inbound | Lớn | loop, conflict | tách spec riêng |
| D5 partition | Nhỏ (DDL) | migration swap | số đo volume vượt ngưỡng |
