# Vision & Định vị LumiBase vs Directus

## 1. Tóm tắt định vị

LumiBase = **Directus DX + Edge-native runtime + Multi-tenant gốc**.

Chúng ta KHÔNG sao chép Directus — chúng ta lấy những gì Directus làm tốt nhất (No-code builder, Permissions chi tiết, Extension SDK, Presets, Translations, Display Templates, Realtime) rồi nâng cấp ở 6 mảng "điểm sáng" mà cộng đồng OSS chưa giải quyết tốt.

## 2. Bảng so sánh điểm sáng

| Mảng | Directus hiện tại | LumiBase mục tiêu | Vũ khí khác biệt |
|---|---|---|---|
| Collection Builder | Form-based, tốt | **Drag-drop + JSON live-preview + AI suggest field** | Bi-directional: UI ↔ JSON schema realtime |
| Field config | Interface + Display + Conditions | + **Per-field validator pipeline (Zod/JSONata)**, **per-field encryption**, **per-field versioning toggle** | Field DSL chuẩn hoá |
| Permissions | Role × Collection × Action + rules | **Role + Policy (attachable) + Field-level + Row-level + Time-bound + IP-bound** | JSON Rule Engine (jsonata/cel) + **policy composition** |
| Raw editor | Có cho 1 số field | **Raw mode bật được cho MỌI field** — kèm schema validate inline | "Toggle raw" là API hợp đồng cố định |
| User mgmt | Cơ bản + Roles | + **Team/Group, Impersonate, Session manager, Device list, Audit per user** | Tích hợp Logto OIDC, SCIM-ready |
| Extension | Hooks/Endpoints/Modules/Interfaces/Displays/Layouts/Panels/Operations | + **Capability-based sandbox** (manifest khai báo quyền), **signed extensions**, **edge-safe runtime** | Permission gate trước hook execution |
| Config | Settings table + env | **Layered config**: env → site → user, hot-reload qua KV, **diff/rollback** | Config-as-Code bidi |
| Bookmarks/Presets | Preset per user/role/collection | + **Shared workspace presets**, **smart preset (saved query + alert)** | Preset có thể subscribe realtime |
| Translations | i18n cho field + UI strings | + **Glossary, MT plug-in (DeepL/OpenAI), per-locale workflow status** | Translation memory store |
| Display Templates | `{{field}}` mustache + Display | + **Component-based templates** (CVA), **conditional slots**, **template inheritance** | Template render edge-side |
| WebSocket | Có (REST-mirror subscribe) | + **Presence**, **collaborative cursors**, **op-based patch (CRDT-lite)** | Cloudflare Durable Objects |

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
