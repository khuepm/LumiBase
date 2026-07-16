# Role Flag to Policy Flag Migration

> Scope: backward-compatible migration design from `roles.admin_access/app_access` to policy-level `admin_access/app_access/enforce_tfa/ip_allow/ip_deny/valid_from/valid_until`.

## 1. Current State

- The `policies` schema already has `admin_access`, `app_access`, `enforce_tfa`, `ip_allow`, `ip_deny`, `valid_from`, and `valid_until`.
- The `roles` schema still has `admin_access` and `app_access` for compatibility.
- `PermissionService` currently computes effective access with a compatibility fallback: legacy role flags OR active policy flags.
- An earlier migration (`0010_loud_the_renegades.sql`, since squashed into `0000_lumibase_init`) added policy flags, but it did not materialize existing role flags into policy rows.

Conclusion: the migration can be safe if legacy role flags are not removed or disabled immediately. Policy flags become the new source of truth, while role flags stay as fallback for one release window.

## 2. Goals

1. Preserve current admin/app access for every role/user/site.
2. Move `adminAccess`, `appAccess`, `enforceTfa`, IP guards, and time windows to policy level.
3. Keep roles as grouping/assignment units, not security guard containers.
4. Prepare for `policy_admin`, `policy_studio_self`, `lumibase.access@v1`, app access enforcement, and TFA enforcement.
5. Keep rollback safe.

## 3. Migration Phases

### Phase A: compatibility window

This is the current implementation shape.

- Keep `roles.admin_access/app_access`.
- Compile effective flags as `role flags OR active policy flags`.
- Mark role-level toggles in Studio as deprecated/read-only or show a warning.
- Policy Detail owns the new flags.
- Import/export should prefer policy flags; role flags are legacy metadata only when needed for debugging.

### Phase B: materialize legacy role flags

Create one legacy policy for every role where `admin_access=true` or `app_access=true`.

Contract:

- Policy key: `legacy_role_flags_<stable_role_key>`.
- Name: `Legacy role flags: <role name>`.
- `admin_access` = current role value.
- `app_access` = current role value.
- `enforce_tfa=false`.
- `ip_allow=[]`, `ip_deny=[]`.
- `valid_from=null`, `valid_until=null`.
- Do not create permission rows for the legacy policy; it only carries access flags.
- Attach the legacy policy to its role through `role_policies`.
- Do not mutate role flags in this phase.

Preserve exact flag values instead of inferring `admin_access => app_access`. Existing data may contain API-only admin roles or app-only roles, and the migration must preserve current effective behavior.

### Phase C: switch UI and seed to policy-first

- Role Detail no longer edits `adminAccess/appAccess`; it can offer quick actions that create or attach policies.
- Policy Detail owns `adminAccess`, `appAccess`, `enforceTfa`, `ipAllow`, `ipDeny`, `validFrom`, and `validUntil`.
- New seeds should not set role flags unless compatibility with older versions is required.
- Minimum seed:
  - `role_administrator`
  - `policy_admin` with `adminAccess=true`, `appAccess=true`, `enforceTfa=true`
  - attach `policy_admin` to `role_administrator`
  - `policy_studio_self` with `appAccess=true` and minimal self-service permissions
  - `policy_public` with `adminAccess=false`, `appAccess=false`

### Phase D: shadow verify and disable fallback

Before disabling role fallback, run a report comparing:

- effective admin/app from legacy role flags
- effective admin/app from attached active policies
- roles that still have legacy flags but no matching policy

Only after the report is clean should this config be enabled:

```text
LUMIBASE_RBAC_LEGACY_ROLE_FLAGS=false
```

When the flag is false, `PermissionService` uses only policy flags. Role flag columns should remain for at least one additional release to preserve rollback.

### Phase E: drop legacy columns

Only after a clear release boundary:

- no code reads role flags
- no Studio control writes role flags
- export/import does not need legacy metadata
- production migration verification has passed

## 4. Idempotent SQL Strategy

> **Implementation:** `packages/database/src/backfill/role-policies.ts` (run via `pnpm --filter @lumibase/database backfill:role-policies`), tested end-to-end in `apps/cms/src/__tests__/upgrade-path.e2e.test.ts`. The pseudo-SQL below documents the intended shape; the shipped code uses a Drizzle transaction and `nanoid()` IDs.

This is pseudo-SQL, not the final migration. The implementation should use a Drizzle/SQL transaction and the same ID generator as the rest of the project.

```sql
WITH legacy_roles AS (
  SELECT
    id AS role_id,
    site_id,
    name,
    admin_access,
    app_access,
    lower(
      regexp_replace(
        coalesce(system_key, key, id),
        '[^a-zA-Z0-9]+',
        '_',
        'g'
      )
    ) AS role_key
  FROM lumibase_roles
  WHERE admin_access = true OR app_access = true
),
upserted_policies AS (
  INSERT INTO lumibase_policies (
    id,
    site_id,
    key,
    name,
    description,
    admin_access,
    app_access,
    enforce_tfa,
    ip_allow,
    ip_deny,
    valid_from,
    valid_until,
    rules
  )
  SELECT
    gen_lumibase_id(),
    site_id,
    'legacy_role_flags_' || role_key,
    'Legacy role flags: ' || name,
    'Backfilled from roles.admin_access/app_access. Do not edit manually after policy migration is complete.',
    admin_access,
    app_access,
    false,
    '[]'::jsonb,
    '[]'::jsonb,
    null,
    null,
    '{}'::jsonb
  FROM legacy_roles
  ON CONFLICT (site_id, key) DO UPDATE SET
    admin_access = excluded.admin_access,
    app_access = excluded.app_access,
    enforce_tfa = excluded.enforce_tfa,
    ip_allow = excluded.ip_allow,
    ip_deny = excluded.ip_deny,
    valid_from = excluded.valid_from,
    valid_until = excluded.valid_until
  RETURNING id, site_id, key
)
INSERT INTO lumibase_role_policies (role_id, policy_id, priority)
SELECT lr.role_id, p.id, 5
FROM legacy_roles lr
JOIN upserted_policies p
  ON p.site_id = lr.site_id
 AND p.key = 'legacy_role_flags_' || lr.role_key
ON CONFLICT DO NOTHING;
```

Implementation notes:

- If the database does not expose `gen_lumibase_id()`, generate IDs from the application migration.
- `priority=5` is only a convention. A flag-only policy has no permission rows, so it does not affect permission row merging.
- `ON CONFLICT (site_id, key)` requires `policies_site_key_unique`.

## 5. Verification Checklist

Pre-check:

```sql
SELECT site_id, count(*) AS role_count
FROM lumibase_roles
WHERE admin_access = true OR app_access = true
GROUP BY site_id;
```

Post-check:

```sql
SELECT r.id, r.site_id, r.name, r.admin_access, r.app_access
FROM lumibase_roles r
WHERE (r.admin_access = true OR r.app_access = true)
AND NOT EXISTS (
  SELECT 1
  FROM lumibase_role_policies rp
  JOIN lumibase_policies p ON p.id = rp.policy_id
  WHERE rp.role_id = r.id
    AND p.admin_access = r.admin_access
    AND p.app_access = r.app_access
);
```

Expected result: zero rows.

Behavior tests:

- Legacy admin role is still admin after migration.
- Legacy app-only role can still enter Studio after migration.
- Role without app access still cannot enter Studio.
- Role without admin access still cannot bypass permission rows.
- Disabling `LUMIBASE_RBAC_LEGACY_ROLE_FLAGS` on a backfilled fixture does not change effective results.
- Rollback can delete `legacy_role_flags_` policies without losing access because role flags remain intact.

## 6. Rollback

Safe rollback during the compatibility window:

```sql
DELETE FROM lumibase_role_policies
WHERE policy_id IN (
  SELECT id FROM lumibase_policies WHERE key LIKE 'legacy_role_flags_%'
);

DELETE FROM lumibase_policies
WHERE key LIKE 'legacy_role_flags_%';
```

Do not delete or reset `roles.admin_access/app_access` in the same migration. This is the core backward-compatible safety mechanism.

## 7. Impact on Upcoming Features

App access enforcement:

- Studio must check `effective.appAccess=true` from active policies.
- During the compatibility window, role flags are still OR-ed into the result.
- API keys are always blocked from Studio, even if an attached policy has `appAccess=true`.

TFA enforcement:

- Backfilled legacy policies set `enforceTfa=false` because old role flags had no equivalent meaning.
- New `policy_admin` seed should set `enforceTfa=true`.
- API keys attached to a policy with `enforceTfa=true` must produce a blocking conflict or strong warning because API keys cannot enroll TFA.

IP/time guards:

- Backfilled legacy policies set `ipAllow=[]`, `ipDeny=[]`, `validFrom=null`, and `validUntil=null`.
- New guards are added only through Policy Detail, seeds, or import manifests.

Import/export:

- `lumibase.access@v1` exports policy flags as the source of truth.
- Legacy role flags must not create new access rights in target environments.
- If migration traceability is needed, export legacy role flags under `metadata.legacyRoleFlags`, not the primary contract.

Studio deprecation:

- Role page shows legacy flags as read-only during the migration window.
- Saving a role should not write `adminAccess/appAccess`.
- Editing access flags should route to Policy Detail or create and attach a new policy.

System seeding:

- New seeds use `policy_admin`, `policy_studio_self`, and `policy_public`.
- Do not seed role-level access flags for new environments unless older versions still need compatibility.
