---
version: 2
lastUpdated: 2026-08-02T19:02:08.528Z
sourceLang: en
translatedFrom: en
sourceHash: f0f9348fb05a5190
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:02:08.528Z
codeVerifiedHash: f0f9348fb05a5190
codeVerifiedClaims: 2
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

Trình phân giải phân phối (delivery resolver) giới hạn truy vấn theo `site_id`, mặc định thành `status: "published"` cho phân phối công khai, giới hạn `limit` tối đa 50 mục, và hợp nhất các dòng đã điền dữ liệu (hydrated rows) vào `data.items`. Chỉ đặt `source.status` khi một trang công khai cố ý cần trạng thái mục khác.

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
