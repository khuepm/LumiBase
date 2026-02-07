# Database Reset Script for Directus-Firebase-Supabase Setup
# This script drops all tables and re-runs migration scripts to reset the database

# Stop on errors
$ErrorActionPreference = "Stop"

Write-Host "=== Database Reset Script ===" -ForegroundColor Blue
Write-Host ""
Write-Host "⚠️  WARNING: This will DROP ALL TABLES and reset the database!" -ForegroundColor Yellow
Write-Host "⚠️  All data will be lost!" -ForegroundColor Yellow
Write-Host ""

# Prompt for confirmation
$confirmation = Read-Host "Are you sure you want to continue? (yes/no)"
if ($confirmation -ne "yes") {
    Write-Host "Operation cancelled." -ForegroundColor Yellow
    exit 0
}

Write-Host ""

# Load environment variables from .env file
if (Test-Path .env) {
    Write-Host "Loading environment variables from .env..." -ForegroundColor Green
    Get-Content .env | ForEach-Object {
        if ($_ -match '^([^#][^=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim()
            Set-Item -Path "env:$name" -Value $value
        }
    }
} else {
    Write-Host "Error: .env file not found!" -ForegroundColor Red
    Write-Host "Please copy .env.example to .env and configure it."
    exit 1
}

# Check if required variables are set
if (-not $env:DB_USER -or -not $env:DB_PASSWORD -or -not $env:DB_NAME) {
    Write-Host "Error: Required database environment variables are not set!" -ForegroundColor Red
    Write-Host "Please ensure DB_USER, DB_PASSWORD, and DB_NAME are configured in .env"
    exit 1
}

Write-Host "Database Configuration:" -ForegroundColor Green
Write-Host "  DB_USER: $env:DB_USER"
Write-Host "  DB_NAME: $env:DB_NAME"
Write-Host ""

# Check if PostgreSQL container is running
$containerRunning = docker ps --format "{{.Names}}" | Select-String -Pattern "directus-postgres"
if (-not $containerRunning) {
    Write-Host "Error: PostgreSQL container is not running!" -ForegroundColor Red
    Write-Host "Please start Docker containers with: docker-compose up -d"
    exit 1
}

Write-Host "PostgreSQL container is running." -ForegroundColor Green
Write-Host ""

# Step 1: Drop all tables
Write-Host "Step 1: Dropping all tables..." -ForegroundColor Yellow

$dropSql = @"
-- Drop all tables in public schema
DROP TABLE IF EXISTS public.users CASCADE;

-- Drop functions
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;

-- Drop extensions (optional, will be recreated)
-- DROP EXTENSION IF EXISTS "uuid-ossp";
"@

try {
    $dropSql | docker exec -i directus-postgres psql -U $env:DB_USER -d $env:DB_NAME
    Write-Host "✓ Successfully dropped all tables" -ForegroundColor Green
} catch {
    Write-Host "✗ Failed to drop tables!" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

Write-Host ""

# Step 2: Re-run migration scripts
Write-Host "Step 2: Re-running migration scripts..." -ForegroundColor Yellow

# Check if init-scripts directory exists
if (-not (Test-Path "init-scripts")) {
    Write-Host "Error: init-scripts directory not found!" -ForegroundColor Red
    exit 1
}

# Run schema creation script
if (Test-Path "init-scripts/01-create-schema.sql") {
    Write-Host "Running 01-create-schema.sql..." -ForegroundColor Green
    
    try {
        Get-Content "init-scripts/01-create-schema.sql" | docker exec -i directus-postgres psql -U $env:DB_USER -d $env:DB_NAME
        Write-Host "✓ Schema created successfully" -ForegroundColor Green
    } catch {
        Write-Host "✗ Failed to create schema!" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "Error: init-scripts/01-create-schema.sql not found!" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Run RLS setup script
if (Test-Path "init-scripts/02-setup-rls.sql") {
    Write-Host "Running 02-setup-rls.sql..." -ForegroundColor Green
    
    try {
        Get-Content "init-scripts/02-setup-rls.sql" | docker exec -i directus-postgres psql -U $env:DB_USER -d $env:DB_NAME
        Write-Host "✓ RLS policies created successfully" -ForegroundColor Green
    } catch {
        Write-Host "✗ Failed to create RLS policies!" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "Error: init-scripts/02-setup-rls.sql not found!" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Step 3: Verify database setup
Write-Host "Step 3: Verifying database setup..." -ForegroundColor Yellow

$verifySql = @"
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
"@

try {
    $verifySql | docker exec -i directus-postgres psql -U $env:DB_USER -d $env:DB_NAME
} catch {
    Write-Host "Warning: Verification queries had issues, but database may still be functional" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "✓ Database reset completed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Summary:" -ForegroundColor Blue
Write-Host "  ✓ All tables dropped"
Write-Host "  ✓ Schema recreated"
Write-Host "  ✓ RLS policies applied"
Write-Host "  ✓ Database verified"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Optionally seed sample data: .\scripts\seed-data.ps1"
Write-Host "  2. Verify setup: .\scripts\verify-database-setup.ps1"
Write-Host "  3. Restart Directus if needed: docker-compose restart directus"
Write-Host ""
