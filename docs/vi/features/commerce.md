---
sourceLang: en
version: 3
lastUpdated: 2026-11-19T09:11:24.583Z
translatedFrom: en
sourceHash: 078cb60d3e1d3edd
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T09:11:24.583Z
codeVerifiedHash: 078cb60d3e1d3edd
codeVerifiedClaims: 12
---

# Nội dung thương mại: Medusa và Shopify

LumiBase có thể sao chiếu catalogue của một cửa hàng để các trang hiển thị sản
phẩm, giá và khuyến mãi cạnh nội dung biên tập (#764, epic #678). Cửa hàng vẫn
là nguồn sự thật: LumiBase không có giỏ hàng và không có thanh toán. Sản phẩm
được đồng bộ vào một collection thông thường, nên delivery, tìm kiếm, CDC, cache
và trình soạn block hoạt động trên chúng như mọi nội dung khác.

Có hai adapter, sau cùng một port (`apps/cms/src/modules/commerce/`):

| Nhà cung cấp | API | Chữ ký webhook |
|---|---|---|
| Medusa v2 | Admin REST, secret API key | `X-Lumi-Signature: sha256=<hex HMAC>` |
| Shopify | Admin GraphQL `2025-01`, app access token | `X-Shopify-Hmac-Sha256` (HMAC base64) |

## 1. Kết nối cửa hàng

```http
PUT /api/v1/integrations/commerce/medusa
{ "apiUrl": "https://shop-api.example.com", "apiKey": "sk_…", "webhookSecret": "…" }

PUT /api/v1/integrations/commerce/shopify
{ "shopDomain": "acme.myshopify.com", "accessToken": "shpat_…", "webhookSecret": "<app client secret>" }
```

Chỉ site admin. Trước khi lưu, LumiBase đọc trang sản phẩm đầu tiên, nên
thông tin xác thực sai sẽ trả `422 COMMERCE_CREDENTIALS_REJECTED`. Thêm
`?verify=false` để bỏ qua bước kiểm tra.

Toàn bộ cấu hình được lưu thành một tool secret mã hoá của site
(`COMMERCE_MEDUSA` / `COMMERCE_SHOPIFY`) và không bao giờ được trả về.
`GET /api/v1/integrations/commerce` liệt kê từng nhà cung cấp với `connected`,
phần không bí mật (`apiUrl` hoặc `shopDomain`) và `webhookUrl` cần đăng ký.
`DELETE /api/v1/integrations/commerce/:provider` ngắt kết nối.

Lệnh gọi ra ngoài được bảo vệ:

- `apiUrl` của Medusa là địa chỉ private, loopback hoặc metadata, trực tiếp
  hay sau khi resolve DNS, bị từ chối với `502 COMMERCE_UNREACHABLE`.
- Lệnh gọi Shopify chỉ đi tới `<store>.myshopify.com`.

Việc kết nối cũng tạo các collection dưới đây, một lần.

## 2. Những gì được đồng bộ

| Collection | Nội dung |
|---|---|
| `commerce_products` | `title`, `handle`, `description`, `thumbnail`, `variants`, `price_from`, `currency`, `provider`, `external_id`, `synced_at` |
| `commerce_promotions` | `title`, `code`, `kind` (`percentage`/`fixed`), `value`, `currency`, `starts_at`, `ends_at`, `provider`, `external_id`, `synced_at` |

Mỗi dòng được định danh theo `(provider, external_id)`. Sản phẩm đã xuất bản ở
phía cửa hàng (Medusa `published`, Shopify `ACTIVE`) là item `published`; mọi
trạng thái khác là `draft`, nên delivery ẩn nó. Khuyến mãi được xuất bản khi
đang hoạt động.

`variants` chứa `prices` của từng biến thể: `{ currency, amount, minQuantity,
maxQuantity, compareAt? }`, số tiền tính theo đơn vị chính.

- **Medusa:** giá có khoảng số lượng là một **bậc giá** (tier). Giá trong
  price list theo nhóm khách không được đồng bộ.
- **Shopify:** bậc giá theo số lượng chỉ có ở catalog B2B, nên mỗi biến thể
  có một giá, kèm `compareAt` khi đang giảm giá.

`price_from` là giá thấp nhất, tính cả các bậc.

Mọi thao tác ghi đi qua item service, nên revision, webhook, đánh chỉ mục tìm
kiếm và invalidation cache delivery diễn ra như với một thay đổi của biên tập
viên. Full sync chạy với quyền của chính admin gọi nó. Webhook không có
principal nên ghi với tư cách hệ thống: CDC actor là
`system`/`commerce:<provider>` và reason là `commerce-sync`.
Đồng bộ sở hữu các dòng của nó: một chỉnh sửa trong Studio sẽ bị ghi đè ở lần
đồng bộ sau.

## 3. Giữ dữ liệu luôn mới

**Webhook** đưa thay đổi ở cửa hàng vào LumiBase trong vài giây. Đăng ký
`webhookUrl` (`POST /api/v1/commerce-webhooks/:site_id/:provider`):

- **Shopify:** đăng ký các topic `products/create`, `products/update` và
  `products/delete`.
- **Medusa:** không có webhook gửi ra. Thêm một subscriber trong app Medusa,
  gửi `{ "event": "product.updated", "data": { "id": "prod_…" } }` (cả
  `product.created`, `product.deleted`, `promotion.*`) với
  `X-Lumi-Signature: sha256=` + HMAC-SHA256 dạng hex của body gốc theo webhook
  secret.

Webhook không cần xác thực, bị giới hạn tốc độ, và được kiểm tra bằng chữ ký:

- thiếu hoặc sai chữ ký trả `401`;
- site không tồn tại, hoặc nhà cung cấp chưa kết nối, trả `404`.

Body chỉ cho biết cái gì đã đổi. Sau đó LumiBase lấy sản phẩm từ nhà cung
cấp, nên body webhook không bao giờ ghi được nội dung. Sự kiện không được xử
lý vẫn được trả `200` để nhà cung cấp không gửi lại.

**Đồng bộ toàn bộ**: `POST /api/v1/integrations/commerce/:provider/sync` đi
qua mọi trang sản phẩm và mọi khuyến mãi, rồi xoá các dòng đã đồng bộ mà nhà
cung cấp không còn. Nó trả `{ products, promotions, truncated }`. Chạy sau khi
kết nối, và bất cứ khi nào có thể đã lỡ webhook.

## 4. Block và bậc giá

Việc kết nối tạo hai block template ẩn cho dynamic zone:

- `block_product_card`: `product_handle`, `show_tiers`, `currency`,
  `cta_label`, `cta_url`;
- `block_promotion`: `promotion_code`, `headline`, `body`, `cta_label`,
  `cta_url`.

Thêm chúng vào `allowedBlocks` của một trường `blocks`. Frontend tra handle
hoặc code qua delivery items API và hiển thị giá bằng các helper trong
`@lumibase/sdk`:

```ts
import { formatPriceTiers, unitPrice } from '@lumibase/sdk';

formatPriceTiers(product.variants[0], 'EUR', 'de');
// ['1–9: 120,00 €', '10+: 99,50 €']
unitPrice(product.variants[0], 'EUR', 12); // 99.5
```

`priceTiers()` sắp xếp các bậc và đóng các khoảng còn mở, nên các khoảng số
lượng không bao giờ chồng nhau.

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/integrations/commerce` | các nhà cung cấp, trạng thái kết nối, URL webhook |
| `PUT` | `/api/v1/integrations/commerce/:provider` | kết nối (`medusa` / `shopify`) |
| `DELETE` | `/api/v1/integrations/commerce/:provider` | ngắt kết nối |
| `POST` | `/api/v1/integrations/commerce/:provider/sync` | đồng bộ toàn bộ |
| `POST` | `/api/v1/commerce-webhooks/:site_id/:provider` | webhook của nhà cung cấp (công khai, có chữ ký) |

Lỗi:

- `400 VALIDATION` và `COMMERCE_CONFIG_INVALID`;
- `404 COMMERCE_NOT_CONFIGURED`;
- `422 COMMERCE_CREDENTIALS_REJECTED`;
- `429 COMMERCE_RATE_LIMITED`;
- `502 COMMERCE_UNAVAILABLE` và `COMMERCE_UNREACHABLE`.

## Multi-tenancy

Không có bảng mới:

- Thông tin xác thực là tool secret mã hoá theo site, với additional
  authenticated data gắn với site và tên.
- Các dòng đã đồng bộ là item thông thường của site.
- Webhook lấy site từ URL, chỉ đọc cấu hình của site đó, và kiểm tra chữ ký
  bằng secret của site đó.

## Chưa làm

- Màn hình Studio để kết nối cửa hàng (hiện chỉ có API).
- Đồng bộ nền định kỳ. Hiện webhook cùng lệnh đồng bộ toàn bộ thủ công đảm
  nhận việc này.
- Bậc giá theo số lượng B2B của Shopify, các nhà cung cấp khác, và biến thể
  sản phẩm thành collection riêng.
