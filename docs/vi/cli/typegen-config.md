---
title: Cấu hình typegen và target đầu ra
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:52:33.839Z
translatedFrom: en
sourceHash: 87ae65be8601739a
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T16:52:33.839Z
codeVerifiedHash: 87ae65be8601739a
codeVerifiedClaims: 8
---

# Cấu hình typegen và target đầu ra

> Một lần chạy `lumibase types`, nhiều cấu hình, nhiều đầu ra: TypeScript, validator Zod, GraphQL SDL và tài liệu OpenAPI 3.1 — từ một CMS đang chạy hoặc từ một manifest đã lưu.

Bản thân `lumibase types` ghi một file TypeScript (xem [hướng dẫn CLI](./index.md#lumibase-types)). Khi dự án cần nhiều hơn — một web app và một admin app đọc các collection khác nhau, một file Zod để kiểm tra lúc chạy, một file SDL cho trình sinh client GraphQL — hãy đặt thiết lập vào một **file cấu hình typegen** thay vì trên dòng lệnh.

## File cấu hình

`lumibase types` tìm, đi ngược lên từ thư mục làm việc, file đầu tiên trong số:

- `lumibase.typegen.config.ts`
- `lumibase.typegen.config.mts`
- `lumibase.typegen.config.js`
- `lumibase.typegen.config.mjs`
- `lumibase.typegen.config.json`

(`TYPEGEN_CONFIG_FILENAMES` trong `packages/cli/src/typegen/load-config.ts`), hoặc file truyền bằng `--config <path>`. Khi tìm thấy, mọi cấu hình trong file đều chạy; khi không có, `lumibase types` giữ hành vi một file như cũ.

File export một cấu hình hoặc một **mảng** cấu hình:

```ts
// lumibase.typegen.config.ts
import { defineTypegenConfig } from 'lumibase'

export default defineTypegenConfig([
  {
    name: 'web',
    include: ['articles', 'authors'],
    targets: [
      { type: 'ts', out: 'apps/web/src/lumibase-types.d.ts' },
      { type: 'zod', out: 'apps/web/src/lumibase-schemas.ts' },
    ],
  },
  {
    name: 'admin',
    source: { urlEnv: 'STAGING_LUMIBASE_URL', site: 'site_admin', tokenEnv: 'STAGING_LUMIBASE_TOKEN' },
    exclude: ['internal_logs'],
    targets: [
      { type: 'graphql-sdl', out: 'apps/admin/schema.graphql' },
      { type: 'openapi', out: 'apps/admin/openapi.json' },
    ],
  },
])
```

Cấu hình `.ts` / `.mts` được nạp bằng [jiti](https://github.com/unjs/jiti), một loader nhỏ không có dependency (loader mà ESLint và Tailwind dùng cho cấu hình TypeScript của chúng), vì Node 22 trước bản 22.18 không import được TypeScript nếu không bật cờ. Nó chỉ được import khi cấu hình là TypeScript; cấu hình `.js`, `.mjs` và `.json` dùng thẳng Node.

Đường dẫn đầu ra và manifest tính tương đối so với file cấu hình. Hai target không được ghi cùng một đường dẫn — lần chạy từ chối trước khi tải bất cứ thứ gì.

### Các key cấu hình

| Key | Kiểu | Mô tả |
|-----|------|-------|
| `name` | `string` | Nhãn trong các dòng log (mặc định `config #<n>`) |
| `source` | object | Manifest lấy từ đâu — xem bên dưới (mặc định: thiết lập kết nối thông thường) |
| `include` | `string[]` | Chỉ các collection này |
| `exclude` | `string[]` | Bỏ qua các collection này |
| `targets` | array | Một hoặc nhiều đầu ra (bắt buộc) |

### Nguồn

**CMS đang chạy** — `{ url?, site?, urlEnv?, siteEnv?, tokenEnv? }`. Mỗi giá trị rơi về cách resolve thông thường (flag > biến môi trường > `lumibase.config.json`). `urlEnv` / `siteEnv` / `tokenEnv` đặt tên biến môi trường cần đọc, nhờ vậy hai cấu hình có thể trỏ tới hai site với hai token; một biến được đặt tên mà không được set là lỗi, không âm thầm rơi về mặc định. Key `token` bị từ chối: file cấu hình là để commit.

**Manifest đã lưu** — `{ manifest: './lumibase.manifest.json' }`. Đọc một file chứa manifest, hoặc nguyên response của `GET /api/v1/typegen/schema` (`{ data: … }`). Không cần mạng, không cần token — hữu ích cho job CI không với tới CMS. Ghi file này bằng target `manifest`.

Các cấu hình dùng chung một nguồn sẽ dùng chung một lần tải mỗi lần chạy; `include` / `exclude` áp dụng theo từng cấu hình.

### Target

| `type` | Đầu ra | Tuỳ chọn |
|--------|--------|----------|
| `ts` | Interface TypeScript — đầu ra `generateTypes` hiện có | `branded` (mặc định `true`), `importFrom` (mặc định `lumibase`) |
| `zod` | Validator Zod: `<Name>Schema`, `type <Name> = z.infer<…>`, map `LumibaseSchemas` | `importFrom` (mặc định `zod`) |
| `graphql-sdl` | SDL của schema mà CMS phục vụ tại `/graphql` | — |
| `openapi` | Tài liệu OpenAPI 3.1 với `components.schemas` (JSON) | `title`, `version` |
| `manifest` | Chính manifest (JSON, đã bỏ site id) | — |

Mọi đầu ra đều tất định — không có host, site id hay timestamp — nên `--check` cho cùng một kết quả trên mọi instance có cùng schema.

## Mỗi target sinh ra gì

Các generator nằm trong SDK (`packages/sdk/src/typegen/`) và được export từ `@lumibase/sdk` dưới tên `generateTypes`, `generateZod`, `generateGraphQLSdl` và `generateOpenApi`, nên cũng có thể gọi từ script của bạn.

**Ánh xạ field dùng chung cho `ts`, `zod` và `openapi`:** field không `required` là optional; field không required hoặc `nullable` còn chấp nhận `null`. Field có interface `translatable-text` là một map theo locale (`Partial<Record<Locale, string>>` trong TS); field `file` là chuỗi id của file; field `files` là mảng id file; `json` là `unknown`; field mã hoá còn có thể là `'***'` (bị che với caller không có `read_decrypted`).

**`zod`** bám theo kiểu TS với hai khác biệt có chủ đích, cả hai đều nghiêng về thứ API thực sự trả về: id có brand được kiểm tra như chuỗi thường (brand chỉ là dấu hiệu lúc biên dịch), và quan hệ to-many chấp nhận một id *hoặc* một object đã expand cho mỗi phần tử. File sinh ra chỉ dùng API chung của Zod 3 và Zod 4.

**`graphql-sdl`** phản chiếu `apps/cms/src/graphql/schema-builder.ts`: cùng tên kiểu (`blog_posts` → `BlogPosts`), các cột cấu trúc (`id`, `status`, `sort`, `createdAt`, …, `_data`), ánh xạ scalar của `type-mapping.ts`, field m2o lồng nhau và field danh sách o2m, cùng các root `Query` / `Mutation` / `Subscription`. Một test (`apps/cms/src/graphql/__tests__/sdl-parity.test.ts`) dựng cả hai và so sánh từng field. Với CMS cũ hơn bản phát hành này, manifest thiếu kiểu lưu trữ của mỗi quan hệ, nên các field o2m phía "one" bị bỏ qua.

**`openapi`** dùng tên component của tài liệu live theo từng caller: `<collection>.Fields`, `.Item` (cột hệ thống ở cấp trên cùng, field người dùng nằm dưới `data`), `.Projection` (dạng phẳng của `?fields=`), `.CreateInput`, `.UpdateInput`, cùng các envelope `{ data, meta }` `.Response` và `.ListResponse`, và `PaginationMeta`, `ErrorObject`, `ErrorResponse` dùng chung. Field nullable dùng `type: [T, 'null']`, enum dùng `enum`. Nó mô tả mọi collection trong manifest; không có path và không có góc nhìn theo role.

## `--check` trong CI

```bash
lumibase types --check
```

Render mọi target của mọi cấu hình, so từng cái với file trên đĩa, in một dòng cho mỗi đầu ra và thoát `1` khi có file thiếu hoặc lỗi thời. Không ghi gì.

## `--watch`

```bash
lumibase types --watch                 # poll every 2 s
lumibase types --watch --interval 5000
```

Chạy một lần, sau đó poll từng nguồn riêng biệt và chỉ sinh lại các cấu hình có nguồn thay đổi:

- **CMS đang chạy** — `GET /api/v1/typegen/schema` giờ trả về một `ETag` yếu, và watcher gửi `If-None-Match`; `304` nghĩa là không có gì phải làm. CMS chưa hỗ trợ ETag vẫn chạy được: body giống hệt được coi là không đổi.
- **Manifest đã lưu** — mỗi vòng kiểm tra mtime và kích thước file, rồi tới nội dung.

Lần poll lỗi sẽ lùi lại theo cấp số nhân (gấp đôi, tối đa 60 giây) và trở về chu kỳ bình thường sau lần thành công kế tiếp. `Ctrl+C` để dừng. `--watch` cũng chạy khi không có file cấu hình, cho đầu ra TypeScript duy nhất mà các flag mô tả. Nó không nạp lại chính file cấu hình — hãy khởi động lại sau khi sửa.

## Flag và file cấu hình

Khi có file cấu hình, các flag một-đầu-ra `--out`, `--include`, `--exclude`, `--no-branded`, `--import-from` và `--stdout` bị từ chối thay vì âm thầm bỏ qua — hãy đặt chúng trong cấu hình. `--url`, `--site` và `--token` vẫn áp dụng, làm giá trị mặc định cho nguồn live.

## Liên quan

- [Hướng dẫn CLI](./index.md) — thiết lập kết nối và các lệnh khác
- [SDK — typegen](../sdk/typegen.md) — gọi các generator từ code
