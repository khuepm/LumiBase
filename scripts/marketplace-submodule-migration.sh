#!/usr/bin/env bash
#
# Move apps/marketplace out of this monorepo into its own repository and
# re-attach it as a git submodule.
#
#   Target repo: git@github.com:lumibase-ai/marketplace.git
#
# WHY A SCRIPT (not done automatically): the CI/session that generated this
# change is scoped to `khuepm/lumibase` and cannot push to `lumibase-ai/*`.
# Run this from a machine with push access to lumibase-ai/marketplace.
#
# It preserves the full git history of apps/marketplace via `git subtree
# split`, so the standalone repo keeps every commit that touched the app.
#
# Usage:
#   ./scripts/marketplace-submodule-migration.sh            # dry run (prints steps)
#   APPLY=1 ./scripts/marketplace-submodule-migration.sh    # execute
#
set -euo pipefail

REPO_URL="${MARKETPLACE_REPO_URL:-git@github.com:lumibase-ai/marketplace.git}"
SUBTREE_PREFIX="apps/marketplace"
SUBMODULE_PATH="apps/marketplace"
BRANCH="${MARKETPLACE_BRANCH:-main}"
APPLY="${APPLY:-0}"

run() {
  echo "+ $*"
  if [[ "$APPLY" == "1" ]]; then
    "$@"
  fi
}

echo "== Marketplace submodule migration =="
echo "   monorepo dir : $SUBTREE_PREFIX"
echo "   target repo  : $REPO_URL (branch: $BRANCH)"
echo "   mode         : $([[ "$APPLY" == "1" ]] && echo APPLY || echo DRY-RUN)"
echo

if [[ ! -d "$SUBTREE_PREFIX" ]]; then
  echo "error: $SUBTREE_PREFIX not found — run from the repo root." >&2
  exit 1
fi

# 1. Extract history of apps/marketplace onto a detached branch.
echo "-- 1. Split subtree history --"
run git subtree split --prefix="$SUBTREE_PREFIX" -b marketplace-export

# 2. Push the extracted history to the standalone repo.
#    (The target repo must exist and be empty, or accept a fresh branch.)
echo "-- 2. Push extracted history to standalone repo --"
run git push "$REPO_URL" "marketplace-export:$BRANCH"

# 3. Remove the app from the monorepo and commit the removal.
echo "-- 3. Remove app from monorepo --"
run git rm -r "$SUBTREE_PREFIX"
run git commit -m "chore(marketplace): move app to standalone repo (submodule)"

# 4. Re-add it as a submodule at the same path.
echo "-- 4. Add submodule --"
run git submodule add -b "$BRANCH" "$REPO_URL" "$SUBMODULE_PATH"
run git commit -m "chore(marketplace): add marketplace as submodule"

# 5. Clean up the temporary export branch.
echo "-- 5. Cleanup --"
run git branch -D marketplace-export

cat <<'NOTE'

Done (or dry-run complete).

Follow-ups after APPLY:
  * pnpm-workspace.yaml already globs apps/* — the submodule keeps the
    @lumibase/marketplace package in the workspace once checked out.
  * Contributors must run: git submodule update --init --recursive
  * CI must checkout submodules (actions/checkout: submodules: recursive).
  * .gitmodules will now contain BOTH `extensions` and `apps/marketplace`.
NOTE
