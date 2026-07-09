---
version: 1
lastUpdated: 2026-07-08T20:21:03.641Z
sourceLang: en
translatedFrom: en
sourceHash: 9c6c07b7161c8e59
mtEngine: claude
syncStatus: machine-translated
---

# Getting Started — Khởi tạo dự án mới bằng `create-lumibase`

`create-lumibase` là công cụ bootstrap dự án chính thức của LumiBase. Từ một
thư mục trống bạn chạy một lệnh duy nhất và có ngay một dự án chạy được, tương
tự `create-next-app` hay `create-vite`.

> **Package:** [`create-lumibase`](../../packages/create-lumibase) ·
> **Published as:** `create-lumibase` on npm ·
> **Node:** `>= 20`

## Quick start

```bash
# any of these work — npx resolves the create-* convention
npm create lumibase@latest my-project
npx create-lumibase@latest my-project
pnpm create lumibase my-project
```

Khi không có tham số nào, CLI chạy ở chế độ tương tác và hỏi mọi thứ nó cần.

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
- Tên dự án được kiểm tra theo quy tắc đặt tên package của npm (chữ thường,
  không khoảng trắng, không được bắt đầu bằng `.`/`_`, ≤ 214 ký tự).

## Templates

| Template | Flag | Stack | Best for |
| --- | --- | --- | --- |
| **Docker** (default) | `--template default` | Hono + `@hono/node-server`, Drizzle ORM, PostgreSQL, Redis, `docker-compose.yml` | Self-hosting, local dev parity with production |
| **Cloudflare Workers** | `--template cloudflare` | Hono, Drizzle ORM, D1, `wrangler.toml` | Edge deployment |

### File được sinh ra (Docker template)

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

Resource `posts` demo tuân theo
[các quy tắc bất di bất dịch](../../CLAUDE.md) của dự án: ID bằng `nanoid()`,
một cột `site_id` trên mọi domain table, envelope response `{ data }` /
`{ errors }`, và validation request bằng Zod.

## Sử dụng non-interactive (CI / scripted)

Truyền flag để bỏ qua hoàn toàn các prompt:

```bash
npx create-lumibase@latest my-blog \
  --template default \
  --pm pnpm \
  --no-install \
  --no-git
```

| Flag | Description |
| --- | --- |
| `--template <default\|cloudflare>` | Template dự án. |
| `--pm <pnpm\|npm\|yarn\|bun>` | Package manager dùng để cài đặt. Tự dò từ `npm_config_user_agent` khi bỏ trống. |
| `--install` / `--no-install` | Bắt buộc bật hoặc bỏ qua bước cài dependency. |
| `--git` / `--no-git` | Bắt buộc bật hoặc bỏ qua `git init` + commit đầu tiên. |
| `DEBUG=1` (env) | In đường dẫn từng file được scaffold và full stack trace khi lỗi. |

## Lần chạy đầu tiên sau khi scaffold

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

Kiểm tra xem nó chạy chưa:

```bash
curl http://localhost:8787/                 # {"name":"my-blog","status":"ok"}
curl http://localhost:8787/posts            # {"data":[]}
curl -X POST http://localhost:8787/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"Hello","slug":"hello","body":"First post"}'
```

> **Note:** các script `dev`, `start`, và `db:migrate` dùng `--env-file=.env`
> nên `tsx`/`node` sẽ nạp environment của bạn. `drizzle-kit` (dùng bởi
> `db:generate`) tự nạp `.env`.

### Cloudflare template

```bash
cd my-blog
pnpm install
# create a D1 database and paste its id into wrangler.toml
wrangler d1 create lumibase-db
pnpm run db:migrate        # applies local D1 migrations
pnpm dev                   # wrangler dev
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Project name must be lowercase` | Tên package npm là chữ thường; đổi tên dự án. |
| `DATABASE_URL is required` | Copy `.env.example` thành `.env` (Docker template). |
| Port `5432` already allocated | Một Postgres khác đang bind vào `5432`; dừng nó hoặc remap host port trong `docker-compose.yml`. |
| Dependency install failed | Chạy lại `<pm> install` thủ công; CLI vẫn tiếp tục và báo cho bạn biết. |

## Liên quan

- [Deployment overview](./deployment/overview.md)
- [Local development](./deployment/local-development.md)
- [Data model](./data-model.md)
- [JS SDK](./sdk/javascript.md)
