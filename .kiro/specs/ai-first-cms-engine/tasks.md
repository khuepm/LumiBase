# Implementation Plan: AI-First CMS Engine

## Overview

Triển khai hệ thống AI-First CMS Engine cho LumiBase gồm 4 module: Database schema (bảng `ai_approvals`), AI Secure Harness service, AI HTTP API routes, và Studio UI components. Sử dụng TypeScript strict mode, Hono framework, Drizzle ORM, Zod validation, React, và fast-check cho property-based testing.

## Tasks

- [x] 1. Thiết lập Database Schema và cấu trúc cơ sở
  - [x] 1.1 Tạo schema bảng `ai_approvals` trong `packages/database/src/schema/ai.ts`
    - Định nghĩa bảng `aiApprovals` với các cột: id (text, PK, nanoid 21 ký tự), siteId (text, NOT NULL, FK → sites CASCADE), agentName (text, NOT NULL, default 'lumibase-copilot'), skillName (text, NOT NULL), arguments (jsonb, NOT NULL, default {}), status (text, NOT NULL, default 'pending'), context (text, nullable), createdAt (timestamp, NOT NULL, default now()), decidedAt (timestamp, nullable), decidedBy (text, FK → users SET NULL)
    - Tạo index `ai_approvals_site_status_idx` trên cặp (siteId, status)
    - Export `aiApprovals` từ `packages/database/src/schema/index.ts`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 10.3, 10.6_

  - [x] 1.2 Viết property test cho schema `ai_approvals` (round-trip)
    - **Property 15: Approval record round-trip**
    - Với bất kỳ dữ liệu hợp lệ, insert rồi query lại phải giữ nguyên giá trị, id đúng 21 ký tự, status mặc định 'pending'
    - **Validates: Requirements 1.1, 1.3, 1.6**

  - [x] 1.3 Sinh migration và áp dụng schema
    - Chạy `pnpm --filter @lumibase/database generate` để sinh file migration
    - Đảm bảo migration tạo đúng bảng, index, và foreign keys
    - _Requirements: 1.1, 1.2_

- [x] 2. Triển khai AI Secure Harness Service (Module B)
  - [x] 2.1 Tạo file `apps/cms/src/services/ai-harness.ts` với interfaces và class cơ bản
    - Định nghĩa `SkillDefinition`, `HarnessExecutionResult`, `AISecureHarnessConfig`
    - Tạo class `AISecureHarness` với constructor nhận `config: { db, siteId }`
    - Triển khai phương thức `validateSkill(skillName)` kiểm tra skill trong CORE_SKILLS
    - Triển khai phương thức `checkCapabilities(skill, userCapabilities)` hỗ trợ wildcard `*`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 10.1_

  - [x] 2.2 Viết property test cho skill validation
    - **Property 1: Skill validation — tên skill không hợp lệ bị từ chối**
    - Với bất kỳ chuỗi skillName không tồn tại trong CORE_SKILLS, kết quả phải có status 'denied'
    - **Validates: Requirements 2.1, 2.2**

  - [x] 2.3 Viết property test cho capability checking
    - **Property 2: Capability checking với wildcard**
    - Với bất kỳ skill hợp lệ và tập capabilities, cho phép khi đủ quyền hoặc có wildcard '*'
    - **Validates: Requirements 2.3, 2.4**

  - [x] 2.4 Triển khai Risk Evaluator và luồng thực thi chính
    - Triển khai `evaluateRisk(skill, skillName)`: phân loại nguy hiểm nếu capability 'schema:write' hoặc tên bắt đầu bằng 'delete'
    - Triển khai `execute(skillName, args, userCapabilities, contextMessage?)`: luồng đầy đủ validate → check caps → evaluate risk → execute hoặc tạo approval
    - Triển khai `runSkill(skillName, args)` với error handling và timeout 30s (Promise.race)
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.9_

  - [x] 2.5 Viết property test cho risk classification
    - **Property 3: Risk classification và execution flow**
    - Skill nguy hiểm (schema:write hoặc delete*) → pending_approval; skill an toàn → executed
    - **Validates: Requirements 2.5, 2.6, 2.7**

  - [x] 2.6 Viết property test cho execution error handling
    - **Property 4: Execution error handling**
    - Skill an toàn mà handler ném exception → status 'denied', không thay đổi DB
    - **Validates: Requirements 2.8**

  - [x] 2.7 Triển khai `executeApproved` và `rejectApproval`
    - Triển khai `executeApproved(approvalId, userId)`: query approval theo id + siteId, kiểm tra status 'pending', thực thi skill, cập nhật trạng thái
    - Triển khai `rejectApproval(approvalId, userId)`: cập nhật status 'rejected', decidedAt, decidedBy
    - Xử lý trường hợp skill thất bại sau phê duyệt: giữ nguyên 'pending'
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 9.1_

  - [x] 2.8 Viết property test cho approval execution flow
    - **Property 5: Approval execution flow — phê duyệt thực thi đúng**
    - Approval pending + skill thành công → status 'executed', record cập nhật 'approved'
    - **Validates: Requirements 3.1, 3.2, 6.1**

  - [x] 2.9 Viết property test cho invalid approval denial
    - **Property 6: Invalid approval denial**
    - Approval không tồn tại, khác site, hoặc không pending → status 'denied', không thay đổi DB
    - **Validates: Requirements 3.3, 6.6**

  - [x] 2.10 Viết property test cho execution failure preserves pending
    - **Property 7: Execution failure preserves pending state**
    - Skill handler ném exception hoặc timeout → Approval giữ 'pending', trả về 'denied'
    - **Validates: Requirements 3.5, 6.7**

  - [x] 2.11 Viết property test cho multi-tenancy isolation
    - **Property 8: Multi-tenancy isolation**
    - Thao tác từ siteB không thể truy cập/thực thi/tiết lộ bản ghi của siteA
    - **Validates: Requirements 3.4, 9.1, 9.2, 9.3, 9.4**

- [x] 3. Checkpoint - Đảm bảo Module A và B hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 4. Triển khai AI HTTP API Routes (Module C)
  - [x] 4.1 Tạo file `apps/cms/src/routes/ai.ts` với Zod schemas và endpoint POST `/chat`
    - Định nghĩa `chatSchema` với validation: message string, min 1, max 2000, trim
    - Triển khai endpoint POST `/chat`: validate input → phân tích intent (mock LLM) → gọi AISecureHarness.execute → trả về response
    - Xử lý lỗi: validation 400, internal error 500, harness result 200
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 10.2, 10.5_

  - [x] 4.2 Viết property test cho chat message validation
    - **Property 9: Chat message validation**
    - Chuỗi trim 1-2000 ký tự → chấp nhận; rỗng hoặc >2000 → HTTP 400 với mảng errors
    - **Validates: Requirements 4.1, 4.2**

  - [x] 4.3 Viết property test cho chat API response structure
    - **Property 10: Chat API response structure**
    - Response thành công phải có cấu trúc `{ data: { status } }` với status là 'executed', 'pending_approval', hoặc 'denied'
    - **Validates: Requirements 4.7**

  - [x] 4.4 Triển khai endpoint GET `/approvals` và POST `/approvals/:id/decide`
    - GET `/approvals`: query pending approvals theo siteId, sắp xếp createdAt DESC, limit 100
    - POST `/approvals/:id/decide`: validate `decideSchema` (decision: 'approved' | 'rejected'), gọi harness.executeApproved hoặc rejectApproval
    - Xử lý multi-tenancy: chỉ truy vấn bản ghi thuộc siteId hiện tại
    - Xử lý lỗi: approval không tồn tại/khác site → 403, thiếu auth → 401, thiếu siteId → 400
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.3, 9.4, 9.5_

  - [x] 4.5 Viết property test cho approvals list query
    - **Property 11: Approvals list query — chỉ trả về pending của site hiện tại**
    - Chỉ trả về records có status 'pending' AND siteId khớp, sắp xếp createdAt DESC, max 100
    - **Validates: Requirements 5.1, 5.2**

  - [x] 4.6 Viết property test cho decision validation
    - **Property 12: Decision validation**
    - Giá trị decision khác 'approved'/'rejected' → từ chối request
    - **Validates: Requirements 6.2, 6.5**

  - [x] 4.7 Mount AI router vào ứng dụng chính
    - Import `aiRouter` trong `apps/cms/src/index.ts`
    - Mount tại path `/api/v1/ai` trong sub-app `api` (đã có middleware withTenant, withAuth, withDb, withRls)
    - _Requirements: 10.2_

- [x] 5. Checkpoint - Đảm bảo Module C hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.

- [x] 6. Triển khai Studio UI Components (Module D)
  - [x] 6.1 Tạo component AI Chat Panel (`apps/studio/src/components/ai-assistant.tsx`)
    - Floating button 48×48px, góc dưới phải (bottom: 24px, right: 24px)
    - Panel 320×480px với glassmorphism (backdrop-blur)
    - State management: open, messages[], input, loading
    - Gọi POST `/api/v1/ai/chat` khi gửi tin nhắn
    - Hiển thị loading indicator khi đang xử lý
    - Phân biệt vai trò 'user' và 'assistant' trong danh sách tin nhắn
    - Hiển thị nhãn 'pending_approval' khi status tương ứng
    - Vô hiệu hóa nút gửi khi tin nhắn trống/chỉ khoảng trắng
    - Giới hạn 50 tin nhắn trong history
    - Xử lý lỗi API: hiển thị thông báo lỗi trong danh sách tin nhắn
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

  - [x] 6.2 Viết property test cho message history limit
    - **Property 13: Message history limit**
    - Số lượng tin nhắn trong history không bao giờ vượt quá 50
    - **Validates: Requirements 7.8**

  - [x] 6.3 Tạo component Approvals Dashboard (`apps/studio/src/modules/settings/ai-approvals.tsx`)
    - Hiển thị danh sách pending approvals dưới dạng card (tối đa 50 thẻ)
    - Mỗi card: skillName, arguments (JSON pretty-print 2 spaces), context
    - Hai nút: Approve / Reject với loading state (vô hiệu hóa khi đang xử lý)
    - Gọi GET `/api/v1/ai/approvals` khi mount, hiển thị loading spinner
    - Gọi POST `/api/v1/ai/approvals/:id/decide` khi click Approve/Reject
    - Loại bỏ card khỏi danh sách khi xử lý thành công
    - Hiển thị thông báo khi danh sách rỗng
    - Hiển thị lỗi và kích hoạt lại nút khi API thất bại
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9_

  - [x] 6.4 Viết property test cho approval card rendering
    - **Property 14: Approval card rendering completeness**
    - Card phải hiển thị đầy đủ: skillName, arguments (JSON pretty-printed 2 spaces), context
    - **Validates: Requirements 8.2**

- [x] 7. Tích hợp và kết nối toàn bộ hệ thống
  - [x] 7.1 Kết nối Skill Executor với các service hiện có
    - Kết nối `runSkill` trong AISecureHarness với SchemaService (cho schema:write skills)
    - Kết nối với ItemService (cho items:read/write skills)
    - Định nghĩa CORE_SKILLS registry với các skill cơ bản: listCollections, createCollection, deleteCollection, listItems, createItem, deleteItem
    - _Requirements: 2.7, 3.1_

  - [x] 7.2 Viết integration tests cho luồng end-to-end
    - Test luồng: Chat → Harness → DB → Approve → Execute
    - Test cascade: xóa site → approvals bị xóa
    - Test set null: xóa user → decidedBy = null
    - _Requirements: 1.4, 1.5, 3.1, 3.2_

- [x] 8. Checkpoint cuối - Đảm bảo toàn bộ hệ thống hoạt động
  - Đảm bảo tất cả tests pass, hỏi người dùng nếu có thắc mắc.
  - Chạy `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` không có lỗi.

## Notes

- Các task đánh dấu `*` là tùy chọn và có thể bỏ qua để triển khai MVP nhanh hơn
- Mỗi task tham chiếu đến requirements cụ thể để đảm bảo truy xuất nguồn gốc
- Checkpoints đảm bảo kiểm tra tăng dần (incremental validation)
- Property tests kiểm tra thuộc tính đúng đắn phổ quát (universal correctness properties)
- Unit tests kiểm tra ví dụ cụ thể và trường hợp biên (edge cases)
- Sử dụng fast-check cho property-based testing với tối thiểu 100 iterations
- Tất cả code phải tuân thủ TypeScript strict mode, không sử dụng `any`
- Mọi truy vấn DB phải bao gồm điều kiện `siteId` để đảm bảo multi-tenancy

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 4, "tasks": ["2.5", "2.6", "2.7"] },
    { "id": 5, "tasks": ["2.8", "2.9", "2.10", "2.11"] },
    { "id": 6, "tasks": ["4.1"] },
    { "id": 7, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 8, "tasks": ["4.5", "4.6", "4.7"] },
    { "id": 9, "tasks": ["6.1", "6.3"] },
    { "id": 10, "tasks": ["6.2", "6.4"] },
    { "id": 11, "tasks": ["7.1"] },
    { "id": 12, "tasks": ["7.2"] }
  ]
}
```
