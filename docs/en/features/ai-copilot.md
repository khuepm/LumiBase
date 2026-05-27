# AI Copilot (HITL)

LumiBase Studio đi kèm một AI Copilot có thể nhận lệnh ngôn ngữ tự nhiên từ admin và thực thi các skill đã được khai báo trên CMS. Mọi hành động nguy hiểm (đụng schema hoặc xoá dữ liệu) đều phải qua **Human-in-the-Loop (HITL)**: AI tạo `ai_approvals` row chờ admin duyệt thay vì execute trực tiếp.

> Tài liệu lịch sử của giai đoạn triển khai (chia 4 module cho AI agent) nằm ở [`ai-first-specification.md`](./ai-first-specification.md). File này tập trung vào hành vi end-user và contract API.

## Kiến trúc 4 module

| Module | File chính | Trách nhiệm |
|--------|-----------|-------------|
| **A. Schema** | `packages/database/src/schema/ai.ts` (`ai_approvals`) | Lưu trạng thái phê duyệt |
| **B. Harness** | `apps/cms/src/services/ai-harness.ts` (`AISecureHarness`) | Validate skill, check capability, evaluate risk, execute hoặc gate qua HITL |
| **C. Routes** | `apps/cms/src/routes/ai.ts` (`aiRouter`) | `/api/v1/ai/chat`, `/api/v1/ai/approvals`, `/api/v1/ai/approvals/:id/decide` |
| **D. Studio UI** | `apps/studio/src/components/ai-assistant.tsx`, `apps/studio/src/modules/settings/ai-approvals.tsx` | Floating chat panel + Approvals dashboard |

## CORE_SKILLS registry

Skills được khai báo tập trung trong `packages/ai-skills/src/skills.ts`. Mỗi skill chứa:

- `name`, `description` (description dùng cho LLM tool calling).
- `parameters` — JSON Schema OpenAI-compatible.
- `requiredCapabilities` — phải thỏa mãn so với capability của session.

Skills hiện có: `listCollections`, `createCollection`, `deleteCollection`, `createField`, `deleteField`, `listItems`, `createItem`, `updateItem`, `deleteItem`.

Helper `getAISkillsAsTools()` trả về dạng OpenAI function-calling tool list — dùng khi tích hợp LLM thật.

## Risk evaluation rules

Một skill được phân loại **dangerous** (cần HITL) nếu:

- Yêu cầu capability `'schema:write'`, **hoặc**
- Tên skill bắt đầu bằng `'delete'`.

Ngược lại là **safe** → execute trực tiếp.

Wildcard `'*'` trong user capabilities thoả mãn mọi yêu cầu.

## Luồng end-to-end

```
┌──────────────┐  POST /api/v1/ai/chat
│ AI Assistant │ ─────────► [Hono router]
│ (Studio UI)  │              │
└──────┬───────┘              ▼
       │              [AISecureHarness.execute]
       │                       │
       │            ┌──────────┼──────────┐
       │            ▼          ▼          ▼
       │       validate    capability   risk
       │       skill       check         eval
       │            │          │          │
       │            └──────────┴──────────┘
       │                       │
       │              ┌────────┴────────┐
       │              ▼                 ▼
       │         safe → run       dangerous →
       │         skill direct     INSERT ai_approvals
       │                                │
       │                          status=pending
       │                                ▼
       │                       respond { status:
       │                       'pending_approval',
       │                       approvalId }
       │                                │
       │             ┌──────────────────┘
       │             │
       ▼             ▼
┌──────────────┐  GET /api/v1/ai/approvals
│ Approvals    │ ─────────► [list pending for siteId]
│ Dashboard    │
│              │  POST /api/v1/ai/approvals/:id/decide
│              │ ─────────► executeApproved | rejectApproval
└──────────────┘
```

## API contract

### `POST /api/v1/ai/chat`

Request: `{ "message": string }` (1-2000 chars sau trim).

Response 200: `{ "data": { "status": "executed" | "pending_approval" | "denied", "data"?, "approvalId"?, "message"? } }`.

Response 400: validation error.

### `GET /api/v1/ai/approvals`

Trả về tối đa 100 approval có `status='pending'` trong site hiện tại, sắp xếp `createdAt DESC`.

### `POST /api/v1/ai/approvals/:id/decide`

Body: `{ "decision": "approved" | "rejected" }`.

- `"approved"` → harness execute skill với arguments đã lưu, cập nhật status thành `approved` (nếu execute thành công). Nếu skill thất bại, giữ status `pending` để admin retry.
- `"rejected"` → cập nhật status `rejected`.

Mọi truy vấn đều scope `siteId` — request từ site B không bao giờ thấy bản ghi của site A (HTTP 403, không tiết lộ existence).

## Studio UI

### AI Assistant panel

- Floating button 48×48px ở `bottom: 24px, right: 24px`.
- Click mở panel 320×480px, glassmorphism (backdrop-blur).
- Phân biệt vai trò `user` vs `assistant`.
- Hiển thị badge `pending_approval` khi áp dụng.
- History tối đa 50 messages, reset khi reload trang.

### Approvals Dashboard

- `apps/studio/src/modules/settings/ai-approvals.tsx`.
- Card view, mỗi card: `skillName`, `arguments` (JSON pretty 2 spaces), `context`.
- Hai nút **Approve** / **Reject** với loading state — disable cả 2 khi đang xử lý.
- Empty state khi không có pending.

## Multi-tenancy

- Mọi insert/select/update bảng `ai_approvals` đều `WHERE siteId = currentSiteId`.
- Cross-site access → 403, không cho biết bản ghi có tồn tại ở site khác hay không.
- Tenant middleware (`withTenant`) bắt buộc resolve `siteId` trước khi router AI hoạt động.

## Tích hợp LLM thật

Phiên bản hiện tại trong `apps/cms/src/routes/ai.ts` dùng **mock intent parser** (hardcode skill `createCollection` cho mọi message). Để tích hợp LLM thật:

1. Gọi `getAISkillsAsTools()` từ `@lumibase/ai-skills` để lấy danh sách tool.
2. Pass vào OpenAI/Anthropic/Workers AI client với message của user.
3. Lấy `tool_calls` từ response → map sang `(skillName, arguments)`.
4. Forward sang `harness.execute(...)`.

Theo dõi roadmap "POST-GA — Nâng cao" trong `docs/roadmap/tasks.md`.

## Property-based testing

Hệ thống có 15 property tests (fast-check, ≥100 iterations) được liệt kê đầy đủ trong `.kiro/specs/ai-first-cms-engine/design.md` mục "Correctness Properties". Các test ở:

- `apps/cms/src/services/__tests__/ai-harness-*.property.test.ts` — Properties 1-8 (Module B).
- `apps/cms/src/routes/__tests__/ai-*.property.test.ts` — Properties 9-12 (Module C).
- `apps/studio/src/modules/settings/__tests__/` — Properties 13-14 (Module D).
- `packages/database/src/__tests__/` — Property 15 (round-trip).
