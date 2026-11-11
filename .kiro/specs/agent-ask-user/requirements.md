# Requirements Document — `askUser`: câu hỏi làm rõ trong harness có quản trị

> Status: **Implemented** (issue #710, epic #671). Đối chiếu: Directus v11.16 "Ask User" clarification tool.

## Introduction

Agent chạy trong `AISecureHarness` hiện chỉ có ba kết cục cho một tool call: `executed`, `pending_approval`, `denied`. Khi agent thiếu một quyết định mà nó không được phép tự đưa ra (giọng văn, locale đích, có công bố ngay không…), nó chỉ có thể đoán hoặc dừng. Đoán thì sai lặng lẽ; dừng thì mất ngữ cảnh.

Spec này thêm tool `askUser`: run **tạm dừng** (`waiting_user`), câu hỏi được đưa tới con người (inbox Mission Control + notification), và run **tiếp tục** với câu trả lời. Vòng đời dùng lại cơ chế approval đang có (parking có điều kiện, provenance #472, kill switch, sweep), không tạo vòng đời song song.

## Glossary

- **Question**: một dòng `agent_approvals` với `kind = 'question'`.
- **Waiting run**: `agent_runs.status = 'waiting_user'`.
- **Requester**: `agent_approvals.requested_by_principal` (#472) — principal hoặc agent role đã khởi tạo run.
- **Approver**: principal có `approvals:decide` hoặc control-plane admin.

## Requirements

### Requirement 1: Hỏi và tạm dừng

**User Story:** Là một agent, tôi muốn hỏi một người khi thiếu quyết định, để không phải đoán.

#### Acceptance Criteria

1. THE harness SHALL đăng ký skill `askUser` với input `question` (1–1000), `options?` (2–10, mỗi cái ≤ 200), `allowFreeText?` (mặc định true), `context?` (≤ 2000), `timeoutMinutes?` (1–10080, mặc định 1440); input sai bị từ chối `VALIDATION` trước khi ghi bất kỳ dòng nào.
2. WHEN `allowFreeText = false` THEN `options` SHALL bắt buộc.
3. THE skill SHALL cần `items:read`, không nằm trên thang autonomy (hỏi không có side effect), và đi qua kill switch, capability, policy như mọi tool call.
4. WHEN agent gọi `askUser` THEN harness SHALL, trong một transaction, chuyển run `queued|running → waiting_user` có điều kiện và tạo question `pending` có `expires_at`; nếu run đã bị huỷ thì không ghi gì.
5. THE harness SHALL trả `status: 'waiting_user'` kèm `questionId`, không có `data`.
6. A waiting run SHALL không giữ queue worker và không giữ khoá DB.
7. THE harness SHALL phát notification kind `question` với deep link tới inbox.

### Requirement 2: Trả lời và tiếp tục

**User Story:** Là operator, tôi muốn trả lời câu hỏi trong Mission Control để run tiếp tục đúng một lần.

#### Acceptance Criteria

1. `POST /api/v1/agent/questions/:id/answer` SHALL nhận `{ answer }` 1–2000 ký tự (trim); với `allowFreeText = false` câu trả lời phải là một option (`400 ANSWER_NOT_AN_OPTION`).
2. Người được trả lời SHALL là Approver, hoặc Requester khi Requester là **user** còn resolve được trên site. API key không bao giờ được tự trả lời.
3. Việc claim question `pending → answered` và chuyển run `waiting_user → succeeded` SHALL nằm trong một transaction; lần trả lời thứ hai nhận `409 ALREADY_ANSWERED`.
4. Tool call `askUser` SHALL chuyển `executed` với output là câu trả lời bọc `untrustedBlock` + `UNTRUSTED_CONTENT_RULE`.
5. Trước khi tiếp tục, quyền của Requester SHALL được resolve lại (#472); Requester mất quyền → run `failed` (`requester_revoked`), `409 REQUESTER_REVOKED`.
6. Tool `getUserAnswer` SHALL trả kết quả câu hỏi cho đúng Requester (hoặc grant admin), các trường hợp khác `NOT_FOUND`; câu trả lời được bọc như dữ liệu không tin cậy.
7. Mọi bước SHALL được audit trong `activity`: `agent_question.asked|answered|expired|cancelled`.

### Requirement 3: Hết hạn

1. Sweep (cron 5 phút cả Docker lẫn Cloudflare) SHALL chuyển question quá `expires_at` sang `expired` và run sang `failed` (`stopReason: question_timeout`), tool call `failed`.
2. Route trả lời gặp câu hỏi quá hạn SHALL tự chốt nó và trả `409 EXPIRED`.
3. Run hết hạn SHALL retry được như mọi run `failed`.

### Requirement 4: Kill switch và huỷ

1. Huỷ run (`cancelRun`, kill switch scope `run`) SHALL đóng question đang mở (`cancelled`).
2. Đóng băng role/site và tạm dừng intent SHALL huỷ các run `waiting_user` trong phạm vi (`stopReason: frozen`).
3. Câu trả lời chạy đua với lệnh đóng băng SHALL bị từ chối `423 FROZEN` và run bị huỷ.

### Requirement 5: Tách biệt với approval

1. `GET /agent/approvals` SHALL không liệt kê question; `decide`/`reopen` trả `409 NOT_AN_APPROVAL`; agent reviewer trả `403 HUMAN_ONLY`.
2. Dispatcher và retry SHALL coi `waiting_user` là in-flight.

### Requirement 6: MCP parity

1. `tools/call askUser` SHALL trả tool result thường (`isError: false`) với `status: 'waiting_user'`, `questionId`, `runId`; property test parity MCP phủ trạng thái này.

### Requirement 7: Metric autonomy

1. Prometheus SHALL có `lumibase_agent_questions_total{status}` và `lumibase_agent_question_wait_seconds{status}`; run trả lời/hết hạn được đếm với `stop_reason` `answered` / `question_timeout`.
2. Trust ledger SHALL hiển thị `questions: { asked, answered, expired }` trong bằng chứng đề xuất thăng cấp (không phải cổng chặn).

### Requirement 8: Multi-tenancy

1. Mọi đọc/ghi question SHALL lọc `site_id`; id của site khác là `404`. Bảng dùng lại `agent_approvals` (đã có RLS `site_isolation`).
2. Sweep chạy trên system connection, chốt từng dòng trong site của nó.

### Requirement 9: Studio

1. Inbox Mission Control SHALL hiển thị question (kèm đếm ngược tới hạn) với ô trả lời; options là các nút; ẩn ô tự do khi `allowFreeText = false`; lỗi từ server hiển thị nguyên văn.
2. Gọi API qua `agentFetch` (`missionControlApi.questions` / `answerQuestion`).
