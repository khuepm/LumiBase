---
version: 1
lastUpdated: 2026-07-28T10:25:03.615Z
sourceLang: en
contentHash: fd79fbc9b05f2fea
codeVerified: 2026-07-28T10:25:03.615Z
codeVerifiedHash: fd79fbc9b05f2fea
codeVerifiedClaims: 8
---

# Deploying MeiliSearch on AWS

LumiBase already ships a MeiliSearch backend behind the `SearchProvider`
interface (see [Full-text Search](../features/search.md)). The Docker runtime
talks to any MeiliSearch instance over HTTP — locally that is the
`meilisearch` service in `docker/docker-compose.yml`, but for a shared demo or
staging environment you can host MeiliSearch on AWS and point the CMS at it.

This is a natural fit for a small AWS credit budget: MeiliSearch is a single
stateless binary plus a data volume, so a modest instance runs it comfortably.

> **Cost note (`[Inference]`):** the instance sizes below are starting points,
> not guarantees. Verify current pricing in the
> [AWS Pricing Calculator](https://calculator.aws) for your region before you
> commit — AWS prices change over time and by region.

## What you need

- An AWS account with credit available.
- A MeiliSearch **master key** (a long random string you generate). MeiliSearch
  derives scoped API keys from it; the CMS uses it as `MEILISEARCH_API_KEY`.
- Network reachability from wherever the CMS runs to the MeiliSearch host
  (same VPC, security group, or an authenticated public endpoint over TLS).

Generate a master key:

```bash
openssl rand -base64 48
```

## Option A — Amazon Lightsail (simplest)

Lightsail gives you a fixed-price VM with a public IP, which is the least
fiddly way to try MeiliSearch on AWS.

1. Create a Lightsail instance (Ubuntu LTS). A 1–2 GB RAM plan is enough for
   evaluation datasets `[Inference]`.
2. SSH in and run MeiliSearch as a container with a persistent volume:

   ```bash
   sudo docker run -d --name meilisearch \
     --restart unless-stopped \
     -p 7700:7700 \
     -e MEILI_MASTER_KEY="<your-master-key>" \
     -e MEILI_ENV="production" \
     -v /home/ubuntu/meili_data:/meili_data \
     getmeili/meilisearch:v1.7
   ```

   `MEILI_ENV=production` makes the master key **mandatory** — MeiliSearch
   refuses unauthenticated access, which is what you want on a reachable host.

3. Restrict inbound traffic: in the Lightsail firewall, open port `7700` only
   to the IP/range of your CMS host, not to `0.0.0.0/0`.
4. Terminate TLS in front of MeiliSearch (Caddy/Nginx, or an Application Load
   Balancer) if the CMS reaches it over the public internet. Never send the
   master key over plain HTTP off-host.

## Option B — ECS Fargate (managed, no VM to patch)

Run the `getmeili/meilisearch:v1.7` image as a Fargate service with:

- An **EFS volume** mounted at `/meili_data` so the index survives task
  restarts (Fargate task storage is ephemeral).
- `MEILI_MASTER_KEY` and `MEILI_ENV=production` as task environment.
- A security group that allows port `7700` only from the CMS task/service.

Fargate removes host maintenance but the always-on task plus EFS will draw down
credit faster than a small Lightsail box `[Inference]`. Scale the task to zero
when idle if you only need it intermittently.

## Option C — MeiliSearch Cloud (not AWS credit)

For the Cloudflare runtime, LumiBase expects **MeiliSearch Cloud over HTTP**.
That is a managed SaaS billed by Meili — it does **not** consume AWS credit.
Use it if you would rather not operate the service yourself; use Option A or B
if the point is to spend the AWS credit.

## Point LumiBase at it

The Docker runtime reads two variables (`packages/runtime/src/adapters/docker/index.ts`):

```bash
MEILISEARCH_HOST=https://search.your-domain.example   # or http://<private-ip>:7700
MEILISEARCH_API_KEY=<your-master-key>
```

Set them in your deployment environment (`docker/.env`, the `cms` service in
`docker-compose.prod.yml`, or your orchestrator's secret store). Restart the
CMS so the new `MeiliSearchProvider` picks them up.

## Backfill the index

A fresh MeiliSearch instance is empty. Reindex existing content:

```bash
pnpm -F @lumibase/cms exec tsx scripts/reindex.ts
```

Newly created/updated items are indexed continuously by the content-indexing
worker (`apps/cms/src/services/content-indexing-worker.ts`), so this backfill
is a one-time step per new instance.

## Verify

```bash
# Health (no auth required)
curl -sS "$MEILISEARCH_HOST/health"

# Authenticated stats — should list your collection indexes
curl -sS "$MEILISEARCH_HOST/indexes" \
  -H "Authorization: Bearer $MEILISEARCH_API_KEY"
```

Then hit the CMS search endpoint end-to-end:

```
GET /api/v1/search?q=<term>
```

## Operational notes

- **Backups:** snapshot the data volume (Lightsail snapshot / EFS backup). The
  index is rebuildable from Postgres via `reindex.ts`, so treat it as a cache,
  not a system of record.
- **Version pinning:** stay on the `v1.7` image tag the adapter is tested
  against; MeiliSearch can require a dump/restore across major upgrades.
- **Security:** the master key grants full admin. Keep it in a secret store,
  scope it out of client-facing code, and prefer private networking between the
  CMS and MeiliSearch over a public endpoint.
