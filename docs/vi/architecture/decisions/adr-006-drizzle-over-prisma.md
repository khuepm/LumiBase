---
version: 1
lastUpdated: 2026-07-05T10:56:37.166Z
sourceLang: en
translatedFrom: en
sourceHash: e5dad22e7ceea328
mtEngine: claude
syncStatus: machine-translated
---

# ADR-006: Drizzle ORM thay cho Prisma

**Date:** 2024-01-25
**Status:** Accepted

## Context

LumiBase cần một ORM cho PostgreSQL với các yêu cầu sau:

1. **Chạy được trong Cloudflare Workers** — Prisma trong quá khứ đòi hỏi một binary query engine và các API của Node.js; adapter tương thích edge `@prisma/adapter-pg` / `neon` của nó còn ở giai đoạn preview sớm tại thời điểm thiết kế.
2. **Hỗ trợ truy vấn SQL thô / JSONB** — mô hình dữ liệu của LumiBase lưu config field của collection và quy tắc phân quyền dưới dạng JSONB. Các truy vấn phức tạp cần `jsonb_array_elements`, các toán tử tùy chỉnh (`@>`, `?`) và hỗ trợ biểu thức thô.
3. **An toàn kiểu hoàn toàn** — thay đổi schema nên tạo ra lỗi biên dịch TypeScript ở nơi hình dạng truy vấn sai.
4. **Ưu tiên schema và thân thiện với migration** — migration cần được sinh từ thay đổi schema và chạy theo cách có kiểm soát (không tự động áp dụng khi khởi động).

Các framework đã đánh giá:
- **Prisma** — trưởng thành, DX tuyệt vời, nhưng hỗ trợ edge runtime còn chưa ổn định; query engine viết bằng Rust không tương thích với Workers
- **Kysely** — query builder, không phải ORM đầy đủ; không có migration
- **Drizzle** — ưu tiên schema, sinh migration SQL, không có binary query engine, chạy được trong Workers qua chế độ HTTP của `postgres.js`
- **MikroORM** — đặc thù Node.js, không tương thích Workers

## Decision

Dùng **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`) với driver `postgres.js`.

Schema nằm trong `packages/database/src/schema/`, được tổ chức thành các file:
- `core.ts` — sites, settings
- `access.ts` — roles, policies, permissions, users, teams
- `cms.ts` — collections, fields, relations, items, revisions, activity
- `platform.ts` — files, webhooks, extensions, presets, flows, operations
- `ai.ts` — ai_approvals, ai_conversations, ai_messages
- `search.ts` — search indexes

SQL migration được sinh qua `drizzle-kit generate` và áp dụng qua `drizzle-kit migrate`. Migration được commit vào `packages/database/src/migrations/`.

## Consequences

**Tích cực:**
- Không phụ thuộc bên ngoài lúc runtime — không có binary query engine, không biên dịch JIT
- Chạy trong Workers qua `postgres.js` ở chế độ HTTP/WebSocket (tương thích với Hyperdrive)
- Suy luận TypeScript đầy đủ từ schema → kết quả truy vấn
- Kiểm soát SQL chi tiết khi cần (lối thoát `sql<string>`)
- File migration là SQL thuần — có thể review, có thể đảo ngược và triển khai qua CI

**Tiêu cực:**
- Hệ sinh thái kém trưởng thành hơn Prisma — ít tài nguyên cộng đồng và plugin bên thứ ba hơn
- Không có hook soft-delete hay audit tích hợp sẵn (được hiện thực thủ công trong `RevisionService` và `ActivityService`)
- Cú pháp định nghĩa schema dài dòng hơn Prisma (DSL `schema.prisma` cô đọng hơn)
- API relations của Drizzle (cho truy vấn lồng nhau) có đường cong học tập và đôi khi có các trường hợp biên với truy vấn JSONB phức tạp

**Trung tính:**
- `packages/database` xuất cả schema Drizzle lẫn một instance `db` đã định kiểu; các app import từ `@lumibase/database`
