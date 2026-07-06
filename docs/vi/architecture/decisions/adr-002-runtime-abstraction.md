---
version: 1
lastUpdated: 2026-07-05T10:56:37.027Z
sourceLang: en
translatedFrom: en
sourceHash: a71ace1da2c7b5a6
mtEngine: claude
syncStatus: machine-translated
---

# ADR-002: Lớp trừu tượng Runtime cho triển khai kép

**Date:** 2024-02-10
**Status:** Accepted

## Context

LumiBase có hai môi trường triển khai đích với các API cho dịch vụ hạ tầng khác biệt về căn bản:

| Dịch vụ | Cloudflare Workers | Docker / Node.js |
|---------|--------------------|------------------|
| Cache | KV (HTTP, hậu thuẫn bởi CDN toàn cầu) | Redis (ioredis) |
| Lưu trữ đối tượng | R2 (API tương thích S3) | MinIO / S3 |
| Cơ sở dữ liệu | Hyperdrive (bộ gộp kết nối qua Cloudflare) | pg pool (node-postgres) |
| Queue | Cloudflare Queues (dựa trên push, ít nhất một lần) | BullMQ trên Redis |
| Search | MeiliSearch Cloud | MeiliSearch tự host |
| Biến đổi ảnh | Cloudflare Images Resize (tích hợp trong Workers) | Imgproxy (URL đã ký) |

Nếu business logic gọi thẳng `KV.get()`, nó không thể chạy trong Docker. Nếu gọi thẳng `Redis.get()`, nó không thể chạy trên Workers. Mọi dịch vụ sẽ cần hai nhánh ở khắp nơi.

Ngoài ra:
- Đội kỹ thuật muốn có thể kiểm thử business logic trong môi trường Node.js mà không cần binding Cloudflare thật
- Các đích triển khai tương lai (ví dụ Bun, Deno Deploy) nên có thể thêm vào mà không cần viết lại business logic
- Phát triển cục bộ nên hoạt động mà không cần tài khoản Cloudflare thật

## Decision

Tạo một **package trừu tượng runtime** tại `packages/runtime` định nghĩa 6 interface provider:

```typescript
interface CacheProvider { get, set, delete, invalidateByTag, addTag }
interface StorageProvider { upload, download, delete, getUrl, getSignedUrl }
interface DatabaseProvider { query, transaction, pool }
interface SearchProvider { index, search, delete, reindex }
interface QueueProvider { publish, subscribe }
interface MediaProcessor { transform, getTransformUrl }
```

Mỗi interface có hai bản hiện thực adapter: `cloudflare/` và `docker/`.

Một factory `createRuntime(env)` trong `packages/runtime/src/factory.ts` chọn adapter dựa trên `env.LUMIBASE_RUNTIME` (`'cloudflare'` | `'docker'`).

Middleware Hono `withRuntime()` tiêm `RuntimeContext` vào `c.set('runtime', ctx)`. Mọi route và service truy cập provider qua `c.get('runtime').cache`, `c.get('runtime').storage`, v.v.

Business logic trong `apps/cms/src/` không bao giờ import trực tiếp binding Cloudflare hay Redis.

## Consequences

**Tích cực:**
- Business logic khả chuyển 100% — cùng một `ItemService.ts` chạy trên cả Workers và Docker
- Kiểm thử cục bộ có thể dùng adapter mock trong bộ nhớ mà không cần hạ tầng thật
- Thêm một đích triển khai mới (ví dụ Deno Deploy) chỉ đòi hỏi adapter mới
- Phân tách mối quan tâm rõ ràng: business logic so với đấu nối hạ tầng

**Tiêu cực:**
- Lớp trừu tượng thêm vào chi phí ~1 lệnh gọi hàm cho mỗi thao tác cache/storage (không đáng kể trong thực tế)
- Lập trình viên phải hiểu mẫu adapter trước khi debug các vấn đề hạ tầng
- Interface phải được giữ đồng bộ trên cả hai adapter — thiếu một method ở một adapter gây lỗi runtime (được bắt bởi kiểm tra `implements` của TypeScript)

**Trung tính:**
- Một số tính năng đặc thù Cloudflare (Durable Objects cho Realtime, service binding Worker-to-Worker) không thể trừu tượng hóa — chúng nằm trong `apps/cms/src/realtime/` và chỉ kích hoạt ở chế độ `cloudflare`
