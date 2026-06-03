# PermissionService Compose Behavior Audit

Audit date: 2026-06-03.

This document records the current runtime behavior of `PermissionService` before the advanced Permission Builder work continues. It intentionally describes implementation reality, including gaps that differ from the desired RBAC blueprint.

Files reviewed:

- `apps/cms/src/services/permission-service.ts`
- `apps/cms/src/services/permission-dsl.ts`
- `apps/cms/src/services/item-service.ts`
- `apps/cms/src/routes/permissions.ts`

## Current Compose Flow

`PermissionService.bundle()` compiles one `PermissionBundle` for the current principal and caches it as `perm:{siteId}:{userId|anon}` for 60 seconds.

The compiler loads the primary role from `user_sites.role_id`, secondary roles from `user_roles`, role policies from `role_policies`, direct user policies from `user_policies`, filters inactive policies by time/IP guards, and groups permission rows by `collection::action`.

If any role or active policy has `adminAccess=true`, the bundle becomes admin bypass and permission rows are not compiled.

## Permission Row Composition

Rules are additive. When multiple rows share the same `collection + action`, non-empty rules are merged with `_or`. This can widen access when a newly attached policy is broader than an existing one.

Fields are additive. If either field list includes `"*"`, the effective list becomes `["*"]`; otherwise lists are unioned. A current gap is that exclusions such as `"-secret"` can be lost when merged with `"*"`.

Presets and validation are merged with object spread. If two policies define the same field, the later row wins silently. Because permission rows are fetched with `inArray` and no explicit priority ordering, this winner is not guaranteed to map cleanly to binding priority.

`sources` now tracks contributing policy id/name for Permission Matrix inspection, but it is not a complete per-field/per-rule trace.

## Runtime Enforcement Summary

Read/list/detail is the strongest path today:

- `read` permission is required.
- Row rules are compiled into SQL WHERE.
- Field masks are applied after query.
- Encrypted fields require `read_decrypted`.

Create is partially enforced:

- `create` permission is required.
- Presets are applied.
- The final payload is checked against the create rule.
- Current gaps: create field whitelist and permission-level validation are not enforced.

Update/replace is not currently permission-gated in `ItemService.patch()`.

Delete is not currently permission-gated in `ItemService.softDelete()`.

Revision list/revert has no dedicated permission gate; revert goes through replace, which inherits the update gap.

## Silent Widening Risks

- Unrestricted rules can widen restricted rules.
- `["*"]` can widen a field whitelist.
- Field exclusions can be dropped during merge.
- Preset/validation conflicts can be overwritten silently.
- Direct DB writes or future imports can bypass the attach conflict checker.
- Permission cache can remain stale for up to 60 seconds.
- Legacy role `adminAccess/appAccess` still acts as compatibility fallback.
- Update/delete currently miss permission gates.

## Recommended Hardening Order

1. Enforce update/delete permission checks in `ItemService`.
2. Enforce create/update field whitelists.
3. Enforce permission-level validation in write paths.
4. Preserve field exclusions when merging with `"*"`.
5. Make permission row merge order deterministic by binding priority.
6. Make unknown magic vars fail closed explicitly.
7. Extend DSL operators according to the roadmap.
8. Require import/dry-run to run the same conflict checker as attach endpoints.
