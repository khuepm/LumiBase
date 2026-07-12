---
title: Git Integration (GitHub / GitLab)
---

# Git Integration (GitHub / GitLab)

Connect GitHub or GitLab repositories to a LumiBase site to track pull requests
and CI, view/store CI logs, post a content-validation status back, reconcile
declarative content intents (GitOps), and run opt-in ephemeral preview
environments per PR. Spec: `.kiro/specs/git-integration/`.

## 1. Goal & model

- **Per-tenant:** a site connects one or more repos; every row carries `site_id`.
- **Provider-agnostic:** business logic depends on the `GitProvider` interface;
  `GitHubProvider` / `GitLabProvider` adapters use only `fetch` (REST), so they
  run on both Cloudflare Workers and Docker via the shared runtime.
- **Earned autonomy:** a `git-sync` agent role is seeded at conservative L1
  (PROPOSE) on first connect; goal creation stays planner-only.

## 2. Auth

- **App install** (`authMethod: 'app'`) — GitHub App / GitLab App; installation
  tokens are minted on demand (GitHub App JWT is RS256 over a PKCS#8 key).
- **OAuth / PAT** (`authMethod: 'pat'`) — user pastes a token, or authorizes via
  the OAuth flow (`GET /:id/oauth/authorize` returns a URL; the public callback
  is bound to a single-use cache `state`).

## 3. Token security

- Access tokens and webhook secrets are encrypted at rest via `CryptoService`
  (AES-GCM), AAD-bound to `{ siteId, integrationId, field }` — a ciphertext
  cannot be replayed across sites or fields. Requires `ENCRYPTION_KEY`.
- Tokens are never returned by the API (`hasToken` boolean only) and never
  logged (`maskToken` fingerprint).

## 4. Webhooks & CI

- Public receiver `POST /api/v1/integrations/git/webhook/:provider/:siteId/:integrationId`.
  GitHub is verified by HMAC-SHA256 (`X-Hub-Signature-256`), GitLab by shared
  token (`X-Gitlab-Token`), compared in constant time. Unverified requests get
  `401 INVALID_SIGNATURE` before any state is touched. Events are logged
  idempotently by `(provider, delivery_id)` and processed async into the PR/CI
  cache. A failed CI run records an `agent_incident` + `git_ci_failed` audit.
- CI logs are fetched through the provider and cached in runtime blob storage so
  they remain viewable after the provider expires the originals.

## 5. GitOps

`POST /:id/gitops/sync` reads `lumibase/intents.json` from the repo, upserts each
definition into `content_intents` (via `IntentService`), then runs a drift scan +
reconcile so out-of-policy items become agent goals; provenance is recorded per
intent. Schema (collections/fields) apply through the HITL harness is a
follow-up.

## 6. Preview environments (opt-in)

When `sync_config.preview = true`, an opened PR provisions a derived ephemeral
site (`${siteId}__pr-${number}`) seeded with a copy of the base site's
collections/fields/items/pages, served at
`/api/v1/deliver/page/${ephemeralSiteId}/…`. It refreshes on push and is torn
down (cascade-delete) on close/merge, with a TTL cleanup.

## 7. Multi-tenancy

**Shared across the deployment** (server identity / config, not tenant data):

- `ENCRYPTION_KEY` (KEK for token encryption), `GITHUB_*` / `GITLAB_*` OAuth &
  App credentials, `LUMIBASE_PUBLIC_URL`. These identify the *server/app*, not a
  tenant, and never carry tenant data.

**Isolated per tenant (`site_id`):**

- All six tables (`lumibase_git_integrations`, `_git_pull_requests`,
  `_git_ci_runs`, `_git_webhook_events`, `_git_preview_envs`, `_git_provenance`)
  carry `site_id`; every `GitIntegrationService` / query is scoped
  `where(eq(table.siteId, siteId))`; all six are registered for RLS
  `site_isolation` in `packages/database/migrations/rls-policies.sql`.
- **Webhook routing:** the public receiver embeds `siteId` + `integrationId` in
  the URL and sets the RLS session var to that `siteId` before reading — it can
  only ever touch that one site's rows, and the per-integration secret signature
  is the authenticity gate.
- **Preview:** the ephemeral site id is derived from the base `siteId`
  (`${siteId}__pr-${n}`); preview content lives in its own `sites` row, isolated
  from the base site's production content. Provisioning is a deliberate
  cross-site *system* write (reads base under the base RLS context, writes the
  ephemeral site under the ephemeral context).
- **Token crypto:** AAD binds ciphertext to `{ siteId, integrationId }`, so a
  token row copied to another site fails to decrypt.

**How to verify two-site isolation** (staging, with Postgres):

1. Connect repo R on site **A** and (separately) on site **B**.
2. `GET /api/v1/integrations/git` with `X-Lumi-Site: A` returns only A's
   integrations; never B's. Same for `/pull-requests`, `/ci`, `/provenance`.
3. Each integration's `webhookUrl` embeds its own `siteId`; deliver a signed
   webhook to A's URL and confirm only A's PR/CI cache changes.
4. With `sync_config.preview`, open a PR on A → preview site `A__pr-N` is created;
   confirm it is invisible under `X-Lumi-Site: B` and its content does not touch
   A's production items.

Automated coverage: `crypto.test.ts` proves cross-site AAD isolation;
`git-service-tenant.test.ts` proves the site-scoped webhook URL / resource
mapping. The full DB-backed two-site list/query isolation is verified on staging
per the steps above (the CI environment has no Postgres).

## 8. Setup notes

- **No setup-wizard step / seed / capability flag.** Integrations are created
  after setup in **Studio → Settings → Integrations → Git repositories**.
- **Migration** `0009_git_integration` is additive (`CREATE TABLE IF NOT EXISTS`,
  `lumibase_git_*` prefix per ADR-010) — no backfill. See Setup Impact Registry
  row for git-integration.
- The `git-sync` role is seeded lazily; its L1 autonomy grant is seeded on the
  first repo connect (idempotent, never overrides operator-set levels).
