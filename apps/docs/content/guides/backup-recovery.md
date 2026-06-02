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
6. Re-index search (content may be stale in MeiliSearch)

```bash
# Quick recovery using latest daily backup + WAL replay
docker compose stop cms
./docker/scripts/restore.sh --pitr "2024-01-15 14:25:00 UTC"
docker compose start cms

# Re-index search
curl -X POST http://localhost:1989/api/search/reindex
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

### Manual Verification Checklist

- [ ] Restore backup to a test database
- [ ] Verify row counts match expected values
- [ ] Run application health check against restored database
- [ ] Verify media files are accessible
- [ ] Check that search index can be rebuilt from restored data
- [ ] Document recovery time (RTO) and data loss window (RPO)

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
