---
version: 3
lastUpdated: 2026-09-01T19:25:54.624Z
sourceLang: en
translatedFrom: en
sourceHash: 86d3fe673e599c75
mtEngine: manual
syncStatus: human-translated
---

# Windsurf — LumiBase Agent Setup

> **Windsurf** là một IDE dạng agentic với engine ngữ cảnh Cascade và Flows automation cho các task nhiều bước. Do Cognition tạo ra.
>
> **Tags:** IDE · Standalone

---

## Thiết lập nhanh (khuyến nghị)

Mở panel Cascade của Windsurf và dán:

```
Read docs/en/agent-setup/prompt.md and follow all setup instructions.
```

---

## Thiết lập thủ công

### Bước 1 — Mở dự án

Mở thư mục gốc `LumiBase` trong Windsurf.

### Bước 2 — Cấu hình MCP server (tùy chọn)

Thêm vào `~/.codeium/windsurf/mcp_config.json` (lưu ý: dùng `serverUrl`, không phải `url`):

```json
{
  "mcpServers": {
    "lumibase": {
      "serverUrl": "http://localhost:1989/mcp"
    }
  }
}
```

Đặt các auth header qua môi trường shell trước khi khởi động Windsurf:

```bash
export LUMIBASE_TOKEN=<your-access-token>
export LUMIBASE_SITE_ID=<your-site-id>
```

OAuth tự động kích hoạt ở lần dùng tool đầu tiên nếu MCP server hỗ trợ.

Khởi động lại Windsurf để nạp MCP server mới.

### Bước 3 — Nạp ngữ cảnh LumiBase vào Cascade

Trong panel Cascade, bắt đầu với:

```
Read docs/en/README.md for the full docs map.
Read docs/en/data-model.md for the database schema.
Read docs/en/ai-skills.md for AI skill conventions.
Then confirm you understand the LumiBase monorepo structure.
```

---

## Dùng Cascade Flows cho LumiBase

Engine ngữ cảnh Cascade của Windsurf rất tốt cho các thay đổi LumiBase đa file. Dùng **Flows** cho các task dài hơi:

```
Flow: Add realtime notifications to the Flows engine
1. Read docs/en/features/flows-automation.md and docs/en/features/websockets-realtime.md
2. Add a "notify" operation type to the operation registry in apps/cms/src/services/
3. Implement the WebSocket push in the existing realtime service
4. Update types in packages/contracts
5. Run pnpm typecheck to confirm no errors
```

```
Flow: Implement SCIM user provisioning
1. Read docs/en/features/scim-provisioning.md
2. Create the SCIM router at apps/cms/src/routes/scim.ts
3. Implement /scim/v2/Users (GET, POST, PUT, DELETE)
4. Wire multi-tenancy: scope all queries to site_id
5. Write unit tests following the pattern in apps/cms/src/__tests__/
```

---

## Tìm kiếm sâu trong codebase

Tìm kiếm sâu trong codebase của Windsurf hoạt động tốt với monorepo của LumiBase. Các truy vấn hữu ích:

- `"site_id"` — tìm mọi pattern multi-tenancy
- `"withTenant"` — tìm chỗ dùng middleware
- `"ai_approvals"` — tìm mọi điểm tích hợp HITL
- `"CORE_SKILLS"` — tìm AI skill registry

---

## Gợi ý lệnh

Windsurf tự động gợi ý các lệnh terminal. Các lệnh LumiBase thường dùng:

```bash
pnpm install                          # Install all workspace dependencies
pnpm dev                              # Start CMS + Studio + Docs
pnpm -F @lumibase/cms dev             # CMS API only (port 1989)
pnpm -F @lumibase/studio dev          # Studio only (port 2026)
pnpm -F @lumibase/database db:generate   # Regenerate Drizzle types
pnpm typecheck                        # Type-check all packages
pnpm test                             # Run all tests
```

---

## Xử lý sự cố

**Cascade mất ngữ cảnh giữa chừng task**: Dán nội dung `docs/en/README.md` vào đầu các phiên dài để neo ngữ cảnh của Cascade.

**MCP server không khả dụng**: Đảm bảo `apps/cms` đang chạy (`pnpm -F @lumibase/cms dev`) trước khi Windsurf kết nối tới MCP endpoint.

**Lỗi phân giải import**: Monorepo dùng pnpm workspaces. Chạy `pnpm install` từ thư mục gốc nếu các workspace link bị hỏng.

---

← [Quay lại Thiết lập Agent](./index.md)
