# System Collections & Sensitive Access Contract

Decision date: 2026-06-03.

This document is the contract for system permission seeding, Permission Builder grouping, access import/export, and security review when new system tables are added.

Source: `packages/database/src/schema/*`.

## Principles

1. System collections are not normal content collections by default.
2. Public policy must not grant system collections unless explicit and reviewed.
3. Sensitive collections are hidden from non-admin users in Permission Builder.
4. Permission Builder must group system collections so admins can understand blast radius.
5. New system tables must be classified here before production seeding.
6. Tables containing secrets, hashes, tokens, audit trails, or security state are admin/security-only.

## Standard Seed Policy Keys

| Policy key | Purpose |
|---|---|
| `policy_admin` | Admin bypass, app access, enforce TFA. |
| `policy_access_manager` | Manage roles, policies, permissions, user-role/user-policy bindings. |
| `policy_schema_manager` | Manage collections, fields, relations, materialized collections. |
| `policy_user_manager` | Manage users, teams, membership, notifications where needed. |
| `policy_security_manager` | Read audit/security logs, manage lockout/recovery/SCIM/API keys. |
| `policy_automation_manager` | Manage flows, operations, webhooks, CDC pipelines. |
| `policy_extension_manager` | Install/enable/configure/grant capabilities for extensions. |
| `policy_ai_manager` | Manage AI approvals/conversations/embeddings where enabled. |
| `policy_studio_self` | Studio user can read/update own profile, notifications, presets. |
| `policy_public` | No app access; only explicit public content grants. |

## Current Classification

| UI group | Collections | Permission Builder visibility | Default seed | Notes |
|---|---|---|---|---|
| Tenant root | `sites` | Admin only | `policy_admin` | Instance/site metadata. |
| Identity | `users`, `user_sites`, `user_roles`, `teams`, `team_members`, `notifications` | Access/User manager | `policy_user_manager`, `policy_studio_self` | Self policy is scoped to own profile/notifications/presets. |
| Access control | `roles`, `policies`, `role_policies`, `user_policies`, `permissions` | Access manager | `policy_access_manager` | Changes can open the whole site; always audit. |
| Schema builder | `collections`, `fields`, `relations`, `materialized_collections` | Schema manager | `policy_schema_manager` | Data model management; not ordinary editor access. |
| Content store | `items`, `pages`, `revisions`, `activity` | Per content role | Per project/role | `items/pages` are content; `revisions/activity` should be read-only except admin. |
| Files & assets | `folders`, `files` | Per content role / asset manager | Per project/role | File metadata can include PII; public must be explicit. |
| UX state | `presets`, `translations`, `settings` | Studio/self + manager | `policy_studio_self`, manager policies | `settings` is config-sensitive. |
| Automation | `flows`, `flow_runs`, `operations`, `webhooks` | Automation manager | `policy_automation_manager` | Webhook secret/header data is sensitive. |
| Extensions | `extensions` | Extension manager | `policy_extension_manager` | Capability grants/install/enable/delete are privileged. |
| Translation memory | `translation_memory`, `glossary` | Translation manager | Dedicated translation policy | May contain internal content; not public by default. |
| AI | `ai_approvals`, `ai_conversations`, `ai_messages`, `ai_embeddings` | AI manager / owner-scoped | `policy_ai_manager` | Conversations/messages can contain PII/secrets. |
| CDC | `cdc_pipelines`, `cdc_pipeline_health`, `cdc_deployments` | Automation/ops manager | Automation or ops policy | Pipeline connection/env config is sensitive. |
| Security sensitive | `system_state`, `audit_log`, `login_attempts`, `login_baselines`, `admin_backup_codes`, `scim_tokens` | Hidden for non-admin | `policy_admin`, `policy_security_manager` | Never public; no plaintext secrets in export. |

## Sensitive Collections Hard Rule

Sensitive/admin-only collections:

```txt
system_state
audit_log
login_attempts
login_baselines
admin_backup_codes
scim_tokens
```

Future sensitive collections:

```txt
api_keys
api_key_roles
api_key_policies
shares
extension_access_policies
```

Rules:

- Hide from non-admin users in Permission Builder.
- Seed only for `policy_admin` or dedicated manager policies.
- Import/export must not include plaintext secrets or token material.
- Security manager read access must be read-only and field-masked where needed.

## Future Virtual/System Access Targets

These targets may not be direct DB tables but must appear in Permission Builder:

| Target | Purpose |
|---|---|
| `extension_modules` | Visibility for extension modules in Module Bar. |
| `extension_endpoints` | Calling extension endpoints. |
| `extension_operations` | Running extension operations/flow nodes. |
| `api_keys` | API key lifecycle management. |
| `shares` | Share link management. |
| `admin_security` | Unlock user, unblock IP, recovery/audit security actions. |

## Minimum Seed

Minimum local/staging/prod seed:

1. `role_administrator` + `policy_admin`.
2. `policy_access_manager`.
3. `policy_schema_manager`.
4. `policy_studio_self`.
5. `policy_public` empty or only explicit public content.

Never seed:

- public read-all content;
- public system collections;
- plaintext API/static token;
- non-admin writes into access/security collections.

## Checklist For New System Collections

1. Add the collection to this classification table.
2. Choose seed policy owner.
3. Decide if it is hidden from non-admin users.
4. Decide if import/export must mask secrets.
5. Add a test that public policy cannot read it if sensitive.
