#!/bin/bash
set -e

load_secret_file() {
  local key="$1"
  local file_var="${key}_FILE"
  local file_path="${!file_var:-}"

  if [ -n "${file_path}" ] && [ -z "${!key:-}" ]; then
    if [ ! -r "${file_path}" ]; then
      echo "[entrypoint] ${file_var} points to an unreadable file: ${file_path}"
      exit 1
    fi
    export "${key}=$(tr -d '\r\n' < "${file_path}")"
  fi
}

for key in \
  DATABASE_URL \
  REDIS_URL \
  JWT_SECRET \
  ENCRYPTION_KEY \
  S3_ACCESS_KEY \
  S3_SECRET_KEY \
  MEILISEARCH_API_KEY \
  IMGPROXY_KEY \
  IMGPROXY_SALT
do
  load_secret_file "${key}"
done

if [ "${SKIP_MIGRATIONS}" = "true" ]; then
  echo "[entrypoint] SKIP_MIGRATIONS=true, skipping database migrations."
else
  MAX_RETRIES=5
  RETRY_COUNT=0
  BACKOFF=1

  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if [ "${RUN_MIGRATION_PREFLIGHT:-true}" != "false" ]; then
      echo "[entrypoint] Running database migration preflight..."
      if ! node dist/migrate.cjs preflight 2>&1; then
        RETRY_COUNT=$((RETRY_COUNT + 1))

        if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
          echo "[entrypoint] Migration preflight failed after $MAX_RETRIES attempts. Exiting."
          exit 1
        fi

        echo "[entrypoint] Migration preflight attempt $RETRY_COUNT/$MAX_RETRIES failed. Retrying in ${BACKOFF}s..."
        sleep $BACKOFF
        BACKOFF=$((BACKOFF * 2))
        continue
      fi

      if [ "${MIGRATION_MODE}" = "preflight" ] || [ "${MIGRATION_MODE}" = "dry-run" ]; then
        echo "[entrypoint] MIGRATION_MODE=${MIGRATION_MODE}; exiting after preflight without starting server."
        exit 0
      fi
    fi

    echo "[entrypoint] Running database migrations..."

    if node dist/migrate.cjs apply 2>&1; then
      echo "[entrypoint] Migrations completed successfully."
      break
    fi

    RETRY_COUNT=$((RETRY_COUNT + 1))

    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
      echo "[entrypoint] Migration failed after $MAX_RETRIES attempts. Exiting."
      exit 1
    fi

    echo "[entrypoint] Migration attempt $RETRY_COUNT/$MAX_RETRIES failed. Retrying in ${BACKOFF}s..."
    sleep $BACKOFF
    BACKOFF=$((BACKOFF * 2))
  done
fi

echo "[entrypoint] Starting server..."
exec node dist/serve.cjs
