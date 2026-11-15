---
title: Astro Starter — Site tĩnh trên Cloudflare Pages
version: 2
lastUpdated: 2026-11-15T08:38:13.859Z
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
sourceHash: 0269f961a6832c9d
codeVerified: 2026-11-15T08:38:13.859Z
codeVerifiedHash: 0269f961a6832c9d
codeVerifiedClaims: 10
---

# Astro starter — một site LumiBase tĩnh trên Cloudflare Pages

`create-lumibase --template astro` sinh ra một site [Astro](https://astro.build)
đọc nội dung LumiBase **một lần, lúc build**, rồi ghi HTML thuần vào `dist/`.
Cloudflare Pages phục vụ nguyên thư mục đó: không server, không có lời gọi API
nào từ khách truy cập, không có credential nào trong trình duyệt.

| | |
|---|---|
| **Bạn sẽ xây** | Một blog tĩnh (`/` và một trang cho mỗi bài) từ collection `posts` |
| **Cấp độ** | Cơ bản |
| **Thời gian** | ~15 phút |
| **Yêu cầu** | Node.js ≥ 22.23.4, một LumiBase CMS truy cập được, và (để deploy) một tài khoản Cloudflare |

> Chưa có CMS? Hãy scaffold template Next.js trước
> (`npm create lumibase my-cms -- --template nextjs`): nó chạy CMS + Studio +
> Postgres ở máy bạn và tạo sẵn publishable key cùng grant mà starter này cần.
> Để host CMS, xem [One-click deploys](../deployment/one-click.md).

## 1. Scaffold

```bash
npm create lumibase my-site -- --template astro
cd my-site
cp .env.example .env
```

Template nằm ở `packages/create-lumibase/templates/astro`. Bạn nhận được:

| File | Vai trò |
|---|---|
| `astro.config.mjs` | `output: 'static'` và schema env có kiểu (`astro:env`) |
| `src/lib/config.ts` | Quy tắc chọn credential cho một lần build — thuần, có unit test |
| `src/lib/lumibase.ts` | Client `lumibase` có kiểu và phần fetch lúc build |
| `src/lumibase-types.d.ts` | Kiểu collection được sinh ra (sinh lại bằng `npm run types`) |
| `src/pages/index.astro`, `src/pages/posts/[slug].astro` | Trang danh sách và một trang tĩnh cho mỗi bài |
| `src/components/VisualEditing.astro` | Điểm móc cho visual editing (hiện đang trống) |
| `public/_headers` | Header phản hồi của Cloudflare Pages |
| `wrangler.jsonc` | Tên project Pages và `pages_build_output_dir: "dist"` |

## 2. Kết nối CMS

Điền vào `.env`:

```bash
LUMIBASE_URL=https://cms.example.com
LUMIBASE_SITE_ID=your-site-id
LUMIBASE_PUBLISHABLE_KEY=lbk_pub_…
```

Người quản trị CMS cung cấp:

1. **Một publishable key** (Studio → Access → API keys, đánh dấu publishable).
   Lần build từ chối mọi token không bắt đầu bằng `lbk_pub_` trong
   `LUMIBASE_PUBLISHABLE_KEY` — đặt secret key vào đó sẽ nới rộng những gì một
   lần build bình thường đọc được.
2. **Một grant đọc chỉ giới hạn ở các dòng đã xuất bản.**
   `GET /api/v1/items/:collection` không tự áp bộ lọc chỉ-đã-xuất-bản nào. Lần
   build cũng chủ động hỏi `status=published`, nhưng chính grant mới là thứ
   thực thi điều đó.
3. **Một collection `posts`** với các field `title`, `slug` và `body`.

Cả năm biến đều được khai báo `context: 'server'` trong `astro.config.mjs`, còn
key và preview token là `access: 'secret'`, nên Astro không cho chúng lọt vào
code phía client.

## 3. Build và chạy

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static HTML in dist/
```

Hai kiểu lỗi được thiết kế có chủ đích:

- **Chưa cấu hình** (`LUMIBASE_URL` hoặc key để trống): build vẫn thành công và
  tạo ra trang "connect your CMS", nên lần deploy đầu tiên không bao giờ hỏng vì
  thiếu cấu hình.
- **Đã cấu hình nhưng không kết nối được**: build thất bại. Xuất bản một site
  rỗng đè lên một site đang chạy còn tệ hơn là giữ bản deploy tốt gần nhất.

Những bài có `slug` không an toàn cho URL (`[a-z0-9][a-z0-9_-]*`) vẫn được liệt
kê nhưng không có trang riêng. Nội dung bài được render dưới dạng text, không
phải HTML — nội dung từ CMS là đầu vào không tin cậy cho đến khi bạn thêm một bộ
sanitize mà bạn tin.

## 4. Nội dung có kiểu

```bash
LUMIBASE_TOKEN=… npm run types      # regenerates src/lumibase-types.d.ts
npm run types:check                 # fails when the file is stale (CI)
```

`src/lib/lumibase.ts` suy ra kiểu `data` của từng collection từ file được sinh
ra, nên `post.data.title` có kiểu và việc đổi tên field sẽ thành lỗi kiểu.
`LUMIBASE_TOKEN` cần quyền đọc schema; nó chỉ được dùng bởi hai lệnh này, không
bao giờ bởi lần build.

## 5. Deploy lên Cloudflare Pages

Xem [Xuất tĩnh lên Cloudflare Pages](../deployment/static-export-cloudflare-pages.md)
cho cả hai cách deploy (tích hợp Git và `npm run deploy`), ví dụ CI, và cách
build lại khi xuất bản bằng deploy hook.

## 6. Build bản xem trước bản nháp

Một site tĩnh không thể bật preview theo từng khách truy cập, nên preview là một
**lần build** riêng: đặt `LUMIBASE_PREVIEW=true` và `LUMIBASE_PREVIEW_TOKEN`
(một token `lbk_…` bí mật có grant bao gồm bản nháp) trên một môi trường được
bảo vệ, chẳng hạn môi trường *Preview* của Pages đặt sau Cloudflare Access. Khi
đó bản build bao gồm cả bản nháp, thêm banner và `noindex`, và thất bại nếu thiếu
token hoặc token là một publishable key. Để có preview theo từng request, dùng
[SvelteKit starter](./sveltekit-starter.md).

## 7. Visual editing

Visual editing của LumiBase (roadmap V03, package dự kiến
`@lumibase/visual-editing`) **chưa được phát hành**. Starter không giả lập nó.
`src/components/VisualEditing.astro` là nơi duy nhất nó sẽ được gắn vào; layout
chỉ render component này trên các bản build preview, và hiện nó không render gì.

## Tương thích

| LumiBase | Starter | Ghi chú |
|---|---|---|
| CMS ≥ 2.0.0 | Các bản `create-lumibase` sau 2.0.0 | Template có mặt từ bản `create-lumibase` đầu tiên sau 2.0.0; `create-lumibase@2.0.0` chưa có |

Các contract mà tutorial này dựa vào: `GET /api/v1/items/:collection` với
`status`, `sort`, `limit` và `offset`; publishable key (tiền tố `lbk_pub_`);
manifest typegen mà `lumibase types` đọc.
