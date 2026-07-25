# Requirements Document

## Introduction

Tài liệu yêu cầu cho **Idempotency Keys** trong LumiBase — cơ chế `Idempotency-Key` header cho các mutation endpoint có side-effect, đảm bảo server chỉ thực thi business logic **một lần duy nhất** cho mỗi key, các retry sau đó nhận lại đúng response đã lưu.

Bối cảnh: bài phân tích "Preventing Duplicate Payment Charges" (Stripe-style idempotency) + bài "Implementing Stripe-like Idempotency Keys in Postgres" (Brandur). LumiBase không có endpoint thanh toán, nhưng cùng một lớp bài toán tồn tại ở các mutation không tự-idempotent:

- `POST /api/v1/items/:collection` và `/bulk` (`apps/cms/src/routes/items.ts:106,120`) — item dùng `nanoid()`, không có natural unique key → client retry khi timeout tạo **duplicate content**.
- `POST /api/v1/deployments/targets/:id/deploy` (`apps/cms/src/routes/deployments.ts:101`) — trigger build trên provider ngoài (Vercel/Netlify); side-effect ngoài hệ thống, không đảo ngược được — tương tự "charge thẻ" trong bài.
- Flow/agent execution (`routes/flows.ts`, `routes/agent.ts`, `routes/ai.ts`) — có thể gửi email, gọi webhook, ghi git; re-execute do retry nhân đôi side-effect.
- `POST /api/v1/uploads`, media — duplicate file/asset.

Những chỗ **đã đúng sẵn** và ngoài phạm vi: git webhook inbound đã idempotent theo delivery id (`hono-api-spec.md:1084`), scheduler/sweep dùng conditional-update guard (`services/scheduler-worker.ts:17`), marketplace vote dùng unique index (`routes/marketplace.ts:453`). Khoảng trống là **mutation POST phía client** — chưa có bất kỳ `Idempotency-Key` nào trong codebase (grep xác nhận 0 kết quả).

Nguyên tắc thiết kế bắt buộc (theo Brandur, khớp kiến trúc LumiBase):

1. **Key do client sinh** (UUID), giữ nguyên xuyên các lần retry.
2. **Business logic chỉ chạy khi MISS**; HIT → replay nguyên response đã lưu, không re-execute.
3. **Chống concurrent same-key** bằng unique constraint trong Postgres (claim-first), không phải lock in-memory — vì LumiBase chạy dual deployment (CF Workers + Docker) nhiều instance cùng lúc.
4. **Idempotency store nằm trong Payments… tức Domain DB**: một bảng Postgres cùng transaction với dữ liệu nghiệp vụ. KHÔNG dùng `runtime.cache` (KV/Redis) làm store — cache tách rời tạo dual-write problem (side-effect ngoài thành công nhưng ghi cache fail → retry thấy MISS → double-execute). Đây là ngoại lệ có chủ đích của thói quen "cache qua runtime abstraction": idempotency là **dữ liệu đúng đắn**, không phải cache.

**Ngoài phạm vi v1:** recovery-point/atomic-phase đầy đủ kiểu Brandur cho multi-step external calls (ghi nhận là v2 trong design); idempotency cho GET/PUT vốn đã idempotent; retrofit toàn bộ endpoint (v1 chỉ opt-in các route liệt kê ở Req 5).

## Glossary

- **Idempotency_Key**: Giá trị header `Idempotency-Key` do client sinh (khuyến nghị UUID), 1–255 ký tự, giữ nguyên khi retry.
- **Idempotency_Store**: Bảng Postgres `idempotency_keys` trong cùng database với dữ liệu domain, unique theo `(site_id, scope, key)`.
- **Scope**: Danh tính người gọi mà key được cô lập theo — `userId` (auth session) hoặc `apiKeyId`; hai caller khác nhau dùng trùng key không đụng nhau.
- **Fingerprint**: SHA-256 của `method + path + raw body`, phát hiện việc tái sử dụng key cho payload khác.
- **Claim**: `INSERT … ON CONFLICT DO NOTHING` giành quyền thực thi cho một key; instance nào claim được thì chạy handler.
- **Replay**: Trả lại response đã lưu (status + body) kèm header `Idempotency-Replayed: true`, không chạy handler.
- **Idempotency_Middleware**: Middleware Hono đặt sau `tenant → auth → db → rls`, chỉ kích hoạt khi request có header và route đã opt-in.

## Requirements

### Requirement 1: Execute-once theo key

**User Story:** Là một API consumer, tôi muốn retry an toàn một mutation khi timeout, để không tạo duplicate content hay trigger deploy hai lần.

#### Acceptance Criteria

1. WHEN một request mutation kèm `Idempotency-Key` chưa từng thấy đến, THE Idempotency_Middleware SHALL claim key rồi cho handler chạy bình thường, sau đó persist `{status, body}` của response vào Idempotency_Store.
2. WHEN một request kèm key đã `completed` đến (bất kể bao nhiêu lần), THE Idempotency_Middleware SHALL replay nguyên response đã lưu kèm header `Idempotency-Replayed: true` và TUYỆT ĐỐI KHÔNG gọi handler.
3. WHEN hai request cùng `(site, scope, key)` chạy song song, THE Idempotency_Store SHALL đảm bảo đúng một request claim được (unique index); request còn lại nhận HTTP 409 `{ errors: [{ code: 'IDEMPOTENCY_CONFLICT' }] }` kèm `Retry-After`.
4. WHEN handler ném lỗi 5xx hoặc crash trước khi persist response, THE Idempotency_Middleware SHALL giải phóng key (xoá row claim) để lần retry sau được re-execute — mirror hành vi Stripe với 5xx.
5. WHEN request không có header `Idempotency-Key`, THE Idempotency_Middleware SHALL bỏ qua hoàn toàn (pass-through, không ghi store) — cơ chế là opt-in per-request.

### Requirement 2: Chống tái sử dụng key sai

**User Story:** Là một developer, tôi muốn bị chặn khi vô tình dùng lại key cho payload khác, để lỗi client không âm thầm trả về response của request khác.

#### Acceptance Criteria

1. THE Idempotency_Middleware SHALL lưu Fingerprint tại thời điểm claim.
2. WHEN key HIT nhưng Fingerprint khác với đã lưu, THE Idempotency_Middleware SHALL trả HTTP 422 `{ errors: [{ code: 'IDEMPOTENCY_KEY_REUSED' }] }`, không replay, không execute.
3. WHEN header dài hơn 255 ký tự hoặc rỗng, THE Idempotency_Middleware SHALL trả HTTP 422 `VALIDATION_ERROR`.

### Requirement 3: Multi-tenant & scope isolation

#### Acceptance Criteria

1. THE Idempotency_Store SHALL có cột `site_id` và mọi truy vấn SHALL lọc theo `site_id` của request (rule multi-tenancy của repo).
2. THE Idempotency_Store SHALL cô lập key theo Scope: cùng key từ hai user/api-key khác nhau là hai entry độc lập.
3. THE Idempotency_Store SHALL có RLS policy site-scoped nhất quán với `packages/database/migrations/rls-policies.sql`.

### Requirement 4: TTL & dọn dẹp

#### Acceptance Criteria

1. THE Idempotency_Store SHALL gắn `expires_at` mặc định 24 giờ kể từ khi tạo.
2. THE hệ thống SHALL prune entry hết hạn bằng sweep định kỳ theo pattern retention hiện có (`modules/cdc/change-feed/retention.ts`, `scheduler-worker.ts`) — idempotent, batch-bounded.
3. WHEN key đã bị prune và client gửi lại, THE Idempotency_Middleware SHALL coi là key mới (re-execute) — TTL là trade-off được ghi rõ trong docs.

### Requirement 5: Phạm vi route v1

#### Acceptance Criteria

1. THE Idempotency_Middleware SHALL được gắn (opt-in) cho: `POST /items/:collection`, `POST /items/:collection/bulk`, `POST /deployments/targets/:id/deploy`, `POST /flows/:id/run` (hoặc route trigger tương đương), `POST /uploads`.
2. THE danh sách route áp dụng SHALL được khai báo tập trung (một mảng/registry), không rải rác điều kiện trong từng handler.
3. Response replay SHALL giữ nguyên contract `{ data }` / `{ errors }` của repo.

### Requirement 6: SDK & Studio

#### Acceptance Criteria

1. THE `packages/sdk` SHALL tự sinh UUID `Idempotency-Key` cho các method mutation tương ứng và **tái sử dụng đúng key đó** khi SDK tự retry; expose option cho caller tự truyền key.
2. THE Studio SHALL gửi `Idempotency-Key` cho mutation tạo item và trigger deploy (sinh key một lần cho mỗi lần user bấm, giữ nguyên khi retry).

### Requirement 7: Docs

#### Acceptance Criteria

1. THE docs SHALL có trang feature `docs/en/features/idempotency-keys.md` + bản `docs/vi/` tương ứng: cách dùng header, bảng hành vi (MISS/HIT/in-flight/fingerprint-mismatch/5xx), TTL, lý do dùng Postgres thay Redis (dual-write problem).
2. THE `docs/en/api/hono-api-spec.md` SHALL được cập nhật: header mới, mã lỗi 409/422 mới, danh sách endpoint hỗ trợ.
3. THE `docs/en/data-model.md` SHALL bổ sung bảng `idempotency_keys`.
4. THE Setup Impact Registry (`.kiro/specs/admin-setup-wizard/setup-impact.md`) SHALL được rà soát và ghi kết quả (dự kiến `n/a` — không thêm bước setup) theo DoD.
