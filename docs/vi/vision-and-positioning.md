# Tầm nhìn & Định vị LumiBase so với Directus

## 1. Tóm tắt định vị

LumiBase = **Directus DX + Edge-native runtime + Multi-tenant gốc**.

Chúng ta KHÔNG sao chép Directus — chúng ta lấy những gì Directus làm tốt nhất (No-code builder, Permissions chi tiết, Extension SDK, Presets, Translations, Display Templates, Realtime) rồi nâng cấp ở 6 mảng "điểm sáng" mà cộng đồng OSS chưa giải quyết tốt.

## 2. Bảng so sánh điểm sáng

| Mảng | Directus hiện tại | LumiBase mục tiêu | Vũ khí khác biệt |
|---|---|---|---|
| Collection Builder | Form-based, tốt | **Drag-drop + JSON live-preview + AI gợi ý field** | Hai chiều: UI ↔ JSON schema realtime |
| Cấu hình Field | Interface + Display + Conditions | + **Pipeline validator per-field (Zod/JSONata)**, **mã hoá per-field**, **toggle versioning per-field** | Field DSL chuẩn hoá |
| Phân quyền | Role × Collection × Action + rules | **Role + Policy (gắn được) + Field-level + Row-level + Giới hạn thời gian + Giới hạn IP** | JSON Rule Engine (jsonata/cel) + **policy composition** |
| Raw editor | Có cho một số field | **Raw mode bật được cho MỌI field** — kèm schema validate inline | "Toggle raw" là API hợp đồng cố định |
| Quản lý người dùng | Cơ bản + Roles | + **Team/Group, Impersonate, Session manager, Danh sách thiết bị, Audit per user** | Tích hợp Logto OIDC, SCIM-ready |
| Extension | Hooks/Endpoints/Modules/Interfaces/Displays/Layouts/Panels/Operations | + **Sandbox dựa trên Capability** (manifest khai báo quyền), **signed extensions**, **edge-safe runtime** | Permission gate trước hook execution |
| Cấu hình | Settings table + env | **Layered config**: env → site → user, hot-reload qua KV, **diff/rollback** | Config-as-Code hai chiều |
| Bookmarks/Presets | Preset per user/role/collection | + **Shared workspace presets**, **smart preset (saved query + alert)** | Preset có thể subscribe realtime |
| Bản dịch | i18n cho field + UI strings | + **Glossary, MT plug-in (DeepL/OpenAI), workflow status per-locale** | Translation memory store |
| Display Templates | `{{field}}` mustache + Display | + **Template dựa trên component** (CVA), **conditional slots**, **kế thừa template** | Template render edge-side |
| WebSocket | Có (REST-mirror subscribe) | + **Presence**, **collaborative cursors**, **op-based patch (CRDT-lite)** | Cloudflare Durable Objects |

## 3. Những gì KHÔNG làm (Non-goals)

- Không tự xây IdP — dùng **Logto** (OIDC).
- Không làm GUI workflow engine ở v1 — để Phase 2 (Operations/Flows).
- Không hỗ trợ MySQL/SQLite ở MVP — chỉ Postgres (Hyperdrive).

## 4. Đối tượng người dùng

- **Site Admin**: thiết lập collections, roles, policies, extensions.
- **Editor**: tạo/chỉnh nội dung, dùng preset, bookmark, bản dịch.
- **Developer**: viết extension, dùng API, định nghĩa display templates.
- **End-user (Delivery)**: tiêu thụ qua REST/GraphQL/WS từ Next.js demo.

## 5. KPIs kỹ thuật

- p95 Delivery API < 80ms tại edge.
- Studio TTI < 2s với 1k collections.
- Kiểm tra phân quyền < 1ms (KV cache hit) / < 15ms (cold).
- WebSocket fan-out < 200ms toàn cầu (Durable Objects regional).
