---
version: 4
lastUpdated: 2026-11-21T00:04:47.630Z
sourceLang: en
translatedFrom: en
sourceHash: 5e14579546207248
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-21T00:04:47.630Z
codeVerifiedHash: 5e14579546207248
codeVerifiedClaims: 8
---

# Hợp đồng API Page Hydration

Để giải quyết vấn đề "2 lần khứ hồi" (2-roundtrip), CMS cung cấp một điểm cuối BFF (Backend-for-Frontend) dành cho Next.js.

## Điểm cuối: `GET /api/v1/deliver/page/:site_id/:slug`

### Luồng công việc được kích hoạt bởi API:
1. **Lấy cấu hình trang (Fetch Page Config):** Truy xuất bản ghi `pages` khớp với `:slug` và `:site_id`.
2. **Phân tích phụ thuộc (Analyze Dependencies):** Đọc `layoutConfig.sections`. Xác định bộ sưu tập (collection) nào cần thiết (ví dụ: "Phần Hero cần 3 mục mới nhất từ bộ sưu tập `posts`").
3. **Truy xuất song song (Parallel Fetch):** Thực thi các truy vấn Drizzle DB để lấy dữ liệu bộ sưu tập bắt buộc.
4. **Hợp nhất & Phân phối (Merge & Deliver):** Kết hợp cấu hình bố cục (layout) và dữ liệu thành một phản hồi JSON hợp nhất.

Các phần (section) có thể khai báo một nguồn dữ liệu (data source):

```json
{
  "id": "featured-posts-1",
  "component": "PostGrid",
  "data": { "heading": "Featured posts" },
  "source": {
    "collection": "posts",
    "limit": 3,
    "orderBy": "-created_at"
  }
}
```

Trình phân giải phân phối (delivery resolver) giới hạn truy vấn theo `site_id`, chỉ trả các mục đã xuất bản, với mọi dạng layout (`source.status` không bao giờ được dùng), giới hạn `limit` tối đa 50 mục, và hợp nhất các dòng đã điền dữ liệu (hydrated rows) vào `data.items`. Field mã hoá và field được phân loại `pii` hoặc `phi` bị loại khỏi mọi mục: trang là công khai, nên delivery không có người gọi nào để giải mã thay.

Người ghi trang chỉ được gắn `source` vào một collection mà họ đọc được toàn bộ: quyền đọc trên mọi field và không có bộ lọc dòng. Nếu không, `POST /api/v1/pages` và `PATCH /api/v1/pages/:id` trả `403 SOURCE_FORBIDDEN`. Các liên kết mà trang đã có thì không bị kiểm tra lại, nên editor vẫn sửa được trang mà quản trị viên đã gắn vào một collection.

Một `source` không thể đòi bản nháp (#1006). `POST` và `PATCH` từ chối `source.status` khác `published` với `400 VALIDATION`, mỗi section một lỗi kèm đường dẫn `field` (`sections.1.source.status`). Trang đã lưu trước quy tắc này vẫn giữ layout, và delivery bỏ qua status đã lưu, nên không cần migration; lưu lại layout không có status đó thì hết lỗi. `?preview=true` và `?draft=true` trên route công khai chỉ bỏ qua cache: chúng không bao giờ mở bản nháp. Để xem một trang có item chưa xuất bản, đọc nó qua preview token, `GET /api/v1/deliver/preview/:site_id/page/:slug` (xem [visual editing](../features/visual-editing.md)): mỗi source khi đó hiện các item đang live cộng với bản nháp, version hoặc release của token, đọc bằng quyền của người tạo token, và response là `private, no-store`.

### Cấu trúc phản hồi JSON dự kiến:
```json
{
  "page": {
    "title": "Home Page",
    "slug": "home"
  },
  "sections": [
    {
      "id": "hero-section-1",
      "component": "HeroBanner",
      "styleConfig": {
        "variant": "primary",
        "spacing": "large"
      },
      "data": {
        "heading": "Welcome to LumiBase",
        "cta_link": "/about"
      }
    },
    {
      "id": "featured-posts-1",
      "component": "PostGrid",
      "styleConfig": {
        "columns": 3
      },
      "data": {
        "items": [
          { "id": "nano123", "title": "Post 1", "image": "https..." },
          { "id": "nano456", "title": "Post 2", "image": "https..." }
        ]
      }
    }
  ]
}
```
