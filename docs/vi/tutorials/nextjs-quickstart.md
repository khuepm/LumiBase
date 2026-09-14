---
title: Next.js Quickstart — Hiển thị nội dung LumiBase
version: 5
lastUpdated: 2026-09-14T19:53:53.530Z
sourceLang: en
translatedFrom: en
sourceHash: ca523023eb37e81c
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-09-14T19:53:53.530Z
codeVerifiedHash: ca523023eb37e81c
codeVerifiedClaims: 26
---

<!--
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ TUTORIAL VERSIONING — đọc trước khi sửa                                     │
  │                                                                            │
  │ applies_to_min: 0.9.0   ← phiên bản LumiBase thấp nhất tutorial còn đúng   │
  │ verified_on:    1.0.0-rc.1  ← phiên bản đã thực sự test lần gần nhất           │
  │                                                                            │
  │ Tutorial này cố tình pin theo version. KHÔNG clone tut này theo từng       │
  │ release. Chỉ bump `verified_on` (và `applies_to_min` nếu có breaking       │
  │ change bắt buộc) khi MỘT trong các contract ở bảng "Tương thích" bên dưới  │
  │ thực sự thay đổi. Xem checklist DoD §5 trong                               │
  │ .kiro/steering/definition-of-done.md.                                      │
  └──────────────────────────────────────────────────────────────────────────┘
-->

<div align="center">

<h1>🟡 Hiển thị nội dung LumiBase trên app Next.js</h1>

<p><strong>Xây dựng trang Next.js đầu tiên với nội dung được phân phối từ LumiBase.</strong></p>

<p>
  <img alt="LumiBase version" src="https://img.shields.io/badge/LumiBase-%E2%89%A5%200.9.0%20%C2%B7%20verified%201.0.0-rc.1-F5A623?style=for-the-badge">
  <img alt="Level" src="https://img.shields.io/badge/C%E1%BA%A5p%20%C4%91%E1%BB%99-C%C6%A1%20b%E1%BA%A3n-3DDC97?style=for-the-badge">
  <img alt="Time" src="https://img.shields.io/badge/Th%E1%BB%9Di%20gian-~20%20ph%C3%BAt-4A90E2?style=for-the-badge">
  <img alt="Stack" src="https://img.shields.io/badge/Next.js-App%20Router-black?style=for-the-badge&logo=next.js">
</p>

</div>

> [!NOTE]
> **Tutorial này cho phiên bản nào?** Đúng từ **LumiBase `0.9.0`** trở lên (verify gần nhất
> trên `1.0.0-rc.1`). Vẫn đúng cho các bản
> mới hơn **cho tới khi** một trong các API contract ở bảng [Tương thích](#compatibility)
> thay đổi — xem bảng đó để chọn đúng version, **mới nhất ở trên cùng**.

Bạn sẽ:

1. Chạy LumiBase ở local (CMS API + Studio).
2. Hoàn tất setup wizard và tạo collection `posts` với vài item đã publish.
3. Tạo API key dài hạn và xác nhận `siteId`.
4. Dựng app Next.js nhỏ để đọc các bài viết đó bằng package `lumibase` chính thức
   (`fetch` thuần được trình bày sau như một lựa chọn thay thế).

Kết thúc, bạn có trang `http://localhost:3000` liệt kê các bài viết nằm trong LumiBase.

> **Cần có:** Node.js ≥ 22, pnpm ≥ 9, Docker + Docker Compose, Git.

---

## How the pieces fit together

<div align="center">
<table border="0" cellpadding="0" cellspacing="0">
<tr>
<td align="center" valign="middle" width="220" style="background:#1f2430;border-radius:12px;padding:16px;">
  <div style="font-size:32px;">🖥️</div>
  <strong>App Next.js</strong><br>
  <code>localhost:3000</code><br>
  <sub>frontend (code của bạn)</sub>
</td>
<td align="center" valign="middle" width="260">
  <div style="font-size:13px;color:#888;">GET /api/v1/items/posts</div>
  <div style="font-size:22px;">➡️</div>
  <div style="font-size:11px;color:#888;">Authorization: Bearer &lt;token&gt;<br>X-Lumi-Site: &lt;siteId&gt;</div>
  <div style="font-size:22px;">⬅️</div>
  <div style="font-size:13px;color:#888;">{ "data": [ …posts ] }</div>
</td>
<td align="center" valign="middle" width="220" style="background:#1f2430;border-radius:12px;padding:16px;">
  <div style="font-size:32px;">🟡</div>
  <strong>LumiBase</strong><br>
  <code>localhost:1989</code> · API<br>
  <code>localhost:2026</code> · Studio<br>
  <sub>Postgres · Redis · …</sub>
</td>
</tr>
</table>
</div>

LumiBase là backend headless (API + Studio quản trị). Next.js chỉ là client gọi vào
**Delivery API** qua HTTP. Mỗi request mang theo hai thứ: một **bearer token** (bạn là ai)
và header **`X-Lumi-Site`** (đọc từ tenant/site nào).

---

## Step 1 — Run LumiBase locally

```bash
git clone https://github.com/khuepm/lumibase.git
cd lumibase

pnpm install

# Backing services: PostgreSQL, Redis, MeiliSearch, Logto
docker compose -f docker/docker-compose.yml up -d

# Database migrations
pnpm -F @lumibase/database db:migrate

# Start CMS API (:1989) + Studio (:2026)
pnpm dev
```

Khi `pnpm dev` đang chạy:

<table>
<thead><tr><th>Dịch vụ</th><th>URL</th><th>Là gì</th></tr></thead>
<tbody>
<tr><td>🔌 CMS API</td><td><code>http://localhost:1989</code></td><td>REST API mà app Next.js gọi vào</td></tr>
<tr><td>🎛️ Studio</td><td><code>http://localhost:2026</code></td><td>UI quản trị để model & soạn nội dung</td></tr>
</tbody>
</table>

> Xem [Local Development](../deployment/local-development.md) để biết danh sách dịch vụ đầy
> đủ và cách xử lý sự cố.

---

## Step 2 — Complete the setup wizard

Lần chạy đầu database trống nên CMS kích hoạt **setup wizard**. Mở
**`http://localhost:1989/setup`** và:

1. Tạo **admin user** đầu tiên (email + mật khẩu — nhớ kỹ).
2. Đặt **tên site** và ngôn ngữ mặc định.
3. Hoàn tất. Response có kèm **backup codes** một lần — cất nơi an toàn.

> [!IMPORTANT]
> Setup wizard tạo một **site mặc định** với id **`__default__`**. Đó là `siteId` cho toàn
> bộ phần dưới. (Xác nhận bất kỳ lúc nào bằng `GET /api/v1/site` — xem Bước 4.)

Kiểm tra setup đã xong:

```bash
curl http://localhost:1989/health
# → { ... "setup_complete": true }
```

---

## Step 3 — Create a `posts` collection and add content

Trong **Studio** (`http://localhost:2026`):

<table>
<thead><tr><th>#</th><th>Thao tác</th></tr></thead>
<tbody>
<tr><td>1</td><td>Vào <strong>Collections → New Collection</strong>, đặt tên là <code>posts</code>.</td></tr>
<tr><td>2</td><td>Thêm các trường: <code>title</code> (String), <code>body</code> (Text). <strong>Không</strong> thêm trường <code>status</code> — mỗi item đã có sẵn cột <code>status</code> dựng sẵn do luồng publish điều khiển.</td></tr>
<tr><td>3</td><td>Lưu collection.</td></tr>
<tr><td>4</td><td>Vào <strong>Content → posts → New Item</strong>. Tạo 2–3 mục và đặt <code>status</code> = <strong>published</strong>.</td></tr>
</tbody>
</table>

> Muốn dùng API? Tạo collection bằng `POST /api/v1/collections` và item bằng
> `POST /api/v1/items/posts`. Xem [API spec](../api/hono-api-spec.md).

---

## Step 4 — Get an API key and confirm your `siteId`

App Next.js của bạn xác thực bằng bearer token. Với bản triển khai thực tế bạn sẽ cần
**API key dài hạn**, không phải token đăng nhập ngắn hạn.

**4a. Đăng nhập để lấy token phiên làm việc** (chỉ dùng để tạo API key):

```bash
curl -X POST http://localhost:1989/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Lumi-Site: __default__" \
  -d '{ "email": "admin@example.com", "password": "your-password" }'
```

Response (chú ý: trường này tên là **`token`**, đơn lẻ — phiên bản này không có
`access_token`/`refresh_token` riêng):

```json
{
  "data": {
    "token": "eyJhbGciOi...",
    "user": { "id": "usr_...", "email": "admin@example.com" }
  }
}
```

**4b. Tạo API key dài hạn** với token phiên làm việc đó:

```bash
curl -X POST http://localhost:1989/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" \
  -d '{ "name": "nextjs-frontend" }'
```

Response — sao chép `token` (bắt đầu bằng **`lbk_`** và chỉ hiển thị **một lần duy nhất**):

```json
{
  "data": {
    "id": "...",
    "name": "nextjs-frontend",
    "prefix": "lbk_",
    "token": "lbk_live_xxxxxxxxxxxxxxxx"
  }
}
```

**4c. Xác nhận `siteId`** (kiểm tra cho chắc):

```bash
curl http://localhost:1989/api/v1/site \
  -H "Authorization: Bearer lbk_live_xxxxxxxxxxxxxxxx" \
  -H "X-Lumi-Site: __default__"
# → { "data": { "id": "__default__", "name": "My Site", ... } }
```

> [!TIP]
> Giữ key `lbk_…` **chỉ ở phía server** — không bao giờ gửi xuống browser. Bên dưới ta dùng
> nó từ Next.js Server Component nên nó không rời khỏi server.

**4d. Cấp quyền tối thiểu cho key.** Key mới tạo chưa có quyền nào. Thay vì gắn
role Administrator, hãy tạo một policy chỉ *đọc* `posts`, giới hạn ở item đã
publish, rồi gắn qua một role:

```bash
# Policy với đúng một quy tắc: "đọc các bài đã publish"
curl -X POST http://localhost:1989/api/v1/policies \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" \
  -d '{ "name": "Blog read-only" }'

curl -X POST http://localhost:1989/api/v1/policies/<policy-id>/permissions \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" \
  -d '{ "collection": "posts", "action": "read",
        "permissions": { "status": { "_eq": "published" } } }'

# Role mang policy đó, rồi gắn role vào key
curl -X POST http://localhost:1989/api/v1/roles \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" -d '{ "name": "Blog Reader" }'

curl -X POST http://localhost:1989/api/v1/roles/<role-id>/policies \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" -d '{ "policyId": "<policy-id>" }'

curl -X POST http://localhost:1989/api/v1/api-keys/<key-id>/roles \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token-from-4a>" \
  -H "X-Lumi-Site: __default__" -d '{ "roleId": "<role-id>" }'
```

Quy tắc được áp dụng **ở phía server**: request từ key này dù bỏ qua
`status=published`, hay hỏi thẳng id của một bản nháp, vẫn chỉ nhận về item đã
publish (`404` với bản nháp). Thao tác ghi trả về `403`.

---

## Step 5 — Create the Next.js app

Trong một **thư mục riêng** (ngoài repo LumiBase):

```bash
npx create-next-app@latest my-lumibase-frontend
cd my-lumibase-frontend
```

Chọn mặc định (App Router, TypeScript). Tạo `.env.local`:

```bash
# .env.local — server-side only, NOT prefixed with NEXT_PUBLIC_
LUMIBASE_API_URL=http://localhost:1989
LUMIBASE_SITE_ID=__default__
LUMIBASE_TOKEN=lbk_live_xxxxxxxxxxxxxxxx
```

> Ta gọi LumiBase từ một **Server Component**, nên token nằm lại phía server và không phải
> cấu hình CORS. Đây cũng là cách khuyến nghị cho production.

---

## Step 6 — Fetch with the SDK

Cài `lumibase`. Một package cung cấp cả client bạn import lúc chạy lẫn CLI
`lumibase` dùng ở Step 7:

```bash
npm install lumibase
```

Tạo client một lần. Nó chỉ được import từ Server Component nên token không bao
giờ xuống tới browser:

```ts
// lib/lumibase.ts
import { createLumiClient, legacyRest, type ItemRow } from 'lumibase'

// Các trường nội dung của collection, đúng như khai báo trong Studio.
export interface PostFields {
  title: string
  body: string
  [key: string]: unknown
}

export type Post = ItemRow<PostFields>

export const lumibase = createLumiClient<{ posts: PostFields }>({
  url: process.env.LUMIBASE_API_URL!,
  siteId: process.env.LUMIBASE_SITE_ID!,
  // API key tĩnh — bỏ qua luồng login
  token: process.env.LUMIBASE_TOKEN!,
}).with(legacyRest())
```

```tsx
// app/page.tsx
import { lumibase, type Post } from '@/lib/lumibase'

export default async function Home() {
  // `status` là tham số riêng của list, không phải filter. Sắp xếp dùng tên
  // snake_case của cột cấu trúc.
  const { data: posts } = await lumibase.items('posts').list({
    status: 'published',
    sort: ['-created_at'],
    limit: 20,
  })

  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Posts from LumiBase</h1>
      {posts.length === 0 && <p>No published posts yet.</p>}
      <ul>
        {posts.map((post: Post) => (
          <li key={post.id} style={{ marginBottom: '1.5rem' }}>
            <h2>{post.data.title}</h2>
            <p>{post.data.body}</p>
          </li>
        ))}
      </ul>
    </main>
  )
}
```

> [!IMPORTANT]
> **Trường nội dung nằm trong `.data`.** Mỗi dòng là một `ItemRow`: các cột cấu
> trúc (`id`, `status`, `createdAt`, …) nằm ở cấp ngoài cùng, còn các trường bạn
> khai báo thì lồng bên trong — `post.data.title`, không phải `post.title`.

Chạy thử:

```bash
# mở http://localhost:3000
npm run dev
```

Bạn sẽ thấy các bài đã publish. Giao diện render đại khái như sau:

<div align="center">
<table border="0" width="520"><tr><td style="border:1px solid #d0d7de;border-radius:10px;padding:20px 28px;background:#ffffff;">
<div style="font-family:system-ui;">
<h2 style="margin:0 0 14px;color:#1f2430;">Posts from LumiBase</h2>
<div style="margin-bottom:16px;">
  <div style="font-size:18px;font-weight:600;color:#0a66c2;">Hello, Edge 👋</div>
  <div style="color:#444;">My first post served from LumiBase.</div>
</div>
<div style="margin-bottom:4px;">
  <div style="font-size:18px;font-weight:600;color:#0a66c2;">Why a Content OS</div>
  <div style="color:#444;">Intent in, reconciled content out.</div>
</div>
</div>
</td></tr></table>
<sub><em>Minh hoạ trang đã render (không phải ảnh chụp thật).</em></sub>
</div>

Đọc một bài đơn lẻ cũng tương tự. Mọi phản hồi khác 2xx đều ném `LumiError` kèm
status, ánh xạ gọn sang `notFound()`:

```tsx
// app/posts/[id]/page.tsx
import { notFound } from 'next/navigation'
import { LumiError } from 'lumibase'
import { lumibase, type Post } from '@/lib/lumibase'

// Bắt buộc. Thiếu dòng này thì route bị cache vĩnh viễn và nội dung sửa trong
// Studio không bao giờ hiện ra.
export const revalidate = 60

export default async function PostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let post: Post

  try {
    const res = await lumibase.items('posts').detail(id)
    post = res.data
  } catch (err) {
    if (err instanceof LumiError && err.status === 404) return notFound()
    throw err
  }

  return (
    <article>
      <h1>{post.data.title}</h1>
      <p>{post.data.body}</p>
    </article>
  )
}
```

Một bản nháp mà credential không được phép thấy sẽ trả `404` — cùng đường đi với
một id không tồn tại — nên nội dung chưa publish không thể lộ ra.

> [!IMPORTANT]
> **Khai báo `revalidate` cho mọi route được cache, không chỉ trang danh sách.**
> Route có `generateStaticParams` nhưng thiếu `revalidate` chỉ được render một
> lần lúc build rồi cache vĩnh viễn, nên nội dung sửa trong Studio không bao giờ
> hiện ra. Bài publish *sau* khi build vẫn phục vụ được: `dynamicParams` mặc
> định là `true` nên Next render on-demand ở lần truy cập đầu tiên.

> **Đang phụ thuộc `@lumibase/sdk`?** Nó export đúng cùng một client —
> `lumibase` chỉ re-export lại để một cái tên bao trọn cả client lẫn CLI. Đổi
> `from 'lumibase'` thành `from '@lumibase/sdk'` là mọi thứ ở trên chạy nguyên vẹn.

---

## Step 7 — Generate types in CI

`lumibase types` biến schema đang chạy thành định nghĩa TypeScript. Hãy commit
kết quả và để CI báo lỗi khi nó lệch với schema.

Tạo `lumibase.config.json` cạnh `package.json` (file này để commit — nó không
chứa secret):

```json
{
  "url": "http://localhost:1989",
  "siteId": "__default__",
  "typegen": { "out": "src/lumibase-types.d.ts" }
}
```

```bash
# ghi src/lumibase-types.d.ts — hãy commit
npx lumibase types
# thoát khác 0 nếu file đã cũ
npx lumibase types --check
# xem cấu hình đã resolve và kiểm tra kết nối
npx lumibase doctor
```

> [!IMPORTANT]
> **Typegen cần token của staff user, không phải API key.**
> `GET /api/v1/typegen/schema` nằm sau bức tường Studio access vốn đòi principal
> là user. API key bị từ chối với `403` kể cả khi role của nó có `schema:read`.
> Hãy dùng access token của một staff user làm secret lúc build cho typegen, còn
> API key chỉ-đọc ở Step 4 thì để cho các lượt đọc lúc chạy của trang.

File sinh ra mang tính tất định — header không chứa host, site id hay timestamp
— nên cùng một file đã commit verify được trên mọi instance:

```yaml
- run: npm ci
- run: npx lumibase types --check
  env:
    LUMIBASE_URL: ${{ secrets.LUMIBASE_URL }}
    LUMIBASE_SITE_ID: ${{ secrets.LUMIBASE_SITE_ID }}
    LUMIBASE_TOKEN: ${{ secrets.LUMIBASE_TYPEGEN_TOKEN }}
```

---

## Alternative — the same read with plain `fetch`

SDK chỉ bọc lại HTTP API; không có gì ngăn bạn gọi thẳng nếu không muốn thêm
dependency. Đổi lại bạn mất kết quả có kiểu và mất typegen, đồng thời phải tự
dựng URL, header và mã hoá filter:

```tsx
// app/page.tsx
type Post = { id: string; status: string; data: { title: string; body: string } }

async function getPosts(): Promise<Post[]> {
  const url = new URL('/api/v1/items/posts', process.env.LUMIBASE_API_URL)
  url.searchParams.set('status', 'published')
  // Tham số `filter` nhận hai dạng tương đương — chọn dạng nào cũng được:
  //   (A) chuỗi JSON:   filter={"status":{"_eq":"published"}}
  //   (B) dạng ngoặc:   filter[status][_eq]=published
  url.searchParams.set('sort', '-created_at')

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.LUMIBASE_TOKEN}`,
      'X-Lumi-Site': process.env.LUMIBASE_SITE_ID!,
    },
    // cache kiểu ISR; dùng 'no-store' nếu cần luôn mới
    next: { revalidate: 60 },
  })

  if (!res.ok) throw new Error(`LumiBase responded ${res.status}: ${await res.text()}`)

  const json = (await res.json()) as { data: Post[] }
  return json.data
}
```

---

## Troubleshooting

<table>
<thead><tr><th>Triệu chứng</th><th>Nguyên nhân khả dĩ</th><th>Cách khắc phục</th></tr></thead>
<tbody>
<tr><td><code>401 Unauthorized</code></td><td>Token thiếu hoặc không hợp lệ</td><td>Kiểm tra lại <code>LUMIBASE_TOKEN</code>; tạo lại API key (Bước 4b)</td></tr>
<tr><td><code>423 SETUP_REQUIRED</code></td><td>Chưa hoàn tất setup</td><td>Hoàn tất <code>http://localhost:1989/setup</code> (Bước 2)</td></tr>
<tr><td><code>404 TENANT_NOT_FOUND</code></td><td>Sai <code>X-Lumi-Site</code> — header đúng định dạng nhưng site không tồn tại</td><td>Dùng <code>__default__</code> trừ khi bạn đã tạo site khác</td></tr>
<tr><td>Mảng trống <code>data: []</code></td><td>Chưa có bài viết <strong>published</strong> nào</td><td>Đặt trạng thái item thành <code>published</code> trong Studio</td></tr>
<tr><td><code>404</code> trên items</td><td>Sai tên collection</td><td>Collection phải đặt tên chính xác là <code>posts</code></td></tr>
<tr><td>Lỗi CORS ở trình duyệt</td><td>Gọi API từ client code</td><td>Gọi từ một <strong>Server Component</strong> (như hướng dẫn trên)</td></tr>
<tr><td><code>429 RATE_LIMITED</code></td><td>Quá nhiều request từ một key/IP</td><td>Lùi lại; tuân thủ header <code>Retry-After</code> (xem bên dưới)</td></tr>
<tr><td><code>503 RATE_LIMIT_UNAVAILABLE</code></td><td>Cache rate-limit của server gián đoạn (triển khai fail-closed)</td><td>Tạm thời — thử lại với lùi thời gian; không phải lỗi app của bạn</td></tr>
</tbody>
</table>

---

## Production & security notes for frontends

Luồng hoạt động ở trên áp dụng tốt cho localhost. Trước khi triển khai thật, hãy đấu nối các hợp đồng mà một client LumiBase được kỳ vọng tuân thủ. Các lưu ý này càng quan trọng hơn khi frontend của bạn là một bản triển khai công khai (Next.js trên Vercel/Cloudflare, v.v.).

### 1. Giữ API key phía server — luôn luôn

Key `lbk_…` là một **bearer credential**. Chỉ đọc nó trong Server Components, Route Handlers, hoặc Server Actions — không bao giờ đọc trong component `'use client'` và không bao giờ đặt tiền tố `NEXT_PUBLIC_` (vì chúng sẽ bị chèn thẳng vào bundle trình duyệt). Nếu trình duyệt thực sự cần dữ liệu, hãy proxy qua Route Handler của riêng bạn để key luôn nằm ở phía server.

### 2. Xử lý giới hạn tốc độ (`429`) và `503` khi fail-closed

LumiBase giới hạn tốc độ theo principal/IP và theo site. Hai phản hồi mà lớp fetch của bạn nên xử lý:

- **`429 RATE_LIMITED`** — bạn đã vượt quá cửa sổ giới hạn. Response có kèm `Retry-After` (giây) và `X-RateLimit-Reset`. Hãy lùi thời gian; không bắn request liên tục.
- **`503 RATE_LIMIT_UNAVAILABLE`** *(LumiBase ≥ 0.24.0)* — chỉ trong các bản triển khai bật limiter **fail-closed** (`LUMIBASE_RATE_LIMIT_FAIL_CLOSED=true`): cache của limiter tạm thời gián đoạn. Đây là sự cố tạm thời và không phải lỗi app — hãy thử lại với lùi thời gian.

```ts
async function lumibaseFetch(url: string | URL, init?: RequestInit, attempt = 0): Promise<Response> {
  const res = await fetch(url, init)
  if ((res.status === 429 || res.status === 503) && attempt < 3) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 2 ** attempt
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
    return lumibaseFetch(url, init, attempt + 1)
  }
  return res
}
```

### 3. Theo dõi header `Deprecation` / `Sunset` *(LumiBase ≥ 0.24.0)*

Một điểm cuối sắp dừng hoạt động sẽ trả về các header theo chuẩn RFC 8594: `Deprecation`, `Sunset` (ngày giờ), và `Link rel="deprecation"` dẫn tới changelog. Hãy log lại ở phía client để điểm cuối không bất ngờ biến mất:

```ts
if (res.headers.get('Deprecation')) {
  console.warn('[LumiBase] deprecated endpoint; sunset:', res.headers.get('Sunset'))
}
```

### 4. Gọi từ trình duyệt? Hãy cấu hình CORS cẩn thận

Mẫu thiết kế Server-Component ở trên không cần CORS. Nếu bạn buộc phải gọi API từ client code, CMS chỉ cho phép các origin **khớp chính xác** nằm trong `CORS_ALLOWED_ORIGINS` — một credentialed response **không bao giờ** trả về cho wildcard `*`. Hãy thêm origin frontend của bạn một cách tường minh (ví dụ `https://app.example.com`), và nhớ rằng các cuộc gọi từ client làm lộ bất kỳ token nào mà nó mang theo, nên hãy dùng token ngắn hạn / phạm vi hẹp chứ không dùng key `lbk_…`.

### 5. `/test-auth` là trang thử nghiệm dev-only

Trang xác thực tương tác tại `/test-auth` là công cụ cho nhà phát triển. Từ **LumiBase ≥ 0.24.0** nó sẽ trả về `404` trên production — đừng dựng bất kỳ thứ gì phụ thuộc vào việc nó truy cập được trên host production.

### 6. Cập nhật bản vá Next.js — cảnh báo SSRF

Vấn đề an toàn môi trường của framework frontend là một phần trong bề mặt tấn công của API. Các bản phát hành Next.js gần đây đã vá các lỗ hổng **server-side request forgery (SSRF)**:

- `GHSA-89xv-2m56-2m9x` — SSRF trong Server Actions trên các custom server.
- `GHSA-p9j2-gv94-2wf4` — SSRF trong `rewrites` qua host đích do kẻ tấn công điều khiển.

Sử dụng **`next` ≥ 16.2.11**, và không bao giờ dựng đích cho `rewrites`/Server-Action từ input người dùng chưa được xác thực (hostname hay URL đầy đủ do người dùng cung cấp). Nếu buộc phải fetch một URL người dùng cung cấp từ phía server, hãy xác minh nó đối với một danh sách cho phép (allowlist) và chặn các dải IP nội bộ/metadata — tương tự như cơ chế phòng thủ SSRF mà LumiBase tự áp dụng.

---

## Compatibility

Tutorial này được **ghim vào phiên bản LumiBase tối thiểu** và chỉ được xác minh lại khi một hợp đồng API mà nó dựa vào thực sự thay đổi. Chọn dòng khớp với phiên bản LumiBase của bạn (**mới nhất ở trên cùng**):

<table>
<thead><tr><th>Phiên bản LumiBase</th><th>Tutorial này</th><th>Ghi chú</th></tr></thead>
<tbody>
<tr><td><strong>0.9.0 → mới nhất</strong></td><td>✅ Trang này (đã verify trên <code>1.0.0-rc.1</code>)</td><td>Đăng nhập trả về <code>{ data: { token } }</code>; API key qua <code>POST /api/v1/api-keys</code> (tiền tố <code>lbk_</code>); bộ lọc item chấp nhận định dạng JSON <em>và</em> ngoặc vuông; site mặc định <code>__default__</code>.</td></tr>
<tr><td>&lt; 0.9.0</td><td>⚠️ Chưa bao phủ</td><td>Các bản cũ hơn trước thời điểm có các hợp đồng trên. Hãy nâng cấp lên ≥ 0.9.0, hoặc điều chỉnh các cuộc gọi auth/filter theo phiên bản của bạn.</td></tr>
</tbody>
</table>

**Các hợp đồng mà tutorial này phụ thuộc vào** (nếu bất kỳ hợp đồng nào thay đổi trong bản phát hành tương lai, hãy cập nhật bảng ở trên và xác minh lại — xem DoD §5):

- `POST /api/v1/auth/login` → `{ data: { token, user } }`
- `POST /api/v1/api-keys` → `{ data: { token: "lbk_…" } }`
- `GET /api/v1/items/:collection` bộ lọc chấp nhận **cả** `filter=<JSON>` và
  dạng ngoặc vuông `filter[field][_op]=value` (JSON ưu tiên hơn nếu gửi cả hai); `sort=<csv>`
- `GET /api/v1/site` trả về tenant đang hoạt động; id mặc định `__default__`
- `lumibase` (re-export `@lumibase/sdk`) —
  `createLumiClient({ url, siteId, token }).with(legacyRest()).items(c).list(...)` /
  `.detail(id)`; mỗi dòng là `ItemRow` với trường nội dung nằm trong `.data`
- `lumibase types` / `types --check` đọc `GET /api/v1/typegen/schema`, vốn đòi
  principal là **staff user** (API key nhận `403`)
- Giới hạn tốc độ trả về `429 RATE_LIMITED` kèm `Retry-After`; mục "Production & security" bao phủ thêm `503 RATE_LIMIT_UNAVAILABLE` và
  header `Deprecation`/`Sunset`, cả hai **được thêm từ `0.24.0`** (luồng cốt lõi ở trên vẫn hoạt động không đổi từ `0.9.0`)

---

## Next steps

- [Tài liệu tham khảo JavaScript SDK](../sdk/javascript.md) — auth, items, files, realtime, Flows.
- [Đặc tả API](../api/hono-api-spec.md) — mọi điểm cuối, bộ lọc, phân trang.
- [Tổng quan triển khai](../deployment/overview.md) — đưa dự án từ localhost lên dev / staging / production (Cloudflare hoặc Docker).
