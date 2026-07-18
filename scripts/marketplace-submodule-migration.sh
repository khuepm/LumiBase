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
#   ./scripts/marketplace-submodule-migration.sh                 # dry run (prints steps)
#   APPLY=1 ./scripts/marketplace-submodule-migration.sh         # execute
#   FORCE=1 APPLY=1 ./scripts/marketplace-submodule-migration.sh # execute, overwriting
#                                                                # scaffolding on remote main
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
#    Recreate the export branch each run so re-invoking after a failed push
#    doesn't trip over an existing branch.
echo "-- 1. Split subtree history --"
run git branch -D marketplace-export 2>/dev/null || true
run git subtree split --prefix="$SUBTREE_PREFIX" -b marketplace-export

# 2. Push the extracted history to the standalone repo.
#    A brand-new repo created via the GitHub UI usually has an initial commit
#    (README/license) on `main`, so the fresh subtree history is NOT a
#    fast-forward and the push is rejected. Set FORCE=1 to replace that
#    scaffolding with the app history (safe when main is throwaway scaffold).
echo "-- 2. Push extracted history to standalone repo --"
# NOTE: plain --force, not --force-with-lease. A lease needs a remote-tracking
# ref, which an ad-hoc URL push doesn't have, so --force-with-lease always
# rejects with "stale info". main here is throwaway scaffold, so --force is safe.
PUSH_ARGS=()
[[ "${FORCE:-0}" == "1" ]] && PUSH_ARGS+=(--force)
if [[ "$APPLY" == "1" ]]; then
  echo "+ git push ${PUSH_ARGS[*]} $REPO_URL marketplace-export:$BRANCH"
  if ! git push "${PUSH_ARGS[@]}" "$REPO_URL" "marketplace-export:$BRANCH"; then
    cat >&2 <<HINT

Push rejected — the remote '$BRANCH' already has commits (likely repo
scaffolding: an initial README/license). Options:
  * Replace it with the app history:   FORCE=1 APPLY=1 $0
  * Keep it and reconcile via a PR:     git push $REPO_URL marketplace-export:import-app
The monorepo has NOT been modified; re-run once the push succeeds.
HINT
    exit 1
  fi
else
  echo "+ git push ${PUSH_ARGS[*]} $REPO_URL marketplace-export:$BRANCH"
fi

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
