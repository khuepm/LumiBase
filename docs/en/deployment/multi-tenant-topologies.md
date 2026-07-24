# Multi-Tenant Deployment Topologies

> **Audience:** platform operators and solution architects deploying LumiBase for many tenants.
> **Scope:** deployment-level tenancy — how CMS instances, databases and networks are laid out per tenant. Application-level tenancy (RLS, permissions, per-site settings) is covered by the [data model](../data-model.md) and [security docs](../security/user-management.md).

Throughout this document, every capability is tagged as either **[Platform]**
(implemented in this repository, with code references) or **[Pattern]**
(a recommended reference architecture you assemble from platform capabilities
plus your own infrastructure).

---

## 1. Terminology

| Term | Meaning |
| --- | --- |
| **Tenant** | One customer/brand. Maps to one **site** row; every domain table is scoped by `site_id`. |
| **Core layer** | The parts identical for all tenants: the CMS image/Worker bundle and the shared database schema. Pinned by release version. |
| **Adaptive layer** | The parts that differ per tenant: collections, fields, settings, webhooks, flows, extensions. Expressed as **data/config**, never as a source-code fork. |
| **Cell** | One self-contained deployment (CMS + Postgres + cache + storage) hosting one or more tenants. |
| **Fleet** | The set of all cells you operate, managed from one declarative repository. |

The design rule that makes every topology below work: **Core is a versioned
artifact, Adaptive is declarative config.** If a tenant requirement can only be
met by patching source code, model it as an extension or a flow instead
(see `packages/extension-sdk/`), so the Core image stays identical fleet-wide.

## 2. Tenancy primitives the platform provides

These are the building blocks every topology composes. **[Platform]**

1. **Row-level tenancy.** Every domain table carries `site_id`; queries are
   scoped in the ORM layer and enforced again by RLS middleware
   (`apps/cms/src/middleware/rls.ts`).
2. **Tenant resolution by request** (`apps/cms/src/middleware/tenant.ts`), in
   priority order:
   1. `X-Lumi-Site` header (Studio, SDK, server-to-server),
   2. exact `Host` → site mapping from `site_domains` (custom domains, cached
      in KV/Redis),
   3. legacy first-label subdomain mapping,
   4. `?site=` query (dev only, `LUMIBASE_DEV_AUTH=true`).
   Consequence: **one instance serves any number of tenant domains** — adding a
   domain is a data change plus DNS/TLS at your ingress, not a deployment.
3. **Config-as-Code API** (`apps/cms/src/routes/config.ts`):
   - `GET  /api/v1/config/export?scope=all|schema|settings|webhooks`
   - `POST /api/v1/config/import?dryRun=true` — validate + diff, no writes
   - `POST /api/v1/config/import?mode=merge|replace-managed|replace-all&allowDestructive=…`
   Site-admin only; every apply is audit-logged. This is the transport for the
   Adaptive layer.
4. **Dual runtime.** The same CMS codebase runs on Cloudflare Workers
   (`apps/cms/src/index.ts`) and as a Node.js container
   (`apps/cms/src/serve.ts`); business logic uses the runtime abstraction
   (`packages/runtime/`), so a tenant can move between runtimes without code
   changes.
5. **Version pinning.** Docker deployments pin the Core image with
   `LUMIBASE_VERSION` (see [Docker deployment](./docker.md)); Workers pin by
   deployed Worker version. This is what makes per-tenant version skew and
   canary waves possible.
6. **Offboarding surface.** Data export (`routes/data-export.ts`) and erasure
   (`routes/admin-erasure.ts`) endpoints operate per site, so tenant exit does
   not require ad-hoc SQL.

## 3. Topology catalog

### T1 — Pooled (shared cell) · *default*

**[Platform + Pattern]** One cell serves all tenants. Isolation is logical
(`site_id` + RLS). This is the topology the repository's compose files
(`docker/docker-compose.yml` + `docker-compose.prod.yml`) produce out of the box.

```
┌─ cell: shared ────────────────────────────────┐
│ ingress (Caddy / your proxy)                  │
│   → cms (image :X.Y.Z, N replicas)            │
│   → postgres · redis · minio                  │
└───────────────────────────────────────────────┘
tenant-a.com ─┐
tenant-b.vn  ─┼─→ same ingress → Host-based site resolution
cms.acme.io  ─┘
```

- **Onboard a tenant:** create site → register domains → apply config
  manifest → point DNS. No new deployment.
- **Choose when:** most tenants, no hard isolation/residency demands, you want
  the lowest cost and operational load.
- **Watch for:** noisy neighbors (mitigated by the pressure limiter and rate
  limits — see [Docker deployment](./docker.md)), blast radius of a bad Core
  upgrade (mitigated by wave rollout, §8.1).

### T2 — Hybrid (pool + dedicated cells)

**[Pattern]** The pooled cell hosts the long tail; a small number of tenants
get their own cell (own CMS + Postgres) because of contract, load or
compliance. Same Core image everywhere, possibly at different pinned versions.

```
cell shared   : tenants a…m        (LUMIBASE_VERSION=2.14.1)
cell tenant-n : tenant n only      (2.14.1, dedicated DB)
cell tenant-p : tenant p only      (2.13.9 — held back by contract)
```

- **Choose when:** 80–95% of tenants fit the pool but a few need dedicated
  resources, a held-back version, or contractual isolation.
- **Watch for:** version skew discipline — record each cell's pinned version in
  the fleet repo and cap the allowed spread (e.g. max one minor behind).

### T3 — Siloed (cell per tenant)

**[Pattern]** Every tenant gets a full cell. Strongest isolation on your own
infrastructure; highest cost and operational overhead. Manage the fleet
declaratively (one `tenant.yaml` per tenant: domain, target nodes/labels,
pinned Core version, resources) and deploy with `docker stack deploy` /
Dokploy API / a GitOps agent — never by hand.

- **Choose when:** few, large tenants; per-tenant SLAs; regulated data that
  must not share a database.
- **Watch for:** upgrade fan-out (automate waves, §8.1) and configuration
  drift (§8.3). Without a reconcile loop this topology decays fastest.

### T4 — Edge pooled (Cloudflare Workers)

**[Platform + Pattern]** The pooled topology on the Workers runtime: one
Worker (Core) + Hyperdrive-pooled Postgres + KV config cache + R2 media +
Durable Objects for realtime, as described in
[Deployment overview](./overview.md) and [Cloudflare deployment](./cloudflare.md).
Tenant custom domains attach via Cloudflare routes; resolution is the same
Host-mapping mechanism as T1.

- **Choose when:** global read-heavy delivery, minimal infrastructure
  operations, tenants spread across regions.
- **Watch for:** scope Worker routes to your API paths (`/api/*`) so tenant
  wildcard domains don't shadow other properties on the same zone; external
  search (MeiliSearch) and other self-hosted dependencies remain your
  responsibility.

### T5 — Regional cells (data residency)

**[Pattern]** Several pooled cells, one per region/jurisdiction (e.g. `eu`,
`vn`, `us`). Each tenant is **pinned to exactly one cell**; the cell is chosen
at onboarding and recorded in the tenant registry. Routing options, simplest
first:

1. **DNS-level:** each tenant's domain points directly at its cell's ingress —
   no global router needed. Recommended default.
2. **Global edge router:** a thin proxy (e.g. a Worker) maps Host → cell
   origin. Adds a hop; only justified when domains must be centrally managed.

- **Choose when:** GDPR/data-localization requirements, or latency-sensitive
  tenants clustered in distinct regions.
- **Watch for:** never let cross-cell traffic touch tenant data (backups,
  observability pipelines included); keep per-region backup storage.

### T6 — Customer-hosted / BYOC

**[Pattern]** For enterprise customers who must run in their own
infrastructure: ship them the pinned Core image plus a compose bundle
(`docker-compose.yml` + prod override + `.env` template) and their Adaptive
config manifest. The customer operates the cell; you deliver upgrades as new
pinned image versions plus migration notes, and config changes as manifest
files they apply through the Config API (`dryRun` first).

- **Choose when:** procurement/security demands customer-controlled
  infrastructure or fully air-gapped operation.
- **Watch for:** support burden — define a supported-version window and an
  upgrade cadence in the contract; require them to return
  `GET /api/v1/config/export` output with support tickets so you can reproduce
  their Adaptive state.

### T7 — Environment lanes (dev → staging → prod)

**[Pattern]** Orthogonal to T1–T6: each environment is its own cell (or pool),
and a tenant's Adaptive manifest is **promoted** across lanes instead of edited
in place. The manifest in git is the artifact; promotion = applying the same
manifest to the next lane after `dryRun` review. Shared-domain tricks for
non-production environments are documented in
[Shared-domain environments](./shared-domain-environments.md).

## 4. Choosing a topology

| Criterion | T1 Pooled | T2 Hybrid | T3 Siloed | T4 Edge | T5 Regional | T6 BYOC |
| --- | --- | --- | --- | --- | --- | --- |
| Infra cost per tenant | lowest | low | high | lowest | low–mid | customer's |
| Ops overhead | lowest | mid | high | low | mid | contract-bound |
| Isolation | logical (RLS) | mixed | physical | logical | logical + geo | physical |
| Blast radius of bad upgrade | all tenants | pool only | one tenant | all tenants | one region | one customer |
| Per-tenant version pinning | no | dedicated cells only | yes | no | per cell | yes |
| Data residency | no | partial | yes | Cloudflare regions | yes | yes |
| Onboarding speed | minutes | minutes (pool) | cell provision time | minutes | minutes | days–weeks |

Default recommendation: **start at T1, evolve to T2 when the first tenant
demands isolation, and treat T3/T5/T6 as explicit, priced decisions.** All
topologies share the same Core artifact and Adaptive manifest format, so the
choice is reversible (§7).

## 5. The Adaptive layer as Config-as-Code

**[Platform + Pattern]** Keep one declarative repository for the fleet:

```
fleet/
├── templates/                     # Core: compose templates, shared services
├── tenants/
│   └── acme/
│       ├── tenant.yaml            # cell, domains, pinned versions, resources
│       └── lumibase.config.json   # Adaptive manifest (config/export output)
└── waves.yaml                     # canary → wave-1 → wave-2 tenant groups
```

The change loop for the Adaptive layer:

```bash
# 1. Plan — validate + diff against the running site (no writes)
curl -s -X POST "$CMS/api/v1/config/import?dryRun=true" \
  -H "X-Lumi-Site: $SITE_ID" -H "Authorization: Bearer $TOKEN" \
  -d @tenants/acme/lumibase.config.json

# 2. Apply — after the diff is reviewed
curl -s -X POST "$CMS/api/v1/config/import?mode=merge" \
  -H "X-Lumi-Site: $SITE_ID" -H "Authorization: Bearer $TOKEN" \
  -d @tenants/acme/lumibase.config.json
```

Rules that keep this safe:

- `allowDestructive=true` stays **off** in CI; destructive schema changes are
  applied manually with a reviewed diff.
- The manifest in git is the source of truth; Studio edits on production sites
  are either forbidden by policy or re-exported into git immediately.
- Secrets never enter `tenant.yaml` or manifests — use your secret store
  (Docker secrets, sops-encrypted files, Wrangler secrets).

## 6. Tenant lifecycle

**[Pattern, composed of Platform APIs]**

1. **Onboard:** create site → register domains (`routes/domains.ts`) → apply
   Adaptive manifest (`dryRun` → apply) → provision DNS/TLS at ingress →
   smoke-check `/health` and one authenticated read.
2. **Change:** edit manifest in git → PR with `dryRun` diff attached → apply on
   merge (per environment lane, §T7).
3. **Scale/move:** see migration paths, §7.
4. **Offboard:** freeze writes → `data-export` for handover → erasure endpoints
   for PII → remove domains and site → archive the tenant folder in git
   (retain for audit; the folder is history, not live config).

## 7. Migration paths between topologies

**[Pattern]** All paths rely on the same two artifacts — the Adaptive manifest
and the tenant's data export — plus standard PostgreSQL tooling:

- **T1 → T2/T3 (pool → dedicated):** provision the new cell at the same Core
  version → apply the tenant's manifest → copy the tenant's rows
  (site-scoped dump/restore) → verify counts and spot-check content → flip DNS
  (lower TTL beforehand) → remove the tenant from the pool cell.
- **T3 → T1 (dedicated → pool):** reverse of the above; verify the pool cell's
  Core version is ≥ the tenant's pinned version first.
- **Docker ↔ Workers (T1 ↔ T4):** the Core codebase is runtime-portable; the
  work is in the stateful services (Postgres ↔ Hyperdrive-fronted Postgres,
  MinIO ↔ R2, Redis ↔ KV). Plan it as a data migration, not a code migration.

Always rehearse on a staging lane with a copy of the tenant's data before the
production window.

## 8. Fleet operations

### 8.1 Upgrades in waves

**[Pattern]** Never upgrade the whole fleet at once. Maintain wave groups
(`canary` → `wave-1` → `wave-2`) in the fleet repo; bump `LUMIBASE_VERSION`
per wave with soak time between waves. For T1/T4 (one shared Core), the wave
unit is the *environment lane* instead: dev → staging → prod.

### 8.2 Observability

**[Pattern]** One shared observability plane for all cells (the repo ships
Prometheus/Grafana compose files under `docker/`). Label every metric/log
stream with `cell` and, where the CMS emits it, `site_id`, so per-tenant
dashboards and alerts work in every topology. Alert at minimum on: `/health`
per cell, error rate per site, event-loop pressure (`SERVICE_UNAVAILABLE`
rate), and queue/CDC lag.

### 8.3 Drift detection

**[Pattern]** Reconcile on a schedule (e.g. hourly): for each tenant, run the
Config API `dryRun` against the manifest in git and diff the running stack
definition against the rendered template. Non-empty diff = drift → alert, and
either re-apply (autofix) or open a ticket, per your policy.

### 8.4 Backup & restore

**[Pattern]** Backup scope follows topology: per-cell Postgres backups (T1/T4:
one backup covers all tenants; T3/T5: per tenant/region) plus object-storage
replication. Restore drills are part of the release checklist — see
`docker/restore-drill.env.example` for the drill harness inputs. For pooled
cells, practice **single-tenant restore** (site-scoped extraction from a full
backup), because that is the request you will actually get.

## 9. Security considerations

- Logical isolation in pooled topologies rests on `site_id` scoping + RLS —
  keep the RLS middleware in every deployment profile and treat any query
  missing a site scope as a release blocker (Strict Rule #2). **[Platform]**
- Terminate TLS per tenant domain at the ingress; automate certificate
  issuance (Caddy does this in the shipped compose files). **[Platform]**
- Per-tenant API keys and rate limits reduce cross-tenant noisy-neighbor and
  credential-blast-radius risk in pooled cells. **[Platform]**
- In T5/T6, verify that *operational* data flows (backups, logs, metrics,
  error trackers) respect residency, not just the primary database. **[Pattern]**

## 10. Related documents

- [Deployment overview](./overview.md)
- [Docker deployment](./docker.md)
- [Cloudflare deployment](./cloudflare.md)
- [Shared-domain environments](./shared-domain-environments.md)
- [Environment variables](./environment-variables.md)
- [Data model](../data-model.md) · [User management & auth realms](../security/user-management.md)
