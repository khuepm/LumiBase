---
version: 2
lastUpdated: 2026-09-02T19:04:59.350Z
sourceLang: en
translatedFrom: en
sourceHash: fa9835f2347614ff
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-09-02T19:04:59.350Z
codeVerifiedHash: fa9835f2347614ff
codeVerifiedClaims: 16
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

Scaffolder **không** phải dependency của `lumibase` — nó chạy một lần cho mỗi project, và các thư viện prompt/template của nó không có chỗ trong mọi lần cài một package runtime. `resolveScaffoldCommand` trong `packages/cli/src/commands/init.ts` lấy nó qua trình chạy một-lần của package manager đã gọi CLI (`npx --yes` / `pnpm dlx` / `yarn dlx` / `bunx`, đọc từ `npm_config_user_agent`; yarn classic rơi về `npx`), ghim vào đúng phiên bản của CLI (`create-lumibase@<version>`) để hai binary luôn đến từ cùng một release.

## `lumibase types`

Lấy manifest collection từ `GET /api/v1/typegen/schema` (do `apps/cms/src/routes/typegen.ts` phục vụ) rồi render bằng `generateTypes` của `@lumibase/sdk`.

```bash
lumibase types                                # -> lumibase-types.d.ts
lumibase types --out src/lumibase-types.d.ts  # custom path; directories are created
lumibase types --include articles,authors     # only these collections
lumibase types --exclude internal_logs        # skip these collections
lumibase types --no-branded                   # plain string ids instead of branded ones
lumibase types --stdout                       # print instead of writing a file
```

File sinh ra import type từ `@lumibase/sdk`, nên package đó phải được cài trong project tiêu thụ chúng (nó là dependency của `lumibase`, nhưng với layout strict của pnpm thì dependency bắc cầu không import được — hãy thêm tường minh).

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

## Liên quan

- [SDK — typegen](../sdk/typegen.md) — API lập trình nằm sau `lumibase types`
- [Bắt đầu](../getting-started.md) — chạy một CMS để CLI trỏ vào
- [npm publishing](../release/npm-publishing.md) — cách package được phát hành
