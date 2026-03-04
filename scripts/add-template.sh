#!/bin/bash

# Add Pre-built Template
# Imports a template with collections and data

set -e

echo "📦 LumiBase Template Installer"
echo "================================"

# Available templates
TEMPLATES=("ecommerce" "blog" "saas" "social")

# Check argument
if [ -z "$1" ]; then
    echo "Usage: ./scripts/add-template.sh <template-name>"
    echo ""
    echo "Available templates:"
    for template in "${TEMPLATES[@]}"; do
        echo "  - $template"
    done
    exit 1
fi

TEMPLATE=$1

# Check if template exists
if [ ! -d "templates/$TEMPLATE" ]; then
    echo "❌ Template not found: $TEMPLATE"
    echo ""
    echo "Available templates:"
    for template in "${TEMPLATES[@]}"; do
        echo "  - $template"
    done
    exit 1
fi

echo ""
echo "Installing template: $TEMPLATE"
echo ""

# Run template migrations
if [ -d "templates/$TEMPLATE/migrations" ]; then
    echo "🔄 Running template migrations..."
    for migration in templates/$TEMPLATE/migrations/*.sql; do
        if [ -f "$migration" ]; then
            filename=$(basename "$migration")
            echo "  📄 $filename"
            
            docker-compose exec -T postgres psql \
                -U $DB_USER \
                -d $DB_NAME \
                < "$migration"
        fi
    done
    echo "✅ Migrations completed"
fi

# Import Directus snapshot
if [ -f "templates/$TEMPLATE/directus-snapshot.yaml" ]; then
    echo ""
    echo "📸 Importing Directus schema..."
    ./scripts/snapshot-import.sh "templates/$TEMPLATE/directus-snapshot.yaml"
fi

# Seed data (optional)
if [ -f "templates/$TEMPLATE/seed-data.sql" ]; then
    echo ""
    echo "🌱 Seeding template data..."
    docker-compose exec -T postgres psql \
        -U $DB_USER \
        -d $DB_NAME \
        < "templates/$TEMPLATE/seed-data.sql"
    echo "✅ Data seeded"
fi

echo ""
echo "================================"
echo "✅ Template '$TEMPLATE' installed successfully!"
echo ""
echo "🌐 Open Directus to see new collections: http://localhost:8055"
