# Private enterprise app via git submodule

This guide sets up `apps/enterprise/` as a **private-only** app: its source
lives in a separate private repo and is mounted into the public monorepo as a
git submodule. The public repo only ever stores a commit pointer — never the
source.

> Why submodule (not a private npm registry)? The `@lumibase/*` packages are
> `private: true` and consumed via `workspace:*`. A submodule keeps that intact:
> when checked out, the enterprise app is just another `apps/*` workspace.

## Threat model / boundary rules

- **One-way dependency:** `enterprise → core` only. Core code (`cms`, `studio`,
  `packages/*`) must never `import '@lumibase/enterprise'`, or the **public
  build breaks** (the submodule is absent in public checkouts).
- `.gitmodules` is committed to the **public** repo and exposes the private
  repo **URL**. That is acceptable — a URL is not a credential; cloning still
  requires repo access.
- **Public CI must not fetch the submodule.** `actions/checkout` defaults to
  `submodules: false` — keep it that way for any public workflow. Only the
  private/self-hosted build job fetches it (with a token).

---

## 1. Create the private repo

Create an **empty private** repo, e.g. `your-org/lumibase-enterprise`. Move the
scaffolded `apps/enterprise/` contents into it as the repo root:

```bash
# from a fresh clone of the (empty) private repo
git clone git@github.com:your-org/lumibase-enterprise.git
cd lumibase-enterprise
# copy the scaffold that was generated in the monorepo:
cp -R /path/to/lumibase/apps/enterprise/. .
git add -A && git commit -m "feat: initial enterprise app"
git push origin main
```

## 2. Add it back into the monorepo as a submodule

In the **public** monorepo, replace the local scaffold with the submodule:

```bash
# remove the local copy first (it now lives in the private repo)
git rm -r --cached apps/enterprise
rm -rf apps/enterprise

# mount the private repo at the same path
git submodule add git@github.com:your-org/lumibase-enterprise.git apps/enterprise
git commit -m "chore: mount enterprise app as private submodule"
```

This creates `.gitmodules`:

```ini
[submodule "apps/enterprise"]
	path = apps/enterprise
	url = git@github.com:your-org/lumibase-enterprise.git
```

## 3. Cloning behaviour

```bash
# Contributors WITHOUT access (public-only):
git clone git@github.com:your-org/lumibase.git
#   → apps/enterprise/ is an empty pointer. pnpm install ignores it
#     because there is no package.json inside. Public build works.

# Team WITH access (full build):
git clone --recurse-submodules git@github.com:your-org/lumibase.git
# or, after a plain clone:
git submodule update --init --recursive
#   → apps/enterprise/ is populated; pnpm picks it up as a workspace.
```

`pnpm-workspace.yaml` already globs `apps/*` and `turbo.json` uses task globs,
so **no config changes are needed** in either case.

## 4. Public CI — must NOT fetch the submodule

In every public workflow that runs `actions/checkout`, leave submodules off
(the default). Be explicit to prevent accidents:

```yaml
- uses: actions/checkout@v4
  with:
    submodules: false   # never fetch private submodules in public CI
```

Public `pnpm install` / `turbo run build` then simply skip the empty
`apps/enterprise/` directory.

## 5. Private / self-hosted build job (fetches the submodule)

This job runs in the **private** repo (or a protected workflow with a secret).
Use a deploy token / fine-grained PAT with read access to
`lumibase-enterprise`:

```yaml
# .github/workflows/enterprise-deploy.yml (private)
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          token: ${{ secrets.ENTERPRISE_SUBMODULE_TOKEN }}
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: pnpm install --ignore-scripts
      - run: pnpm --filter @lumibase/enterprise typecheck
      - run: pnpm --filter @lumibase/enterprise test
      - run: pnpm --filter @lumibase/enterprise build
      - run: pnpm --filter @lumibase/enterprise deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## 6. Day-to-day: updating the pointer

```bash
# pull latest enterprise code into the submodule
git submodule update --remote apps/enterprise
git add apps/enterprise
git commit -m "chore: bump enterprise submodule"
```

## 7. Enforce the one-way boundary (recommended)

Add a public CI guard so nobody accidentally imports the enterprise app from
core code:

```bash
# fails if any core source imports @lumibase/enterprise
! grep -rES "from ['\"]@lumibase/enterprise" \
    apps/cms apps/studio packages \
  || { echo "core must not import @lumibase/enterprise"; exit 1; }
```

---

## Recap

| Concern | Public repo | Private repo / team |
| --- | --- | --- |
| Source visible? | No (empty pointer) | Yes |
| `pnpm install` | Skips empty dir | Treats as workspace |
| CI checkout | `submodules: false` | `submodules: recursive` + token |
| Deploy | n/a | `wrangler deploy --env production` |
