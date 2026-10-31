---
version: 2
lastUpdated: 2026-10-31T23:41:40.096Z
sourceLang: en
contentHash: d3a62a6ea64bb371
translatedFrom: en
sourceHash: 020f29ddf81d0497
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-31T23:41:40.096Z
codeVerifiedHash: 020f29ddf81d0497
codeVerifiedClaims: 28
---

# AI Copilot (HITL)

LumiBase Studio đi kèm một AI Copilot có thể nhận lệnh ngôn ngữ tự nhiên từ admin và thực thi các skill đã được khai báo trên CMS. Đây là bước seed của **Agent Harness Layer**: agent nhận goal/context/quyền hạn qua harness, gọi tool theo registry, bị đánh giá rủi ro và để lại audit trail. Mọi hành động nguy hiểm (đụng schema hoặc xoá dữ liệu) đều phải qua **Human-in-the-Loop (HITL)**: AI tạo `ai_approvals` row chờ admin duyệt thay vì execute trực tiếp.

> Tài liệu lịch sử của giai đoạn triển khai (chia 4 module cho AI agent) nằm ở [`ai-first-specification.md`](./ai-first-specification.md). Blueprint chiến lược để mở rộng Copilot thành control plane cho agent nằm ở [`agent-harness-layer.md`](./agent-harness-layer.md). File này tập trung vào hành vi end-user và contract API.

## Kiến trúc 4 module

| Module | File chính | Trách nhiệm |
|--------|-----------|-------------|
| **A. Schema** | `packages/database/src/schema/ai.ts` (`ai_approvals`) | Lưu trạng thái phê duyệt |
| **B. Harness** | `apps/cms/src/services/ai-harness.ts` (`AISecureHarness`) | Validate skill, check capability, evaluate risk, execute hoặc gate qua HITL |
| **C. Routes** | `apps/cms/src/routes/ai.ts` (`aiRouter`) | `/api/v1/ai/chat`, `/api/v1/ai/approvals`, `/api/v1/ai/approvals/:id/decide` |
| **D. Studio UI** | `apps/studio/src/components/ai-assistant.tsx`, `apps/studio/src/modules/settings/ai-approvals.tsx` | Floating chat panel + Approvals dashboard |

## Quan hệ với Agent Harness Layer

AI Copilot hiện tại xử lý một vòng lặp ngắn: chat → chọn skill → risk/capability check → execute hoặc tạo approval. Agent Harness Layer mở rộng cùng nguyên tắc này cho vòng lặp dài hơn:

```text
Goal → Run → Plan → Tool calls → Evaluation → Approval → Artifact commit → Memory update
```

Vì vậy các bảng hiện có được xem như seed:

- `ai_approvals` → tiền thân của approval gate tổng quát cho plan/tool/artifact.
- `ai_conversations` + `ai_messages` → context memory ngắn hạn.
- `ai_embeddings` → RAG knowledge base theo site/collection/item.
- `CORE_SKILLS` → tiền thân của tool registry có input schema, capability, rate limit và risk policy.

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

## Tích hợp LLM thật & Context Memory (RAG)

LumiBase Copilot đã tích hợp hoàn chỉnh với các mô hình ngôn ngữ lớn (LLM) và hệ thống lưu trữ vector/lịch sử trò chuyện:

### 1. LLM Providers
Hệ thống hỗ trợ nhiều LLM providers (cấu hình qua `LLM_PROVIDER` env, model qua `LLM_MODEL`):
- **OpenAI**: Sử dụng Chat Completions tool calling (ví dụ `gpt-4.1-nano`, mặc định `gpt-4o-mini`).
- **Anthropic / Claude**: Sử dụng dòng mô hình Claude thông qua native `tool_use`.
- **Gemini**: Sử dụng Gemini REST `generateContent` với function declarations.
- **Workers AI**: Chạy trực tiếp tại edge trên hạ tầng Cloudflare Workers AI (mặc định sử dụng `@cf/meta/llama-3.1-8b-instruct`).
- **Echo**: Bộ khớp từ khóa (fallback mock) dùng cho môi trường test hoặc khi thiếu API credentials.

### 2. Context Memory (Lịch sử hội thoại)
Bảng `ai_conversations` và `ai_messages` được dùng để lưu trữ trạng thái các luồng trò chuyện:
- Mỗi khi gửi message lên `/api/v1/ai/chat`, hệ thống sẽ load tối đa **20 messages gần nhất** để làm ngữ cảnh (context window) truyền vào LLM.
- Hỗ trợ đầy đủ các API quản lý: `GET /conversations`, `GET /conversations/:id/messages`, `DELETE /conversations/:id`.
- Một hội thoại thuộc về user đã tạo nó (#579). Thành viên khác của site nhận `404` khi đọc messages, `DELETE` không xoá gì, và `POST /chat` với `conversationId` đó sẽ mở một hội thoại mới cho người gọi. Caller dùng API key chỉ sở hữu các hội thoại do chính nó tạo (không có user id).

### Ranh giới tin cậy (#579)

- **Chỉ dẫn và dữ liệu.** Chỉ Copilot chat dùng system prompt của Copilot và danh sách tool. Mọi lời gọi model khác (skill sinh nội dung, constitution compiler và judge, intent compiler, decisions) gửi chỉ dẫn riêng vào system slot của provider và tắt tool (`completeWithInstructions`). Constitution judge gửi nội dung cần chấm làm user turn duy nhất, trong một khối `<untrusted>`. Một test source-scan sẽ fail khi có lời gọi mới bỏ qua quy tắc này.
- **Mỗi lượt một tool call, output của tool không vào prompt.** `POST /chat` chỉ thực thi tool call đầu tiên mà model trả về, và kết quả tool trả cho client chứ không quay lại model. Một tấn công nhiều bước vì vậy cần một lượt user cho mỗi bước, và mỗi lượt được phân quyền riêng.
- **Model không cấp quyền.** Harness kiểm capability, input schema chuẩn, và quyền theo row và field của người gọi ở mọi tool call, bất kể model yêu cầu gì. `apps/cms/eval/prompt-injection/dataset.v1.json` liệt kê các tấn công và benign control, được chạy lại như thể model làm theo kẻ tấn công.
- **Redaction.** `listSettings` che các field chứa secret theo cùng quy tắc với `GET /api/v1/settings`.

### 3. RAG Skills (`aiSuggestField` và `aiContentAssist`)
Tích hợp dịch vụ sinh vector embeddings (`embedding-service.ts`) hỗ trợ OpenAI `text-embedding-3-small` và Workers AI `@cf/baai/bge-base-en-v1.5`:
- **`aiSuggestField`**: Phân tích schema hiện tại và mô tả của admin, truy xuất vector tương tự từ database thông qua cosine similarity để gợi ý cấu hình field tối ưu.
- **`aiContentAssist`**: Hỗ trợ sinh hoặc hiệu chỉnh nội dung field dựa trên RAG context từ các item đã lưu trong hệ thống.

## Property-based testing

Hệ thống có 15 property tests (fast-check, ≥100 iterations) được liệt kê đầy đủ trong `.kiro/specs/ai-first-cms-engine/design.md` mục "Correctness Properties". Các test ở:

- `apps/cms/src/services/__tests__/ai-harness-*.property.test.ts` — Properties 1-8 (Module B).
- `apps/cms/src/routes/__tests__/ai-*.property.test.ts` — Properties 9-12 (Module C).
- `apps/studio/src/modules/settings/__tests__/` — Properties 13-14 (Module D).
- `packages/database/src/__tests__/` — Property 15 (round-trip).
