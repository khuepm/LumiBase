---
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
version: 2
lastUpdated: 2026-11-15T08:37:17.584Z
sourceHash: 3c24ed16f8d5e8dc
codeVerified: 2026-11-15T08:37:17.584Z
codeVerifiedHash: 3c24ed16f8d5e8dc
codeVerifiedClaims: 18
---

# Tài liệu OpenAPI trực tiếp

> `GET /api/v1/openapi.json` — một tài liệu OpenAPI 3.1 sinh từ schema đang chạy của site, được lọc theo người đang gọi. Mặc định tắt.

## Tổng quan

File tĩnh [`docs/openapi.yaml`](../../openapi.yaml) mô tả nền tảng. Tài liệu trực tiếp mô tả **site của bạn**: mỗi collection một cặp path, mỗi collection một component schema, với đúng các kiểu field, relation, file và field đa ngôn ngữ mà bạn đã cấu hình.

Tài liệu được sinh theo từng người gọi. Cùng một URL trả về tài liệu khác nhau cho editor, subscriber và khách ẩn danh, vì nó chỉ liệt kê:

- các collection mà người gọi được **đọc** (collection không có quyền `read` thì không bao giờ được nhắc tên — không có trong paths, schemas hay `$ref`);
- các field mà **field mask** của người gọi cho qua — cùng quy tắc `applyFieldMask` mà `PermissionService.maskItem` áp lên các lần đọc thật, nên field bị loại khỏi response cũng vắng mặt trong tài liệu;
- các thao tác người gọi có quyền (`create` → `POST`, `update` → `PATCH`, `delete` → `DELETE`). Body ghi chỉ chứa các field mà người gọi vừa ghi được vừa đọc được.

Realm `public` (người gọi ẩn danh, ADR-011) luôn chỉ nhận bề mặt **chỉ đọc**, kể cả khi grant cho phép nhiều hơn.

Mã nguồn: `apps/cms/src/routes/openapi.ts`, bộ sinh nằm trong `apps/cms/src/services/openapi/`.

## Bật tính năng

Endpoint bị tắt trên mọi site cho đến khi một site admin bật nó. Khi đang tắt — hoặc khi realm của người gọi không được phép — nó trả về **đúng body 404 của một route không tồn tại**, nên không làm lộ sự tồn tại của endpoint.

Từ Studio: **Settings → Developer → Types → Live OpenAPI document**. Đánh dấu *Enable* và chọn ai được tải về.

Từ API (site admin):

```bash
curl -X PUT "$LUMI_URL/api/v1/openapi/config" \
  -H "Authorization: Bearer $LUMI_TOKEN" \
  -H "X-Lumi-Site: $SITE" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": true, "realms": ["studio", "api_key"] }'
```

`GET /api/v1/openapi/config` đọc giá trị hiện tại. Giá trị được lưu trong bảng `settings` sẵn có dưới key `openapi` (không có migration); row thiếu hoặc sai định dạng được đọc là đang tắt. Mọi thay đổi đều được audit với sự kiện `openapi_config_updated`.

| Realm | Ai |
|---|---|
| `studio` | Phiên của nhân sự (token audience `studio`), Cloudflare Access, dev admin token |
| `frontend` | Phiên subscriber (token audience `frontend`) và người dùng từ một trusted external issuer |
| `api_key` | Mọi API key của site, publishable hay secret |
| `public` | Người gọi ẩn danh được resolve thành role `public` của site — cần bật public access tại **Access → Public & subscribers** |

## Tải tài liệu

```bash
curl "$LUMI_URL/api/v1/openapi.json" \
  -H "Authorization: Bearer $LUMI_TOKEN" \
  -H "X-Lumi-Site: $SITE"
```

Response chính là tài liệu OpenAPI (không bọc trong `{ data }`), kèm `Cache-Control: private, no-cache` và một `ETag`; gửi `If-None-Match` để nhận `304`.

`servers` là URL tương đối `/api/v1`, được resolve theo chính URL của tài liệu — không có host nào bị gắn cứng.

## Tài liệu chứa gì

Với mỗi collection đọc được `<name>`:

| Component | Hình dạng |
|---|---|
| `<name>.Item` | Hình dạng đọc mặc định: các cột hệ thống ở cấp trên cùng (`id`, `status`, `sort`, `createdAt`, …) và field người dùng nằm dưới `data` |
| `<name>.Fields` | Các field người dùng đọc được (`data`) |
| `<name>.Projection` | Hình dạng phẳng trả về khi request truyền `fields=` (cột hệ thống dạng snake_case, relation và file mở rộng được bằng `rel.*`) |
| `<name>.CreateInput` / `<name>.UpdateInput` | Body của request — chỉ khi người gọi có `create` / `update` |

Paths: `/items/<name>` (`GET` danh sách với `fields`, `filter`, `sort`, `limit`, `offset`, `status`, `meta`; `POST` khi được phép) và `/items/<name>/{id}` (`GET`; `PATCH`/`DELETE` khi được phép), cộng endpoint delivery công khai `/deliver/page/{site_id}/{slug}` (`locale`/`lang`). Body thành công dùng `{ data, meta? }`; lỗi dùng `{ errors: [...] }`.

Các kiểu field được ánh xạ đúng như `lumibase typegen` ánh xạ (`apps/cms/src/services/openapi/field-schema.ts` phản chiếu `packages/sdk/src/typegen/index.ts`):

| Field | JSON Schema |
|---|---|
| `string`, `text`, `hash`, `csv` | `string` |
| `integer`, `bigInteger` | `integer` |
| `decimal` | `number` |
| `boolean` | `boolean` |
| `json` | bất kỳ (`{}`) |
| `uuid`, `date`, `datetime`, `time`, `timestamp` | `string` kèm `format` |
| `geometry` | object GeoJSON |
| lựa chọn (`validation.rules[choices]`) | `enum` |
| interface `translatable-text` | object locale → string |
| interface `file` / `files` | id file / mảng id file (mở rộng được trong projection) |
| relation m2o | khoá chính của collection đích (mở rộng thành projection của đích khi đọc được) |
| alias o2m / m2m | mảng khoá chính của collection đích |

Field nullable hoặc không bắt buộc cho phép `null`, đúng như `| null` của typegen. Field được mã hoá mà người gọi không có `read_decrypted` được mô tả là kiểu của nó **hoặc** giá trị mask `'***'`.

## Cache

Tài liệu được cache trong runtime cache (`c.get('runtime').cache` — KV trên Workers, Redis trên Docker) dưới key `openapi:<site>:s<schema version>:<permission fingerprint>`:

- **schema version** là con trỏ theo site, được `SchemaService.invalidate` tăng lên mỗi khi collection, field hay relation thay đổi (`apps/cms/src/services/schema-version.ts`), nên một thay đổi schema bỏ rơi mọi tài liệu đã cache của site chỉ bằng một lần ghi;
- **permission fingerprint** là digest của realm và permission bundle đã biên dịch của người gọi (chỉ các action mà tài liệu dùng tới). Những người gọi có quyền giống hệt nhau dùng chung một entry; thay đổi quyền tạo ra fingerprint mới.

Entry hết hạn sau 300 giây như một lưới an toàn khi việc tăng version bị mất. Sự cố cache chỉ làm sinh lại tài liệu, không bao giờ biến thành lỗi.

## Multi-tenancy

Mọi thứ đều cô lập theo site; giữa các tenant không dùng chung gì ngoài mã của bộ sinh. Công tắc là một row `settings` theo `site_id`, manifest được đọc với `scopeSite`, con trỏ schema version là `schema-ver:<site>` và mọi key tài liệu trong cache đều bắt đầu bằng `openapi:<site>:`. Một site chưa bật endpoint thì trả 404 bất kể site khác cho phép gì. Kiểm bằng `apps/cms/src/routes/__tests__/openapi.test.ts` (hai site dùng chung một cache; hai principal dùng chung một cache).

## Dùng với typegen và công cụ SDK

Mọi công cụ OpenAPI 3.1 đều dùng được. Với [`openapi-typescript`](https://openapi-ts.dev):

```bash
npx openapi-typescript "$LUMI_URL/api/v1/openapi.json" \
  -H "Authorization: Bearer $LUMI_TOKEN" -H "X-Lumi-Site: $SITE" \
  -o ./lumibase-openapi.ts
```

```ts
import type { components, paths } from './lumibase-openapi';

type Post = components['schemas']['posts.Fields'];
type PostList = paths['/items/posts']['get']['responses'][200]['content']['application/json'];
```

Bộ test của CMS chạy đúng việc này (`apps/cms/src/services/openapi/__tests__/openapi-consumers.test.ts`): nó sinh type từ một tài liệu phủ mọi kiểu field rồi type-check một đoạn code dùng chúng, và khẳng định mọi kiểu field vô hướng nhận cùng một kiểu TypeScript từ `openapi-typescript` như từ `lumibase typegen`. Các tài liệu sinh ra được kiểm tra với schema OpenAPI 3.1 chính thức, gồm cả các lượt property-based trên schema và permission mask ngẫu nhiên để chắc chắn không field hay collection ẩn nào xuất hiện.

`lumibase typegen` vẫn là đường chính (nó còn sinh id có brand và kiểu relation `*Expanded`); tài liệu trực tiếp dành cho các công cụ nói OpenAPI — bộ sinh client, Postman, contract test, API gateway.

## Duyệt trên trang docs

Trang docs có trang API explorer (`/en/api-explorer/` · `/vi/api-explorer/`): một Swagger UI được bundle sẵn, nạp URL tài liệu mà bạn gõ vào. Không có gì được tải cho tới khi bạn bấm **Nạp**, trang bỏ qua tham số `?url=` trên query string, và site id cùng token (tuỳ chọn) chỉ nằm trong bộ nhớ của tab và chỉ được gửi tới chính origin của tài liệu. CMS của bạn phải cho phép origin của trang docs trong CORS để trình duyệt tải được tài liệu.
