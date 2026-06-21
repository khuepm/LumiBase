---
title: Next.js Quickstart — Hiển thị nội dung LumiBase
---

<!--
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ TUTORIAL VERSIONING — đọc trước khi sửa                                     │
  │                                                                            │
  │ applies_to_min: 0.9.0   ← phiên bản LumiBase thấp nhất tutorial còn đúng   │
  │ verified_on:    0.9.0   ← phiên bản đã thực sự test lần gần nhất           │
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

<p><strong>Đi từ máy trống đến một trang Next.js render nội dung từ LumiBase.</strong></p>

<p>
  <img alt="LumiBase version" src="https://img.shields.io/badge/LumiBase-0.9.0-F5A623?style=for-the-badge">
  <img alt="Level" src="https://img.shields.io/badge/C%E1%BA%A5p%20%C4%91%E1%BB%99-C%C6%A1%20b%E1%BA%A3n-3DDC97?style=for-the-badge">
  <img alt="Time" src="https://img.shields.io/badge/Th%E1%BB%9Di%20gian-~20%20ph%C3%BAt-4A90E2?style=for-the-badge">
  <img alt="Stack" src="https://img.shields.io/badge/Next.js-App%20Router-black?style=for-the-badge&logo=next.js">
</p>

</div>

> [!NOTE]
> **Tutorial này cho phiên bản nào?** Nhắm tới **LumiBase `0.9.0`**. Vẫn đúng cho các bản
> mới hơn **cho tới khi** một trong các API contract ở bảng [Tương thích](#tương-thích)
> thay đổi — xem bảng đó để chọn đúng version, **mới nhất ở trên cùng**.

Bạn sẽ:

1. Chạy LumiBase ở local (CMS API + Studio).
2. Hoàn tất setup wizard và tạo collection `posts` với vài item đã publish.
3. Tạo API key dài hạn và xác nhận `siteId`.
4. Dựng app Next.js nhỏ để đọc các bài viết đó — đầu tiên bằng `fetch` thuần, sau đó bằng
   `@lumibase/sdk`.

Kết thúc, bạn có trang `http://localhost:3000` liệt kê các bài viết nằm trong LumiBase.

> **Cần có:** Node.js ≥ 20, pnpm ≥ 9, Docker + Docker Compose, Git.

---

## Các thành phần ghép với nhau thế nào

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

## Bước 1 — Chạy LumiBase ở local

```bash
git clone https://github.com/khuepm/lumibase.git
cd lumibase

pnpm install

# Dịch vụ nền: PostgreSQL, Redis, MeiliSearch, Logto
docker compose -f docker/docker-compose.yml up -d

# Chạy migration database
pnpm -F @lumibase/database db:migrate

# Khởi động CMS API (:1989) + Studio (:2026)
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

## Bước 2 — Hoàn tất setup wizard

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

## Bước 3 — Tạo collection `posts` và thêm nội dung

Trong **Studio** (`http://localhost:2026`):

<table>
<thead><tr><th>#</th><th>Thao tác</th></tr></thead>
<tbody>
<tr><td>1</td><td>Vào <strong>Collections → New Collection</strong>, đặt tên <code>posts</code>.</td></tr>
<tr><td>2</td><td>Thêm field: <code>title</code> (String), <code>body</code> (Text), <code>status</code> (Select: <code>draft</code> / <code>published</code>, mặc định <code>draft</code>).</td></tr>
<tr><td>3</td><td>Lưu collection.</td></tr>
<tr><td>4</td><td>Vào <strong>Content → posts → New Item</strong>. Tạo 2–3 item, đặt <code>status</code> = <strong>published</strong>.</td></tr>
</tbody>
</table>

> Thích dùng API? Tạo collection bằng `POST /api/v1/collections` và item bằng
> `POST /api/v1/items/posts`. Xem [API spec](../api/hono-api-spec.md).

---

## Bước 4 — Lấy API key và xác nhận `siteId`

App Next.js xác thực bằng bearer token. Với tích hợp thực tế bạn nên dùng **API key dài
hạn**, không dùng token login ngắn hạn.

**4a. Đăng nhập để lấy session token** (chỉ dùng để tạo API key):

```bash
curl -X POST http://localhost:1989/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Lumi-Site: __default__" \
  -d '{ "email": "admin@example.com", "password": "your-password" }'
```

Response (lưu ý: field là **`token`**, một token duy nhất — bản này KHÔNG tách
`access_token`/`refresh_token`):

```json
{
  "data": {
    "token": "eyJhbGciOi...",
    "user": { "id": "usr_...", "email": "admin@example.com" }
  }
}
```

**4b. Tạo API key dài hạn** bằng session token đó:

```bash
curl -X POST http://localhost:1989/api/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token-từ-4a>" \
  -H "X-Lumi-Site: __default__" \
  -d '{ "name": "nextjs-frontend" }'
```

Response — copy `token` (bắt đầu bằng **`lbk_`**, chỉ hiện **một lần**):

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

---

## Bước 5 — Tạo app Next.js

Trong một **thư mục riêng** (ngoài repo LumiBase):

```bash
npx create-next-app@latest my-lumibase-frontend
cd my-lumibase-frontend
```

Chọn mặc định (App Router, TypeScript). Tạo `.env.local`:

```bash
# .env.local — chỉ server-side, KHÔNG đặt tiền tố NEXT_PUBLIC_
LUMIBASE_API_URL=http://localhost:1989
LUMIBASE_SITE_ID=__default__
LUMIBASE_TOKEN=lbk_live_xxxxxxxxxxxxxxxx
```

> Ta gọi LumiBase từ một **Server Component**, nên token nằm lại phía server và không phải
> cấu hình CORS. Đây cũng là cách khuyến nghị cho production.

---

## Bước 6 (Cách A) — Fetch bằng `fetch` thuần

Không cần dependency thêm. Thay nội dung `app/page.tsx`:

```tsx
// app/page.tsx
type Post = { id: string; title: string; body: string; status: string }

async function getPosts(): Promise<Post[]> {
  const url = new URL('/api/v1/items/posts', process.env.LUMIBASE_API_URL)
  // Param `filter` chấp nhận hai cách tương đương — chọn một:
  //   (A) chuỗi JSON:
  url.searchParams.set('filter', JSON.stringify({ status: { _eq: 'published' } }))
  //   (B) cú pháp ngoặc vuông (tiện khi viết URL tay):
  //   url.searchParams.set('filter[status][_eq]', 'published')
  url.searchParams.set('sort', '-created_at')

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.LUMIBASE_TOKEN}`,
      'X-Lumi-Site': process.env.LUMIBASE_SITE_ID!,
    },
    next: { revalidate: 60 }, // cache kiểu ISR; dùng 'no-store' nếu muốn luôn mới
  })

  if (!res.ok) throw new Error(`LumiBase trả về ${res.status}: ${await res.text()}`)

  const json = (await res.json()) as { data: Post[] }
  return json.data
}

export default async function Home() {
  const posts = await getPosts()
  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Bài viết từ LumiBase</h1>
      {posts.length === 0 && <p>Chưa có bài viết nào được publish.</p>}
      <ul>
        {posts.map((post) => (
          <li key={post.id} style={{ marginBottom: '1.5rem' }}>
            <h2>{post.title}</h2>
            <p>{post.body}</p>
          </li>
        ))}
      </ul>
    </main>
  )
}
```

Chạy thử:

```bash
npm run dev   # mở http://localhost:3000
```

Bạn sẽ thấy các bài đã publish. Đại khái trang render như sau:

<div align="center">
<table border="0" width="520"><tr><td style="border:1px solid #d0d7de;border-radius:10px;padding:20px 28px;background:#ffffff;">
<div style="font-family:system-ui;">
<h2 style="margin:0 0 14px;color:#1f2430;">Bài viết từ LumiBase</h2>
<div style="margin-bottom:16px;">
  <div style="font-size:18px;font-weight:600;color:#0a66c2;">Xin chào, Edge 👋</div>
  <div style="color:#444;">Bài viết đầu tiên phục vụ từ LumiBase.</div>
</div>
<div style="margin-bottom:4px;">
  <div style="font-size:18px;font-weight:600;color:#0a66c2;">Vì sao cần Content OS</div>
  <div style="color:#444;">Ý định vào, nội dung được reconcile ra.</div>
</div>
</div>
</td></tr></table>
<sub><em>Minh hoạ trang render (không phải screenshot thật).</em></sub>
</div>

---

## Bước 6 (Cách B) — Fetch bằng SDK

SDK loại bỏ boilerplate (dựng URL, header, encode filter) và trả kết quả có kiểu.

```bash
npm install @lumibase/sdk
```

```ts
// lib/lumibase.ts
import { createClient } from '@lumibase/sdk'

export const lumibase = createClient({
  url: process.env.LUMIBASE_API_URL!,
  siteId: process.env.LUMIBASE_SITE_ID!,
  token: process.env.LUMIBASE_TOKEN!, // API key tĩnh — bỏ qua bước login
})
```

```tsx
// app/page.tsx
import { lumibase } from '@/lib/lumibase'

export default async function Home() {
  const posts = await lumibase.items('posts').readMany({
    filter: { status: { _eq: 'published' } },
    sort: ['-created_at'],
    limit: 20,
  })
  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Bài viết từ LumiBase</h1>
      {posts.length === 0 && <p>Chưa có bài viết nào được publish.</p>}
      <ul>
        {posts.map((post: any) => (
          <li key={post.id} style={{ marginBottom: '1.5rem' }}>
            <h2>{post.title}</h2>
            <p>{post.body}</p>
          </li>
        ))}
      </ul>
    </main>
  )
}
```

Cùng kết quả, ít code hơn. Muốn `post.title` có kiểu thay vì `any`, sinh type từ schema —
xem [SDK type generation](../sdk/typegen.md).

---

## Xử lý sự cố

<table>
<thead><tr><th>Triệu chứng</th><th>Nguyên nhân</th><th>Cách sửa</th></tr></thead>
<tbody>
<tr><td><code>401 Unauthorized</code></td><td>Thiếu/sai token</td><td>Kiểm tra <code>LUMIBASE_TOKEN</code>; tạo lại API key (Bước 4b)</td></tr>
<tr><td><code>423 SETUP_REQUIRED</code></td><td>Chưa xong setup</td><td>Hoàn tất <code>http://localhost:1989/setup</code> (Bước 2)</td></tr>
<tr><td><code>404 SITE_NOT_FOUND</code></td><td>Sai/thiếu <code>X-Lumi-Site</code></td><td>Dùng <code>__default__</code> trừ khi đã tạo site khác</td></tr>
<tr><td><code>data: []</code> rỗng</td><td>Chưa có bài <strong>published</strong></td><td>Đặt item là <code>published</code> trong Studio</td></tr>
<tr><td><code>404</code> ở items</td><td>Sai tên collection</td><td>Collection phải đặt đúng tên <code>posts</code></td></tr>
<tr><td>Lỗi CORS trên browser</td><td>Fetch từ code client</td><td>Fetch trong <strong>Server Component</strong> (như trên)</td></tr>
</tbody>
</table>

---

## Tương thích

Tutorial này **pin theo phiên bản LumiBase tối thiểu** và chỉ verify lại khi một API
contract nó dựa vào thực sự thay đổi. Chọn dòng khớp với phiên bản của bạn
(**mới nhất ở trên cùng**):

<table>
<thead><tr><th>Phiên bản LumiBase</th><th>Tutorial này</th><th>Ghi chú</th></tr></thead>
<tbody>
<tr><td><strong>0.9.0 → mới nhất</strong></td><td>✅ Trang này (verify trên <code>0.9.0</code>)</td><td>Login trả <code>{ data: { token } }</code>; API key qua <code>POST /api/v1/api-keys</code> (prefix <code>lbk_</code>); filter items chấp nhận JSON <em>và</em> ngoặc vuông; site mặc định <code>__default__</code>.</td></tr>
<tr><td>&lt; 0.9.0</td><td>⚠️ Không bao gồm</td><td>Các bản cũ hơn có trước những contract trên. Nâng lên ≥ 0.9.0, hoặc tự chỉnh phần auth/filter cho version của bạn.</td></tr>
</tbody>
</table>

**Các contract tutorial phụ thuộc** (nếu bản tương lai đổi một trong số này thì bump bảng
trên và verify lại — xem DoD §5):

- `POST /api/v1/auth/login` → `{ data: { token, user } }`
- `POST /api/v1/api-keys` → `{ data: { token: "lbk_…" } }`
- `GET /api/v1/items/:collection` filter chấp nhận **cả** `filter=<JSON>` lẫn
  `filter[field][_op]=value` (JSON thắng nếu gửi cả hai); `sort=<csv>`
- `GET /api/v1/site` trả tenant đang hoạt động; id mặc định `__default__`
- `@lumibase/sdk` `createClient({ url, siteId, token }).items(c).readMany(...)`

---

## Bước tiếp theo

- [JavaScript SDK reference](../sdk/javascript.md) — auth, items, files, realtime, Flows.
- [API specification](../api/hono-api-spec.md) — mọi endpoint, filter, phân trang.
- [Deployment overview](../deployment/overview.md) — đưa từ localhost lên dev / staging /
  production (Cloudflare hoặc Docker).
