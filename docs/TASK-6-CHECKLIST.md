# Task 6: Database Setup Verification Checklist

## Quick Reference Checklist

Use this checklist to quickly verify database setup completion.

---

## Prerequisites

- [ ] Docker Desktop installed and running
- [ ] Docker containers started: `docker-compose up -d`
- [ ] Task 4.1 completed (schema migration script created)
- [ ] Task 5.1 completed (RLS policy script created)

---

## Step 1: Restart Containers

```bash
# Stop containers
docker-compose down

# Start containers (migrations will run automatically)
docker-compose up -d

# Wait for containers to be healthy
docker-compose ps
```

**Expected:** All containers show status "Up (healthy)"

- [ ] PostgreSQL container is Up
- [ ] Directus container is Up

---

## Step 2: Verify Schema

### Quick Verification

```bash
# Run automated verification script
./scripts/verify-database-setup.sh
# Or on Windows PowerShell:
# .\scripts\verify-database-setup.ps1
```

### Manual Verification

```bash
# Connect to PostgreSQL
docker-compose exec postgres psql -U directus -d directus
```

```sql
-- Check table exists
\dt public.users

-- Check table structure
\d public.users

-- Exit
\q
```

**Schema Checklist:**

- [ ] Table `public.users` exists
- [ ] Column `firebase_uid` is VARCHAR(128) PRIMARY KEY
- [ ] Column `email` is VARCHAR(255) UNIQUE NOT NULL
- [ ] Column `display_name` is VARCHAR(255) NULL
- [ ] Column `photo_url` is TEXT NULL
- [ ] Column `created_at` is TIMESTAMP WITH TIME ZONE
- [ ] Column `updated_at` is TIMESTAMP WITH TIME ZONE
- [ ] Index `idx_users_email` exists
- [ ] Function `update_updated_at_column` exists
- [ ] Trigger `update_users_updated_at` exists

---

## Step 3: Verify RLS Policies

```sql
-- Connect to PostgreSQL
docker-compose exec postgres psql -U directus -d directus

-- Check RLS is enabled
SELECT rowsecurity FROM pg_tables 
WHERE tablename = 'users' AND schemaname = 'public';
-- Expected: t (true)

-- List all policies
SELECT policyname, cmd FROM pg_policies 
WHERE tablename = 'users' AND schemaname = 'public';

-- Exit
\q
```

**RLS Checklist:**

- [ ] RLS is enabled on `users` table (rowsecurity = t)
- [ ] Policy "Users can view own data" exists (SELECT)
- [ ] Policy "Users can update own data" exists (UPDATE)
- [ ] Policy "Service role has full access" exists (ALL)
- [ ] Policy "Allow insert for authenticated users" exists (INSERT)

---

## Step 4: Test Trigger Functionality

```sql
-- Connect to PostgreSQL
docker-compose exec postgres psql -U directus -d directus

-- Insert test record
INSERT INTO public.users (firebase_uid, email, display_name)
VALUES ('test-123', 'test@example.com', 'Test User');

-- Check timestamps
SELECT firebase_uid, created_at, updated_at 
FROM public.users WHERE firebase_uid = 'test-123';
-- Note: created_at and updated_at should be equal

-- Wait 2 seconds, then update
SELECT pg_sleep(2);
UPDATE public.users SET display_name = 'Updated' 
WHERE firebase_uid = 'test-123';

-- Check timestamps again
SELECT firebase_uid, created_at, updated_at 
FROM public.users WHERE firebase_uid = 'test-123';
-- Note: updated_at should be later than created_at

-- Clean up
DELETE FROM public.users WHERE firebase_uid = 'test-123';

-- Exit
\q
```

**Trigger Checklist:**

- [ ] Initial created_at and updated_at are equal
- [ ] After UPDATE, created_at remains unchanged
- [ ] After UPDATE, updated_at is automatically updated

---

## Step 5: Run Database Tests

```bash
# Run database tests (if implemented)
npm run test:db-schema
npm run test:rls-policies

# Or run all tests
npm test -- --grep "database"
```

**Test Checklist:**

- [ ] Schema integrity tests pass
- [ ] RLS policy tests pass
- [ ] No errors in test output

---

## Step 6: Check Logs

```bash
# Check PostgreSQL logs for errors
docker-compose logs postgres | grep -i error

# Check Directus logs
docker-compose logs directus | grep -i error
```

**Log Checklist:**

- [ ] No errors in PostgreSQL logs
- [ ] No errors in Directus logs
- [ ] Migrations ran successfully

---

## Troubleshooting

### Issue: Migrations didn't run

**Solution:**
```bash
# Force re-run migrations
docker-compose down -v
docker-compose up -d
```

### Issue: Table doesn't exist

**Solution:**
```bash
# Manually run migration
docker-compose exec postgres psql -U directus -d directus \
  -f /docker-entrypoint-initdb.d/01-create-schema.sql
```

### Issue: RLS policies missing

**Solution:**
```bash
# Manually run RLS script
docker-compose exec postgres psql -U directus -d directus \
  -f /docker-entrypoint-initdb.d/02-setup-rls.sql
```

### Issue: Trigger not working

**Solution:**
```sql
-- Re-create trigger
DROP TRIGGER IF EXISTS update_users_updated_at ON public.users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

---

## Verification Commands Summary

```bash
# 1. Restart containers
docker-compose down && docker-compose up -d

# 2. Check container status
docker-compose ps

# 3. Run automated verification
./scripts/verify-database-setup.sh

# 4. Check PostgreSQL connection
docker-compose exec postgres pg_isready -U directus

# 5. Connect to database
docker-compose exec postgres psql -U directus -d directus

# 6. Check logs
docker-compose logs postgres
docker-compose logs directus
```

---

## Success Criteria

✅ **Task 6 is complete when:**

1. All containers are running and healthy
2. Database schema is created correctly with all columns, constraints, and indexes
3. RLS is enabled on users table
4. All 4 RLS policies exist with correct definitions
5. Trigger auto-updates updated_at timestamp
6. Automated verification script passes all checks
7. No errors in PostgreSQL or Directus logs

---

## Next Steps

After completing Task 6:

1. ✅ Mark Task 6 as complete in tasks.md
2. ➡️ Proceed to Task 7: Setup Firebase project and Cloud Functions
3. 📝 Document any issues encountered

---

## Resources

- **Detailed Guide**: [docs/TASK-6-DATABASE-VERIFICATION.md](./TASK-6-DATABASE-VERIFICATION.md)
- **Verification Scripts**:
  - Bash: `scripts/verify-database-setup.sh`
  - PowerShell: `scripts/verify-database-setup.ps1`
- **Docker Guide**: [docs/docker-verification-guide.md](./docker-verification-guide.md)

---

## Notes

- Migrations only run automatically when PostgreSQL volume is empty
- To force re-run migrations, use `docker-compose down -v`
- RLS policies use `auth.uid()` and `auth.role()` functions from Supabase
- In local PostgreSQL, these functions don't exist yet (will be added with Supabase integration)
- Policies are created but won't be fully functional until Supabase integration (Task 9)

---

**Task**: 6. Checkpoint - Verify database setup  
**Requirements**: 4.1, 4.2, 4.3, 4.6, 4.7, 5.1, 5.2, 5.3, 5.4, 5.6  
**Status**: Ready for verification
