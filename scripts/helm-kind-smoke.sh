#!/usr/bin/env bash
# kind smoke test for the Helm chart (#742). Two scenarios on one kind cluster:
#
#   1. install: install the chart, wait until every workload is ready
#      (migrations included), run `helm test` (/health, setup state, Studio
#      shell from inside the cluster), then upgrade and check that the
#      generated secrets did not change.
#   2. schema upgrade (#823 review): a worker and two web replicas that start
#      together (maxSurge=2). Install with `migrations.target` one migration
#      short of the image's journal (N-1), then `helm upgrade` to the full
#      journal (N) — a real schema upgrade with both web pods racing their
#      migrators and the worker gated — and assert: everything Ready,
#      `helm test` passes, `drizzle.__drizzle_migrations` holds exactly N
#      distinct rows, exactly one web pod applied each step while the other
#      found nothing to apply (the advisory lock), and the worker's main
#      container started only after its `migrations-ready` gate passed, which
#      itself finished no earlier than the migration was applied. Then switch
#      the same release to `migrations.mode=job` and check the Job path.
#
#   docker build -f docker/Dockerfile -t lumibase-cms:ci .
#   scripts/helm-kind-smoke.sh            # needs docker, kind, helm, kubectl, jq
#
# Environment: IMAGE (default lumibase-cms:ci, loaded into kind),
# KIND_CLUSTER (default lumibase-helm), KEEP_CLUSTER=1 to leave it running,
# SCENARIOS (default "install upgrade"), UPGRADE_FROM_TAG (default: the
# second-to-last entry of packages/database/drizzle/meta/_journal.json).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chart="$root/deploy/helm/lumibase"
journal="$root/packages/database/drizzle/meta/_journal.json"
cluster="${KIND_CLUSTER:-lumibase-helm}"
image="${IMAGE:-lumibase-cms:ci}"
scenarios="${SCENARIOS:-install upgrade}"
release=lumibase
ns=lumibase
ns_upgrade=lumibase-upgrade
kube_context="kind-$cluster"

for tool in kind helm kubectl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
done

kc() { kubectl --context "$kube_context" "$@"; }

created=0
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    for n in "$ns" "$ns_upgrade"; do
      kc get namespace "$n" >/dev/null 2>&1 || continue
      echo "::group::diagnostics ($n)"
      kc -n "$n" get pods,jobs,pvc,svc -o wide || true
      kc -n "$n" describe pods || true
      kc -n "$n" logs -l "app.kubernetes.io/instance=$release" \
        --all-containers --prefix --tail=200 || true
      kc -n "$n" get events --sort-by=.lastTimestamp || true
      echo "::endgroup::"
    done
  fi
  if [ "$created" -eq 1 ] && [ "${KEEP_CLUSTER:-0}" != 1 ]; then
    kind delete cluster --name "$cluster" || true
  fi
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if ! kind get clusters | grep -qx "$cluster"; then
  kind create cluster --name "$cluster" --wait 120s
  created=1
fi
kind load docker-image "$image" --name "$cluster"

repo="${image%:*}"
tag="${image##*:}"
values=(-f "$chart/ci/kind-values.yaml" --set "image.repository=$repo" --set "image.tag=$tag")

helm lint "$chart" "${values[@]}"

# ---------------------------------------------------------------------------
# Scenario 1: install, helm test, upgrade keeps the generated secrets.
# ---------------------------------------------------------------------------
scenario_install() {
  echo "--- [install] helm install"
  helm install "$release" "$chart" --kube-context "$kube_context" -n "$ns" --create-namespace \
    "${values[@]}" --wait --timeout 10m

  echo "--- [install] helm test"
  helm test "$release" --kube-context "$kube_context" -n "$ns" --logs --timeout 5m

  secret_of() {
    helm get manifest "$release" --kube-context "$kube_context" -n "$ns" \
      | awk '/^kind: Secret$/ { s = 1 } s && /^  ENCRYPTION_KEY:/ { print $2; exit }'
  }
  local before after
  before="$(secret_of)"
  [ -n "$before" ] || fail "ENCRYPTION_KEY not found in the release Secret"

  echo "--- [install] helm upgrade (generated secrets must be kept)"
  helm upgrade "$release" "$chart" --kube-context "$kube_context" -n "$ns" \
    "${values[@]}" --set cms.podAnnotations.smoke=upgraded --wait --timeout 10m
  after="$(secret_of)"
  [ "$before" = "$after" ] || fail "ENCRYPTION_KEY changed across helm upgrade"
  helm test "$release" --kube-context "$kube_context" -n "$ns" --logs --timeout 5m

  echo "Helm chart installed, passed its health checks and kept its secrets across an upgrade."
  # Free the node for the next scenario (the kept Secret goes with the namespace).
  helm uninstall "$release" --kube-context "$kube_context" -n "$ns" --wait --timeout 5m
  kc delete namespace "$ns" --wait --timeout 5m
}

# ---------------------------------------------------------------------------
# Scenario 2: schema upgrade N-1 → N with a worker and two racing web pods.
# ---------------------------------------------------------------------------

# Run SQL in the bundled PostgreSQL (its own credentials, from its own env).
# shellcheck disable=SC2016 # expanded by the pod's shell, not this one
psql_up() {
  kc -n "$ns_upgrade" exec "$release-postgresql-0" -c postgresql -- \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "$1"' \
    sh "$1"
}

# "rows distinct_hashes distinct_created_at" of the migrations table.
migration_stats() {
  psql_up "SELECT count(*) || ' ' || count(DISTINCT hash) || ' ' || count(DISTINCT created_at) FROM drizzle.__drizzle_migrations"
}

# Pods of a component that belong to the finished rollout (not terminating).
live_pods() {
  kc -n "$ns_upgrade" get pods \
    -l "app.kubernetes.io/instance=$release,app.kubernetes.io/component=$1" -o json \
    | jq -r '.items[] | select(.metadata.deletionTimestamp == null and .status.phase == "Running") | .metadata.name'
}

# Both rollouts finished and every live web/worker pod reports Ready.
wait_rollouts() {
  kc -n "$ns_upgrade" rollout status "deployment/$release" --timeout 10m
  kc -n "$ns_upgrade" rollout status "deployment/$release-worker" --timeout 10m
  local pod ready
  for pod in $(live_pods cms) $(live_pods worker); do
    ready="$(kc -n "$ns_upgrade" get pod "$pod" -o json \
      | jq -r '.status.conditions[] | select(.type == "Ready") | .status')"
    [ "$ready" = True ] || fail "$pod is not Ready"
  done
}

# Assert the lock: across the live web pods, exactly one `migrate` init
# container applied <expected> migration(s) and every other one found
# nothing to apply. Prints the applier's pod name.
assert_single_applier() {
  local expected="$1" pods applied=() idle=0 pod log
  pods="$(live_pods cms)"
  [ "$(wc -l <<<"$pods")" -eq 2 ] || fail "expected 2 live web pods, got: $pods"
  for pod in $pods; do
    log="$(kc -n "$ns_upgrade" logs "$pod" -c migrate)"
    if grep -q "Applied $expected migration(s)" <<<"$log"; then
      applied+=("$pod")
    elif grep -q 'Nothing to apply' <<<"$log"; then
      idle=$((idle + 1))
    else
      echo "$log" >&2
      fail "$pod: migrate init container neither applied $expected migration(s) nor found nothing to apply"
    fi
    echo "  $pod: $(grep -E 'Applied|Nothing to apply|holds the lock' <<<"$log" | tr '\n' ' ')" >&2
  done
  [ "${#applied[@]}" -eq 1 ] || fail "expected exactly one web pod to apply, got ${#applied[@]}: ${applied[*]}"
  [ "$idle" -eq 1 ] || fail "expected the other web pod to find nothing to apply"
  echo "${applied[0]}"
}

# Assert the worker gate: init container `migrations-ready` exited 0 no
# earlier than <applied_at>, and the worker container started after it.
assert_worker_gated() {
  local applied_at="$1" pods pod json gate_exit gate_done started
  pods="$(live_pods worker)"
  [ -n "$pods" ] || fail "no live worker pod"
  for pod in $pods; do
    json="$(kc -n "$ns_upgrade" get pod "$pod" -o json)"
    gate_exit="$(jq -r '.status.initContainerStatuses[] | select(.name == "migrations-ready") | .state.terminated.exitCode' <<<"$json")"
    gate_done="$(jq -r '.status.initContainerStatuses[] | select(.name == "migrations-ready") | .state.terminated.finishedAt' <<<"$json")"
    started="$(jq -r '.status.containerStatuses[] | select(.name == "worker") | .state.running.startedAt' <<<"$json")"
    echo "  $pod: migration applied at $applied_at, gate passed at $gate_done, worker started at $started" >&2
    [ "$gate_exit" = 0 ] || fail "$pod: migrations-ready did not exit 0 ($gate_exit)"
    # RFC 3339 UTC timestamps of equal length compare correctly as strings.
    [[ ! "$gate_done" < "$applied_at" ]] || fail "$pod: the gate passed before the migration was applied"
    [[ ! "$started" < "$gate_done" ]] || fail "$pod: the worker started before its gate passed"
    kc -n "$ns_upgrade" logs "$pod" -c migrations-ready | grep -q 'Schema is current' \
      || fail "$pod: the gate never reported a current schema"
  done
}

# When the `migrate` init container of <pod> finished.
migrate_finished_at() {
  kc -n "$ns_upgrade" get pod "$1" -o json \
    | jq -r '.status.initContainerStatuses[] | select(.name == "migrate") | .state.terminated.finishedAt'
}

scenario_upgrade() {
  local total from stats applier applied_at
  total="$(jq '.entries | length' "$journal")"
  from="${UPGRADE_FROM_TAG:-$(jq -r '.entries[-2].tag' "$journal")}"
  local expected_from
  expected_from="$(jq --arg t "$from" '([.entries[].tag] | index($t) // -1) + 1' "$journal")"
  if [ "$expected_from" -lt 1 ] || [ "$expected_from" -ge "$total" ]; then
    fail "UPGRADE_FROM_TAG=$from must be a journal entry before the last"
  fi
  local to_apply=$((total - expected_from))
  # Two web replicas started together, plus a worker.
  local upgrade_values=("${values[@]}"
    --set cms.replicaCount=2
    --set cms.strategy.rollingUpdate.maxSurge=2
    --set worker.enabled=true)

  echo "--- [upgrade] install at $from ($expected_from of $total migrations)"
  helm install "$release" "$chart" --kube-context "$kube_context" -n "$ns_upgrade" --create-namespace \
    "${upgrade_values[@]}" --set "migrations.target=$from" --wait --timeout 10m
  wait_rollouts
  stats="$(migration_stats)"
  [ "$stats" = "$expected_from $expected_from $expected_from" ] \
    || fail "after install: migrations table is '$stats', expected $expected_from distinct rows"
  echo "  fresh install, two web pods racing:"
  applier="$(assert_single_applier "$expected_from")"
  applied_at="$(migrate_finished_at "$applier")"
  assert_worker_gated "$applied_at"

  echo "--- [upgrade] helm upgrade to the full journal ($total migrations)"
  helm upgrade "$release" "$chart" --kube-context "$kube_context" -n "$ns_upgrade" \
    "${upgrade_values[@]}" --wait --timeout 10m
  wait_rollouts
  stats="$(migration_stats)"
  [ "$stats" = "$total $total $total" ] \
    || fail "after upgrade: migrations table is '$stats', expected $total distinct rows"
  echo "  schema upgrade, two new web pods racing:"
  applier="$(assert_single_applier "$to_apply")"
  applied_at="$(migrate_finished_at "$applier")"
  assert_worker_gated "$applied_at"
  helm test "$release" --kube-context "$kube_context" -n "$ns_upgrade" --logs --timeout 5m

  echo "--- [upgrade] switch the release to migrations.mode=job"
  helm upgrade "$release" "$chart" --kube-context "$kube_context" -n "$ns_upgrade" \
    "${upgrade_values[@]}" --set migrations.mode=job --wait --timeout 10m
  kc -n "$ns_upgrade" wait job --for=condition=complete --timeout 5m \
    -l "app.kubernetes.io/instance=$release,app.kubernetes.io/component=migrate"
  [ "$(kc -n "$ns_upgrade" get jobs -l "app.kubernetes.io/component=migrate" -o name | wc -l)" -eq 1 ] \
    || fail "expected exactly one migration Job"
  kc -n "$ns_upgrade" logs -l "app.kubernetes.io/component=migrate" -c migrate --tail=-1 \
    | grep -q 'Nothing to apply' || fail "the migration Job did not report a current schema"
  wait_rollouts
  for pod in $(live_pods cms) $(live_pods worker); do
    kc -n "$ns_upgrade" logs "$pod" -c migrations-ready | grep -q 'Schema is current' \
      || fail "$pod: no migrations-ready gate in job mode"
  done
  stats="$(migration_stats)"
  [ "$stats" = "$total $total $total" ] || fail "after job mode: migrations table is '$stats'"
  helm test "$release" --kube-context "$kube_context" -n "$ns_upgrade" --logs --timeout 5m

  echo "Schema upgrade $from -> $(jq -r '.entries[-1].tag' "$journal") applied once under the lock;" \
    "the worker waited for it; job mode passed."
}

for scenario in $scenarios; do
  case "$scenario" in
    install) scenario_install ;;
    upgrade) scenario_upgrade ;;
    *) fail "unknown scenario '$scenario' (install, upgrade)" ;;
  esac
done
