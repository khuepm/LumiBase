---
version: 1
lastUpdated: 2026-07-08T20:22:25.809Z
sourceLang: en
translatedFrom: en
sourceHash: 051a5ab7df48ac91
mtEngine: claude
syncStatus: machine-translated
---

# Codex — Thiết lập Agent cho LumiBase

> **Codex** là một terminal agent nhẹ, mã nguồn mở, có thể đọc và ghi file, chạy lệnh, và duyệt web trong một sandbox. Do OpenAI tạo ra.
>
> **Tags:** Terminal · Standalone · Cloud · Extension · Open Source

---

## Thiết lập nhanh (khuyến nghị)

```bash
codex "Read docs/en/agent-setup/prompt.md and follow all setup instructions."
```

---

## Thiết lập thủ công

### Bước 1 — Cài đặt Codex

```bash
npm install -g @openai/codex
```

Xác thực:
```bash
export OPENAI_API_KEY=<your-key>
```

### Bước 2 — Di chuyển tới dự án

```bash
cd /path/to/lumibase
```

### Bước 3 — Nạp ngữ cảnh LumiBase

```bash
codex "Read docs/en/README.md and docs/en/data-model.md to understand the LumiBase codebase structure and conventions."
```

### Bước 4 — Tạo một file ngữ cảnh (tùy chọn)

Codex tôn trọng `AGENTS.md` hoặc `codex.md` ở thư mục gốc dự án. Tạo một file:

```bash
cat > AGENTS.md << 'EOF'
# LumiBase agent context

You are working on LumiBase, an Edge-native Headless CMS.

Stack: Hono.js API (apps/cms), React+Vite Studio (apps/studio), PostgreSQL+Drizzle (packages/database), Cloudflare Workers + Docker dual-runtime.

Rules:
- IDs: NanoID or UUIDv7. Never auto-increment serial.
- Multi-tenancy: site_id on every domain table, scoped in every query.
- Runtime: use @lumibase/runtime abstractions, never direct CF KV/R2 bindings.
- AI safety: dangerous skills (schema:write, delete*) must gate through ai_approvals.
- Cache: tag-based invalidation only.

Key docs:
- docs/en/data-model.md
- docs/en/api/hono-api-spec.md
- docs/en/features/ai-copilot.md
- docs/en/features/flows-automation.md
EOF
```

### Bước 5 — Thêm MCP server (tùy chọn)

```bash
codex mcp add lumibase --url http://localhost:1989/mcp
```

Đặt auth qua environment:
```bash
export LUMIBASE_TOKEN=<your-access-token>
export LUMIBASE_SITE_ID=<your-site-id>
```

---

## Ví dụ các phiên Codex

```bash
# Add a new API route
codex "Read docs/en/api/hono-api-spec.md. Add a GET /api/v1/stats endpoint that returns site-level counts for collections, items, users, and files. Scope by site_id."

# Extend the Flows engine
codex "Read docs/en/features/flows-automation.md. Add a 'webhook-verify' operation that validates an HMAC-SHA256 signature on incoming webhook payloads."

# Fix a bug with context
codex "apps/cms/src/services/flow-service.ts has a bug where failed flow_runs are not saving the error message. Read the file and fix it."
```

---

## Chế độ Sandbox

Codex chạy trong một môi trường được sandbox. Đối với phát triển LumiBase:

```bash
# Codex can read/write files and run commands — useful for:
codex "Run pnpm typecheck in packages/database and fix any TypeScript errors."
codex "Generate Drizzle migration SQL for adding a tags column to the flows table."
```

---

## Xử lý sự cố

**Codex không hiểu cấu trúc monorepo**: Trỏ nó tới `docs/en/README.md` trước, file này ánh xạ toàn bộ package và app.

**Lệnh thất bại trong sandbox**: Một số lệnh pnpm workspace cần workspace root. Hãy bảo Codex: "Run this from the project root, not from a subdirectory."

---

← [Quay lại Thiết lập Agent](./index.md)
