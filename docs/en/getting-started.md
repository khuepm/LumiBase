---
version: 1
lastUpdated: 2026-07-08T20:21:03.641Z
sourceLang: en
contentHash: 9c6c07b7161c8e59
---

# Getting Started — Scaffold a new project with `create-lumibase`

`create-lumibase` is the official project bootstrapper for LumiBase. From an
empty directory you run a single command and get a ready-to-run project,
similar to `create-next-app` or `create-vite`.

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

With no arguments, the CLI runs interactively and asks for everything it needs.

## What happens, step by step

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

### Empty-directory and overwrite handling

- If the target directory does not exist it is created.
- If it exists **and is not empty**, the CLI asks before overwriting.
- The project name is validated against npm package-name rules (lowercase, no
  spaces, may not start with `.`/`_`, ≤ 214 chars).

## Templates

| Template | Flag | Stack | Best for |
| --- | --- | --- | --- |
| **Docker** (default) | `--template default` | Hono + `@hono/node-server`, Drizzle ORM, PostgreSQL, Redis, `docker-compose.yml` | Self-hosting, local dev parity with production |
| **Cloudflare Workers** | `--template cloudflare` | Hono, Drizzle ORM, D1, `wrangler.toml` | Edge deployment |

### Generated files (Docker template)

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

The demo `posts` resource follows the project's
[non-negotiable rules](../../CLAUDE.md): `nanoid()` IDs, a `site_id` column on
every domain table, the `{ data }` / `{ errors }` response envelope, and Zod
request validation.

## Non-interactive (CI / scripted) usage

Pass flags to skip prompts entirely:

```bash
npx create-lumibase@latest my-blog \
  --template default \
  --pm pnpm \
  --no-install \
  --no-git
```

| Flag | Description |
| --- | --- |
| `--template <default\|cloudflare>` | Project template. |
| `--pm <pnpm\|npm\|yarn\|bun>` | Package manager used for install. Auto-detected from `npm_config_user_agent` when omitted. |
| `--install` / `--no-install` | Force-enable or skip dependency install. |
| `--git` / `--no-git` | Force-enable or skip `git init` + first commit. |
| `DEBUG=1` (env) | Print each scaffolded file path and full stack traces on error. |

## First run after scaffolding

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

Verify it works:

```bash
curl http://localhost:8787/                 # {"name":"my-blog","status":"ok"}
curl http://localhost:8787/posts            # {"data":[]}
curl -X POST http://localhost:8787/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"Hello","slug":"hello","body":"First post"}'
```

> **Note:** the `dev`, `start`, and `db:migrate` scripts use `--env-file=.env`
> so `tsx`/`node` load your environment. `drizzle-kit` (used by `db:generate`)
> loads `.env` automatically.

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
| `Project name must be lowercase` | npm package names are lowercase; rename the project. |
| `DATABASE_URL is required` | Copy `.env.example` to `.env` (Docker template). |
| Port `5432` already allocated | Another Postgres is bound to `5432`; stop it or remap the host port in `docker-compose.yml`. |
| Dependency install failed | Re-run `<pm> install` manually; the CLI continues and tells you so. |

## Related

- [Deployment overview](./deployment/overview.md)
- [Local development](./deployment/local-development.md)
- [Data model](./data-model.md)
- [JS SDK](./sdk/javascript.md)
