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

Create is now enforced for the previously audited hardening gaps:

- `create` permission is required.
- Presets are applied.
- The final payload is checked against the create rule.
- User-submitted data is checked against the field whitelist, including structural `status`/`sort`.
- Permission-level validation is evaluated before insert.

Update/replace now requires `update` permission in `ItemService.patch()`. The row rule is injected into both the pre-update read and final update WHERE, user-submitted fields are checked against the whitelist, and permission-level validation is evaluated on the final snapshot.

Delete now requires `delete` permission in `ItemService.softDelete()`. The row rule is injected before hooks run and again into the soft-delete update.

Revision list still has no dedicated permission gate. Revert goes through replace and now inherits the update gate.

## Silent Widening Risks

- Unrestricted rules can widen restricted rules.
- `["*"]` can widen a field whitelist.
- Field exclusions can be dropped during merge.
- Preset/validation conflicts can be overwritten silently.
- Direct DB writes or future imports can bypass the attach conflict checker.
- Permission cache can remain stale for up to 60 seconds.
- Legacy role `adminAccess/appAccess` still acts as compatibility fallback.
- Revision list still needs a dedicated permission decision.

## Recommended Hardening Order

1. Preserve field exclusions when merging with `"*"`.
2. Make permission row merge order deterministic by binding priority.
3. Add a dedicated permission gate for revision list.
4. Require import/dry-run to run the same conflict checker as attach endpoints.
