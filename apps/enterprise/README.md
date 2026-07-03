# @lumibase/enterprise

Standalone, **private-only** enterprise app for LumiBase.

> ⚠️ The source in this directory does **not** live in the public `lumibase`
> repo. It is a **git submodule** pointing at the private
> `lumibase-enterprise` repo. In a public checkout this folder is an empty
> submodule pointer — that is intentional.

## Boundary rules

- **One-way dependency:** `enterprise → core`. This app may import
  `@lumibase/shared`, `@lumibase/runtime`, `@lumibase/database`, etc.
- Core apps/packages (`cms`, `studio`, `shared`, …) **must never import
  `@lumibase/enterprise`**. The public build never has this submodule checked
  out, so any such import breaks the public build.
- Public CI must check out with `submodules: false` (the default).

## Local dev (with submodule checked out)

```bash
pnpm install
pnpm --filter @lumibase/enterprise dev    # http://localhost:1995
pnpm --filter @lumibase/enterprise test
pnpm --filter @lumibase/enterprise typecheck
```

## Deploy (self-hosted by the team)

```bash
pnpm --filter @lumibase/enterprise deploy   # wrangler deploy --env production
```

See `docs/en/enterprise/private-submodule.md` for the full submodule + CI setup.
