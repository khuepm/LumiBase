# Dependency Overrides & Patches (Ghi đè và vá dependency)

Tài liệu này theo dõi mọi pin `pnpm.overrides` và patch `pnpm.patchedDependencies`
trong [`package.json`](../../../package.json) gốc, lý do mỗi mục tồn tại, và điều kiện
để có thể gỡ bỏ an toàn.

> **Vì sao có file này:** override và patch là những "footgun" vô hình — chúng âm thầm
> thay đổi phiên bản của một transitive dependency mà cả workspace resolve tới. Không có
> ghi chép *lý do*, một maintainer sau này không thể phân biệt đâu là pin bảo mật cố ý với
> tàn dư thừa, và gỡ nhầm một mục có thể âm thầm tái tạo lỗ hổng. Cập nhật bảng này mỗi khi
> bạn thêm, đổi, hoặc gỡ một mục dưới key `pnpm` trong `package.json`.

## Cơ chế override ở đây

- **`pnpm.overrides`** ép một phiên bản resolved duy nhất của một package trên toàn
  workspace, bao gồm cả các transitive dependency vốn yêu cầu một range khác (thường là
  range dính lỗ hổng).
- **`pnpm.patchedDependencies`** áp một source patch cục bộ vào package đã cài. Patch nằm
  trong [`patches/`](../../../patches/) và được tham chiếu theo phiên bản chính xác.
  Tạo lại bằng `pnpm patch <pkg>@<version>` → sửa → `pnpm patch-commit <dir>`.

Sau khi thay đổi một trong hai, chạy `pnpm install` để lockfile (`pnpm-lock.yaml`) ghi lại
resolution / patch hash mới.

## Registry overrides

| Package | Pin tới | Lý do | Gỡ khi |
| --- | --- | --- | --- |
| `js-yaml` | `^4.3.0` | [CVE-2026-53550](https://github.com/advisories/GHSA-h67p-54hq-rp68) — DoS độ phức tạp bậc hai (quadratic) trong xử lý merge-key của YAML (moderate). Được kéo vào gián tiếp bởi `gray-matter@4.0.3`, vốn hard-pin js-yaml 3.x. Xem ghi chú patch bên dưới. | `gray-matter` (hoặc thứ tiêu thụ nó) phụ thuộc js-yaml `>=4.2.0` trực tiếp, **và** không dependency nào khác tái introduce range 3.x. Xác minh bằng `pnpm why js-yaml`. |
| `dompurify` | `^3.4.11` | Advisory bảo mật (đã xử lý qua Dependabot). | Một consumer trực tiếp/gián tiếp tự yêu cầu `>=3.4.11`. |
| `esbuild` | `^0.28.1` | Advisory RCE qua request tới dev-server của esbuild (`<=0.24.2`). | Mọi consumer (vite, tsx, v.v.) yêu cầu `>=0.28.1`. |
| `form-data` | `^4.0.6` | Advisory bảo mật (random boundary không an toàn). | Mọi consumer yêu cầu `>=4.0.6`. |
| `fast-uri` | `>=4.1.2` | [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) — **high**, host confusion qua backslash authority introducer (`>=4.0.0 <4.1.2`). Đi vào qua `ajv@8` dưới `@hookform/resolvers` (Studio) và `@modelcontextprotocol/sdk` (`packages/mcp-server`). Pin cũ là `>=3.1.4`, vẫn cho phép bản 4.1.1 có lỗ hổng. | `ajv` (hoặc thứ tiêu thụ nó) phụ thuộc fast-uri `>=4.1.2` trực tiếp, và không dependency nào khác tái introduce range thấp hơn. Xác minh bằng `pnpm why fast-uri`. |
| `postcss` | `^8.5.25` | Advisory bảo mật (đã xử lý qua Dependabot). | Mọi consumer yêu cầu `>=8.5.25`. |
| `undici` | `^7.28.0` | Advisory bảo mật (đã xử lý qua Dependabot). | Mọi consumer yêu cầu `>=7.28.0`. |
| `uuid` | `^14.0.1` | Hợp nhất phiên bản / advisory (đã xử lý qua Dependabot). | Trôi lệch phiên bản giữa các package không còn là mối lo. |
| `vite` | `^8.2.0` | Hợp nhất về Vite 8 và kéo esbuild vượt advisory RCE `0.28.1`. | Workspace không còn cần ép một major Vite duy nhất. |
| `@types/react` | `19.2.18` | **Không phải pin bảo mật** — ép React 19 types toàn workspace để Studio/Docs/Landing/`@lumibase/ui` typecheck cùng major với runtime React 19. | Trôi lệch giữa các app không còn là mối lo, hoặc workspace cố ý tách React major trở lại. |
| `@types/react-dom` | `19.2.4` | Giống `@types/react` — nhất quán type React 19. | Giống `@types/react`. |

## Registry patches

### `gray-matter@4.0.3` → [`patches/gray-matter@4.0.3.patch`](../../../patches/gray-matter@4.0.3.patch)

**Nó làm gì:** viết lại YAML engine của gray-matter
(`lib/engines.js`) từ `yaml.safeLoad` / `yaml.safeDump` (đã bị gỡ) sang
`yaml.load` / `yaml.dump`.

**Vì sao cần:** `gray-matter@4.0.3` là bản phát hành mới nhất và thực chất đã ngừng bảo trì.
Nó hard-pin `js-yaml@^3.13.1` và gọi `safeLoad`/`safeDump`. Các hàm đó đã bị **gỡ bỏ** trong
js-yaml 4.x (nơi `load`/`dump` an toàn mặc định — và `safeLoad` là stub *ném lỗi*). Vì
override `js-yaml: ^4.2.0` (ở trên) nâng js-yaml toàn cây để vá
[CVE-2026-53550](https://github.com/advisories/GHSA-h67p-54hq-rp68), gray-matter sẽ crash
lúc parse nếu không có patch này. gray-matter chỉ được dùng ở thời điểm build/dev trong
[`apps/docs`](../../../apps/docs/src/plugins/vite-plugin-docs-loader.ts) để parse front
matter Markdown thuộc repo (tin cậy).

**Gỡ khi:** `gray-matter` phát hành bản tương thích js-yaml `>=4.2.0` (khi đó bỏ cả nhu cầu
do override lẫn patch này), **hoặc** `apps/docs` ngừng dùng `gray-matter` (ví dụ thay bằng
một parser front-matter nhỏ trong repo gọi thẳng `load()` của js-yaml 4.x). Sau khi gỡ, xóa
mục này, mục `patchedDependencies` trong `package.json`, và file patch, rồi chạy lại
`pnpm install`.

## Ghi chú Dependabot

`js-yaml` sẽ tiếp tục hiện lên như một alert transitive *không thể fix* chừng nào
`gray-matter` còn trong cây, vì Dependabot không thể tự nâng `gray-matter` vượt ràng buộc
js-yaml 3.x của nó — chính override + patch ở trên mới thực sự xử lý. Nếu alert lặp lại gây
nhiễu, dismiss nó trên GitHub với lý do **"advisory này đã được xử lý qua pnpm override +
patch"** (kèm link tài liệu này), thay vì bỏ qua toàn bộ package — vì bỏ qua kiểu blanket
cũng sẽ che mất một advisory js-yaml *thật sự chưa được vá trong tương lai*.
