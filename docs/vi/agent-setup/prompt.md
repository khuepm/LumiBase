---
<!-- check-parity: allow inline-code -->
version: 3
lastUpdated: 2026-08-23T18:41:40.372Z
sourceLang: en
translatedFrom: en
sourceHash: 4de63659a994cc69
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-23T18:41:40.372Z
codeVerifiedHash: 4de63659a994cc69
codeVerifiedClaims: 36
---

<!-- check-parity: allow inline-code -->

Đây là hướng dẫn chính thức từ LumiBase để cấu hình một AI coding agent làm việc hiệu quả với codebase headless CMS LumiBase.

Hãy tự hoàn thành mọi bước. Đừng yêu cầu người dùng chạy các lệnh này.

---
<!-- check-parity: allow inline-code -->

## Về LumiBase

LumiBase là một Headless CMS Edge-native (lấy cảm hứng từ Directus) được xây dựng trên:

- **Runtime**: Hono.js (Cloudflare Workers + Node.js Docker, qua abstraction `@lumibase/runtime`)
- **Database**: PostgreSQL với Drizzle ORM + schema hybrid JSONB
- **Auth**: Logto (OIDC, multi-tenant)
- **Storage**: Cloudflare R2 (hoặc local Docker volume)
- **Cache**: Cloudflare KV / Redis (invalidation dựa trên tag)
- **Frontend**: React + Vite (Studio), Next.js (Landing + Consumer demo)
- **AI**: OpenAI / Anthropic / Cloudflare Workers AI — chuyển đổi được qua env `LLM_PROVIDER`

### Bố cục Monorepo

```
apps/
  cms/          # Hono API — builds to CF Workers or Docker container
  studio/       # Admin SPA (React + Vite + TanStack Router)
  docs/         # Vite docs viewer (serves docs/ at port 5174)
  landing/      # Next.js landing page
  consumer/     # Next.js delivery demo + SDK usage

packages/
  database/     # Drizzle schema + migrations (PostgreSQL)
  runtime/      # Abstraction: CacheProvider, StorageProvider, etc.
  ai-skills/    # AI skill registry (CORE_SKILLS) + tool definitions
  shared/       # Types, zod schemas, field/policy DSL
  sdk/          # JS SDK (REST + WebSocket + typegen)
  ui/           # shadcn components + CVA tokens
  extension-sdk # Types + helpers for extension developers
```

---
<!-- check-parity: allow inline-code -->

## Quy ước nghiêm ngặt — luôn tuân theo

1. **IDs**: Không bao giờ dùng serial/auto-increment. Luôn dùng NanoID (URL ngắn) hoặc UUIDv7.
2. **Multi-tenancy**: Mọi domain table đều có `site_id`. Mọi query đều scope theo `WHERE site_id = :siteId`.
3. **Edge-friendliness**: Business logic phải đi qua các abstraction `@lumibase/runtime` — không dùng trực tiếp binding Cloudflare KV/R2 trong app code.
4. **API 1-roundtrip**: Các endpoint Studio và delivery trả về payload đã tổng hợp — tránh pattern N+1.
5. **HITL cho các hành động AI nguy hiểm**: Các skill yêu cầu `schema:write` hoặc `delete*` phải tạo một row `ai_approvals` và chờ human approval trước khi thực thi.
6. **Config-as-code**: Collection, field, và permission có thể xuất/nhập dưới dạng JSON/YAML (`apps/cms/scripts/config-cli.ts`).
7. **Cache tagging**: Khi dữ liệu thay đổi, invalidate mọi cache key được tag với entity đó.
8. **Endpoint deprecation (chỉ gắn khi khai tử)**: `withDeprecation` trong `apps/cms/src/middleware/deprecation.ts` là helper RFC 8594 tái sử dụng. **Không** gắn lên endpoint đang sống bình thường. Chỉ gắn khi có chỉ thị rõ ràng deprecate / retire / sunset một route (hoặc router) cụ thể. Để unwired khi chưa có API nào bị khai tử là đúng.
9. **Docs song ngữ (EN ↔ VI)**: Mọi sửa dưới `docs/en/` hoặc `docs/vi/` phải cập nhật locale còn lại trong **cùng PR** khi đã có counterpart (hoặc tạo counterpart mới). Ưu tiên sync thừa hơn thiếu. Sau khi cặp đã dịch 1-1 đủ, chạy `pnpm docs:i18n:verify` + `stamp-pair.mjs` để version/provenance khớp. Xem `.kiro/steering/definition-of-done.md` §4a.

### Khi có chỉ thị deprecate một endpoint

1. Import `withDeprecation` từ `apps/cms/src/middleware/deprecation.ts`.
2. Gắn **chỉ** vào route/sub-router sắp gỡ (không gắn vào chuỗi middleware global của app).
3. Nên truyền đủ ngày + `link` changelog để client có cửa sổ migrate:

```typescript
import { withDeprecation } from '../middleware/deprecation'

// Gắn CHỈ vào route/router sắp gỡ — không gắn global
legacyRouter.use('*', withDeprecation({
  since: '2026-08-01',
  sunset: '2026-11-01',
  link: 'https://docs.lumibase.dev/changelog#items-legacy',
}))
```

Header phát ra: `Deprecation` (HTTP-date hoặc `true`), optional `Sunset`, optional `Link rel="deprecation"`. Mọi option đều optional — bỏ ngày thì chỉ có `Deprecation: true`. Ghi changelog; nếu có consumer FE, xem hướng dẫn trong `docs/vi/tutorials/nextjs-quickstart.md` mục Production & security notes.

---
<!-- check-parity: allow inline-code -->

## Các API endpoint chính

Base URL: `https://<your-site>.lumibase.dev` (hoặc `http://localhost:1989` khi chạy local)

Mọi request đều yêu cầu:
- `Authorization: Bearer <access_token>`
- Header `X-Site-Id: <siteId>` (hoặc phân giải qua subdomain)

### Items (CRUD)
```
GET    /api/v1/items/:collection          # List items
POST   /api/v1/items/:collection          # Create item
GET    /api/v1/items/:collection/:id      # Get item
PATCH  /api/v1/items/:collection/:id      # Update item
DELETE /api/v1/items/:collection/:id      # Delete item
```

### Schema
```
GET    /api/v1/collections                # List collections
POST   /api/v1/collections                # Create collection
GET    /api/v1/fields/:collection         # List fields
POST   /api/v1/fields/:collection         # Create field
```

### Flows / Automation
```
GET    /api/v1/flows                      # List flows
POST   /api/v1/flows/:id/run              # Manually trigger a flow
GET    /api/v1/flows/:id/runs             # Execution history
```

### AI Copilot
```
POST   /api/v1/ai/chat                    # Natural language → skill execution
GET    /api/v1/ai/approvals               # List pending HITL approvals
POST   /api/v1/ai/approvals/:id/decide    # Approve or reject
```

### Files
```
POST   /api/v1/files                      # Upload asset (multipart/form-data)
GET    /api/v1/files/:id                  # File metadata
```

### Auth / Users
```
POST   /api/v1/auth/login                 # Username/password login
POST   /api/v1/auth/refresh               # Refresh access token
GET    /api/v1/users                      # List users
POST   /api/v1/users                      # Create user
```

Spec đầy đủ: `docs/en/api/hono-api-spec.md`

---
<!-- check-parity: allow inline-code -->

## Chỉ mục Docs

Các file tài liệu chính:

- `docs/en/README.md` — bản đồ docs đầy đủ
- `docs/en/data-model.md` — tham chiếu database schema
- `docs/en/features/ai-copilot.md` — nội bộ AI Copilot (HITL, skills, LLM providers)
- `docs/en/ai-skills.md` — định nghĩa AI skill và system prompt
- `docs/en/features/flows-automation.md` — engine Flows / Operations
- `docs/en/features/permissions-rbac.md` — role, policy, permission cấp field
- `docs/en/features/websockets-realtime.md` — subscribe/publish realtime qua WebSocket
- `docs/en/architecture/overview.md` — tech stack, layer, runtime abstraction
- `docs/en/deployment/overview.md` — Cloudflare Workers, Cloudflare Pages, Docker
- `docs/en/deployment/environment-variables.md` — tất cả env var và binding

---
<!-- check-parity: allow inline-code -->

## Phát triển cục bộ

```bash
# Install dependencies
pnpm install

# Start all services (CMS API + Studio + Docs)
pnpm dev

# CMS API runs at:   http://localhost:1989
# Studio runs at:    http://localhost:2026
# Docs run at:       http://localhost:5174
```

Sao chép `.env.example` thành `.env` và điền các giá trị bắt buộc (xem `docs/en/deployment/environment-variables.md`).

---
<!-- check-parity: allow inline-code -->

## Hệ thống skill của AI Copilot

AI Copilot dùng một skill registry trong `packages/ai-skills/src/skills.ts`. Mỗi skill có:

- `name` + `description` — dùng cho LLM tool calling
- `parameters` — JSON Schema (tương thích OpenAI)
- `requiredCapabilities` — ví dụ `['schema:write']`, `['items:read']`

**Skill an toàn** (thực thi trực tiếp): `listCollections`, `listItems`, `createItem`, `updateItem`

**Skill nguy hiểm** (yêu cầu HITL approval): `createCollection`, `deleteCollection`, `createField`, `deleteField`, `deleteItem`

Gọi `getAISkillsAsTools()` từ `packages/ai-skills` để lấy danh sách tool function-calling của OpenAI.

---
<!-- check-parity: allow inline-code -->

## Hệ thống Permissions

LumiBase dùng một engine luật policy dạng JSON:

- **Role** → gán cho user
- **Policy** → gắn vào role, chứa các luật permission
- **Permission** → `{ collection, action, fields?, conditions? }`
- **Capability** — các token dạng chuỗi (`schema:write`, `items:read`, `flows:execute`, v.v.)

Wildcard `'*'` trong capability thỏa mãn mọi yêu cầu.

---
<!-- check-parity: allow inline-code -->

Hướng dẫn này được publish tại `docs/en/agent-setup/prompt.md`.
