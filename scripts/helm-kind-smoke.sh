#!/usr/bin/env bash
# kind smoke test for the Helm chart (#742): install the chart into a kind
# cluster, wait until every workload is ready (migrations included), run
# `helm test` (/health, setup state, Studio shell from inside the cluster),
# then upgrade and check that the generated secrets did not change.
#
#   docker build -f docker/Dockerfile -t lumibase-cms:ci .
#   scripts/helm-kind-smoke.sh            # needs docker, kind, helm
#
# Environment: IMAGE (default lumibase-cms:ci, loaded into kind),
# KIND_CLUSTER (default lumibase-helm), KEEP_CLUSTER=1 to leave it running.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chart="$root/deploy/helm/lumibase"
cluster="${KIND_CLUSTER:-lumibase-helm}"
image="${IMAGE:-lumibase-cms:ci}"
release=lumibase
ns=lumibase
kube_context="kind-$cluster"

created=0
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && command -v kubectl >/dev/null 2>&1; then
    echo "::group::diagnostics"
    kubectl --context "$kube_context" -n "$ns" get pods,pvc,svc -o wide || true
    kubectl --context "$kube_context" -n "$ns" describe pods || true
    kubectl --context "$kube_context" -n "$ns" logs -l "app.kubernetes.io/instance=$release" \
      --all-containers --prefix --tail=200 || true
    kubectl --context "$kube_context" -n "$ns" get events --sort-by=.lastTimestamp || true
    echo "::endgroup::"
  fi
  if [ "$created" -eq 1 ] && [ "${KEEP_CLUSTER:-0}" != 1 ]; then
    kind delete cluster --name "$cluster" || true
  fi
  exit "$status"
}
trap cleanup EXIT

if ! kind get clusters | grep -qx "$cluster"; then
  kind create cluster --name "$cluster" --wait 120s
  created=1
fi
kind load docker-image "$image" --name "$cluster"

repo="${image%:*}"
tag="${image##*:}"
values=(-f "$chart/ci/kind-values.yaml" --set "image.repository=$repo" --set "image.tag=$tag")

helm lint "$chart" "${values[@]}"

echo "--- helm install"
helm install "$release" "$chart" --kube-context "$kube_context" -n "$ns" --create-namespace \
  "${values[@]}" --wait --timeout 10m

echo "--- helm test"
helm test "$release" --kube-context "$kube_context" -n "$ns" --logs --timeout 5m

secret_of() {
  helm get manifest "$release" --kube-context "$kube_context" -n "$ns" \
    | awk '/^kind: Secret$/ { s = 1 } s && /^  ENCRYPTION_KEY:/ { print $2; exit }'
}
before="$(secret_of)"
[ -n "$before" ] || { echo "ENCRYPTION_KEY not found in the release Secret" >&2; exit 1; }

echo "--- helm upgrade (generated secrets must be kept)"
helm upgrade "$release" "$chart" --kube-context "$kube_context" -n "$ns" \
  "${values[@]}" --set cms.podAnnotations.smoke=upgraded --wait --timeout 10m
after="$(secret_of)"
if [ "$before" != "$after" ]; then
  echo "ENCRYPTION_KEY changed across helm upgrade" >&2
  exit 1
fi
helm test "$release" --kube-context "$kube_context" -n "$ns" --logs --timeout 5m

echo "Helm chart installed, passed its health checks and kept its secrets across an upgrade."
