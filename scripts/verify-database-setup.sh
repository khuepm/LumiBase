#!/bin/bash

# Database Setup Verification Script
# Task 6: Verify database schema and RLS policies

set -e

echo "=========================================="
echo "DATABASE SETUP VERIFICATION SCRIPT"
echo "Task 6: Checkpoint - Verify database setup"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0

# Function to print success
print_success() {
    echo -e "${GREEN}✓${NC} $1"
    ((PASSED++))
}

# Function to print failure
print_failure() {
    echo -e "${RED}✗${NC} $1"
    ((FAILED++))
}

# Function to print warning
print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Function to run SQL query
run_query() {
    docker-compose exec -T postgres psql -U directus -d directus -t -A -c "$1" 2>/dev/null
}

# Check if Docker is running
echo "Checking Docker status..."
if ! docker info > /dev/null 2>&1; then
    print_failure "Docker is not running. Please start Docker Desktop."
    exit 1
fi
print_success "Docker is running"
echo ""

# Check if containers are running
echo "Checking Docker containers..."
if ! docker-compose ps | grep -q "directus-postgres.*Up"; then
    print_failure "PostgreSQL container is not running. Run: docker-compose up -d"
    exit 1
fi
print_success "PostgreSQL container is running"

if ! docker-compose ps | grep -q "directus-cms.*Up"; then
    print_warning "Directus container is not running"
else
    print_success "Directus container is running"
fi
echo ""

# Check PostgreSQL connection
echo "Checking PostgreSQL connection..."
if docker-compose exec -T postgres pg_isready -U directus > /dev/null 2>&1; then
    print_success "PostgreSQL is accepting connections"
else
    print_failure "PostgreSQL is not accepting connections"
    exit 1
fi
echo ""

# ==========================================
# SCHEMA VERIFICATION
# ==========================================
echo "=========================================="
echo "SCHEMA VERIFICATION"
echo "=========================================="
echo ""

# Check if users table exists
echo "Checking if users table exists..."
TABLE_EXISTS=$(run_query "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users');")
if [ "$TABLE_EXISTS" = "t" ]; then
    print_success "users table exists"
else
    print_failure "users table does not exist"
    echo ""
    echo "To create the table, run:"
    echo "  docker-compose exec postgres psql -U directus -d directus -f /docker-entrypoint-initdb.d/01-create-schema.sql"
    exit 1
fi
echo ""

# Check columns
echo "Checking table columns..."

# firebase_uid
COLUMN_CHECK=$(run_query "SELECT data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'firebase_uid';")
if echo "$COLUMN_CHECK" | grep -q "character varying|128|NO"; then
    print_success "firebase_uid is VARCHAR(128) NOT NULL"
else
    print_failure "firebase_uid column is incorrect: $COLUMN_CHECK"
fi

# email
COLUMN_CHECK=$(run_query "SELECT data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email';")
if echo "$COLUMN_CHECK" | grep -q "character varying|255|NO"; then
    print_success "email is VARCHAR(255) NOT NULL"
else
    print_failure "email column is incorrect: $COLUMN_CHECK"
fi

# display_name
COLUMN_CHECK=$(run_query "SELECT data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'display_name';")
if echo "$COLUMN_CHECK" | grep -q "character varying|255|YES"; then
    print_success "display_name is VARCHAR(255) NULL"
else
    print_failure "display_name column is incorrect: $COLUMN_CHECK"
fi

# photo_url
COLUMN_CHECK=$(run_query "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'photo_url';")
if echo "$COLUMN_CHECK" | grep -q "text|YES"; then
    print_success "photo_url is TEXT NULL"
else
    print_failure "photo_url column is incorrect: $COLUMN_CHECK"
fi

# created_at
COLUMN_CHECK=$(run_query "SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'created_at';")
if echo "$COLUMN_CHECK" | grep -q "timestamp with time zone"; then
    print_success "created_at is TIMESTAMP WITH TIME ZONE"
else
    print_failure "created_at column is incorrect: $COLUMN_CHECK"
fi

# updated_at
COLUMN_CHECK=$(run_query "SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'updated_at';")
if echo "$COLUMN_CHECK" | grep -q "timestamp with time zone"; then
    print_success "updated_at is TIMESTAMP WITH TIME ZONE"
else
    print_failure "updated_at column is incorrect: $COLUMN_CHECK"
fi
echo ""

# Check constraints
echo "Checking constraints..."

# Primary key
PK_EXISTS=$(run_query "SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_name = 'users' AND constraint_type = 'PRIMARY KEY';")
if [ "$PK_EXISTS" = "1" ]; then
    print_success "PRIMARY KEY constraint exists"
else
    print_failure "PRIMARY KEY constraint missing"
fi

# Unique constraint on email
UNIQUE_EXISTS=$(run_query "SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_name = 'users' AND constraint_type = 'UNIQUE';")
if [ "$UNIQUE_EXISTS" -ge "1" ]; then
    print_success "UNIQUE constraint on email exists"
else
    print_failure "UNIQUE constraint on email missing"
fi
echo ""

# Check indexes
echo "Checking indexes..."

# Index on firebase_uid (from PRIMARY KEY)
INDEX_EXISTS=$(run_query "SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'users' AND indexname LIKE '%pkey%';")
if [ "$INDEX_EXISTS" -ge "1" ]; then
    print_success "Index on firebase_uid exists (PRIMARY KEY)"
else
    print_failure "Index on firebase_uid missing"
fi

# Index on email
INDEX_EXISTS=$(run_query "SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'users' AND indexname = 'idx_users_email';")
if [ "$INDEX_EXISTS" = "1" ]; then
    print_success "Index idx_users_email exists"
else
    print_failure "Index idx_users_email missing"
fi
echo ""

# Check trigger function
echo "Checking trigger function..."
FUNCTION_EXISTS=$(run_query "SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = 'public' AND routine_name = 'update_updated_at_column';")
if [ "$FUNCTION_EXISTS" = "1" ]; then
    print_success "Function update_updated_at_column exists"
else
    print_failure "Function update_updated_at_column missing"
fi

# Check trigger
TRIGGER_EXISTS=$(run_query "SELECT COUNT(*) FROM information_schema.triggers WHERE event_object_table = 'users' AND trigger_name = 'update_users_updated_at';")
if [ "$TRIGGER_EXISTS" = "1" ]; then
    print_success "Trigger update_users_updated_at exists"
else
    print_failure "Trigger update_users_updated_at missing"
fi
echo ""

# ==========================================
# RLS VERIFICATION
# ==========================================
echo "=========================================="
echo "RLS POLICIES VERIFICATION"
echo "=========================================="
echo ""

# Check if RLS is enabled
echo "Checking if RLS is enabled..."
RLS_ENABLED=$(run_query "SELECT rowsecurity FROM pg_tables WHERE tablename = 'users' AND schemaname = 'public';")
if [ "$RLS_ENABLED" = "t" ]; then
    print_success "RLS is enabled on users table"
else
    print_failure "RLS is not enabled on users table"
fi
echo ""

# Check policies
echo "Checking RLS policies..."

# Count policies
POLICY_COUNT=$(run_query "SELECT COUNT(*) FROM pg_policies WHERE tablename = 'users' AND schemaname = 'public';")
echo "Found $POLICY_COUNT policies"
echo ""

# Check specific policies
POLICY_EXISTS=$(run_query "SELECT COUNT(*) FROM pg_policies WHERE tablename = 'users' AND policyname = 'Users can view own data';")
if [ "$POLICY_EXISTS" = "1" ]; then
    print_success "Policy 'Users can view own data' exists"
else
    print_failure "Policy 'Users can view own data' missing"
fi

POLICY_EXISTS=$(run_query "SELECT COUNT(*) FROM pg_policies WHERE tablename = 'users' AND policyname = 'Users can update own data';")
if [ "$POLICY_EXISTS" = "1" ]; then
    print_success "Policy 'Users can update own data' exists"
else
    print_failure "Policy 'Users can update own data' missing"
fi

POLICY_EXISTS=$(run_query "SELECT COUNT(*) FROM pg_policies WHERE tablename = 'users' AND policyname = 'Service role has full access';")
if [ "$POLICY_EXISTS" = "1" ]; then
    print_success "Policy 'Service role has full access' exists"
else
    print_failure "Policy 'Service role has full access' missing"
fi

POLICY_EXISTS=$(run_query "SELECT COUNT(*) FROM pg_policies WHERE tablename = 'users' AND policyname = 'Allow insert for authenticated users';")
if [ "$POLICY_EXISTS" = "1" ]; then
    print_success "Policy 'Allow insert for authenticated users' exists"
else
    print_failure "Policy 'Allow insert for authenticated users' missing"
fi
echo ""

# ==========================================
# TRIGGER FUNCTIONALITY TEST
# ==========================================
echo "=========================================="
echo "TRIGGER FUNCTIONALITY TEST"
echo "=========================================="
echo ""

echo "Testing trigger auto-update of updated_at..."

# Insert test record
TEST_UID="test-verify-$(date +%s)"
run_query "INSERT INTO public.users (firebase_uid, email, display_name) VALUES ('$TEST_UID', 'test-verify@example.com', 'Test User');" > /dev/null 2>&1

# Get timestamps
TIMESTAMPS=$(run_query "SELECT created_at, updated_at FROM public.users WHERE firebase_uid = '$TEST_UID';")
CREATED_AT=$(echo "$TIMESTAMPS" | cut -d'|' -f1)
UPDATED_AT=$(echo "$TIMESTAMPS" | cut -d'|' -f2)

if [ "$CREATED_AT" = "$UPDATED_AT" ]; then
    print_success "Initial created_at and updated_at are equal"
else
    print_failure "Initial timestamps are not equal"
fi

# Wait 2 seconds
sleep 2

# Update record
run_query "UPDATE public.users SET display_name = 'Updated Test User' WHERE firebase_uid = '$TEST_UID';" > /dev/null 2>&1

# Get new timestamps
TIMESTAMPS=$(run_query "SELECT created_at, updated_at FROM public.users WHERE firebase_uid = '$TEST_UID';")
NEW_CREATED_AT=$(echo "$TIMESTAMPS" | cut -d'|' -f1)
NEW_UPDATED_AT=$(echo "$TIMESTAMPS" | cut -d'|' -f2)

if [ "$NEW_CREATED_AT" = "$CREATED_AT" ]; then
    print_success "created_at remained unchanged after update"
else
    print_failure "created_at changed after update (should not change)"
fi

if [ "$NEW_UPDATED_AT" != "$UPDATED_AT" ]; then
    print_success "updated_at was automatically updated by trigger"
else
    print_failure "updated_at was not updated by trigger"
fi

# Clean up test record
run_query "DELETE FROM public.users WHERE firebase_uid = '$TEST_UID';" > /dev/null 2>&1
echo ""

# ==========================================
# SUMMARY
# ==========================================
echo "=========================================="
echo "VERIFICATION SUMMARY"
echo "=========================================="
echo ""
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed! Database setup is correct.${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Mark Task 6 as complete"
    echo "  2. Proceed to Task 7: Setup Firebase project and Cloud Functions"
    exit 0
else
    echo -e "${RED}✗ Some checks failed. Please review the errors above.${NC}"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Check init-scripts are mounted: docker-compose exec postgres ls -la /docker-entrypoint-initdb.d/"
    echo "  2. Check PostgreSQL logs: docker-compose logs postgres"
    echo "  3. Manually run migrations:"
    echo "     docker-compose exec postgres psql -U directus -d directus -f /docker-entrypoint-initdb.d/01-create-schema.sql"
    echo "     docker-compose exec postgres psql -U directus -d directus -f /docker-entrypoint-initdb.d/02-setup-rls.sql"
    echo "  4. See docs/TASK-6-DATABASE-VERIFICATION.md for detailed troubleshooting"
    exit 1
fi
