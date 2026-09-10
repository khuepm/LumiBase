# create-lumibase

Scaffold a starter project that follows [LumiBase](https://lumibase.dev)
conventions — a minimal **Hono + Drizzle** app you own and extend.

> **Two different things share the "LumiBase" name. This package is the starter, not the platform.**
>
> | You want… | Use | What you get |
> |-----------|-----|--------------|
> | A starter app to build on | `create-lumibase` (this package) | A minimal Hono + Drizzle project with a demo `posts` resource. **No** Collections API, Studio admin, Email, Flows, or AI harness. |
> | The full Content OS platform | The CMS image `ghcr.io/khuepm/lumibase-cms`, or a clone of the [monorepo](https://github.com/khuepm/lumibase) | The complete platform: Collections API, Studio admin, permissions, Flows, AI agents, multi-tenancy. See [Deployment overview](https://docs.lumibase.dev/en/docs/deployment/overview). |
> | To talk to a running CMS from your app | [`lumibase`](https://www.npmjs.com/package/lumibase) or [`@lumibase/sdk`](https://www.npmjs.com/package/@lumibase/sdk) | A typed REST/realtime client plus a CLI for type generation. |

```bash
npm create lumibase@latest my-project
# or
npx create-lumibase@latest my-project
# or
pnpm create lumibase my-project
```

## What it does

`create-lumibase` bootstraps a ready-to-run **starter** into an empty directory,
the same way `create-next-app` or `create-vite` scaffold their respective
stacks. It is interactive by default and fully scriptable via flags.

What it gives you is a small Hono server with a `posts` resource wired the way
LumiBase wires things — `nanoid()` identifiers, a `site_id` column on every
domain table, the `{ data }` / `{ errors }` response envelope, and Zod request
validation — so the habits you build here carry over to the platform. It is not
a copy of the platform, and it does not run the Studio.

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

Verify it:

```bash
curl http://localhost:8787/          # {"name":"my-blog","status":"ok"}
curl http://localhost:8787/posts     # {"data":[]}
```

The starter listens on `8787` (change it with `PORT` in `.env`). That is
deliberately **not** `1989` — `1989` is the LumiBase CMS's own port, and the
starter is your app, not the CMS, so the two can run side by side.

## Requirements

- Node.js `>= 22` (required by the CLI's `execa` 10 dependency)
- For the Docker template: Docker + Docker Compose
- For the Cloudflare template: a Cloudflare account + `wrangler`

## Related packages

| Package | Role |
| --- | --- |
| [`@lumibase/sdk`](https://www.npmjs.com/package/@lumibase/sdk) | Typed REST / realtime client for a running CMS |
| [`@lumibase/contracts`](https://www.npmjs.com/package/@lumibase/contracts) | Shared Zod schemas / policy & field DSLs |
| [`@lumibase/extension-sdk`](https://www.npmjs.com/package/@lumibase/extension-sdk) | Author hooks, endpoints, UI extensions |
| [`@lumibase/mcp-server`](https://www.npmjs.com/package/@lumibase/mcp-server) | Stdio MCP server for AI assistants |

## License

Apache-2.0 — part of the [LumiBase](https://github.com/khuepm/lumibase) monorepo.
