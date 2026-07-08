---
version: 1
lastUpdated: 2026-06-23T13:05:48.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: ad255fa4351bf7f9
mtEngine: claude
syncStatus: machine-translated
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
User ──┬─► UserPolicy (direct attach, override)
       └─► UserSite (role per site)
Role ──► RolePolicy (priority) ──► Policy ──► Permission[] per (collection, action)
```

- **Role**: a fixed set assigned to a user (per site).
- **Policy**: a reusable unit, attachable to multiple roles/users, with a priority order (lower `priority` = runs first, higher ones override later).
- **Permission**: a specific `(collection, action)` rule with `permissions`, `validation`, `presets`, `fields`.

> Design note 2026-06-03: Directus v11 moved `admin_access`, `app_access`, `enforce_tfa`, `ip_access` off the role and onto the policy. LumiBase still has `roles.adminAccess/appAccess`; treat this as a compatibility layer and migrate to policy flags so the role is only a grouping. For the detailed strategy see [Migrating role flags to policy flags](./role-policy-flag-migration.md).

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

## 7. API

- `GET /permissions/me` — returns the matrix `{collection: { create, read, update, delete, share, fields, presets }}` so Studio can render the UI (hide buttons, disable fields).
- `POST /permissions/check` — debug: input action+payload, output allow/deny + reason trace.

## 8. Studio UI

- The **Access Control** module:
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
