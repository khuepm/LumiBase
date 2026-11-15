# LumiBase Helm chart

Runs the LumiBase CMS API and the Studio admin UI on Kubernetes from the
published image `ghcr.io/khuepm/lumibase-cms`, with optional bundled
PostgreSQL, Redis and Meilisearch.

```bash
helm install lumibase oci://ghcr.io/khuepm/charts/lumibase --version <version> \
  --namespace lumibase --create-namespace \
  --set publicUrl=https://cms.example.com
```

`publicUrl` (or `corsAllowedOrigins`, or an ingress host) is required: in
production the server refuses to start without `CORS_ALLOWED_ORIGINS`, and the
chart fails the render instead.

Full guide, both locales: `docs/en/deployment/kubernetes-helm.md`,
`docs/vi/deployment/kubernetes-helm.md` — install, setup token, secrets and
GitOps, production values, the value-to-variable table, migration modes, health
probes, scaling (and the realtime limitation with several web replicas),
bundled services, NetworkPolicy, `helm test`, upgrade and uninstall.

## Key values

| Value | Default | Meaning |
|-------|---------|---------|
| `image.repository` / `image.tag` | `ghcr.io/khuepm/lumibase-cms` / chart appVersion | Needs the hardened (distroless) image. |
| `publicUrl` | `""` | Public origin; sets `LUMIBASE_PUBLIC_URL` and the default CORS origin. |
| `secrets.existingSecret` | `""` | Secret with `JWT_SECRET` and `ENCRYPTION_KEY`; required for GitOps renders. |
| `postgresql.enabled` / `database.external.*` | `true` | Bundled single-instance PostgreSQL, or an external URL/Secret. |
| `redis.enabled` / `redis.external.*` | `true` | Redis is required (cache, queues, locks). |
| `meilisearch.enabled` / `meilisearch.external.*` | `false` | Optional search. |
| `s3.*` | unset | S3-compatible media storage (not bundled). |
| `migrations.mode` | `initContainer` | `initContainer`, `entrypoint` or `none`. |
| `worker.enabled` | `false` | Separate worker Deployment; web pods run as `web`. |
| `ingress.*`, `autoscaling.*`, `podDisruptionBudget.*`, `networkPolicy.*` | off | Optional. |

All values are documented in `values.yaml` and validated by
`values.schema.json`.

## Development

```bash
helm lint deploy/helm/lumibase -f deploy/helm/lumibase/ci/kind-values.yaml --strict
node --test scripts/__tests__/helm-chart.test.mjs     # render tests (skips without helm)
docker build -f docker/Dockerfile -t lumibase-cms:ci . && scripts/helm-kind-smoke.sh
```

CI: `.github/workflows/helm.yml`. Published by the `publish-helm-chart` job of
`.github/workflows/release.yml`.
