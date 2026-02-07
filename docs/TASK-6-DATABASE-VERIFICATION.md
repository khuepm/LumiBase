# Task 6: Database Setup Verification Guide

## Mục đích

Task 6 là checkpoint quan trọng để verify rằng database schema và RLS policies đã được apply đúng cách trước khi tiếp tục với Firebase setup. Tài liệu này cung cấp hướng dẫn chi tiết và scripts để thực hiện verification.

## Yêu cầu

- ✅ Docker Desktop đã được cài đặt và đang chạy
- ✅ Docker containers đã được start (Task 3 completed)
- ✅ Database migration scripts đã được tạo (Task 4.1 completed)
- ✅ RLS policy scripts đã được tạo (Task 5.1 completed)

## Verification Steps

### Step 1: Restart Docker Containers để Apply Migrations

Khi PostgreSQL container khởi động, nó sẽ tự động chạy tất cả SQL scripts trong thư mục `init-scripts/` (được mount vào `/docker-entrypoint-initdb.d`).

```bash
# Stop containers
docker-compose down

# Start containers (migrations sẽ chạy tự động)
docker-compose up -d

# Wait for containers to be healthy
docker-compose ps
```

**Expected Output:**
```
NAME               STATUS         PORTS
directus-cms       Up (healthy)   0.0.0.0:8055->8055/tcp
directus-postgres  Up (healthy)   0.0.0.0:5432->5432/tcp
```

**⚠️ Important:** Nếu đây không phải lần đầu start containers, migrations có thể đã chạy rồi. PostgreSQL chỉ chạy init scripts khi database volume trống.

**To force re-run migrations:**
```bash
# Stop và xóa volumes
docker-compose down -v

# Start lại (migrations sẽ chạy)
docker-compose up -d
```

### Step 2: Verify Schema được tạo đúng trong PostgreSQL

#### 2.1 Connect vào PostgreSQL

```bash
docker-compose exec postgres psql -U directus -d directus
```

#### 2.2 Verify bảng users tồn tại

```sql
-- List all tables
\dt public.*

-- Expected output:
--          List of relations
--  Schema |  Name  | Type  |  Owner
-- --------+--------+-------+----------
--  public | users  | table | directus
```

#### 2.3 Verify schema structure

```sql
-- Describe users table
\d public.users
```

**Expected Output:**
```
                Table "public.users"
    Column     |            Type             | Collation | Nullable |      Default
---------------+-----------------------------+-----------+----------+-------------------
 firebase_uid  | character varying(128)      |           | not null |
 email         | character varying(255)      |           | not null |
 display_name  | character varying(255)      |           |          |
 photo_url     | text                        |           |          |
 created_at    | timestamp with time zone    |           |          | now()
 updated_at    | timestamp with time zone    |           |          | now()
Indexes:
    "users_pkey" PRIMARY KEY, btree (firebase_uid)
    "users_email_key" UNIQUE CONSTRAINT, btree (email)
    "idx_users_email" btree (email)
Triggers:
    update_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
```

**✅ Verify Checklist:**
- [ ] firebase_uid là VARCHAR(128) và PRIMARY KEY
- [ ] email là VARCHAR(255), UNIQUE, NOT NULL
- [ ] display_name là VARCHAR(255), nullable
- [ ] photo_url là TEXT, nullable
- [ ] created_at và updated_at có DEFAULT now()
- [ ] Index idx_users_email tồn tại
- [ ] Trigger update_users_updated_at tồn tại

#### 2.4 Verify constraints

```sql
-- Check constraints
SELECT
    tc.constraint_name,
    tc.constraint_type,
    kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
WHERE tc.table_name = 'users'
    AND tc.table_schema = 'public'
ORDER BY tc.constraint_type, kcu.column_name;
```

**Expected Output:**
```
   constraint_name    | constraint_type | column_name
----------------------+-----------------+--------------
 users_pkey           | PRIMARY KEY     | firebase_uid
 users_email_key      | UNIQUE          | email
```

#### 2.5 Verify indexes

```sql
-- Check indexes
SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'users'
    AND schemaname = 'public';
```

**Expected Output:**
```
    indexname     |                           indexdef
------------------+--------------------------------------------------------------
 users_pkey       | CREATE UNIQUE INDEX users_pkey ON public.users USING btree (firebase_uid)
 users_email_key  | CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)
 idx_users_email  | CREATE INDEX idx_users_email ON public.users USING btree (email)
```

#### 2.6 Verify trigger function

```sql
-- Check trigger function exists
SELECT
    routine_name,
    routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
    AND routine_name = 'update_updated_at_column';
```

**Expected Output:**
```
      routine_name       | routine_type
-------------------------+--------------
 update_updated_at_column | FUNCTION
```

#### 2.7 Test trigger functionality

```sql
-- Insert test data
INSERT INTO public.users (firebase_uid, email, display_name)
VALUES ('test-uid-123', 'test@example.com', 'Test User');

-- Check created_at and updated_at
SELECT firebase_uid, email, created_at, updated_at
FROM public.users
WHERE firebase_uid = 'test-uid-123';

-- Wait a moment, then update
SELECT pg_sleep(2);

UPDATE public.users
SET display_name = 'Updated Test User'
WHERE firebase_uid = 'test-uid-123';

-- Verify updated_at changed
SELECT firebase_uid, email, created_at, updated_at
FROM public.users
WHERE firebase_uid = 'test-uid-123';

-- Clean up test data
DELETE FROM public.users WHERE firebase_uid = 'test-uid-123';
```

**✅ Expected:** updated_at should be later than created_at after the UPDATE.

### Step 3: Verify RLS Policies được Enable

#### 3.1 Check RLS is enabled

```sql
-- Check if RLS is enabled on users table
SELECT
    schemaname,
    tablename,
    rowsecurity
FROM pg_tables
WHERE tablename = 'users'
    AND schemaname = 'public';
```

**Expected Output:**
```
 schemaname | tablename | rowsecurity
------------+-----------+-------------
 public     | users     | t
```

**✅ rowsecurity = 't' (true)** means RLS is enabled!

#### 3.2 List all RLS policies

```sql
-- List all policies on users table
SELECT
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE tablename = 'users'
    AND schemaname = 'public'
ORDER BY policyname;
```

**Expected Output:**
```
 schemaname | tablename |          policyname           | permissive |  roles   | cmd
------------+-----------+-------------------------------+------------+----------+--------
 public     | users     | Allow insert for authenticated| PERMISSIVE | {public} | INSERT
 public     | users     | Service role has full access  | PERMISSIVE | {public} | ALL
 public     | users     | Users can update own data     | PERMISSIVE | {public} | UPDATE
 public     | users     | Users can view own data       | PERMISSIVE | {public} | SELECT
```

**✅ Verify Checklist:**
- [ ] "Users can view own data" policy exists (SELECT)
- [ ] "Users can update own data" policy exists (UPDATE)
- [ ] "Service role has full access" policy exists (ALL)
- [ ] "Allow insert for authenticated users" policy exists (INSERT)

#### 3.3 Verify policy definitions

```sql
-- Get detailed policy information
SELECT
    pol.polname AS policy_name,
    CASE pol.polcmd
        WHEN 'r' THEN 'SELECT'
        WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE'
        WHEN 'd' THEN 'DELETE'
        WHEN '*' THEN 'ALL'
    END AS command,
    pg_get_expr(pol.polqual, pol.polrelid) AS using_expression,
    pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check_expression
FROM pg_policy pol
JOIN pg_class pc ON pol.polrelid = pc.oid
JOIN pg_namespace pn ON pc.relnamespace = pn.oid
WHERE pc.relname = 'users'
    AND pn.nspname = 'public'
ORDER BY pol.polname;
```

**Expected Policies:**

1. **Users can view own data** (SELECT)
   - USING: `(auth.uid() = firebase_uid)`

2. **Users can update own data** (UPDATE)
   - USING: `(auth.uid() = firebase_uid)`
   - WITH CHECK: `(auth.uid() = firebase_uid)`

3. **Service role has full access** (ALL)
   - USING: `(auth.role() = 'service_role'::text)`

4. **Allow insert for authenticated users** (INSERT)
   - WITH CHECK: `(auth.uid() = firebase_uid)`

### Step 4: Test RLS Policies (Manual Testing)

**⚠️ Note:** RLS policies sử dụng `auth.uid()` và `auth.role()` functions từ Supabase. Trong local PostgreSQL setup, các functions này chưa được định nghĩa. Testing RLS policies đầy đủ sẽ được thực hiện trong Task 9 khi integrate với Supabase.

Tuy nhiên, bạn có thể verify policies đã được tạo đúng cách bằng các queries ở Step 3.

### Step 5: Run Database Tests

Chạy automated tests để verify database setup:

```bash
# Run database schema tests
npm run test:db-schema

# Run RLS policy tests
npm run test:rls-policies

# Run all database tests
npm test -- --grep "database"
```

**Expected Output:**
```
✓ Database schema integrity
  ✓ users table exists
  ✓ firebase_uid is VARCHAR(128) PRIMARY KEY
  ✓ email is VARCHAR(255) UNIQUE NOT NULL
  ✓ indexes exist on firebase_uid and email
  ✓ trigger auto-updates updated_at

✓ RLS policies
  ✓ RLS is enabled on users table
  ✓ Users can view own data policy exists
  ✓ Users can update own data policy exists
  ✓ Service role has full access policy exists
  ✓ Allow insert policy exists

12 passing
```

## Verification Checklist

Đánh dấu ✅ khi hoàn thành:

### Docker & Containers
- [ ] Docker containers đã được restart: `docker-compose down && docker-compose up -d`
- [ ] Tất cả containers có status "Up (healthy)": `docker-compose ps`
- [ ] PostgreSQL accepting connections: `pg_isready -U directus`

### Database Schema
- [ ] Bảng public.users tồn tại
- [ ] firebase_uid là VARCHAR(128) PRIMARY KEY
- [ ] email là VARCHAR(255) UNIQUE NOT NULL
- [ ] display_name là VARCHAR(255) nullable
- [ ] photo_url là TEXT nullable
- [ ] created_at và updated_at có DEFAULT now()
- [ ] Index idx_users_email tồn tại
- [ ] Trigger update_users_updated_at tồn tại và hoạt động

### RLS Policies
- [ ] RLS được enable trên bảng users (rowsecurity = true)
- [ ] Policy "Users can view own data" tồn tại (SELECT)
- [ ] Policy "Users can update own data" tồn tại (UPDATE)
- [ ] Policy "Service role has full access" tồn tại (ALL)
- [ ] Policy "Allow insert for authenticated users" tồn tại (INSERT)
- [ ] Tất cả policies có correct USING và WITH CHECK expressions

### Tests
- [ ] Database schema tests pass
- [ ] RLS policy tests pass
- [ ] No errors trong PostgreSQL logs: `docker-compose logs postgres`

## Troubleshooting

### Issue 1: Migrations không chạy

**Symptoms:**
- Bảng users không tồn tại
- Functions không được tạo

**Solutions:**

1. **Check init-scripts được mount đúng:**
   ```bash
   docker-compose exec postgres ls -la /docker-entrypoint-initdb.d/
   ```
   Expected: Thấy files `01-create-schema.sql` và `02-setup-rls.sql`

2. **Check PostgreSQL logs:**
   ```bash
   docker-compose logs postgres | grep -i error
   ```

3. **Force re-run migrations:**
   ```bash
   # Stop và xóa volumes
   docker-compose down -v
   
   # Start lại
   docker-compose up -d
   
   # Check logs
   docker-compose logs postgres
   ```

4. **Manually run migrations:**
   ```bash
   # Copy SQL files vào container
   docker cp init-scripts/01-create-schema.sql directus-postgres:/tmp/
   docker cp init-scripts/02-setup-rls.sql directus-postgres:/tmp/
   
   # Execute manually
   docker-compose exec postgres psql -U directus -d directus -f /tmp/01-create-schema.sql
   docker-compose exec postgres psql -U directus -d directus -f /tmp/02-setup-rls.sql
   ```

### Issue 2: RLS policies không được tạo

**Symptoms:**
- `SELECT * FROM pg_policies WHERE tablename = 'users'` returns empty

**Solutions:**

1. **Check if 02-setup-rls.sql có syntax errors:**
   ```bash
   docker-compose logs postgres | grep "02-setup-rls"
   ```

2. **Manually run RLS script:**
   ```bash
   docker-compose exec postgres psql -U directus -d directus -f /docker-entrypoint-initdb.d/02-setup-rls.sql
   ```

3. **Check if auth.uid() and auth.role() functions exist:**
   ```sql
   SELECT routine_name FROM information_schema.routines
   WHERE routine_schema = 'auth';
   ```
   
   **Note:** Trong local PostgreSQL, các functions này chưa tồn tại. Policies vẫn được tạo nhưng sẽ fail khi execute. Đây là expected behavior - policies sẽ hoạt động khi deploy lên Supabase.

### Issue 3: Trigger không hoạt động

**Symptoms:**
- updated_at không tự động update khi UPDATE record

**Solutions:**

1. **Verify trigger exists:**
   ```sql
   SELECT trigger_name, event_manipulation, action_statement
   FROM information_schema.triggers
   WHERE event_object_table = 'users';
   ```

2. **Verify function exists:**
   ```sql
   SELECT routine_name FROM information_schema.routines
   WHERE routine_name = 'update_updated_at_column';
   ```

3. **Re-create trigger:**
   ```sql
   DROP TRIGGER IF EXISTS update_users_updated_at ON public.users;
   
   CREATE TRIGGER update_users_updated_at
       BEFORE UPDATE ON public.users
       FOR EACH ROW
       EXECUTE FUNCTION update_updated_at_column();
   ```

### Issue 4: Tests fail

**Symptoms:**
- `npm test` shows failures

**Solutions:**

1. **Check test database connection:**
   - Verify DATABASE_URL in .env or test config
   - Ensure PostgreSQL is accessible

2. **Check test data:**
   - Tests may need clean database state
   - Run: `npm run test:db:reset`

3. **Check test logs:**
   ```bash
   npm test -- --verbose
   ```

## SQL Verification Script

Để verify tất cả requirements một lần, chạy script sau:

```bash
# Save to verify-database.sh
docker-compose exec postgres psql -U directus -d directus << 'EOF'
\echo '=== DATABASE VERIFICATION SCRIPT ==='
\echo ''

\echo '1. Checking if users table exists...'
SELECT EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name = 'users'
) AS users_table_exists;

\echo ''
\echo '2. Checking table structure...'
\d public.users

\echo ''
\echo '3. Checking constraints...'
SELECT constraint_name, constraint_type, column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
WHERE tc.table_name = 'users' AND tc.table_schema = 'public';

\echo ''
\echo '4. Checking indexes...'
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'users' AND schemaname = 'public';

\echo ''
\echo '5. Checking RLS status...'
SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename = 'users' AND schemaname = 'public';

\echo ''
\echo '6. Checking RLS policies...'
SELECT policyname, cmd
FROM pg_policies
WHERE tablename = 'users' AND schemaname = 'public';

\echo ''
\echo '=== VERIFICATION COMPLETE ==='
EOF
```

Make executable and run:
```bash
chmod +x verify-database.sh
./verify-database.sh
```

## Next Steps

Sau khi verify thành công:

1. ✅ **Mark Task 6 as complete**
2. ➡️ **Proceed to Task 7**: Setup Firebase project và Cloud Functions
3. 📝 **Document any issues** encountered during verification

## Success Criteria

Task 6 được coi là hoàn thành khi:

- ✅ Docker containers restart thành công
- ✅ Database schema được tạo đúng với tất cả columns, constraints, indexes
- ✅ Trigger auto-update updated_at hoạt động
- ✅ RLS được enable trên bảng users
- ✅ Tất cả 4 RLS policies được tạo với correct definitions
- ✅ Database tests pass
- ✅ No errors trong PostgreSQL logs

## References

- [PostgreSQL Row Level Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL Triggers](https://www.postgresql.org/docs/current/trigger-definition.html)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Supabase Auth Helpers](https://supabase.com/docs/guides/auth/row-level-security)

---

**Created**: Task 6 Checkpoint
**Requirements Validated**: 4.1, 4.2, 4.3, 4.6, 4.7, 5.1, 5.2, 5.3, 5.4, 5.6
