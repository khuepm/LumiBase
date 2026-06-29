# Requirements Document — Realtime Audience Channels

## Introduction

Spec `realtime-subscriptions` đã chuẩn hoá realtime cho **Studio plane**: admin user (bảng `users`/`userSites`, định danh qua JWT principal) subscribe **theo collection + filter** và nhận live item mutation. Toàn bộ fan-out hiện khoá theo `collection` + `siteId`; `SiteRoom.publish()` chỉ lọc `session.subscriptions.has(collection)` và skip echo theo `actorUserId` (`apps/cms/src/realtime/site-room.ts`). Không có khái niệm "gửi cho **một** người nhận cụ thể", và `userId` luôn là admin.

Kịch bản còn thiếu (gap của spec này): hệ thống cần gửi realtime cho **end-user phía Frontend** — những người KHÔNG nằm trong bảng `users`, mà ở **bảng riêng do app sở hữu**, phân biệt bằng một định danh ngoài (ví dụ `citizenID`). Đây là vấn đề thực tế đã gặp trên Directus: vì user FE tách bảng khỏi `users`, lớp WebSocket không "địa chỉ hoá" (address) được người nhận FE, nên không thể fan-out đúng người.

Điểm thiết kế cốt lõi: **việc end-user nằm ở bảng riêng là hợp lệ và nên giữ nguyên.** Khoảng trống không phải ở chỗ tách bảng, mà ở chỗ lớp realtime chưa có một **địa chỉ logic (subject) độc lập với nguồn user**. Spec này bổ sung:

1. **Audience plane** tách khỏi Studio plane: hai mặt phẳng realtime cô lập nhau, không rò chéo.
2. **Subject-based & channel-based addressing**: publish nhắm đúng `subjectId` (vd `citizenID`) hoặc một `channel` (topic) tuỳ ý, thay vì chỉ broadcast theo collection.
3. **Authz cho audience**: end-user chỉ join được channel/subject mà ticket của họ cho phép — không nghe trộm được người khác.
4. **Per-recipient notifications**: nối dây `notifications.recipient` + `notifications.pushed` (cột đã tồn tại, comment schema ghi rõ "Realtime fan-out lives in Durable Objects") cho cả admin lẫn end-user.
5. **Dual deployment**: hoạt động trên cả Cloudflare (Durable Object) và Docker (Node) qua một interface runtime mới `realtime` — tuân ADR-002 (non-negotiable rule #3: business logic không import CF binding trực tiếp).

Hiện trạng tận dụng được (xác minh trong codebase):
- `SiteRoom` DO (`apps/cms/src/realtime/site-room.ts`): session registry, heartbeat 30s, idle 90s, rate-limit 20 msg/s, presence, `publish()` fan-out.
- Ticket flow (`apps/cms/src/routes/realtime.ts`): `POST /realtime/ticket` (JWT 1m, payload `{userId, roles, siteId}`), `GET /realtime?ticket=...` verify + forward DO; Docker hiện trả `501 REALTIME_NOT_AVAILABLE`.
- `ItemService.publishRealtimeEvent` (`apps/cms/src/services/item-service.ts`) — nguồn phát event.
- Bảng `notifications` (`packages/database/src/schema/core.ts`): `recipient`, `sender`, `pushed`, `siteId` — sẵn sàng cho per-recipient.
- Spec `realtime-subscriptions` + doc `docs/en/architecture/realtime-websocket-implementation.md` — Studio plane đã có roadmap; spec này KHÔNG đụng vào, chỉ bổ sung audience plane.

## Glossary

- **Plane**: Mặt phẳng realtime. `studio` = admin (bảng `users`); `public` = end-user FE (bảng riêng của app). Hai plane cô lập — event plane này không bao giờ tới session plane kia.
- **Subject**: Định danh logic của end-user trong realtime, độc lập với bảng nguồn. App map `citizenID` (hoặc external user id) → `subjectId`. Lấy từ ticket đã verify, KHÔNG từ client.
- **Channel**: Topic tuỳ ý để nhóm session (vd `order:123`, `room:abc`, `site-broadcast`). Một session join nhiều channel; publish có thể nhắm `channel`.
- **Audience_Ticket**: JWT ngắn hạn cấp cho end-user FE, payload chứa `plane:'public'`, `subjectId`, và danh sách `channels` được phép join (allowlist do app/route quyết định, không do client khai).
- **Target**: Bộ chọn người nhận của một event: `{ userId? | subjectId? | channel? }`. Rỗng = broadcast theo collection (hành vi Studio plane hiện tại).
- **Realtime_Event** (mở rộng): `{ type:'event'|'notification', plane, target?, collection?, action?, itemId?, payload, actorUserId? }`.

## Requirements

### Requirement 1: Tách Studio plane và Audience plane

**User Story:** Là kiến trúc sư hệ thống, tôi muốn admin realtime và end-user realtime cô lập nhau, để event nội bộ Studio không bao giờ rò xuống user FE và ngược lại.

#### Acceptance Criteria

1. THE mỗi session SHALL mang một `plane` (`studio` | `public`) xác định từ ticket đã verify, KHÔNG từ query/client message.
2. WHEN publish một Realtime_Event với `plane = P`, THE hub SHALL chỉ gửi tới session có `plane === P`.
3. THE Studio plane SHALL giữ nguyên hành vi hiện tại (subscribe theo collection, admin `userId`/`roles`) — tương thích ngược, không thay đổi protocol đang dùng.
4. THE Audience plane SHALL KHÔNG cho phép subscribe trực tiếp theo `collection` trừ khi app bật rõ ràng — mặc định end-user chỉ nhận qua `subject`/`channel` được cấp.

### Requirement 2: Subject-based addressing cho end-user FE

**User Story:** Là frontend app, tôi muốn gửi realtime cho đúng một end-user (phân biệt bằng `citizenID`) dù họ không nằm trong bảng `users`, để thông báo cá nhân tới đúng người.

#### Acceptance Criteria

1. THE Audience_Ticket SHALL chứa `subjectId` (app map từ `citizenID`/external id) đã verify; session lưu `principal.subjectId`.
2. WHEN publish một event với `target.subjectId = S`, THE hub SHALL chỉ gửi tới session `public` có `principal.subjectId === S`.
3. THE một `subjectId` SHALL có thể có nhiều session đồng thời (nhiều tab/thiết bị) — event gửi tới tất cả.
4. THE `subjectId` SHALL KHÔNG bao giờ nhận từ client message hay query param khi đã có ticket — chống mạo danh người nhận.
5. IF không có session nào khớp `subjectId`, THEN event SHALL được bỏ qua ở tầng realtime; nếu là notification bền, bản ghi `notifications` vẫn được lưu để đẩy khi user online lại (xem Req 5).

### Requirement 3: Channel-based addressing (topic)

**User Story:** Là frontend app, tôi muốn nhóm nhiều end-user vào một topic (vd phòng chat, theo dõi đơn hàng) để broadcast tới cả nhóm mà không liệt kê từng subject.

#### Acceptance Criteria

1. THE Audience_Ticket SHALL chứa allowlist `channels` mà subject này được phép join; session chỉ join được channel trong allowlist.
2. WHEN client gửi `{ type:'join', channel }`, THE hub SHALL kiểm tra channel ∈ allowlist của session; thuộc → thêm vào `session.channels` + trả `joined`; không thuộc → trả `error code:'CHANNEL_FORBIDDEN'`, KHÔNG join.
3. WHEN publish event với `target.channel = C`, THE hub SHALL gửi tới mọi session (đúng plane) có `C ∈ session.channels`.
4. THE client SHALL `{ type:'leave', channel }` để rời channel; sau đó không nhận event của channel đó.
5. THE channel authz SHALL nằm ở lúc cấp ticket / lúc join — KHÔNG tin client tự khai quyền (đây chính là lỗ hổng cần tránh khi tách bảng user).

### Requirement 4: Targeted publish API

**User Story:** Là backend dev, tôi muốn một API publish nhắm đối tượng (user/subject/channel) thống nhất cho cả hai plane, để gửi realtime mà không cần biết backend là DO hay Node hub.

#### Acceptance Criteria

1. THE runtime SHALL expose `runtime.realtime.publish(siteId, event)` với `event.target` chọn người nhận; `target` rỗng + có `collection` → broadcast theo collection (Studio plane, như hiện tại).
2. THE matching trong hub SHALL theo thứ tự: (a) plane khớp; (b) nếu có `target` → khớp `userId` HOẶC `subjectId` HOẶC `channel`; (c) nếu không có `target` → khớp subscription `collection`.
3. THE skip-echo SHALL chỉ áp khi `actorUserId` set và khớp `principal.userId` (admin) — không áp cho end-user (FE thường muốn nhận lại event do chính action mình gây ra).
4. THE publish SHALL async và non-critical: lỗi fan-out KHÔNG làm fail mutate/notification gốc (giữ nguyên nguyên tắc của `publishRealtimeEvent` hiện tại).

### Requirement 5: Per-recipient notifications (nối dây `notifications`)

**User Story:** Là người dùng (admin hoặc end-user), tôi muốn nhận thông báo cá nhân realtime và không mất nó nếu đang offline, để luôn thấy thông báo dành cho mình.

#### Acceptance Criteria

1. WHEN một bản ghi `notifications` được tạo, THE system SHALL publish event `{ type:'notification', plane, target }` — `plane:'studio' target.userId=recipient` cho admin, hoặc `plane:'public' target.subjectId` cho end-user.
2. WHEN event notification được gửi thành công tới ít nhất một session của người nhận, THE system SHALL set `notifications.pushed = true`.
3. WHEN người nhận (re)connect, THE system SHALL có cơ chế đẩy các notification `pushed = false` của họ (replay khi online) — qua subscribe inbox hoặc fetch + mark.
4. THE notification fan-out SHALL scoped `siteId` — không rò notification site này sang site khác.

### Requirement 6: Dual deployment (Cloudflare + Docker)

**User Story:** Là operator self-host, tôi muốn realtime audience hoạt động trên cả bản Docker, để không phụ thuộc Cloudflare Durable Object.

#### Acceptance Criteria

1. THE business logic SHALL gọi realtime qua interface `runtime.realtime` (mới trong `packages/runtime/src/interfaces/realtime.ts`) — KHÔNG import `DurableObjectNamespace` trực tiếp (ADR-002, non-negotiable rule #3).
2. THE Cloudflare adapter SHALL map `runtime.realtime` → `SiteRoom` DO stub (giữ logic DO hiện có, mở rộng cho plane/target).
3. THE Docker adapter SHALL cung cấp hub realtime Node: single-node dùng in-process pub/sub + `@hono/node-ws` cho WS server; multi-node dùng transport ngoài (Postgres `LISTEN/NOTIFY` hoặc Redis pub/sub) — v1 hỗ trợ single-node, multi-node ghi là tương lai.
4. THE Docker path SHALL KHÔNG còn trả `501 REALTIME_NOT_AVAILABLE` khi adapter đã cấu hình; vẫn trả lỗi rõ ràng khi realtime bị tắt (kill switch / site setting).
5. THE protocol message (Zod, `@lumibase/shared`) SHALL dùng chung cho cả hai adapter và client — lệch schema là lỗi build.

### Requirement 7: Scale & cô lập cho audience đông

**User Story:** Là operator, tôi muốn audience plane chịu được số lượng end-user lớn mà không làm nghẽn hub của admin, để hệ thống ổn định khi traffic FE tăng.

#### Acceptance Criteria

1. THE Studio plane SHALL giữ một room per `siteId` (admin ít) — không đổi.
2. WHEN audience plane vượt ngưỡng cấu hình, THE hệ thống SHALL hỗ trợ shard audience theo bucket (vd `idFromName(siteId + ':aud:' + hash(subjectId) % N)` trên CF) — publish và connect dùng CHUNG shard resolver để không lệch room (cùng vấn đề shard mismatch đã ghi trong doc roadmap).
3. THE per-session rate-limit, heartbeat, idle-timeout SHALL áp cho audience plane như Studio plane.
4. THE audience ticket SHALL có thể giới hạn `maxConnectionsPerSubject` (chống một subject mở quá nhiều kết nối).
5. THE channel fan-out trong một bucket lớn SHALL có ngưỡng/backpressure rõ ràng khi implement — drop + cảnh báo nếu session chậm, không để một session chậm chặn cả broadcast.

### Requirement 8: Phối hợp & chất lượng

#### Acceptance Criteria

1. THE protocol schema (Zod) cho audience SHALL ở `@lumibase/shared` dùng chung FE/BE; mở rộng (không phá) protocol `lumibase-sync-v1` hiện tại — version bump nếu breaking.
2. THE authz join channel / resolve subject SHALL nhất quán: quyết định ở route cấp ticket (có DB/runtime context), KHÔNG trong DO (DO giữ vai trò connection + fan-out hub, tránh query DB — nhất quán nguyên tắc trong doc roadmap).
3. THE mọi event SHALL scoped `siteId`; Studio và Audience plane cô lập; subject/channel không rò chéo.
4. `pnpm typecheck` (recursive) + `pnpm test` pass; runtime abstraction tuân ADR-002; broadcast async không chậm mutate/notification.
5. **Setup impact:** rà `.kiro/specs/admin-setup-wizard/setup-impact.md` và ghi kết quả vào Registry (kể cả `n/a`) — theo Definition of Done.
