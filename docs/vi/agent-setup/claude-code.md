---
version: 2
lastUpdated: 2026-08-02T19:13:16.483Z
sourceLang: en
translatedFrom: en
sourceHash: 58eee638b9682bbc
mtEngine: manual
syncStatus: human-translated
---

# Claude Code — LumiBase Agent Setup

> **Claude Code** là một coding agent chạy trên terminal do Anthropic tạo ra. Nó hiểu codebase của bạn, chạy lệnh, chỉnh sửa file, và quản lý git.
>
> **Tags:** Terminal · Standalone · Cloud · Extension

---

## Thiết lập nhanh (khuyến nghị)

Chạy bên trong Claude Code để nạp toàn bộ ngữ cảnh LumiBase trong một bước:

```
Read docs/en/agent-setup/prompt.md and follow all setup instructions.
```

Hoặc nếu bạn đang dùng bản copy docs từ xa:

```
Fetch https://raw.githubusercontent.com/khuepm/lumibase/main/docs/en/agent-setup/prompt.md
```

---

## Thiết lập thủ công

### Bước 1 — Mở dự án của bạn

```bash
cd /path/to/lumibase
claude
```

### Bước 2 — Nạp ngữ cảnh dự án

Dán nội dung sau vào Claude Code:

```
Read docs/en/README.md to understand the LumiBase monorepo structure.
Then read docs/en/data-model.md for the database schema.
Then read docs/en/ai-skills.md for the skill system conventions.
```

### Bước 3 — Thêm luật LumiBase vào CLAUDE.md

Tạo hoặc thêm vào `CLAUDE.md` ở thư mục gốc dự án:

```markdown
## LumiBase development rules

- Use NanoID or UUIDv7 for all IDs — never auto-increment serial
- Every domain table must have `site_id` for multi-tenancy
- Business logic goes through `@lumibase/runtime` abstractions (not direct CF bindings)
- Prefer 1-roundtrip aggregated API responses
- Dangerous AI actions (schema:write, delete*) must create ai_approvals rows
- Cache invalidation must use tag-based approach (not key enumeration)
- Follow the stack: Hono.js + Drizzle ORM + PostgreSQL + Cloudflare Workers / Docker
```

### Bước 4 — Thiết lập MCP server (tùy chọn)

Nếu bạn muốn Claude Code có quyền truy cập trực tiếp (live) vào LumiBase API:

Thêm vào cấu hình Claude MCP của bạn (`~/.claude.json` hoặc `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "lumibase": {
      "url": "http://localhost:1989/mcp",
      "env": {
        "LUMIBASE_TOKEN": "<your-access-token>",
        "LUMIBASE_SITE_ID": "<your-site-id>"
      }
    }
  }
}
```

Sau đó khởi động lại Claude Code và xác minh bằng: `/mcp`

---

## Các file chính cho Claude Code

Khi bắt đầu một task mới, hãy trỏ Claude Code tới các docs liên quan:

| Task | File cần đọc |
|------|-------------|
| Thêm collection / field mới | `docs/en/data-model.md` + `docs/en/features/collections-builder.md` |
| Xây dựng một Flow / automation | `docs/en/features/flows-automation.md` |
| Làm việc trên AI Copilot | `docs/en/features/ai-copilot.md` + `packages/ai-skills/src/skills.ts` |
| Thêm một API route | `docs/en/api/hono-api-spec.md` + `apps/cms/src/routes/` |
| Thêm logic permissions | `docs/en/features/permissions-rbac.md` |
| Deploy lên Cloudflare | `docs/en/deployment/cloudflare.md` |
| Chạy cục bộ | `docs/en/deployment/local-development.md` |

---

## Ví dụ prompt

```
Read docs/en/features/flows-automation.md, then add a new "send-slack" operation type
to the operations engine. Follow the existing pattern for operation handlers.
```

```
Read docs/en/features/ai-copilot.md. Add a new AI skill called "publishCollection"
that sets a collection's status to "published". Mark it as safe (no HITL needed).
```

```
Read docs/en/data-model.md. Create a Drizzle migration to add a `tags` text[] column
to the items table, following the site_id multi-tenancy pattern.
```

---

## Xử lý sự cố

**Claude không tìm thấy docs**: Đảm bảo bạn đang chạy `claude` từ thư mục gốc dự án, hoặc cung cấp đường dẫn tuyệt đối.

**Lỗi type sau khi thay đổi schema**: Chạy `pnpm -F @lumibase/database db:generate` để regenerate các type Drizzle.

**CMS API không khởi động được**: Kiểm tra `apps/cms/.dev.vars` và đảm bảo mọi env var bắt buộc đã được đặt (xem `docs/en/deployment/environment-variables.md`).

---

← [Quay lại Thiết lập Agent](./index.md)
