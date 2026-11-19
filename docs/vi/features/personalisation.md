---
sourceLang: en
version: 1
lastUpdated: 2026-11-19T06:12:09.760Z
translatedFrom: en
sourceHash: 7d9fde0ac4b70d8e
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T06:12:09.760Z
codeVerifiedHash: 7d9fde0ac4b70d8e
codeVerifiedClaims: 12
---

# Cá nhân hoá: audience và biến thể nội dung

Một page hoặc một item có thể có **biến thể** (variant): nội dung khác nhau cho
các **audience** khác nhau. Ở mỗi request, delivery API chọn audience dựa trên
những gì request mang theo (quốc gia, locale, chiến dịch, hạng thành viên mà
site truyền vào), trộn biến thể của audience đó lên nội dung đã xuất bản, và
cache một bản cho mỗi audience. Khách không khớp audience nào nhận nội dung
mặc định (#762, epic #678).

Tính năng này bật theo từng site: một site không có audience nào vẫn hoạt động
y như trước. Hiện chưa có trình soạn trong Studio; quản lý audience và biến
thể qua API bên dưới.

## Audience

Một audience gồm key, độ ưu tiên và một rule. Audience đang bật đầu tiên có
rule khớp sẽ thắng; `priority` thấp hơn chạy trước, nếu bằng nhau thì xét key
theo thứ tự chữ cái.

```json
{
  "key": "vn-gold",
  "name": "Gold members in Vietnam",
  "priority": 10,
  "rules": {
    "match": "all",
    "conditions": [
      { "attribute": "country", "op": "eq", "value": "VN" },
      { "attribute": "attr.tier", "op": "in", "value": ["gold", "platinum"] }
    ]
  }
}
```

- `match`: `all` (mọi điều kiện) hoặc `any` (ít nhất một điều kiện).
- `op`: `eq`, `neq`, `in`, `nin`, `prefix`, `exists`. So sánh không phân biệt
  hoa thường.
- `key`: 1–40 chữ thường, chữ số hoặc dấu gạch ngang. Nó xuất hiện trong cache
  key, trong số đếm exposure và trong header phản hồi `X-Lumi-Variant`.
  `default` là từ dành riêng.

| Thuộc tính | Lấy từ | Cần consent |
|---|---|---|
| `country` | header geo của CDN: `CF-IPCountry` (Cloudflare), `X-Vercel-IP-Country`, `CloudFront-Viewer-Country` | không |
| `locale` | `?locale=` hoặc `?lang=` | không |
| `utm.source`, `utm.medium`, `utm.campaign`, `utm.term`, `utm.content` | tham số query `utm_*` | có |
| `attr.<name>` | header `X-Lumi-Attrs`, ví dụ `X-Lumi-Attrs: tier=gold; plan=pro` | có |

Delivery API là công khai và không biết khách là ai, nên hạng thành viên (hoặc
bất kỳ thông tin nào về khách) được server của chính site truyền vào qua
`X-Lumi-Attrs`, thường lấy từ phiên đăng nhập khi render trang. Đừng để trình
duyệt tự đặt header này cho các audience chặn thứ gì nhạy cảm: audience chỉ
đổi nội dung được hiển thị, nó không phải cơ chế kiểm soát truy cập.

Khi không có header quốc gia (ví dụ triển khai Docker không có CDN phía
trước), các điều kiện `country` không bao giờ khớp.

### Consent

`country` và `locale` là thông tin thô, không gắn với một người, nên luôn dùng
được. Tham số UTM và thuộc tính tuỳ chỉnh là thông tin cá nhân: chúng chỉ được
đọc khi request mang consent cá nhân hoá:

```http
X-Lumi-Consent: personalization, analytics
```

Banner consent của site quyết định gửi gì. `DNT: 1` hoặc `Sec-GPC: 1` rút lại
cả hai. Khi không có consent, mọi điều kiện trên thuộc tính cá nhân đều sai,
kể cả `neq` và `nin`, nên một audience không bao giờ có nghĩa là "mọi người
không đồng ý". Khách rơi xuống một audience chỉ dựa trên quốc gia hoặc locale,
hoặc nhận nội dung mặc định. API báo `needsConsent: true` trên các audience
dùng thuộc tính cá nhân.

## Biến thể

Một biến thể thuộc về một page hoặc một item và một audience:

- **Page** (`subjectType: "page"`, `subjectId` = id của page): ghi đè `title`
  và/hoặc `layoutConfig`. Layout thay thế có thể trỏ các section sang
  collection khác.
- **Item** (`subjectType: "item"`, `subjectId` = id của item): ghi đè bất kỳ
  trường dữ liệu nào, từng trường một. Không ghi đè được `id`, `status`,
  `sort`, `createdAt` và `updatedAt`.

Chỉ biến thể `published` được phân phối; mặc định là `draft`. Mỗi page hoặc
item chỉ có một biến thể cho mỗi audience. Phần ghi đè giới hạn 64 KiB. Xoá
một audience sẽ xoá các biến thể của nó.

## Phân phối

`GET /api/v1/deliver/page/:site_id/:slug` xác định audience trước, rồi mới trả
lời. Khi site có audience:

- Biến thể page thay title hoặc layout, và biến thể item được trộn lên các item
  của mọi section.
- Payload có thêm `personalisation: { audience, variants }`: key của audience
  (`null` cho nội dung mặc định) và id các biến thể đã áp dụng.
- `X-Lumi-Variant` mang key của audience, hoặc `_` cho nội dung mặc định.
- `Vary` thêm các header mà audience có thể phụ thuộc (`CF-IPCountry`,
  `X-Vercel-IP-Country`, `CloudFront-Viewer-Country`, `X-Lumi-Attrs`,
  `X-Lumi-Consent`, `DNT`, `Sec-GPC`), để một cache dùng chung đứng trước API
  không trộn lẫn các audience.

### Cache

Mọi tầng cache đều được keyed theo **audience đã xác định**, không bao giờ theo
thuộc tính thô. Một site có ba audience có tối đa bốn bản cache cho một trang,
dù khách đến từ bao nhiêu quốc gia, hạng hay chiến dịch.

- Key của bản ở edge có thêm tham số tổng hợp `__aud=<key>`.
- Key của application cache và `ETag` có chứa audience, và `ETag` còn bao gồm
  các biến thể của site. Một `304` của audience này không bao giờ trả lời cho
  audience khác.
- Mọi thay đổi audience hoặc biến thể đều bỏ danh sách audience đang cache
  (cache 60 giây) và purge các cache phân phối của site, nên có hiệu lực ngay ở
  request tiếp theo.

Xem [Caching](./caching.md) để biết chi tiết các tầng cache.

## Exposure

**Trong CMS.** Mỗi trang được phân phối tính một exposure theo ngày, slug của
page và key của audience (`_` cho nội dung mặc định). Nó chỉ được tính khi
request mang consent phân tích (`X-Lumi-Consent: analytics`, và không có
`DNT` / `Sec-GPC`). Không lưu gì về khách. Nó được tính ở mọi lần phân phối,
kể cả khi trúng cache ở edge. Site không có audience không ghi gì.

```http
GET /api/v1/personalisation/exposures?from=2026-11-01&to=2026-11-30
```

**Trong GA4.** `@lumibase/analytics-consent` gửi một event
`lumi_variant_exposure` theo cùng quy tắc với chính tag (không gửi gì nếu chưa
được đồng ý):

```ts
import { readConsent, trackVariantExposure, variantFromHeaders } from '@lumibase/analytics-consent';

const res = await fetch(`${cms}/api/v1/deliver/page/${siteId}/home`, { headers });
const page = await res.json();
trackVariantExposure(window.gtag, readConsent(localStorage), {
  subject: 'home',
  audience: page.personalisation?.audience ?? variantFromHeaders(res.headers),
  variants: page.personalisation?.variants,
});
```

Event mang `lumi_subject`, `lumi_audience` (`default` cho nội dung mặc định) và
`lumi_variants`.

## API

Chỉ site admin, dưới `/api/v1/personalisation`:

| Method | Path | |
|---|---|---|
| `GET` / `POST` | `/audiences` | liệt kê / tạo (`409 AUDIENCE_EXISTS` khi trùng key) |
| `PATCH` / `DELETE` | `/audiences/:id` | cập nhật / xoá (các biến thể đi theo) |
| `GET` | `/variants?subjectType=&subjectId=&audienceId=` | liệt kê |
| `POST` | `/variants` | `{ subjectType, subjectId, audienceId, overrides, status? }`; `404 SUBJECT_NOT_FOUND` / `AUDIENCE_NOT_FOUND`, `409 VARIANT_EXISTS`, `413 OVERRIDES_TOO_LARGE` |
| `PATCH` / `DELETE` | `/variants/:id` | `{ overrides?, status? }` / xoá |
| `GET` | `/exposures?from=&to=&subjectType=&subjectId=` | số đếm theo ngày và `meta.totals` theo audience; tối đa 366 ngày |

## Multi-tenancy

`lumibase_audiences`, `lumibase_content_variants` và
`lumibase_variant_exposures` mang `site_id` và nằm trong danh sách RLS
`site_isolation`. Mọi query đều giới hạn trong site; delivery lấy site từ URL
và dùng database handle theo site, giống phần còn lại của `/deliver`. Danh sách
audience được cache theo từng site.

## Chưa làm

- Trình soạn audience và biến thể trong Studio.
- Preview delivery (`/api/v1/deliver/preview`) luôn hiển thị nội dung mặc
  định; xem trước một biến thể cần trình soạn trong Studio.
- A/B test với phân nhóm ngẫu nhiên và insights (#763) dựng trên các bảng này.
