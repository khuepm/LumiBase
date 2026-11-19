---
version: 1
lastUpdated: 2026-11-19T06:06:09.106Z
sourceLang: en
translatedFrom: en
sourceHash: 6bda70c8176b1e84
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T06:06:09.106Z
codeVerifiedHash: 6bda70c8176b1e84
codeVerifiedClaims: 2
---

# Backend templates

Một **backend template** là một tài liệu JSON mô tả một content model hoàn
chỉnh: các collection, field, validation, giá trị mặc định, metadata hiển thị,
lựa chọn lưu trữ và relation, cộng dữ liệu demo tuỳ chọn. Từ nó, bạn có thể cài
cùng model đó vào một site khác. Epic #900; đặc tả
`.kiro/specs/backend-templates/`.

> **Trạng thái.** Trang này mô tả **định dạng** template và bộ validator của
> nó, hiện đã có trong `@lumibase/contracts/backend-templates` (#901). Catalog
> template, preview/plan, cài đặt có governance, MCP tool và màn hình Studio do
> #902–#909 đảm nhận. Cho tới khi chúng xong, chưa có gì trong CMS đọc hay cài
> một template.

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
