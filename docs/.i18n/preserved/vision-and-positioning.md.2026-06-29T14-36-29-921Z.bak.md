# Vision & Định vị LumiBase vs Directus

## 1. Tóm tắt định vị

LumiBase = **Directus DX + Edge-native runtime + Multi-tenant gốc**.

Chúng ta KHÔNG sao chép Directus — chúng ta lấy những gì Directus làm tốt nhất (No-code builder, Permissions chi tiết, Extension SDK, Presets, Translations, Display Templates, Realtime) rồi nâng cấp ở 6 mảng "điểm sáng" mà cộng đồng OSS chưa giải quyết tốt.

## 1.1. Comparison Ledger for Marketing

Whenever we design or implement a feature that Directus does not provide as a first-class capability, update the matching feature comparison table. For Permission Builder/RBAC, the primary ledger is [permission-builder-directus-investigation.md](./features/permission-builder-directus-investigation.md#11-bảng-so-sánh-lumibase-vs-directus).

Update rules:

- If the feature matches Directus, mark it as `Parity`.
- If LumiBase solves the same use case with safer or more operationally reliable behavior, mark it as `Improve`.
- If Directus does not provide it first-class, mark it as `New` and phrase the LumiBase column as a reusable marketing claim.
- Do not add a claim without evidence from official docs, the sampled DB, or implementation in this repo.

## 2. Bảng so sánh điểm sáng

### Collection Builder

- **Directus**: Form-based, tốt
- **LumiBase**: Drag-drop + JSON live-preview + AI suggest field
- **Khác biệt**: Bi-directional — UI ↔ JSON schema realtime

### Field Config

- **Directus**: Interface + Display + Conditions
- **LumiBase**: + Per-field validator pipeline (Zod/JSONata),
  per-field encryption, per-field versioning toggle
- **Khác biệt**: Field DSL chuẩn hoá

### Permissions

- **Directus**: Role × Collection × Action + rules
- **LumiBase**: Role + Policy (attachable) + Field-level +
  Row-level + Time-bound + IP-bound
- **Khác biệt**: JSON Rule Engine (jsonata/cel) + policy composition

### Raw Editor

- **Directus**: Có cho 1 số field
- **LumiBase**: Raw mode bật được cho MỌI field — kèm schema validate inline
- **Khác biệt**: "Toggle raw" là API hợp đồng cố định

### User Management

- **Directus**: Cơ bản + Roles
- **LumiBase**: + Team/Group, Impersonate, Session manager,
  Device list, Audit per user
- **Khác biệt**: Tích hợp Logto OIDC, SCIM-ready

### Extension

- **Directus**: Hooks / Endpoints / Modules / Interfaces /
  Displays / Layouts / Panels / Operations
- **LumiBase**: + Capability-based sandbox (manifest khai báo quyền),
  signed extensions, edge-safe runtime
- **Khác biệt**: Permission gate trước hook execution

### Config

- **Directus**: Settings table + env
- **LumiBase**: Layered config — env → site → user,
  hot-reload qua KV, diff/rollback
- **Khác biệt**: Config-as-Code bidi

### Bookmarks / Presets

- **Directus**: Preset per user/role/collection
- **LumiBase**: + Shared workspace presets,
  smart preset (saved query + alert)
- **Khác biệt**: Preset có thể subscribe realtime

### Translations

- **Directus**: i18n cho field + UI strings
- **LumiBase**: + Glossary, MT plug-in (DeepL/OpenAI),
  per-locale workflow status
- **Khác biệt**: Translation memory store

### Display Templates

- **Directus**: `{{field}}` mustache + Display
- **LumiBase**: + Component-based templates (CVA),
  conditional slots, template inheritance
- **Khác biệt**: Template render edge-side

### WebSocket

- **Directus**: Có (REST-mirror subscribe)
- **LumiBase**: + Presence, collaborative cursors,
  op-based patch (CRDT-lite)
- **Khác biệt**: Cloudflare Durable Objects

## 3. Non-goals

- Không tự build IdP — dùng **Logto** (OIDC).
- Không làm GUI workflow engine v1 — để Phase 2 (Operations/Flows).
- Không hỗ trợ MySQL/SQLite ở MVP — chỉ Postgres (Hyperdrive).

## 4. Personas

- **Site Admin**: thiết lập collections, roles, policies, extensions.
- **Editor**: tạo/chỉnh nội dung, dùng preset, bookmark, translation.
- **Developer**: viết extension, dùng API, định nghĩa display templates.
- **End-user (Delivery)**: tiêu thụ qua REST/GraphQL/WS từ Next.js demo.

## 5. KPIs kỹ thuật

- p95 Delivery API < 80ms ở edge.
- Studio TTI < 2s với 1k collections.
- Permission check < 1ms (KV cache hit) / < 15ms (cold).
- WebSocket fan-out < 200ms toàn cầu (Durable Objects regional).
