#!/bin/bash

# Import Directus Schema Snapshot
# Applies a saved schema to Directus

set -e

echo "📥 Importing Directus Schema..."
echo "================================"

# Check argument
if [ -z "$1" ]; then
    echo "Usage: ./scripts/snapshot-import.sh <snapshot-file>"
    echo ""
    echo "Available snapshots:"
    ls -1 directus-snapshots/*.yaml 2>/dev/null || echo "  (none found)"
    exit 1
fi

SNAPSHOT_FILE=$1

# Check if file exists
if [ ! -f "$SNAPSHOT_FILE" ]; then
    echo "❌ Snapshot file not found: $SNAPSHOT_FILE"
    exit 1
fi

# Check if Directus is running
if ! curl -s http://localhost:8055/server/health &>/dev/null; then
    echo "❌ Directus is not running"
    echo "Run: docker-compose up -d"
    exit 1
fi

# Copy snapshot to container
echo ""
echo "Copying snapshot to container..."
docker cp $SNAPSHOT_FILE directus-cms:/directus/snapshots/import.yaml

# Apply snapshot
echo ""
echo "Applying schema..."
docker-compose exec directus npx directus schema apply \
    /directus/snapshots/import.yaml

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Schema imported successfully!"
    echo ""
    echo "🌐 Open Directus to see changes: http://localhost:8055"
else
    echo ""
    echo "❌ Import failed"
    exit 1
fi
