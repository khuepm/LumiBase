---
version: 1
lastUpdated: 2026-08-23T18:32:17.000Z
sourceLang: en
translatedFrom: en
sourceHash: 37b4156f0b315dad
mtEngine: manual
syncStatus: human-translated
---

# Dependency Overrides & Patches (Ghi đè và vá dependency)

Tài liệu này theo dõi mọi pin `overrides`, patch `patchedDependencies` và loại trừ
`auditConfig.ignoreGhsas`: lý do mỗi mục tồn tại, và điều kiện để có thể gỡ bỏ an toàn.

**Cả ba đều được khai hai lần, có chủ đích.** pnpm 9 — bản đang pin — đọc chúng từ key
`pnpm` trong [`package.json`](../../../package.json) gốc. pnpm 10+ lại đọc từ
[`pnpm-workspace.yaml`](../../../pnpm-workspace.yaml), và chỉ cảnh báo một dòng về key
trong `package.json` trước khi bỏ qua nó. Giữ cả hai nghĩa là một lần nâng pnpm trong
tương lai sẽ không âm thầm làm mất các override bảo mật, patch `gray-matter`, hay audit
ignore (#295). `pnpm settings:check` sẽ fail CI khi hai bản lệch nhau; khi nào bỏ hỗ trợ
pnpm 9 thì xoá key `pnpm` khỏi `package.json` cùng với script đó.

> **Vì sao có file này:** override và patch là những "footgun" vô hình — chúng âm thầm
> thay đổi phiên bản của một transitive dependency mà cả workspace resolve tới. Không có
> ghi chép *lý do*, một maintainer sau này không thể phân biệt đâu là pin bảo mật cố ý với
> tàn dư thừa, và gỡ nhầm một mục có thể âm thầm tái tạo lỗ hổng. Cập nhật bảng này mỗi khi
> bạn thêm, đổi, hoặc gỡ một mục — **ở cả hai file**.

## Cơ chế override ở đây

- **`overrides`** ép một phiên bản resolved duy nhất của một package trên toàn
  workspace, bao gồm cả các transitive dependency vốn yêu cầu một range khác (thường là
  range dính lỗ hổng).
- **`patchedDependencies`** áp một source patch cục bộ vào package đã cài. Patch nằm
  trong [`patches/`](../../../patches/) và được tham chiếu theo phiên bản chính xác.
  Tạo lại bằng `pnpm patch <pkg>@<version>` → sửa → `pnpm patch-commit <dir>`.
- **`auditConfig.ignoreGhsas`** loại một advisory cụ thể khỏi cổng
  `pnpm audit --prod --audit-level high` trong
  [`ci.yml`](../../../.github/workflows/ci.yml). **Chỉ** dùng khi advisory đó về mặt cấu
  trúc không áp dụng được vào cách ta tiêu thụ package và không có bản đã vá nào cài
  được — tuyệt đối không dùng để dập một rủi ro thật. Mỗi mục cần một dòng ở bảng dưới.

Sau khi thay đổi một trong hai, chạy `pnpm install` để lockfile (`pnpm-lock.yaml`) ghi lại
resolution / patch hash mới, rồi `pnpm settings:check` để xác nhận hai bản khai vẫn khớp nhau.

## Registry overrides

| Package | Pin tới | Lý do | Gỡ khi |
| --- | --- | --- | --- |
| `js-yaml` | `^4.3.1` | [CVE-2026-53550](https://github.com/advisories/GHSA-h67p-54hq-rp68) — DoS độ phức tạp bậc hai (quadratic) trong xử lý merge-key của YAML (moderate), và [GHSA-mxjm-jjmh-r63x](https://github.com/advisories/GHSA-mxjm-jjmh-r63x) — tiêu thụ CPU bậc hai khi resolve `!!omap`, chưa vá ở dưới `4.3.1` (high). Được kéo vào gián tiếp bởi `gray-matter@4.0.3`, vốn hard-pin js-yaml 3.x. Xem ghi chú patch bên dưới. | `gray-matter` (hoặc thứ tiêu thụ nó) phụ thuộc js-yaml `>=4.2.0` trực tiếp, **và** không dependency nào khác tái introduce range 3.x. Xác minh bằng `pnpm why js-yaml`. |
| `dompurify` | `^3.4.13` | Advisory bảo mật (đã xử lý qua Dependabot), sau đó nâng thêm vì [GHSA-8v5p-ggcr-6q56](https://github.com/advisories/GHSA-8v5p-ggcr-6q56) — việc gỡ hook `IN_PLACE` để lại một subtree bị tách rời, cho phép bypass sanitizer ở `<=3.4.12` (moderate). | Một consumer trực tiếp/gián tiếp tự yêu cầu `>=3.4.13`. |
| `esbuild` | `^0.28.1` | Advisory RCE qua request tới dev-server của esbuild (`<=0.24.2`). | Mọi consumer (vite, tsx, v.v.) yêu cầu `>=0.28.1`. |
| `form-data` | `^4.0.6` | Advisory bảo mật (random boundary không an toàn). | Mọi consumer yêu cầu `>=4.0.6`. |
| `postcss` | `^8.5.24` | Advisory bảo mật (đã xử lý qua Dependabot). | Mọi consumer yêu cầu `>=8.5.24`. |
| `nanoid@3` | `^3.3.17` | [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) — generator tuỳ biến lặp vô hạn khi `size` bằng 0, chưa vá ở dưới `3.3.17` (high). Chỉ tới được gián tiếp: `next` → `postcss` → `nanoid@3`. Giới hạn trong range 3.x để không đánh nhau với pin 5.x bên dưới. | `postcss` (hoặc thứ tiêu thụ nó) yêu cầu `nanoid >=3.3.17`. Xác minh bằng `pnpm why nanoid`. |
| `nanoid@5` | `^5.1.16` | [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) — generator không-an-toàn lặp vô hạn với size âm, chưa vá ở dưới `5.1.16` (high). Đây chính là range mà `apps/cms` và `packages/database` khai trực tiếp (`^5.0.7`) để sinh ID cho domain table, nên pin này nâng sàn mà không ép đổi major. | Cả hai package tự khai `>=5.1.16`, lúc đó override thành thừa. |
| `undici` | `^7.28.0` | Advisory bảo mật (đã xử lý qua Dependabot). | Mọi consumer yêu cầu `>=7.28.0`. |
| `uuid` | `^11.1.1` | Hợp nhất phiên bản / advisory (đã xử lý qua Dependabot). | Trôi lệch phiên bản giữa các package không còn là mối lo. |
| `vite` | `^7.3.5` | Hợp nhất về Vite 7 và kéo esbuild vượt advisory RCE `0.28.1`. | Workspace không còn cần ép một major Vite duy nhất. |
| `@types/react` | `19.2.0` | **Không phải pin bảo mật** — ép React 19 types toàn workspace để Studio/Docs/Landing/`@lumibase/ui` typecheck cùng major với runtime React 19. | Trôi lệch giữa các app không còn là mối lo, hoặc workspace cố ý tách React major trở lại. |
| `@types/react-dom` | `19.2.0` | Giống `@types/react` — nhất quán type React 19. | Giống `@types/react`. |

## Bảng audit ignore

| Advisory | Package | Lý do | Gỡ khi |
| --- | --- | --- | --- |
| [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) | `react-router` `7.18.1` (qua `apps/docs > react-router-dom@7.18.1`) | **High — bypass CSRF ở RSC Mode cho phép action chạy trước khi trả về 400.** Không áp dụng được vào cách `apps/docs` tiêu thụ router, và không vá tại chỗ được. Xem phân tích bên dưới. | `apps/docs` chuyển được sang `react-router@>=8.3.0`, vốn yêu cầu React `>=19.2.7` (xem phân tích). Khi đó bỏ `react-router-dom`, chuyển import, rồi xoá dòng này. |

### Vì sao GHSA-qwww-vcr4-c8h2 không khai thác được ở đây

**Đường code dính lỗ hổng đòi RSC mode kèm server action.** `apps/docs` không có cái nào:

- **Không có RSC mode.** App là một SPA Vite thuần dùng `createBrowserRouter`, cộng
  `createStaticHandler` / `createStaticRouter` / `StaticRouterProvider` để prerender lúc
  build. Không chỗ nào import các entry point RSC của React Router.
- **Không có action nào để chạy.** Tác động của advisory là *thực thi action*; trình xem
  docs chỉ đọc, không định nghĩa route `action`, `Form`, `useFetcher`, hay `useSubmit`.
- **Không có server lúc chạy.** `pnpm build` render ra HTML tĩnh rồi xoá bundle SSR
  (`&& rm -rf dist-ssr` trong [`apps/docs/package.json`](../../../apps/docs/package.json)),
  nên artifact đã deploy không còn bề mặt xử lý request nào cho CSRF nhắm vào.

**Vì sao không nâng thẳng được.** Range đã vá của advisory là `>=8.3.0`, còn
`react-router-dom` đã ngừng sau `7.18.1` — không có 8.x dưới tên đó, và 7.x không được
backport (`7.18.1` là bản 7.x cuối). Vì vậy cách vá nghĩa là migrate `apps/docs` khỏi
`react-router-dom` sang `react-router@8`, vốn khai peer `react >=19.2.7` /
`react-dom >=19.2.7` và `engines.node >=22.22.0`. Workspace hiện nhắm React 19 cho
Studio/Docs/Landing (`@lumibase/ui` peer `^18.3.1 || ^19.0.0`, `engines.node >=22`).
Migrate `apps/docs` sang `react-router@8` vẫn là việc follow-up cần phối hợp (không phải
một lần bump phiên bản đơn thuần).

**Kiểm tra phạm vi:** `apps/studio` không bị ảnh hưởng — nó dùng `@tanstack/react-router`,
một package không liên quan. `react-router-dom` chỉ xuất hiện ở `apps/docs`.

## Registry patches

### `gray-matter@4.0.3` → [`patches/gray-matter@4.0.3.patch`](../../../patches/gray-matter@4.0.3.patch)

**Nó làm gì:** viết lại YAML engine của gray-matter
(`lib/engines.js`) từ `yaml.safeLoad` / `yaml.safeDump` (đã bị gỡ) sang
`yaml.load` / `yaml.dump`.

**Vì sao cần:** `gray-matter@4.0.3` là bản phát hành mới nhất và thực chất đã ngừng bảo trì.
Nó hard-pin `js-yaml@^3.13.1` và gọi `safeLoad`/`safeDump`. Các hàm đó đã bị **gỡ bỏ** trong
js-yaml 4.x (nơi `load`/`dump` an toàn mặc định — và `safeLoad` là stub *ném lỗi*). Vì
override `js-yaml: ^4.3.1` (ở trên) nâng js-yaml toàn cây để vá
[CVE-2026-53550](https://github.com/advisories/GHSA-h67p-54hq-rp68), gray-matter sẽ crash
lúc parse nếu không có patch này. gray-matter chỉ được dùng ở thời điểm build/dev trong
[`apps/docs`](../../../apps/docs/src/plugins/vite-plugin-docs-loader.ts) để parse front
matter Markdown thuộc repo (tin cậy).

**Gỡ khi:** `gray-matter` phát hành bản tương thích js-yaml `>=4.2.0` (khi đó bỏ cả nhu cầu
do override lẫn patch này), **hoặc** `apps/docs` ngừng dùng `gray-matter` (ví dụ thay bằng
một parser front-matter nhỏ trong repo gọi thẳng `load()` của js-yaml 4.x). Sau khi gỡ, xóa
mục này, mục `patchedDependencies` trong **cả** `package.json` **và** `pnpm-workspace.yaml`,
và file patch, rồi chạy lại
`pnpm install`.

## Ghi chú Dependabot

`js-yaml` sẽ tiếp tục hiện lên như một alert transitive *không thể fix* chừng nào
`gray-matter` còn trong cây, vì Dependabot không thể tự nâng `gray-matter` vượt ràng buộc
js-yaml 3.x của nó — chính override + patch ở trên mới thực sự xử lý. Nếu alert lặp lại gây
nhiễu, dismiss nó trên GitHub với lý do **"advisory này đã được xử lý qua pnpm override +
patch"** (kèm link tài liệu này), thay vì bỏ qua toàn bộ package — vì bỏ qua kiểu blanket
cũng sẽ che mất một advisory js-yaml *thật sự chưa được vá trong tương lai*.
