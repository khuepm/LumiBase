---
version: 1
lastUpdated: 2026-06-23T13:05:48.000Z
sourceLang: vi
contentHash: bd0ba5b5bf9cfe5f
---

# Tầm nhìn & Định vị LumiBase so với Directus

## 1. Tóm tắt định vị

LumiBase = **Directus DX + Edge-native runtime + Multi-tenant gốc + Agent Harness Layer**.

Chúng ta KHÔNG sao chép Directus — chúng ta lấy những gì Directus làm tốt nhất (No-code builder, Permissions chi tiết, Extension SDK, Presets, Translations, Display Templates, Realtime, Flows/Automation, database-first API) rồi nâng cấp theo hướng **AI-native backend operating system**: nơi con người, agent, data, workflow và application cùng tiến hoá có kiểm soát.

## 1.1. Comparison Ledger cho marketing

Mỗi khi thiết kế hoặc implement một tính năng mà Directus chưa có first-class, phải cập nhật bảng so sánh tương ứng trong tài liệu feature. Với Permission Builder/RBAC, ledger chính nằm ở [permission-builder-directus-investigation.md](./features/permission-builder-directus-investigation.md#11-bảng-so-sánh-lumibase-vs-directus).

Quy tắc cập nhật:

- Nếu tính năng là parity với Directus, ghi `Parity`.
- Nếu cùng use case nhưng LumiBase làm an toàn hơn hoặc vận hành tốt hơn, ghi `Improve`.
- Nếu Directus chưa có first-class, ghi `New` và mô tả thành marketing claim có thể dùng lại.
- Không ghi claim nếu chưa có bằng chứng từ docs chính thức, DB mẫu, hoặc implementation trong repo.


## 1.2. Luận điểm AI-native

Directus mạnh vì biến database thành CMS/API có quản trị tốt cho con người. LumiBase phải đi xa hơn: biến CMS thành **control plane cho AI Agent**. Agent không được “tự do bay lung tung”; agent hoạt động trong harness gồm goal, context, plan, tool calls, validation, approval, artifact commit và audit trail.

Định nghĩa sản phẩm:

> LumiBase is not just a CMS where humans manage content. It is a structured operating layer where humans, agents, data, workflows, and applications co-evolve.

Ba tầng chiến lược:

1. **CMS Layer** — schema, content, users, roles, policies, files, revisions, activity.
2. **Agent Harness Layer** — goals, runs, plans, tools, memory, approvals, evaluations, permissions, audit.
3. **App Generation Layer** — agent dùng schema/content để sinh page, component, dataset, config, prompt, migration, API spec và automation.

Xem blueprint chi tiết ở [Agent Harness Layer](./features/agent-harness-layer.md).

## 2. Bảng so sánh điểm sáng

### Collection Builder

- **Directus**: Form-based, tốt
- **LumiBase**: Drag-drop + JSON live-preview + AI gợi ý field
- **Khác biệt**: Hai chiều — UI ↔ JSON schema realtime

### Cấu hình Field

- **Directus**: Interface + Display + Conditions
- **LumiBase**: + Pipeline validator per-field (Zod/JSONata),
  mã hoá per-field, toggle versioning per-field
- **Khác biệt**: Field DSL chuẩn hoá

### Phân quyền

- **Directus**: Role × Collection × Action + rules
- **LumiBase**: Role + Policy (gắn được) + Field-level +
  Row-level + Giới hạn thời gian + Giới hạn IP
- **Khác biệt**: JSON Rule Engine (jsonata/cel) + policy composition

### Raw Editor

- **Directus**: Có cho một số field
- **LumiBase**: Raw mode bật được cho MỌI field — kèm schema validate inline
- **Khác biệt**: "Toggle raw" là API hợp đồng cố định

### Quản lý người dùng

- **Directus**: Cơ bản + Roles
- **LumiBase**: + Team/Group, Impersonate, Session manager,
  Danh sách thiết bị, Audit per user
- **Khác biệt**: Tích hợp Logto OIDC, SCIM-ready

### Extension

- **Directus**: Hooks / Endpoints / Modules / Interfaces /
  Displays / Layouts / Panels / Operations
- **LumiBase**: + Sandbox dựa trên Capability (manifest khai báo quyền),
  signed extensions, edge-safe runtime
- **Khác biệt**: Permission gate trước hook execution

### Cấu hình

- **Directus**: Settings table + env
- **LumiBase**: Layered config — env → site → user,
  hot-reload qua KV, diff/rollback
- **Khác biệt**: Config-as-Code hai chiều

### Bookmarks / Presets

- **Directus**: Preset per user/role/collection
- **LumiBase**: + Shared workspace presets,
  smart preset (saved query + alert)
- **Khác biệt**: Preset có thể subscribe realtime

### Bản dịch

- **Directus**: i18n cho field + UI strings
- **LumiBase**: + Glossary, MT plug-in (DeepL/OpenAI),
  workflow status per-locale
- **Khác biệt**: Translation memory store

### Display Templates

- **Directus**: `{{field}}` mustache + Display
- **LumiBase**: + Template dựa trên component (CVA),
  conditional slots, kế thừa template
- **Khác biệt**: Template render edge-side

### WebSocket

- **Directus**: Có (REST-mirror subscribe)
- **LumiBase**: + Presence, collaborative cursors,
  op-based patch (CRDT-lite)
- **Khác biệt**: Cloudflare Durable Objects

### Agent Harness

- **Directus**: Có nền tảng CMS/API/Flows/Extensions để automation chạy quanh dữ liệu
- **LumiBase**: + First-class agent goals, runs, tools, memory, approvals, evaluations và artifact store
- **Khác biệt**: Agent bị điều khiển bởi harness: quyền đến từ policy snapshot, hành động rủi ro cần HITL, output được version/evaluate trước khi commit

### App Generation

- **Directus**: Chủ yếu quản trị data/API để developer hoặc integration tiêu thụ
- **LumiBase**: + Agent đọc schema/content/policy để sinh storefront, dashboard, workflow, API docs, seed data, migration
- **Khác biệt**: CMS trở thành nguồn sự thật để agent tạo business software có kiểm soát

## 3. Những gì KHÔNG làm (Non-goals)

- Không tự xây IdP — dùng **Logto** (OIDC).
- Không làm GUI workflow engine ở v1 — để Phase 2 (Operations/Flows).
- Không hỗ trợ MySQL/SQLite ở MVP — chỉ Postgres (Hyperdrive).

## 4. Đối tượng người dùng

- **Site Admin**: thiết lập collections, roles, policies, extensions, agent goals và approval policies.
- **Editor**: tạo/chỉnh nội dung, dùng preset, bookmark, bản dịch.
- **Developer**: viết extension/tool, dùng API, định nghĩa display templates và review generated artifacts.
- **Agent Operator**: tạo goal, theo dõi run, phê duyệt plan/artifact, xem eval/audit.
- **End-user (Delivery)**: tiêu thụ qua REST/GraphQL/WS từ Next.js demo.

## 5. KPIs kỹ thuật

- p95 Delivery API < 80ms tại edge.
- Studio TTI < 2s với 1k collections.
- Kiểm tra phân quyền < 1ms (KV cache hit) / < 15ms (cold).
- WebSocket fan-out < 200ms toàn cầu (Durable Objects regional).
- 100% agent runs có goal, plan/tool-call log, approval/evaluation state và artifact hash khi tạo output.
