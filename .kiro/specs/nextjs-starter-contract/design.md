# Design Document — Next.js starter contract (#332, handoff A-02)

> **Trạng thái: ĐỀ XUẤT — chưa được cấp grant, chưa implement.**
> Handoff A-02 (#332) yêu cầu chốt contract *trước* khi viết code. Tài liệu này
> là đầu ra của bước đó: đề xuất template, hai đường backend, mô hình nội dung
> và public client, kèm bảng file/env/lệnh xin cấp phát.
>
> Baseline: main `6a20441af5dde899b976479f0ed7f8d1a9341dee`.
> Mọi khẳng định dưới đây đã verify trên source tree / registry và có trích dẫn.
> Chỗ chưa verify được ghi rõ `[Unverified]`.

## 1. Tổng quan

Mục tiêu #332: một người dùng mới, **ngoài monorepo**, tạo được website Next.js,
kết nối CMS/Studio, thấy nội dung seed, sửa & publish trong Studio rồi đọc thay
đổi trên website **bằng quyền tối thiểu** — không có admin token nào lọt vào
browser bundle.

Nguyên tắc:

- **Tái dụng, không phát minh lại** — publishable API key, setup wizard, seed
  pattern và Studio-in-Docker đều đã tồn tại; contract này ráp chúng lại.
- **Không thêm package chỉ để tăng lượt tải** (yêu cầu tường minh của #332).
- **`create-lumibase` là implementation duy nhất** — `lumibase init` delegate
  sang nó, nên hai entrypoint không thể drift.
- **Phân biệt artifact local với artifact đã phát hành** — "code đã merge"
  không đồng nghĩa "image/npm đã phát hành".

## 2. Template Next.js

Thêm template thứ ba `nextjs`, **giữ nguyên** `default` và `cloudflare`.

`scaffold.ts` **không cần đổi logic**: nó copy đệ quy toàn bộ thư mục template và
render mọi file `.hbs` (`packages/create-lumibase/src/scaffold.ts:50-95`). Thêm
một template = thêm thư mục + nới union type.

Điểm sửa, tối thiểu và có chủ đích:

| Vị trí | Thay đổi |
|---|---|
| `packages/create-lumibase/src/index.ts:14` | `Template = 'default' \| 'cloudflare'` → thêm `'nextjs'` |
| `packages/create-lumibase/src/index.ts:78-96` | thêm một choice vào prompt "Deployment target" |
| `packages/create-lumibase/src/scaffold.ts:41-48` | `buildTemplateContext` thêm cờ `isNextjs` (đã có `isCloudflare`/`isDefault`) |

**Không drift giữa hai entrypoint:** `lumibase init` không re-implement scaffold —
nó chạy `dlx create-lumibase@<đúng version của CLI>`
(`packages/cli/src/commands/init.ts:20-45`). Contract này **không sửa**
`init.ts`; chỉ bổ sung test khẳng định `--template nextjs` đi qua được cả
`npm create` lẫn `lumibase init`.

## 3. Hai đường backend

### 3.1 Đường A — kết nối instance CMS/Studio sẵn có

Consumer chỉ cần base URL + site id + publishable key. Không provisioning.

### 3.2 Đường B — Docker, CMS kèm Studio trong một image

Các fact dưới đây **đã verify**, không phải suy đoán:

- Image `ghcr.io/khuepm/lumibase-cms` **public, pull ẩn danh được**. Lấy
  anonymous pull token từ `ghcr.io/token` rồi `GET /v2/khuepm/lumibase-cms/manifests/<tag>`:

  | tag | HTTP |
  |---|---|
  | `edge` | 200 |
  | `latest` | 200 |
  | `1.0.0-rc.1` | 200 |
  | `1.0.0` | 404 |
  | `1.0` | 404 |

- ⇒ **Template phải pin `1.0.0-rc.1`, không dùng `latest`.** Repo đang ở
  `1.0.0-rc.1` (root `package.json`), trong khi `latest` còn trỏ dòng 0.x (tag
  list có tới `0.26.0`). Dùng `latest` là lệch major so với RC.

- **Image có Studio đi kèm** — một image, cả CMS lẫn Studio:
  `docker/Dockerfile:21` copy `apps/studio/`, `:30` build
  `pnpm --filter @lumibase/studio build`, `:43` copy `dist` → `/app/studio`.
  Runtime mount tại `apps/cms/src/serve.ts:81` qua `mountStudio`; env
  `LUMIBASE_SERVE_STUDIO` (tắt) và `LUMIBASE_STUDIO_DIST` (đổi path) —
  `apps/cms/src/serve-studio.ts:94,110`.

- **Local ≠ published:** `docker/docker-compose.yml:86-87` service `cms` dùng
  `build:` — build từ source, **không** pull image đã phát hành. Nên compose hiện
  có *không* phải bằng chứng image chạy được. Template `nextjs` sẽ ship compose
  **pull tag đã pin**, và được verify riêng bằng một lần cold pull.

### 3.3 Bootstrap first-admin + site

- `POST /api/v1/setup/complete` (`apps/cms/src/modules/setup/routes.ts:317-379`),
  mount public ngoài tenant/auth (`apps/cms/src/index.ts:173`).
  Body: `account{email,password,firstName,lastName}`, `adminPath`, `setupToken?`
  (`routes.ts:40-79`).
- Site đầu tiên có id cố định `__default__`
  (`apps/cms/src/modules/setup/site-constants.ts:11`) — chọn vậy để chạy lại
  wizard là idempotent.
- `LUMIBASE_REQUIRE_SETUP_TOKEN=true` ⇒ token in ra log **một lần** dạng
  `[lumibase-cms] SETUP_TOKEN=<token>`
  (`apps/cms/src/modules/setup/setup-token.ts:199`); DB chỉ giữ SHA-256.

## 4. Collection, seed và public client

### 4.1 Collection

Một collection `posts`, field tối thiểu `title` / `slug` / `body`.

Mô hình là `collections → fields → items`
(`packages/database/src/schema/cms.ts:47,88,184`); `items.status` mặc định
`draft` (`:194-195`). Tạo collection kèm `fields` inline qua
`POST /api/v1/collections` (`apps/cms/src/routes/collections.ts:97,162-178`);
tạo item qua `POST /api/v1/items/:collection`
(`apps/cms/src/routes/items.ts:106-118`).

### 4.2 Seed chạy lại không trùng

Theo đúng pattern repo đã dùng: id ổn định + `onConflictDoNothing`, như
`packages/database/scripts/seed-content-os-demo.ts:109,127,166`. Seed
site-scoped và chạy **server-side** trong bước bootstrap.

### 4.3 Public client — publishable key

Chọn **publishable key** (không dùng đường anonymous thuần, lý do ở §6):

- Key class `lbk_pub_` (`apps/cms/src/services/api-key-publishable.ts:29`), tách
  khỏi secret key `lbk_`. Gửi qua `Authorization: Bearer <token>`; server chỉ
  lưu hash (`apps/cms/src/middleware/auth.ts:285-291`).
- Publishable key bị **origin-check** theo `metadata.allowedOrigins`
  (`apps/cms/src/middleware/auth.ts:329-349`).
  ⚠️ Allowlist rỗng = `no_constraint`, dùng được từ mọi nơi
  (`apps/cms/src/services/api-key-publishable.ts:75-80`) — template **phải** set
  `allowedOrigins` tường minh.
- Key gắn cứng vào site: `apiKey.siteId !== siteId` ⇒ 401 + audit
  (`apps/cms/src/middleware/auth.ts:299-305`). Đây chính là cơ chế khiến client
  tenant B không đọc được nội dung tenant A.

### 4.4 ⚠️ Rủi ro lộ draft — phải chốt trước khi code

`GET /api/v1/items` **không** tự lọc `published`: `status` chỉ là query param
optional, chỉ áp dụng khi client truyền (`apps/cms/src/routes/items.ts:27`,
`apps/cms/src/services/item-service.ts:693`). Và `enablePublicAccess` chỉ tạo
role + policy, **không tạo permission row nào**
(`apps/cms/src/services/auth/public-role.ts:130-175`).

⇒ Nếu grant `read` mà không kèm filter, client công khai **đọc được cả draft**.

**Đề xuất chốt:** grant `read` trên `posts` **bắt buộc kèm row-filter
`status = published`**, dùng DSL row-level của `permissions.permissions`
(`packages/database/src/schema/access.ts:291-292`), cộng `fields` whitelist
(`:297-298`) để chặn field nội bộ. Test phải assert: publishable key **không**
nhìn thấy item draft.

### 4.5 Token quản trị

Chỉ dùng ở bước bootstrap/seed phía server. Biến admin **không** mang prefix
`NEXT_PUBLIC_`, nên không thể lọt browser bundle. Bằng chứng: grep bundle đã
build.

## 5. Bảng file, env và lệnh

### 5.1 File xin cấp phát

| File | Thêm/Sửa |
|---|---|
| `packages/create-lumibase/templates/nextjs/**` | mới — app Next.js + compose pull image đã pin + script bootstrap/seed |
| `packages/create-lumibase/src/index.ts` | sửa — union `Template`, một prompt choice |
| `packages/create-lumibase/src/scaffold.ts` | sửa — cờ `isNextjs` trong context |
| `packages/create-lumibase/src/templates.test.ts` | sửa — mở rộng `it.each` sang `nextjs` |
| `packages/create-lumibase/src/*.test.ts` | mới/sửa — test scaffold + assertion chống rò token |

**Không đụng:** `packages/sdk/**`, `apps/studio/**`, root manifest/lockfile,
`.github/workflows/**`, docs/spec dùng chung. `#334` sở hữu reference example —
contract này không tạo example độc lập. Tránh va `#467` (nhánh
`chore/deps-batch-2026-09`).

### 5.2 Contract biến môi trường

| Biến | Phía | Vai trò |
|---|---|---|
| `NEXT_PUBLIC_LUMIBASE_URL` | browser | base URL của CMS |
| `NEXT_PUBLIC_LUMIBASE_SITE_ID` | browser | `__default__`; gửi qua `X-Lumi-Site` |
| `NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY` | browser | key `lbk_pub_`, read-only + published-only |
| `LUMIBASE_ADMIN_TOKEN` | **server only** | chỉ bootstrap/seed |
| `LUMIBASE_REQUIRE_SETUP_TOKEN` | container | bật setup token |

Tenant resolution: header **`X-Lumi-Site`** là đường chính
(`apps/cms/src/middleware/tenant.ts:26`) — đúng header SDK đã gửi sẵn
(`packages/sdk/src/client.ts:183`).

### 5.3 Lệnh cold-install (ngoài monorepo, không `workspace:*`)

```bash
pnpm -F create-lumibase build && npm pack
cd "$(mktemp -d)" && npm i <tarball>
npx create-lumibase my-site --template nextjs --pm npm --no-git
```

## 6. Điểm cần SDK/API hỗ trợ

`LumiClientOptions.token` là **bắt buộc**, kiểu `string`, doc ghi "Logto access
token" (`packages/sdk/src/client.ts:12`), và client **luôn** set
`authorization: Bearer ${currentToken}` (`packages/sdk/src/client.ts:182`).
Không có chế độ anonymous/publishable.

- Publishable key **vẫn dùng được ngay**: nó đi qua đúng `Authorization: Bearer`,
  nên truyền key vào `token` là chạy. **Không chặn #332.**
- Nhưng đường **anonymous thuần** (`apps/cms/src/middleware/auth.ts:529-545`;
  chỉ `GET`/`HEAD`, chỉ các prefix `/api/v1/items|search|media|files` — `:567-575`)
  thì SDK hiện **không gọi được** vì không bỏ được header `authorization`.
- Đề xuất: #332 dùng publishable key. Việc nới `token?: string` thuộc SDK owner;
  contract này **không** sửa `packages/sdk`. Xin reviewer xác nhận có tách
  ticket riêng hay không.

## 7. Bằng chứng nghiệm thu sẽ nộp

- Pack rồi cài vào thư mục ngoài monorepo; không `workspace:*`; hai entrypoint
  hoạt động tương đương.
- Seed chạy hai lần không trùng.
- Studio sửa/publish → website đọc được thay đổi **thật**, không mock.
- Grep bundle chứng minh không rò admin token.
- Client tenant B không đọc được nội dung tenant A.
- **Assert publishable key không nhìn thấy item draft** (§4.4).
- Regression template `default` + `cloudflare`.
- Handoff ghi base/head, changed paths, lệnh/exit code/skips, phần chưa xác minh.
- Artifact local ghi tách bạch với npm/image đã phát hành; bằng chứng
  cold-install nộp cho #448.

## 8. Chặn — cần reviewer quyết trước khi implement

1. **#450 còn OPEN.** Template `cloudflare` hiện không `npm install` được
   (ERESOLVE do peer Workers Types; bối cảnh ở
   `packages/create-lumibase/src/templates.test.ts:1-20`). Không thể nộp bằng
   chứng "regression default/Cloudflare" xanh khi #450 chưa đóng. Xin quyết:
   đóng #450 trước, hay ghi nhận Cloudflare là known-fail có dẫn chiếu #450?
2. **Chốt row-filter `status = published`** (§4.4) — nếu không, public client lộ
   draft.
3. **Pin tag `1.0.0-rc.1`**, không `latest` (§3.2) — xác nhận đây là artifact
   chuẩn cho contract này.
4. Xác nhận bảng file §5.1 và việc **không** sửa `packages/sdk` trong #332.
