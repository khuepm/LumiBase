---
sourceLang: en
version: 1
lastUpdated: 2026-11-19T06:34:14.857Z
translatedFrom: en
sourceHash: 79e001eacf6a5421
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T06:34:14.857Z
codeVerifiedHash: 79e001eacf6a5421
codeVerifiedClaims: 16
---

# Nhập từ Figma: từ một frame thành một block

Chỉ cho LumiBase một frame Figma, nó tạo ra một **block template**: một
collection ẩn có các trường lấy từ các layer của frame, kèm display template.
Thêm nó vào một trường `blocks` là biên tập viên dùng được ngay trong Studio
(#758, epic #677). Màu và bo góc của frame cũng được ánh xạ sang các token
theme của Studio, và một agent có thể áp dụng chúng sau khi được duyệt.

Bản thân block được mô tả trong [Dynamic zones](./dynamic-zones.md).

## 1. Lưu token Figma

Tạo một personal access token trong Figma (Settings → Security → Personal
access tokens, scope *File content: read*), rồi lưu cho site:

```http
PUT /api/v1/integrations/figma/token
{ "token": "figd_…" }
```

Nó được giữ dưới dạng tool secret mã hoá `FIGMA_TOKEN` của site, trong cùng kho
mà các tool của agent dùng, và không bao giờ được trả về.
`GET /api/v1/integrations/figma` trả `{ hasToken }`;
`DELETE /api/v1/integrations/figma/token` xoá nó. Việc lưu cần key provider của
deployment.

## 2. Xem trước ánh xạ

Trong Figma, chọn frame và dùng *Copy link to selection*. Sau đó:

```http
POST /api/v1/integrations/figma/preview
{ "url": "https://www.figma.com/design/<file>/<name>?node-id=12-34" }
```

Kết quả là bản nháp (`collection`, `label`, `fields`, `displayTemplate`,
`tokens`, `theme`, `warnings`, `source`). Không ghi gì cả.

### Layer thành trường như thế nào

- Nếu có layer nào trong frame được đặt tên `#something`, **chỉ** những layer
  đó được ánh xạ, và `something` là tên trường. Đây là cách kiểm soát kết quả.
- Nếu không, mọi layer chữ đang hiện và mọi layer có fill ảnh đều được ánh xạ,
  theo tên layer.
- Một layer chữ trở thành:
  - `string` với interface `input` cho một dòng tối đa 80 ký tự;
  - `text` với `input-multiline` cho mọi thứ dài hơn.

  Đoạn chữ trong Figma trở thành ghi chú của trường.
- Một layer chữ có tên, hoặc nằm trong layer có tên, `button`, `btn`, `cta`
  hoặc `link` sẽ có thêm trường `<name>_url` cho đích liên kết.
- Một layer có fill ảnh trở thành trường `file`.
- Tên được chuyển sang snake_case. `id`, `status`, `sort` và các tên dành riêng
  khác được thêm tiền tố `f_`, tên trùng được thêm `_2`, `_3`…. Tối đa 40
  trường; phần còn lại được liệt kê trong `warnings`. Layer ẩn bị bỏ qua.
- Collection là `block_<frame name>` trừ khi bạn truyền `collection`, và display
  template là `{{<first single-line text field>}}` (trường chữ một dòng đầu tiên).

## 3. Nhập

```http
POST /api/v1/integrations/figma/import
{
  "url": "https://www.figma.com/design/<file>/<name>?node-id=12-34",
  "collection": "block_hero",
  "addToBlocksField": { "collection": "landing_pages", "field": "sections" }
}
```

Lệnh này tạo collection (`hidden`, icon `widgets`) và các trường của nó trong
một transaction. Nguồn gốc được ghi trong `meta.figma`. Với `addToBlocksField`,
block còn được thêm vào `allowedBlocks` của trường `blocks` đó, để biên tập viên
thêm được ngay.

Nó trả `409 COLLECTION_EXISTS` thay vì sửa một collection đã có, và
`404 BLOCKS_FIELD_NOT_FOUND` khi đích không phải trường `blocks`. Lỗi Figma được
ánh xạ thành `422 FIGMA_TOKEN_REJECTED`, `404 FIGMA_NOT_FOUND`,
`422 FIGMA_NOT_A_FRAME`, `429 FIGMA_RATE_LIMITED`, `502 FIGMA_UNAVAILABLE`, và
một liên kết không phải liên kết frame Figma thành `400 FIGMA_URL_INVALID`.

## 4. Design token và theme của Studio

`tokens` của bản xem trước liệt kê:

- các màu đơn sắc của frame theo cách dùng (`frame`, `text`, `button`, `fill`);
- các họ font và cỡ chữ;
- các giá trị bo góc.

`theme` ánh xạ chúng sang token theme của Studio:

| Token | Lấy từ |
|---|---|
| `--primary` (và `--ring`) | màu dùng nhiều nhất trên layer button / CTA / link, nếu không thì màu bão hoà dùng nhiều nhất |
| `--primary-foreground` | trắng hoặc gần đen, cái nào tương phản với `--primary` |
| `--background` | fill của frame |
| `--foreground` | màu chữ dùng nhiều nhất |
| `--radius` | bo góc dùng nhiều nhất, tính bằng px |

Các giá trị ở dạng mà `PATCH /api/v1/site` chấp nhận trong `themeOverrides`, nên
bạn có thể tự áp dụng, hoặc để agent làm:

- `mapDesignTokens({ tokens })` trả về cùng ánh xạ đó. Nó chỉ đọc và cần
  `config:read`.
- `applyThemeOverrides({ themeOverrides })` thay theme override của site và cần
  `config:write`. Nó thay đổi Studio của mọi biên tập viên, nên là skill được
  quản trị: nó chờ duyệt (HITL) như các thao tác control-plane khác. Giá trị
  được kiểm tra theo danh sách token được phép của Studio.

## API

Chỉ site admin, dưới `/api/v1/integrations/figma`:

| Method | Path | |
|---|---|---|
| `GET` | `/` | `{ hasToken }` |
| `PUT` / `DELETE` | `/token` | lưu (`{ token }`) / xoá token Figma |
| `POST` | `/preview` | `{ url, collection?, label? }` → bản nháp, token và theme; không ghi |
| `POST` | `/import` | `{ url, collection?, label?, addToBlocksField? }` → `201` kèm bản nháp |

## Multi-tenancy

Không có bảng mới:

- Token là tool secret theo site: được mã hoá, với additional authenticated
  data gắn với site và tên.
- Collection và các trường được nhập thuộc về site gọi, như mọi thay đổi
  schema.
- Figma chỉ được gọi bằng token của site đó.

## Chưa làm

- Hộp thoại nhập trong Studio (hiện chỉ có API và agent).
- Component có biến thể (`COMPONENT_SET`) chỉ nhập node được chọn; mỗi biến thể
  được nhập riêng.
- Chưa đọc Figma variables và styles; token lấy từ chính các layer của frame.
