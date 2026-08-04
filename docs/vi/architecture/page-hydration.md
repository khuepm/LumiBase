---
version: 1
lastUpdated: 2026-08-04T22:01:12.048Z
sourceLang: en
translatedFrom: en
sourceHash: f0f9348fb05a5190
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-04T22:01:12.048Z
codeVerifiedHash: f0f9348fb05a5190
codeVerifiedClaims: 2
---

# Hợp đồng API Page Hydration

Để giải quyết vấn đề "2-roundtrip", CMS cung cấp một endpoint BFF (Backend-for-Frontend) cho Next.js.

## Endpoint: `GET /api/v1/deliver/page/:site_id/:slug`

### Luồng xử lý mà API kích hoạt:
1. **Lấy cấu hình page:** Truy xuất record `pages` khớp với `:slug` và `:site_id`.
2. **Phân tích dependency:** Đọc `layoutConfig.sections`. Xác định những collection nào cần dùng (ví dụ "Hero section cần 3 item mới nhất từ collection `posts`").
3. **Fetch song song:** Chạy các query Drizzle DB để lấy dữ liệu collection cần thiết.
4. **Gộp & trả về:** Kết hợp cấu hình layout và dữ liệu thành một response JSON hợp nhất.

Mỗi section có thể khai báo một nguồn dữ liệu:

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

Delivery resolver scope query theo `site_id`, mặc định
`status: "published"` cho public delivery, kẹp `limit` xuống tối đa 50 item, và
gộp các dòng đã hydrate vào `data.items`. Chỉ đặt `source.status` khi một
public page thật sự cần một item status khác.

### Cấu trúc JSON response mong đợi:
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
