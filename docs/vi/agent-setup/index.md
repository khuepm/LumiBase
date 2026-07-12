---
version: 1
lastUpdated: 2026-07-08T20:22:25.632Z
sourceLang: en
translatedFrom: en
sourceHash: 605ac6e8cf30748d
mtEngine: claude
syncStatus: machine-translated
---

# Thiết lập Agent — LumiBase

> **Dành cho AI agent:** Trang này cũng có sẵn ở dạng Markdown thuần. Nếu bạn đang đọc HTML, hãy yêu cầu `index.md` thay thế. Để xem chỉ mục đầy đủ của trang, xem [`llms.txt`](../llms.txt).

LumiBase cung cấp một [prompt template](./prompt.md), các cấu hình MCP server, và các file ngữ cảnh có cấu trúc để AI coding agent có thể hiểu codebase, gọi API, và xây dựng tính năng đúng cách. Chọn agent của bạn bên dưới để bắt đầu.

---

## Thiết lập nhanh

Đã có sẵn agent? Dán nội dung này vào bất kỳ AI coding agent nào để nạp ngữ cảnh dự án LumiBase chỉ trong một bước:

```
Fetch https://raw.githubusercontent.com/lumibase/lumibase/main/docs/en/agent-setup/prompt.md
```

Hoặc nếu bạn đang làm việc cục bộ, hãy bảo agent của bạn:

```
Read docs/en/agent-setup/prompt.md and follow all setup instructions.
```

---

## Thiết lập thủ công — Chọn agent của bạn

Chọn agent của bạn để xem hướng dẫn từng bước về cách kết nối ngữ cảnh LumiBase và (tùy chọn) MCP server.

| Agent | Loại | Hướng dẫn |
|-------|------|-------|
| [Claude Code](./claude-code.md) | Terminal · Standalone · Cloud · Extension | [Xem hướng dẫn →](./claude-code.md) |
| [Codex](./codex.md) | Terminal · Standalone · Cloud · Extension · Open Source | [Xem hướng dẫn →](./codex.md) |
| [Cursor](./cursor.md) | Terminal · IDE · Standalone · Cloud | [Xem hướng dẫn →](./cursor.md) |
| [GitHub Copilot](./github-copilot.md) | Terminal · Cloud · Extension | [Xem hướng dẫn →](./github-copilot.md) |
| [Windsurf](./windsurf.md) | IDE · Standalone | [Xem hướng dẫn →](./windsurf.md) |

---

## Docs thân thiện với agent

LumiBase cấu trúc tài liệu của mình để tiết kiệm token và dễ tiêu thụ trong một context window.

### Phiên bản Markdown

Thêm `/index.md` vào bất kỳ URL docs nào của LumiBase để lấy phiên bản Markdown thuần.

### Chỉ mục trang (llms.txt)

Mỗi section cấp cao nhất đều có `llms.txt` riêng — một chỉ mục trang được chỉnh kích cỡ vừa với một context window:

- [`docs/llms.txt`](../../llms.txt) — thư mục của toàn bộ docs LumiBase.
- [`docs/en/llms.txt`](../llms.txt) — chỉ mục docs tiếng Anh đầy đủ.

### Prompt cho agent

[`docs/en/agent-setup/prompt.md`](./prompt.md) — hướng dẫn thiết lập ở dạng máy đọc được để cấu hình bất kỳ agent nào làm việc với LumiBase. Được thiết kế để agent fetch và thực thi trực tiếp.

---

## Agent có thể làm gì với LumiBase

Sau khi thiết lập, agent của bạn có thể điều khiển **toàn bộ Content OS** qua MCP. MCP server
standalone (`@lumibase/mcp-server`) hiện phơi bày ~80 tool trên mọi
domain; mọi tool có tính hủy hoại đều yêu cầu `confirm: true` một cách tường minh:

- **Đọc và ghi collection** — `GET/POST/PATCH/DELETE /api/v1/items/:collection`
- **Quản lý schema** — tạo collection, thêm field, cấu hình relation qua CMS API
- **Quản trị RBAC** — role, policy, permission row, API key, xuất/nhập bulk access & kiểm tra xung đột
- **Quản lý người dùng & nhóm** — mời/cập nhật/xóa thành viên, quyền thành viên nhóm
- **Quản trị nội dung** — content intent (SLO), quét drift, và reconciliation
- **Kích hoạt và giám sát Flows** — `POST /api/v1/flows/:id/run`, `GET /api/v1/flows/:id/runs`
- **Cấu hình delivery** — preset, settings, bản dịch + translation memory, webhook, search
- **Vận hành site** — activity log, health, metrics, backup/restore NDJSON, materialized collection, extension & marketplace
- **Truy vấn AI Copilot** — `POST /api/v1/ai/chat` với chỉ dẫn bằng ngôn ngữ tự nhiên
- **Dùng WebSocket realtime** — subscribe các thay đổi collection, presence, collaborative cursor

Để thực thi có governance, được gate bởi HITL/autonomy, agent có thể gọi
in-process MCP endpoint `POST /api/v1/mcp` (bật cờ `contentOs.mcp` theo từng site).

Mọi endpoint đều yêu cầu access token hợp lệ (`Authorization: Bearer <token>`) được scope theo site (`X-Site-Id` header hoặc subdomain routing). Xem [`api/hono-api-spec.md`](../api/hono-api-spec.md) để có tham chiếu REST/WS đầy đủ.

---

## So sánh các agent

| Agent | Terminal | IDE | Extension | Cloud | Open Source | Model |
|-------|:--------:|:---:|:---------:|:-----:|:-----------:|-------|
| Claude Code | ✓ | — | ✓ | ✓ | — | Claude (locked) |
| Codex | ✓ | — | ✓ | ✓ | ✓ | GPT-4o (locked) |
| Cursor | ✓ | ✓ | — | ✓ | — | Multi-provider |
| GitHub Copilot | ✓ | — | ✓ | ✓ | — | Multi-provider |
| Windsurf | — | ✓ | — | — | — | Multi-provider |

---

## Tài nguyên

- **REST API spec**: [`docs/en/api/hono-api-spec.md`](../api/hono-api-spec.md)
- **Data model**: [`docs/en/data-model.md`](../data-model.md)
- **Nội bộ AI Copilot**: [`docs/en/features/ai-copilot.md`](../features/ai-copilot.md)
- **AI skills registry**: [`docs/en/ai-skills.md`](../ai-skills.md)
- **Flows automation**: [`docs/en/features/flows-automation.md`](../features/flows-automation.md)
- **Tổng quan kiến trúc**: [`docs/en/architecture/overview.md`](../architecture/overview.md)
- **Permissions / RBAC**: [`docs/en/features/permissions-rbac.md`](../features/permissions-rbac.md)
- **Deployment**: [`docs/en/deployment/overview.md`](../deployment/overview.md)
