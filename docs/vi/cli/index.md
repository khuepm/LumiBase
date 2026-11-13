---
title: LumiBase CLI
version: 10
lastUpdated: 2026-11-13T06:20:02.940Z
sourceLang: en
translatedFrom: en
sourceHash: 32b28106fb02ad1f
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-13T06:20:02.940Z
codeVerifiedHash: 32b28106fb02ad1f
codeVerifiedClaims: 20
---

# LumiBase CLI

> `lumibase` — client JS/TS và CLI trong một package: sinh type từ schema đang chạy, kiểm tra cấu hình, tạo project.

Package không scope `lumibase` (`packages/cli/`) vừa là library vừa là CLI. Entry library (`src/lib.ts`) re-export `@lumibase/sdk`, nên một project chỉ cần một tên trong `dependencies` cho cả client runtime và lệnh `lumibase`:

```bash
npm install lumibase
```

```ts
import { createLumiClient, readItems } from 'lumibase';
```

`@lumibase/sdk` vẫn là package nền bên dưới — `lumibase` phụ thuộc vào nó thay vì bundle, nên project import cả hai chỉ có một bản của mỗi class (kiểm tra `instanceof` với `LumiError`) và một bộ type. Entry library không có code riêng cho Node và an toàn để import từ bundle trình duyệt và edge.

CLI cũng có thể chạy trực tiếp:

```bash
npx lumibase --help
```

CLI yêu cầu Node.js 22+; launcher tại `packages/cli/bin/lumibase.js` từ chối các runtime cũ hơn trước khi nạp đồ thị ESM.

## Các lệnh

| Lệnh | Tác dụng |
| --- | --- |
| `lumibase init [name]` | Tạo khung một project mới |
| `lumibase types` | Sinh type TypeScript từ một CMS đang chạy |
| `lumibase doctor` | Báo cáo cấu hình đã resolve và thăm dò kết nối |
| `lumibase skills <list\|pull\|push\|install>` | Đồng bộ Site Skills (playbook cho agent) với một site |
| `lumibase migrate <source>` | Migrate nội dung từ CMS khác (Contentful); chỉ dry run nếu không có `--apply` |

`lumibase help` và `lumibase version` cũng được chấp nhận, cùng với `--help` / `-h` và `--version` / `-v`.

## Cấu hình kết nối

Mọi lệnh cần nói chuyện với CMS đều resolve ba giá trị theo thứ tự ưu tiên **flag > biến môi trường > file config**:

| Giá trị | Flag | Biến môi trường | `lumibase.config.json` |
| --- | --- | --- | --- |
| URL gốc của CMS | `--url` | `LUMIBASE_URL` | `url` |
| Site / tenant id | `--site` | `LUMIBASE_SITE_ID` | `siteId` |
| Bearer token | `--token` | `LUMIBASE_TOKEN` | — |

Token **cố ý không** đọc được từ file config, vì file đó sinh ra để commit. Khoá `token` nằm trong file sẽ bị báo lỗi thay vì âm thầm bỏ qua — xem `readConfigFile` trong `packages/cli/src/config.ts`.

```json
{
  "url": "https://api.mysite.lumibase.dev",
  "siteId": "site_abc123",
  "typegen": {
    "out": "src/lumibase-types.d.ts",
    "exclude": ["internal_logs"]
  }
}
```

File config được tìm ngược lên từ thư mục hiện tại tới gốc filesystem, nên nó vẫn resolve đúng từ bất kỳ package nào bên trong một monorepo.

Request được gửi kèm `Authorization: Bearer <token>` và `X-Lumi-Site: <siteId>` — đúng bộ header mà SDK client dùng.

## `lumibase init`

Uỷ quyền cho `create-lumibase`, nơi giữ bản cài đặt duy nhất của scaffold, để `npm create lumibase` và `lumibase init` không bao giờ lệch nhau. Mọi tham số được forward nguyên vẹn:

```bash
lumibase init my-site --template cloudflare --pm pnpm
```

Có ba template được chấp nhận — `nextjs`, `default`, và `cloudflare` (`TEMPLATES` trong `packages/create-lumibase/src/index.ts`). Không truyền `--template` thì lựa chọn thuộc về prompt, nơi **`nextjs`** được chọn sẵn: một website Next.js kèm CMS và Studio chạy trong Docker, nội dung đã seed, và một publishable key. Template *tên* `default` là starter Hono + Drizzle, không phải lựa chọn mặc định. [Bắt đầu](../getting-started.md) hướng dẫn từng loại.

Scaffolder **không** phải dependency của `lumibase` — nó chạy một lần cho mỗi project, và các thư viện prompt/template của nó không có chỗ trong mọi lần cài một package runtime. `resolveScaffoldCommand` trong `packages/cli/src/commands/init.ts` lấy nó qua trình chạy một-lần của package manager đã gọi CLI (`npx --yes` / `pnpm dlx` / `yarn dlx` / `bunx`, đọc từ `npm_config_user_agent`; yarn classic rơi về `npx`), ghim vào đúng phiên bản của CLI (`create-lumibase@<version>`) để hai binary luôn đến từ cùng một release.

Cái ghim đó có một hệ quả nên biết trước khi nó làm bạn bất ngờ: `init` lấy scaffolder từ **registry**, không phải từ repository này. Nên một template đã có trong source tree vẫn **không** dùng được qua `lumibase init` cho tới khi một bản `create-lumibase` có chứa nó được publish ở đúng phiên bản của CLI. Lệnh fail thế nào tuỳ vào độ cũ của scaffolder đã publish: các bản tới `1.0.0-rc.1` không validate `--template`, nên lệnh fail *bên trong* scaffolder với lỗi thiếu thư mục template; các bản sau đó từ chối tên ngay từ đầu với `Unknown template`, chỉ liệt kê những template mà bản đó mang theo. Dù theo cách nào thì tên vẫn hợp lệ; chỉ là artifact đã publish ra đời trước nó. `npm create lumibase@latest` cũng bị đúng ràng buộc này vì cùng lý do. Nếu bạn đang làm từ một checkout và cần một template chưa publish, hãy chạy scaffolder trực tiếp từ repo thay vì đi qua một trong hai đường vào.

## `lumibase types`

Lấy manifest collection từ `GET /api/v1/typegen/schema` (do `apps/cms/src/routes/typegen.ts` phục vụ) rồi render bằng `generateTypes` của `@lumibase/sdk`.

```bash
lumibase types                                # -> lumibase-types.d.ts
lumibase types --out src/lumibase-types.d.ts  # custom path; directories are created
lumibase types --include articles,authors     # only these collections
lumibase types --exclude internal_logs        # skip these collections
lumibase types --no-branded                   # plain string ids instead of branded ones
lumibase types --import-from @lumibase/sdk    # module the generated file imports from
lumibase types --stdout                       # print instead of writing a file
```

File sinh ra mặc định import các helper type (`ID`, `Locale`, `Brand`) từ `lumibase` (`DEFAULT_IMPORT_FROM` trong `packages/cli/src/commands/types.ts`) — chính package mà project đang chạy lệnh này đã cài. Project phụ thuộc trực tiếp vào SDK có thể trỏ import sang chỗ khác bằng `--import-from @lumibase/sdk` hoặc `typegen.importFrom` trong `lumibase.config.json`; module được nêu phải được cài trong project tiêu thụ type.

### Output tất định và `--check`

Header của file sinh ra không chứa timestamp, host hay site id. Hai máy trỏ vào cùng một schema sẽ tạo ra file giống nhau từng byte, nhờ vậy output an toàn để commit và kiểm tra trong CI:

```yaml
- run: npx lumibase types --check
```

`--check` thoát với mã khác 0 khi file thiếu hoặc đã cũ, và không bao giờ ghi gì. Khi không có `--check`, file không đổi sẽ được giữ nguyên thay vì ghi đè, nên watcher không rebuild vô ích.

## `lumibase doctor`

In ra những gì đã resolve, mỗi giá trị đến từ đâu, và CMS có trả lời hay không:

```
✔ node         v22.22.2
✔ config       /path/to/lumibase.config.json
✔ url          http://localhost:1989 (from lumibase.config.json)
✔ siteId       site_abc123 (from lumibase.config.json)
✔ token        tok_••••••••3f (from environment)
✔ health       reachable — status: healthy
✔ schema       12 collections readable
```

Bước health gọi endpoint `/health` không cần xác thực (`apps/cms/src/routes/health.ts`); bước schema thực hiện đúng request có xác thực mà `lumibase types` sẽ gửi, nên `doctor` xanh nghĩa là typegen sẽ chạy được. Token được che: giữ lại một tiền tố ngắn để người vận hành biết token nào đã được nhận diện mà giá trị thật không lọt vào log CI.

`doctor` thoát với mã khác 0 nếu có bất kỳ mục nào fail.

## `lumibase skills`

Đồng bộ [Site Skills](../features/site-skills.md) — các playbook Markdown cho agent của site — giữa một thư mục trong repository của bạn và một site. CLI chỉ chuyển file: CMS parse và validate từng tài liệu, nên định dạng chỉ có một bản cài đặt.

| Lệnh | Tác dụng |
| --- | --- |
| `lumibase skills list` | Bảng các skill của site. `--status <s>` để lọc; `--json` in các dòng thô. |
| `lumibase skills pull` | Ghi mọi skill ra `<dir>/<slug>.skill.md`. `--dir` (mặc định `skills`), `--status`. |
| `lumibase skills push` | Tạo hoặc cập nhật skill từ các file `*.md` trong `<dir>` (bỏ qua `README.md`), kể cả skill đang active. `--activate`, `--dry-run`, `--check`. |
| `lumibase skills install <src>` | Thêm skill từ một thư mục, một file `.md` đơn lẻ, hoặc một package npm đã được cài cục bộ. Không bao giờ đổi một skill đang active. `--activate`, `--dry-run`. |

```bash
lumibase skills pull
lumibase skills push --dry-run
lumibase skills push --check      # CI: exit 1 if the site differs from the directory
lumibase skills install @acme/lumibase-skills
```

- **Skill mới tới ở dạng draft.** Truyền `--activate` để kích hoạt; nếu không thì rà soát và kích hoạt trong Studio (Mission Control → Skills). Skill đã có giữ nguyên status.
- **`push` để deploy; `install` không chạm vào skill đang chạy.** `push` coi thư mục là nguồn sự thật và gửi `updateActive: true`, nên push một chỉnh sửa lên skill active sẽ đổi hành vi agent ngay lập tức. `install` thì không: một file sẽ làm đổi skill active được báo `ACTIVE_SKILL_CHANGE` và skill đang chạy được giữ nguyên — hãy rà soát nó trong Studio, hoặc deploy bằng `push`.
- **Idempotent.** File có nội dung khớp với phiên bản đang lưu được báo `unchanged` và không ghi gì.
- **Mã thoát.** `push` và `install` thoát `1` khi có tài liệu bị từ chối; các tài liệu khác vẫn được áp dụng. `--check` cũng thoát `1` khi có thứ gì sẽ được tạo hoặc cập nhật.
- **`install` không tải gì về.** Đường dẫn tồn tại được ưu tiên; nếu không, tên được resolve dưới `node_modules`, đi ngược lên từ thư mục làm việc. Bên trong một package, thư mục skill là `package.json` → `lumibase.skills`, hoặc `skills/` khi key đó vắng mặt. Tên và phiên bản package được ghi làm nguồn của phiên bản — một nhãn do CLI tự khai; tác giả do server ghi lại mới là câu trả lời có thẩm quyền cho "ai".
- **Một chiều.** `push` không bao giờ xoá: skill có trên site nhưng không có trong thư mục được để yên, và `--check` không báo nó.
- **Token.** Các endpoint nằm dưới `/api/v1/agent`, và mọi thao tác đọc và ghi skill đều cần control-plane admin, nên token cần quyền admin trên site. Chưa hỗ trợ tác giả skill không phải admin.

## `lumibase migrate contentful`

Chuyển một space Contentful vào site đang kết nối: content type thành collection,
entry thành item giữ nguyên id Contentful, asset được upload thành file, và rich
text thành JSON rich-text portable của LumiBase.

```bash
lumibase migrate contentful --file space.json                 # dry run: prints the plan
lumibase migrate contentful --file space.json --apply         # asks, then writes
lumibase migrate contentful --file space.json --apply --yes   # CI
```

Không có `--apply` thì không ghi gì. `--apply` hỏi xác nhận trước khi đổi schema;
shell không tương tác cần `--yes`. Chạy lại là an toàn: item đã có được cập nhật,
asset đã upload được bỏ qua. Các flag, bảng ánh xạ field và giới hạn:
[Content migration](../features/content-migration.md).

## Liên quan

- [SDK — typegen](../sdk/typegen.md) — API lập trình nằm sau `lumibase types`
- [Bắt đầu](../getting-started.md#bạn-thật-sự-cần-cái-nào) — starter vs platform vs consumer client, và `lumibase` nằm ở đâu
- [Phát triển cục bộ](../deployment/local-development.md) — chạy CMS và Studio mà CLI này trỏ vào
- [npm publishing](../release/npm-publishing.md) — cách package được phát hành
- [Content migration](../features/content-migration.md) — `lumibase migrate` đầy đủ
