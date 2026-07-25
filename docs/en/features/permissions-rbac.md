---
version: 3
lastUpdated: 2026-07-25T07:47:22.511Z
sourceLang: vi
translatedFrom: vi
sourceHash: 2a8277f7ae1ace80
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T07:56:30.140Z
codeVerifiedHash: 2a8277f7ae1ace80
codeVerifiedClaims: 22
---

# Permissions, Roles & Policies

> Goal: the **most powerful** permission system among OSS headless CMSs. Supports field-level, row-level, time-bound, IP-bound, attribute-based, and composable policies.
>
> See also the detailed investigation/blueprint: [permission-builder-directus-investigation.md](./permission-builder-directus-investigation.md).
>
> The current audit of the implementation: [permission-service-compose-audit.md](./permission-service-compose-audit.md).
>
> Migrating role flags to policy flags: [role-policy-flag-migration.md](./role-policy-flag-migration.md).

## 1. Model

```
Realm (staff / subscriber / public / integration)   ← authentication boundary
  └─ Site (tenant; every access table is site_id-scoped)
       └─ User ──┬─► UserPolicy (direct attach, override)
                 └─► UserSite (role per site)
          Role ──► RolePolicy (priority) ──► Policy ──► Permission[] per (collection, action)
                                                          └─ fields / row rule / validation / presets
```

- **Realm**: which authentication boundary the principal came through. Staff
  and subscribers are separated by role + token audience (ADR-011); `public` is
  the anonymous realm (§1.1); integrations authenticate with an API key.
- **Role**: a fixed set assigned to a user (per site).
- **Policy**: a reusable unit, attachable to multiple roles/users, with a priority order (lower `priority` = runs first, higher ones override later).
- **Permission**: a specific `(collection, action)` rule with `permissions`, `validation`, `presets`, `fields`.

> Design note 2026-06-03: Directus v11 moved `admin_access`, `app_access`, `enforce_tfa`, `ip_access` off the role and onto the policy. LumiBase still has `roles.adminAccess/appAccess`; treat this as a compatibility layer and migrate to policy flags so the role is only a grouping. For the detailed strategy see [Migrating role flags to policy flags](./role-policy-flag-migration.md).

> `roles.parentId` exists in the schema but the permission evaluator does not
> read it — there is **no role inheritance**. A child role does not receive its
> parent's policies. Treat the column as grouping metadata until an evaluator
> change lands.

### 1.1. Non-staff realms: `public` and `subscriber`

Two least-privilege realms exist for people who are not staff. Both start
**empty** — they grant nothing until an operator says so.

| | `public` | `subscriber` |
|---|---|---|
| Who | anyone, no credential | registered + signed in on your frontend |
| Exists by default | ❌ opt-in per site | ✅ on first registration |
| Grantable actions | `read` only | `read`/`create`/`update`/`delete` |
| Row scopes | published-only | published-only, own-rows-only |
| Studio | never | never (`appAccess: false`) |

**Anonymous resolution.** With public access enabled, a credential-less request
resolves to the site's `public` role rather than skipping authorization — so row
filters and field masks stay in force. Two conditions gate it, both
load-bearing:

1. the site has a `public` role (creating it *is* enabling the realm), and
2. the request is a `GET`/`HEAD` on an allow-listed content prefix
   (`/items`, `/search`, `/media`, `/files`).

`/graphql` is excluded: operations arrive over POST, so the read-method rule
cannot cover it. Opening it needs read-only operation validation alongside the
existing cost limiter.

**Why `public` is read-only.** A generic write grant would hand every
unauthenticated caller an unmetered write path. A public write surface (contact
form, anonymous comment) needs its own throttle/captcha story behind a
purpose-built endpoint, not a permission row.

**Hard guards.** `adminAccess`/`appAccess` on the `public` role and policy are
pinned off by check constraints (migration `0012`) — an elevation flag there
would be an unauthenticated admin bypass. Route guards refuse the same edits
with a readable 4xx. Policies attached to the public role by hand are screened
at the attach point, since a table check cannot see across the `role_policies`
join. The generic policy-permission editor is screened for the read-only limit
too, because a grant added there lands in the same compiled bundle.

**Caching.** Anonymous principals share one compiled bundle per site (cache key
`role:{id}`), and the role lookup itself is cached with negative results
included — the anonymous path is the highest-volume one.

**API** (`/api/v1/access/grants`, site-admin only):

```
GET    /access/grants                             # collections + both realms' limits & grants
POST   /access/grants/public/enable               # provision the realm
POST   /access/grants/public/disable              # tear it down (removes all its grants)
POST   /access/grants/:realm                      # { collection, action?, publishedOnly?, ownOnly?, fields? }
DELETE /access/grants/:realm/:collection/:action
```

`publishedOnly` defaults **on** for `read` and **off** for writes. Both scopes
may be combined, composing to an `_and`. Studio surfaces all of this at
**Access control → Public & subscribers**.

`POST /users/subscriber-access` keeps its original published-only-read contract
when `action` is omitted.

## 2. Permission record (JSON DSL)

```json
{
  "collection": "posts",
  "action": "update",
  "fields": ["title", "body", "status"],
  "permissions": {
    "_and": [
      { "user_created": { "_eq": "$CURRENT_USER" } },
      { "status": { "_neq": "archived" } },
      { "_or": [
        { "site_id": { "_eq": "$CURRENT_SITE" } },
        { "_role": { "_in": ["admin"] } }
      ]}
    ]
  },
  "validation": {
    "status": { "_in": ["draft", "review", "published"] }
  },
  "presets": { "updated_by": "$CURRENT_USER" }
}
```

### Supported operators
- Logic: `_and`, `_or`, `_not`.
- Comparison: `_eq`, `_neq`, `_lt`, `_lte`, `_gt`, `_gte`, `_in`, `_nin`, `_contains`, `_starts_with`, `_ends_with`, `_between`.
- Date: `_dynamic`, e.g. `$NOW(-7 days)`.
- Magic: `$CURRENT_USER`, `$CURRENT_ROLE`, `$CURRENT_SITE`, `$NOW`, `$IP`, `$HEADERS.x-foo`.
- Extended magic: `$CURRENT_ROLES`, `$CURRENT_POLICIES`, `$CURRENT_API_KEY`, `$CURRENT_USER.email`, `$CURRENT_USER.preferences.locale`, `$NOW(+2 hours)`, `$NOW(-7 days)`.
- Unknown magic vars fail closed; a rule using an unsupported variable will not match.

## 3. Field-level

- `fields: ["*"]` = all.
- `fields: ["title","body"]` whitelist.
- `fields: ["-secret"]` blacklist (prefix `-`).
- For `read`: returns a **field mask**; the server does **not** serialize forbidden fields.
- For `update/create`: the server rejects the request if the payload contains a disallowed field.

## 4. Row-level

- Evaluate the `permissions` AST → SQL where (Drizzle) for `read/list`, or post-fetch check for `update/delete` (safe updates still need a WHERE).
- Cache the "compiled rule" by `(policyId, action)` in KV.

## 5. Time-bound & IP-bound

- A policy has optional fields at the `policy` level:
```json
{ "activeWindow": { "from": "2025-01-01T00:00:00Z", "to": "2025-12-31T23:59:59Z" }, "allowIps": ["10.0.0.0/8"], "denyIps": [] }
```
- Evaluated before the rules; reject early if outside the window.
- Should support IPv4, IPv6, CIDR, and IP ranges. `ipDeny` beats `ipAllow`.
- If a policy fails the IP/time check, remove that policy from the chain rather than denying the whole principal.

## 5.1. App access, admin access, enforce TFA

- `adminAccess=true` bypasses all permission checks; an admin policy does not need seeded permission rows.
- `appAccess=true` lets a principal use Studio, which is not the same as API access. An API-only user can still call the API if they have permission rows but is blocked from Studio.
- The Studio client must send `X-Lumi-Client: studio`; the backend uses the effective `appAccess` to gate these requests.
- An API key may never use Studio even if the policy grants app access.
- `enforceTfa=true` requires the user to have enrolled and the session to have passed 2FA before a Studio request can be used.
- Do not set these flags on the user; the user only holds identity/status/TFA enrollment.

## 6. Composition & precedence

- Merging multiple permissions with the same `(collection, action)`:
  - `fields`: union (special case: if a blacklist appears, apply it after the union).
  - `permissions` rule: joined with `_or` (additive grants).
  - `validation`/`presets`: merged with `_and` / object spread by `priority`.
- A role with `adminAccess=true` → bypass.

New recommendation: do not silently OR/union when attaching policies via Studio. The backend needs a conflict checker:

- Block if one policy grants `{}` but another restricts the same collection/action.
- Block if one policy grants `["*"]` but another whitelists fields.
- Block if `validation` or `presets` cover the same field with different values.
- Warn if it only widens fields or OR-adds a conditional rule; the admin must confirm and it is audited.
- The DB should have a unique `(policyId, collection, action)` so a policy cannot have multiple permission rows with the same key.

### 6.1. Publishable API keys

An API key can be minted as **publishable** (`lbk_pub_…`) for embedding in a
browser bundle or mobile app, as opposed to a secret `lbk_…` key held
server-side.

A publishable key is **not a secret**. Anything shipped to a client is
extractable, so the only correct posture is to scope it exactly as if it were
already public. What it buys over serving the same data fully anonymously:
per-key rate-limit quota (the limiter already keys on `k:{apiKeyId}`),
revocation and rotation without redeploying, audit attribution, and per-key
scope (staging vs production). What it does **not** buy: confidentiality. If
leaking it would hurt, keep a secret key server-side and proxy through your own
backend.

- The `lbk_pub_` prefix is the source of truth — derived from the token, so it
  cannot drift from a metadata flag, and a secret scanner can alert on leaked
  `lbk_` keys while staying quiet about publishable ones. Rotation preserves it.
- **Origin allowlist** — `metadata.allowedOrigins`, editable live via
  `PATCH /api-keys/:id/allowed-origins`. Empty = no constraint.
- Enforcement is scoped to publishable keys (a secret key is used
  server-to-server, where no `Origin` exists). A non-matching `Origin`/`Referer`
  is `403 ORIGIN_NOT_ALLOWED` and audited; an **absent** origin is allowed.
  This is deliberate: the control stops another *website* from using your key in
  a browser, which is the real failure mode. It is not a defence against `curl`,
  which can set any `Origin` — rejecting absent-origin requests would only break
  legitimate native/server callers without adding security.
- A policy with `adminAccess`/`appAccess` cannot be attached to a publishable
  key (`PUBLISHABLE_KEY_ELEVATION`).

## 7. API

- `GET /permissions/me` — returns the matrix `{collection: { create, read, update, delete, share, fields, presets }}` so Studio can render the UI (hide buttons, disable fields).
- `POST /permissions/check` — debug: input action+payload, output allow/deny + reason trace.

## 8. Studio UI

- The **Access Control** module:
  - Public & subscribers page: enable/disable anonymous access and check off
    `collection × action` grants per non-staff realm. Limits are read from
    `GET /access/grants` rather than hard-coded client-side, so a server-side
    tightening cannot be contradicted by a stale client assumption. A togglable
    realm that is off renders read-only, so a first checkbox click cannot
    quietly switch anonymous access on.
  - Roles page: list + create + assign users + attach policies.
  - Policies page: list + JSON editor + GUI builder (a form per row).
  - Permission Matrix page: a `collection × action` grid; click a cell to open the detail (fields, rules, presets, validation).
  - Test sandbox page: simulate a user → see the field mask, allowed rows.
  - API Keys page: create a key, rotate/revoke, attach roles/policies, preview effective permissions.
  - Role/Key attach flow: preview conflicts before saving.

## 8.1. Import / Export

- `GET /access/export` exports roles, policies, permission rows, role-policy bindings, and API key metadata as versioned JSON.
- `POST /access/import?dryRun=true` returns a diff/conflict and does not write the DB.
- A real import runs in a transaction, uses stable keys, is fully audited, and never imports/exports a plaintext API key.

## 9. Caching & invalidation

- KV: `perm:{site}:{role}` (compiled). TTL 5 minutes + invalidate when a policy/role changes.
- WebSocket broadcasts a `permissions.changed` event → the Studio client reloads `/permissions/me`.

## 10. Audit

- Every denial is logged to `activity` with the action `permission_denied` + the reason (rule path).

## 11. Tasks: Phase MVP-C, C2.

## 12. Compliance & user rights

This RBAC/audit machinery underpins several regulatory obligations (access control,
provenance, breach detection). For how it maps to user data-subject rights and where
gaps remain, see [Compliance — gap analysis](../compliance/gap-analysis.md).
