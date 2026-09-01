---
version: 1
lastUpdated: 2026-07-08T20:22:25.910Z
sourceLang: en
translatedFrom: en
sourceHash: ce887b90495381f9
mtEngine: manual
syncStatus: human-translated
---

# GitHub Copilot — LumiBase Agent Setup

> **GitHub Copilot** là một editor extension và CLI với chế độ agent, ngữ cảnh workspace, và tích hợp PR native. Do GitHub tạo ra.
>
> **Tags:** Terminal · Cloud · Extension

---

## Thiết lập nhanh (khuyến nghị)

Mở GitHub Copilot Chat trong VS Code và dán:

```
Read docs/en/agent-setup/prompt.md and follow all setup instructions.
```

---

## Thiết lập thủ công

### Bước 1 — Mở dự án trong VS Code

```bash
code /path/to/lumibase
```

Đảm bảo extension GitHub Copilot đã được cài đặt và xác thực.

### Bước 2 — Tạo một file workspace instructions

Tạo `.github/copilot-instructions.md` ở thư mục gốc dự án:

```markdown
# LumiBase — Copilot workspace instructions

You are working on LumiBase, an Edge-native Headless CMS.

## Stack
- **API**: Hono.js (apps/cms) — dual-runtime: Cloudflare Workers + Docker/Node.js
- **DB**: PostgreSQL + Drizzle ORM (packages/database), JSONB hybrid schema
- **Studio**: React + Vite + TanStack Router (apps/studio)
- **Runtime abstraction**: @lumibase/runtime — use this, never call CF APIs directly
- **Auth**: Logto OIDC, multi-tenant (every request carries siteId)
- **AI**: OpenAI / Anthropic / CF Workers AI — via packages/ai-skills

## Mandatory rules
1. IDs: NanoID or UUIDv7 only. No serial/auto-increment.
2. Multi-tenancy: `site_id` on every domain table, every query scoped.
3. AI safety: Skills with `schema:write` or `delete*` → HITL via ai_approvals table.
4. Performance: Aggregated 1-roundtrip responses, cache-tagged invalidation.

## Key documentation
Read these files before making changes in their area:
- docs/en/data-model.md (schema)
- docs/en/features/ai-copilot.md (AI Copilot)
- docs/en/api/hono-api-spec.md (API spec)
- docs/en/features/flows-automation.md (Flows engine)
- docs/en/features/permissions-rbac.md (permissions)
```

### Bước 3 — Thiết lập MCP server (tùy chọn)

Thêm vào `.vscode/mcp.json`:

```json
{
  "servers": {
    "lumibase": {
      "type": "http",
      "url": "http://localhost:1989/mcp",
      "headers": {
        "Authorization": "Bearer ${env:LUMIBASE_TOKEN}",
        "X-Site-Id": "${env:LUMIBASE_SITE_ID}"
      }
    }
  }
}
```

Đặt `LUMIBASE_TOKEN` và `LUMIBASE_SITE_ID` trong môi trường shell của bạn hoặc `.env`.

Reload VS Code và kiểm tra panel MCP (`Cmd+Shift+P` → "MCP: List Servers").

---

## Chế độ Agent

Bật GitHub Copilot Agent Mode trong VS Code (`Cmd+Shift+P` → "GitHub Copilot: Enable Agent Mode").

Ví dụ prompt agent cho LumiBase:

```
#file:docs/en/features/flows-automation.md
Add a "retry" mechanism to the Flow runner so failed operations retry up to 3 times with exponential backoff.
Modify apps/cms/src/services/flow-service.ts and update the flow_runs schema in packages/database.
```

```
#file:docs/en/features/ai-copilot.md #file:packages/ai-skills/src/skills.ts
Add a new AI skill "exportCollection" that exports all items from a collection as CSV.
Mark it as safe (no HITL needed). Register it in CORE_SKILLS and implement the handler.
```

---

## Mẹo ngữ cảnh workspace

Ngữ cảnh workspace của Copilot (`#workspace`) hoạt động tốt khi:

1. Bạn đã mở thư mục gốc monorepo làm VS Code workspace
2. Các file nguồn liên quan đang mở trong các tab editor
3. Bạn tham chiếu các file docs bằng `#file:` trong prompt

**Các file nên giữ mở** khi làm việc trên LumiBase:

- `docs/en/README.md`
- `docs/en/data-model.md`
- `apps/cms/src/index.ts`
- File route/service cụ thể bạn đang chỉnh sửa

---

## Tóm tắt PR

GitHub Copilot có thể sinh mô tả PR cho các thay đổi LumiBase. Hãy yêu cầu nó:

```
Write a PR description for these changes. Reference the relevant docs files
(docs/en/features/, docs/en/data-model.md) and follow conventional commits format.
```

---

## Tích hợp CLI

Với GitHub Copilot CLI:

```bash
# Ask about a specific LumiBase pattern
gh copilot suggest "how do I add a new Hono route with multi-tenant middleware in LumiBase"

# Explain existing code
gh copilot explain "apps/cms/src/services/ai-harness.ts"
```

---

## Xử lý sự cố

**Copilot không biết các quy ước LumiBase**: Đảm bảo `.github/copilot-instructions.md` đã được commit và VS Code đã reload workspace.

**MCP server không hiện lên**: MCP server yêu cầu `apps/cms` đang chạy cục bộ. Khởi động nó bằng `pnpm -F @lumibase/cms dev`.

**Lỗi type trong code được sinh ra**: Chạy `pnpm typecheck` trong package bị ảnh hưởng để xác định các điểm không khớp, rồi hiển thị lỗi cho Copilot.

---

← [Quay lại Thiết lập Agent](./index.md)
