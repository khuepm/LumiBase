---
version: 1
lastUpdated: 2026-07-28T10:18:03.865Z
sourceLang: en
contentHash: 5acaa937f36c1fe7
---

# Moving the marketplace app to a submodule

> **Status: applied.** `.gitmodules` already carries the `apps/marketplace`
> submodule entry. This page is kept as the runbook of record — for auditing what
> the move did, or for repeating the same extraction on another app.

The public marketplace site (`apps/marketplace`) was extracted into its own
repository and re-attached to this monorepo as a git submodule:

- **Target repo:** `git@github.com:lumibase-ai/marketplace.git`
- **Mount path:** `apps/marketplace` (unchanged).
- **Workspace membership:** the submodule is deliberately **excluded** from the
  pnpm workspace — `pnpm-workspace.yaml` carries `- "!apps/marketplace"` after
  the `apps/*` glob. It builds independently with its own dependencies, so the
  root `pnpm-lock.yaml` stays free of them and a frozen install here never
  depends on the submodule being checked out. CI installs and builds it
  standalone inside `apps/marketplace`.

## Why this isn't done automatically

The automation that prepared this change is scoped to `khuepm/lumibase` and has
**no push access** to `lumibase-ai/*`. The extraction therefore ships as a
runnable script — run it from a machine (or CI) that can push to
`lumibase-ai/marketplace`.

## Prerequisites

1. `lumibase-ai/marketplace` exists and is empty (or willing to accept a fresh
   `main`).
2. Your git remote has push access to it (SSH key or PAT).
3. Run from a clean working tree at the repo root.

## Run it

```bash
# Dry run — prints every git command without executing:
./scripts/marketplace-submodule-migration.sh

# Execute for real:
APPLY=1 ./scripts/marketplace-submodule-migration.sh

# Execute, overwriting scaffolding (README/license) on the remote's main:
FORCE=1 APPLY=1 ./scripts/marketplace-submodule-migration.sh
```

Overridable env vars: `MARKETPLACE_REPO_URL`, `MARKETPLACE_BRANCH`, `FORCE`.

### If the push is rejected ("fetch first" / non-fast-forward)

The target repo already has commits on `main` — almost always the initial
`README`/license GitHub adds when you create a repo through the UI. The
extracted subtree history is a separate root, so it can't fast-forward.

- **Discard that scaffolding** (safe when `main` is just the auto-init commit):
  re-run with `FORCE=1` — it pushes with `--force` (a `--force-with-lease` can't
  be used on an ad-hoc URL push: with no remote-tracking ref it always rejects
  with "stale info").
- **Keep the remote history**: push to a side branch and reconcile via PR:
  ```bash
  git push git@github.com:lumibase-ai/marketplace.git marketplace-export:import-app
  ```

The script stops before touching the monorepo, so a rejected push leaves
`apps/marketplace` intact — just resolve the push and re-run.

## What it does

1. `git subtree split --prefix=apps/marketplace` — extracts the full history of
   the app onto a temporary `marketplace-export` branch (every commit that
   touched the folder is preserved).
2. Pushes that history to `lumibase-ai/marketplace` as `main`.
3. `git rm -r apps/marketplace` and commits the removal from the monorepo.
4. `git submodule add` at the same path and commits the submodule pointer.
5. Deletes the temporary export branch.

## After the move

- `.gitmodules` lists `extensions`, `apps/marketplace`, and `apps/enterprise`.
- Contributors: `git submodule update --init --recursive` after pulling.
- CI: enable submodule checkout (`actions/checkout` with `submodules: recursive`).
- Bumping the app = committing a new submodule SHA in the monorepo (or a
  `git submodule update --remote`).
