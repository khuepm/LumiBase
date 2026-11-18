---
version: 1
lastUpdated: 2026-11-18T06:17:04.462Z
sourceLang: en
translatedFrom: en
sourceHash: cf046ee898a17fad
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-18T06:17:04.462Z
codeVerifiedHash: cf046ee898a17fad
codeVerifiedClaims: 12
---

# Page composer

> Dựng một trang delivery từ các block đã đăng ký, không cần viết code. Đầu ra
> vẫn là JSON `lumibase_pages.layoutConfig` thuần, nên
> `GET /api/v1/deliver/page/:site_id/:slug` không đổi. Epic #667, V06 #684.

**Status:** đã có định dạng layout, kiểm tra khi ghi, API danh sách block và
cấu hình URL preview cho trang. Màn hình composer trong Studio sẽ ra ở một thay
đổi riêng.

## 1. Đăng ký block

Một page block là một collection bình thường, các field của nó là schema của
block (cùng ý tưởng với block template của [dynamic zone](./dynamic-zones.md)).
Đánh dấu nó bằng `meta.pageBlock: true`:

```http
PATCH /api/v1/collections/hero
{ "meta": { "pageBlock": true } }
```

`GET /api/v1/pages/blocks` liệt kê các page block của site cùng field của
chúng. Đây là bảng block của composer. Field ẩn, field mã hoá và field pii/phi
bị loại ra: dữ liệu block được lưu dạng rõ bên trong trang.

## 2. Định dạng layout (v1)

```json
{
  "version": 1,
  "regions": [{ "key": "main" }, { "key": "sidebar", "label": "Sidebar" }],
  "sections": [
    {
      "id": "s1",
      "component": "hero",
      "data": { "title": "Welcome" },
      "styleConfig": { "region": "main" }
    },
    {
      "id": "s2",
      "component": "grid",
      "data": { "heading": "Latest", "cards": [{ "id": "c1", "type": "card", "data": { "label": "One" } }] },
      "styleConfig": { "region": "sidebar", "locales": ["vi"] },
      "source": { "collection": "posts", "limit": 5, "orderBy": "-createdAt" }
    }
  ]
}
```

| Key | Ý nghĩa |
|---|---|
| `version: 1` | Đánh dấu layout của composer; chỉ những layout này được kiểm chặt. |
| `regions` | Các vùng (slot) của trang (mặc định một vùng, `main`). Key không được trùng. |
| `sections[].component` | Một page block đã đăng ký. |
| `sections[].data` | Giá trị field của block đó, được kiểm theo field của nó. Field `blocks` bên trong block lồng thêm block (cây block). |
| `styleConfig.region` | Vùng mà section được hiển thị (mặc định `main`). |
| `styleConfig.locales` | Nếu có, section chỉ hiển thị ở các locale này. |
| `styleConfig.*` | Các key trình bày khác bạn dùng, giữ nguyên. |
| `source` | Liên kết dữ liệu tuỳ chọn, do delivery hydrate: `collection`, `limit` (≤ 50), `orderBy` (`field` hoặc `-field`), `seo`. Chỉ item đã xuất bản. |

Ở `POST /api/v1/pages` và `PATCH /api/v1/pages/:id`, layout v1 bị từ chối với
`400` khi một block chưa đăng ký, dữ liệu block không khớp field của nó (key
lạ, thiếu giá trị bắt buộc, sai kiểu, lỗi ở block lồng nhau), một region chưa
được khai, id section bị trùng, một `source` trỏ tới collection không tồn tại
hoặc đòi thứ khác ngoài item đã xuất bản, hoặc dữ liệu block điền vào field mã
hoá hay pii/phi. Mỗi lỗi có đường dẫn `field` như `sections.1.data.title`.
Layout không có `version` vẫn được lưu nguyên như trước.

## 3. Render

Delivery trả `sections` theo thứ tự với `id`, `component`, `styleConfig` và
`data` (kèm `data.items` cho section có `source`). Lấy các section của một
vùng cho locale hiện tại bằng helper từ `@lumibase/contracts`:

```ts
import { selectPageSections } from '@lumibase/contracts';

const page = await fetch(`${CMS}/api/v1/deliver/page/${siteId}/home`).then((r) => r.json());
const main = selectPageSections(page.sections, { region: 'main', locale: 'vi' });
const sidebar = selectPageSections(page.sections, { region: 'sidebar', locale: 'vi' });
```

Section không có `styleConfig.region` thuộc `main`; section không có
`styleConfig.locales` hiển thị ở mọi locale.

## 4. Preview

Đặt template URL của trang (`pageUrl`, ví dụ
`https://www.example.com/{slug}`) bằng `PUT /api/v1/preview/settings`, để
composer mở được trang ngay cạnh trình soạn. Template theo cùng quy tắc với
[Preview URL](./visual-editing.md) của collection: `http(s)` tuyệt đối, chỉ
placeholder đã biết.
