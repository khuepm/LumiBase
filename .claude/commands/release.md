---
description: Cut a LumiBase release — bump version, update changelog & version-bearing files, verify, commit, tag.
argument-hint: <x.y.z> (target SemVer, e.g. 0.11.0)
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
# Bash includes git + gh (GitHub CLI, for release/run status checks in Step 0)
---

# /release — LumiBase release runbook

You are cutting a new LumiBase release. The target version is: **$ARGUMENTS**

If `$ARGUMENTS` is empty, ask the user for the target `x.y.z` (SemVer, no `v` prefix) before doing anything else. Do not guess.

> ⚠️ Pushing the `v<x.y.z>` tag triggers `.github/workflows/release.yml`, which **deploys the Cloudflare Worker to `production`, publishes npm packages, and pushes a Docker image** — all outward-facing and hard to reverse (npm publish cannot be undone after 72h). Treat the tag push as the point of no return: confirm with the user before pushing the tag.

## Step 0 — Preflight & resume detection (ALWAYS run first)

A release can be **partially done** from an earlier attempt: the version may already be bumped in `package.json`, a tag may already exist locally but not on origin, or a tag may be pushed but its release run never completed. Do NOT blindly bump + tag a new version — first detect the actual state and resume from the correct step, so you don't end up with skipped/duplicate versions.

Gather the state (run against the main repo, not a worktree):
```bash
CURRENT=$(node -p "require('./package.json').version")           # version in package.json
LATEST_TAG=$(git tag | sort -V | tail -1)                        # newest tag locally, e.g. v0.16.0
TARGET="<x.y.z>"                                                  # requested target (may equal CURRENT)

git fetch origin --tags --prune                                  # sync remote tags
git rev-parse -q --verify "refs/tags/v$TARGET"    2>/dev/null    # tag exists locally?  (prints SHA)
git ls-remote --tags origin "v$TARGET"                           # tag exists on origin? (non-empty = pushed)
gh release view "v$TARGET" --json tagName,url 2>/dev/null        # GitHub Release already created?
gh run list --workflow=release.yml --limit 5 2>/dev/null         # did the release workflow run for this tag?
```

Then classify the state and act:

| State | Signal | What to do |
|---|---|---|
| **A. Fresh release** | `TARGET` > `CURRENT`, no `vTARGET` tag anywhere | Normal path: proceed to Preconditions → Step 1. |
| **B. Version bumped, not tagged** | `CURRENT == TARGET` (or `CURRENT` already > `LATEST_TAG`), no `vTARGET` tag | **Skip Step 1's version bump.** Verify Steps 2–3 files already reflect `TARGET` (fix any that don't), run Step 4 verify, ensure the bump is committed & pushed (Step 5), then go to Step 6 to tag. |
| **C. Tagged locally, not pushed** | `vTARGET` tag exists locally, `git ls-remote` empty | Confirm the tag points at the right commit: `git rev-list -n1 vTARGET` should be the `chore(release): vTARGET` commit on `origin/main`. If wrong, `git tag -d vTARGET` and recreate at the correct commit. Then jump straight to **Step 6's push** (`git push origin vTARGET`). Skip bump/changelog/tag-create. |
| **D. Tag pushed, release incomplete** | `git ls-remote` non-empty, but no GitHub Release or the `release.yml` run failed | Do NOT re-tag or delete a pushed tag. Inspect the failed run (`gh run list` / `gh run view <id> --log-failed`). If it's re-runnable, `gh run rerun <id>`; otherwise report the failure and what's needed. Go to Step 7. |
| **E. Fully released** | Release exists and workflow succeeded for `vTARGET` | Nothing to do — report that `vTARGET` is already released and link the Release. Stop. |

If `CURRENT > TARGET` (target is behind package.json) or `TARGET` is not strictly greater than `LATEST_TAG` **and** none of B–E apply, stop and ask the user — the numbering is ambiguous (see also the parallel-branch renumbering caveat).

State the detected state (A–E) to the user before proceeding.

## Preconditions

1. Confirm the working tree is clean and you are on `main`, synced with origin:
   ```bash
   git fetch origin main && git checkout main && git pull origin main
   git status --short   # must be empty
   ```
2. Capture today's date in `YYYY-MM-DD` (used in changelog + releases.json).
3. Read the current root version: `node -p "require('./package.json').version"`. For a **fresh release (State A)** the target must be strictly greater (SemVer). For a **resume (State B/C)** the version may already equal the target — that's expected; do not treat it as an error. Rely on the Step 0 classification, not a blind strictly-greater check.

## Step 1 — Bump and sync version

> Skip this whole step if Step 0 detected **State B/C** (version already at `<x.y.z>`) — just run `pnpm version:check` to confirm everything is synced, then continue.

1. Set the root `package.json` `version` to `<x.y.z>`.
2. Propagate to every app/package manifest:
   ```bash
   pnpm version:sync
   pnpm version:check   # must report all synced to <x.y.z>
   ```

## Step 2 — Update CHANGELOG.md

- Add a new section directly under `## [Unreleased]` (and reset Unreleased to `_No unreleased changes yet._`):
  ```md
  ## [<x.y.z>] - <YYYY-MM-DD>

  ### Version
  - `v<x.y.z>`

  ### Date
  - `<YYYY-MM-DD>`

  ### Highlights
  - ...

  ### Added / Changed / Fixed / Notes
  - ...

  ### Migrations
  - None  (always include this section, even if "None")
  ```
- Populate it from the commits since the previous release. If a section heading already exists for `<x.y.z>` (e.g. drafted earlier in the cycle), refine it instead of duplicating.
- Verify the release workflow can extract the notes (this is the exact awk the workflow runs):
  ```bash
  awk -v version="<x.y.z>" 'BEGIN{f=0} /^## \[/{if(f)exit; if($0 ~ "^## \\[" version "\\]"){f=1;next}} f{print}' CHANGELOG.md
  ```
  The output must be non-empty.

## Step 3 — Update version-bearing files

These are NOT covered by `version:sync` and must be edited by hand. Update each to `<x.y.z>`:

- **README.md** — the `Current release: \`v<x.y.z>\`` line and any `LUMIBASE_VERSION=<x.y.z>` example.
- **apps/landing/src/app/page.tsx** — `softwareVersion: "<x.y.z>"` (schema.org JSON-LD).
- **apps/docs/public/releases.json** — `stable` and `edge`: `version`, `releaseDate` (today), `changelogUrl` (`.../releases/tag/v<x.y.z>`). Bump `minimumSafeUpgradeVersion` / set `migrationWarning: true` only if this release has breaking migrations.

Then sweep for any other stale references and fix or report them:
```bash
git grep -nE "v?[0-9]+\.[0-9]+\.[0-9]+" -- README.md apps/landing apps/docs/public docs | grep -vE "node_modules|pnpm-lock"
```
(Ignore historical/contextual mentions in prose — e.g. "introduced in v0.5.0" — only fix things that assert the *current/latest* version.)

## Step 4 — Verify

Run the same gates the release workflow runs; all must pass before tagging:
```bash
pnpm version:check
pnpm typecheck
pnpm test
pnpm build
pnpm release:check   # validates production deploy env/config
```
If any fail, stop and report — do not tag.

## Step 5 — Commit to main

```bash
git add -A
git commit -m "chore(release): v<x.y.z>"
git push -u origin main
```

## Step 6 — Tag (point of no return)

Confirm with the user, then create and push the annotated tag:
```bash
git tag -a v<x.y.z> -m "LumiBase v<x.y.z>"    # skip if State C — tag already exists locally
git push origin v<x.y.z>
```

> **State C (tag exists locally, not pushed):** do NOT recreate the tag — `git tag -a` fails if it exists, and recreating risks pointing at the wrong commit. Verify `git rev-list -n1 v<x.y.z>` matches the `chore(release): v<x.y.z>` commit on `origin/main`, then run only the `git push origin v<x.y.z>` line.

> If the push returns **HTTP 403** (not a network error), the current environment forbids pushing tags. Do not retry. Tell the user to push the tag from their local clone with the commands above — the tag is what fires the release pipeline.

## Step 7 — After the tag is on GitHub

`.github/workflows/release.yml` runs: verify → create GitHub Release (notes from the `## [<x.y.z>]` changelog section) → deploy Cloudflare Worker `production` → publish npm packages (gated by the `PUBLISH_NPM_PACKAGES` repo variable + `NPM_TOKEN`) → build & push the Docker image.

Report to the user: the commit SHA, that the tag is pushed (or that they need to push it), and a link to the Actions run / Release once available. Do not open a PR unless asked.
