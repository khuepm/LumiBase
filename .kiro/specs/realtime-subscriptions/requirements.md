# Requirements Document — Realtime Subscriptions

## Introduction

Directus realtime cho phép subscribe theo collection với filter (`{ event, collection, query }`) qua WebSocket/GraphQL subscriptions, nhận live create/update/delete. LumiBase đã có hạ tầng WS: `POST /realtime/ticket` (JWT 1m), `GET /realtime` (WS upgrade), Durable Object `SITE_ROOM`, multi-region sharding, protocol `lumibase-sync-v1`. NHƯNG subscription filter logic nằm trong DO (chưa chuẩn hoá/chưa rõ) và chưa có client SDK chuẩn.

Spec này gap-focused: chuẩn hoá **subscription protocol** (subscribe/unsubscribe theo collection + filter), **broadcast item mutation** vào room theo subscription khớp, và **client SDK** để Studio/app subscribe dễ dàng. Mục tiêu FE↔BE: một protocol message rõ ràng, FE và DO cùng hiểu.

Hiện trạng tận dụng được (xác minh trong codebase):
- `realtime.ts` (`apps/cms/src/routes/realtime.ts`): `POST /api/v1/realtime/ticket` (JWT 1m), `GET /api/v1/realtime` (WS upgrade, ticket validate, DO `SITE_ROOM` routing, locationHint multi-region), protocol `lumibase-sync-v1`.
- Durable Object `SiteRoom` (binding `SITE_ROOM`) xử lý WS — subscription logic hiện ở đây.
- `conditions.ts`: `ConditionRule` + `evaluateRule` → tái dùng làm filter subscription server-side.
- `ItemService` create/update/delete — nguồn phát event (như flow event trigger).
- Metrics `realtimeConnectionsTotal` (`metrics.ts`).
- Runtime abstraction (ADR-002).

## Glossary

- **Ticket**: JWT ngắn hạn (1m) lấy từ `/realtime/ticket`, dùng để mở WS (chống lộ token dài hạn qua query).
- **Subscription**: Đăng ký của một client nhận event của một collection (kèm filter optional), có `subId` để unsubscribe.
- **Sub_Filter**: `ConditionRule` áp server-side trên payload item — chỉ event khớp mới gửi.
- **Site_Room**: Durable Object một-per-site giữ kết nối WS + danh sách subscription, broadcast event.
- **Realtime_Event**: Message server→client: `{ type:'event', collection, action, key, payload, subId }`.

## Requirements

### Requirement 1: Subscription protocol chuẩn hoá

**User Story:** Là client dev, tôi muốn một protocol message rõ ràng để subscribe/unsubscribe collection và nhận event, để tích hợp realtime nhất quán.

#### Acceptance Criteria

1. THE protocol `lumibase-sync-v1` SHALL định nghĩa message client→server: `subscribe` (`{ type:'subscribe', collection, filter?, subId }`), `unsubscribe` (`{ type:'unsubscribe', subId }`), `ping`.
2. THE protocol SHALL định nghĩa server→client: `ack` (`{ type:'ack', subId }`), `event` (Realtime_Event), `error` (`{ type:'error', subId?, message }`), `pong`.
3. THE message schema SHALL dùng chung FE/BE (`@lumibase/shared`, Zod) — DO và client validate cùng schema.
4. WHEN client gửi message sai schema, THE Site_Room SHALL trả `error` và KHÔNG ngắt kết nối (trừ khi vi phạm nghiêm trọng).

### Requirement 2: Subscribe theo collection + filter

**User Story:** Là frontend, tôi muốn chỉ nhận event của collection tôi quan tâm (và thoả filter), để không xử lý event thừa.

#### Acceptance Criteria

1. WHEN client `subscribe` một collection, THE Site_Room SHALL lưu subscription (subId, collection, filter, userId) cho kết nối đó và trả `ack`.
2. THE subscription SHALL chịu permission: chỉ subscribe được collection mà user (từ ticket) có quyền đọc; thiếu quyền → `error`, không lưu subscription.
3. WHEN có Sub_Filter, THE Site_Room SHALL chỉ gửi event mà `evaluateRule(filter, payload)` = true (tái dùng `conditions.ts`).
4. THE client SHALL unsubscribe bằng `subId`; sau unsubscribe không nhận event của sub đó.
5. THE một kết nối SHALL có nhiều subscription đồng thời (nhiều collection).

### Requirement 3: Broadcast item mutation

**User Story:** Là người dùng, tôi muốn thấy thay đổi của người khác xuất hiện ngay, để cộng tác realtime.

#### Acceptance Criteria

1. WHEN một item create/update/delete qua `ItemService`, THE system SHALL phát event tới Site_Room của site đó với `{ collection, action, key, payload }`.
2. THE Site_Room SHALL gửi Realtime_Event tới mọi kết nối có subscription khớp collection + filter + còn quyền đọc.
3. THE broadcast SHALL filter theo `siteId` — event site A không bao giờ tới client site B (DO đã một-per-site, đảm bảo điều này).
4. THE phát event SHALL async, không block response mutate item (giống flow event dispatch).
5. IF payload chứa field nhạy cảm vượt quyền field-level của một subscriber, THEN THE event tới subscriber đó SHALL được lọc field theo quyền (hoặc bỏ qua nếu không thể) — không rò field cấm.

### Requirement 4: Client SDK realtime

**User Story:** Là Studio/app dev, tôi muốn một client SDK xử lý ticket→WS→subscribe→reconnect, để không tự viết WS thô.

#### Acceptance Criteria

1. THE SDK SHALL có `realtime.connect()` tự lấy ticket (`/realtime/ticket`) rồi mở WS đúng region.
2. THE SDK SHALL có `subscribe(collection, { filter?, onEvent })` trả handle có `unsubscribe()`; quản lý subId nội bộ.
3. THE SDK SHALL tự reconnect khi rớt (exponential backoff) và re-subscribe các subscription đang mở; ticket hết hạn → lấy ticket mới.
4. THE SDK SHALL expose trạng thái kết nối (`connecting|open|closed`) cho UI hiển thị.

### Requirement 5: Studio live updates

**User Story:** Là biên tập viên, tôi muốn danh sách item và editor tự cập nhật khi có thay đổi, để không phải refresh.

#### Acceptance Criteria

1. THE item list SHALL subscribe collection đang xem; khi nhận event create/update/delete, cập nhật cache React Query tương ứng (invalidate hoặc patch).
2. THE item editor SHALL (tuỳ chọn) hiển thị banner "item đã được người khác cập nhật" khi nhận update event cho item đang mở.
3. THE connection status SHALL hiển thị kín đáo (vd dot trong AppShell) để biết realtime có hoạt động.

### Requirement 6: Phối hợp FE↔BE & chất lượng

#### Acceptance Criteria

1. THE protocol schema (Zod) SHALL là nguồn truth chung FE (SDK) và BE (DO) — lệch schema là lỗi build.
2. THE filter SHALL dùng cùng `ConditionRule`/`evaluateRule` ở subscription (server) như nơi khác — không định nghĩa lại.
3. THE permission check khi subscribe + khi broadcast SHALL nhất quán với PermissionService (không có đường vòng realtime).
4. `pnpm typecheck` + `pnpm test` pass; runtime abstraction; mọi event scoped siteId; broadcast async không chậm mutate.
