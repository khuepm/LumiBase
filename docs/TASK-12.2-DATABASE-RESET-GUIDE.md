# Task 12.2: Database Reset Script - Implementation Guide

## Overview

This document describes the database reset scripts created for Task 12.2, which allow developers to reset the PostgreSQL database to its initial state by dropping all tables and re-running migration scripts.

## Created Files

### 1. `scripts/reset-db.sh` (Linux/Mac)
Bash script for Unix-based systems that:
- Prompts for user confirmation before proceeding
- Loads environment variables from `.env`
- Drops all tables, functions, and triggers
- Re-runs migration scripts in order
- Verifies the database setup after reset
- Provides colored output for better readability

### 2. `scripts/reset-db.ps1` (Windows PowerShell)
PowerShell script for Windows systems with identical functionality to the Bash version.

### 3. Updated `scripts/README.md`
Comprehensive documentation for all scripts including:
- Usage instructions for both platforms
- What the scripts do step-by-step
- Critical warnings about data loss
- When to use the reset scripts
- Example workflows

## Script Features

### Safety Features
- ⚠️ **Confirmation Prompt**: Requires user to type "yes" to proceed
- ⚠️ **Clear Warnings**: Displays warnings about data loss before execution
- ✅ **Error Handling**: Exits immediately on any error (`set -e` in Bash, `$ErrorActionPreference = "Stop"` in PowerShell)
- ✅ **Prerequisites Check**: Verifies Docker is running and `.env` exists

### Execution Steps

The scripts perform the following steps in order:

#### Step 1: Drop All Tables
```sql
DROP TABLE IF EXISTS public.users CASCADE;
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;
```

#### Step 2: Re-run Migration Scripts
1. Executes `init-scripts/01-create-schema.sql`:
   - Creates `public.users` table
   - Adds indexes
   - Creates triggers for auto-updating timestamps

2. Executes `init-scripts/02-setup-rls.sql`:
   - Enables Row Level Security
   - Creates RLS policies for user access control

#### Step 3: Verify Database Setup
Runs verification queries to confirm:
- Users table exists with correct column count
- RLS is enabled
- Policies are created

### Output Format

The scripts provide colored, structured output:
- 🔵 **Blue**: Section headers
- 🟢 **Green**: Success messages and configuration info
- 🟡 **Yellow**: Warnings and step descriptions
- 🔴 **Red**: Error messages

## Usage Examples

### Linux/Mac

```bash
# Make script executable (first time only)
chmod +x scripts/reset-db.sh

# Run the reset script
./scripts/reset-db.sh

# When prompted, type "yes" to confirm
Are you sure you want to continue? (yes/no): yes

# After reset, optionally seed data
./scripts/seed-data.sh

# Verify the setup
./scripts/verify-database-setup.sh
```

### Windows PowerShell

```powershell
# Run the reset script
.\scripts\reset-db.ps1

# When prompted, type "yes" to confirm
Are you sure you want to continue? (yes/no): yes

# After reset, optionally seed data
.\scripts\seed-data.ps1

# Verify the setup
.\scripts\verify-database-setup.ps1
```

## When to Use

### ✅ Good Use Cases
- Starting fresh with a clean database during development
- Testing migration scripts after modifications
- Recovering from database schema corruption
- Switching between development branches with different schemas
- Setting up a new development environment

### ❌ Do NOT Use
- **Never in production!** This will delete all data.
- When you have important test data you want to keep
- Without backing up data first (if needed)
- When other developers are actively using the database

## Workflow Integration

### Typical Development Workflow

```bash
# 1. Reset database to clean state
./scripts/reset-db.sh

# 2. Seed sample data for testing
./scripts/seed-data.sh

# 3. Verify everything is working
./scripts/verify-database-setup.sh

# 4. Start development
# ... make changes to your application ...

# 5. If needed, reset again
./scripts/reset-db.sh
```

### After Modifying Migration Scripts

```bash
# 1. Edit migration scripts
vim init-scripts/01-create-schema.sql

# 2. Reset database to apply changes
./scripts/reset-db.sh

# 3. Test the new schema
npm test

# 4. If tests pass, commit changes
git add init-scripts/ scripts/
git commit -m "feat: update database schema"
```

## Technical Details

### Environment Variables Required

The scripts require these environment variables from `.env`:
- `DB_USER`: PostgreSQL username
- `DB_PASSWORD`: PostgreSQL password
- `DB_NAME`: Database name

### Docker Container Requirements

- Container name: `directus-postgres`
- Must be running before executing the script
- Start with: `docker-compose up -d`

### Migration Scripts Location

The scripts expect migration files in:
- `init-scripts/01-create-schema.sql`
- `init-scripts/02-setup-rls.sql`

### Error Handling

Both scripts will exit immediately if:
- User doesn't confirm with "yes"
- `.env` file is missing
- Required environment variables are not set
- PostgreSQL container is not running
- Migration scripts are not found
- Any SQL command fails

## Troubleshooting

### Issue: "PostgreSQL container is not running"

**Solution:**
```bash
# Start Docker containers
docker-compose up -d

# Wait for PostgreSQL to be ready
docker-compose ps

# Try again
./scripts/reset-db.sh
```

### Issue: "Permission denied" (Linux/Mac)

**Solution:**
```bash
# Make script executable
chmod +x scripts/reset-db.sh

# Try again
./scripts/reset-db.sh
```

### Issue: ".env file not found"

**Solution:**
```bash
# Copy example file
cp .env.example .env

# Edit with your configuration
nano .env

# Try again
./scripts/reset-db.sh
```

### Issue: "Failed to drop tables"

**Solution:**
This usually means there are active connections to the database.

```bash
# Restart Directus to close connections
docker-compose restart directus

# Wait a few seconds
sleep 5

# Try again
./scripts/reset-db.sh
```

### Issue: "Failed to create schema"

**Solution:**
Check the migration script for syntax errors.

```bash
# Test SQL syntax
docker exec -i directus-postgres psql -U $DB_USER -d $DB_NAME < init-scripts/01-create-schema.sql

# Check for errors in the output
```

## Security Considerations

### Development Only
- These scripts are designed for **local development only**
- Never run in production environments
- Never commit `.env` files with real credentials

### Data Loss Prevention
- Always backup important data before running
- Use version control for migration scripts
- Test in isolated environments first

### Access Control
- Scripts require database credentials from `.env`
- Ensure `.env` is in `.gitignore`
- Use strong passwords even in development

## Related Documentation

- [Main README](../README.md) - Project overview and setup
- [Task 12.1 Summary](./TASK-12.1-SUMMARY.md) - Seed data script documentation
- [Database Verification Guide](./TASK-6-DATABASE-VERIFICATION.md) - Database verification procedures
- [Scripts README](../scripts/README.md) - All available scripts

## Requirements Validation

This implementation satisfies the following requirements:

### Requirement 9.5: Database Reset Scripts
✅ Script drops all tables  
✅ Script recreates database schema  
✅ Script re-runs migrations  
✅ Script is documented  

### Requirement 11.1: Git Workflow
✅ Changes committed with descriptive message  
✅ Task number included in commit message  

### Requirement 11.2: Commit Message Format
✅ Uses conventional commit format: `feat(task-12.2): add database reset script`  

### Requirement 11.3: Push to Remote
✅ Changes pushed to remote repository  

### Requirement 11.7: Commit Message Format
✅ Follows format: "feat(task-X): [description]"  

## Testing

### Manual Testing Steps

1. **Test Prerequisites Check:**
   ```bash
   # Stop Docker
   docker-compose down
   
   # Try to run script (should fail with clear error)
   ./scripts/reset-db.sh
   ```

2. **Test Confirmation Prompt:**
   ```bash
   # Start Docker
   docker-compose up -d
   
   # Run script and type "no"
   ./scripts/reset-db.sh
   # Should exit without making changes
   ```

3. **Test Full Reset:**
   ```bash
   # Seed some data first
   ./scripts/seed-data.sh
   
   # Verify data exists
   docker exec directus-postgres psql -U directus -d directus -c "SELECT COUNT(*) FROM public.users;"
   
   # Reset database
   ./scripts/reset-db.sh
   # Type "yes" to confirm
   
   # Verify data is gone
   docker exec directus-postgres psql -U directus -d directus -c "SELECT COUNT(*) FROM public.users;"
   # Should return 0
   ```

4. **Test Migration Re-run:**
   ```bash
   # After reset, verify schema exists
   docker exec directus-postgres psql -U directus -d directus -c "\d public.users"
   
   # Verify RLS is enabled
   docker exec directus-postgres psql -U directus -d directus -c "SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = 'users';"
   ```

### Automated Testing

The reset functionality is tested indirectly by:
- Database schema tests (verify schema after reset)
- RLS policy tests (verify policies after reset)
- Integration tests (verify full system after reset)

## Future Enhancements

Potential improvements for future versions:

1. **Backup Before Reset**: Automatically create a backup before dropping tables
2. **Selective Reset**: Option to reset only specific tables
3. **Dry Run Mode**: Show what would be done without actually doing it
4. **Rollback Support**: Ability to undo a reset operation
5. **Progress Indicators**: Show progress for long-running operations
6. **Log File**: Save reset operations to a log file
7. **Interactive Mode**: Ask which migration scripts to run

## Conclusion

The database reset scripts provide a safe, reliable way to reset the development database to a clean state. With proper confirmation prompts, error handling, and clear documentation, developers can confidently use these scripts to maintain their local development environment.

---

**Task Status**: ✅ Completed  
**Created**: Task 12.2  
**Requirements**: 9.5, 11.1, 11.2, 11.3, 11.7  
**Related Tasks**: 12.1 (Seed Data), 4.1 (Schema Migration), 5.1 (RLS Setup)
