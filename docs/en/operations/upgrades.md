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
