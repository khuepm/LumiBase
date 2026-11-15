---
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:45:24.249Z
translatedFrom: en
sourceHash: ee3c803e9107939d
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T16:45:24.249Z
codeVerifiedHash: ee3c803e9107939d
codeVerifiedClaims: 10
---

# Runtime được hỗ trợ

Trang này là ma trận hỗ trợ cho các runtime và framework mà LumiBase chạy trên đó
hoặc cung cấp starter: Node.js, runtime Cloudflare Workers, PostgreSQL, Redis,
Next.js/React, và các trình duyệt chạy Studio. Trang cũng nói một phiên bản được
đưa vào ma trận ra sao, bị loại ra ra sao, và người dùng được cảnh báo trước như thế nào.

Mọi con số ở đây đều lấy từ một file trong repository hoặc từ lịch phát hành
chính thức của dự án upstream. Khi hai nguồn gặp nhau, repository là chuẩn: một
phiên bản chỉ được coi là **được hỗ trợ** khi CI chạy trên nó. Phiên bản được
chấp nhận nhưng chưa được test thì gắn nhãn **best effort**.

[Chính sách versioning](./versioning-policy.md) nói về các release của chính
LumiBase. Trang này nói về những gì các release đó chạy trên.

## Mức hỗ trợ

| Mức | Ý nghĩa |
|-----|---------|
| **Được hỗ trợ** | CI cài đặt, typecheck và test trên nó ở mọi thay đổi. Bug riêng của nó là blocker cho release. |
| **Best effort** | Các range đã khai báo chấp nhận nó, nhưng CI không chạy nó. Báo lỗi được hoan nghênh; không cam kết sửa. |
| **Không hỗ trợ** | Nằm ngoài range đã khai báo. Công cụ cảnh báo hoặc từ chối khởi động (xem [Thông báo của CLI](#thông-báo-của-cli)). |

## Node.js

LumiBase **chỉ hỗ trợ các dòng Node.js LTS**. Range được khai báo một lần duy
nhất, trong `package.json` ở root:

```json
"engines": { "node": "^22.22.2 || ^24.15.0 || >=26.0.0" }
```

Sàn patch đến từ toolchain, không phải từ sở thích: jsdom 30 (môi trường test của
Studio) khai báo đúng range này, và nanoid 6 loại các major lẻ. Một bản patch
22.x hay 24.x thấp hơn sẽ cài đặt hoặc chạy test thất bại, nên không được đưa vào.

| Dòng | Codename | Trạng thái upstream (2026-11) | Upstream hết vòng đời | LumiBase |
|------|----------|-------------------------------|-----------------------|----------|
| Node.js 22 | Jod | Maintenance LTS | 2027-04-30 | **Được hỗ trợ** từ 22.22.2 — ma trận CI, Docker image |
| Node.js 24 | Krypton | Maintenance LTS | 2028-04-30 | **Được hỗ trợ** từ 24.15.0 — ma trận CI, `.nvmrc`, gate CI chính |
| Node.js 26 | Lithium | Active LTS từ 2026-10-28 | 2029-04-30 | **Best effort** — được `>=26.0.0` chấp nhận, chưa có trong ma trận CI |
| Node.js 23, 25 | — | Hết vòng đời (lẻ, chưa từng là LTS) | 2025-06-01, 2026-06-01 | **Không hỗ trợ** — CLI cảnh báo |
| Node.js 27 | — | Alpha (phát hành 2027-04-22, LTS 2027-10-20) | 2030-04-30 | **Best effort** cho tới ngày LTS |
| Node.js ≤ 21 | — | Hết vòng đời | — | **Không hỗ trợ** — CLI từ chối khởi động |

Các mốc ngày lấy từ
[lịch phát hành](https://github.com/nodejs/Release#release-schedule) của Node.js
Release Working Group.

**"Chỉ LTS", không phải "chỉ major chẵn".** Cho tới Node.js 25, major lẻ chưa bao
giờ là LTS. Theo lịch phát hành bắt đầu từ Node.js 27, mọi major đều trở thành
LTS khoảng sáu tháng sau khi phát hành, sau một giai đoạn là "Current". Quy tắc
vẫn giữ nguyên: một dòng chuyển sang **Được hỗ trợ** khi nó đạt Active LTS và CI
chạy nó. Quy tắc không bao giờ phụ thuộc vào việc số major là chẵn hay lẻ.

### Mỗi dòng được dùng ở đâu

- **Phát triển local:** `.nvmrc` ghim `24`, cùng dòng với `NODE_VERSION` trong
  `.github/workflows/ci.yml`, nên "xanh trên máy tôi" nghĩa là xanh trên CI.
- **Gate CI chính:** `.github/workflows/ci.yml` chạy trên Node.js 24.
- **Ma trận CI:** `.github/workflows/runtime-matrix.yml` cài đặt, typecheck và
  chạy unit test của các package chính (`@lumibase/cms`, `@lumibase/studio`,
  `@lumibase/sdk`, `@lumibase/runtime`, `@lumibase/database`, `lumibase`,
  `create-lumibase`) trên Node.js 22 và Node.js 24.
- **Docker image:** `docker/Dockerfile` build trên `node:22-slim` và chạy trên
  `gcr.io/distroless/nodejs22-debian13`. Builder và runtime phải cùng một
  major.
- **CLI được publish:** `lumibase` và `create-lumibase` khai báo cùng
  `engines.node` với root và kiểm tra nó lúc khởi động.
- **`@lumibase/mcp-server`** giữ range `>=18` riêng. Range đó là hợp đồng với
  người dùng package đã publish, không phải sàn toolchain của repo.

## Cloudflare Workers

Workers không chạy một phiên bản Node.js. Chúng chạy runtime `workerd` ở một
**compatibility date** được ghim, và Cloudflare giữ cho các compatibility date
cũ vẫn hoạt động. Vì vậy ngày này là một hợp đồng mà chúng ta chủ động dời,
không bao giờ là giá trị trôi nổi.

| Ở đâu | `compatibility_date` | Flag |
|-------|----------------------|------|
| CMS (`apps/cms/wrangler.toml`) | `2024-10-01` | `nodejs_compat` |
| `create-lumibase --template cloudflare` | `2025-01-01` | `nodejs_compat` |
| Site docs (`apps/docs/wrangler.toml`) | `2026-06-01` | — |

Dời ngày của CMS là một thay đổi được review riêng. Nó phải qua
`pnpm verify:worker-bundle` và `pnpm verify:worker-startup` (khởi động Worker
dưới `workerd`), và được ghi trong CHANGELOG. `wrangler` thuộc dòng `^4`
(`package.json` ở root).

## PostgreSQL

| Phiên bản | Upstream hết vòng đời | LumiBase |
|-----------|-----------------------|----------|
| PostgreSQL 16 | 2028-11-09 | **Được hỗ trợ** — CI (`postgres:16`), `docker/docker-compose.yml` (`postgres:16-alpine`), Render blueprint (`postgresMajorVersion: "16"`) |
| PostgreSQL 15 | 2027-11-11 | **Best effort** — mức tối thiểu ghi trong deployment checklist |
| PostgreSQL 17, 18 | 2029-11-08, 2030-11-14 | **Best effort** — không chạy trong CI |

Các mốc ngày lấy từ [chính sách versioning](https://www.postgresql.org/support/versioning/)
của PostgreSQL. Trên Cloudflare, CMS kết nối Postgres qua Hyperdrive. Các phiên
bản server ở trên áp dụng như nhau.

## Redis / Valkey

Redis được runtime Docker dùng (hàng đợi BullMQ, cache); một bản cài Docker
production từ chối khởi động nếu thiếu `REDIS_URL`. Workers không dùng Redis.

| Server | LumiBase |
|--------|----------|
| Redis 7 | **Được hỗ trợ** — CI (`redis:7`), `docker/docker-compose.yml` (`redis:7-alpine`) |
| Valkey | **Best effort** — fork từ Redis 7.2 và tương thích giao thức, nhưng không chạy trong CI |
| Redis/Key Value managed (template Render, Fly, Railway) | **Best effort** — phải chạy với `noeviction`, như Render blueprint cấu hình |

## Next.js và React

Next.js có [chính sách hỗ trợ](https://nextjs.org/support-policy) riêng: major
mới nhất là **Active LTS**, và major trước đó là **Maintenance LTS** (bản vá bảo
mật và lỗi nghiêm trọng) trong hai năm kể từ ngày phát hành. Tính đến 2026-11,
Next.js 16 (phát hành 2025-10-21) là Active LTS và Next.js 15 là
Maintenance LTS. Upstream đã gia hạn các bản vá bảo mật của nó tới 2027-01-31.

LumiBase đi theo khung đó: **current và current−1** được hỗ trợ.

| Bề mặt | Khai báo | LumiBase |
|--------|----------|----------|
| `create-lumibase --template nextjs` | `next` `^15.5.4`, `react`/`react-dom` `^19.2.0` | **Được hỗ trợ** trên Next.js 15 và Next.js 16. CI scaffold nó, cài `next@^15` và `next@^16`, rồi typecheck và chạy `next build` |
| `apps/consumer`, `apps/landing` | `next` `16.4.6` / `^16.4.6`, `react` `19.3.1` / `^19.3.1` | App nội bộ, được `pnpm build` build trong CI — chỉ current |
| `examples/nextjs-blog`, `examples/nextjs-sensitive-content` | `next` `^15.5.19`, `react` `^18.3.0` | **Best effort** — nằm ngoài workspace, không chạy trong CI |
| Studio (`apps/studio`) | `react` `^19.3.1` | Chỉ React 19 |
| `@lumibase/ui` | peer `react` `^18.3.1 \|\| ^19.0.0` | React 18 và 19 |

SDK (`@lumibase/sdk`, được `lumibase` re-export) không phụ thuộc framework nào.
Nó chạy với bất kỳ phiên bản React hay Next.js nào chạy trên một dòng Node.js
được hỗ trợ.

Khi upstream phát hành một major Next.js mới, ma trận dịch lên một bậc: major mới
thành "current", current cũ thành "current−1", và major cũ nhất rời ma trận. Bản
ghim `next` của template luôn phải là một trong hai major được test
(`pnpm check:all` cưỡng chế điều này). Các bản vá bảo mật của Next.js 15 kết thúc
ngày 2027-01-31, nên mặc định của template phải chuyển sang Next.js 16 trước
ngày đó.

## Trình duyệt (Studio)

Studio được build bằng Vite 8 và dùng build target mặc định của Vite,
`baseline-widely-available`:

| Trình duyệt | Tối thiểu |
|-------------|-----------|
| Chrome / Edge | 111 |
| Firefox | 114 |
| Safari (macOS và iOS) | 16.4 |

Trình duyệt cũ hơn **không được hỗ trợ**: bundle dùng cú pháp mà chúng không
parse được. Shell desktop và mobile (`apps/shell`, Tauri) nạp cùng bản build đó
trong webview của nền tảng, nên cùng mức sàn áp dụng.

## Giá trị được ghim

`scripts/check-runtime-matrix.mjs` (thuộc `pnpm check:all`, nên cũng chạy trong
pre-commit hook và trên CI) đọc bảng này ở cả hai ngôn ngữ. Nó fail khi một giá
trị ở đây khác với repository, và khi repository tự mâu thuẫn với chính nó:

| Khoá | Giá trị |
|------|---------|
| `.nvmrc` | `24` |
| `engines.node` | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` |
| `matrix.node` | `22`, `24` |
| `matrix.next` | `15`, `16` |
| `docker.builder` | `node:22-slim` |
| `docker.runtime` | `nodejs22-debian13` |

Check này cũng cưỡng chế các điều sau:

- Các dòng Node.js của ma trận CI bằng đúng các dòng có chặn trên trong `engines.node`.
- `.nvmrc` bằng `NODE_VERSION` trong `ci.yml` và là một dòng của ma trận.
- Builder và runtime của Dockerfile dùng cùng major, và major đó là một dòng của ma trận.
- Cả hai CLI được publish khai báo đúng `engines.node` của root.
- Hai bản sao của phần kiểm tra phiên bản trong CLI giống hệt nhau.
- Template Next.js ghim một major đã được test.

## Thông báo của CLI

`lumibase` và `create-lumibase` kiểm tra phiên bản Node.js đang chạy trước khi
nạp bất cứ thứ gì khác. Chúng lấy range từ `engines.node` của chính mình, vốn
bằng range ở root nói trên, nên phần kiểm tra và chính sách có chung một nguồn:

- **Trong range** — không in gì.
- **Dưới major thấp nhất được hỗ trợ (22)** — lệnh dừng với exit code 1 và một
  thông báo nêu range được hỗ trợ cùng link tới trang này. Các dependency như
  execa 10 thậm chí không nạp được ở đó.
- **Từ 22 trở lên nhưng ngoài range** (ví dụ 22.12, 23.x hoặc 25.x) — một cảnh
  báo trên stderr, và lệnh vẫn tiếp tục.

## Tự động hoá dependency

Dependabot (`.github/dependabot.yml`) áp chính sách này lên các PR cập nhật:

- **Docker:** Dependabot không đề xuất major của image `node`. Major được dời bằng
  tay cùng với phần còn lại của ma trận. #803 đã nâng builder lên
  `node:25-slim`, một dòng không phải LTS và không có corepack, trong khi runtime
  distroless vẫn ở Node.js 22. Cập nhật digest và tag cùng major vẫn đến hằng
  tuần. Runtime image (`nodejs22-debian13`) mang major ngay trong tên image, nên
  Dependabot không bao giờ dời được nó.
- **`@types/node`:** không cập nhật major. Một major của types đi sau một thay đổi
  của ma trận runtime, không bao giờ ngược lại.
- **Next.js / React:** major của `next`, `@next/*`, `eslint-config-next`,
  `react`, `react-dom`, `@types/react` và `@types/react-dom` đến trong **một**
  PR gộp (`framework-majors`), để framework không bao giờ bị migrate dở dang.
  Cập nhật minor và patch vẫn nằm trong nhóm `minor-and-patch` hằng tuần.

**Vì sao dùng Dependabot mà không dùng Renovate:** repository đã chạy Dependabot
cho npm, GitHub Actions và Docker, và mọi quy tắc nói trên (bỏ qua major theo
từng dependency, gộp nhóm theo pattern và loại cập nhật) đều có sẵn ở đó.
Renovate sẽ thêm một bot thứ hai và một lần cài GitHub App, và thêm một file
config nữa có thể lệch. Tính năng Renovate duy nhất mà chúng ta sẽ dùng, một quy
tắc `allowedVersions` biết dòng Node.js nào là LTS, được thay bằng việc bỏ qua
major cùng với `check-runtime-matrix`. Check này làm fail mọi PR, từ bot hay từ
người, dời một major Node.js ở một chỗ duy nhất.

## Thay đổi ma trận

### Thêm một phiên bản

Khi một dòng Node.js đạt Active LTS (Node.js 26 đã đạt vào 2026-10-28):

1. Thêm nó vào `matrix.node` trong `.github/workflows/runtime-matrix.yml`.
2. Ghim nó thành một dòng có chặn trên trong `engines.node` ở root (ví dụ
   `^26.x.y`), và chép range sang `packages/cli` và
   `packages/create-lumibase`.
3. Cập nhật bảng [giá trị được ghim](#giá-trị-được-ghim) ở cả hai ngôn ngữ.
4. Chạy `pnpm check:all`, rồi để ma trận chạy xanh.

Khi một major Next.js mới phát hành, thay mục cũ nhất của `matrix.next` bằng nó,
rồi cập nhật trang này và template nếu bản ghim của template rơi ra khỏi ma trận.

### Loại bỏ một phiên bản

Một phiên bản rời ma trận khi nó hết vòng đời ở upstream, hoặc khi một dependency
mà sản phẩm cần đòi phiên bản mới hơn. Gỡ nó khỏi `engines.node` là một
**breaking change** theo [chính sách versioning](./versioning-policy.md), nên
các bước sau được áp dụng:

1. **Thông báo:** trong một release minor, liệt kê phiên bản đó dưới mục
   `Deprecated` trong CHANGELOG, đánh dấu nó ở đây kèm release sẽ gỡ, và giữ nó
   trong CI.
2. **Gỡ bỏ:** sớm nhất là ở release major kế tiếp, bỏ nó khỏi `engines.node`, ma
   trận CI và trang này trong cùng một PR. Từ đó trở đi CLI cảnh báo khi gặp nó,
   hoặc từ chối nếu nó thấp hơn major thấp nhất mới.

Hết vòng đời ở upstream không chờ chu kỳ release của chúng ta. Nếu một phiên bản
hết vòng đời mà không có release major nào ở giữa, nó chuyển sang **best effort**
vào ngày đó. Nó vẫn cài được cho tới khi major kế tiếp gỡ nó, và các bản vá bảo
mật cần runtime mới hơn được ghi rõ như vậy.

### Dời Docker image sang major khác

Đổi builder `FROM node:<M>-slim` và runtime
`FROM gcr.io/distroless/nodejs<M>-debian13` trong cùng một PR, với digest mới cho
cả hai, và cập nhật [giá trị được ghim](#giá-trị-được-ghim). `<M>` phải là một
dòng của ma trận CI. Sau đó smoke test image của workflow release sẽ chạy image
trên major mới.
