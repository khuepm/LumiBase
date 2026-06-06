#!/usr/bin/env bash
set -euo pipefail

# Restore drill automation for Docker and Cloudflare restore environments.
#
# Required:
#   RESTORE_DATABASE_URL - Non-production PostgreSQL database to restore into.
#   BACKUP_FILE          - Local backup path, backup filename, or s3:// URI.
#
# Required when BACKUP_FILE is not a local file or s3:// URI:
#   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY
#
# Optional:
#   BACKUP_PREFIX             - S3 prefix for backup filenames (default: backups)
#   RESTORE_APP_URL           - Restored app base URL for /health, media, search checks
#   EXPECTED_ROW_COUNTS_FILE  - Baseline row counts to diff against
#   RESTORE_RESET_SCHEMA      - Drop/recreate public schema before restore (default: true)
#   REINDEX_URL               - POST endpoint or job trigger URL for search rebuild
#   MEDIA_CHECK_KEY           - Media object key to fetch through /api/media
#   SEARCH_CHECK_URL          - Full URL for a representative search query
#   DRILL_REPORT_DIR          - Directory for drill outputs (default: ./restore-drill-reports)
#   DRILL_ENV                 - docker, cloudflare, or a deployment-specific label
#   CLOUDFLARE_ENV           - Cloudflare Worker environment label for reporting

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[restore-drill] missing required command: $1" >&2
    exit 1
  fi
}

require_env() {
  if [ -z "${!1:-}" ]; then
    echo "[restore-drill] missing required environment variable: $1" >&2
    exit 1
  fi
}

require_cmd psql
require_cmd curl

require_env RESTORE_DATABASE_URL
require_env BACKUP_FILE

if [ "${ALLOW_PRODUCTION_RESTORE_DRILL:-false}" != "true" ] &&
  [ -n "${DATABASE_URL:-}" ] &&
  [ "${RESTORE_DATABASE_URL}" = "${DATABASE_URL}" ]; then
  echo "[restore-drill] refusing to restore into DATABASE_URL; set a separate RESTORE_DATABASE_URL" >&2
  exit 1
fi

BACKUP_PREFIX="${BACKUP_PREFIX:-backups}"
RESTORE_RESET_SCHEMA="${RESTORE_RESET_SCHEMA:-true}"
DRILL_REPORT_DIR="${DRILL_REPORT_DIR:-./restore-drill-reports}"
DRILL_ENV="${DRILL_ENV:-docker}"
START_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
START_EPOCH=$(date +%s)
RUN_ID=$(date -u +"%Y%m%dT%H%M%SZ")
RUN_DIR="${DRILL_REPORT_DIR}/${RUN_ID}"
TMP_DIR=$(mktemp -d)

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${RUN_DIR}"

echo "[restore-drill] run=${RUN_ID} env=${DRILL_ENV} started=${START_ISO}"

LOCAL_BACKUP="${TMP_DIR}/backup"
if [ -f "${BACKUP_FILE}" ]; then
  cp "${BACKUP_FILE}" "${LOCAL_BACKUP}"
elif [[ "${BACKUP_FILE}" == s3://* ]]; then
  require_cmd aws
  require_env S3_ACCESS_KEY
  require_env S3_SECRET_KEY
  export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}"
  export AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}"
  if [ -n "${S3_ENDPOINT:-}" ]; then
    aws s3 cp "${BACKUP_FILE}" "${LOCAL_BACKUP}" --endpoint-url "${S3_ENDPOINT}"
  else
    aws s3 cp "${BACKUP_FILE}" "${LOCAL_BACKUP}"
  fi
else
  require_cmd aws
  require_env S3_ENDPOINT
  require_env S3_BUCKET
  require_env S3_ACCESS_KEY
  require_env S3_SECRET_KEY
  export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}"
  export AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}"
  aws s3 cp "s3://${S3_BUCKET}/${BACKUP_PREFIX}/${BACKUP_FILE}" "${LOCAL_BACKUP}" \
    --endpoint-url "${S3_ENDPOINT}"
fi

echo "[restore-drill] backup downloaded ($(du -h "${LOCAL_BACKUP}" | cut -f1))"

if [ "${RESTORE_RESET_SCHEMA}" = "true" ]; then
  echo "[restore-drill] resetting public schema in restore database"
  psql "${RESTORE_DATABASE_URL}" -v ON_ERROR_STOP=1 --quiet <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
SQL
fi

echo "[restore-drill] restoring database"
case "${BACKUP_FILE}" in
  *.dump|*.backup)
    require_cmd pg_restore
    pg_restore --no-owner --no-privileges --dbname "${RESTORE_DATABASE_URL}" "${LOCAL_BACKUP}"
    ;;
  *.gz)
    gunzip -c "${LOCAL_BACKUP}" | psql "${RESTORE_DATABASE_URL}" -v ON_ERROR_STOP=1 --quiet
    ;;
  *)
    psql "${RESTORE_DATABASE_URL}" -v ON_ERROR_STOP=1 --quiet < "${LOCAL_BACKUP}"
    ;;
esac

echo "[restore-drill] capturing row counts"
psql "${RESTORE_DATABASE_URL}" -Atc "
  SELECT format(
    'SELECT %L AS table_name, count(*) AS rows FROM %I.%I;',
    schemaname || '.' || tablename,
    schemaname,
    tablename
  )
  FROM pg_tables
  WHERE schemaname = 'public';
" | psql "${RESTORE_DATABASE_URL}" -At | sort > "${RUN_DIR}/restored-row-counts.txt"

ROW_COUNT_RESULT="not_provided"
if [ -n "${EXPECTED_ROW_COUNTS_FILE:-}" ]; then
  if diff -u "${EXPECTED_ROW_COUNTS_FILE}" "${RUN_DIR}/restored-row-counts.txt" \
    > "${RUN_DIR}/row-count-diff.txt"; then
    ROW_COUNT_RESULT="passed"
  else
    ROW_COUNT_RESULT="failed"
  fi
fi

HEALTH_RESULT="skipped"
if [ -n "${RESTORE_APP_URL:-}" ]; then
  echo "[restore-drill] checking app health"
  curl -fsS "${RESTORE_APP_URL%/}/health" > "${RUN_DIR}/health.json"
  HEALTH_RESULT="passed"
fi

MEDIA_RESULT="skipped"
if [ -n "${RESTORE_APP_URL:-}" ] && [ -n "${MEDIA_CHECK_KEY:-}" ]; then
  echo "[restore-drill] checking media object"
  curl -fsS -o "${RUN_DIR}/media-check.bin" \
    "${RESTORE_APP_URL%/}/api/media/${MEDIA_CHECK_KEY}"
  MEDIA_RESULT="passed"
fi

REINDEX_RESULT="skipped"
if [ -n "${REINDEX_URL:-}" ]; then
  echo "[restore-drill] triggering search rebuild"
  curl -fsS -X POST "${REINDEX_URL}" > "${RUN_DIR}/reindex.json"
  REINDEX_RESULT="triggered"
fi

SEARCH_RESULT="skipped"
if [ -n "${SEARCH_CHECK_URL:-}" ]; then
  echo "[restore-drill] checking search query"
  curl -fsS "${SEARCH_CHECK_URL}" > "${RUN_DIR}/search.json"
  SEARCH_RESULT="passed"
fi

END_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
END_EPOCH=$(date +%s)
RTO_SECONDS=$((END_EPOCH - START_EPOCH))

cat > "${RUN_DIR}/restore-drill.md" <<EOF
# Restore Drill ${RUN_ID}

| Field | Value |
|-------|-------|
| Drill environment | ${DRILL_ENV} |
| Cloudflare environment | ${CLOUDFLARE_ENV:-n/a} |
| Backup file | ${BACKUP_FILE} |
| Restore start | ${START_ISO} |
| Restore finished | ${END_ISO} |
| Measured RTO seconds | ${RTO_SECONDS} |
| Row-count diff | ${ROW_COUNT_RESULT} |
| Health check | ${HEALTH_RESULT} |
| Media check | ${MEDIA_RESULT} |
| Search rebuild | ${REINDEX_RESULT} |
| Search check | ${SEARCH_RESULT} |
EOF

echo "[restore-drill] completed; report=${RUN_DIR}/restore-drill.md"

if [ "${ROW_COUNT_RESULT}" = "failed" ]; then
  echo "[restore-drill] row-count verification failed; see ${RUN_DIR}/row-count-diff.txt" >&2
  exit 1
fi
