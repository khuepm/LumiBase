---
version: 3
lastUpdated: 2026-09-14T21:26:07.815Z
sourceLang: en
translatedFrom: en
sourceHash: 99526fe6886264cb
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-09-14T21:26:07.815Z
codeVerifiedHash: 99526fe6886264cb
codeVerifiedClaims: 8
---

# Getting Started — Khởi tạo dự án mới bằng `create-lumibase`

`create-lumibase` là công cụ bootstrap dự án chính thức của LumiBase. Từ một thư
mục trống bạn chạy một lệnh duy nhất và có ngay một dự án sẵn sàng chạy, tương tự
`create-next-app` hay `create-vite`.

## Bạn thật sự cần cái nào?

Có ba việc khác nhau đều được gọi là "cài LumiBase". Chúng không thay thế được
cho nhau, nên hãy chọn đúng dòng khớp với thứ bạn đang xây.

| Bạn muốn… | Dùng | Những gì bạn nhận được |
|-----------|-----|--------------|
| **Một website có CMS phía sau** | `create-lumibase` → template `nextjs` (trang này, được chọn sẵn) | Một site Next.js **kèm** CMS thật và Studio chạy trong Docker, một collection `posts`, nội dung mẫu, và một publishable key an toàn cho trình duyệt. |
| **Một starter app bạn tự sở hữu, không cần CMS** | `create-lumibase` → template `default` hoặc `cloudflare` | Một dự án **Hono + Drizzle** tối giản với tài nguyên mẫu `posts`. Không có Collections API, không có Studio — quy ước của LumiBase, không phải nền tảng. |
| **Chỉ riêng nền tảng** | Image CMS `ghcr.io/khuepm/lumibase-cms` hoặc bản clone của [monorepo](https://github.com/khuepm/lumibase) | Nền tảng hoàn chỉnh mà không kèm khung ứng dụng: Collections API, Studio admin, Email, Flows, AI, multi-tenancy. Xem [Phát triển cục bộ](./deployment/local-development.md) và [Tổng quan triển khai](./deployment/overview.md). |
| **Đọc dữ liệu từ một CMS đã có sẵn** | `npm install lumibase` — không cần khung nào cả | Client REST/realtime có type và CLI `lumibase` trong cùng một package. Xem [CLI](./cli/index.md) và [JS SDK](./sdk/javascript.md). |

Dòng cuối là dòng bị hiểu sai nhiều nhất, nên cần nói thẳng: **`lumibase` là
dependency runtime, không phải công cụ dev.** Ứng dụng của bạn import từ nó lúc
xử lý request, nên nó thuộc `dependencies`:

```bash
npm install lumibase        # ✅ runtime client + CLI
npm install -D lumibase     # ❌ the import disappears in production installs
```

Cùng package đó mang theo CLI, nên không phải cài thêm gì cho `lumibase types`
hay `lumibase doctor`.

> **Package:** [`create-lumibase`](../../packages/create-lumibase) ·
> **Published as:** `create-lumibase` trên npm ·
> **Node:** `>= 22`

## Quick start

```bash
# any of these work — npx resolves the create-* convention
npm create lumibase@latest my-project
npx create-lumibase@latest my-project
pnpm create lumibase my-project
```

Khi không có tham số nào, CLI sẽ chạy ở chế độ tương tác và hỏi mọi thông tin cần
thiết. Câu hỏi đầu tiên là câu quan trọng nhất — nó chọn template, và lựa chọn
Next.js được chọn sẵn.

## Điều gì diễn ra, theo từng bước

```
npx create-lumibase@latest my-blog
│
├─ 1. npx downloads the create-lumibase package from npm
│
├─ 2. Interactive prompts (skipped when flags are passed)
│     ? Project name          my-blog
│     ? Deployment target      › Next.js website  + CMS, Studio and seed content (recommended)
│                                Docker           Node.js + PostgreSQL
│                                Cloudflare Workers  Edge + D1
│     ? Package manager        › pnpm / npm / yarn / bun  (auto-detected)
│     ? Install dependencies   › Yes
│     ? Initialize git         › Yes
│
├─ 3. Scaffold files from the bundled template (Handlebars-rendered)
│       └── project name injected into package.json, server, wrangler.toml…
│
├─ 4. git init + first commit            (if chosen)
│
├─ 5. install dependencies               (if chosen)
│
└─ 6. print exact next steps for the chosen stack
```

### Xử lý thư mục trống và ghi đè

- Nếu thư mục đích chưa tồn tại thì nó sẽ được tạo.
- Nếu thư mục đã tồn tại **và không rỗng**, CLI sẽ hỏi trước khi ghi đè.
- Tên dự án được kiểm tra theo quy tắc đặt tên package của npm (chữ thường, không
  khoảng trắng, không được bắt đầu bằng `.`/`_`, ≤ 214 ký tự).

## Templates

| Template | Flag | Stack | Phù hợp nhất cho |
| --- | --- | --- | --- |
| **Next.js website + CMS** (chọn sẵn) | `--template nextjs` | Next.js 15 + React 19, client `lumibase`, và image CMS (đã kèm Studio) + PostgreSQL + Redis qua `docker-compose.yml` | Xuất bản một site thật: editor có Studio, trình duyệt chỉ có key chỉ-đọc |
| **Docker starter** | `--template default` | Hono + `@hono/node-server`, Drizzle ORM, PostgreSQL, Redis, `docker-compose.yml` | Tự xây API của bạn theo quy ước LumiBase |
| **Cloudflare Workers starter** | `--template cloudflare` | Hono, Drizzle ORM, D1, `wrangler.toml` | Vẫn starter đó, nhưng triển khai ở edge |

> **Một cái bẫy tên gọi nên biết:** template *tên* `default` không còn là lựa
> chọn *mặc định*. `--template default` vẫn chọn Docker starter, nhưng tuỳ chọn
> được chọn sẵn trong prompt là `nextjs`. Tên cũ được giữ để tương thích với các
> script đang dùng.

### Các file được sinh ra (template Next.js)

```
my-blog/
├── docker-compose.yml      # CMS (Studio included) + Postgres + Redis, bound to 127.0.0.1
├── next.config.mjs
├── package.json            # dev/build/start + cms:up/cms:bootstrap/cms:seed/cms:verify
├── tsconfig.json
├── .env.example            # NEXT_PUBLIC_* (browser-safe) vs server-only, split and labelled
├── .gitignore
├── app/
│   ├── layout.tsx
│   ├── page.tsx            # lists published posts; shows setup steps until configured
│   └── globals.css
├── lib/
│   └── lumibase.ts         # createLumiClient + readItems from `lumibase`
└── scripts/
    ├── lumibase.mjs        # shared request helper
    ├── bootstrap.mjs       # first admin + public read grant + publishable key
    ├── seed.mjs            # sample posts (idempotent, leaves one draft on purpose)
    └── verify.mjs          # asserts the public client cannot read drafts or write
```

Cách chia trong `.env.example` chính là điểm cốt lõi của template này. Các giá trị
`NEXT_PUBLIC_*` được nhúng vào bundle phía client, nên credential duy nhất ở đó là
một **publishable key** (`lbk_pub_…`) — chỉ đọc, khoá theo origin, và bị giới hạn ở
các bản ghi đã publish bởi grant đứng sau nó. Admin token nằm ở
`LUMIBASE_ADMIN_TOKEN`, không có tiền tố `NEXT_PUBLIC_`, nên Next.js không thể để
lộ nó ra trình duyệt.

### Các file được sinh ra (Docker starter)

```
my-blog/
├── docker-compose.yml      # Postgres + Redis
├── drizzle.config.ts       # → ./src/db/schema.ts
├── package.json            # dev/build/start + db:generate/db:migrate/db:studio
├── tsconfig.json
├── .env.example            # DATABASE_URL, REDIS_URL, JWT_SECRET, PORT…
├── .gitignore
└── src/
    ├── server.ts           # Hono app + GET/POST /posts demo resource
    └── db/
        ├── schema.ts        # posts table — nanoid id, site_id, timestamps
        ├── client.ts        # drizzle-orm + postgres client
        └── migrate.ts       # migration runner
```

Tài nguyên mẫu `posts` tuân theo [các quy tắc không thể thương lượng](../../CLAUDE.md)
của dự án: ID dùng `nanoid()`, một cột `site_id` trên mọi bảng domain, bao bọc
response trong `{ data }` / `{ errors }`, và xác thực request bằng Zod.

## Sử dụng không tương tác (CI / scripted)

Truyền các cờ (flag) để bỏ qua hoàn toàn các câu hỏi tương tác:

```bash
npx create-lumibase@latest my-blog \
  --template nextjs \
  --pm pnpm \
  --no-install \
  --no-git
```

| Cờ (Flag) | Mô tả |
| --- | --- |
| `--template <nextjs\|default\|cloudflare>` | Template dự án. Tên không hợp lệ bị từ chối ngay từ đầu, kèm giá trị bạn đã truyền. |
| `--pm <pnpm\|npm\|yarn\|bun>` | Package manager dùng để cài đặt. Tự động phát hiện từ `npm_config_user_agent` khi bỏ trống. |
| `--install` / `--no-install` | Bắt buộc bật hoặc bỏ qua bước cài đặt dependency. |
| `--git` / `--no-git` | Bắt buộc bật hoặc bỏ qua `git init` + commit đầu tiên. |
| `DEBUG=1` (env) | In đường dẫn từng file được sinh ra và xuất đầy đủ stack trace khi xảy ra lỗi. |

Bỏ trống `--template` trong môi trường không tương tác vẫn dẫn tới prompt, nên hãy
truyền nó tường minh khi chạy trong CI.

## Lần chạy đầu tiên sau khi khởi tạo

Scaffolder in ra đúng các bước này cho package manager bạn đã chọn. Các lệnh bên
dưới dùng `npm run`; `pnpm cms:up`, `yarn cms:up` và `bun run cms:up` là tương
đương.

### Template Next.js

```bash
cd my-blog
cp .env.example .env       # fill in secrets
npm install                # only if you used --no-install
npm run cms:up             # CMS + Studio + Postgres + Redis
npm run cms:bootstrap      # first admin, public read grant, publishable key
npm run cms:seed           # sample posts
npm run dev                # http://localhost:3000
```

Không có bước migrate: container CMS tự chạy migration của nó ở lần boot đầu tiên.
`cms:bootstrap` ghi publishable key trở lại vào `.env` giúp bạn, và cả
`cms:bootstrap` lẫn `cms:seed` đều idempotent, nên chạy lại sau một lần thất bại
giữa đường là an toàn.

| Cái gì | Ở đâu |
| --- | --- |
| Website | <http://localhost:3000> |
| API | <http://localhost:1989> |
| Studio | `http://localhost:1989/<LUMIBASE_ADMIN_PATH>` |

Studio nằm **bên trong image CMS**, nên một container phục vụ cả API lẫn UI admin
— không có deployment thứ hai và không phải cấu hình thêm entry CORS nào.

Sau đó hãy chứng minh client phía trình duyệt thật sự là least-privilege:

```bash
npm run cms:verify
```

Nó dùng publishable key — không bao giờ dùng admin token — để cho thấy nó đọc được
các post đã publish, **không** thấy được bản draft đã seed (qua list, qua id trực
tiếp, và khi hỏi thẳng `status=draft`), và không ghi được. Phần seed cố ý để lại
một post chưa publish để bước kiểm tra này có thứ thật để bắt. Các kiểm tra không
chạy được sẽ báo SKIPPED chứ không bị gộp vào số lượt pass.

Hai vấn đề upstream của CMS định hình template này, cả hai đều được ghi trong
`README.md` được sinh ra: cổng chặn setup-token đòi một token mà server không bao
giờ in ra ([#470](https://github.com/khuepm/lumibase/issues/470)), nên compose file
để cờ đó tắt và bind mọi port công bố vào `127.0.0.1`; và một header `X-Lumi-Site`
trỏ tới site không tồn tại có thể làm chết tiến trình CMS
([#469](https://github.com/khuepm/lumibase/issues/469)), nên phép thử đó nằm sau
`LUMIBASE_VERIFY_CROSS_TENANT=1`. Việc kiểm tra cô lập tenant với một site thứ hai
*thật* vẫn chạy bình thường, qua `LUMIBASE_VERIFY_OTHER_SITE`.

#### Trỏ nó vào một CMS bạn đã chạy sẵn

Stack Docker chỉ là một trong hai đường. Nếu đã có một instance LumiBase, hãy bỏ
qua `cms:up` và `cms:bootstrap` — website này chỉ đọc, nên ba giá trị trong `.env`
là đủ:

```bash
NEXT_PUBLIC_LUMIBASE_URL=https://cms.example.com
NEXT_PUBLIC_LUMIBASE_SITE_ID=your-site-id
NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY=lbk_pub_…
```

Người quản trị CMS đó phải cấp một publishable key có origin của bạn trong danh
sách cho phép, một read grant **chỉ-published** (`GET /api/v1/items` không tự áp
bộ lọc đó), một collection `posts`, và các field được khai trên nó — một collection
không khai field nào vẫn trả về JSON của item, nên site có thể trông ổn trong khi
Studio hiện "No editable fields". `README.md` được sinh ra nói kỹ từng mục;
`npm run cms:verify` kiểm tra kết quả.

### Docker starter

```bash
cd my-blog
cp .env.example .env       # fill in secrets
pnpm install               # only if you used --no-install
docker compose up -d       # Postgres + Redis
pnpm run db:generate       # generate the first migration from schema.ts
pnpm run db:migrate        # apply it
pnpm dev                   # http://localhost:8787
```

Xác minh dự án đã hoạt động:

```bash
curl http://localhost:8787/                 # {"name":"my-blog","status":"ok"}
curl http://localhost:8787/posts            # {"data":[]}
curl -X POST http://localhost:8787/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"Hello","slug":"hello","body":"First post"}'
```

> **Lưu ý:** các script `dev`, `start`, và `db:migrate` sử dụng `--env-file=.env`
> để `tsx`/`node` nạp các biến môi trường của bạn. `drizzle-kit` (được dùng bởi
> `db:generate`) sẽ tự động nạp `.env`.

Starter lắng nghe ở `8787`, cố ý không phải `1989`: `1989` thuộc về CMS của
LumiBase, còn starter là app của bạn, nên hai bên chạy song song được.

### Cloudflare starter

```bash
cd my-blog
pnpm install
# create a D1 database and paste its id into wrangler.toml
wrangler d1 create lumibase-db
pnpm run db:migrate        # applies local D1 migrations
pnpm dev                   # wrangler dev
```

## Xử lý sự cố (Troubleshooting)

| Triệu chứng | Nguyên nhân / Cách khắc phục |
| --- | --- |
| `Unknown template: …` | `--template` chỉ nhận `nextjs`, `default`, hoặc `cloudflare`. Thông báo lỗi nêu rõ giá trị bạn đã truyền. |
| `Project name must be lowercase` | Tên package npm phải là chữ thường; hãy đổi tên dự án. |
| `DATABASE_URL is required` | Sao chép `.env.example` thành `.env` (với Docker starter). |
| Website hiện "Almost there" | `.env` còn thiếu một trong ba giá trị `NEXT_PUBLIC_LUMIBASE_*`. Chạy `cms:bootstrap`, hoặc điền tay. |
| Studio trả về `404` | Bạn đang ở `/`, `/admin`, hoặc `/studio` — cả ba đều cố ý trả `404` không phân biệt được. Hãy dùng đường dẫn trong `LUMIBASE_ADMIN_PATH`. |
| Port `5432` already allocated | Một Postgres khác đang chiếm port `5432`; hãy dừng nó hoặc đổi port host trong `docker-compose.yml`. |
| Port `1989` already allocated | Một CMS LumiBase đang chạy rồi. Hãy dừng nó, hoặc đổi port host trong `docker-compose.yml` rồi cập nhật `NEXT_PUBLIC_LUMIBASE_URL`. |
| Dependency install failed | Chạy lại `<pm> install` thủ công; CLI vẫn tiếp tục và thông báo cho bạn. |

## Tài liệu liên quan

- [CLI](./cli/index.md) — `lumibase init`, `lumibase types`, `lumibase doctor`
- [JS SDK](./sdk/javascript.md) — client mà template Next.js dùng để đọc dữ liệu
- [Next.js quickstart](./tutorials/nextjs-quickstart.md) — cùng cách nối dây đó, làm bằng tay
- [Tổng quan triển khai](./deployment/overview.md)
- [Phát triển cục bộ](./deployment/local-development.md)
- [Mô hình dữ liệu](./data-model.md)
