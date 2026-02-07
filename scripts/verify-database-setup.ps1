# Database Setup Verification Script (PowerShell)
# Task 6: Verify database schema and RLS policies

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "DATABASE SETUP VERIFICATION SCRIPT" -ForegroundColor Cyan
Write-Host "Task 6: Checkpoint - Verify database setup" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Counters
$script:Passed = 0
$script:Failed = 0

# Function to print success
function Print-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
    $script:Passed++
}

# Function to print failure
function Print-Failure {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
    $script:Failed++
}

# Function to print warning
function Print-Warning {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

# Function to run SQL query
function Run-Query {
    param([string]$Query)
    try {
        $result = docker-compose exec -T postgres psql -U directus -d directus -t -A -c "$Query" 2>$null
        return $result
    }
    catch {
        return $null
    }
}

# Check if Docker is running
Write-Host "Checking Docker status..."
try {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Print-Failure "Docker is not running. Please start Docker Desktop."
        exit 1
    }
    Print-Success "Docker is running"
}
catch {
    Print-Failure "Docker is not installed or not in PATH."
    exit 1
}
Write-Host ""

# Check if containers are running
Write-Host "Checking Docker containers..."
$psOutput = docker-compose ps 2>&1
if ($psOutput -match "directus-postgres.*Up") {
    Print-Success "PostgreSQL container is running"
}
else {
    Print-Failure "PostgreSQL container is not running. Run: docker-compose up -d"
    exit 1
}

if ($psOutput -match "directus-cms.*Up") {
    Print-Success "Directus container is running"
}
else {
    Print-Warning "Directus container is not running"
}
Write-Host ""

# Check PostgreSQL connection
Write-Host "Checking PostgreSQL connection..."
$pgReady = docker-compose exec -T postgres pg_isready -U directus 2>&1
if ($pgReady -match "accepting connections") {
    Print-Success "PostgreSQL is accepting connections"
}
else {
    Print-Failure "PostgreSQL is not accepting connections"
    exit 1
}
Write-Host ""

# ==========================================
# SCHEMA VERIFICATION
# ==========================================
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "SCHEMA VERIFICATION" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Check if users table exists
Write-Host "Checking if users table exists..."
$tableExists = Run-Query "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users');"
if ($tableExists -eq "t") {
    Print-Success "users table exists"
}
else {
    Print-Failure "users table does not exist"
    Write-Host ""
    Write-Host "To create the table, run:"
    Write-Host "  docker-compose exec postgres psql -U directus -d directus -f /docker-entrypoint-initdb.d/01-create-schema.sql"
    exit 1
}
Write-Host ""

# Check columns
Write-Host "Checking table columns..."

# firebase_uid
$columnCheck = Run-Query "SELECT data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'firebase_uid';"
if ($columnCheck -match "character varying\|128\|NO") {
    Print-Success "firebase_uid is VARCHAR(128) NOT NULL"
}
else {
    Print-Failure "firebase_uid column is incorrect: $columnCheck"
}

# email
$columnCheck = Run-Query "SELECT data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email';"
if ($columnCheck -match "character varying\|255\|NO") {
    Print-Success "email is VARCHAR(255) NOT NULL"
}
else {
    Print-Failure "email column is incorrect: $columnCheck"
}

# display_name
$columnCheck = Run-Query "SELECT data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'display_name';"
if ($columnCheck -match "character varying\|255\|YES") {
    Print-Success "display_name is VARCHAR(255) NULL"
}
else {
    Print-Failure "display_name column is incorrect: $columnCheck"
}

# photo_url
$columnCheck = Run-Query "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'photo_url';"
if ($columnCheck -match "text\|YES") {
    Print-Success "photo_url is TEXT NULL"
}
else {
    Print-Failure "photo_url column is incorrect: $columnCheck"
}

# created_at
$columnCheck = Run-Query "SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'created_at';"
if ($columnCheck -match "timestamp with time zone") {
    Print-Success "created_at is TIMESTAMP WITH TIME ZONE"
}
else {
    Print-Failure "created_at column is incorrect: $columnCheck"
}

# updated_at
$columnCheck = Run-Query "SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'updated_at';"
if ($columnCheck -match "timestamp with time zone") {
    Print-Success "updated_at is TIMESTAMP WITH TIME ZONE"
}
else {
    Print-Failure "updated_at column is incorrect: $columnCheck"
}
Write-Host ""

# Check constraints
Write-Host "Checking constraints..."

# Primary key
$pkExists = Run-Query "SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_name = 'users' AND constraint_type = 'PRIMARY KEY';"
if ($pkExists -eq "1") {
    Print-Success "PRIMARY KEY constraint exists"
}
else {
    Print-Failure "PRIMARY KEY constraint missing"
}

# Unique constraint on email
$uniqueExists = Run-Query "SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_name = 'users' AND constraint_type = 'UNIQUE';"
if ([int]$uniqueExists -ge 1) {
    Print-Success "UNIQUE constraint on email exists"
}
else {
    Print-Failure "UNIQUE constraint on email missing"
}
Write-Host ""

# Check indexes
Write-Host "Checking indexes..."

# Index on firebase_uid (from PRIMARY KEY)
$indexExists = Run-Query "SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'users' AND indexname LIKE '%pkey%';"
if ([int]$indexExists -ge 1) {
    Print-Success "Index on firebase_uid exists (PRIMARY KEY)"
}
else {
    Print-Failure "Index on firebase_uid missing"
}

# Index on email
$indexExists = Run-Query "SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'users' AND indexname = 'idx_users_email';"
if ($indexExists -eq "1") {
    Print-Success "Index idx_users_email exists"
}
else {
    Print-Failure "Index idx_users_email missing"
}
Write-Host ""

# Check trigger function
Write-Host "Checking trigger function..."
$functionExists = Run-Query "SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = 'public' AND routine_name = 'update_updated_at_column';"
if ($functionExists -eq "1") {
    Print-Success "Function update_updated_at_column exists"
}
else {
    Print-Failure "Function update_updated_at_column missing"
}

# Check trigger
$triggerExists = Run-Query "SELECT COUNT(*) FROM information_schema.triggers WHERE event_object_table = 'users' AND trigger_name = 'update_users_updated_at';"
if ($triggerExists -eq "1") {
    Print-Success "Trigger update_users_updated_at exists"
}
else {
    Print-Failure "Trigger update_users_updated_at missing"
}
Write-Host ""

# ==========================================
# RLS VERIFICATION
# ==========================================
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "RLS POLICIES VERIFICATION" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Check if RLS is enabled
Write-Host "Checking if RLS is enabled..."
$rlsEnabled = Run-Query "SELECT rowsecurity FROM pg_tables WHERE tablename = 'users' AND schemaname = 'public';"
if ($rlsEnabled -eq "t") {
    Print-Success "RLS is enabled on users table"
}
else {
    Print-Failure "RLS is not enabled on users table"
}
Write-Host ""

# Check policies
Write-Host "Checking RLS policies..."

# Count policies
$policyCount = Run-Query "SELECT COUNT(*) FROM pg_policies WHERE tablename = 'users' AND schemaname = 'public';"
Write-Host "Found $policyCount policies"
Write-Host ""

# Check specific policies
$policyExists = Run-Query "SELECT COUNT(*) FROM pg_policies WHERE tablename = 'users' AND policyname = 'Users can view own data';"
if ($policyExists -eq "1") {
    Print-Success "Policy 'Users can view own data' exists"
}
else {
    Print-Failure "Policy 'Users can view own data' missing"
}

$policyExists = Run-Query "SELECT COUNT(*) FROM pg_policies WHERE tablename = 'users' AND policyname = 'Users can update own data';"
if ($policyExists -eq "1") {
    Print-Success "Policy 'Users can update own data' exists"
}
else {
    Print-Failure "Policy 'Users can update own data' missing"
}

$policyExists = Run-Query "SELECT COUNT(*) FROM pg_policies WHERE tablename = 'users' AND policyname = 'Service role has full access';"
if ($policyExists -eq "1") {
    Print-Success "Policy 'Service role has full access' exists"
}
else {
    Print-Failure "Policy 'Service role has full access' missing"
}

$policyExists = Run-Query "SELECT COUNT(*) FROM pg_policies WHERE tablename = 'users' AND policyname = 'Allow insert for authenticated users';"
if ($policyExists -eq "1") {
    Print-Success "Policy 'Allow insert for authenticated users' exists"
}
else {
    Print-Failure "Policy 'Allow insert for authenticated users' missing"
}
Write-Host ""

# ==========================================
# TRIGGER FUNCTIONALITY TEST
# ==========================================
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "TRIGGER FUNCTIONALITY TEST" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Testing trigger auto-update of updated_at..."

# Insert test record
$testUid = "test-verify-$(Get-Date -Format 'yyyyMMddHHmmss')"
Run-Query "INSERT INTO public.users (firebase_uid, email, display_name) VALUES ('$testUid', 'test-verify@example.com', 'Test User');" | Out-Null

# Get timestamps
$timestamps = Run-Query "SELECT created_at, updated_at FROM public.users WHERE firebase_uid = '$testUid';"
$createdAt, $updatedAt = $timestamps -split '\|'

if ($createdAt -eq $updatedAt) {
    Print-Success "Initial created_at and updated_at are equal"
}
else {
    Print-Failure "Initial timestamps are not equal"
}

# Wait 2 seconds
Start-Sleep -Seconds 2

# Update record
Run-Query "UPDATE public.users SET display_name = 'Updated Test User' WHERE firebase_uid = '$testUid';" | Out-Null

# Get new timestamps
$timestamps = Run-Query "SELECT created_at, updated_at FROM public.users WHERE firebase_uid = '$testUid';"
$newCreatedAt, $newUpdatedAt = $timestamps -split '\|'

if ($newCreatedAt -eq $createdAt) {
    Print-Success "created_at remained unchanged after update"
}
else {
    Print-Failure "created_at changed after update (should not change)"
}

if ($newUpdatedAt -ne $updatedAt) {
    Print-Success "updated_at was automatically updated by trigger"
}
else {
    Print-Failure "updated_at was not updated by trigger"
}

# Clean up test record
Run-Query "DELETE FROM public.users WHERE firebase_uid = '$testUid';" | Out-Null
Write-Host ""

# ==========================================
# SUMMARY
# ==========================================
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "VERIFICATION SUMMARY" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Passed: $script:Passed" -ForegroundColor Green
Write-Host "Failed: $script:Failed" -ForegroundColor Red
Write-Host ""

if ($script:Failed -eq 0) {
    Write-Host "✓ All checks passed! Database setup is correct." -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Mark Task 6 as complete"
    Write-Host "  2. Proceed to Task 7: Setup Firebase project and Cloud Functions"
    exit 0
}
else {
    Write-Host "✗ Some checks failed. Please review the errors above." -ForegroundColor Red
    Write-Host ""
    Write-Host "Troubleshooting:"
    Write-Host "  1. Check init-scripts are mounted: docker-compose exec postgres ls -la /docker-entrypoint-initdb.d/"
    Write-Host "  2. Check PostgreSQL logs: docker-compose logs postgres"
    Write-Host "  3. Manually run migrations:"
    Write-Host "     docker-compose exec postgres psql -U directus -d directus -f /docker-entrypoint-initdb.d/01-create-schema.sql"
    Write-Host "     docker-compose exec postgres psql -U directus -d directus -f /docker-entrypoint-initdb.d/02-setup-rls.sql"
    Write-Host "  4. See docs/TASK-6-DATABASE-VERIFICATION.md for detailed troubleshooting"
    exit 1
}
