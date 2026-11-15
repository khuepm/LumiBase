---
title: Xuất tĩnh lên Cloudflare Pages
version: 2
lastUpdated: 2026-11-15T08:38:14.448Z
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
sourceHash: 63a9024b64e372f2
codeVerified: 2026-11-15T08:38:14.448Z
codeVerifiedHash: 63a9024b64e372f2
codeVerifiedClaims: 20
---

# Xuất tĩnh lên Cloudflare Pages

Cách đưa một site dùng LumiBase lên Cloudflare Pages dưới dạng file tĩnh, lấy
[Astro starter](../tutorials/astro-starter.md) làm ví dụ cụ thể. Các bước tương
tự áp dụng cho mọi bản build tĩnh (ví dụ SvelteKit starter với
`@sveltejs/adapter-static`). Trang này nói về **website** của bạn; để host chính
CMS, xem [Cloudflare](./cloudflare.md) và [One-click deploys](./one-click.md).

## Mô hình

1. `astro build` đọc nội dung từ CMS bằng một **publishable** key
   (`lbk_pub_…`) và ghi HTML vào `dist/`.
2. `wrangler pages deploy dist` (hoặc tích hợp Git của Pages) tải `dist/` lên.
3. Khi editor xuất bản, một **deploy hook** build lại site.

Không có gì bí mật nằm trong `dist/`: key chỉ được dùng trong lúc build, và
starter khai báo nó là secret chỉ-ở-server trong `astro.config.mjs`.

## Cách A — tích hợp Git của Pages

Workers & Pages → Create → Pages → Connect to Git, rồi:

| Thiết lập | Giá trị |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Phiên bản Node | `NODE_VERSION=22` (Astro 7 cần ≥ 22.23.4) |
| Variables | `LUMIBASE_URL`, `LUMIBASE_SITE_ID` |
| Secrets | `LUMIBASE_PUBLISHABLE_KEY` |

## Cách B — tải lên trực tiếp từ CI

`npm run deploy` chạy `wrangler pages deploy dist`; `wrangler.jsonc` mang tên
project. Lệnh này đọc `CLOUDFLARE_API_TOKEN` (quyền *Cloudflare Pages: Edit*) và
`CLOUDFLARE_ACCOUNT_ID` từ môi trường. Hãy chặn bước deploy để một lần chạy
không có chúng — một fork, một pull request — vẫn build và bỏ qua gọn gàng:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci && npm run build
        env:
          LUMIBASE_URL: ${{ vars.LUMIBASE_URL }}
          LUMIBASE_SITE_ID: ${{ vars.LUMIBASE_SITE_ID }}
          LUMIBASE_PUBLISHABLE_KEY: ${{ secrets.LUMIBASE_PUBLISHABLE_KEY }}
      - name: Deploy to Cloudflare Pages
        if: env.CLOUDFLARE_API_TOKEN != '' && env.CLOUDFLARE_ACCOUNT_ID != ''
        run: npm run deploy -- --branch main
```

Một bước deploy bị bỏ qua vẫn để job xanh, nên đừng coi dấu xanh là bằng chứng
đã deploy — cùng lưu ý như [Cloudflare Pages CI](./cloudflare-pages-ci.md).

### Repository LumiBase kiểm tra điều này thế nào

Job `scaffold-smoke` trong `.github/workflows/ci.yml` (do
`packages/create-lumibase/scripts/smoke-scaffold.mjs` điều khiển) scaffold mọi
template, cài đặt bằng npm và pnpm, typecheck, và **build** Astro starter cùng
SvelteKit starter, thất bại nếu thiếu `dist/index.html` hoặc
`.svelte-kit/cloudflare/_worker.js`. Với các lần push lên `main` có cấu hình
`CLOUDFLARE_API_TOKEN` và `CLOUDFLARE_ACCOUNT_ID`, job sau đó deploy bản build
Astro đã scaffold bằng chính `npm run deploy` của starter (tên project lấy từ
biến repository `STARTER_PAGES_PROJECT`, mặc định `lumibase-astro-starter`);
nếu không, job in ra một notice và bỏ qua.

## Build lại khi xuất bản (deploy hook)

1. Project Pages → Settings → Builds → **Deploy hooks** → tạo một hook cho
   branch production. Ai có URL này cũng khởi động được một lần build: hãy coi
   nó là secret.
2. Trong LumiBase, tạo một Flow với trigger type `event` và
   `triggerOptions: { "collection": "posts" }`, có graph gồm đúng một node
   `http` với options `{ "url": "<deploy hook URL>", "method": "POST" }`. Thao
   tác `http` được bảo vệ chống SSRF và hết thời gian sau 30 giây
   (`apps/cms/src/services/flow-service.ts`). Flow kiểu event được đưa vào hàng
   đợi `flow-events` của CMS, nên hàng đợi đó phải được cấu hình.

Trigger khớp mọi thao tác tạo, cập nhật và xoá trong collection, kể cả bản nháp
(`apps/cms/src/services/flow-dispatch.ts`); đặt một node `condition` trước node
`http` để chỉ build lại với một số thay đổi. Mỗi lần gọi khởi động một lần build
Pages và tính vào hạn mức build của bạn. Để thu hẹp trigger về một số thao tác,
đặt `"action": ["update"]` trong `triggerOptions`.

## Bản xem trước nháp của một site tĩnh

Một bản build tĩnh không thể quyết định theo từng khách truy cập, nên preview là
một lần build riêng: đặt `LUMIBASE_PREVIEW=true` và một `LUMIBASE_PREVIEW_TOKEN`
bí mật (token có grant bao gồm bản nháp) **chỉ** trên môi trường *Preview* của
Pages, và bảo vệ các URL preview `*.pages.dev` bằng Cloudflare Access. Starter
từ chối build preview khi thiếu token đó, hoặc khi đặt một publishable key vào
chỗ của nó. Để có preview theo từng request, dùng
[SvelteKit starter](../tutorials/sveltekit-starter.md).

## Checklist

- [ ] `LUMIBASE_PUBLISHABLE_KEY` là publishable key với grant chỉ-đã-xuất-bản
- [ ] Secret là *secret* của Pages / secret của CI, không bao giờ nằm trong `wrangler.jsonc` hay một `.env` được commit
- [ ] URL deploy hook chỉ được lưu trong Flow
- [ ] Biến preview chỉ tồn tại trên một môi trường preview được bảo vệ
- [ ] Header chống framing (`public/_headers`) vẫn cho phép origin Studio của bạn nếu bạn nhúng preview
