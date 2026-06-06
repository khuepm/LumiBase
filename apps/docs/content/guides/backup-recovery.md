# Backup & Recovery Guide

This guide covers database backup strategies, restore procedures, point-in-time recovery (PITR), and disaster recovery planning for self-hosted Lumibase deployments.

## Backup Strategy Overview

Lumibase uses PostgreSQL as its primary data store. A robust backup strategy combines:

1. **Scheduled logical backups** — Daily `pg_dump` snapshots stored in S3
2. **WAL archiving** — Continuous write-ahead log shipping for point-in-time recovery
3. **Retention policies** — Automated cleanup of old backups

```
┌─────────────────────────────────────────────────────────┐
│                    Backup Architecture                    │
│                                                          │
│  PostgreSQL ──── WAL Archive ──── S3 (continuous)       │
│       │                                                  │
│       └──── pg_dump ──── S3 (daily at 02:00 UTC)        │
│                                                          │
│  Retention: 7 daily + 4 weekly                          │
└─────────────────────────────────────────────────────────┘
```

## Automated Backups (Docker Compose)

The monitoring overlay includes an automated backup service:

```bash
# Start with backup service
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
```

The `pg-backup` service runs `pg_dump` on a configurable schedule and stores backups in MinIO/S3.

### Backup Service Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULE` | `@daily` | Cron schedule for backups |
| `BACKUP_KEEP_DAYS` | `7` | Number of daily backups to retain |
| `BACKUP_KEEP_WEEKS` | `4` | Number of weekly backups to retain |
| `BACKUP_KEEP_MONTHS` | `0` | Number of monthly backups to retain |
| `POSTGRES_HOST` | `postgres` | PostgreSQL hostname |
| `POSTGRES_DB` | `lumibase` | Database name |
| `POSTGRES_USER` | `lumibase` | Database user |
| `POSTGRES_PASSWORD` | — | Database password |

### Custom Schedule Examples

```yaml
# Every 6 hours
SCHEDULE: "0 */6 * * *"

# Daily at 2 AM UTC
SCHEDULE: "0 2 * * *"

# Every 12 hours
SCHEDULE: "0 0,12 * * *"
```

## Manual Backup

### Using the Backup Script

```bash
# Run a manual backup
docker compose exec pg-backup /backup.sh

# Or use the standalone script
./docker/scripts/backup.sh
```

### Direct pg_dump

```bash
# Compressed custom format (recommended for restore flexibility)
pg_dump -h localhost -U lumibase -d lumibase -Fc -f backup_$(date +%Y%m%d_%H%M%S).dump

# Plain SQL (human-readable, larger file)
pg_dump -h localhost -U lumibase -d lumibase -f backup_$(date +%Y%m%d_%H%M%S).sql

# Schema only (no data)
pg_dump -h localhost -U lumibase -d lumibase --schema-only -f schema.sql
```

### Upload to S3/MinIO

```bash
# Using the MinIO client (mc)
mc alias set local http://localhost:9000 minioadmin minioadmin
mc cp backup_20240115_020000.dump local/lumibase-backups/daily/

# Using AWS CLI
aws --endpoint-url http://localhost:9000 s3 cp \
  backup_20240115_020000.dump \
  s3://lumibase-backups/daily/
```

## Restore Procedures

### Restore from Custom Format Dump

```bash
# Stop the CMS to prevent writes during restore
docker compose stop cms

# Drop and recreate the database
docker compose exec postgres psql -U lumibase -c "DROP DATABASE IF EXISTS lumibase;"
docker compose exec postgres psql -U lumibase -c "CREATE DATABASE lumibase;"

# Restore from dump
docker compose exec -T postgres pg_restore \
  -U lumibase -d lumibase --no-owner --no-privileges \
  < backup_20240115_020000.dump

# Restart the CMS
docker compose start cms
```

### Restore from SQL Dump

```bash
docker compose stop cms

docker compose exec postgres psql -U lumibase -c "DROP DATABASE IF EXISTS lumibase;"
docker compose exec postgres psql -U lumibase -c "CREATE DATABASE lumibase;"

docker compose exec -T postgres psql -U lumibase -d lumibase < backup_20240115_020000.sql

docker compose start cms
```

### Using the Restore Script

```bash
# Restore from a specific backup file
./docker/scripts/restore.sh backup_20240115_020000.dump

# Restore from S3
./docker/scripts/restore.sh s3://lumibase-backups/daily/backup_20240115_020000.dump
```

### Restore to a Different Database (Testing)

```bash
# Create a test database
docker compose exec postgres psql -U lumibase -c "CREATE DATABASE lumibase_restore_test;"

# Restore into it
docker compose exec -T postgres pg_restore \
  -U lumibase -d lumibase_restore_test --no-owner \
  < backup_20240115_020000.dump

# Verify
docker compose exec postgres psql -U lumibase -d lumibase_restore_test \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
```

## Point-in-Time Recovery (PITR)

PITR allows restoring the database to any specific moment using WAL (Write-Ahead Log) archiving. This is essential for production deployments where you need to recover from accidental data deletion or corruption.

### Enable WAL Archiving

Add these settings to your PostgreSQL configuration:

```yaml
# docker-compose.prod.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: lumibase
      POSTGRES_USER: lumibase
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    command:
      - "postgres"
      - "-c" 
      - "wal_level=replica"
      - "-c"
      - "archive_mode=on"
      - "-c"
      - "archive_command=aws --endpoint-url ${S3_ENDPOINT} s3 cp %p s3://lumibase-backups/wal/%f"
      - "-c"
      - "archive_timeout=60"
    volumes:
      - pgdata:/var/lib/postgresql/data
```

### WAL Archive Configuration

| Parameter | Value | Description |
|-----------|-------|-------------|
| `wal_level` | `replica` | Enable WAL archiving (minimum level) |
| `archive_mode` | `on` | Activate WAL archiving |
| `archive_command` | S3 upload | Command to archive each WAL segment |
| `archive_timeout` | `60` | Force archive after 60s of inactivity |

### Performing PITR

1. **Stop PostgreSQL:**

```bash
docker compose stop postgres
```

2. **Restore the base backup:**

```bash
# Clear existing data
rm -rf /var/lib/postgresql/data/*

# Restore base backup
pg_restore -D /var/lib/postgresql/data < base_backup.dump
```

3. **Create recovery configuration:**

```bash
# Create recovery.signal file
touch /var/lib/postgresql/data/recovery.signal
```

4. **Configure recovery target in `postgresql.conf`:**

```ini
# Recover to a specific timestamp
restore_command = 'aws --endpoint-url http://minio:9000 s3 cp s3://lumibase-backups/wal/%f %p'
recovery_target_time = '2024-01-15 14:30:00 UTC'
recovery_target_action = 'promote'
```

5. **Start PostgreSQL:**

```bash
docker compose start postgres
```

PostgreSQL will replay WAL segments up to the specified timestamp.

### PITR Best Practices

- Take a base backup at least weekly (daily for high-write workloads)
- Monitor WAL archive lag — if archiving falls behind, your recovery window shrinks
- Test PITR recovery quarterly on a separate instance
- Store WAL archives in a different region/provider than your primary database

## Disaster Recovery Playbook

### Scenario 1: Accidental Data Deletion

**Symptoms:** User reports missing content, audit log shows DELETE operations.

**Recovery steps:**

1. Identify the timestamp before the deletion from application logs
2. Stop the CMS to prevent further writes
3. Perform PITR to the timestamp just before the deletion
4. Verify recovered data
5. Restart the CMS
6. Rebuild the search index (content may be stale in MeiliSearch)

```bash
# Quick recovery using latest daily backup + WAL replay
docker compose stop cms
./docker/scripts/restore.sh --pitr "2024-01-15 14:25:00 UTC"
docker compose start cms

# Rebuild search with your deployment's reindex job or admin operation.
# If your deployment exposes a reindex endpoint:
curl -fsS -X POST http://localhost:1989/api/search/reindex
```

### Scenario 2: Database Corruption

**Symptoms:** PostgreSQL crashes, checksum errors in logs, queries return unexpected errors.

**Recovery steps:**

1. Stop PostgreSQL immediately
2. Preserve the corrupted data directory for analysis
3. Restore from the latest clean backup
4. Apply WAL logs up to the last known good state
5. Verify data integrity
6. Restart all services

```bash
# Preserve corrupted state
docker compose stop postgres
docker cp $(docker compose ps -q postgres):/var/lib/postgresql/data ./corrupted_data_backup

# Restore from last backup
./docker/scripts/restore.sh latest

# Verify
docker compose exec postgres psql -U lumibase -d lumibase -c "SELECT count(*) FROM items;"
docker compose start cms
```

### Scenario 3: Complete Infrastructure Loss

**Symptoms:** Host machine failure, cloud region outage.

**Recovery steps:**

1. Provision new infrastructure (new Docker host or cluster)
2. Pull the latest Lumibase Docker image
3. Restore PostgreSQL from S3 backup
4. Restore MinIO data from S3 backup (if using cross-region replication)
5. Start all services
6. Update DNS to point to new infrastructure
7. Verify all services are healthy

```bash
# On new infrastructure
git clone https://github.com/your-org/lumibase.git
cd lumibase/docker

# Configure environment
cp .env.example .env
# Edit .env with production values

# Start infrastructure services
docker compose up -d postgres redis minio meilisearch imgproxy

# Restore database
./docker/scripts/restore.sh s3://lumibase-backups/daily/latest.dump

# Restore media files
mc mirror remote/lumibase-media local/lumibase-media

# Start CMS
docker compose up -d cms

# Verify
curl http://localhost:1989/health
```

### Scenario 4: Ransomware / Security Breach

**Symptoms:** Encrypted files, unauthorized access detected, data exfiltration.

**Recovery steps:**

1. **Isolate** — Disconnect affected systems from the network immediately
2. **Assess** — Determine the scope and timeline of the breach
3. **Restore** — Use backups from before the breach (verify backup integrity first)
4. **Rotate** — Change all credentials (database passwords, API keys, encryption keys)
5. **Patch** — Address the vulnerability that allowed the breach
6. **Monitor** — Increase monitoring and alerting thresholds

## Backup / DR Validation

Run a restore drill at least monthly, and after any change to database schema,
storage provider, search provider, backup schedule, retention, or infrastructure
topology. A drill is only complete when the restored application is usable, not
just when `pg_restore` exits successfully.

### Restore Drill Runbook

Use an isolated environment that cannot send production webhooks or email.
Record the start time before restoring so the measured recovery time can be
compared with the RTO target.

```bash
# 1. Capture the drill start time
date -u +"%Y-%m-%dT%H:%M:%SZ" | tee restore-drill-start.txt

# 2. Start the dependencies in the isolated environment
docker compose up -d postgres redis minio meilisearch imgproxy

# 3. Restore the selected backup
./docker/scripts/restore.sh s3://lumibase-backups/daily/backup_20240115_020000.dump

# 4. Start the CMS against the restored database
docker compose up -d cms
```

Restore drills must use a named backup artifact, not `latest`, unless the drill
is specifically testing the `latest` pointer. Keep the backup object key, WAL
target timestamp, Git SHA, and environment name in the drill notes.

### Row-Count Verification

Before the drill, capture production row counts for business-critical tables and
store them with the backup metadata. After restore, compare the restored counts
against that baseline.

```bash
# Capture exact row counts for every public table in the restored database
docker compose exec -T postgres psql -U lumibase -d lumibase -Atc "
  SELECT format(
    'SELECT %L AS table_name, count(*) AS rows FROM %I.%I;',
    schemaname || '.' || tablename,
    schemaname,
    tablename
  )
  FROM pg_tables
  WHERE schemaname = 'public';
" | docker compose exec -T postgres psql -U lumibase -d lumibase -At \
  | sort > restored-row-counts.txt

# Compare with the production baseline captured at backup time
diff -u expected-row-counts.txt restored-row-counts.txt
```

For tables with active writes, compare against the backup timestamp, not the
current production state. If PITR is used, validate that rows created after the
recovery target are absent and rows created before the target are present.

### Application Health Check After Restore

The restored app must pass the public health endpoint and at least one
authenticated smoke test before the drill is accepted.

```bash
# Service-level health
curl -fsS http://localhost:1989/health

# Confirm backing services report healthy, or document intentional degraded services
curl -fsS http://localhost:1989/health | jq '.status, .services'
```

Also verify the most important user journeys for the deployment:

- [ ] Admin can log in
- [ ] Collections and items load
- [ ] A restored item can be read through the API
- [ ] A non-production write can be created and rolled back
- [ ] Background queues do not contain production-only jobs

### Cloudflare Restore Drill

Cloudflare deployments use the same PostgreSQL restore process, but the
validation surface is wider than Docker. Hyperdrive only connects the Worker to
PostgreSQL; it is not the backup source. Restore and row-count verification must
run against the origin PostgreSQL provider, then validate each Cloudflare service
that fronts or derives state from that database.

Use a separate Cloudflare environment for drills whenever possible:

```bash
# Deploy the Worker against restore-drill bindings, not production bindings
wrangler deploy --env restore-drill

# Confirm the deployed Worker is using the expected account and environment
wrangler whoami

# Watch Worker errors while the restored app starts
wrangler tail --env restore-drill
```

Validate the Cloudflare service layer after the database restore:

| Service | What to validate | Example check |
|---------|------------------|---------------|
| Workers | The restored API route is deployed and healthy. | `curl -fsS https://restore-api.example.com/health` |
| Hyperdrive | The Worker can reach the restored PostgreSQL database and is not pointing at production by mistake. | Health response reports `database: healthy`; row counts match the restored database. |
| R2 | Media objects exist in the restore bucket and are readable through the API or media custom domain. | `curl -fsS https://restore-api.example.com/api/media?prefix= \| jq '.data \| length'` |
| KV | Config and permission cache are either empty for the drill or repopulated from restored database reads. | Log in and load collections after clearing stale restore-environment cache keys. |
| Queues | No production-only jobs are replayed; restore-environment queues and dead-letter queues are empty before smoke tests. | Check Cloudflare Queues metrics/dashboards for backlog and failures. |
| MeiliSearch Cloud | Search is rebuilt from restored database content, not copied from production indexes. | Query restored collections after the reindex job completes. |
| DNS / WAF / Access | Custom domains, Cloudflare Access, and WAF rules allow health, auth, media, and API smoke tests. | Run health and authenticated smoke tests through the real restore domain, not only the workers.dev URL. |

For Cloudflare, include these extra fields in the drill record:

| Field | Example |
|-------|---------|
| Cloudflare account | `acme-prod` |
| Worker environment | `restore-drill` |
| Worker deployment ID | `from wrangler deploy output` |
| Hyperdrive binding | `lumibase-hyperdrive-restore` |
| Origin database | `restore-postgres-us-east-1` |
| R2 bucket | `lumibase-media-restore` |
| KV namespace | `CONFIG_CACHE restore namespace` |
| Queue names | `content-indexing-restore`, `media-processing-restore` |
| Custom domain tested | `https://restore-api.example.com` |

Do not count KV, R2, search indexes, or queue state as covered by the PostgreSQL
backup. KV and search are derived state and should be rebuilt or repopulated.
R2 media needs its own replication or backup policy. Queues should be drained,
discarded, or replayed intentionally according to the incident type.

### Media and Search Rebuild

Database restore does not prove that object storage and derived indexes are
consistent. Validate media separately, then rebuild derived search state from
the restored database.

```bash
# Verify the storage adapter can list restored media keys
curl -fsS http://localhost:1989/api/v1/media?prefix= | jq '.data | length'

# Verify a known restored media object can be fetched
curl -fsS -o /tmp/lumibase-media-check.bin \
  http://localhost:1989/api/v1/media/path/to/known-object.jpg

# If media is restored from a replicated bucket, compare object counts
mc ls --recursive remote/lumibase-media | wc -l
mc ls --recursive local/lumibase-media | wc -l
```

Rebuild MeiliSearch or the configured search backend after every restore because
the index is derived state. Use the deployment's reindex job or administrative
operation. If your deployment exposes a reindex endpoint, run:

```bash
curl -fsS -X POST http://localhost:1989/api/search/reindex
```

After rebuild, run representative search queries against restored collections
and compare the result count with expected fixtures.

```bash
curl -fsS "http://localhost:1989/api/v1/search?q=release&collection=articles&limit=5" \
  | jq '.meta.totalHits'
```

### RTO / RPO Documentation

Every drill must produce a short record that can be audited later:

| Field | Example |
|-------|---------|
| Drill date | `2024-01-15` |
| Environment | `restore-drill-us-east-1` |
| Backup artifact | `s3://lumibase-backups/daily/backup_20240115_020000.dump` |
| WAL target | `2024-01-15 14:25:00 UTC` |
| Restore start | `2024-01-15T15:00:00Z` |
| App healthy | `2024-01-15T15:18:00Z` |
| Measured RTO | `18 minutes` |
| Backup timestamp | `2024-01-15T14:00:00Z` |
| Last recovered transaction | `2024-01-15T14:24:52Z` |
| Measured RPO | `8 seconds` |
| Row-count diff | `0 unexpected diffs` |
| Media check | `passed: listed bucket and fetched known object` |
| Search rebuild | `passed: articles query returned expected hits` |
| Exceptions | `none` |

If measured RTO or RPO exceeds the target, open an incident follow-up and update
the recovery plan before considering the drill passed.

## Backup Verification

### Automated Verification

Add a weekly backup verification job:

```yaml
# docker-compose.monitoring.yml addition
services:
  backup-verify:
    image: postgres:16-alpine
    environment:
      PGPASSWORD: ${POSTGRES_PASSWORD}
    entrypoint: /bin/sh
    command: >
      -c "
        pg_restore --list /backups/latest.dump > /dev/null 2>&1 &&
        echo 'Backup verification: PASSED' ||
        echo 'Backup verification: FAILED'
      "
    volumes:
      - backupdata:/backups
    profiles:
      - verify
```

Run verification:

```bash
docker compose --profile verify run --rm backup-verify
```

### Automated Restore Drills

Use `docker/scripts/restore-drill.sh` to restore a named backup into a dedicated
restore database, capture exact row counts, check the restored app health
endpoint, validate media, and trigger/search-check derived indexes. The same
script works for Docker and Cloudflare restore environments because it targets a
database URL and an app URL rather than assuming a specific runtime.

```bash
BACKUP_FILE=lumibase_20240115_020000.sql.gz \
RESTORE_DATABASE_URL=postgresql://lumibase:password@restore-db:5432/lumibase_restore \
RESTORE_APP_URL=https://restore-api.example.com \
RESTORE_AUTH_HEADER="Authorization: Bearer dev:admin@lumibase.dev:admin" \
RESTORE_SITE_HEADER="X-Lumi-Site: site_demo" \
SEARCH_EXPECT_MIN_HITS=1 \
EXPECTED_ROW_COUNTS_FILE=expected-row-counts.txt \
S3_ENDPOINT=https://s3.example.com \
S3_BUCKET=lumibase-backups \
S3_ACCESS_KEY=restore-readonly \
S3_SECRET_KEY=restore-secret \
DRILL_ENV=cloudflare \
CLOUDFLARE_ENV=restore-drill \
./docker/scripts/restore-drill.sh
```

Schedule it from cron, systemd timers, GitHub Actions, or your Cloudflare
operations scheduler. For a weekly host cron:

```cron
0 3 * * 0 cd /opt/lumibase && /usr/bin/env bash docker/scripts/restore-drill.sh >> /var/log/lumibase-restore-drill.log 2>&1
```

Store the required environment variables in the scheduler's secret store or in a
root-readable env file. Never point `RESTORE_DATABASE_URL` at production; the
script refuses to run when it matches `DATABASE_URL` unless
`ALLOW_PRODUCTION_RESTORE_DRILL=true` is explicitly set.

### Manual Verification Checklist

- [ ] Restore backup to a test database
- [ ] Verify row counts match expected values
- [ ] Run application health check against restored database
- [ ] Verify media files are accessible
- [ ] Check that search index can be rebuilt from restored data
- [ ] Document recovery time (RTO) and data loss window (RPO)
- [ ] Attach the completed restore drill record to the operations log

## Backup Failure Notifications

Configure the backup service to send notifications on failure:

### Webhook Notification

```yaml
# In docker-compose.monitoring.yml
services:
  pg-backup:
    environment:
      WEBHOOK_URL: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
      WEBHOOK_ERROR_ONLY: "true"
```

### Email Notification

```yaml
services:
  pg-backup:
    environment:
      SMTP_HOST: smtp.gmail.com
      SMTP_PORT: 587
      SMTP_USER: alerts@yourdomain.com
      SMTP_PASSWORD: your-app-password
      MAIL_TO: ops-team@yourdomain.com
      MAIL_FROM: alerts@yourdomain.com
```

## Recovery Objectives

Define and test these targets for your deployment:

| Metric | Target | Description |
|--------|--------|-------------|
| RPO (Recovery Point Objective) | < 1 hour | Maximum acceptable data loss |
| RTO (Recovery Time Objective) | < 30 minutes | Maximum acceptable downtime |
| Backup frequency | Daily + continuous WAL | How often backups run |
| Retention | 7 daily + 4 weekly | How long backups are kept |
| Verification | Weekly | How often backups are tested |

## Next Steps

- [Docker Deployment](../deployment/docker.md) — Production deployment setup
- [Environment Variables](../deployment/environment-variables.md) — Configure backup-related variables
- [Tooling Recommendations](./tooling-recommendations.md) — Monitoring and alerting tools
