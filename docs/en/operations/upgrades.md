---
version: 1
lastUpdated: 2026-07-11T03:49:05.879Z
sourceLang: en
contentHash: dc7a160b08b512cb
---

# Upgrade Operations

This runbook defines the minimum upgrade path for LumiBase deployments on Cloudflare-hosted and Docker self-hosted environments. Treat every upgrade as a change-management event: choose an explicit version, back up data, run migrations intentionally, verify the running app, and keep a bounded rollback plan.

## Versioning policy: fixed-version

LumiBase uses a **fixed-version** operations policy for production upgrades.

- Pin production deployments to an explicit release channel or immutable version instead of tracking an unreviewed moving target.
- Record the current app version, target app version, migration identifier, Docker image digest when applicable, and deploy timestamp in the change ticket.
- Promote versions through environments in order: development, staging, then production.
- Avoid mixing app binaries and database schema versions outside the compatibility window documented by each release note.

## Release channels

Supported release channels are:

| Channel | Meaning | Recommended use |
|---------|---------|-----------------|
| `edge` | Fast-moving preview channel built from the newest accepted changes. | Development and early integration only. |
| `latest` | Current generally recommended release. | Small non-critical deployments that accept automatic patch adoption after review. |
| `X.Y` | Minor release line, for example `1.4`. | Production fleets that want patch updates inside one minor line. |
| `X.Y.Z` | Fully fixed patch release, for example `1.4.2`. | Production environments that require reproducible deploys and explicit change approval. |

Prefer `X.Y.Z` for regulated or high-availability production systems. Use `X.Y` only when the team has an automated staging validation gate for new patch releases.

## Cloudflare-hosted upgrade flow

1. Read the target release notes and identify required environment variable, binding, queue, R2, KV, Hyperdrive, D1/Postgres, and migration changes.
2. Snapshot configuration and secrets metadata without exposing secret values.
3. Run the [backup checklist](#backup-checklist).
4. Deploy the target CMS Worker version to staging first.
5. Run the [migration checklist](#migration-checklist) against staging.
6. Verify the app version endpoint:

   ```bash
   curl -fsS https://<cms-host>/api/v1/system/version
   ```

7. Smoke test authentication, Studio access, collection reads/writes, file operations, flows/webhooks, and realtime if enabled.
8. Promote the same fixed release to production using the approved Cloudflare deployment process.
9. Re-run the version check and production smoke tests.
10. Keep the previous app deployment available until the rollback window closes.

## Docker self-host upgrade flow

1. Review the target release notes and confirm that your compose file, environment variables, volumes, and database version satisfy the target release requirements.
2. Run the [backup checklist](#backup-checklist).
3. Pull the target CMS image:

   ```bash
   docker compose pull cms
   ```

4. Start only the CMS service on the new image:

   ```bash
   docker compose up -d cms
   ```

5. Run the [migration checklist](#migration-checklist).
6. Verify the app version endpoint from the host or load balancer:

   ```bash
   curl -fsS http://localhost:1989/api/v1/system/version
   ```

7. Check container health and logs:

   ```bash
   docker compose ps cms
   docker compose logs --tail=200 cms
   ```

8. Smoke test authentication, Studio access, collection reads/writes, file operations, flows/webhooks, and realtime if enabled.
9. Keep the previous image tag or digest available locally until the rollback window closes.

## Backup checklist

Before any upgrade, capture enough state to restore service outside the application rollback path:

- Database logical backup, plus a restore test for production-critical datasets.
- Object storage backup or versioned snapshot for uploaded files and generated assets.
- Exported LumiBase configuration for collections, fields, roles, policies, permissions, flows, webhooks, and extensions.
- Environment variable inventory and platform binding inventory.
- Current app version and target app version.
- Current Docker image tag and digest for self-hosted installs.
- Current Cloudflare Worker deployment ID for Cloudflare-hosted installs.
- Migration history table contents and pending migration list.
- Recent application logs and metrics baseline.

## Migration checklist

Run migrations deliberately and verify both schema and application behavior:

- Read release notes for destructive, long-running, or manual migrations.
- Confirm database backups completed and can be restored.
- Confirm no unexpected pending migrations exist before starting.
- Run migrations in staging before production.
- For production, schedule a maintenance window if the migration changes large tables, indexes, constraints, permissions, or tenant-scoped data.
- Apply migrations with the same application version that will serve traffic.
- Verify migration history after completion.
- Smoke test core reads and writes for at least one representative site tenant.
- Keep a record of migration IDs applied during the upgrade.

## Upgrading to 1.0

`1.0.0` is the first release that carries a semver stability guarantee (see the [versioning policy](#) in the README). Because it freezes the public surface, the path onto it depends on the version you start from. Read this section end to end before you begin — some source versions upgrade in place, others require an intermediate stop, and one range cannot be migrated forward at all.

### Supported upgrade sources

| From | Path to 1.0.0 | Notes |
|------|---------------|-------|
| `0.18.x` – `0.21.x` | Direct. | Table prefix and RBAC model already match 1.0. Run the [migration checklist](#migration-checklist); no manual data step. |
| `0.6.x` – `0.17.x` | Direct, **with the RBAC backfill below**. | Schema migrations are cumulative and idempotent. The one manual verification is the role→policy backfill (see [RBAC role→policy backfill](#rbac-rolepolicy-backfill)). |
| Before `0.17.0` (unprefixed tables) | **Not supported as an in-place upgrade.** | The `0.17.x` table-prefix change is fresh-install-only. Instances created before `0.17.0` must export their data (collections, items, files, roles/policies/permissions, flows, webhooks) and re-import into a fresh `1.0.0` install. There is no forward migration for the unprefixed schema. |
| Before `0.6.0` | Via an intermediate `0.17.x` – `0.21.x` release first. | Upgrade to a recent `0.x` (which applies the RBAC backfill and any prefix handling), verify, then upgrade to `1.0.0`. Do not skip directly. |

Determine your current version from `/api/v1/system/version` before choosing a row.

### RBAC role→policy backfill

`1.0.0` treats **policies** as the source of truth for `admin_access` and `app_access` (plus `enforce_tfa`, IP guards, and time windows). Instances that predate the policy model stored these as flags on **roles**. During the compatibility window `PermissionService` still reads `role flags OR active policy flags`, so access does not break on upgrade — but before `1.0.0` you should materialize the legacy role flags into policy rows so the policy layer alone is authoritative.

The backfill is idempotent and does **not** mutate role flags (they remain intact as the rollback anchor). For each role where `admin_access` or `app_access` is true it creates one flag-only policy — key `legacy_role_flags_<role_key>_<role_id>` (the role id suffix keeps roles whose keys normalize identically on separate policies), name `Legacy role flags: <role name>`, copying the exact flag values, with `enforce_tfa=false`, empty IP guards, and null time windows — and attaches it to the role via `role_policies`. Full contract: [Role Flag to Policy Flag Migration](../features/role-policy-flag-migration.md).

Run it with the bundled script (apply also runs the post-check and exits non-zero if it fails):

```bash
DATABASE_URL=postgresql://... pnpm --filter @lumibase/database backfill:role-policies          # apply + verify
DATABASE_URL=postgresql://... pnpm --filter @lumibase/database backfill:role-policies verify   # post-check only
DATABASE_URL=postgresql://... pnpm --filter @lumibase/database backfill:role-policies rollback # compat-window rollback
```

Run it against staging first, then verify. The post-check must return **zero rows** — every role that carries a legacy flag must have a matching policy:

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

Then confirm effective access is unchanged: a legacy admin role is still admin, a legacy app-only role can still enter Studio, and a role without app access still cannot. This whole path — pre-policy fixture → backfill → zero-row post-check → idempotent re-run → rollback — is exercised automatically in CI by `apps/cms/src/__tests__/upgrade-path.e2e.test.ts` (the `e2e-golden-path` job), so a green build is the release-gate evidence. Role flag columns stay in place through 1.0 for rollback; they are only scheduled to drop in a later release after `LUMIBASE_RBAC_LEGACY_ROLE_FLAGS=false` has shipped and been verified.

### Rollback from 1.0

- **Application:** roll back to the previous `0.21.x` deployment per [rollback app](#rollback-app). `1.0.0` adds no destructive schema change over `0.21.x`, so the prior app version remains compatible with the 1.0 database.
- **RBAC backfill:** it is separately reversible during the compatibility window — delete the `legacy_role_flags_%` policies and their `role_policies` rows (role flags are untouched, so access is preserved). See [§6 Rollback](../features/role-policy-flag-migration.md#6-rollback).
- **Pre-0.17 re-import path:** there is no rollback to the old unprefixed schema; keep the source instance running read-only until the 1.0 install is verified.

## Rollback app

Application rollback means routing traffic back to the previous app deployment while keeping the database at its current post-upgrade state unless a separate database restore is approved.

- Cloudflare-hosted: roll back to the previous Worker deployment or redeploy the previous fixed version.
- Docker self-host: start the previous fixed image tag or digest.
- After rollback, verify `/api/v1/system/version` and run smoke tests.
- Confirm the previous app version is compatible with the current database schema before keeping it in service.

## Rollback Docker image

Use immutable tags or digests when possible:

```bash
# Example: pin the compose file or override to the previous image first, then restart cms.
docker compose up -d cms
curl -fsS http://localhost:1989/api/v1/system/version
```

If the previous image is not available locally, pull the exact previous tag or digest before restarting:

```bash
docker compose pull cms
docker compose up -d cms
```

Do not roll back to `latest` blindly; update the compose image reference to the intended `X.Y.Z` tag or digest first.

## Rollback database limits

Database rollback is limited and higher risk than application rollback.

- LumiBase does not assume every migration is reversible.
- Downgrade migrations may not exist for destructive schema changes, data rewrites, backfills, or permission model changes.
- Restoring a database backup can discard writes created after the backup timestamp.
- Restoring only the database without matching object storage and configuration exports can create inconsistent state.
- Database restore must be treated as a disaster-recovery action with explicit approval, a write freeze, and a post-restore consistency check.
- Prefer forward fixes when the upgraded database is healthy and only application behavior needs correction.
