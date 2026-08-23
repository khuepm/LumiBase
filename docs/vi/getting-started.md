---
version: 1
lastUpdated: 2026-08-02T19:04:40.044Z
sourceLang: en
translatedFrom: en
sourceHash: 415d80a8367fca52
mtEngine: manual
syncStatus: human-translated
---

# Getting Started — Khởi tạo dự án mới bằng `create-lumibase`

`create-lumibase` là công cụ bootstrap dự án chính thức của LumiBase. Từ một thư mục trống bạn chạy một lệnh duy nhất và có ngay một dự án sẵn sàng chạy, tương tự `create-next-app` hay `create-vite`.

> **Hai khái niệm khác nhau cùng mang tên "LumiBase" — chọn đúng nhu cầu của bạn:**
>
> | Bạn muốn… | Dùng | Những gì bạn nhận được |
> |-----------|-----|--------------|
> | Một ứng dụng khởi đầu để xây dựng tiếp | `create-lumibase` (trang này) | Một dự án **Hono + Drizzle** tối giản với tài nguyên mẫu `posts`. Không bao gồm Collections API, Studio, Email, hay các phần còn lại của nền tảng. |
> | Nền tảng Content OS đầy đủ | Image CMS `ghcr.io/khuepm/lumibase-cms` hoặc bản clone của [monorepo](https://github.com/khuepm/lumibase) | Nền tảng hoàn chỉnh: Collections API, Studio admin, Email, Flows, AI, multi-tenancy, v.v. Xem [Phát triển cục bộ](./deployment/local-development.md) và [Tổng quan triển khai](./deployment/overview.md). |
>
> Bộ khung bên dưới là **starter**, không phải nền tảng.

> **Package:** [`create-lumibase`](../../packages/create-lumibase) ·
> **Published as:** `create-lumibase` trên npm ·
> **Node:** `>= 20`

## Quick start

```bash
# any of these work — npx resolves the create-* convention
npm create lumibase@latest my-project
npx create-lumibase@latest my-project
pnpm create lumibase my-project
```

Khi không có tham số nào, CLI sẽ chạy ở chế độ tương tác và hỏi mọi thông tin cần thiết.

## Điều gì diễn ra, theo từng bước

```
npx create-lumibase@latest my-blog
│
├─ 1. npx downloads the create-lumibase package from npm
│
├─ 2. Interactive prompts (skipped when flags are passed)
│     ? Project name          my-blog
│     ? Deployment target      › Docker / Cloudflare Workers
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
- Tên dự án được kiểm tra theo quy tắc đặt tên package của npm (chữ thường, không khoảng trắng, không được bắt đầu bằng `.`/`_`, ≤ 214 ký tự).

## Templates

| Template | Flag | Stack | Phù hợp nhất cho |
| --- | --- | --- | --- |
| **Docker** (mặc định) | `--template default` | Hono + `@hono/node-server`, Drizzle ORM, PostgreSQL, Redis, `docker-compose.yml` | Self-hosting, đồng bộ giữa phát triển cục bộ và production |
| **Cloudflare Workers** | `--template cloudflare` | Hono, Drizzle ORM, D1, `wrangler.toml` | Triển khai ở Edge |

### Các file được sinh ra (Docker template)

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

Tài nguyên mẫu `posts` tuân theo [các quy tắc không thể thương lượng](../../CLAUDE.md) của dự án: ID dùng `nanoid()`, một cột `site_id` trên mọi bảng domain, bao bọc response trong `{ data }` / `{ errors }`, và xác thực request bằng Zod.

## Sử dụng không tương tác (CI / scripted)

Truyền các cờ (flag) để bỏ qua hoàn toàn các câu hỏi tương tác:

```bash
npx create-lumibase@latest my-blog \
  --template default \
  --pm pnpm \
  --no-install \
  --no-git
```

| Cờ (Flag) | Mô tả |
| --- | --- |
| `--template <default\|cloudflare>` | Template dự án. |
| `--pm <pnpm\|npm\|yarn\|bun>` | Package manager dùng để cài đặt. Tự động phát hiện từ `npm_config_user_agent` khi bỏ trống. |
| `--install` / `--no-install` | Bắt buộc bật hoặc bỏ qua bước cài đặt dependency. |
| `--git` / `--no-git` | Bắt buộc bật hoặc bỏ qua `git init` + commit đầu tiên. |
| `DEBUG=1` (env) | In đường dẫn từng file được sinh ra và xuất đầy đủ stack trace khi xảy ra lỗi. |

## Lần chạy đầu tiên sau khi khởi tạo

### Docker template

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

> **Lưu ý:** các script `dev`, `start`, và `db:migrate` sử dụng `--env-file=.env` để `tsx`/`node` nạp các biến môi trường của bạn. `drizzle-kit` (được dùng bởi `db:generate`) sẽ tự động nạp `.env`.

### Cloudflare template

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
| `Project name must be lowercase` | Tên package npm phải là chữ thường; hãy đổi tên dự án. |
| `DATABASE_URL is required` | Sao chép `.env.example` thành `.env` (với Docker template). |
| Port `5432` already allocated | Một Postgres khác đang chiếm port `5432`; hãy dừng nó hoặc đổi port host trong `docker-compose.yml`. |
| Dependency install failed | Chạy lại `<pm> install` thủ công; CLI vẫn tiếp tục và thông báo cho bạn. |

## Tài liệu liên quan

- [Tổng quan triển khai](./deployment/overview.md)
- [Phát triển cục bộ](./deployment/local-development.md)
- [Mô hình dữ liệu](./data-model.md)
- [JS SDK](./sdk/javascript.md)
