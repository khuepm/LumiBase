---
version: 8
lastUpdated: 2026-09-28T23:50:21.665Z
sourceLang: en
contentHash: 99917b80bbbe6308
codeVerified: 2026-09-28T23:50:21.665Z
codeVerifiedHash: 99917b80bbbe6308
codeVerifiedClaims: 8
---

# Getting Started — Scaffold a new project with `create-lumibase`

`create-lumibase` is the official project bootstrapper for LumiBase. From an
empty directory you run a single command and get a ready-to-run project,
similar to `create-next-app` or `create-vite`.

## Which one do you actually want?

Three different things get called "installing LumiBase". They are not
interchangeable, so pick the row that matches what you are building.

| You want… | Use | What you get |
|-----------|-----|--------------|
| **A website with a CMS behind it** | `create-lumibase` → the `nextjs` template (this page, preselected) | A Next.js site **plus** the real CMS and Studio in Docker, a `posts` collection, seeded content, and a browser-safe publishable key. |
| **A starter app you own, no CMS** | `create-lumibase` → the `default` or `cloudflare` template | A minimal **Hono + Drizzle** project with a demo `posts` resource. No Collections API, no Studio — LumiBase conventions, not the platform. |
| **The platform on its own** | The CMS image `ghcr.io/khuepm/lumibase-cms` or a clone of the [monorepo](https://github.com/khuepm/lumibase) | The complete platform with no app scaffold: Collections API, Studio admin, Email, Flows, AI, multi-tenancy. See [Local development](./deployment/local-development.md) and [Deployment overview](./deployment/overview.md). |
| **To read from a CMS that already exists** | `npm install lumibase` — no scaffold at all | The typed REST/realtime client and the `lumibase` CLI in one package. See [CLI](./cli/index.md) and [JS SDK](./sdk/javascript.md). |

That last row is the one people get wrong most often, so it is worth being
explicit: **`lumibase` is a runtime dependency, not a dev tool.** Your app
imports from it at request time, so it belongs in `dependencies`:

```bash
npm install lumibase        # ✅ runtime client + CLI
npm install -D lumibase     # ❌ the import disappears in production installs
```

The same package carries the CLI, so there is nothing extra to add for
`lumibase types` or `lumibase doctor`.

> **Package:** [`create-lumibase`](../../packages/create-lumibase) ·
> **Published as:** `create-lumibase` on npm ·
> **Node:** `>= 22`

## Quick start

```bash
# any of these work — npx resolves the create-* convention
npm create lumibase@next my-project
npx create-lumibase@next my-project
pnpm create lumibase@next my-project
```

> **Use `@next` during the 1.0 release candidates.** npm's `latest` tag still
> points at the 0.x scaffolder, which has no Next.js template and pins no CMS.
> `@next` is the current release candidate. The commands move back to `@latest`
> when 1.0.0 ships.

With no arguments, the CLI runs interactively and asks for everything it needs.
The first prompt is the one that matters most — it chooses your template, and
the Next.js option is preselected.

If a project already has the `lumibase` CLI, `lumibase init` is the same
scaffold, not a second one: it runs `create-lumibase` and forwards your
arguments verbatim, so the two entry points cannot offer different templates or
drift apart. Use whichever is at hand — `npm create lumibase@next` needs
nothing installed. See [`lumibase init`](./cli/index.md#lumibase-init) for how
the delegation works and why the scaffolder is not a dependency of `lumibase`.

## What happens, step by step

```
npx create-lumibase@next my-blog
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

### Empty-directory and overwrite handling

- If the target directory does not exist it is created.
- If it exists **and is not empty**, the CLI asks before overwriting.
- The project name is validated against npm package-name rules (lowercase, no
  spaces, may not start with `.`/`_`, ≤ 214 chars).

## Templates

| Template | Flag | Stack | Best for |
| --- | --- | --- | --- |
| **Next.js website + CMS** (preselected) | `--template nextjs` | Next.js 15 + React 19, the `lumibase` client, and the CMS image (Studio included) + PostgreSQL + Redis via `docker-compose.yml` | Publishing a real site: editors get Studio, the browser gets a read-only key |
| **Docker starter** | `--template default` | Hono + `@hono/node-server`, Drizzle ORM, PostgreSQL, Redis, `docker-compose.yml` | Building your own API with LumiBase conventions |
| **Cloudflare Workers starter** | `--template cloudflare` | Hono, Drizzle ORM, D1, `wrangler.toml` | The same starter, deployed at the edge |

> **A naming trap worth knowing:** the template *named* `default` is no longer
> the default *choice*. `--template default` still selects the Docker starter,
> but the preselected option in the prompt is `nextjs`. The name is kept for
> compatibility with existing scripts.

### Generated files (Next.js template)

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

The split in `.env.example` is the point of this template. `NEXT_PUBLIC_*`
values are inlined into the client bundle, so the only credential there is a
**publishable key** (`lbk_pub_…`) — read-only, origin-locked, and restricted to
published rows by the grant behind it. The admin token lives in
`LUMIBASE_ADMIN_TOKEN`, which has no `NEXT_PUBLIC_` prefix, so Next.js cannot
leak it to the browser.

### Generated files (Docker starter)

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
npx create-lumibase@next my-blog \
  --template nextjs \
  --pm pnpm \
  --no-install \
  --no-git
```

| Flag | Description |
| --- | --- |
| `--template <nextjs\|default\|cloudflare>` | Project template. An unknown name is rejected up front, naming the value you passed. |
| `--pm <pnpm\|npm\|yarn\|bun>` | Package manager used for install. Auto-detected from `npm_config_user_agent` when omitted. |
| `--install` / `--no-install` | Force-enable or skip dependency install. |
| `--git` / `--no-git` | Force-enable or skip `git init` + first commit. |
| `DEBUG=1` (env) | Print each scaffolded file path and full stack traces on error. |

Omitting `--template` in a non-interactive environment still reaches the prompt,
so pass it explicitly in CI.

## First run after scaffolding

The scaffolder prints these steps for the package manager you chose. The
commands below use `npm run`; `pnpm cms:up`, `yarn cms:up` and `bun run cms:up`
are equivalent.

### Next.js template

```bash
cd my-blog
cp .env.example .env       # fill in secrets
npm install                # only if you used --no-install
npm run cms:up             # CMS + Studio + Postgres + Redis
npm run cms:bootstrap      # first admin, public read grant, publishable key
npm run cms:seed           # sample posts
npm run dev                # http://localhost:3000
```

There is no migrate step: the CMS container runs its own migrations on first
boot. `cms:bootstrap` writes the publishable key back into `.env` for you, and
both `cms:bootstrap` and `cms:seed` are idempotent, so re-running after a
partial failure is safe.

| What | Where |
| --- | --- |
| Website | <http://localhost:3000> |
| API | <http://localhost:1989> |
| Studio | `http://localhost:1989/<LUMIBASE_ADMIN_PATH>` |

Studio ships **inside the CMS image**, so one container serves both the API and
the admin UI — there is no second deployment and no CORS entry to configure.

Then prove the browser-facing client is actually least-privilege:

```bash
npm run cms:verify
```

It uses the publishable key — never the admin token — to show that it can read
published posts, **cannot** see the seeded draft (by list, by direct id, and by
asking for `status=draft`), cannot write, and is refused for a site id that does
not exist — after which it re-checks that the CMS is still healthy. The seed
deliberately leaves one post unpublished so the check has something real to
catch. Checks that cannot run are reported as SKIPPED rather than folded into
the pass count. Tenant isolation against a *real* second site runs when
`LUMIBASE_VERIFY_OTHER_SITE` is set.

The generated project pins the `lumibase` client and the CMS image to
**exactly** the `create-lumibase` version that created it, so the API, Studio
and the client always come from one release. The pin is exact rather than a `^`
range: npm resolves a range to the newest version tagged `latest` that satisfies
it, which during a prerelease line can be an older release candidate. The
compose file leaves the setup-token gate off and binds every published port to
`127.0.0.1`; the generated `README.md` shows how to turn the gate on (the CMS
prints `SETUP_TOKEN=…` once at startup).

#### Pointing it at a CMS you already run

The Docker stack is one of two paths. If a LumiBase instance already exists,
skip `cms:up` and `cms:bootstrap` — this website only reads, so three values in
`.env` are enough:

```bash
NEXT_PUBLIC_LUMIBASE_URL=https://cms.example.com
NEXT_PUBLIC_LUMIBASE_SITE_ID=your-site-id
NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY=lbk_pub_…
```

Whoever administers that CMS has to supply a publishable key with your origin
in its allowlist, a **published-only** read grant (`GET /api/v1/items` applies
no such filter of its own), a `posts` collection, and declared fields on it —
a collection with no declared fields still returns item JSON, so the site can
look fine while Studio shows "No editable fields". The generated `README.md`
covers each of these; `npm run cms:verify` checks the result.

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

The starter listens on `8787`, deliberately not `1989`: `1989` belongs to the
LumiBase CMS, and the starter is your app, so the two can run side by side.

### Cloudflare starter

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
| `Unknown template: …` | `--template` accepts `nextjs`, `default`, or `cloudflare`. The error names the value you passed. |
| `Project name must be lowercase` | npm package names are lowercase; rename the project. |
| `DATABASE_URL is required` | Copy `.env.example` to `.env` (Docker starter). |
| Website says "Almost there" | `.env` is missing one of the three `NEXT_PUBLIC_LUMIBASE_*` values. Run `cms:bootstrap`, or fill them in by hand. |
| Studio returns `404` | You are on `/`, `/admin`, or `/studio` — all three return an indistinguishable `404` on purpose. Use the path in `LUMIBASE_ADMIN_PATH`. |
| Port `5432` already allocated | Another Postgres is bound to `5432`; stop it or remap the host port in `docker-compose.yml`. |
| Port `1989` already allocated | A LumiBase CMS is already running. Stop it, or remap the host port in `docker-compose.yml` and update `NEXT_PUBLIC_LUMIBASE_URL`. |
| Dependency install failed | Re-run `<pm> install` manually; the CLI continues and tells you so. |

## Related

- [CLI](./cli/index.md) — `lumibase init`, `lumibase types`, `lumibase doctor`
- [JS SDK](./sdk/javascript.md) — the client the Next.js template reads with
- [Next.js quickstart](./tutorials/nextjs-quickstart.md) — the same wiring, built by hand
- [Deployment overview](./deployment/overview.md)
- [Local development](./deployment/local-development.md)
- [Data model](./data-model.md)
