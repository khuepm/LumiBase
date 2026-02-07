# Seed Data Script for Directus-Firebase-Supabase Setup
# This script adds sample users to the PostgreSQL database

# Stop on errors
$ErrorActionPreference = "Stop"

Write-Host "=== Seed Data Script ===" -ForegroundColor Green
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

# Sample users data
Write-Host "Seeding sample users..." -ForegroundColor Yellow

# SQL to insert sample users
$sqlScript = @"
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
"@

# Execute SQL script
try {
    $sqlScript | docker exec -i directus-postgres psql -U $env:DB_USER -d $env:DB_NAME
    
    Write-Host ""
    Write-Host "✓ Successfully seeded sample users!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Sample users created:" -ForegroundColor Green
    Write-Host "  1. alice@example.com (Alice Johnson)"
    Write-Host "  2. bob@example.com (Bob Smith)"
    Write-Host "  3. charlie@example.com (Charlie Brown)"
    Write-Host "  4. diana@example.com (Diana Prince)"
    Write-Host "  5. eve@example.com (Eve Wilson)"
    Write-Host ""
    Write-Host "Note: These are test users for development only." -ForegroundColor Yellow
    Write-Host "In production, users should be created via Firebase Authentication." -ForegroundColor Yellow
} catch {
    Write-Host ""
    Write-Host "✗ Failed to seed data!" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
