---
sourceLang: en
version: 1
lastUpdated: 2026-11-12T06:32:29.957Z
translatedFrom: en
sourceHash: 35bbb3c580043861
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-12T06:32:29.957Z
codeVerifiedHash: 35bbb3c580043861
codeVerifiedClaims: 4
---

# Data export

Xuất một collection dạng **CSV** hoặc **JSON** từ Studio (**Content → collection →
Export**) hoặc qua API. Bản xuất được truyền theo luồng từng trang, nên kích thước
collection không bị giới hạn bởi bộ nhớ. Chính file đó có thể được đọc lại làm dữ
liệu import, và một vòng export → import → export giữ nguyên mọi giá trị, kể cả bản dịch.

## Endpoint

```
GET /api/v1/items/{collection}/export
```

| Query | Giá trị | Mặc định | Ghi chú |
|-------|---------|----------|---------|
| `format` | `csv`, `json` | `csv` | |
| `fields` | tên trường, phân cách bằng dấu phẩy | mọi trường có lưu giá trị | `id`, `status`, `sort`, `created_at`, `updated_at` luôn được ghi. Trường không tồn tại trả về `400 UNKNOWN_FIELD`. |
| `locales` | các locale, phân cách bằng dấu phẩy | CSV: setting `locales` của site · JSON: mọi locale | Áp dụng cho trường dịch được (interface `translatable-text`). |
| `relations` | `id`, `slug`, `embed` | `id` | Xem [Quan hệ](#quan-hệ). |
| `filter` | JSON hoặc `filter[field][_op]=value` | không có | Cùng cú pháp với endpoint danh sách. |
| `sort` | phân cách bằng dấu phẩy, `-` để giảm dần | `id` | |
| `status` | trạng thái item | mọi trạng thái | |

Phản hồi là một file tải về (`Content-Disposition: attachment; filename="<collection>-<date>.<format>"`,
`Cache-Control: no-store`). Đầu vào sai bị từ chối trước khi gửi byte đầu tiên.
Request dùng quyền `read` của người gọi: luật theo dòng lọc các dòng và luật theo
trường che giá trị, y hệt endpoint danh sách. Mỗi lần export ghi một mục
`items_exported` vào audit log (collection, định dạng, các trường, locale, chế độ
quan hệ, có dùng filter hay không).

```bash
curl -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE" \
  "https://api.example.com/api/v1/items/products/export?format=csv&locales=en,vi" -o products.csv
```

Với SDK:

```ts
const res = await client.items('products').export({ format: 'json', fields: ['title', 'price'] });
const doc = await res.json(); // or pipe res.body to a file
```

## Bố cục CSV

- UTF-8 có byte-order mark, xuống dòng CRLF, đặt ngoặc kép theo RFC 4180.
- Các cột: `id,status,sort,created_at,updated_at`, sau đó mỗi trường một cột.
- Một trường dịch được tách thành mỗi locale một cột: `title.en`, `title.vi`.
- Object và mảng (trường `json`, quan hệ được nhúng) được ghi dưới dạng chuỗi JSON.
- Ô trống là `null`; `""` là chuỗi rỗng.
- Giá trị văn bản bắt đầu bằng `=`, `+`, `-`, `@`, tab, ký tự xuống dòng (carriage
  return) hoặc `'` được ghi thêm một dấu `'` ở đầu, để ứng dụng bảng tính không chạy
  nó như công thức. Khi đọc lại file làm dữ liệu import, dấu `'` đó được bỏ đi.

## Bố cục JSON

```json
{
  "collection": "products",
  "format": "lumibase-export@1",
  "exportedAt": "2026-11-12T08:00:00.000Z",
  "fields": ["title", "price"],
  "locales": null,
  "relations": "id",
  "items": [
    {
      "id": "x8Kq…",
      "status": "published",
      "sort": 1,
      "created_at": "2026-11-01T10:00:00.000Z",
      "updated_at": "2026-11-02T10:00:00.000Z",
      "data": { "title": { "en": "Coffee", "vi": "Cà phê" }, "price": 10.5 }
    }
  ]
}
```

`locales` là `null` khi giữ mọi locale. JSON giữ chính xác kiểu giá trị; CSV khôi
phục số, boolean và JSON dựa theo kiểu trường của collection.

## Quan hệ

| Chế độ | Tác dụng |
|--------|----------|
| `id` | Id khoá ngoại như đã lưu. Dùng chế độ này để import lại. |
| `slug` | Với trường many-to-one, `slug` của item liên quan thay cho id (giữ id khi item liên quan không có slug). |
| `embed` | Thêm bản ghi liên quan dưới alias của quan hệ (`author` cho `author_id`), dạng JSON. Id khoá ngoại vẫn được giữ. |

## Hook cho extension

Extension loại hook có thể biến đổi từng dòng bằng `items.export.before`. Hook nhận
`{ collection, item, itemId, userId, siteId }`, trong đó `item` là bản ghi export
(`{ id, status, sort, created_at, updated_at, data }`). Trả về `{ item }` để thay
dòng đó; ném lỗi sẽ dừng export.

```ts
export default {
  hooks: {
    'items.export.before': async ({ item }) => ({
      item: { ...item, data: { ...item.data, internal_notes: null } },
    }),
  },
};
```

## Import lại

Hiện tại có thể gửi các object `items[].data` của một bản export JSON tới
[bulk endpoint](./data-import.md) với `op: "create"`. Job import chạy nền đọc trực
tiếp cả hai định dạng, có báo tiến độ và báo cáo lỗi theo từng dòng, được theo dõi ở #726.

## Liên quan

- [Data import](./data-import.md)
- [Hono API spec → Items](../api/hono-api-spec.md)
- [Extensions system](./extensions-system.md)
