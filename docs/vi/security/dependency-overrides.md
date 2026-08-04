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
| `js-yaml` | `^4.2.0` | [CVE-2026-53550](https://github.com/advisories/GHSA-h67p-54hq-rp68) — DoS độ phức tạp bậc hai (quadratic) trong xử lý merge-key của YAML (moderate). Được kéo vào gián tiếp bởi `gray-matter@4.0.3`, vốn hard-pin js-yaml 3.x. Xem ghi chú patch bên dưới. | `gray-matter` (hoặc thứ tiêu thụ nó) phụ thuộc js-yaml `>=4.2.0` trực tiếp, **và** không dependency nào khác tái introduce range 3.x. Xác minh bằng `pnpm why js-yaml`. |
| `dompurify` | `^3.4.11` | Advisory bảo mật (đã xử lý qua Dependabot). | Một consumer trực tiếp/gián tiếp tự yêu cầu `>=3.4.11`. |
| `esbuild` | `^0.28.1` | Advisory RCE qua request tới dev-server của esbuild (`<=0.24.2`). | Mọi consumer (vite, tsx, v.v.) yêu cầu `>=0.28.1`. |
| `fast-uri` | `>=4.1.2` | [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) — host confusion do backslash chèn vào phần authority (high). Vá theo từng nhánh ở `2.4.4` / `3.1.5` / `4.1.2`; sàn phải nêu đúng bản vá 4.x, vì sàn `>=3.1.5` vẫn cho phép `4.1.1`. Vào gián tiếp qua họ validator `ajv` / fastify. | Mọi consumer tự yêu cầu `>=4.1.2`. |
| `form-data` | `^4.0.6` | Advisory bảo mật (random boundary không an toàn). | Mọi consumer yêu cầu `>=4.0.6`. |
| `postcss` | `^8.5.14` | Advisory bảo mật (đã xử lý qua Dependabot). | Mọi consumer yêu cầu `>=8.5.14`. |
| `undici` | `^7.28.0` | Advisory bảo mật (đã xử lý qua Dependabot). | Mọi consumer yêu cầu `>=7.28.0`. |
| `uuid` | `^11.1.1` | Hợp nhất phiên bản / advisory (đã xử lý qua Dependabot). | Trôi lệch phiên bản giữa các package không còn là mối lo. |
| `vite` | `^7.3.5` | Hợp nhất về Vite 7 và kéo esbuild vượt advisory RCE `0.28.1`. | Workspace không còn cần ép một major Vite duy nhất. |
| `brace-expansion@1` | `^1.1.16` | [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) — DoS do expansion thời gian mũ với các nhóm `{}` không expand liên tiếp (high), được backport về nhánh 1.x ở `1.1.16`. Chỉ dev: đi vào qua `minimatch@3` từ ESLint và các plugin. Key theo major vì hai major không tương thích cùng tồn tại trong cây — xem [Advisory không vá được](#advisory-không-vá-được) để biết vì sao không gộp 1.x vào 5.x được. | Không còn gì trong cây resolve `minimatch@3` (`pnpm why brace-expansion -r`), lúc đó hai dòng `brace-expansion@*` gộp lại làm một. |
| `brace-expansion@5` | `^5.0.8` | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) — DoS do độ dài expansion không giới hạn gây crash OOM tiến trình (high), vá ở `5.0.8`. Chỉ dev: đi vào qua `minimatch@10` từ `glob`, `eslint`, `@typescript-eslint/typescript-estree`. | Giống dòng `@1`. |
| `@types/react` | `19.2.0` | **Không phải pin bảo mật** — ép React 19 types toàn workspace để Studio/Docs/Landing/`@lumibase/ui` typecheck cùng major với runtime React 19. | Trôi lệch giữa các app không còn là mối lo, hoặc workspace cố ý tách React major trở lại. |
| `@types/react-dom` | `19.2.0` | Giống `@types/react` — nhất quán type React 19. | Giống `@types/react`. |

## Advisory không vá được

Các advisory còn mở trên GitHub nhưng không có bản vá cài được và không ảnh hưởng gate
`pnpm audit --prod --audit-level high`. Chúng không có mục ignore audit — gate đó là
`--prod` còn những thứ này nằm ngoài cây production — nên mục này là ghi chép duy nhất.

### GHSA-mh99-v99m-4gvg vẫn khớp `brace-expansion@1.1.16`

Range bị ảnh hưởng của advisory là `<= 5.0.7`, theo semver thuần thì **bao gồm mọi phiên
bản 1.x** — nên nâng nhánh 1.x lên `1.1.16` đóng được
[GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) chứ không đóng
được cái này. Phiên bản duy nhất thỏa mãn là `>=5.0.8`.

**Gộp 1.x vào 5.x sẽ làm hỏng ESLint.** `brace-expansion@1` export chính hàm đó
(`module.exports = expandTop`); bản CommonJS của 5.x export một namespace object
(`{ EXPANSION_MAX, EXPANSION_MAX_LENGTH, expand }`). `minimatch@3` — được kéo vào bởi
`eslint`, `@eslint/eslintrc`, `eslint-plugin-import`, `eslint-plugin-react` và
`eslint-plugin-jsx-a11y` — gọi `require('brace-expansion')(…)`, sẽ ném
`TypeError: m is not a function` với 5.x. Kiểm chứng trước khi xem lại:

```bash
node -e "const m=require('brace-expansion'); console.log(typeof m, Object.keys(m))"
```

**Vì sao chấp nhận rủi ro còn lại:** `brace-expansion` ở đây chỉ dùng cho dev (không xuất
hiện trong `pnpm audit --prod`), và đầu vào expansion là chính các glob pattern của ESLint
lấy từ config do repo sở hữu — không do kẻ tấn công điều khiển. Tác động là một lần chạy
lint chậm với pattern cố tình dựng, không phải DoS ở production.

**Xem lại khi** không còn gì resolve `minimatch@3`, hoặc upstream backport giới hạn độ dài
về một bản `1.1.17`.

### `glib` 0.18.5 (Rust / Tauri) — GHSA-wrw7-89jp-8q8g

`apps/shell/src-tauri/Cargo.lock` pin `glib@0.18.5`; advisory (moderate, unsoundness
trong impl `Iterator`/`DoubleEndedIterator` của `glib::VariantStrIter`) yêu cầu
`>=0.20.0`. `glib` không phải dependency trực tiếp — nó vào qua stack GTK (`gtk`, `gdk`,
`gdkx11`, `gdk-pixbuf`, `atk`, `pango`, `cairo-rs`, `gio`, `soup3`, `webkit2gtk`,
`javascriptcore-rs`, `libappindicator`), tất cả đều pin `0.18.x`. Vì vậy `cargo update -p
glib` không vượt được minor, và stack này **chỉ được compile vào bản Linux** — target
macOS (WebKit) và Windows (WebView2) không bao giờ link tới nó. Không chỗ nào trong
`apps/shell` tạo `VariantStrIter`.

**Xem lại khi** backend Linux của Tauri 2 chuyển sang thế hệ `glib` 0.20 / `gtk` 0.19+.
Kiểm bằng `cargo tree -i glib` sau khi bump `tauri`.

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
