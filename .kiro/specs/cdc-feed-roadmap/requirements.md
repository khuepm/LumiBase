# Change Feed Roadmap — Requirements

> Spec kế thừa `cdc-extension-integration` (Change Feed đã ship A–H + capture
> collections/fields + long-polling). Tài liệu này gom các mở rộng lớn còn lại
> thành yêu cầu để triển khai theo vòng, mỗi mục tách được thành PR/spec con
> khi bắt tay làm. Nhà EARS house style, tiếng Việt.

## Bối cảnh

Change Feed hiện tại: outbox `lumibase_cdc_change_events` (keyset `(occurred_at, id)`),
pull API `GET /cdc/events` (cursor + `wait` long-poll), webhook HMAC + extension
subscriber, retention/replay, capture `items.*`/`collections.*`/`fields.*`. Các mục
dưới đây là *ngoài* phạm vi v1 và cần quyết định kiến trúc trước khi code.

## R1 — Realtime fan-out change events (audience plane)

- R1.1 KHI một change event được ghi vào outbox, hệ thống SHALL có thể fan-out
  event đó tới client đang kết nối realtime qua `RealtimeProvider` (kênh
  `cdc:<siteId>:<collection>`), để consumer nhận trong < 1s thay vì chờ poll.
- R1.2 Fan-out realtime SHALL đi qua audience/RBAC: chỉ client có capability
  `cdc:subscribe` (hoặc `cdc:subscribe:<collection>`) mới nhận; frontend-realm
  token bị từ chối như pull API (ADR-011).
- R1.3 Realtime SHALL là *best-effort tối ưu độ trễ*, KHÔNG thay thế
  at-least-once của pull/webhook — mất một message realtime không được làm mất
  delivery (cursor + sweep vẫn là nguồn sự thật).
- R1.4 Fan-out SHALL hoạt động trên cả hai runtime: Durable Object `SITE_ROOM`
  (Cloudflare) và WS adapter (Docker), không rò CF binding vào business logic.
- R1.5 KHI tải cao, fan-out SHALL áp backpressure (drop message realtime, không
  drop outbox) và không được làm chậm mutation path.

## R2 — Capture settings changes (`settings.*`)

- R2.1 KHI một settings row (`settings` table) được tạo/sửa/xoá, hệ thống SHALL
  ghi một change event `settings.<operation>` (`itemId` = settings key).
- R2.2 Capture settings SHALL phủ *mọi* đường ghi settings (REST route, ConfigService,
  setup wizard) qua một seam thống nhất — KHÔNG được bắt thiếu event ở bất kỳ
  đường nào (nếu không, consumer tin nhầm feed là đầy đủ).
- R2.3 Payload settings event SHALL loại trừ giá trị nhạy cảm theo danh mục key
  nhạy cảm (ví dụ khoá API, secret) — mask trước khi ghi, tương tự pii/phi item.

## R3 — Consumer-group / parallel delivery per subscription

- R3.1 Một subscription SHALL cấu hình được `concurrency > 1` để nhiều worker
  xử lý delivery song song, tăng throughput cho subscription tải lớn.
- R3.2 KHI `concurrency > 1`, hệ thống SHALL bảo toàn thứ tự *per partition key*
  (mặc định `itemId`) — event cùng một item không bao giờ giao nhau giữa các
  worker; thứ tự toàn cục có thể nới lỏng.
- R3.3 Checkpoint SHALL vẫn gap-free: cursor chỉ tiến khi mọi partition ≤ cursor
  đã deliver thành công (high-water mark an toàn).

## R4 — Inbound CDC / two-way sync

- R4.1 Hệ thống SHALL nhận change từ hệ thống ngoài (webhook inbound hoặc pull
  adapter) và áp vào content LumiBase qua ItemService (validate + RBAC + audit).
- R4.2 Inbound SHALL idempotent theo khoá nguồn (external id + version) — nhận lại
  cùng change không tạo bản ghi trùng.
- R4.3 Two-way sync SHALL chống loop: change do inbound tạo ra KHÔNG được re-emit
  ra outbox theo cách khiến hệ thống nguồn nhận lại (đánh dấu provenance
  `source: 'sync'` + bỏ qua ở connector nguồn).
- R4.4 KHI xung đột (cùng item sửa hai phía), hệ thống SHALL áp một chiến lược
  conflict-resolution cấu hình được (last-write-wins mặc định; hoặc HITL).

## R5 — Partition bảng outbox theo thời gian

- R5.1 KHI volume outbox vượt ngưỡng vận hành, `lumibase_cdc_change_events`
  SHALL partition được theo `occurred_at` (theo tháng) để prune = drop partition
  và query keyset chỉ chạm partition liên quan.
- R5.2 Partitioning SHALL trong suốt với reader/dispatcher hiện tại (keyset query
  không đổi API); migration SHALL có đường chuyển dữ liệu cũ an toàn.
- R5.3 Quyết định bật partition SHALL dựa trên số đo thực (kích thước bảng, thời
  gian prune) — không tối ưu sớm.

## Phi mục tiêu (v-này)

- Không đổi wire format envelope v1 (mọi mục trên đều additive hoặc plane khác).
- Không thay outbox+relay bằng WAL-tailing (ràng buộc dual-runtime giữ nguyên).
