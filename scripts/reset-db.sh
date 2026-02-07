#!/bin/bash

# Database Reset Script for Directus-Firebase-Supabase Setup
# This script drops all tables and re-runs migration scripts to reset the database

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Database Reset Script ===${NC}"
echo ""
echo -e "${YELLOW}⚠️  WARNING: This will DROP ALL TABLES and reset the database!${NC}"
echo -e "${YELLOW}⚠️  All data will be lost!${NC}"
echo ""

# Prompt for confirmation
read -p "Are you sure you want to continue? (yes/no): " confirmation
if [ "$confirmation" != "yes" ]; then
    echo -e "${YELLOW}Operation cancelled.${NC}"
    exit 0
fi

echo ""

# Load environment variables from .env file
if [ -f .env ]; then
    echo -e "${GREEN}Loading environment variables from .env...${NC}"
    export $(cat .env | grep -v '^#' | xargs)
else
    echo -e "${RED}Error: .env file not found!${NC}"
    echo "Please copy .env.example to .env and configure it."
    exit 1
fi

# Check if required variables are set
if [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
    echo -e "${RED}Error: Required database environment variables are not set!${NC}"
    echo "Please ensure DB_USER, DB_PASSWORD, and DB_NAME are configured in .env"
    exit 1
fi

echo -e "${GREEN}Database Configuration:${NC}"
echo "  DB_USER: $DB_USER"
echo "  DB_NAME: $DB_NAME"
echo ""

# Check if PostgreSQL container is running
if ! docker ps | grep -q directus-postgres; then
    echo -e "${RED}Error: PostgreSQL container is not running!${NC}"
    echo "Please start Docker containers with: docker-compose up -d"
    exit 1
fi

echo -e "${GREEN}PostgreSQL container is running.${NC}"
echo ""

# Step 1: Drop all tables
echo -e "${YELLOW}Step 1: Dropping all tables...${NC}"

DROP_SQL="
-- Drop all tables in public schema
DROP TABLE IF EXISTS public.users CASCADE;

-- Drop functions
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;

-- Drop extensions (optional, will be recreated)
-- DROP EXTENSION IF EXISTS \"uuid-ossp\";
"

echo "$DROP_SQL" | docker exec -i directus-postgres psql -U "$DB_USER" -d "$DB_NAME"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Successfully dropped all tables${NC}"
else
    echo -e "${RED}✗ Failed to drop tables!${NC}"
    exit 1
fi

echo ""

# Step 2: Re-run migration scripts
echo -e "${YELLOW}Step 2: Re-running migration scripts...${NC}"

# Check if init-scripts directory exists
if [ ! -d "init-scripts" ]; then
    echo -e "${RED}Error: init-scripts directory not found!${NC}"
    exit 1
fi

# Run schema creation script
if [ -f "init-scripts/01-create-schema.sql" ]; then
    echo -e "${GREEN}Running 01-create-schema.sql...${NC}"
    docker exec -i directus-postgres psql -U "$DB_USER" -d "$DB_NAME" < init-scripts/01-create-schema.sql
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Schema created successfully${NC}"
    else
        echo -e "${RED}✗ Failed to create schema!${NC}"
        exit 1
    fi
else
    echo -e "${RED}Error: init-scripts/01-create-schema.sql not found!${NC}"
    exit 1
fi

echo ""

# Run RLS setup script
if [ -f "init-scripts/02-setup-rls.sql" ]; then
    echo -e "${GREEN}Running 02-setup-rls.sql...${NC}"
    docker exec -i directus-postgres psql -U "$DB_USER" -d "$DB_NAME" < init-scripts/02-setup-rls.sql
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ RLS policies created successfully${NC}"
    else
        echo -e "${RED}✗ Failed to create RLS policies!${NC}"
        exit 1
    fi
else
    echo -e "${RED}Error: init-scripts/02-setup-rls.sql not found!${NC}"
    exit 1
fi

echo ""

# Step 3: Verify database setup
echo -e "${YELLOW}Step 3: Verifying database setup...${NC}"

VERIFY_SQL="
-- Check if users table exists
SELECT 
    table_name,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'users' AND table_schema = 'public') as column_count
FROM information_schema.tables 
WHERE table_schema = 'public' AND table_name = 'users';

-- Check if RLS is enabled
SELECT 
    tablename,
    rowsecurity as rls_enabled
FROM pg_tables 
WHERE schemaname = 'public' AND tablename = 'users';

-- Check policies
SELECT 
    COUNT(*) as policy_count
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'users';
"

echo "$VERIFY_SQL" | docker exec -i directus-postgres psql -U "$DB_USER" -d "$DB_NAME"

echo ""
echo -e "${GREEN}✓ Database reset completed successfully!${NC}"
echo ""
echo -e "${BLUE}Summary:${NC}"
echo "  ✓ All tables dropped"
echo "  ✓ Schema recreated"
echo "  ✓ RLS policies applied"
echo "  ✓ Database verified"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Optionally seed sample data: ./scripts/seed-data.sh"
echo "  2. Verify setup: ./scripts/verify-database-setup.sh"
echo "  3. Restart Directus if needed: docker-compose restart directus"
echo ""
