#!/bin/bash

# Export Directus Schema Snapshot
# Saves current Directus schema to YAML file

set -e

echo "📸 Exporting Directus Schema..."
echo "================================"

# Create snapshots directory if not exists
mkdir -p directus-snapshots

# Generate filename with timestamp
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_FILE="directus-snapshots/schema-$TIMESTAMP.yaml"

# Check if Directus is running
if ! curl -s http://localhost:8055/server/health &>/dev/null; then
    echo "❌ Directus is not running"
    echo "Run: docker-compose up -d"
    exit 1
fi

# Export schema
echo ""
echo "Exporting to: $SNAPSHOT_FILE"

docker-compose exec directus npx directus schema snapshot \
    /directus/snapshots/schema-$TIMESTAMP.yaml

# Copy from container to host
docker cp directus-cms:/directus/snapshots/schema-$TIMESTAMP.yaml \
    $SNAPSHOT_FILE

if [ -f "$SNAPSHOT_FILE" ]; then
    echo ""
    echo "✅ Schema exported successfully!"
    echo "📁 File: $SNAPSHOT_FILE"
    
    # Create/update base snapshot link
    ln -sf $(basename $SNAPSHOT_FILE) directus-snapshots/base-snapshot.yaml
    echo "🔗 Updated base-snapshot.yaml symlink"
    
    # Show file size
    SIZE=$(du -h "$SNAPSHOT_FILE" | cut -f1)
    echo "📊 Size: $SIZE"
else
    echo "❌ Export failed"
    exit 1
fi

echo ""
echo "💡 Tip: Commit this snapshot to version control"
echo "   git add $SNAPSHOT_FILE"
echo "   git commit -m 'chore: update Directus schema snapshot'"
