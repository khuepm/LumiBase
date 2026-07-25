---
version: 1
lastUpdated: 2026-07-05T10:56:37.096Z
sourceLang: en
translatedFrom: en
sourceHash: 7dd34abca4670fc2
mtEngine: claude
syncStatus: machine-translated
---

# ADR-004: Vô hiệu hóa cache dựa trên tag

**Date:** 2024-04-05
**Status:** Accepted

## Context

LumiBase cache một số loại dữ liệu đã tính toán:
- **Schema cache** — "virtual schema" được xây từ các bảng `collections` + `fields` + `relations`, dùng bởi mọi truy vấn item để dựng truy vấn Drizzle động
- **Permission cache** — ma trận phân quyền đã đánh giá cho mỗi bộ ba `(site, role, collection)`
- **Settings cache** — cấu hình phạm vi site được đọc ở mỗi request
- **Delivery cache** — các phản hồi page hydration từ `/api/v1/deliver/page/:slug` (phục vụ cho consumer Next.js với revalidate dựa trên tag)

Chỉ riêng cache key là không đủ để vô hiệu hóa:
- Một thay đổi schema ở collection `articles` phải vô hiệu hóa TẤT CẢ mục cache phụ thuộc vào `articles` — bao gồm cả cache relation lồng nhau
- Một cập nhật item trong `articles` phải vô hiệu hóa cache của item cụ thể VÀ mọi cache danh sách có thể chứa nó

Các phương án đã cân nhắc:
1. **Hết hạn dựa trên TTL** — đơn giản nhưng có thể cũ tới N giây; không chấp nhận được với thay đổi schema cần lan truyền tức thì
2. **Liệt kê key dựa trên sự kiện** — xóa mọi key đã biết khi có mutation; mong manh, đòi hỏi theo dõi mọi key đã phát ra
3. **Vô hiệu hóa dựa trên tag** — mỗi mục cache được gắn tag theo các phụ thuộc của nó; một lệnh vô hiệu hóa tag sẽ xóa mọi mục dùng chung tag đó

## Decision

Dùng **vô hiệu hóa cache dựa trên tag** qua interface `CacheProvider`:

```typescript
interface CacheProvider {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { tags?: string[]; ttl?: number }): Promise<void>
  invalidateByTag(tag: string): Promise<void>
}
```

**Quy ước đặt tên tag:**

| Tag | Vô hiệu hóa khi |
|-----|-----------------|
| `schema:{siteId}` | Bất kỳ thay đổi collection/field/relation nào |
| `schema:{siteId}:{collection}` | Schema của một collection cụ thể thay đổi |
| `perm:{siteId}:{roleId}` | Phân quyền của một role thay đổi |
| `item:{siteId}:{collection}:{id}` | Một item cụ thể được cập nhật/xóa |
| `list:{siteId}:{collection}` | Bất kỳ item nào trong collection được tạo/cập nhật/xóa |
| `settings:{siteId}` | Bất kỳ cấu hình site nào thay đổi |
| `page:{siteId}:{slug}` | Một page hoặc các phụ thuộc nội dung của nó thay đổi |

**Adapter Cloudflare:** Dùng KV + một "chỉ mục tag" phụ được lưu dưới key `tag:{tagName}`, chứa một tập các cache key mang tag đó. Khi `invalidateByTag`, đọc chỉ mục, xóa mọi key được liệt kê, rồi xóa chính mục chỉ mục.

**Adapter Docker:** Dùng Redis với mẫu `SADD tag:{tagName} cacheKey` và `SMEMBERS` + `DEL`.

## Consequences

**Tích cực:**
- Vô hiệu hóa cache tức thì khi có mutation — không có cửa sổ dữ liệu cũ
- Chi tiết — thay đổi một item không làm xả toàn bộ cache của site
- Tách rời — các service không cần biết những cache key nào tồn tại; chúng chỉ cần phát một tag
- Hoạt động giống hệt trên cả Cloudflare KV và Redis nhờ lớp trừu tượng

**Tiêu cực:**
- Bản thân chỉ mục tag là một điểm có thể cache miss — nếu chỉ mục cũ, một số mục có thể không được vô hiệu hóa (nhất quán cuối cùng)
- Cloudflare KV có tính nhất quán cuối cùng (~60 giây lan truyền toàn cầu) — một thay đổi schema có thể mất tới 60 giây để vô hiệu hóa trên mọi PoP
- Chi phí ghi cao hơn: mỗi `set` cũng ghi vào chỉ mục tag (2 lần ghi KV thay vì 1)

**Giảm thiểu:**
- Schema cache dùng TTL ngắn (60 giây) như một biện pháp dự phòng chống lại các lần bỏ sót vô hiệu hóa
- Với các thay đổi schema quan trọng, Studio buộc cache-bust qua một lệnh gọi `POST /utils/cache/purge` tường minh
