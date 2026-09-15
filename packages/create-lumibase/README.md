# create-lumibase

Scaffold a new project that follows [LumiBase](https://lumibase.dev)
conventions. The default choice gives you a **Next.js website with a real CMS
and Studio behind it**; two leaner templates give you a **Hono + Drizzle**
starter you own and extend.

> **Several things share the "LumiBase" name. Pick the row that matches what you are building.**
>
> | You want… | Use | What you get |
> |-----------|-----|--------------|
> | A website with a CMS behind it | `create-lumibase` → `--template nextjs` (**preselected**) | A Next.js site plus the CMS image (Studio included) + PostgreSQL + Redis in Docker, a `posts` collection, seeded content, and a browser-safe publishable key. |
> | A starter app you own, no CMS | `create-lumibase` → `--template default` or `--template cloudflare` | A minimal Hono + Drizzle project with a demo `posts` resource. **No** Collections API, Studio admin, Email, Flows, or AI harness. |
> | The platform on its own | The CMS image `ghcr.io/khuepm/lumibase-cms`, or a clone of the [monorepo](https://github.com/khuepm/lumibase) | The complete platform with no app scaffold: Collections API, Studio admin, permissions, Flows, AI agents, multi-tenancy. See [Deployment overview](https://docs.lumibase.dev/en/docs/deployment/overview). |
> | To talk to a CMS that already exists | [`lumibase`](https://www.npmjs.com/package/lumibase) or [`@lumibase/sdk`](https://www.npmjs.com/package/@lumibase/sdk) | A typed REST/realtime client plus a CLI for type generation. Install it as a **runtime** dependency (`npm install lumibase`), not with `-D` — your app imports from it at request time. |

```bash
npm create lumibase@latest my-project
# or
npx create-lumibase@latest my-project
# or
pnpm create lumibase my-project
```

## What it does

`create-lumibase` bootstraps a ready-to-run project into an empty directory, the
same way `create-next-app` or `create-vite` scaffold their respective stacks. It
is interactive by default and fully scriptable via flags.

Which stack you get depends on the template:

- **`nextjs`** (preselected) — a Next.js 15 / React 19 site that reads content
  through the `lumibase` client, plus a `docker-compose.yml` that runs the actual
  LumiBase CMS with Studio inside it. Scripts bootstrap the first admin, mint a
  publishable key, seed sample posts, and then *verify* that the browser-facing
  client cannot read drafts or write anything.
- **`default`** / **`cloudflare`** — a small Hono server with a `posts` resource
  wired the way LumiBase wires things: `nanoid()` identifiers, a `site_id` column
  on every domain table, the `{ data }` / `{ errors }` response envelope, and Zod
  request validation. These are starters, not a copy of the platform, and they do
  not run the Studio.

## Interactive flow

Running `npm create lumibase@latest` with no arguments walks you through:

1. **Project name** — validated against npm package-name rules.
2. **Deployment target** — `Next.js website` (+ CMS, Studio and seed content — preselected), `Docker` (Node.js + PostgreSQL), or `Cloudflare Workers` (Edge + D1).
3. **Package manager** — `pnpm` / `npm` / `yarn` / `bun` (the one you invoked is auto-detected).
4. **Install dependencies** — yes/no.
5. **Initialize git** — yes/no.

The tool then scaffolds the files, optionally runs `git init` + a first commit,
installs dependencies, and prints the exact next steps for your chosen stack.

## Templates

| Template | Flag | Stack |
| --- | --- | --- |
| **Next.js website + CMS** (preselected) | `--template nextjs` | Next.js 15 + React 19 + the `lumibase` client, and the CMS image (Studio included) + PostgreSQL + Redis via `docker-compose.yml` |
| **Docker starter** | `--template default` | Hono + `@hono/node-server`, Drizzle ORM, PostgreSQL, Redis, `docker-compose.yml` |
| **Cloudflare Workers starter** | `--template cloudflare` | Hono, Drizzle ORM, D1, `wrangler.toml` |

The template *named* `default` is no longer the default *choice* — the name is
kept so existing `--template default` scripts keep working.

## Non-interactive usage

Skip every prompt by passing flags:

```bash
npx create-lumibase@latest my-blog \
  --template nextjs \
  --pm pnpm \
  --no-install \
  --no-git
```

| Flag | Description |
| --- | --- |
| `--template <nextjs\|default\|cloudflare>` | Choose the project template. An unknown name is rejected up front. |
| `--pm <pnpm\|npm\|yarn\|bun>` | Package manager to install with. |
| `--install` / `--no-install` | Force-enable or skip dependency install. |
| `--git` / `--no-git` | Force-enable or skip `git init`. |
| `DEBUG=1` | Print scaffolded file paths and full stack traces on error. |

`--template` has no implicit value: omitting it in a non-interactive environment
still reaches the prompt, so pass it explicitly in CI.

## After scaffolding (Next.js template)

```bash
cd my-blog
cp .env.example .env       # fill in your secrets
npm install                # if you skipped --install
npm run cms:up             # CMS + Studio + Postgres + Redis
npm run cms:bootstrap      # first admin, public read grant, publishable key
npm run cms:seed           # sample posts
npm run dev                # http://localhost:3000
```

| What | Where |
| --- | --- |
| Website | `http://localhost:3000` |
| API | `http://localhost:1989` |
| Studio | `http://localhost:1989/<LUMIBASE_ADMIN_PATH>` |

No migrate step: the CMS container runs its own migrations on first boot.
`cms:bootstrap` writes the publishable key back into `.env`, and both
`cms:bootstrap` and `cms:seed` are idempotent.

Then check that the browser-facing client is least-privilege:

```bash
npm run cms:verify
```

It uses the publishable key — never the admin token — to prove it can read
published posts, cannot see the seeded draft, and cannot write. The seed leaves
one post unpublished on purpose so the check has something real to catch.

Already run a LumiBase instance? Skip `cms:up`/`cms:bootstrap` and put its URL,
your site id, and a publishable key (`lbk_pub_…`) in `.env`. The generated
`README.md` lists what the CMS administrator has to provide.

## After scaffolding (Docker starter)

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
- For the Next.js and Docker templates: Docker + Docker Compose
- For the Cloudflare template: a Cloudflare account + `wrangler`

## Related packages

| Package | Role |
| --- | --- |
| [`lumibase`](https://www.npmjs.com/package/lumibase) | The runtime client **and** the CLI (`lumibase types`, `lumibase doctor`, `lumibase init`) in one install |
| [`@lumibase/sdk`](https://www.npmjs.com/package/@lumibase/sdk) | Typed REST / realtime client for a running CMS |
| [`@lumibase/contracts`](https://www.npmjs.com/package/@lumibase/contracts) | Shared Zod schemas / policy & field DSLs |
| [`@lumibase/extension-sdk`](https://www.npmjs.com/package/@lumibase/extension-sdk) | Author hooks, endpoints, UI extensions |
| [`@lumibase/mcp-server`](https://www.npmjs.com/package/@lumibase/mcp-server) | Stdio MCP server for AI assistants |

Full guide: [Getting started](https://docs.lumibase.dev/en/docs/getting-started).

## License

Apache-2.0 — part of the [LumiBase](https://github.com/khuepm/lumibase) monorepo.
