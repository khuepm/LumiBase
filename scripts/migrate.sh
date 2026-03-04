#!/bin/bash

# Database Migration Script
# Runs all SQL migrations in order

set -e

echo "🔄 Running Database Migrations..."
echo "================================"

# Load environment variables
if [ -f .env ]; then
    source .env
else
    echo "❌ .env file not found"
    exit 1
fi

# Check if migrations directory exists
if [ ! -d "init-scripts" ]; then
    echo "❌ init-scripts directory not found"
    exit 1
fi

# Check if PostgreSQL is running
if ! docker-compose exec -T postgres pg_isready -U $DB_USER &>/dev/null; then
    echo "❌ PostgreSQL is not running"
    echo "Run: docker-compose up -d"
    exit 1
fi

# Run migrations in order
echo ""
echo "Running migrations..."

for migration in init-scripts/*.sql; do
    if [ -f "$migration" ]; then
        filename=$(basename "$migration")
        echo "  📄 $filename"
        
        docker-compose exec -T postgres psql \
            -U $DB_USER \
            -d $DB_NAME \
            -f /docker-entrypoint-initdb.d/$filename
        
        if [ $? -eq 0 ]; then
            echo "     ✅ Success"
        else
            echo "     ❌ Failed"
            exit 1
        fi
    fi
done

echo ""
echo "================================"
echo "✅ All migrations completed!"
