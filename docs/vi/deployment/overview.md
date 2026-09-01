---
version: 1
lastUpdated: 2026-08-02T19:10:07.375Z
sourceLang: en
translatedFrom: en
sourceHash: 36ae5aa938f6c83d
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:10:07.375Z
codeVerifiedHash: 36ae5aa938f6c83d
codeVerifiedClaims: 8
---

# Deployment Overview

LumiBase hỗ trợ hai chế độ triển khai từ cùng một codebase CMS:

- **Cloudflare Workers** cho runtime API tại edge.
- **Docker tự vận hành (self-hosting)** cho các nhóm muốn vận hành toàn bộ stack trong các container.

Để tự vận hành trên cloud quản lý, xem [Google Cloud (single VM)](./google-cloud-vm.md) — cách rẻ nhất để chạy toàn bộ stack Docker trên Google Cloud với Gemini làm nhà cung cấp LLM, trong khi vẫn giữ cho các background job dài hạn của CMS hoạt động.

Trang web tài liệu công khai là một ứng dụng Vite tĩnh được triển khai riêng biệt trên **Cloudflare Pages**.
Trang web Marketplace công khai cũng được triển khai trên **Cloudflare Pages** và đọc danh mục marketplace của CMS tại thời điểm build/revalidation runtime.
**Studio** admin SPA cũng là một ứng dụng Vite tĩnh được triển khai trên **Cloudflare Pages** — xem [Kết nối Studio API](#studio-api-connectivity).

## Studio API connectivity

Studio SPA giao tiếp với CMS qua một URL cơ sở duy nhất được giải quyết bởi `apps/studio/src/lib/api-base.ts` (`getApiBaseUrl()`):

- **Dev / Docker cùng origin (single-origin):** để trống `VITE_API_URL`. Studio sử dụng các request cùng origin — Vite dev server proxy `/api` tới CMS local, và Docker phục vụ Studio từ cùng origin với CMS.
- **Cloudflare Pages (ví dụ `studio.lumibase.dev`):** SPA tĩnh **không có backend đi kèm**, do đó nó phải gọi CMS cross-origin. Đặt `VITE_API_URL` tại thời điểm build thành origin của CMS (ví dụ `https://api.lumibase.dev`). Workflow release kết nối giá trị này từ biến repository `LUMIBASE_CMS_PRODUCTION_URL`.

Vì Studio sau đó gọi CMS từ một origin khác, CMS phải cho phép origin đó qua `CORS_ALLOWED_ORIGINS` (xem `apps/cms/wrangler.toml`). Môi trường production từ chối `*`, vì vậy hãy liệt kê chính xác origin của Studio. Nếu thiếu `VITE_API_URL` trên một triển khai độc lập, Studio sẽ quay về cùng origin và cổng setup hiển thị **"Couldn't reach the server."**

> Các môi trường **dev / staging / demo** thay vào đó phục vụ Studio và CMS từ **một hostname duy nhất** (`<env>.lumibase.dev`), vì vậy `VITE_API_URL` để trống (cùng origin) và không cần CORS. Xem [Shared-domain environments](./shared-domain-environments.md).

## Cloudflare Targets

| Target | Package | Output | Deploy command |
| --- | --- | --- | --- |
| CMS API Worker | `@lumibase/cms` | Worker bundle | `pnpm --filter @lumibase/cms deploy` |
| Documentation site | `@lumibase/docs` | `apps/docs/dist` | `pnpm docs:deploy` |
| Landing site | `@lumibase/landing` | `apps/landing/out` | `pnpm landing:deploy` |
| Marketplace site | `@lumibase/marketplace` | `apps/marketplace/out` | `pnpm marketplace:deploy` |

Chạy lệnh build hoặc dry-run trước khi triển khai:

```bash
pnpm --filter @lumibase/docs build
NEXT_PUBLIC_USE_REAL_API=true NEXT_PUBLIC_CMS_API_URL=https://<cms-production-host> pnpm marketplace:build
pnpm --filter @lumibase/cms build
```

Các URL smoke test Marketplace sau khi triển khai: `/`, `/extensions/`, `/categories/seo/`, và `/extensions/<slug>/`.

## Required Cloudflare Services

CMS Worker có thể chạy chỉ với các biến môi trường cho môi trường phát triển local, nhưng môi trường production yêu cầu các binding Cloudflare được mô tả trong `apps/cms/wrangler.toml`:

- `HYPERDRIVE` cho việc truy cập PostgreSQL có connection pooling.
- `CONFIG_CACHE` cho cache schema, quyền và cài đặt dựa trên KV.
- `MEDIA` cho lưu trữ media R2.
- `SITE_ROOM` Durable Object cho việc phát tán (fan-out) WebSocket realtime theo từng site.
- Cron Triggers cho việc dọn dẹp lưu giữ audit/lần thử đăng nhập theo lịch.

Các secret như `JWT_SECRET`, các giá trị Cloudflare Access và chứng thư database phải được đặt bằng Wrangler secrets hoặc các biến secret quản lý qua dashboard, không commit vào repository.

## Recommended Release Flow

1. Cài đặt các phụ thuộc với `pnpm install`.
2. Chạy `pnpm --filter @lumibase/docs build` cho trang tài liệu.
3. Chạy `pnpm --filter @lumibase/cms build` để dry-run gói Worker.
4. Triển khai tài liệu với `pnpm docs:deploy`.
5. Triển khai CMS Worker với `pnpm --filter @lumibase/cms deploy` sau khi các binding và secret production được cấu hình.

Xem [Cloudflare deployment](./cloudflare.md) để biết các lệnh Worker và Pages chi tiết.
Xem [Private admin path](./private-admin-path.md) để biết chính sách không chuyển hướng ở production giúp giữ bí mật điểm truy cập Studio.
Xem [Multi-tenant deployment topologies](./multi-tenant-topologies.md) để biết cách sắp xếp các cell, database và domain khi một bản triển khai phục vụ nhiều tenant.
