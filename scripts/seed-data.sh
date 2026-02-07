#!/bin/bash

# Seed Data Script for Directus-Firebase-Supabase Setup
# This script adds sample users to the PostgreSQL database

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Seed Data Script ===${NC}"
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

# Sample users data
echo -e "${YELLOW}Seeding sample users...${NC}"

# SQL to insert sample users
SQL_SCRIPT="
-- Insert sample users
-- Note: In production, these would be created via Firebase Auth and synced by Cloud Functions

INSERT INTO public.users (firebase_uid, email, display_name, photo_url, created_at, updated_at)
VALUES 
    ('test-user-001', 'alice@example.com', 'Alice Johnson', 'https://i.pravatar.cc/150?img=1', NOW(), NOW()),
    ('test-user-002', 'bob@example.com', 'Bob Smith', 'https://i.pravatar.cc/150?img=2', NOW(), NOW()),
    ('test-user-003', 'charlie@example.com', 'Charlie Brown', 'https://i.pravatar.cc/150?img=3', NOW(), NOW()),
    ('test-user-004', 'diana@example.com', 'Diana Prince', 'https://i.pravatar.cc/150?img=4', NOW(), NOW()),
    ('test-user-005', 'eve@example.com', 'Eve Wilson', 'https://i.pravatar.cc/150?img=5', NOW(), NOW())
ON CONFLICT (firebase_uid) DO UPDATE SET
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    photo_url = EXCLUDED.photo_url,
    updated_at = NOW();

-- Display seeded users
SELECT 
    firebase_uid,
    email,
    display_name,
    created_at
FROM public.users
ORDER BY created_at DESC;
"

# Execute SQL script
echo "$SQL_SCRIPT" | docker exec -i directus-postgres psql -U "$DB_USER" -d "$DB_NAME"

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ Successfully seeded sample users!${NC}"
    echo ""
    echo -e "${GREEN}Sample users created:${NC}"
    echo "  1. alice@example.com (Alice Johnson)"
    echo "  2. bob@example.com (Bob Smith)"
    echo "  3. charlie@example.com (Charlie Brown)"
    echo "  4. diana@example.com (Diana Prince)"
    echo "  5. eve@example.com (Eve Wilson)"
    echo ""
    echo -e "${YELLOW}Note: These are test users for development only.${NC}"
    echo -e "${YELLOW}In production, users should be created via Firebase Authentication.${NC}"
else
    echo ""
    echo -e "${RED}✗ Failed to seed data!${NC}"
    exit 1
fi
