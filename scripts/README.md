# Scripts Documentation

This directory contains utility scripts for database management and verification.

## 📋 Available Scripts

### 1. Seed Data Scripts

Add sample users to the database for development and testing.

#### `seed-data.sh` (Linux/Mac)

**Usage:**
```bash
# Make executable
chmod +x scripts/seed-data.sh

# Run script
./scripts/seed-data.sh
```

#### `seed-data.ps1` (Windows PowerShell)

**Usage:**
```powershell
# Run script
.\scripts\seed-data.ps1
```

#### `seed-data.ts` (Cross-platform TypeScript)

**Usage:**
```bash
# Using npm script (recommended)
npm run seed-data

# Or directly with tsx
npx tsx scripts/seed-data.ts
```

**What it does:**
- ✅ Loads environment variables from `.env`
- ✅ Connects to PostgreSQL database
- ✅ Inserts 5 sample users (or updates if they already exist)
- ✅ Displays all users in the database

**Sample Users:**
1. `alice@example.com` - Alice Johnson
2. `bob@example.com` - Bob Smith
3. `charlie@example.com` - Charlie Brown
4. `diana@example.com` - Diana Prince
5. `eve@example.com` - Eve Wilson

**Requirements:**
- Docker containers must be running (`docker-compose up -d`)
- `.env` file must be configured with database credentials
- For TypeScript version: `tsx` and `dotenv` packages installed

**⚠️ Important Notes:**
- These are test users for **development only**
- In production, users should be created via Firebase Authentication
- Cloud Functions will automatically sync Firebase users to Supabase
- The script uses `ON CONFLICT` to safely update existing users

---

### 2. Database Verification Scripts

Verify database schema and Row Level Security policies.

#### `verify-database-setup.sh` (Linux/Mac)

**Usage:**
```bash
chmod +x scripts/verify-database-setup.sh
./scripts/verify-database-setup.sh
```

#### `verify-database-setup.ps1` (Windows PowerShell)

**Usage:**
```powershell
.\scripts\verify-database-setup.ps1
```

**What it verifies:**
- ✅ Docker containers are running
- ✅ Database schema (tables, columns, constraints)
- ✅ Indexes on firebase_uid and email
- ✅ RLS policies are enabled and configured
- ✅ Trigger for auto-updating timestamps

---

### 3. Database Reset Scripts

Reset database to initial state by dropping all tables and re-running migrations.

#### `reset-db.sh` (Linux/Mac)

**Usage:**
```bash
# Make executable
chmod +x scripts/reset-db.sh

# Run script
./scripts/reset-db.sh
```

#### `reset-db.ps1` (Windows PowerShell)

**Usage:**
```powershell
# Run script
.\scripts\reset-db.ps1
```

**What it does:**
- ⚠️ **Prompts for confirmation** (requires typing "yes" to proceed)
- ✅ Drops all tables in the database
- ✅ Drops functions and triggers
- ✅ Re-runs migration script `01-create-schema.sql`
- ✅ Re-runs RLS setup script `02-setup-rls.sql`
- ✅ Verifies database setup after reset
- ✅ Displays summary and next steps

**⚠️ CRITICAL WARNING:**
- **ALL DATA WILL BE LOST!** This script drops all tables and recreates them from scratch.
- This is intended for **development only** - never run in production!
- Always backup important data before running this script.
- The script will prompt for confirmation before proceeding.

**When to use:**
- When you need to start fresh with a clean database
- After modifying migration scripts and want to test them
- When database schema gets corrupted during development
- When switching between different development branches

**Requirements:**
- Docker containers must be running (`docker-compose up -d`)
- `.env` file must be configured with database credentials
- Migration scripts must exist in `init-scripts/` directory

**Example workflow:**
```bash
# Reset database
./scripts/reset-db.sh

# Seed sample data
./scripts/seed-data.sh

# Verify everything is working
./scripts/verify-database-setup.sh
```

---

## 🔧 Troubleshooting

### Common Issues

#### "Docker is not running"
**Solution:** Start Docker Desktop and wait for it to fully initialize.

#### "PostgreSQL container is not running"
**Solution:**
```bash
docker-compose up -d
docker-compose ps
```

#### "Permission denied" (Linux/Mac)
**Solution:**
```bash
chmod +x scripts/seed-data.sh
```

#### ".env file not found"
**Solution:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

#### "Connection refused" or "Database connection error"
**Solution:**
1. Verify PostgreSQL is running:
   ```bash
   docker-compose ps
   ```
2. Check database credentials in `.env`:
   - `DB_USER`
   - `DB_PASSWORD`
   - `DB_NAME`
3. Test connection manually:
   ```bash
   docker-compose exec postgres psql -U directus -d directus
   ```

#### TypeScript script fails with "Cannot find module"
**Solution:**
```bash
npm install
# or
npm install dotenv tsx pg @types/pg --save-dev
```

---

## 📝 Script Development Guidelines

When creating new scripts:

1. **Provide both Bash and PowerShell versions** for cross-platform support
2. **Use colors** for better readability (green for success, red for errors, yellow for warnings)
3. **Check prerequisites** before running (Docker, .env file, etc.)
4. **Handle errors gracefully** with clear error messages
5. **Document usage** in this README
6. **Add comments** to explain complex logic
7. **Use `set -e`** in Bash scripts to exit on error
8. **Use `$ErrorActionPreference = "Stop"`** in PowerShell scripts

---

## 🔐 Security Notes

- **Never commit** `.env` files to Git
- **Never hardcode** credentials in scripts
- **Always use** environment variables for sensitive data
- **Be careful** with service role keys - they bypass RLS
- **Test scripts** in development before using in production

---

## 📚 Related Documentation

- [Main README](../README.md) - Project overview and setup
- [Database Verification Guide](../docs/TASK-6-DATABASE-VERIFICATION.md) - Detailed database verification
- [Docker Verification Guide](../docs/docker-verification-guide.md) - Docker setup verification
- [Supabase Setup Guide](../docs/supabase-project-setup-guide.md) - Supabase configuration

---

## 🤝 Contributing

When adding new scripts:

1. Create both Bash and PowerShell versions
2. Add TypeScript version if applicable
3. Update this README with usage instructions
4. Test on multiple platforms if possible
5. Follow existing script patterns and conventions

---

Made with ❤️ for LumiBase
