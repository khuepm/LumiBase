---
version: 1
lastUpdated: 2026-07-08T20:22:25.860Z
sourceLang: en
translatedFrom: en
sourceHash: 26c4353b91d32cc8
mtEngine: claude
syncStatus: machine-translated
---

# Cursor — Thiết lập Agent cho LumiBase

> **Cursor** là một IDE ưu tiên AI được xây dựng trên VS Code với các chỉnh sửa Composer đa file và background agent. Do Cursor tạo ra.
>
> **Tags:** Terminal · IDE · Standalone · Cloud

---

## Thiết lập nhanh (khuyến nghị)

Mở cửa sổ chat của Cursor (`Cmd+L`) và dán:

```
Read docs/en/agent-setup/prompt.md and follow all setup instructions.
```

---

## Thiết lập thủ công

### Bước 1 — Mở dự án

Mở thư mục `Lumibase` trong Cursor (`File → Open Folder`).

### Bước 2 — Cấu hình `.cursorrules`

Dự án đã có sẵn một file `.cursorrules` ở thư mục gốc. Xác minh nó tồn tại và bao gồm các quy ước LumiBase. Nếu chưa, hãy tạo nó:

```markdown
# LumiBase .cursorrules

You are working on LumiBase, an Edge-native Headless CMS built on Hono.js + PostgreSQL + Cloudflare Workers.

## Stack
- Backend: Hono.js (apps/cms) — deploys to Cloudflare Workers or Docker
- Frontend: React + Vite + TanStack Router (apps/studio)
- Database: PostgreSQL with Drizzle ORM (packages/database)
- Runtime abstraction: @lumibase/runtime (CacheProvider, StorageProvider, etc.)
- Auth: Logto (OIDC, multi-tenant)

## Strict rules
- IDs: Use NanoID or UUIDv7. Never auto-increment.
- Multi-tenancy: Every domain table has `site_id`. Every query scopes with WHERE site_id = :siteId.
- Edge-friendliness: Never call CF KV/R2 directly. Use @lumibase/runtime adapters.
- API style: 1-roundtrip aggregated responses. Avoid N+1.
- AI safety: Dangerous skills (schema:write, delete*) must create ai_approvals rows.
- Cache: Tag-based invalidation only.

## Key docs
- docs/en/README.md — full docs map
- docs/en/data-model.md — DB schema
- docs/en/features/ai-copilot.md — AI Copilot internals
- docs/en/api/hono-api-spec.md — REST/WS API spec
```

### Bước 3 — Thêm docs vào ngữ cảnh của Cursor

Trong Cursor Settings (`Cmd+,` → Features → Docs), thêm:

- Index `docs/en/` như một thư mục docs cục bộ, hoặc
- Dán `docs/en/README.md` vào ngữ cảnh Composer khi bắt đầu một task mới.

### Bước 4 — Thiết lập MCP server (tùy chọn)

Thêm vào `.cursor/mcp.json` ở thư mục gốc dự án (tạo mới nếu chưa có):

```json
{
  "mcpServers": {
    "lumibase": {
      "url": "http://localhost:1989/mcp"
    }
  }
}
```

Đặt `LUMIBASE_TOKEN` và `LUMIBASE_SITE_ID` như biến môi trường hoặc trong `.env`.

Khởi động lại Cursor để nạp MCP server. Xác minh qua panel Cursor MCP.

---

## Dùng Composer cho các task LumiBase

Chế độ **Composer** của Cursor (`Cmd+I`) hoạt động tốt cho các task LumiBase đa file:

```
@docs/en/features/flows-automation.md
Add a new "notify-slack" operation type to the Flows engine.
Follow the existing pattern in apps/cms/src/services/flow-service.ts.
Create the operation handler, register it in the operation registry, and add types to packages/shared.
```

```
@docs/en/features/permissions-rbac.md @packages/database/src/schema/
Add a new capability token "reports:read" and wire it through the permissions system.
Update the policy evaluation logic in apps/cms/src/services/permission-service.ts.
```

---

## Background agents

Background agent của Cursor hoạt động tốt cho các task LumiBase dài hơi như:

- Chạy toàn bộ test suite trong khi bạn tiếp tục code
- Sinh các type TypeScript từ schema Drizzle
- Lint và sửa mọi file trong một package

```bash
# Generate types (run in terminal or via background agent)
pnpm -F @lumibase/database db:generate
pnpm -F @lumibase/sdk typegen
```

---

## Mẹo lập chỉ mục codebase

Chỉ mục codebase của Cursor sẽ quét toàn bộ monorepo. Để giúp nó tập trung:

- **Loại trừ** khỏi chỉ mục: `node_modules/`, `.pnpm-store/`, `.wrangler/`, `dist/`, `.turbo/`
- **Ưu tiên bao gồm**: `apps/cms/src/`, `packages/database/src/`, `packages/ai-skills/src/`, `docs/en/`

Cấu hình trong Cursor Settings → Features → Codebase Index.

---

## Xử lý sự cố

**Cursor gợi ý import sai**: Monorepo dùng `pnpm` workspaces. Đảm bảo các đường dẫn TypeScript được cấu hình qua `tsconfig.base.json` ở thư mục gốc.

**MCP server không kết nối được**: Khởi động CMS API trước (`pnpm -F @lumibase/cms dev`), rồi reload kết nối MCP trong Cursor.

**Type Drizzle đã lỗi thời**: Chạy `pnpm -F @lumibase/database db:generate` sau bất kỳ thay đổi schema nào.

---

← [Quay lại Thiết lập Agent](./index.md)
