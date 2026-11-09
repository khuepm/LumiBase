---
version: 1
lastUpdated: 2026-11-09T10:47:21.066Z
sourceLang: en
contentHash: bc1d243317196919
codeVerified: 2026-11-09T10:47:21.066Z
codeVerifiedHash: bc1d243317196919
codeVerifiedClaims: 26
---

# ADR-013: Organization plane (tenant hierarchy and scope-typed credentials)

**Date:** 2026-11-09
**Status:** Proposed

<!-- verify-code-refs: planned /api/v1/orgs /api/v1/orgs/:orgId /api/v1/orgs/:orgId/sites /api/v1/orgs/:orgId/sites/:siteId /api/v1/orgs/:orgId/sites/:siteId/transfer /api/v1/orgs/:orgId/members /api/v1/orgs/:orgId/keys -->

## Context

LumiBase is multi-tenant by default: every domain table carries `site_id`,
every query filters by it, and an API key (`lbk_…`) is bound to exactly one
site (`api_keys.site_id`, `packages/database/src/schema/access.ts`). Roles,
policies and memberships (`user_sites`) are all per site. The only principal
that stands above a site is the bootstrap admin (`users.is_bootstrap`), and it
is a boolean flag, not a principal with an API surface.

The model therefore has **one plane: the site**. Nothing in the schema can
answer the question "who may create a site, and whose site is it?":

- `sites` (`packages/database/src/schema/core.ts`) has no parent column — no
  `owner_id`, no `organization_id`. A site belongs to nobody.
- `POST /api/v1/admin/sites` and `DELETE /api/v1/admin/sites/:id`
  (`apps/cms/src/routes/admin.ts`) exist only because the test runner needs
  them. They are guarded by `requireSiteAdmin` of the *calling* site, so an
  administrator of site A can create arbitrary sites or delete site B. Tenant
  isolation is only as strong as the weakest route, and these two routes have
  no tenant to be isolated to.
- The MCP server (`packages/mcp-server`) mirrors the model exactly: one
  `LUMIBASE_SITE_ID`, one site-scoped token, therefore no `create_site`,
  `list_sites` or `switch_site` tool. That is *correct* for the credential it
  holds — a site token must never reach outside its site — but it leaves no
  credential that could.

The trigger for this ADR was a user asking the MCP server to create a new site
and discovering it cannot. The real gap is not a missing tool; it is a missing
tier above the site.

### Terminology already in use

LumiBase already uses **"control plane"** for *site-scoped administration*:
`CONTROL_PLANE_PATHS` in `apps/cms/src/middleware/control-plane-access-guard.ts`
(`/api/v1/access`, `/api/v1/admin`, `/api/v1/roles`, …), the
`controlPlaneAdmin` grant in `EffectiveCapabilityService`, and "control-plane
skills" in the MCP route. That meaning is kept unchanged. This ADR introduces a
tier *above* it and names it the **organization plane** to avoid overloading
the word. Three tiers result:

| Tier | Scope | Who | Credential | Examples |
|------|-------|-----|------------|----------|
| **Instance plane** | one deployment | self-host operator | process env, setup token, `is_bootstrap` user | first-run setup, instance-wide lockout policy, enabling org sign-up |
| **Organization plane** (new) | one tenant account, N sites | org owner / admin / billing | Studio session with org membership, or **`lbo_…` organization key** | create/delete/transfer site, org members, billing, org-level defaults |
| **Site plane** (existing) | one site | site roles | Studio session with `user_sites` row, or **`lbk_…` site key** | control plane (`/admin`, `/roles`, …) + data plane (items, collections, flows) |

### What the industry converged on

Every large platform solved the same problem with the same shape, differing
only in names:

| Platform | Container | Resource | Lesson taken |
|----------|-----------|----------|--------------|
| AWS | Organization → OU → **Account** | IAM inside the account | Creating an account is an *Organizations* API, not an IAM permission inside any account. Service-control policies cap the whole tree. |
| GCP | Organization → Folder → **Project** | IAM inside the project | `resourcemanager.projects.create` is a permission *on the parent*; IAM is inherited downward. Service accounts live inside a project (≈ `lbk_`). |
| Azure | Entra tenant → Management group → **Subscription** | ARM RBAC | Identity plane and resource plane are separate; a Global Administrator must explicitly *elevate access* (audited) to touch resources. |
| Cloudflare | **Account** → Zone | zone roles | Closest analogue (Zone ≈ Site). API tokens are typed by scope (account vs zone) and carry an explicit permission list. |
| Supabase | Organization → **Project** | anon / service keys | Two credential *kinds*: a Personal Access Token for the Management API (`create_project`, `list_organizations`) and per-project keys for data. Its MCP server runs on the PAT with `--read-only` and `--project-ref` to narrow it. |
| Kubernetes | Cluster | **Namespace** | `ClusterRole` vs `Role`; creating a namespace is a cluster-scoped verb. The cleanest semantic model. |

The common pattern, which this ADR adopts: (1) a container tier above the
resource; (2) the permission to create a resource lives on its *parent*;
(3) credentials are **typed by scope**, not ranked by power — a resource-scoped
credential can never call the container tier, however privileged it is inside
its resource; (4) the operator of the whole installation is a third, separate
tier.

## Decision

### 1. Add an `organizations` tier; a site belongs to exactly one organization

```
organizations                     ← lumibase_organizations
  id (nanoid), slug (unique), name, settings jsonb, created_at, updated_at
organization_members              ← lumibase_organization_members
  (user_id, organization_id) PK, role: owner | admin | billing | member
sites.organization_id             ← NEW, FK → organizations.id, NOT NULL after backfill
api_keys.scope                    ← NEW, 'site' | 'organization' (default 'site')
api_keys.organization_id          ← NEW, FK, set iff scope = 'organization'
api_keys.site_id                  ← becomes nullable (null iff scope = 'organization')
```

- IDs follow Strict Rule #1 (`nanoid()`); table names follow ADR-010.
- `organization_members.role` is a closed enum, not a row in `roles`. The site
  `roles`/`policies` DSL (ADR-008) models *what you can do to content*; the
  organization tier has a small fixed vocabulary and does not need the DSL.
  `owner` is the only role that can delete the organization or transfer a
  site out; at least one `owner` must always exist (same invariant style as
  `users_is_bootstrap_unique`).
- **Backfill:** every existing site is attached to a *personal organization*
  created for the bootstrap user (`slug = 'default'`, name from the
  `__default__` site). This is the Vercel "personal team" / GitHub personal
  account pattern: self-hosted single-tenant installs never see an
  organization unless they create a second one.

### 2. Organization-plane authorization is a separate check, not a bigger role

A fixed action vocabulary is evaluated against `organization_members.role`:

| Action | owner | admin | billing | member |
|--------|:-----:|:-----:|:-------:|:------:|
| `org:read` | ✓ | ✓ | ✓ | ✓ |
| `org:sites:create` | ✓ | ✓ | | |
| `org:sites:delete`, `org:sites:transfer` | ✓ | | | |
| `org:members:manage` | ✓ | ✓ | | |
| `org:keys:manage` (organization keys) | ✓ | ✓ | | |
| `org:billing:manage` | ✓ | | ✓ | |
| `org:settings:write` | ✓ | ✓ | | |
| `org:delete` | ✓ | | | |

**Inheritance into the site plane (GCP/Cloudflare model):** an organization
`owner` or `admin` is treated as a site `administrator` on every site of the
organization — `hasSiteAdminAccess` consults `organization_members` after
`user_sites`. Rationale: it prevents lockout (an owner can always recover a
site whose last admin left) and matches operator expectations. Every such
access is recorded in `audit_log` with `via: 'organization'` so provenance is
preserved. `billing` and `member` inherit nothing; they need a `user_sites`
row like anyone else.

**No upward inheritance, ever.** A site `administrator`, a site `lbk_` key,
and the `controlPlaneAdmin` grant give zero organization-plane rights. The
existing `CONTROL_PLANE_FORBIDDEN` posture stays exactly as it is for the
site tier; the organization tier gets its own `ORGANIZATION_FORBIDDEN` code.

### 3. Credentials are typed by scope; the prefix says which

| Credential | Prefix | Carries | Can call |
|------------|--------|---------|----------|
| Site key (existing) | `lbk_` | `site_id` | site plane only |
| Publishable site key (existing) | `lbk_pub_` | `site_id` | public data plane only |
| **Organization key (new)** | **`lbo_`** | `organization_id` | organization plane; **plus** any site of that organization as if it were an `administrator` there, narrowed by an optional *site pin* |
| Studio session (existing) | JWT `aud: studio` | user | both planes according to memberships |

A distinct prefix keeps secret scanners and audit queries unambiguous, the
same reason `lbk_pub_` exists (`apps/cms/src/services/api-key-publishable.ts`).
The organization key is minted and rotated through the organization plane
(`/api/v1/orgs/:orgId/keys`), never through `/api/v1/api-keys`, so a site admin
cannot mint one. `EffectiveCapabilityService` gains a third caller class
`organization_api_key`; resolving it with an `X-Lumi-Site` header checks that
the site belongs to the key's organization and then grants `administrator`
capabilities on that site.

### 4. Routing: the organization plane does not require `X-Lumi-Site`

```
GET    /api/v1/orgs                          list organizations the principal belongs to
POST   /api/v1/orgs                          create (instance plane decides who may: §6)
GET    /api/v1/orgs/:orgId
PATCH  /api/v1/orgs/:orgId
DELETE /api/v1/orgs/:orgId                   owner only, destructive, HITL for agents
GET    /api/v1/orgs/:orgId/sites
POST   /api/v1/orgs/:orgId/sites             replaces POST /api/v1/admin/sites
DELETE /api/v1/orgs/:orgId/sites/:siteId     replaces DELETE /api/v1/admin/sites/:id
POST   /api/v1/orgs/:orgId/sites/:siteId/transfer
GET|POST|PATCH|DELETE /api/v1/orgs/:orgId/members[/:userId]
GET|POST|DELETE       /api/v1/orgs/:orgId/keys[/:keyId]
```

- The tenant middleware (`apps/cms/src/middleware/tenant.ts`) exempts
  `/api/v1/orgs` from the `X-Lumi-Site` requirement; RLS request scope
  (`rls-request-scope` spec) is set to the organization instead.
- `POST /api/v1/admin/sites` and `DELETE /api/v1/admin/sites/:id` are removed
  once the test runner is moved to the new routes with an organization key.
  Their interim containment (restrict delete to the caller's own site, gate
  create behind the bootstrap user) is a separate hotfix, not part of this
  ADR.
- Site creation runs the same provisioning the setup wizard runs for a site
  (`administrator`/`member` roles, official `lumibase-*` extensions via
  `reconcileOfficialExtensions`, negative-cache purge), so a site created from
  the organization plane is indistinguishable from one created at first run.

### 5. MCP: one server, tool set decided by the credential

The MCP server stays a single package. At start-up it inspects
`LUMIBASE_TOKEN`:

| Token | `LUMIBASE_SITE_ID` | Exposed tools |
|-------|--------------------|---------------|
| `lbk_` | required (as today) | current site tool set, unchanged |
| `lbo_` + site id | pins the key to one site | current site tool set **plus** `list_sites`, `get_organization` (read-only org tools) |
| `lbo_` without site id | — | organization tools (`list_sites`, `create_site`, `delete_site`, `transfer_site`, `list_org_members`, `invite_org_member`, `create_org_key`) **plus** site tools that take a `site` argument |

Rules:

- `LUMIBASE_READ_ONLY=true` hides every mutating tool regardless of token
  (Supabase `--read-only` pattern). Recommended default in the published
  configuration snippets.
- Organization-plane mutations are **destructive by definition** and route
  through `ai_approvals` (Strict Rule #4; ADR-003) when called by an agent
  principal, independently of the `confirm=true` convention used by site
  tools. They start at autonomy **L0/L1** (propose → human approves) and are
  not eligible for veto-window or autopilot promotion in this ADR.
- The per-site `contentOs.mcp` flag keeps gating site tools. An organization
  setting `contentOs.mcp.allowOrganizationTools` (default `false`) gates the
  organization tools; the instance operator can force it off with
  `LUMIBASE_MCP_ORG_TOOLS=off`.
- The governed harness (`packages/mcp-server/src/governed.ts`) is extended to
  carry `organizationId` so run audit and kill switch cover organization-plane
  calls.

### 6. Instance plane: who may create organizations

- Self-host (Docker): by default only the `is_bootstrap` user may create
  additional organizations; `LUMIBASE_ALLOW_ORG_SIGNUP=true` opens
  `POST /api/v1/orgs` to any `studio`-audience user. No new instance role is
  introduced; the bootstrap user *is* the instance operator, as today.
- Hosted (`lumibase.dev`): the same flag is on, and the sign-up flow creates
  the personal organization on first login. Billing lives on the organization,
  never on the site.
- Instance-wide settings keep living on the `__default__` site
  (`apps/cms/src/modules/setup/site-constants.ts`); this ADR does not move
  them. A later ADR may lift them to an `instance_settings` table.

## Consequences

**Positive**

- Site creation, deletion and ownership have a home. The "who may create a
  site" question is answered by data, not by a test-only route.
- A leaked `lbk_` key — even one with an admin policy — can never create or
  delete sites. Blast radius of the most common credential is unchanged by
  this ADR and becomes *provably* bounded to its site.
- The MCP server gains organization capabilities without any site-token user
  seeing a single new tool. Agents get the capability under HITL from day one.
- Mirrors the mental model operators already have from AWS/GCP/Cloudflare;
  Studio can show an organization switcher like every comparable product.
- Billing, quotas and org-level defaults (locales, branding templates,
  allowed extensions) get a natural owner, unblocking the hosted offering.

**Negative / trade-offs**

- Two new tables, three new columns, one backfill migration (hand-written,
  per project convention; numbering must be reconciled on merge).
- `api_keys.site_id` becomes nullable. Every reader of `api_keys` must handle
  `scope = 'organization'`; `EffectiveCapabilityService` and the key auth
  middleware are the choke points, but the audit is real work.
- Downward inheritance (org owner ⇒ site administrator) widens what an
  organization owner can read. Mitigated by audit provenance and by the fact
  that owners already hold the keys that could grant themselves access.
- Self-hosted single-tenant users gain a concept they do not need. Mitigated
  by the personal-organization backfill: Studio hides the organization UI
  while exactly one organization exists.

**Security notes (Reality Filter)**

- The scope typing (`lbk_` cannot call `/api/v1/orgs`) is enforceable in one
  place — the key auth middleware — and must be covered by a matrix test
  alongside `auth-middleware-matrix.test.ts`. Until that test exists the
  boundary is a design claim, not an observed control. [Inference]
- Removing `/api/v1/admin/sites` closes a cross-tenant hole that exists today
  independently of this ADR; the interim hotfix should land first.

## Alternatives considered

1. **A `super_admin` flag or role above `administrator`.** Rejected: it ranks
   power instead of typing scope, so a leaked key with that role is worse,
   not safer; it has no place to record *which* sites the holder owns; and
   every vendor surveyed moved away from it (Azure's "elevate access" is the
   audited escape hatch, not the model).
2. **A second MCP package (`@lumibase/mcp-admin`).** Rejected for now: it
   doubles release and docs surface, and the credential already carries the
   information needed to choose the tool set. Revisit if the organization
   tool set grows past ~15 tools.
3. **Treat `__default__` as the "root site" and hang others under it.**
   Rejected: it conflates instance settings with a tenant, keeps `sites`
   owner-less, and would make deleting the root site catastrophic.
4. **Model organization roles with the site Policy DSL (ADR-008).** Rejected:
   the organization vocabulary is eight fixed actions; the DSL's
   collection/field/row semantics do not apply, and a fixed enum is easier to
   reason about in a security review.

## References

- `apps/cms/src/routes/admin.ts` — `POST/DELETE /sites` (to be removed)
- `apps/cms/src/middleware/control-plane-access-guard.ts` — existing
  site-scoped "control plane" (unchanged)
- `apps/cms/src/services/effective-capability-service.ts` — caller classes
- `apps/cms/src/services/api-key-publishable.ts` — prefix precedent (`lbk_pub_`)
- `packages/database/src/schema/{core,access}.ts` — `sites`, `users`, `api_keys`
- `packages/mcp-server/src/{client,governed}.ts` — token/site configuration
- `docs/en/security/user-management.md` §7 — prior MCP exposure assessment
- ADR-003 (HITL), ADR-008 (Policy DSL), ADR-010 (table prefix), ADR-011 (realms)
- Spec: `.kiro/specs/organizations/`
