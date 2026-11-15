---
sourceLang: en
version: 3
lastUpdated: 2026-11-15T08:52:54.637Z
contentHash: 4c6c95f828adf398
codeVerified: 2026-11-15T08:52:54.637Z
codeVerifiedHash: 4c6c95f828adf398
codeVerifiedClaims: 36
---

# Kubernetes (Helm chart)

The official chart in `deploy/helm/lumibase/` runs the published image
`ghcr.io/khuepm/lumibase-cms` on Kubernetes: the CMS API **and** the Studio from
one Deployment on one origin, migrations before the server starts, probes on
the server's own health routes, and the hardening the image was built for
(non-root UID 65532, read-only root filesystem, no capabilities). PostgreSQL and
Redis are bundled for a first install and replaced by managed services for
production; Meilisearch is optional.

| Resource | When |
|----------|------|
| Deployment `<release>-lumibase` (API + Studio, role `all` or `web`) | always |
| Service, ConfigMap, Secret, ServiceAccount | always |
| StatefulSet + Service for PostgreSQL / Redis | `postgresql.enabled` / `redis.enabled` (default on) |
| StatefulSet + Service for Meilisearch | `meilisearch.enabled` |
| Deployment `<release>-lumibase-worker` (role `worker`) | `worker.enabled` |
| Ingress (TLS optional) | `ingress.enabled` |
| HorizontalPodAutoscaler, PodDisruptionBudget, NetworkPolicy | `autoscaling.enabled`, `podDisruptionBudget.enabled`, `networkPolicy.enabled` |
| `helm test` pod | `tests.enabled` (default on) |

Requirements: Kubernetes 1.25 or newer, Helm 3.8 or newer (OCI registries), and
a default StorageClass when the bundled services keep persistence on. The chart
calls the image's distroless entrypoint and migration runner directly, so it
needs the hardened image from [Hardened image](./docker.md#hardened-image) —
the release the chart is published with, or `image.tag=edge` for `main`.

## Install

The chart is published as an OCI artifact with every release, versioned like
the release, and its default image tag is that same release:

```bash
helm install lumibase oci://ghcr.io/khuepm/charts/lumibase --version <version> \
  --namespace lumibase --create-namespace \
  --set publicUrl=https://cms.example.com
```

From a checkout, use the path instead: `helm install lumibase ./deploy/helm/lumibase …`.

`publicUrl` is the one value you must give. In production the server refuses to
start without `CORS_ALLOWED_ORIGINS`, and the chart fails the render with a
message rather than leaving a pod in a crash loop. It accepts any one of:
`publicUrl`, `corsAllowedOrigins`, or `ingress.enabled` with a host (the origin
is then `https://<host>` when a TLS entry lists that host, `http://<host>`
otherwise).

### Try it locally (kind, port-forward)

```bash
kind create cluster
helm install lumibase ./deploy/helm/lumibase -n lumibase --create-namespace \
  --set publicUrl=http://localhost:1989 --wait --timeout 10m
kubectl -n lumibase port-forward service/lumibase 1989:80
```

Then open `http://localhost:1989/setup`. The install notes print the next
steps, including the setup-token command below.

## Setup token

The chart sets `LUMIBASE_REQUIRE_SETUP_TOKEN=true` (`setup.requireToken`): the
instance is reachable before anyone has set it up, and without the token
whoever reaches `/setup` first would own it. The first web pod to start mints
the token and prints it once:

```bash
kubectl -n lumibase logs -l app.kubernetes.io/instance=lumibase,app.kubernetes.io/component=cms \
  --tail=-1 --prefix | grep SETUP_TOKEN=
```

The plaintext is not stored, so a pod restart does not print it again. If it is
lost before setup is complete, clear the stored hash and restart; the next start
prints a new token (the statement is `CLEAR_SETUP_TOKEN_SQL` in
`apps/cms/src/modules/setup/startup.ts`):

```bash
kubectl -n lumibase exec statefulset/lumibase-postgresql -- \
  psql -U lumibase -d lumibase -c "UPDATE lumibase_system_state SET setup_token_hash = NULL WHERE id = 'singleton';"
kubectl -n lumibase rollout restart deployment/lumibase
```

## Secrets

The chart-managed Secret `<release>-lumibase` holds `JWT_SECRET`,
`ENCRYPTION_KEY` and the passwords of the bundled services. For each value the
order is: the value you set, else the value already in the Secret (read with
Helm's `lookup`, so `helm upgrade` keeps it), else a newly generated one.
Generated values are never written back to your values, so nothing secret ends
up in a file you commit.

- `ENCRYPTION_KEY` is generated as standard base64 of 32 random bytes, the form
  the server accepts. A key you set is checked at render time against the same
  rule (16, 24 or 32 bytes, canonical padding) — the server would refuse anything
  else in production.
- The Secret carries `helm.sh/resource-policy: keep`
  (`secrets.keepOnUninstall`): `helm uninstall` leaves it in place, and a
  reinstall under the same release name and namespace reuses it instead of
  minting a key that cannot read the old data.
- **Back up `ENCRYPTION_KEY`** right after the first install (the notes print
  the command). Encrypted fields and two-factor seeds cannot be read without it;
  see [Encryption keys](../operations/encryption-keys.md).
- Bundled-service URLs are never stored: the pod spec carries
  `postgresql://lumibase:$(LUMIBASE_HELM_POSTGRES_PASSWORD)@…`, and Kubernetes
  fills in the password from the Secret when the container starts.

**GitOps (Argo CD, Flux) and `helm template`:** `lookup` returns nothing when the
chart is rendered without a cluster connection, so generated values would change
on every sync — a new `ENCRYPTION_KEY` each time. Create the Secret yourself and
point the chart at it:

```bash
kubectl -n lumibase create secret generic lumibase-app \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)" \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

```yaml
secrets:
  existingSecret: lumibase-app   # keys JWT_SECRET and ENCRYPTION_KEY
```

The same applies to the bundled passwords (`postgresql.auth.existingSecret`,
`redis.auth.existingSecret`), or run PostgreSQL and Redis outside the chart.

## Production values

```yaml
publicUrl: https://cms.example.com
secrets:
  existingSecret: lumibase-app
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: cms.example.com
      paths: [{ path: /, pathType: Prefix }]
  tls:
    - secretName: cms-example-com-tls
      hosts: [cms.example.com]
postgresql:
  enabled: false
database:
  external:
    existingSecret: lumibase-db        # key DATABASE_URL, with sslmode=require
redis:
  enabled: false
  external:
    existingSecret: lumibase-redis     # key REDIS_URL
meilisearch:
  external:
    host: https://search.example.com
    existingSecret: lumibase-search    # key MEILISEARCH_API_KEY
s3:
  endpoint: https://s3.eu-central-1.amazonaws.com
  bucket: lumibase-media
  existingSecret: lumibase-s3          # keys S3_ACCESS_KEY, S3_SECRET_KEY
podDisruptionBudget:
  enabled: true
networkPolicy:
  enabled: true
  ingressFrom:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
```

## Values and the variables they set

Every setting maps to a variable the image reads; see
[Environment variables](./environment-variables.md) for what each one does.
Anything else goes in `config` (non-secret, rendered into the ConfigMap, and it
wins over the chart's own keys), `extraEnv` or `extraEnvFrom`.

| Value | Variable |
|-------|----------|
| `environment` | `NODE_ENV` (when `production`), `LUMIBASE_ENV` |
| `publicUrl` (or the ingress host) | `LUMIBASE_PUBLIC_URL` |
| `corsAllowedOrigins` (default: the public origin) | `CORS_ALLOWED_ORIGINS` |
| `setup.requireToken` | `LUMIBASE_REQUIRE_SETUP_TOKEN` |
| `studio.enabled` | `LUMIBASE_SERVE_STUDIO` |
| `secrets.*` | `JWT_SECRET`, `ENCRYPTION_KEY` |
| `postgresql.*` / `database.external.*` | `DATABASE_URL` |
| `database.sslMode` (`disable` with the bundled PostgreSQL) | `DATABASE_SSL_MODE` |
| `database.rls`, `database.systemUrl.*` | `LUMIBASE_DB_RLS`, `DATABASE_SYSTEM_URL` |
| `redis.*` | `REDIS_URL` |
| `meilisearch.*` | `MEILISEARCH_HOST`, `MEILISEARCH_API_KEY` |
| `s3.*` | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` |
| `cms.role`, `worker.enabled` | `LUMIBASE_PROCESS_ROLE` |
| `worker.healthPort` | `LUMIBASE_WORKER_HEALTH_PORT` |
| `migrations.mode` | `SKIP_MIGRATIONS`, `MIGRATION_MODE` (init container) |

The chart always sets `LUMIBASE_RUNTIME=docker` and `PORT=1989`.
`values.schema.json` rejects malformed values before anything is rendered.

## Migrations

`migrations.mode` picks who runs them:

- `initContainer` (default): each web pod first runs the image entrypoint with
  `MIGRATION_MODE=preflight` — which waits for the database with the
  entrypoint's own retry and backoff and prints the schema version — then
  `node /app/dist/migrate.cjs apply`. The server container starts with
  `SKIP_MIGRATIONS=true`. A failed migration keeps the pod out of service
  instead of serving on a half-migrated schema, and the rolling update stops
  there. When several pods start at once, each run is one transaction; a pod
  that loses the race fails and is retried by Kubernetes.
- `entrypoint`: no init containers; the image migrates on every start, as on
  Docker and the one-click platforms.
- `none`: `SKIP_MIGRATIONS=true` everywhere; run migrations from your own
  pipeline before rolling out.

Not a Helm hook on purpose: a pre-install hook runs before the bundled
PostgreSQL and the chart's Secret exist, so it could not reach the database.

Worker pods never migrate. Read [Upgrades](../operations/upgrades.md) before
moving `image.tag` across a major release.

## Health checks

| Probe | Path | Why |
|-------|------|-----|
| startup, liveness | `/health` | Answers 200 whenever the process serves HTTP, so a database outage does not restart every pod. |
| readiness | `/health/ready` or `/health` | `/health/ready` answers 503 while any of database, cache, search, storage or queue is unhealthy. |

`cms.readinessPath` empty (the default) picks `/health/ready` only when search
**and** object storage are configured; otherwise `/health`, because
`/health/ready` would report the missing service and never turn ready. Set it
explicitly to override. Worker pods probe `/health` and `/health/ready` on
`worker.healthPort`.

## Scaling

- `cms.replicaCount` or `autoscaling.enabled` (CPU, optionally memory) scale the
  web Deployment. Scheduled jobs are leader-locked through Redis, so more than
  one replica does not run them twice.
- `worker.enabled` moves queue workers and the scheduler into their own
  Deployment (`LUMIBASE_PROCESS_ROLE=worker`), and the web pods switch to `web`.
- **Realtime limitation:** on the Docker runtime WebSocket events are delivered
  in-process (`packages/runtime/src/adapters/docker/realtime.ts`), so with more
  than one web replica a client receives only the events published by the pod
  it is connected to. Keep one web replica if you depend on realtime, or accept
  that limitation.
- `podDisruptionBudget.enabled` protects the web pods during node drains.

## Bundled services

PostgreSQL (`postgres:16-alpine`), Redis (`redis:7-alpine`) and Meilisearch
(`getmeili/meilisearch:v1.7`, the versions in `docker/docker-compose.yml`) are
plain single-instance StatefulSets, non-root with a read-only root filesystem.
They are not dependency subcharts: a subchart must be fetched from a chart
repository at install time and pins its own release cadence and images, while a
template in this chart installs offline and is reviewed with it. They have no
replication and no backups; use them to evaluate, and use managed services in
production. Redis runs with AOF persistence and `noeviction`, because BullMQ
jobs must never be evicted.

Object storage is not bundled. Without `s3.endpoint` the instance boots and
setup completes, but uploads do not work.

## NetworkPolicy

With `networkPolicy.enabled` the web pods accept traffic only on their HTTP port
(from `networkPolicy.ingressFrom` when set), the worker accepts none (traffic from
the pod's own node, which carries the kubelet probes, is always allowed), and the bundled PostgreSQL, Redis and
Meilisearch accept only the release's web and worker pods. Egress is not
restricted: the CMS calls object storage, LLM providers and webhooks.

## Verify

```bash
helm test lumibase -n lumibase --logs
```

The test pod uses the release image's own Node to check, through the Service,
that `/health` answers, that `/api/v1/setup/state` answers, and that `/setup`
serves the Studio shell. In CI, `.github/workflows/helm.yml` lints the chart,
runs `scripts/__tests__/helm-chart.test.mjs` (render tests), and
`scripts/helm-kind-smoke.sh` installs the chart on kind with the image built
from the same commit, runs `helm test`, upgrades, and checks that
`ENCRYPTION_KEY` did not change.

## Upgrade and uninstall

```bash
helm upgrade lumibase oci://ghcr.io/khuepm/charts/lumibase --version <new> -n lumibase -f my-values.yaml
helm uninstall lumibase -n lumibase
```

`helm uninstall` keeps the Secret (see [Secrets](#secrets)) and the
StatefulSets' PersistentVolumeClaims; delete them yourself when the data should
go.
