# Design Document — Next.js starter contract (#332, handoff A-02)

> **Trạng thái: ĐÃ IMPLEMENT.** Owner chỉ đạo triển khai luôn, không chờ
> reviewer (2026-09-12), nên 4 điểm chặn ở §8 được quyết theo đúng đề xuất.
>
> Contract này được giữ lại làm tài liệu thiết kế. Phần đã chạy thật và bằng
> chứng nằm ở §9.
>
> Baseline: main `6a20441af5dde899b976479f0ed7f8d1a9341dee`.
> Mọi khẳng định đã verify trên source tree / registry / instance chạy thật.

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

- ⚠️ **KHÔNG semver tag nào chứa Studio.** Bản contract đầu tiên của tôi đề
  xuất pin `1.0.0-rc.1` và khẳng định image có Studio — **sai**, reviewer bắt
  đúng. Tôi suy ra điều đó từ `docker/Dockerfile` *hiện tại*, nhưng Dockerfile
  hiện tại không mô tả nội dung một tag đã build từ trước.

  Kiểm chứng bằng cách chạy chính image đó (`ls /app/studio`):

  | tag | Studio | ghi chú |
  |---|---|---|
  | `1.0.0-rc.1` | ✖ không | build 2026-09-03 |
  | `latest` / `0.26.0` | ✖ không | dòng 0.x |
  | `edge` | ✔ có | revision `683a0270`, nhưng tag trôi nổi |

  Lý do: commit thêm Studio (`2bd5b0ab`) là **2026-09-07**, còn image
  `1.0.0-rc.1` build **2026-09-03** — sau 4 ngày. Đúng cái bẫy handoff cảnh báo.

- ⇒ **Pin theo digest**, không theo tag: `edge` có Studio nhưng rebuild mỗi lần
  push main; semver thì không có Studio. Digest
  `sha256:3f125caa…` bất biến và đã kiểm chứng có `/app/studio/index.html`.
  Chạy thật: log in `[lumibase-cms] Serving Studio from /app/studio`,
  `GET /<adminPath>` trả 200 `text/html` với `<title>LumiBase Studio</title>`,
  và `/api/v1/*` vẫn trả JSON `{errors}` chứ không bị SPA catch-all nuốt.

- Cơ chế phục vụ Studio: `apps/cms/src/serve.ts:81` gọi `mountStudio`; env
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
- `LUMIBASE_REQUIRE_SETUP_TOKEN=true` **nhìn thì** in token một lần
  (`apps/cms/src/modules/setup/setup-token.ts:199`), nhưng thực tế hàm đó không
  bao giờ được gọi — xem §9.1(a). Template vì vậy **không** bật cờ này.

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

### 4.4 ⚠️ Rủi ro lộ draft — đã chốt và đã kiểm chứng

`GET /api/v1/items` **không** tự lọc `published`: `status` chỉ là query param
optional, chỉ áp dụng khi client truyền (`apps/cms/src/routes/items.ts:27`,
`apps/cms/src/services/item-service.ts:693`). Và `enablePublicAccess` chỉ tạo
role + policy, **không tạo permission row nào**
(`apps/cms/src/services/auth/public-role.ts:130-175`).

⇒ Nếu grant `read` mà không kèm filter, client công khai **đọc được cả draft**.

**Đã chốt:** grant `read` trên `posts` luôn kèm `publishedOnly: true`
(`apps/cms/src/routes/access-grants.ts:82`), biên dịch thành
`{ status: { _eq: 'published' } }` (`apps/cms/src/services/auth/realm-access.ts:35`),
cộng `fields` whitelist. Truyền tường minh chứ không dựa vào mặc định
server-side (`realm-access.ts:226` bật sẵn cho `read`) — mặc định có thể đổi.

Đã kiểm chứng trên instance thật: seed cố tình để lại một bài draft, và
`cms:verify` xác nhận publishable key chỉ thấy `published` (§9).

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

## 8. Bốn điểm chặn — đã quyết

Owner chỉ đạo implement luôn, nên cả bốn được quyết theo đề xuất:

1. **#450**: ghi nhận là known-fail có dẫn chiếu, không chặn #332. Template
   `nextjs` **cài được sạch** (xem §9), nên lỗi ERESOLVE của Cloudflare không
   lây sang đường đi mới.
2. **Row-filter `status = published`**: chốt bắt buộc. API đã có sẵn cờ
   `publishedOnly` (`apps/cms/src/routes/access-grants.ts:82`) biên dịch thành
   `{ status: { _eq: 'published' } }`
   (`apps/cms/src/services/auth/realm-access.ts:35`), nên không phải tự viết DSL.
3. **Pin image**: đề xuất ban đầu (`1.0.0-rc.1`) **sai** — tag đó không có
   Studio. Sửa thành pin theo digest `sha256:3f125caa…` (§3.2).
4. **Không sửa `packages/sdk`**: giữ nguyên. Publishable key đi qua đúng header
   `Authorization: Bearer` nên client hiện tại dùng được ngay.

## 9. Đã chạy thật — bằng chứng

Toàn bộ vòng đời chạy trên instance thật (cold install ngoài monorepo → Docker
→ bootstrap → seed → website), không mock:

| Hạng mục | Kết quả |
|---|---|
| Cold install từ tarball đã pack, ngoài monorepo | ✔ không `workspace:*`, không `.hbs` sót |
| `npm install` project scaffold | ✔ 31 packages, **không ERESOLVE** |
| `tsc --noEmit` trong project scaffold | ✔ exit 0 |
| Pull image theo digest `sha256:3f125caa…` | ✔ chạy được, **có Studio** |
| Studio phục vụ tại `/<adminPath>` | ✔ 200 `text/html`, `<title>LumiBase Studio</title>` |
| `/api/v1/*` không bị SPA nuốt | ✔ vẫn trả `{errors}` JSON |
| `cms:bootstrap` | ✔ trọn 6/6 bước |
| `cms:seed` chạy 2 lần | ✔ lần 1 tạo 3, lần 2 tạo 0 — idempotent |
| `cms:verify` | ✔ đọc được published, **không thấy draft**, không ghi được |
| Website render | ✔ hiện 2 bài published, **không hiện draft** |
| Publish draft → reload | ✔ bài xuất hiện (0 → 1), dữ liệu thật |
| Rò token trong HTML | ✔ 0 lần xuất hiện admin token/password |

### 9.1 Hai lỗi CMS phát hiện khi chạy thật

Cả hai **nằm ngoài phạm vi #332** (không được sửa `apps/cms`), đã né trong
template và ghi vào README của starter:

**(a) Cờ setup token khoá chết instance.** `printSetupTokenIfRequired`
(`apps/cms/src/modules/setup/setup-token.ts:148`) có unit test nhưng **không
được gọi từ đâu** lúc khởi động — grep toàn repo chỉ ra 3 kết quả, đều trong
chính file đó. Bật `LUMIBASE_REQUIRE_SETUP_TOKEN=true` ⇒ `/setup/state` trả
`requiresSetupToken: true`, `/setup/complete` trả `SETUP_TOKEN_REQUIRED`, và
không có cách nào lấy token. Đã kiểm chứng trực tiếp. ⇒ compose **không** bật cờ
này; stack chỉ bind localhost.

**(b) Header site giả làm sập CMS — DoS không cần xác thực.** `withTenant` chỉ
kiểm tra *định dạng* của `X-Lumi-Site` (`apps/cms/src/middleware/tenant.ts:29-43`),
không kiểm tra site có tồn tại. Khi từ chối api key, `auditApiKeyUseDenied` ghi
audit với chính site id do client gửi (`apps/cms/src/middleware/auth.ts:93`), vi
phạm FK `lumibase_audit_log_site_id_lumibase_sites_id_fk` và **giết process**.
Tái hiện chắc chắn: một request duy nhất → 401 → `health` = 000.
⇒ `verify.mjs` để phép thử cross-tenant sau cờ `LUMIBASE_VERIFY_CROSS_TENANT=1`,
nếu không `cms:verify` sẽ tự bắn sập CMS của người dùng.

### 9.2 Lệch so với contract ban đầu

- **Thêm Redis vào compose.** Không có nó, runtime Docker fallback về
  `127.0.0.1:6379` và đẩy **506 dòng ECONNREFUSED** vào log, che hết thông tin
  hữu ích. Có Redis: **0 lỗi**.
- **Bỏ `LUMIBASE_REQUIRE_SETUP_TOKEN`** — lý do ở §9.1(a).
- **Thêm validate `--template`**: trước đây tên template sai đi thẳng tới
  `scaffold()` và chết bằng ENOENT trỏ vào đường dẫn nội bộ.
