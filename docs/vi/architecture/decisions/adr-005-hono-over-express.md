---
version: 1
lastUpdated: 2026-07-05T10:56:37.131Z
sourceLang: en
translatedFrom: en
sourceHash: 872eb1bddf553837
mtEngine: claude
syncStatus: machine-translated
---

# ADR-005: Hono.js thay cho Express / Elysia

**Date:** 2024-01-20
**Status:** Accepted

## Context

LumiBase cần một web framework cho CMS API (`apps/cms`) mà:

1. **Chạy trên Cloudflare Workers** — đích triển khai chính. Workers dùng API `Request`/`Response` theo chuẩn Web, không phải `http.IncomingMessage`/`ServerResponse` của Node.js. Express, Fastify và NestJS phụ thuộc vào API của Node.js và không thể chạy trên Workers nếu không có shim.

2. **Cũng chạy trên Node.js / Docker** — cho các triển khai tự host. Cùng một codebase phải phục vụ được cả hai đích.

3. **Hỗ trợ TypeScript tốt** — phân quyền cấp field, tích hợp Drizzle và các kiểu middleware phức tạp đòi hỏi typing mạnh.

4. **Nhẹ** — Workers có giới hạn bundle nén 1MB. Các framework đầy đủ với nhiều tính năng tích hợp sẵn làm tăng đáng kể kích thước bundle.

Các framework đã đánh giá:
- **Express** — không tương thích với Workers (đặc thù Node.js)
- **Fastify** — không tương thích Workers nếu không có shim nặng
- **NestJS** — quá lớn, không tương thích Workers
- **Elysia** — ưu tiên Bun, khả năng tương thích Workers còn hạn chế và thử nghiệm
- **Hono** — thiết kế theo chuẩn web, chạy trên Workers + Bun + Deno + Node.js + Cloudflare Pages

## Decision

Dùng **Hono.js** làm web framework.

Hai điểm vào trong `apps/cms/src/`:
- `index.ts` → `export default app` (Cloudflare Workers / Wrangler)
- `serve.ts` → `serve(app, { port })` qua `@hono/node-server` (Node.js / Docker)

Toàn bộ code router và middleware nằm trong các file dùng chung, chỉ import từ lõi `hono`.

## Consequences

**Tích cực:**
- Một codebase duy nhất chạy trên cả Workers và Node.js mà không cần thay đổi
- Bundle nhỏ — lõi Hono khoảng ~13KB sau minify+gzip
- Generics TypeScript tuyệt vời cho các kiểu context (`c.get('runtime')`, `c.get('user')`)
- Được bảo trì tích cực, cộng đồng tốt, hệ sinh thái đang phát triển
- Tương thích với các API chuẩn Web (`Request`, `Response`, `Headers`, `URLSearchParams`)

**Tiêu cực:**
- Hệ sinh thái nhỏ hơn Express — ít package middleware có sẵn hơn; một số phải viết tùy chỉnh (ví dụ upload file multipart cho Workers)
- RPC client của Hono (`hc<>`) hữu ích nhưng làm tăng độ phức tạp nếu áp dụng
- Tài liệu ít đầy đủ hơn Express cho các mẫu nâng cao

**Trung tính:**
- `@hono/zod-validator` được dùng để validate request (khớp tốt với các schema zod của chúng ta trong `packages/contracts`)
