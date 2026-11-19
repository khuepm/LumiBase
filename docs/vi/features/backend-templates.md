---
version: 6
lastUpdated: 2026-11-19T07:43:09.419Z
sourceLang: en
translatedFrom: en
sourceHash: c801a4dd4fa38995
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T07:43:09.419Z
codeVerifiedHash: c801a4dd4fa38995
codeVerifiedClaims: 24
---

# Backend templates

Một **backend template** là một tài liệu JSON mô tả một content model hoàn
chỉnh: các collection, field, validation, giá trị mặc định, metadata hiển thị,
lựa chọn lưu trữ và relation, cộng dữ liệu demo tuỳ chọn. Từ nó, bạn có thể cài
cùng model đó vào một site khác. Epic #900; đặc tả
`.kiro/specs/backend-templates/`.

> **Trạng thái.** Hiện đã có: **định dạng** template và bộ validator trong
> `@lumibase/contracts/backend-templates` (#901), và **catalog** riêng của mỗi
> site (#902): draft, revision đã publish và capture, và **plan** (#903), dùng
> để xem trước một lần cài mà không thay đổi gì, và **cài schema** từ một plan
> (#904), kể cả seed pack tuỳ chọn (#905). MCP tool và màn hình Studio do
> #906–#909 đảm nhận.

Code: `packages/contracts/src/backend-templates/` (`envelope.ts`, `validate.ts`, `ingest.ts`, `canonical.ts`, `limits.ts`). Test: `packages/contracts/src/backend-templates/__tests__/backend-template-contract.test.ts`.

## Tài liệu

```json
{
  "formatVersion": "lumibase.template@v1",
  "slug": "wordpress-alike",
  "displayName": "WordPress alike",
  "templateVersion": "1.0.0",
  "description": "Posts, pages, taxonomies and comments.",
  "compatibility": { "cmsVersionRange": ">=2.2.0 <3.0.0", "storageModes": ["jsonb"] },
  "config": {
    "version": "lumibase.config@v1",
    "collections": [{ "name": "authors" }, { "name": "posts" }],
    "fields": [
      { "collection": "authors", "field": "name", "type": "string", "interface": "input", "required": true },
      { "collection": "posts", "field": "title", "type": "string", "interface": "input", "required": true },
      { "collection": "posts", "field": "author", "type": "string", "interface": "input" }
    ],
    "relations": [
      { "manyCollection": "posts", "manyField": "author", "oneCollection": "authors", "type": "m2o" }
    ]
  },
  "seedPacks": {
    "demo": {
      "records": [
        { "key": "author-1", "collection": "authors", "values": { "name": "Demo author" } },
        { "key": "post-1", "collection": "posts", "values": { "title": "Hello" }, "references": { "author": "author-1" } }
      ]
    }
  }
}
```

| Thuộc tính | Bắt buộc | Ý nghĩa |
|---|---|---|
| `formatVersion` | có | Luôn là `lumibase.template@v1`. Mọi giá trị khác là `UNSUPPORTED_FORMAT`. |
| `slug` | có | Định danh kebab-case, tối đa 64 ký tự. |
| `displayName` | có | Tối đa 120 ký tự. |
| `templateVersion` | có | [SemVer 2.0.0](https://semver.org), ví dụ `1.0.0` hoặc `1.1.0-beta.1`, không có tiền tố `v`. Nó độc lập với phiên bản CMS. |
| `description` | không | Tối đa 4000 ký tự. Hiển thị cho người đọc; không bao giờ được coi là chỉ dẫn. |
| `compatibility` | có | `cmsVersionRange` (một khoảng SemVer) và các `storageModes` mà các collection dùng. |
| `config` | có | Một config manifest (`lumibase.config@v1`, cùng định dạng với config export/import): `collections` (ít nhất một), `fields`, `relations`. |
| `seedPacks` | không | Dữ liệu demo có tên. Khi bỏ trống, template chỉ có schema. Việc cài không bao giờ seed dữ liệu trừ khi một pack được chọn. |

Các mục collection, field và relation chính là các mục của config manifest, nên
chúng dùng cùng tên và tuỳ chọn với schema API.

## Những gì một template không được chứa

Envelope rất chặt, và key lạ ở bất kỳ đâu đều bị từ chối. Điều này giữ những
thứ sau ra khỏi template:

- **Định danh:** id của record, id của site, `createdAt` / `updatedAt`, hoặc
  field tên `id` hay `site_id`. Id được sinh ra khi template được cài.
- **Code và tác dụng phụ:** SQL, migration, flow, extension, `config.webhooks`,
  `config.settings` (có thể chứa secret) và `config.managedScopes`. Danh sách
  `webhooks` / `settings` rỗng được chấp nhận và bị bỏ đi.
- **Quyền truy cập:** permission, role và user.
- **Secret:** giá trị seed cho field kiểu `hash`.
- **Tài nguyên nền tảng:** collection đánh dấu `system`, tên bắt đầu bằng
  `lumibase_` hoặc `mat_`, và primary key khác `nanoid` tên `id`.

## Seed pack

Một pack là `{ description?, records: [...] }`. Mỗi record có:

- `key`: khoá logic, duy nhất trong pack. Nó không bao giờ là id được lưu.
- `collection`: một collection đã khai báo.
- `values`: giá trị theo tên field. Chúng phải khớp kiểu field, và không được
  gồm field relation, alias hay hash.
- `references` (tuỳ chọn): một field relation m2o trỏ tới key của một record
  khác **trong cùng pack**, hoặc `null`. Đích phải là record thuộc collection
  đích của relation. Reference ra ngoài pack bị từ chối.

Field bắt buộc phải có mặt, trừ khi có giá trị mặc định. Reference bắt buộc
không được tạo thành vòng, vì khi đó các record không thể được insert.

## Validation

```ts
import { parseBackendTemplate, templateDigest, exportBackendTemplate } from '@lumibase/contracts/backend-templates';

const result = parseBackendTemplate(jsonText);        // raw text: duplicate keys, size and depth checked
if (!result.ok) console.log(result.errors);           // [{ code, path: '$.config.fields[3].type', message }]
const digest = await templateDigest(result.template); // 'sha256:…'
```

`parseBackendTemplate` đọc văn bản JSON thô và từ chối key trùng, trong khi
`JSON.parse` thông thường sẽ giữ key cuối. `validateBackendTemplate` nhận một
giá trị đã parse sẵn. Cả hai báo **mọi** vấn đề tìm thấy. Mỗi vấn đề có một mã
ổn định và một JSON path:

| Mã | Khi nào |
|---|---|
| `UNSUPPORTED_FORMAT` | `formatVersion` hoặc `config.version` không phải phiên bản CMS này đọc được |
| `INVALID_TEMPLATE` | Cấu trúc sai, hoặc key bị trùng, reference trỏ vào chỗ không tồn tại, tên bị dành riêng, kiểu field không biết, giá trị seed không khớp field, hoặc có vòng bắt buộc |
| `INCOMPATIBLE_RUNTIME` | Một storage mode hoặc kiểu relation mà template v1 không cài được, như `physical`, `materialized`, `external` hoặc `m2a`. Chúng bị từ chối, không bao giờ bị hạ cấp. |
| `LIMIT_EXCEEDED` | Vượt một giới hạn bên dưới |

Các mã khác (`AMBIGUOUS_TEMPLATE`, `SITE_MISMATCH`, `NAME_CONFLICT`,
`STALE_PLAN`, `APPROVAL_REQUIRED`, `IDEMPOTENCY_CONFLICT`) dành cho bước
catalog và cài đặt.

`backendTemplateJsonSchema()` trả JSON Schema (draft 2020-12) của envelope. Nó
được sinh từ chính schema Zod, nên một validator bên ngoài chấp nhận và từ chối
cùng các tài liệu về mặt cấu trúc. Các quy tắc tham chiếu chéo ở trên chỉ được
áp dụng bởi validator.

## Giới hạn

| Giới hạn | Giá trị |
|---|---|
| Tài liệu | 2 MiB (số byte UTF-8 của văn bản JSON) |
| Độ sâu lồng | 32 (object cấp cao nhất có độ sâu 1) |
| Collection | 100 |
| Field | 2000 |
| Relation | 500 |
| Seed record, trên mọi pack | 1000 |
| Giá trị seed, trên mọi pack | 1 MiB (UTF-8 của `values` và `references` của từng record) |

Một tài liệu đúng bằng giới hạn được chấp nhận khi mọi thứ khác hợp lệ. Vượt
một đơn vị sẽ bị từ chối với `LIMIT_EXCEEDED`. Không gì bị cắt bớt.

## Dạng canonical và digest

`canonicalTemplate` sắp xếp key của object. Nó cũng sắp xếp collection, field,
relation, seed record và `compatibility.storageModes` theo khoá ổn định của
chúng, vì thứ tự của chúng không mang ý nghĩa (thứ tự field là `sortOrder`).
Mọi mảng khác giữ nguyên thứ tự. `config.exportedAt` bị bỏ đi.
`templateDigest` là SHA-256 trên các byte canonical, gồm cả seed pack. Vì vậy
hai tài liệu chỉ khác nhau về thứ tự key hay danh sách có cùng digest, và mọi
thay đổi ở một field hay một giá trị seed đều làm digest đổi.
`exportBackendTemplate` trả object canonical.

## Catalog

Mỗi site giữ một catalog riêng dưới `/api/v1/backend-templates`. Nó chỉ mở cho
**site admin**, và gắn với site của request: template của site khác không được
tìm thấy, dù đoán id hay slug nào. Các bảng là `lumibase_backend_templates` và
`lumibase_backend_template_revisions`, và cả hai nằm trong danh sách RLS
`site_isolation`. Template chính thức đi kèm CMS ở dạng chỉ đọc
(`GET /api/v1/backend-templates/official`) và không bao giờ được copy vào một
site. Code: `apps/cms/src/services/backend-templates/catalog-service.ts`.

- **Draft.** `POST /` với `{ document }` tạo một draft. Document là một object
  JSON, hoặc văn bản JSON thô, được kiểm tra key trùng. Draft có thể chưa hoàn
  chỉnh: `validation` của nó liệt kê những gì còn thiếu. `PATCH /:id` nhận
  `{ document, draftRevision }` và chỉ thành công nếu draft vẫn ở revision đó.
  Trong hai lần sửa từ cùng một revision, một lần thắng và lần kia nhận
  `409 DRAFT_CONFLICT`. `slug` không thể đổi.
- **Publish.** `POST /:id/publish` validate toàn bộ draft và lưu một revision
  bất biến của `templateVersion` của nó, dưới dạng JSON canonical kèm digest
  `sha256`. Publish lại đúng nội dung đó trả revision đã có (`200`,
  `meta.created: false`). Nội dung khác dưới một version đã publish bị từ chối
  với `409 IMMUTABLE_REVISION`; hãy publish một `templateVersion` mới. Một draft
  không hợp lệ trả `422 INVALID_TEMPLATE` kèm mọi lỗi và JSON path của chúng.
- **Export.** `GET /:id/revisions/:version` trả document đã publish.
- **Capture.** `POST /capture` với
  `{ collections, slug, displayName, templateVersion?, description?, seed? }`
  biến các collection của site hiện tại thành một draft mới. Chỉ những
  collection được nêu tên mới được capture. Nếu chúng liên quan tới một
  collection không được nêu, capture fail với `422 MISSING_DEPENDENCY` kèm danh
  sách `missing` đầy đủ, thay vì lặng lẽ capture thêm. Capture chỉ lấy schema
  và không đọc item nào, trừ khi có `seed: { collections, maxRecordsPerCollection?, pack? }`.
  Khi đó seed capture đọc item bằng chính quyền item của người gọi, bỏ các
  field `hash` và field mã hoá, và thay id bằng khoá logic. Nếu có lần đọc nào
  bị từ chối, không gì được lưu.

Việc tạo, capture và publish được ghi vào audit log
(`backend_template_created`, `backend_template_captured`,
`backend_template_published`).

## Plan (xem trước)

`POST /api/v1/backend-templates/plans` xem trước việc cài một revision template
cụ thể vào site của request. Nó không thay đổi schema hay content nào. Thứ duy
nhất được ghi là dòng plan (`lumibase_backend_template_plans`, gắn với site
đích), và nó hết hạn sau 15 phút. Code:
`apps/cms/src/services/backend-templates/planner.ts`.

```json
{
  "template": { "source": "site", "sourceSiteId": "site_a", "slug": "blog", "version": "1.0.0" },
  "targetSiteId": "site_b",
  "namespace": { "prefix": "blog_" },
  "seedPack": null
}
```

- **Đích rõ ràng.** `targetSiteId` là bắt buộc, và phải là site của request.
  Thiếu thì trả `400 MISSING_INPUT`; site khác thì trả `400 SITE_MISMATCH`.
- **Template chính xác.** `source` là `official` (đi kèm CMS) hoặc `site`
  (catalog riêng, `sourceSiteId` mặc định là site đích). Gọi template bằng
  `slug` cộng `version`, hoặc `displayName` cộng `version`. Nếu một display name
  khớp nhiều hơn một template, trên cả hai catalog, request fail với
  `409 AMBIGUOUS_TEMPLATE` và liệt kê các ứng viên. `digest` (tuỳ chọn) ghim
  đúng revision.
- **Phân quyền riêng.** Đọc catalog riêng của site khác cũng cần quyền site
  admin trên site nguồn đó; là admin của site đích là chưa đủ. Không có quyền
  thì template được báo là không tìm thấy.
- **Namespace.** `prefix` được thêm vào trước mọi tên collection, và `map` đổi
  tên từng collection. Chỉ các tham chiếu cấu trúc được viết lại: tên collection
  trong collection, field, relation, junction và seed record. Mô tả, ghi chú,
  options, display template và giá trị seed giữ nguyên văn bản.
- **Chỉ tạo mới.** Collection đích cùng tên là `409 NAME_CONFLICT`, kể cả khi
  schema giống hệt, và response liệt kê các xung đột. Template không bao giờ gộp
  vào, hay thay thế, collection có sẵn; hãy chọn một namespace. Các collection
  không liên quan được giữ nguyên.
- **Điều kiện tiên quyết.** Storage mode, khoảng phiên bản CMS
  (`compatibility.cmsVersionRange`) và runtime có transaction được kiểm tra
  trước khi phát hành plan. Không đạt thì trả `422 INCOMPATIBLE_RUNTIME`. Khi
  phiên bản CMS không được gắn, plan kèm một cảnh báo thay vào đó.
- **Seed.** `seedMode` là `none` (mặc định) hoặc `pack`, với `seedPack` nêu
  tên pack. Một `seedPack` không kèm `seedMode` nghĩa là `pack`. `none` kèm
  pack, hoặc `pack` không kèm pack, bị từ chối với `400`, và pack không tồn tại
  là `422 INVALID_TEMPLATE`.

Response (`201`) có `id` của plan, `expiresAt`, `targetFingerprint` của schema
đích và một `report`. Report liệt kê các collection, relation và số lượng, lựa
chọn seed, điều kiện lưu trữ, các xung đột và số collection không liên quan.
`GET /plans/:id` đọc một plan. `POST /plans/:id/verify` kiểm tra lại: plan hết
hạn bị đóng là `expired`, plan có schema đích đã thay đổi kể từ lúc lập bị đóng
là `invalidated`, và cả hai trả `409 STALE_PLAN`, sau đó bạn lập plan lại. Plan
giữ một bản chụp của revision, nên các sửa đổi sau này ở catalog nguồn không
làm thay đổi nó.

## Cài đặt

`POST /api/v1/backend-templates/installations` với `{ planId, idempotencyKey }`
áp dụng một plan vào site của request. Chỉ dành cho site admin. Code:
`apps/cms/src/services/backend-templates/installer.ts`.

- **Nguyên tử.** Các collection, field, relation, seed pack được chọn và bản ghi
  cài đặt (`lumibase_backend_template_installations`) commit cùng nhau trong
  một transaction cơ sở dữ liệu, hoặc không cái nào được commit. Runtime không
  có transaction bị từ chối (`422 INCOMPATIBLE_RUNTIME`); không có đường lui
  ghi dở dang.
- **Kiểm tra lại dưới khoá.** Một khoá theo site xếp tuần tự các lần cài. Dưới
  khoá đó, plan phải còn mở và chưa hết hạn, schema đích phải khớp fingerprint
  của plan, và người gọi phải vẫn là site admin. Nếu không, request bị từ chối
  (`409 STALE_PLAN`, `403`) trước khi ghi bất cứ thứ gì. Một collection cùng tên
  xuất hiện trong lúc đó là `409 NAME_CONFLICT`.
- **Idempotent.** Key được gắn với payload của plan: site đích, plan, digest,
  namespace và seed pack. Thử lại với cùng key trả bản cài đã commit (`200`,
  `meta.replayed: true`) và không ghi thêm gì. Mười request giống hệt nhau
  chạy đồng thời chỉ tạo một bản cài. Dùng cùng key cho plan khác là
  `409 IDEMPOTENCY_CONFLICT`. Một plan chỉ được dùng một lần.
- **Tác động sau commit.** Việc xoá cache schema, CDC dispatch và audit
  `backend_template_installed` chỉ chạy sau commit. Sự kiện thay đổi schema là
  các dòng outbox trong transaction, nên rollback không để lại sự kiện nào.
  Lần cài thất bại để site đích y như trước, và được audit riêng
  (`backend_template_install_failed`) mà không kèm giá trị seed.
- **Provenance.** Bản cài ghi định danh và digest của template, namespace, seed
  pack, template đã cài (sau namespace) làm baseline cho lần nâng cấp sau, và
  các tài nguyên đã tạo. Publish một revision mới không bao giờ thay đổi một
  backend đã cài.

`GET /api/v1/backend-templates/installations/:id` đọc một bản cài của site.

## Seed pack khi cài

Mặc định một lần cài chỉ tạo schema, với không item content nào, kể cả khi
template có kèm pack. Plan lập với `seedMode: "pack"` và một `seedPack` sẽ cài
các record của pack đó bên trong transaction cài đặt. Code:
`apps/cms/src/services/backend-templates/seed-writer.ts`.

- **Với tư cách người gọi.** Mỗi record được tạo qua chính item service của
  người gọi, gắn với transaction, nên quyền item và validation field của họ
  được áp dụng. Một record người gọi không được tạo sẽ làm cả lần cài thất bại,
  và không schema hay content nào còn lại.
- **Id mới.** Khoá logic của record trở thành id mới. Cùng một pack cài vào hai
  site sẽ có id khác nhau, và các reference của nó được giải quyết trong từng
  site. Bản cài giữ bảng ánh xạ khoá sang id trong `resources.seedKeys`.
- **Reference.** Record được tạo theo thứ tự mà mọi reference bắt buộc đều đã
  tồn tại. Reference tuỳ chọn tới một record được tạo sau sẽ được gán ở lượt
  thứ hai, nên vòng tuỳ chọn như hai bài viết trỏ lẫn nhau vẫn hoạt động. Vòng
  bắt buộc bị validator từ chối trước khi ghi bất cứ thứ gì.
- **Không gì ngoài dữ liệu.** Việc seed không tạo user, credential hay file, và
  không tải gì về. Flow, webhook, search index và extension hook không chạy
  trên content seed, vì item service gắn với transaction không có queue,
  search, cache hay hook.
- **Một lần.** Thử lại một lần cài đã hoàn tất trả về chính nó mà không seed
  lại. Content người dùng đã sửa sau đó giữ nguyên như đã sửa. Thêm content sau
  này qua item API hoặc MCP thông thường.

## Template chính thức: `wordpress-alike` 1.0.0

Một backend blog dựng theo các khái niệm quen thuộc của WordPress. Nó đi kèm
CMS (`GET /api/v1/backend-templates/official`). Asset là
`apps/cms/src/services/backend-templates/official/wordpress-alike.template.json`,
và nó nhắm tới CMS `>=2.1.0 <3.0.0`.

| Collection | Field | Relation |
|---|---|---|
| `authors` | `name`*, `slug`*, `email`, `bio` | — |
| `posts` | `title`*, `slug`*, `excerpt`, `body`, `status` (draft · published · private), `published_at`, `author`, `comment_status` (open · closed), `featured` | `author` → `authors` |
| `pages` | `title`*, `slug`*, `body`, `status`, `parent`, `author`, `menu_order` | `parent` → `pages`, `author` → `authors` |
| `categories` | `name`*, `slug`*, `description`, `parent` | `parent` → `categories` |
| `tags` | `name`*, `slug`* | — |
| `post_categories` | `post`*, `category`* | junction: `post` → `posts`, `category` → `categories` |
| `post_tags` | `post`*, `tag`* | junction: `post` → `posts`, `tag` → `tags` |
| `comments` | `post`*, `author`, `author_name`*, `author_email`, `body`*, `status` (pending · approved · spam), `parent` | `post` → `posts`, `author` → `authors`, `parent` → `comments` |

`*` đánh dấu field bắt buộc. Mọi relation đều là m2o, và alias của nó là tên
field, nên `author.name` hoặc `parent.title` đọc được qua nó. Các junction
taxonomy là collection tường minh.

- **Author là hồ sơ nội dung, không phải tài khoản đăng nhập.** Một author
  không thể đăng nhập, và việc cài template không tạo user, role hay
  permission nào.
- **Lựa chọn.** Các lựa chọn của `status` và `comment_status` được kiểm tra
  khi ghi. Giá trị mặc định của chúng (`draft`, `open`, `pending`) được điền
  sẵn trong form Studio; item API lưu đúng những gì nhận được và không tự điền.
- **Tính duy nhất.** Các field `slug` được khai báo `unique`, nhưng việc ghi
  item chưa bắt buộc tính duy nhất trên collection JSONB (backlog B240). Field
  relation cũng chưa được kiểm tra đích có tồn tại khi ghi (B241).
- **Demo pack.** Không có seed pack thì lần cài chỉ có schema, và cả tám
  collection đều trống. Pack `demo` thêm record tổng hợp vào mọi collection và
  qua mọi relation, gồm một trang con, một category con và một comment trả lời.
  Nó không chứa người thật, tài khoản, file hay secret nào.
- **Những gì nó không phải.** Không có PHP và không tương thích WordPress REST
  API, và không có plugin, theme, nội dung thư viện media hay hosting. Đây là
  một content model, không phải bản sao WordPress.
