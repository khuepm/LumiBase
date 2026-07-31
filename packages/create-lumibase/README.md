# create-lumibase

Scaffold a new [LumiBase](https://lumibase.dev) project — an Edge-native Headless CMS — in seconds.

```bash
npm create lumibase@latest my-project
# or
npx create-lumibase@latest my-project
# or
pnpm create lumibase my-project
```

## What it does

`create-lumibase` bootstraps a ready-to-run LumiBase project into an empty
directory, the same way `create-next-app` or `create-vite` scaffold their
respective stacks. It is interactive by default and fully scriptable via flags.

## Interactive flow

Running `npm create lumibase@latest` with no arguments walks you through:

1. **Project name** — validated against npm package-name rules.
2. **Deployment target** — `Docker` (Node.js + PostgreSQL) or `Cloudflare Workers` (Edge + D1).
3. **Package manager** — `pnpm` / `npm` / `yarn` / `bun` (the one you invoked is auto-detected).
4. **Install dependencies** — yes/no.
5. **Initialize git** — yes/no.

The tool then scaffolds the files, optionally runs `git init` + a first commit,
installs dependencies, and prints the exact next steps for your chosen stack.

## Templates

| Template | Flag | Stack |
| --- | --- | --- |
| **Docker** (default) | `--template default` | Hono + `@hono/node-server`, Drizzle ORM, PostgreSQL, Redis, `docker-compose.yml` |
| **Cloudflare Workers** | `--template cloudflare` | Hono, Drizzle ORM, D1, `wrangler.toml` |

The `default` template ships a working `posts` resource (`GET`/`POST /posts`)
that demonstrates LumiBase conventions: `nanoid()` IDs, `site_id`
multi-tenancy, the `{ data }` / `{ errors }` response format, and Zod
validation.

## Non-interactive usage

Skip every prompt by passing flags:

```bash
npx create-lumibase@latest my-blog \
  --template default \
  --pm pnpm \
  --no-install \
  --no-git
```

| Flag | Description |
| --- | --- |
| `--template <default\|cloudflare>` | Choose the project template. |
| `--pm <pnpm\|npm\|yarn\|bun>` | Package manager to install with. |
| `--install` / `--no-install` | Force-enable or skip dependency install. |
| `--git` / `--no-git` | Force-enable or skip `git init`. |
| `DEBUG=1` | Print scaffolded file paths and full stack traces on error. |

## After scaffolding (Docker template)

```bash
cd my-blog
cp .env.example .env       # fill in your secrets
pnpm install               # if you skipped --install
docker compose up -d       # starts Postgres + Redis
pnpm run db:generate       # generate the first migration
pnpm run db:migrate        # apply it
pnpm dev                   # http://localhost:8787
```

## Requirements

- Node.js `>= 22` (required by the CLI's `execa` 10 dependency)
- For the Docker template: Docker + Docker Compose
- For the Cloudflare template: a Cloudflare account + `wrangler`

## License

Part of the LumiBase monorepo.
