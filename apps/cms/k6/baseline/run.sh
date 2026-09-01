#!/usr/bin/env bash
set -euo pipefail

# Reproducible Phase 0 runner. Start CMS separately with the values below,
# including LUMIBASE_RATE_LIMIT_DISABLED=true for capacity measurements.
# The script intentionally does not alter or stop Docker containers.
#
# Required: DATABASE_URL, TOKEN
# Optional: BASE_URL, SITE_ID, COLLECTION, OUTPUT_DIR, K6_IMAGE, SKIP_SEED
#
# Example CMS environment:
#   LUMIBASE_RUNTIME=docker LUMIBASE_ENV=development \
#   LUMIBASE_RATE_LIMIT_DISABLED=true DATABASE_URL=... JWT_SECRET=... \
#   pnpm --filter @lumibase/cms exec tsx src/serve.ts

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../" && pwd)"
BASELINE_DIR="${OUTPUT_DIR:-$ROOT_DIR/.kiro/specs/high-load-cache-readiness/baseline/$(date -u +%Y-%m-%d)}"
BASE_URL="${BASE_URL:-http://127.0.0.1:1989}"
SITE_ID="${SITE_ID:-loadtest-main-00000001}"
COLLECTION="${COLLECTION:-loadtest_collection_01}"
K6_IMAGE="${K6_IMAGE:-grafana/k6@sha256:e7eeddf1ce2361df6920d925297f487c0ba549c44be242c6a9c22f28d9b08efa}"
K6_TREND_STATS="avg,min,med,max,p(90),p(95),p(99)"

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${TOKEN:?TOKEN is required; pass a short-lived load-test token through the environment}"

mkdir -p "$BASELINE_DIR"
cd "$ROOT_DIR"

# k6 exits 99 when a threshold fails. For a BASELINE that is data, not an error:
# the whole point of Req 0.3 is to record what the system actually does, and
# on modest hardware the delivery thresholds are expected to fail. Any other
# non-zero code is a real failure (script error, connection refused, bad flag)
# and must stop the run — otherwise we would publish artifacts from a run that
# never reached the server.
#
# Thresholds are therefore advisory here. Task 20 (CI perf gate) derives its
# gating numbers FROM these artifacts (baseline x 1.2, Req 18.2) rather than
# reusing the hand-picked values inside the scripts.
K6_THRESHOLD_EXIT=99
FAILED_THRESHOLDS=()

measure() {
  local name="$1"
  shift
  local status=0
  docker run --rm -i --network host \
    -v "$ROOT_DIR/apps/cms/k6:/scripts:ro" \
    -v "$BASELINE_DIR:/out" \
    -e TOKEN="$TOKEN" \
    "$K6_IMAGE" run --summary-trend-stats="$K6_TREND_STATS" \
    --summary-export="/out/${name}.json" \
    "$@" || status=$?

  if [ "$status" -eq 0 ]; then
    return 0
  fi
  if [ "$status" -eq "$K6_THRESHOLD_EXIT" ]; then
    FAILED_THRESHOLDS+=("$name")
    echo "note: ${name} exceeded a threshold (k6 exit ${status}); measurement retained." >&2
    return 0
  fi
  echo "error: ${name} failed with k6 exit ${status} — not a threshold breach; aborting." >&2
  exit "$status"
}

if [ "${SKIP_SEED:-}" = "true" ]; then
  echo "note: SKIP_SEED=true — reusing the existing dataset." >&2
else
  # Idempotent (ON CONFLICT), but re-inserting 500k items takes a while; pass
  # SKIP_SEED=true when re-measuring against an already-seeded database.
  pnpm --filter @lumibase/database exec tsx ../../apps/cms/k6/seed.ts
fi

measure smoke \
  -e BASE_URL="$BASE_URL" -e SITE_ID="$SITE_ID" \
  /scripts/smoke.js

measure load-items \
  -e BASE_URL="$BASE_URL" -e SITE_ID="$SITE_ID" -e COLLECTION="$COLLECTION" \
  /scripts/load-items.js

measure load-realtime \
  -e BASE_URL="${BASE_URL/http/ws}" -e SITE_ID="$SITE_ID" -e COLLECTION="$COLLECTION" \
  /scripts/load-realtime.js

measure load-deliver \
  -e BASE_URL="$BASE_URL" -e SITE_ID="$SITE_ID" -e COLLECTION="$COLLECTION" \
  -e PAGE_COUNT=100 -e VUS=20 -e DURATION=2m -e ZIPF_EXPONENT=1.1 -e THINK_TIME=0.1 \
  /scripts/load-deliver.js

echo "Baseline artifacts written to $BASELINE_DIR"
if [ "${#FAILED_THRESHOLDS[@]}" -gt 0 ]; then
  echo "Thresholds exceeded (recorded, not an error): ${FAILED_THRESHOLDS[*]}"
fi
