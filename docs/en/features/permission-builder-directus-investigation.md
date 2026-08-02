---
version: 1
lastUpdated: 2026-07-29T02:34:50.049Z
sourceLang: vi
translatedFrom: vi
sourceHash: e9a6e1734723c15d
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-29T02:34:50.049Z
codeVerifiedHash: e9a6e1734723c15d
codeVerifiedClaims: 8
---

# Permission Builder & RBAC: Directus investigation and a design for LumiBase

> Investigation date: 2026-06-03. This document collects what came out of reading a sample Directus database, cross-checks it against the official Directus documentation, and proposes a Role / Policy / Permission / API Key design for LumiBase.

> **This is a point-in-time snapshot, not a description of the current state.** The Directus figures and every "LumiBase currently has" statement were accurate on 2026-06-03 and have since aged. Re-checked on 2026-07-29:
>
> - Most of **Phases 1, 3 and 4** in §13 have shipped: the unique index `permissions_policy_collection_action_unique`, `POST /access/conflicts/check`, `GET /access/export` + `POST /access/import`, and the `api_keys` / `api_key_roles` / `api_key_policies` tables. The `user_roles` and `shares` tables also exist now.
> - The system-collections list in §9 is now only a **subset**: 44 names against 103 tables in the current Drizzle schema. Every name in the list is still a real table — none are invented — but 59 are missing, including the `api_keys`, `user_roles` and `shares` tables this very document proposes adding.
>
> For how the permission system **currently** behaves, read [permissions-rbac.md](./permissions-rbac.md). Keep this document as the investigation record and the reasoning behind the design.

## 1. Goals

LumiBase needs an Access Control system comparable to Directus, but tighter at the points where Directus is easy to get wrong:

- A role groups users or service accounts into a single permission context.
- A policy is the reusable unit, attachable to a role, a user, or an API key.
- A permission is a right per `collection + action`, with field-level control, row-level rules, validation, and presets.
- Studio must detect conflicts when a role or API key receives several policies covering the same collection/action.
- JSON import/export, so permissions can be synced between dev/staging/prod.
- Security guards: mandatory 2FA, IP allowlists, safe static/API keys, audit, and dry-run.

Primary sources:

- The sample Directus DB, queried directly with Postgres metadata and aggregate queries.
- [Directus Access Control guide](https://directus.io/docs/guides/auth/access-control)
- [Directus Policies API](https://directus.io/docs/api/policies)
- [Directus Permissions API](https://directus.io/docs/api/permissions)
- [Directus Roles API](https://directus.io/docs/api/roles)
- [Directus Filter Rules / Dynamic Variables](https://docs.directus.io/reference/filter-rules)
- [Directus Authentication API](https://directus.io/docs/api/authentication)

## 1.1. LumiBase vs Directus comparison table

This is the **comparison ledger** for Permission Builder/RBAC. Whenever a new capability is added that Directus has no first-class equivalent for, a row must be added or updated here, to serve later product/marketing documentation.

Legend:

- **Parity**: LumiBase should support the Directus equivalent.
- **Improve**: LumiBase supports the same use case but fails closed more often, or operates better.
- **New**: a capability Directus has no first-class support for; LumiBase should ship it as a competitive advantage.

| Area | Directus | LumiBase target | Design status |
|---|---|---|---|
| Role | A user has one primary role; roles may have a parent/nested role. | A user has a primary role plus additional roles via `user_roles`; a role is only long-lived grouping. | Parity + Improve |
| Policy | A policy attaches to a role or a user via `directus_access`. | A policy attaches to roles, users, and API keys; the policy is the primary import/export unit. | Improve |
| Access flags | `admin_access`, `app_access`, `enforce_tfa`, `ip_access` live on the policy. | Keep role flags for short-term compatibility but migrate to policy flags: `adminAccess`, `appAccess`, `enforceTfa`, `ipAllow`, `ipDeny`, `validFrom`, `validUntil`. | Parity + Improve |
| Permission granularity | Per `collection + action`, with row rules, a field list, validation, and presets. | The same, plus a source trace in the effective permission and a conflict preview before attaching. | Improve |
| The `share` action | An action/share link carries a role that reads the data. | A dedicated share role, validity window, password hash, max uses, revoke, field/row masking through the share role. | Parity + Improve |
| Field rules | `fields` may be a whitelist or `*`. | Explicit whitelist/blacklist; the conflict checker blocks `*` vs whitelist, and needs hardening to preserve exclusions when merging. | Improve |
| Dynamic variables | Supports `$CURRENT_USER`, `$CURRENT_ROLE`, `$CURRENT_ROLES`, `$CURRENT_POLICIES`, `$NOW`, etc. | The same variables, plus `$CURRENT_API_KEY`, nested `$CURRENT_USER.*`, `$NOW(+/- duration)`, and fail-closed handling of unknown magic vars. | Parity + Improve |
| Multiple policies on the same collection/action | Additive merge; users have reported cases where stacked policies produced wrong or over-broad permissions. | Backend/UI conflict checker: blocking for unconditional-vs-restricted, `*` vs whitelist, preset/validation conflicts; warnings require an override and are audited. | Improve |
| Unique permission row within a policy | The sample Directus DB has duplicate permission rows for the same `policy + collection + action`. | Unique `(policy_id, collection, action)`; the migration detects duplicates before applying. | Improve |
| IP access | Directus uses `ip_access` on the policy. | A JSON array `ipAllow`/`ipDeny`, supporting IPv4/IPv6/CIDR, where `ipDeny` beats `ipAllow` and a policy that does not pass is dropped from the chain. | Improve |
| App access | The policy has `app_access`, controlling entry to the Directus App. | Enforce app access from the effective active policies; an API key is always barred from Studio. | Parity + Improve |
| TFA enforcement | The policy has `enforce_tfa`. | A user attached to a TFA role/policy must enrol in and pass TFA; an API key attached to a TFA policy raises a conflict/warning. | Parity + Improve |
| Static token / API key | A Directus static token lives on the user; the token inherits the user's role. | An API key is its own principal, can attach roles/policies directly, has a token hash/prefix, rotate/revoke/expire/last_used, and is never exported in plaintext. | **New / Improve** |
| Import/export of access config | No first-class permission-builder manifest for syncing roles/policies/API-key metadata between environments by stable key. | `lumibase.access@v1`, with export/import/dry-run/diff/conflict-check, the modes `merge`, `replace-managed`, `replace-all`, and a CLI for CI/CD. | **New** |
| Conflict dry-run | No first-class endpoint for policy-attach diff/conflict. | `POST /access/conflicts/check`, used by the UI, the API, and import dry-run. | **New** |
| Effective permission trace | The Directus App shows permissions but does not focus on a source trace for each effective cell. | `/permissions/me` returns the source policies; the Permission Matrix shows both the final permission and where it came from. | **New / Improve** |
| System collections | Directus has system collections and matching permissions. | Seed system permissions explicitly, group the sensitive/admin-only ones, and hide them from non-admins in the builder. | Parity + Improve |
| Extension sandbox | Directus sandboxed API extensions declare requested scopes; non-sandboxed extensions are a different trust boundary. | A capability grant is the upper bound inside the sandbox runtime, with grant/revoke audited. | Parity + Improve |
| Per-user/role extension access | Directus has no first-class policy for "role/user X may see/call extension Y"; app modules usually check for themselves or lean on the admin/permissions store. | First-class Extension Access Control: `extensions:read/execute/configure/install/enable/grant_capability/delete`, applied to the Studio loader, the module bar, endpoint dispatch, and operations. | **New** |
| Extension data permission | Directus services use `accountability`; dropping or nulling accountability can run as admin. | An extension operates on data with the actor's permissions by default; service-account mode must declare its own capability/policy and is audited. | Improve |
| Audit | Directus has a background activity/audit trail. | Audit is mandatory for access import, conflict override, API-key lifecycle, extension capability grants, service-account execution, and significant denials. | Improve |

## 2. What Directus stores in the database

The sample Directus instance has 26 `directus_*` tables:

```txt
directus_access
directus_activity
directus_collections
directus_comments
directus_dashboards
directus_extensions
directus_fields
directus_files
directus_flows
directus_folders
directus_migrations
directus_notifications
directus_operations
directus_panels
directus_permissions
directus_policies
directus_presets
directus_relations
directus_revisions
directus_roles
directus_sessions
directus_settings
directus_shares
directus_translations
directus_users
directus_versions
```

The tables that matter here:

| Table | Role | Important columns |
|---|---|---|
| `directus_roles` | Organisational grouping of users. Directus v11 no longer keeps `admin_access`/`app_access` on the role. | `id`, `name`, `icon`, `description`, `parent` |
| `directus_policies` | The unit of permission, attachable to a role or a user. | `id`, `name`, `icon`, `description`, `ip_access`, `enforce_tfa`, `admin_access`, `app_access` |
| `directus_access` | Junction for policy-to-role or policy-to-user. | `id`, `role`, `user`, `policy`, `sort` |
| `directus_permissions` | The rule per collection/action. | `id`, `collection`, `action`, `permissions`, `validation`, `presets`, `fields`, `policy` |
| `directus_users` | Login accounts and static tokens. | `id`, `email`, `password`, `tfa_secret`, `status`, `role`, `token` |
| `directus_shares` | Per-item share links. | `collection`, `item`, `role`, `password`, `date_start`, `date_end`, `times_used`, `max_uses` |

The main relationships:

- `directus_users.role -> directus_roles.id`: each user has one direct role.
- `directus_roles.parent -> directus_roles.id`: Directus supports nested roles; the sample DB does not use child roles.
- `directus_access.policy -> directus_policies.id`.
- `directus_access.role -> directus_roles.id`, nullable.
- `directus_access.user -> directus_users.id`, nullable.
- `directus_permissions.policy -> directus_policies.id`.
- `directus_shares.role -> directus_roles.id`: a share link inherits the read permissions of the chosen role.

The key point: Directus v11 moved `admin_access`, `app_access`, `enforce_tfa`, and `ip_access` from the role onto the policy. The Directus breaking-changes documentation also describes a user's permissions as the aggregate of directly-attached policies, policies attached via a role, and policies from nested roles.

## 3. Numbers from the sample Directus DB

| Metric | Result |
|---|---:|
| `directus_roles` | 24 |
| `directus_policies` | 33 |
| `directus_access` | 50 |
| `directus_permissions` | 2414 |
| `directus_users` | 57 |
| Users with a direct role | 51 |
| Users with a static token | 9 |
| Users with a `tfa_secret` | 11 |
| Policies with `admin_access=true` | 2 |
| Policies with `app_access=true` | 25 |
| Policies with `enforce_tfa=true` | 0 |
| Policies with `ip_access` | 0 |

Action distribution across `directus_permissions`:

| Action | Rows |
|---|---:|
| `create` | 491 |
| `read` | 947 |
| `update` | 499 |
| `delete` | 348 |
| `share` | 129 |

Field-level use in the Directus DB:

- `fields='*'`: 2346 rows.
- Specific `fields`: 64 rows.
- `fields` is stored as CSV text in the sample DB, e.g. `id,first_name,last_name,email,...`.
- `permissions` carrying a row-level filter: 432 rows.
- `validation` carrying a rule: 58 rows.
- `presets` carrying a default: 66 rows.

Examples of rules Directus is actually using:

```json
{ "user_created": { "_eq": "$CURRENT_USER" } }
```

```json
{
  "_or": [
    { "user": { "_eq": "$CURRENT_USER" } },
    {
      "_and": [
        { "user": { "_null": true } },
        { "role": { "_eq": "$CURRENT_ROLE" } }
      ]
    },
    {
      "_and": [
        { "user": { "_null": true } },
        { "role": { "_null": true } }
      ]
    }
  ]
}
```

Directus supports these dynamic variables:

- `$CURRENT_USER`
- `$CURRENT_ROLE`
- `$CURRENT_ROLES`
- `$CURRENT_POLICIES`
- `$NOW`
- `$NOW(-1 year)`, `$NOW(+2 hours)`
- Inside permissions/validation/presets/conditional fields, Directus also allows nested user/role variables such as `$CURRENT_USER.avatar.filesize` or `$CURRENT_ROLE.name`.

## 4. What `share` means in Directus

Directus uses CRUDS rather than CRUD: `create`, `read`, `update`, `delete`, `share`.

`share` is not a direct right to read data. It is the right to create and manage a share link for an item. The link is stored in `directus_shares` with:

- `collection`
- `item`
- `role`
- `password`
- `date_start`
- `date_end`
- `times_used`
- `max_uses`

When an outsider opens a share link, Directus uses the role attached to the share to determine the read permissions for that item. So `share` has to be understood as the right to create a temporary access gateway — the data returned still passes through the share role's permissions.

Proposal for LumiBase:

- Keep the `share` action.
- Add a `shares` table when the feature is built: `site_id`, `collection`, `item_id`, `role_id`, `created_by`, `password_hash`, `valid_from`, `valid_until`, `max_uses`, `used_count`, `revoked_at`.
- The share role must be a dedicated role, never a real admin/editor role.
- The UI should only offer roles with `appAccess=false`, `adminAccess=false`, and minimal read permissions.

## 5. The important lessons from Directus

### 5.1. `app_access`/`admin_access`/`enforce_tfa`/`ip_access` belong on the policy, not on the user or the role

Directus v11 puts these flags on the policy rather than the role. That is the better direction for LumiBase too:

- A policy is deployable and import/exportable.
- A role is only organisational grouping.
- An API key can receive the same policy as a user.
- A user should only hold identity state: `status`, `tfa`, profile, external id.
- Putting `adminAccess` on the user makes permissions hard to audit, hard to sync between environments, and easy to turn into an exception invisible in the Permission Builder.

LumiBase currently has `roles.adminAccess` and `roles.appAccess`. These should be migrated gradually:

1. Add explicit flags to `policies`: `adminAccess`, `appAccess`, `enforceTfa`, `ipAllow`, `ipDeny`, `validFrom`, `validUntil`.
2. Keep `roles.adminAccess`/`appAccess` temporarily for old-API compatibility, but treat them as deprecated.
3. When compiling permissions, take effective access from the active policies first; role flags are only a fallback during a migration window. For the detailed strategy see [Migrating role flags to policy flags](./role-policy-flag-migration.md).
4. Studio's Role Detail should no longer edit `adminAccess`/`appAccess` on the role directly; it should create or attach the corresponding policy instead.

### 5.2. Admin access is a bypass, not a set of permission rows

In the sample DB, the policy with `admin_access=true` has 0 permission rows. That is a pattern worth keeping:

- `adminAccess=true`: bypass every permission check within the site/project.
- No need to seed hundreds of permission rows for an admin.
- The UI must lock the permission editor when a policy is an admin bypass, to avoid the misreading.

### 5.3. Directus merges multiple policies additively

The Directus documentation states that multiple policies on the same collection/action accumulate:

- Fields: union.
- Item rules: OR.
- IP access: any policy that does not pass the IP check is dropped from the chain.

This is powerful but dangerous: adding one policy with a broader rule can open up data silently. The sample DB also has a great deal of overlap:

- Duplicate permission rows for the same `policy + collection + action`.
- Roles receiving several policies for the same `collection + action`.
- One sample role receiving 4 policies all granting `directus_translations/read`.

Users have reported Directus cases where stacking policies on the same collection with different permissions made permissions behave wrongly, sometimes opening access far too wide. LumiBase should not reproduce that experience.

## 6. Proposed design for LumiBase

### 6.1. Conceptual model

```txt
Principal
  ├─ User
  ├─ API Key
  └─ Public/Anonymous

User ──► UserRole[] ──► Role ──► RolePolicy[] ──► Policy ──► Permission[]
API Key ──────────────► ApiKeyRole[] ─┘
User ──► UserPolicy[] ───────────────────────────────┘
API Key ──► ApiKeyPolicy[] ───────────────────────────┘
Public ──► Public Policy
```

LumiBase currently has `user_sites.role_id`, i.e. one primary role per site. There are two directions:

- A Directus-compatible MVP: keep one direct role via `user_sites.role_id`, with policies attached to the role or directly to the user.
- A LumiBase upgrade: add `user_roles(user_id, site_id, role_id)` so a user can hold several roles. `user_sites.role_id` is kept as the primary/display role during the transition.

Because the requirement is for API keys to attach directly to roles, the API key should be designed for multiple roles from the outset.

### 6.2. Proposed schema

Existing tables:

- `roles`
- `policies`
- `role_policies`
- `user_policies`
- `permissions`
- `users`
- `user_sites`

To add or adjust:

```txt
roles
  id
  site_id
  name
  icon
  description
  parent_id nullable
  system_key nullable
  created_at

policies
  id
  site_id
  key stable unique per site
  name
  icon
  description
  admin_access boolean default false
  app_access boolean default false
  enforce_tfa boolean default false
  ip_allow jsonb default []
  ip_deny jsonb default []
  valid_from timestamp nullable
  valid_until timestamp nullable
  rules jsonb default {}
  created_at
  updated_at

permissions
  id
  site_id
  policy_id
  collection
  action
  permissions jsonb default {}
  validation jsonb default {}
  presets jsonb default {}
  fields jsonb default ["*"]
  unique(policy_id, collection, action)

user_roles
  user_id
  site_id
  role_id
  primary key(user_id, site_id, role_id)

api_keys
  id
  site_id
  name
  key_prefix
  key_hash
  created_by
  expires_at
  revoked_at
  last_used_at
  metadata jsonb
  created_at

api_key_roles
  api_key_id
  role_id
  primary key(api_key_id, role_id)

api_key_policies
  api_key_id
  policy_id
  priority
  primary key(api_key_id, policy_id)
```

Notes:

- Never export or import a plaintext API key.
- Show the plaintext key exactly once, at creation.
- `key_hash` should use SHA-256 or HMAC-SHA-256 with a server secret. For better resistance to offline brute force, token entropy of >= 256 bits with SHA-256 is pragmatically sufficient.
- `key_prefix` exists for fast lookup and logging, e.g. `lumi_live_xxxxx`.
- An API-key principal should have its own magic var: `$CURRENT_API_KEY`.

### 6.3. Policy flags and how they are evaluated

Evaluation order:

1. Resolve the principal: user, API key, or anonymous.
2. Load candidate policies:
   - Policies from roles.
   - Policies attached directly to the principal.
   - The public policy, if anonymous.
3. Filter policies by time and IP:
   - If the IP is in `ip_deny`: drop the policy.
   - If `ip_allow` is non-empty and the IP does not match: drop the policy.
   - If outside `valid_from`/`valid_until`: drop the policy.
4. If no active policy remains for a Studio/API route: deny.
5. If any active policy has `enforce_tfa=true`:
   - The user must have TFA enrolled, and the request/session must have passed TFA.
   - API keys do not use TFA; for an API key, a policy with `enforce_tfa=true` should be treated as incompatible, or ignored-by-design with a warning at attach time.
6. If any active policy has `admin_access=true`: admin bypass.
7. If the route is Studio: require at least one active policy with `app_access=true`.
8. Compose the permission rows per collection/action.

### 6.4. Mandatory 2FA

The requirement to "enable mandatory 2FA for users attached to roles" should become an explicit rule:

- If a role attaches a policy with `enforce_tfa=true`, every user receiving that role must enrol in TFA before entering Studio or using a login token.
- To go beyond Directus, add a site-level setting `security.requireTfaForRoleMembers=true`: every user with at least one non-public role must have TFA.
- When an admin assigns a role to a user who has not enrolled in TFA, the UI allows the assignment but the user's state becomes `mfa_required`; the next login forces TFA setup.
- Audit events:
  - `role_assigned_requires_tfa`
  - `mfa_enrollment_required`
  - `mfa_enrolled`
  - `mfa_bypass_denied`

### 6.5. IP allowlist

Directus uses a CSV `ip_access` on the policy. LumiBase should use a JSON array:

```json
{
  "ipAllow": ["203.0.113.10", "10.0.0.0/8", "2001:db8::/32"],
  "ipDeny": ["198.51.100.0/24"]
}
```

Best practice:

- Support IPv4, IPv6, and CIDR.
- Do not only match exact strings as the current code does; a CIDR parser is needed.
- `ipDeny` beats `ipAllow`.
- If a policy does not pass the IP check, drop that policy from evaluation rather than denying the whole principal. This matches Directus and allows "this policy only grants more while on the VPN".
- Studio must preview: "from the current IP, which policies are active/inactive".

## 7. Conflict detection for the Role Builder

### 7.1. The problem to avoid

If a role holds several policies for the same `collection + action`, the rules can accumulate into a broader permission than intended. For example:

```json
// Policy A
{ "collection": "posts", "action": "read", "permissions": { "status": { "_eq": "published" } } }

// Policy B
{ "collection": "posts", "action": "read", "permissions": {} }
```

Under an OR-merge, policy B turns the permission into reading every post. That may be mathematically correct but it is wrong about the admin's intent.

### 7.2. DB constraint

A unique index should be added:

```sql
unique(policy_id, collection, action)
```

A policy has at most one permission row per collection/action. When several rules are needed, use `_or`/`_and` within the same row.

### 7.3. Conflict classifier

When a policy is attached to a role/API key/user, the backend returns a diff:

```txt
compatible
  - Same collection/action but identical rule, fields, validation, and presets.
  - Fields are a subset/superset and the admin explicitly chose a merge mode.

warning
  - Fields differ but only widen field reads.
  - Row rules differ but there is no unconditional grant.
  - The policy is only active by IP/time, so the conflict is conditional.

blocking_conflict
  - One rule is unconditional (`{}` or `null`) while the other is restricted.
  - One permission has fields `["*"]` while the other is a whitelist.
  - `validation` on the same field but with a different operator/value.
  - `presets` on the same field but with a different value.
  - A policy with `admin_access=true` attached alongside a granular policy.
  - A policy with `enforce_tfa=true` attached to an API key.
```

### 7.4. UI requirements

Role Detail, when a new policy is selected:

- Call `POST /api/v1/access/conflicts/check`.
- Show a conflict table:
  - collection
  - action
  - existing policy
  - incoming policy
  - conflict type
  - the effective result if merged
- A blocking conflict prevents Save.
- A warning permits Save if the admin ticks "I understand this widens access"; this must be audited.
- The Permission Matrix has an "Effective View" mode so an admin can see the final permissions of a role or API key.

Proposed endpoint:

```txt
POST /api/v1/access/conflicts/check
{
  "target": { "type": "role", "id": "role_editor" },
  "addPolicies": ["policy_news_read"],
  "removePolicies": []
}
```

Response:

```json
{
  "data": {
    "ok": false,
    "conflicts": [
      {
        "severity": "blocking",
        "collection": "posts",
        "action": "read",
        "existingPolicy": "policy_posts_published",
        "incomingPolicy": "policy_posts_all",
        "reason": "UNCONDITIONAL_RULE_WIDENS_RESTRICTED_RULE"
      }
    ],
    "warnings": []
  }
}
```

## 8. The permission DSL for LumiBase

LumiBase already supports many operators and magic vars. It should be extended to sit closer to Directus:

```txt
Logic:
  _and, _or, _not

Compare:
  _eq, _neq, _lt, _lte, _gt, _gte, _in, _nin

Null/empty:
  _null, _nnull, _empty, _nempty

String:
  _contains, _icontains, _ncontains,
  _starts_with, _istarts_with,
  _ends_with, _iends_with

Range:
  _between, _nbetween

Validation-only:
  _regex

Relations:
  nested object paths, _some, _none
```

The magic vars that should exist:

```txt
$CURRENT_USER
$CURRENT_USER.email
$CURRENT_ROLE
$CURRENT_ROLE.name
$CURRENT_ROLES
$CURRENT_POLICIES
$CURRENT_SITE
$CURRENT_API_KEY
$NOW
$NOW(-7 days)
$IP
$HEADERS.x-foo
```

Fail-closed rules:

- Unknown operator: deny.
- Unknown magic var: resolve to null or deny — never treat it as a literal string match.
- Relation traversal must be depth-limited and compiled safely, to avoid query explosion.

## 9. System collections and seeding

Directus lets non-admins configure permissions on system collections through its "System Collections" section. LumiBase needs to seed policies for the equivalent system tables; without them Studio will be either too open or unusable.

The settled contract for seeding/UI/import-export lives in [system-collections-access.md](./system-collections-access.md). This section keeps the Directus investigation context and the original blueprint.

The system collections LumiBase currently has, per the Drizzle schema:

```txt
sites
users
user_sites
teams
team_members
notifications
roles
policies
role_policies
user_policies
permissions
scim_tokens
pages
collections
fields
relations
items
revisions
activity
flows
flow_runs
operations
materialized_collections
folders
files
presets
translations
settings
webhooks
extensions
translation_memory
glossary
system_state
audit_log
login_attempts
login_baselines
admin_backup_codes
ai_approvals
ai_conversations
ai_messages
ai_embeddings
cdc_pipelines
cdc_pipeline_health
cdc_deployments
```

Not all of these should appear in the Permission Builder by default. They should be grouped:

| Group | Collections | Seed policy |
|---|---|---|
| Identity | `users`, `user_sites`, `teams`, `team_members` | `studio_user_self`, `access_manager` |
| Access control | `roles`, `policies`, `role_policies`, `user_policies`, `permissions`, `api_keys`, `api_key_roles`, `api_key_policies` | `access_manager` only |
| Schema builder | `collections`, `fields`, `relations` | `schema_manager` |
| Content/runtime | `items`, `revisions`, `activity`, `files`, `folders`, `presets`, `translations` | per role |
| Automation | `flows`, `flow_runs`, `operations`, `webhooks` | `automation_manager` |
| Security sensitive | `system_state`, `audit_log`, `login_attempts`, `login_baselines`, `admin_backup_codes`, `scim_tokens` | admin/security only |
| AI/CDC | `ai_*`, `cdc_*` | admin or a dedicated manager |

The minimum seed for local/dev:

- `site_demo`
- `system_state`
- `policy_admin` with `admin_access=true`, `app_access=true`, `enforce_tfa=true`
- `role_administrator`
- attach `policy_admin` to `role_administrator`
- bootstrap/dev user membership in the administrator role
- `policy_studio_self` with app access and permission to read/update the user's own profile, notifications, and presets
- `policy_public` with no app access, holding only the public permissions the project owner chooses

What should not be seeded:

- Public read access to all content.
- Plaintext static/API keys.
- Non-admin access to `system_state`, `audit_log`, backup codes, or SCIM/API-key secrets.

## 10. API keys attached directly to roles

A Directus static token lives on `directus_users.token`: the token uses that user's permissions. That is simple but has drawbacks:

- The token is tied to a real person, making service integrations hard to audit.
- A user can only have one static token.
- The token has no independent lifecycle per integration.
- Rotating or revoking it affects the user.

LumiBase should make the API key first-class:

- An API key is its own principal, not a fake user.
- An API key has roles and policies just like a user.
- An API key has no app access.
- An API key has scope metadata so the UI/audit shows which service is using it.
- An API key has expire/revoke/rotate/last_used.
- An API key goes through conflict checking when roles/policies are attached.

Runtime:

```txt
Authorization: Bearer lumi_live_<prefix>_<secret>
```

Middleware:

1. Hash the token.
2. Look up the active row in `api_keys`.
3. Build the principal `{ type: "api_key", apiKeyId, siteId }`.
4. Compile policies via `api_key_roles` + `api_key_policies`.
5. Apply permission checks exactly as for a user, except for TFA and Studio access.

## 11. Import / export of access config

This should be the "Permission Builder Config-as-Code" feature.

The versioned contract is settled in [access-manifest-v1.md](./access-manifest-v1.md), with the JSON schema at [`docs/schemas/lumibase.access.v1.schema.json`](../../schemas/lumibase.access.v1.schema.json).

### 11.1. Principles

- Use stable keys, never depend on DB ids.
- The export contains no secrets.
- The import runs in a transaction.
- There is always a dry-run.
- There is a conflict report before applying.
- There are `merge`, `replace-managed`, and `replace-all` modes.
- There is an audit event per import.
- There is a schema version.

### 11.2. Proposed manifest

```json
{
  "schema": "lumibase.access@v1",
  "version": 1,
  "kind": "lumibase.access",
  "siteKey": "default",
  "exportedAt": "2026-06-03T00:00:00.000Z",
  "roles": [
    {
      "key": "editor",
      "name": "Editor",
      "description": "Can edit own drafts",
      "icon": "square-pen",
      "parents": [],
      "policies": [
        { "key": "studio_app", "priority": 10 },
        { "key": "posts_editor", "priority": 100 }
      ]
    }
  ],
  "policies": [
    {
      "key": "posts_editor",
      "name": "Posts editor",
      "adminAccess": false,
      "appAccess": true,
      "enforceTfa": true,
      "ipAllow": ["10.0.0.0/8"],
      "ipDeny": [],
      "validFrom": null,
      "validUntil": null,
      "permissions": [
        {
          "collection": "posts",
          "action": "read",
          "fields": ["title", "body", "status", "user_created"],
          "permissions": {
            "_or": [
              { "status": { "_eq": "published" } },
              { "user_created": { "_eq": "$CURRENT_USER" } }
            ]
          },
          "validation": {},
          "presets": {}
        },
        {
          "collection": "posts",
          "action": "update",
          "fields": ["title", "body", "status"],
          "permissions": {
            "user_created": { "_eq": "$CURRENT_USER" }
          },
          "validation": {
            "status": { "_in": ["draft", "review"] }
          },
          "presets": {
            "user_updated": "$CURRENT_USER"
          }
        }
      ]
    }
  ],
  "apiKeys": [
    {
      "key": "nextjs_frontend",
      "name": "Next.js frontend",
      "roles": ["public_reader"],
      "policies": [],
      "expiresAt": null,
      "revoked": false
    }
  ]
}
```

### 11.3. Import modes

| Mode | Behaviour |
|---|---|
| `dry-run` | Parse, validate, diff, conflict-check; writes nothing to the DB |
| `merge` | Upsert role/policy/permission by key; deletes nothing outside the manifest |
| `replace-managed` | Deletes only objects with `managedBy="access-import"` that are no longer in the manifest |
| `replace-all` | Deletes all access config in the site, then applies; only for a fresh environment |

### 11.4. Endpoints / CLI

```txt
GET  /api/v1/access/export
POST /api/v1/access/import?dryRun=true
POST /api/v1/access/import
POST /api/v1/access/conflicts/check
```

CLI:

```bash
lumibase access export --site site_demo > access.json
lumibase access import access.json --dry-run
lumibase access import access.json --mode replace-managed
```

### 11.5. Best practice when syncing environments

- Commit `access.json` to the repo alongside the collection schema.
- CI runs an import dry-run against a staging DB clone.
- Do not export production user membership if it carries PII; export roles/policies first, and handle membership through SCIM or a separate seed.
- API keys export metadata, never secrets. An import creates the key disabled, or requires `--generate-secrets`.
- Use slug-style stable keys: `posts_editor`, `policy_public_read_posts`.
- Every import must write an audit log entry with a diff summary.

## 12. Extension access control

### 12.1. Directus handles extensions across several layers

Directus has no single first-class policy of the form "role/user X may access extension Y" for every extension. It handles this across several distinct layers instead:

1. **Extension installation/loading layer**
   - App extensions and sandboxed API extensions can be installed via the Marketplace.
   - Non-sandboxed API extensions are a higher trust level, and a self-host may have to enable trust or install them manually.
   - Enabling/disabling an extension in Settings is project-wide, not per-user.

2. **Sandbox capability layer for API extensions**
   - Sandboxed API extensions run in an isolate and must declare `requestedScopes`.
   - Example scopes: `log`, `sleep`, `request` with a method/URL allowlist.
   - This is the extension's permission against the host environment, not a user's permission against the extension.

3. **Accountability/user-permission layer when an extension calls Directus services**
   - An API extension can use internal services such as `ItemsService`, `CollectionsService`, `FilesService`.
   - When a service is constructed with `accountability: req.accountability`, data permissions are checked against the current user.
   - If the extension passes `accountability: null` or omits accountability, the service runs with admin permissions. This layer is powerful but also a risk when an extension is careless.

4. **App extension / module UI layer**
   - App modules have no access control of their own the way collections do.
   - A module can use the permission store itself to check collection/admin rights and then hide or block its UI.
   - This is a convention in extension code, not a mandatory policy binding at platform level.

Conclusion: Directus has extension enable/sandbox/service accountability, but no first-class permission builder for configuring which user/role/policy may see or run which extension.

Official sources:

- Directus Sandbox: sandboxed API extensions run in an isolate and must declare requested scopes.
- Directus Services: internal services take `accountability`; `null`/omitted may use administrator permissions.
- Directus Including Extensions: the Marketplace covers app and sandboxed API extensions by default; non-sandboxed API extensions depend on trust/self-host install.
- Directus Modules: a module appears when the extension is enabled and the module is enabled in the Module Bar; modules have no access control like collections do, and an extension may use the permission store to block itself.

### 12.2. Proposed design for LumiBase

LumiBase should separate three kinds of extension permission:

| Layer | Purpose | Who configures it | Where it is enforced |
|---|---|---|---|
| Extension capability grant | Which host APIs the extension may use | Site admin / security admin | Sandbox runtime |
| Extension access policy | Which user/role/API key may see or call which extension | Access manager | PermissionService + Studio/router |
| Effective data permission | Whether the extension acts on data as the user or as a service account | Extension author + admin grant | ItemService/PermissionService |

A capability does not replace RBAC. For example, the `shopify-sync` extension may have the capability `items:update:products`, but only the `commerce_manager` role may open the module and run the sync.

### 12.3. New collections/actions for the Permission Builder

Add system collections, virtual or real:

- `extensions`
- `extension_modules`
- `extension_endpoints`
- `extension_operations`

Proposed actions:

| Action | Meaning |
|---|---|
| `read` | See the extension in Settings/Marketplace/Module Bar |
| `execute` | Call the extension's endpoint/operation/module action |
| `configure` | Edit the extension's config |
| `install` | Install a new extension |
| `enable` | Enable/disable an extension |
| `grant_capability` | Approve sandbox capabilities |
| `delete` | Uninstall an extension |

A permission row can use the standard collection/action:

```json
{
  "collection": "extensions",
  "action": "execute",
  "permissions": {
    "extension_key": { "_in": ["shopify_sync", "stripe_refunds"] }
  },
  "fields": ["*"]
}
```

Or a more specialised model:

```json
{
  "collection": "extension_modules",
  "action": "read",
  "permissions": {
    "extension_key": { "_eq": "commerce_dashboard" }
  }
}
```

### 12.4. Runtime enforcement for LumiBase

1. **Studio extension loader**
   - The `/extensions` list only returns UI extensions for which the principal has `extensions:read` or `extension_modules:read`.
   - The Module Bar only shows an extension module if the effective policy allows it.
   - Settings > Extensions requires `extensions:configure/install/enable/delete`.

2. **Extension endpoint router**
   - Before routing to `/api/v1/extensions/:name/*`, the backend checks that:
     - the extension is enabled;
     - the principal has `extensions:execute` with `extension_key=name`;
     - if the principal is an API key, the extension declares `apiKeyCallable=true` or the policy allows it explicitly.

3. **Hook/operation execution**
   - A hook runs because of a user's mutation, so the context must carry an `actor`.
   - An extension acting on data uses the actor's permissions by default.
   - Service-account mode must be declared in the manifest, granted its own capability, and audited.

4. **Sandbox capability**
   - Keep the existing capability allowlist (`items:*`, `http:fetch`, `secrets:read`, `log:write`, …).
   - The capability grant is the upper bound; the user's permission is the lower bound. The extension may only act when both layers allow it.

### 12.5. Proposed DB/API

Schema options:

- Add columns to `extensions`:
  - `key`, stable and unique per site.
  - `accessMode`: `inherit` | `restricted` | `public_studio`.
  - `serviceAccountPolicyId`, nullable.
  - `apiKeyCallable`, boolean.
- Or add a table:
  - `extension_access_policies(extension_id, policy_id, access_scope, priority)`.

Recommendation: make the Permission Builder the single source and do not create a second RBAC system. `extension_access_policies` is only needed as a UI shortcut. Import/export must include extension access config in the manifest.

### 12.6. Conflict and audit

- The conflict checker must treat `extensions`/`extension_modules`/`extension_endpoints` as system collections.
- Block a policy that grants an ordinary user `grant_capability` or `install` on an extension without `appAccess`.
- Audit is mandatory for:
  - install/uninstall;
  - enable/disable;
  - granting/revoking a capability;
  - a denied endpoint/operation execution;
  - service-account execution.

## 13. Implementation plan

### Phase 1: Harden the existing schema

- Add unique `(policy_id, collection, action)`.
- Add the conflict checker service.
- Add the `POST /access/conflicts/check` endpoint.
- Have the Role Detail UI call the conflict checker before attaching a policy.
- Have PermissionService return the source-policy trace in `/permissions/me`.

### Phase 2: Policy flags migration

- Add the policy columns: `admin_access`, `app_access`, `enforce_tfa`, `ip_allow`, `ip_deny`, `valid_from`, `valid_until`.
- Deprecate `roles.admin_access` and `roles.app_access`.
- Move the Studio toggles onto the policy detail, or a quick-create policy.
- Have the auth middleware enforce app access and TFA from the effective policies.

### Phase 3: API keys

- Add `api_keys`, `api_key_roles`, `api_key_policies`.
- Bearer auth looked up by hashed token.
- API Key management UI.
- Rotate/revoke/last-used/audit.

### Phase 4: Import/export

- Define the JSON schema.
- Export stable keys.
- Dry-run diff.
- Apply in a transaction, with audit.
- CLI wrapper.

### Phase 5: Extension access

- Add the extension-access system collections/actions.
- Enforce the extension list/module/endpoint against effective permissions.
- Add a UI policy builder for extension access.
- Audit capability grants and endpoint/operation denials.

### Phase 6: Share

- Add `shares`.
- Implement the `share` action.
- A dedicated share-role builder.
- A public share endpoint that uses the role's permissions to mask fields and read the item.

## 14. Test matrix

Backend tests:

- A policy active/inactive by IP CIDR.
- A policy active/inactive by time window.
- `enforce_tfa` denies when the session has not passed TFA.
- `admin_access` bypasses without needing permission rows.
- An unknown operator or magic var fails closed.
- A duplicate permission within one policy is rejected.
- The conflict checker blocks unconditional-vs-restricted.
- The conflict checker blocks `*` fields vs a whitelist.
- An API key compiles roles/policies exactly as a user does.
- A user without `extensions:execute` cannot call an extension endpoint.
- A user without `extension_modules:read` does not see the extension module in Studio.
- An extension holding the capability but whose actor lacks the permission is still denied the data mutation.
- An import dry-run writes nothing to the DB.
- An import apply is idempotent.

Frontend tests:

- Attaching a policy to a role shows the conflict before saving.
- The permission matrix shows the effective source policies.
- Policy detail has app/admin/TFA/IP controls.
- API key detail attaches roles/policies and previews the effective permissions.
- The import dialog shows the diff/conflict.
- Extension settings only show install/enable/grant-capability when the principal holds the matching permission.

Security tests:

- The public role cannot read a collection with no explicit permission.
- A revoked API key does not authenticate.
- An API key cannot use a Studio route even if its policy has app access.
- An API key cannot call an extension endpoint unless the extension is API-key callable and the policy has `extensions:execute`.
- A share link only reads the fields the share role permits.
- Sensitive system collections do not appear for non-admins.

## 15. Recommended decisions

1. Follow Directus v11 in putting access flags on the policy, not on the user.
2. Do not keep `adminAccess`/`appAccess` on the role long term; a role should only be grouping.
3. Let an API key hold roles/policies directly, but make the API key its own principal rather than a user's static token.
4. Block conflicts in the UI/backend instead of silently OR-ing and union-ing everything.
5. Seed the system access policies from the start, particularly `admin`, `studio self`, `schema manager`, `access manager`, and `public`.
6. Treat import/export of access config as production-critical: schema version, dry-run, stable keys, audit, and never export plaintext secrets.
7. Add first-class extension access control; this is where LumiBase can beat Directus, since Directus relies mostly on the sandbox/accountability and on modules checking permissions themselves.
