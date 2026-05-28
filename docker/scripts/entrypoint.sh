#!/bin/bash
set -e

if [ "${SKIP_MIGRATIONS}" = "true" ]; then
  echo "[entrypoint] SKIP_MIGRATIONS=true, skipping database migrations."
else
  MAX_RETRIES=5
  RETRY_COUNT=0
  BACKOFF=1

  echo "[entrypoint] Running database migrations..."

  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if node dist/migrate.js 2>&1; then
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
exec node dist/serve.js
