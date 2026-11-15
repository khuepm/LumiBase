---
title: SvelteKit Starter — Load phía server và Draft Preview trên Cloudflare Pages
version: 3
lastUpdated: 2026-11-15T08:39:52.066Z
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
sourceHash: 0fe449a09715982d
codeVerified: 2026-11-15T08:39:52.066Z
codeVerifiedHash: 0fe449a09715982d
codeVerifiedClaims: 16
---

# SvelteKit starter — load phía server và draft preview trên Cloudflare Pages

`create-lumibase --template sveltekit` sinh ra một site
[SvelteKit](https://svelte.dev/docs/kit) đọc nội dung LumiBase trong các **load
phía server** và chạy trên Cloudflare Pages qua
`@sveltejs/adapter-cloudflare`. Trang được render tại thời điểm request, nên một
lần xuất bản trong Studio hiện ra ngay ở request kế tiếp mà không cần build lại,
và editor có thể xem trước bản nháp.

| | |
|---|---|
| **Bạn sẽ xây** | Một blog (`/` và `/posts/:slug`) có draft preview theo từng request |
| **Cấp độ** | Trung cấp |
| **Thời gian** | ~20 phút |
| **Yêu cầu** | Node.js ≥ 22.17, một LumiBase CMS truy cập được, và (để deploy) một tài khoản Cloudflare |

## 1. Scaffold

```bash
npm create lumibase my-site -- --template sveltekit
cd my-site
cp .env.example .env
npm install
npm run dev      # http://localhost:5173
```

Template nằm ở `packages/create-lumibase/templates/sveltekit`. Nó nhắm tới
SvelteKit 3: cấu hình được truyền cho `sveltekit(...)` trong `vite.config.ts`
(không còn `svelte.config.js`), import thư viện dùng `#lib`, và biến môi trường
được khai báo trong `src/env.ts`.

| File | Vai trò |
|---|---|
| `src/env.ts` | Khai báo mọi biến — không biến nào public, không biến nào static |
| `src/lib/server/config.ts` | Quy tắc chọn credential cho một request — thuần, có unit test |
| `src/lib/server/preview.ts` | Cookie preview có chữ ký (chỉ dùng Web Crypto) |
| `src/lib/server/lumibase.ts` | Client `lumibase` có kiểu, các load và header cache |
| `src/hooks.server.ts` | Xác minh cookie preview một lần cho mỗi request |
| `src/routes/api/preview/+server.ts`, `src/routes/api/preview/exit/+server.ts` | Vào / thoát preview |
| `src/lib/components/VisualEditing.svelte` | Điểm móc cho visual editing (hiện đang trống) |
| `wrangler.jsonc` | Tên project Pages và `pages_build_output_dir: ".svelte-kit/cloudflare"` |

## 2. Kết nối CMS

```bash
LUMIBASE_URL=https://cms.example.com
LUMIBASE_SITE_ID=your-site-id
LUMIBASE_PUBLISHABLE_KEY=lbk_pub_…
```

CMS cần đúng ba thứ như với
[Astro starter](./astro-starter.md): một publishable key, một grant đọc chỉ giới
hạn ở các dòng đã xuất bản, và một collection `posts` với các field `title`,
`slug` và `body`. Một token không có tiền tố `lbk_pub_` trong
`LUMIBASE_PUBLISHABLE_KEY` sẽ bị từ chối: key đó trả lời mọi khách truy cập ẩn
danh.

Các biến được đọc từ `$app/env/private`, một module chỉ-dành-cho-server —
SvelteKit làm build thất bại nếu code trình duyệt import nó — và chỉ từ
`src/lib/server/`, hooks và các file `+server.ts` / `+page.server.ts`. Không biến
nào là `static`, nên trên Cloudflare Pages chúng được lấy từ Variables and
Secrets của project khi app khởi động, chứ không phải từ lần build.

## 3. Draft preview

Preview **tắt** cho đến khi cả hai giá trị chỉ-ở-server sau được đặt:

| Biến | Giá trị |
|---|---|
| `LUMIBASE_PREVIEW_SECRET` | Ngẫu nhiên, từ 32 ký tự (`openssl rand -base64 32`). Giá trị ngắn hơn để preview tắt |
| `LUMIBASE_PREVIEW_TOKEN` | Một token bí mật (`lbk_…`, không phải `lbk_pub_…`) có grant đọc bao gồm bản nháp |

Vào preview bằng cách mở (hoặc cấu hình làm preview URL trong Studio):

```
https://<your-site>/api/preview?secret=<LUMIBASE_PREVIEW_SECRET>&redirect=/posts/<slug>
```

Cách nó được thực thi:

- Secret được so sánh sau khi băm cả hai phía, theo thời gian hằng.
- Secret đúng sẽ đặt cookie HttpOnly `lumibase_preview` có giá trị
  `<expiry>.<HMAC-SHA256(expiry)>` được ký bằng secret, hiệu lực một giờ. Cookie
  giả mạo, hết hạn hoặc bị sửa chỉ được coi là khách thường, và xoay vòng secret
  sẽ kết thúc mọi phiên.
- Request preview đọc bằng preview token với mọi trạng thái, và được trả về
  `Cache-Control: private, no-store`. Mọi người khác đọc bằng publishable key và
  `status=published` (`public, max-age=0, s-maxage=60`).
- Secret sai trả về `401`; khi preview chưa được cấu hình, route trả về `404`.
- `redirect` chỉ chấp nhận đường dẫn cùng origin (không `//host`, không URL tuyệt
  đối).
- `/api/preview/exit` xoá cookie.
- Ở production cookie là `Secure; SameSite=None` để preview cũng chạy được trong
  iframe của Studio; nó chỉ mở khoá thao tác đọc.

> Cờ `?preview=true` của chính Delivery API trên
> `GET /api/v1/deliver/page/:site_id/:slug` chỉ **bỏ qua cache** — nó không trả
> về bản nháp (route không dùng cờ này cho việc gì khác ngoài quyết định cache,
> xem `apps/cms/src/routes/deliver.ts`). Vì vậy draft preview cần một credential
> có grant bao gồm bản nháp, và đó chính là `LUMIBASE_PREVIEW_TOKEN`.

## 4. Nội dung có kiểu

```bash
LUMIBASE_TOKEN=… npm run types      # regenerates src/lib/lumibase-types.ts
npm run types:check
```

## 5. Deploy lên Cloudflare Pages

```bash
npm run build                       # .svelte-kit/cloudflare (assets + _worker.js)
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npm run deploy
npx wrangler pages secret put LUMIBASE_PUBLISHABLE_KEY
```

Hoặc kết nối repository trong dashboard với build command `npm run build` và
output directory `.svelte-kit/cloudflare`. Thêm `LUMIBASE_URL` và
`LUMIBASE_SITE_ID` làm variable, còn key, preview secret và preview token làm
**secret**. Để chạy site đã build dưới runtime của Pages ở máy bạn, đặt các biến
vào `.dev.vars` (đã được git-ignore) rồi chạy `npm run preview`.

Muốn xuất tĩnh hoàn toàn? Thay bằng `@sveltejs/adapter-static`, đặt
`export const prerender = true` trong `src/routes/+layout.server.ts` và bỏ các
route preview cùng hook. Khi đó site được ghi vào `build/`: trỏ
`pages_build_output_dir` trong `wrangler.jsonc` (và output directory của Pages)
về đó, rồi làm theo
[Xuất tĩnh lên Cloudflare Pages](../deployment/static-export-cloudflare-pages.md).

## 6. Visual editing

Visual editing của LumiBase (roadmap V03, package dự kiến
`@lumibase/visual-editing`) **chưa được phát hành**.
`src/lib/components/VisualEditing.svelte` là nơi nó sẽ được gắn vào: root layout
chỉ render component này cho các phiên preview đã được xác minh, và hiện nó
không render gì.

## Tương thích

| LumiBase | Starter | Ghi chú |
|---|---|---|
| CMS ≥ 2.0.0 | Các bản `create-lumibase` sau 2.0.0 | SvelteKit 3 / `@sveltejs/adapter-cloudflare` 8; template chưa có trong `create-lumibase@2.0.0` |

Các contract mà tutorial này dựa vào: `GET /api/v1/items/:collection` với
`status`, `filter` (`{ "slug": { "_eq": … } }`), `sort` và `limit`; publishable
key (tiền tố `lbk_pub_`); secret API key có grant bao gồm bản nháp.
