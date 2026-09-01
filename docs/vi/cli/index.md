---
version: 1
lastUpdated: 2026-08-01T23:58:19.962Z
sourceLang: en
translatedFrom: en
sourceHash: cfd657c0ddf0a6f6
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-08-01T23:58:19.962Z
codeVerifiedHash: cfd657c0ddf0a6f6
codeVerifiedClaims: 14
---

# LumiBase CLI

> `lumibase` — tạo project, sinh type từ schema đang chạy, và kiểm tra cấu hình.

CLI được publish dưới tên package không scope là `lumibase` (`packages/cli/`). Cài như một dev dependency, hoặc chạy nhanh bằng `npx`.

```bash
npm install -D lumibase
npx lumibase --help
```

Yêu cầu Node.js 22+; launcher tại `packages/cli/bin/lumibase.js` từ chối các runtime cũ hơn trước khi nạp đồ thị ESM.

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

## `lumibase types`

Lấy manifest collection từ `GET /api/v1/typegen/schema` (do `apps/cms/src/routes/typegen.ts` phục vụ) rồi render bằng `generateTypes` của `@lumibase/sdk`.

```bash
lumibase types                                # -> lumibase-types.d.ts
lumibase types --out src/lumibase-types.d.ts  # đường dẫn tuỳ ý; thư mục được tạo tự động
lumibase types --include articles,authors     # chỉ những collection này
lumibase types --exclude internal_logs        # bỏ qua những collection này
lumibase types --no-branded                   # id kiểu string thường thay vì branded
lumibase types --stdout                       # in ra stdout thay vì ghi file
```

File sinh ra import type từ `@lumibase/sdk`, nên package đó phải được cài trong project tiêu thụ chúng.

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
