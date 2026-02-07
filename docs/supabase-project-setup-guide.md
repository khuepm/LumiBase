# Supabase Project Setup Guide

This guide provides detailed instructions for configuring Supabase to work with Firebase Authentication in LumiBase.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Creating a Supabase Project](#creating-a-supabase-project)
- [Getting API URL and Keys](#getting-api-url-and-keys)
- [Configuring Firebase Third-Party Auth](#configuring-firebase-third-party-auth)
- [Setting Up JWT Secret](#setting-up-jwt-secret)
- [Running Database Migrations](#running-database-migrations)
- [Testing Supabase Integration](#testing-supabase-integration)
- [Troubleshooting](#troubleshooting)
- [Security Best Practices](#security-best-practices)

## Prerequisites

Before you begin, ensure you have:

- A Supabase account ([Sign up here](https://supabase.com/))
- Firebase project already configured (see [Firebase Authentication Guide](./firebase-authentication-guide.md))
- Firebase Web API Key and Project ID
- Basic understanding of PostgreSQL and JWT tokens
- Docker running locally (for local database)

## Creating a Supabase Project

### Step 1: Access Supabase Dashboard

1. Navigate to [Supabase Dashboard](https://app.supabase.com/)
2. Sign in with your account (GitHub, GitLab, or email)

### Step 2: Create New Project

1. Click **New project** button
2. Select your organization (or create a new one)
3. Fill in project details:

   **Project Name**: Enter a descriptive name
   - Example: "LumiBase", "MyApp Production"
   - This is for your reference only
   - Can contain spaces and special characters

   **Database Password**: Create a strong password
   - Minimum 8 characters
   - Use uppercase, lowercase, numbers, and symbols
   - **IMPORTANT**: Save this password securely!
   - You'll need it for direct database connections

   **Region**: Select the closest region to your users
   - Affects latency and data residency
   - Cannot be changed after creation
   - Common choices: US East, EU West, Asia Pacific

   **Pricing Plan**: Select your plan
   - **Free**: Perfect for development and small projects
   - **Pro**: For production apps with higher limits
   - **Team/Enterprise**: For larger organizations

4. Click **Create new project**

### Step 3: Wait for Project Initialization

Supabase will provision your project (usually takes 1-2 minutes):
- PostgreSQL database
- RESTful API
- Realtime subscriptions
- Authentication service
- Storage service

Once complete, you'll see the project dashboard.

### Step 4: Verify Project Creation

Check that these services are running:
- ✅ **Database**: PostgreSQL instance
- ✅ **API**: Auto-generated REST API
- ✅ **Auth**: Authentication service
- ✅ **Storage**: File storage service
- ✅ **Realtime**: WebSocket subscriptions

## Getting API URL and Keys

Supabase provides several keys for different purposes. Understanding which key to use is crucial for security.

### Step 1: Navigate to API Settings

1. In your Supabase project dashboard
2. Click on **Settings** (gear icon) in the left sidebar
3. Click on **API** section

### Step 2: Locate Your API URL

Find the **Project URL** section:

```
Project URL: https://xxxxxxxxxxxxx.supabase.co
```

This is your `SUPABASE_URL` - copy it to your `.env` file:

```bash
SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
```

**Important Notes:**
- This URL is public and safe to use in client-side code
- All API requests go through this URL
- Format: `https://[project-ref].supabase.co`

### Step 3: Understand Supabase Keys

Supabase provides three types of API keys:

#### 1. **anon (public) Key**

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4eHh4eHh4eHh4eHgiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTYxNjE2MTYxNiwiZXhwIjoxOTMxNzM3NjE2fQ...
```

**Purpose**: Client-side applications (web, mobile)

**Permissions**: 
- Limited by Row Level Security (RLS) policies
- Can only access data allowed by RLS
- Safe to expose in client-side code

**Use Cases**:
- Frontend applications
- Mobile apps
- Public API access

**Add to `.env`**:
```bash
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### 2. **service_role Key**

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4eHh4eHh4eHh4eHgiLCJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNjE2MTYxNjE2LCJleHAiOjE5MzE3Mzc2MTZ9...
```

**Purpose**: Server-side operations (Cloud Functions, backend services)

**Permissions**:
- **Bypasses ALL Row Level Security policies**
- Full database access
- Can perform any operation

**Use Cases**:
- Firebase Cloud Functions
- Backend services
- Admin operations
- Data migrations

**⚠️ CRITICAL SECURITY WARNING**:
- **NEVER expose this key in client-side code**
- **NEVER commit to Git**
- Store only in secure environment variables
- Use only in trusted server environments

**Add to `.env`**:
```bash
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### 3. **JWT Secret**

```
your-super-secret-jwt-token-with-at-least-32-characters-long
```

**Purpose**: Sign and verify JWT tokens

**Permissions**:
- Used to verify token signatures
- Required for custom JWT implementations

**Use Cases**:
- Custom authentication flows
- Token verification
- Directus integration

**Add to `.env`**:
```bash
SUPABASE_JWT_SECRET=your-super-secret-jwt-token-with-at-least-32-characters-long
```

### Step 4: Copy Keys to Environment File

Update your `.env` file with all three values:

```bash
# Supabase Configuration
SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_JWT_SECRET=your-super-secret-jwt-token-with-at-least-32-characters-long
```

### Step 5: Verify Keys

Test your keys with a simple query:

```typescript
import { createClient } from '@supabase/supabase-js';

// Test anon key (client-side)
const supabaseClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

// Test service role key (server-side only!)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Verify connection
async function testConnection() {
  try {
    const { data, error } = await supabaseClient
      .from('users')
      .select('count');
    
    if (error) throw error;
    console.log('✅ Supabase connection successful!');
  } catch (error) {
    console.error('❌ Connection failed:', error);
  }
}
```

## Configuring Firebase Third-Party Auth

To allow Supabase to accept JWT tokens from Firebase, you need to configure Firebase as a third-party authentication provider.

### Understanding the Integration

```mermaid
sequenceDiagram
    participant User
    participant Client
    participant Firebase
    participant Supabase
    
    User->>Client: Sign in
    Client->>Firebase: Authenticate
    Firebase->>Client: JWT Token
    Client->>Supabase: API Request + JWT
    Supabase->>Firebase: Verify JWT signature
    Firebase->>Supabase: Valid + user claims
    Supabase->>Client: Data response
```

### Method 1: Using Supabase Dashboard (Recommended)

#### Step 1: Navigate to Authentication Settings

1. In Supabase Dashboard, go to **Authentication**
2. Click on **Providers** in the left sidebar
3. Scroll down to find **Firebase** (or search for it)

#### Step 2: Enable Firebase Provider

1. Click on **Firebase** provider
2. Toggle **Enable** switch to ON

#### Step 3: Configure Firebase Settings

Fill in the required fields:

**Firebase Project ID**:
```
your-firebase-project-id
```
- Found in Firebase Console → Project Settings
- Same as `FIREBASE_PROJECT_ID` in your `.env`

**Firebase Issuer URL**:
```
https://securetoken.google.com/your-firebase-project-id
```
- Replace `your-firebase-project-id` with your actual project ID
- This is the JWT issuer that Supabase will trust

**Example**:
```
Project ID: lumibase-prod
Issuer URL: https://securetoken.google.com/lumibase-prod
```

4. Click **Save** to apply changes

#### Step 4: Verify Configuration

Check that Firebase is listed in enabled providers:
- Go to **Authentication** → **Providers**
- Firebase should show as **Enabled**

### Method 2: Using Supabase SQL Editor

If you prefer SQL or need to automate setup:

#### Step 1: Navigate to SQL Editor

1. In Supabase Dashboard, click **SQL Editor**
2. Click **New query**

#### Step 2: Configure JWT Settings

Run this SQL to configure Firebase JWT verification:

```sql
-- Configure Firebase as JWT issuer
-- This tells Supabase to trust JWT tokens from Firebase

-- Note: Supabase automatically verifies JWT signatures using Firebase's public keys
-- You just need to ensure your JWT secret matches Firebase's configuration

-- Verify current JWT settings
SELECT current_setting('app.settings.jwt_secret');

-- The JWT secret should match your Firebase configuration
-- This is already set when you created the Supabase project
```

**Important**: Supabase automatically fetches Firebase's public keys from:
```
https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
```

No additional configuration needed for key rotation!

### Method 3: Using Supabase CLI

For infrastructure-as-code approach:

#### Step 1: Install Supabase CLI

```bash
npm install supabase --save-dev
```

#### Step 2: Login to Supabase

```bash
npx supabase login
```

#### Step 3: Link Your Project

```bash
npx supabase link --project-ref xxxxxxxxxxxxx
```

#### Step 4: Set Firebase Configuration

```bash
# Set Firebase project ID
npx supabase secrets set FIREBASE_PROJECT_ID=your-firebase-project-id

# Set Firebase issuer
npx supabase secrets set FIREBASE_ISSUER=https://securetoken.google.com/your-firebase-project-id
```

#### Step 5: Verify Configuration

```bash
npx supabase secrets list
```

### Understanding JWT Token Flow

When a client sends a Firebase JWT token to Supabase:

1. **Client gets token from Firebase**:
```typescript
const user = await signInWithEmailAndPassword(auth, email, password);
const firebaseToken = await user.getIdToken();
```

2. **Client sends token to Supabase**:
```typescript
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: {
    headers: {
      Authorization: `Bearer ${firebaseToken}`
    }
  }
});
```

3. **Supabase verifies token**:
   - Checks signature using Firebase public keys
   - Verifies issuer matches configured Firebase project
   - Checks expiration time
   - Extracts user claims (uid, email, etc.)

4. **Supabase applies RLS policies**:
   - Uses `auth.uid()` from JWT claims
   - Filters data based on policies
   - Returns only authorized data

### Configuring Custom Claims (Optional)

If you need custom claims in JWT tokens:

#### In Firebase Cloud Functions:

```typescript
import * as admin from 'firebase-admin';

export const setCustomClaims = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'User not authenticated');
  }
  
  // Set custom claims
  await admin.auth().setCustomUserClaims(uid, {
    role: 'admin',
    subscription: 'premium'
  });
  
  return { success: true };
});
```

#### In Supabase RLS Policies:

```sql
-- Access custom claims in RLS policies
CREATE POLICY "Premium users can access premium content"
  ON premium_content
  FOR SELECT
  USING (
    (auth.jwt() ->> 'subscription') = 'premium'
  );
```

### Testing Firebase JWT Integration

Create a test script to verify the integration:

```typescript
// test-firebase-jwt.ts
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { createClient } from '@supabase/supabase-js';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_WEB_API_KEY,
  authDomain: `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: process.env.FIREBASE_PROJECT_ID,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

async function testIntegration() {
  try {
    // 1. Sign in with Firebase
    console.log('1. Signing in with Firebase...');
    const userCredential = await signInWithEmailAndPassword(
      auth,
      'test@example.com',
      'password123'
    );
    
    // 2. Get Firebase JWT token
    console.log('2. Getting Firebase JWT token...');
    const firebaseToken = await userCredential.user.getIdToken();
    console.log('   Token:', firebaseToken.substring(0, 50) + '...');
    
    // 3. Create Supabase client with Firebase token
    console.log('3. Creating Supabase client with Firebase token...');
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
      {
        global: {
          headers: {
            Authorization: `Bearer ${firebaseToken}`
          }
        }
      }
    );
    
    // 4. Query Supabase with Firebase JWT
    console.log('4. Querying Supabase...');
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('firebase_uid', userCredential.user.uid);
    
    if (error) {
      console.error('❌ Query failed:', error);
      return;
    }
    
    console.log('✅ Integration successful!');
    console.log('   User data:', data);
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testIntegration();
```

Run the test:
```bash
npx ts-node test-firebase-jwt.ts
```

Expected output:
```
1. Signing in with Firebase...
2. Getting Firebase JWT token...
   Token: eyJhbGciOiJSUzI1NiIsImtpZCI6IjFlOWdkazcifQ...
3. Creating Supabase client with Firebase token...
4. Querying Supabase...
✅ Integration successful!
   User data: [{ firebase_uid: 'abc123', email: 'test@example.com', ... }]
```

## Setting Up JWT Secret

The JWT secret is used to sign and verify JWT tokens. For LumiBase, we need to configure it for Directus integration.

### Understanding JWT Secret

**What is it?**
- A secret key used to sign JWT tokens
- Ensures token integrity and authenticity
- Must be kept secure and never exposed

**Why do we need it?**
- Directus needs to verify Supabase JWT tokens
- Ensures secure communication between services
- Prevents token tampering

### Step 1: Locate Your JWT Secret

#### Method A: From Supabase Dashboard

1. Go to **Settings** → **API**
2. Scroll down to **JWT Settings** section
3. Find **JWT Secret**:
```
your-super-secret-jwt-token-with-at-least-32-characters-long
```
4. Click the **Copy** button

#### Method B: From Project Configuration

The JWT secret is automatically generated when you create a Supabase project. It's the same secret used for the `service_role` key.

To decode and verify:

```bash
# Install jwt-cli (optional)
npm install -g jwt-cli

# Decode your service_role key to see the secret
jwt decode eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Step 2: Add JWT Secret to Environment

Add to your `.env` file:

```bash
# Supabase JWT Secret
SUPABASE_JWT_SECRET=your-super-secret-jwt-token-with-at-least-32-characters-long
```

**Security Requirements:**
- Minimum 32 characters
- Use alphanumeric and special characters
- Never commit to Git
- Rotate periodically (every 90 days recommended)

### Step 3: Configure Directus to Use JWT Secret

Directus needs the JWT secret to verify tokens from Supabase.

Update your `docker-compose.yml`:

```yaml
services:
  directus:
    image: directus/directus:10-latest
    environment:
      # ... other environment variables ...
      
      # JWT Configuration
      SECRET: ${DIRECTUS_SECRET}
      ACCESS_TOKEN_TTL: 15m
      REFRESH_TOKEN_TTL: 7d
      
      # Supabase JWT Secret (for token verification)
      AUTH_PROVIDERS: supabase
      AUTH_SUPABASE_DRIVER: openid
      AUTH_SUPABASE_CLIENT_ID: ${SUPABASE_URL}
      AUTH_SUPABASE_CLIENT_SECRET: ${SUPABASE_JWT_SECRET}
      AUTH_SUPABASE_ISSUER_URL: ${SUPABASE_URL}/auth/v1
```

### Step 4: Generate Strong JWT Secret (Optional)

If you want to generate a custom JWT secret:

#### Using OpenSSL:

```bash
# Generate 32-byte random secret
openssl rand -base64 32
```

Output example:
```
Xk7jP9mN2qR5tY8wE3vB6nM1cL4fG0hS9dA7zK5xJ2i=
```

#### Using Node.js:

```javascript
// generate-jwt-secret.js
const crypto = require('crypto');

const secret = crypto.randomBytes(32).toString('base64');
console.log('JWT Secret:', secret);
```

Run:
```bash
node generate-jwt-secret.js
```

#### Using Python:

```python
# generate_jwt_secret.py
import secrets
import base64

secret = base64.b64encode(secrets.token_bytes(32)).decode('utf-8')
print(f'JWT Secret: {secret}')
```

Run:
```bash
python generate_jwt_secret.py
```

### Step 5: Update Supabase JWT Secret (Advanced)

**⚠️ WARNING**: Changing the JWT secret will invalidate all existing tokens!

If you need to use a custom JWT secret:

#### Using Supabase Dashboard:

1. Go to **Settings** → **API**
2. Scroll to **JWT Settings**
3. Click **Generate new JWT secret**
4. Confirm the action (this will invalidate all tokens!)
5. Copy the new secret

#### Using Supabase CLI:

```bash
# Generate new JWT secret
npx supabase secrets set JWT_SECRET=$(openssl rand -base64 32)

# Restart services to apply changes
npx supabase db reset
```

### Step 6: Verify JWT Secret Configuration

Test that JWT verification works:

```typescript
// verify-jwt-secret.ts
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET!;

// Create a test token
const testToken = jwt.sign(
  {
    sub: 'test-user-id',
    email: 'test@example.com',
    role: 'authenticated'
  },
  JWT_SECRET,
  {
    expiresIn: '1h',
    issuer: process.env.SUPABASE_URL
  }
);

console.log('Test Token:', testToken);

// Verify the token
try {
  const decoded = jwt.verify(testToken, JWT_SECRET);
  console.log('✅ JWT verification successful!');
  console.log('Decoded:', decoded);
} catch (error) {
  console.error('❌ JWT verification failed:', error);
}
```

Run:
```bash
npx ts-node verify-jwt-secret.ts
```

Expected output:
```
Test Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
✅ JWT verification successful!
Decoded: {
  sub: 'test-user-id',
  email: 'test@example.com',
  role: 'authenticated',
  iat: 1234567890,
  exp: 1234571490,
  iss: 'https://xxxxxxxxxxxxx.supabase.co'
}
```

### JWT Secret Best Practices

1. **Keep it Secret**
   - Never commit to Git
   - Store in environment variables
   - Use secret managers in production

2. **Use Strong Secrets**
   - Minimum 32 characters
   - High entropy (random generation)
   - Mix of alphanumeric and special characters

3. **Rotate Regularly**
   - Every 90 days recommended
   - After security incidents
   - When team members leave

4. **Monitor Usage**
   - Log JWT verification failures
   - Alert on suspicious patterns
   - Track token expiration

5. **Backup Secrets**
   - Store securely in password manager
   - Document rotation procedures
   - Have recovery plan

## Running Database Migrations

After setting up Supabase, you need to create the database schema for user data.

### Understanding Migrations

Migrations are SQL scripts that:
- Create database tables and schemas
- Set up indexes for performance
- Configure Row Level Security (RLS) policies
- Create triggers and functions

LumiBase includes pre-written migration scripts in the `init-scripts/` directory.

### Step 1: Review Migration Scripts

Check the migration scripts:

```bash
# List migration scripts
ls init-scripts/

# Expected files:
# 01-create-schema.sql  - Creates users table and indexes
# 02-setup-rls.sql      - Sets up Row Level Security policies
```

### Step 2: Method A - Using Supabase SQL Editor (Recommended)

#### Run Schema Migration:

1. Go to Supabase Dashboard → **SQL Editor**
2. Click **New query**
3. Copy content from `init-scripts/01-create-schema.sql`
4. Paste into the editor
5. Click **Run** (or press Ctrl+Enter)

Expected output:
```
Success. No rows returned
```

#### Run RLS Migration:

1. Click **New query** again
2. Copy content from `init-scripts/02-setup-rls.sql`
3. Paste into the editor
4. Click **Run**

Expected output:
```
Success. No rows returned
```

### Step 3: Method B - Using Supabase CLI

#### Initialize Supabase Locally:

```bash
# Initialize Supabase in your project
npx supabase init

# Link to your remote project
npx supabase link --project-ref xxxxxxxxxxxxx
```

#### Create Migration Files:

```bash
# Create new migration
npx supabase migration new create_users_table

# This creates: supabase/migrations/[timestamp]_create_users_table.sql
```

#### Copy Migration Content:

```bash
# Copy your migration scripts
cp init-scripts/01-create-schema.sql supabase/migrations/20240101000000_create_users_table.sql
cp init-scripts/02-setup-rls.sql supabase/migrations/20240101000001_setup_rls.sql
```

#### Apply Migrations:

```bash
# Apply to remote database
npx supabase db push

# Or apply locally first (for testing)
npx supabase db reset
npx supabase db push
```

### Step 4: Method C - Using psql (Direct Connection)

#### Get Connection String:

1. Go to Supabase Dashboard → **Settings** → **Database**
2. Find **Connection string** section
3. Select **URI** tab
4. Copy the connection string:
```
postgresql://postgres:[YOUR-PASSWORD]@db.xxxxxxxxxxxxx.supabase.co:5432/postgres
```

#### Connect and Run Migrations:

```bash
# Connect to Supabase database
psql "postgresql://postgres:[YOUR-PASSWORD]@db.xxxxxxxxxxxxx.supabase.co:5432/postgres"

# Run migrations
\i init-scripts/01-create-schema.sql
\i init-scripts/02-setup-rls.sql

# Verify tables
\dt public.*

# Exit
\q
```

### Step 5: Verify Database Schema

#### Check Tables:

```sql
-- List all tables
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public';

-- Expected output:
-- users
```

#### Check Columns:

```sql
-- Describe users table
SELECT 
  column_name, 
  data_type, 
  character_maximum_length,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'users' 
  AND table_schema = 'public'
ORDER BY ordinal_position;

-- Expected columns:
-- firebase_uid (varchar 128, NOT NULL)
-- email (varchar 255, NOT NULL)
-- display_name (varchar 255, NULL)
-- photo_url (text, NULL)
-- created_at (timestamp with time zone, NOT NULL)
-- updated_at (timestamp with time zone, NOT NULL)
```

#### Check Indexes:

```sql
-- List indexes on users table
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'users'
  AND schemaname = 'public';

-- Expected indexes:
-- users_pkey (PRIMARY KEY on firebase_uid)
-- idx_users_email (INDEX on email)
```

#### Check RLS Policies:

```sql
-- Check if RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename = 'users'
  AND schemaname = 'public';

-- Expected: rowsecurity = true

-- List RLS policies
SELECT 
  policyname,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE tablename = 'users'
  AND schemaname = 'public';

-- Expected policies:
-- Users can view own data (SELECT)
-- Users can update own data (UPDATE)
-- Service role has full access (ALL)
-- Allow insert for authenticated users (INSERT)
```

### Step 6: Test Database Operations

#### Test Insert:

```sql
-- Insert test user
INSERT INTO public.users (firebase_uid, email, display_name)
VALUES ('test-uid-123', 'test@example.com', 'Test User');

-- Verify insert
SELECT * FROM public.users WHERE firebase_uid = 'test-uid-123';
```

#### Test Update Trigger:

```sql
-- Update user
UPDATE public.users 
SET display_name = 'Updated Name'
WHERE firebase_uid = 'test-uid-123';

-- Check updated_at changed
SELECT firebase_uid, display_name, updated_at 
FROM public.users 
WHERE firebase_uid = 'test-uid-123';
```

#### Clean Up Test Data:

```sql
-- Delete test user
DELETE FROM public.users WHERE firebase_uid = 'test-uid-123';
```

### Troubleshooting Migrations

**Problem**: "relation already exists" error

**Solution**:
```sql
-- Drop existing table
DROP TABLE IF EXISTS public.users CASCADE;

-- Re-run migration
\i init-scripts/01-create-schema.sql
```

---

**Problem**: "permission denied" error

**Solution**:
- Ensure you're using the correct database password
- Check that you have admin privileges
- Verify connection string is correct

---

**Problem**: RLS policies not working

**Solution**:
```sql
-- Verify RLS is enabled
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Re-create policies
\i init-scripts/02-setup-rls.sql
```

### Migration Best Practices

1. **Version Control**
   - Keep migrations in Git
   - Use sequential numbering
   - Never modify existing migrations

2. **Test Locally First**
   - Test migrations on local database
   - Verify data integrity
   - Check performance impact

3. **Backup Before Migrating**
   - Always backup production database
   - Test restore procedures
   - Have rollback plan

4. **Document Changes**
   - Comment SQL code
   - Explain complex logic
   - Note breaking changes

5. **Idempotent Migrations**
   - Use `IF NOT EXISTS` clauses
   - Check before dropping
   - Handle existing data

## Testing Supabase Integration

After completing the setup, verify that everything works correctly.

### Test 1: Basic Connection

```typescript
// test-supabase-connection.ts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

async function testConnection() {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('count');
    
    if (error) throw error;
    
    console.log('✅ Supabase connection successful!');
    console.log('   Users count:', data);
  } catch (error) {
    console.error('❌ Connection failed:', error);
  }
}

testConnection();
```

### Test 2: RLS Policies

```typescript
// test-rls-policies.ts
import { createClient } from '@supabase/supabase-js';

async function testRLS() {
  // Test with anon key (should be restricted by RLS)
  const supabaseAnon = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  );
  
  // Test with service role key (should bypass RLS)
  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  
  try {
    // Try to query with anon key (should return empty or error)
    console.log('Testing anon key (should be restricted)...');
    const { data: anonData, error: anonError } = await supabaseAnon
      .from('users')
      .select('*');
    
    console.log('   Anon query result:', anonData?.length || 0, 'rows');
    if (anonError) console.log('   Anon error (expected):', anonError.message);
    
    // Try to query with service role key (should succeed)
    console.log('Testing service role key (should bypass RLS)...');
    const { data: adminData, error: adminError } = await supabaseAdmin
      .from('users')
      .select('*');
    
    if (adminError) throw adminError;
    
    console.log('✅ RLS policies working correctly!');
    console.log('   Admin query result:', adminData.length, 'rows');
    
  } catch (error) {
    console.error('❌ RLS test failed:', error);
  }
}

testRLS();
```

### Test 3: Firebase JWT Integration

```typescript
// test-firebase-jwt-integration.ts
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { createClient } from '@supabase/supabase-js';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_WEB_API_KEY,
  authDomain: `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: process.env.FIREBASE_PROJECT_ID,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

async function testFirebaseJWT() {
  try {
    // 1. Sign in with Firebase
    console.log('1. Signing in with Firebase...');
    const userCredential = await signInWithEmailAndPassword(
      auth,
      'test@example.com',
      'password123'
    );
    console.log('   ✅ Firebase sign-in successful');
    
    // 2. Get JWT token
    console.log('2. Getting Firebase JWT token...');
    const token = await userCredential.user.getIdToken();
    console.log('   ✅ Token obtained');
    
    // 3. Use token with Supabase
    console.log('3. Querying Supabase with Firebase JWT...');
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      }
    );
    
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('firebase_uid', userCredential.user.uid);
    
    if (error) throw error;
    
    console.log('✅ Firebase JWT integration successful!');
    console.log('   User data:', data);
    
  } catch (error) {
    console.error('❌ Integration test failed:', error);
  }
}

testFirebaseJWT();
```

### Test 4: Cloud Function Sync

```bash
# Create a test user in Firebase
firebase auth:import test-users.json

# Check if user was synced to Supabase
npx supabase db query "SELECT * FROM public.users WHERE email = 'test@example.com';"
```

### Test 5: Realtime Subscriptions

```typescript
// test-realtime.ts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

async function testRealtime() {
  console.log('Setting up realtime subscription...');
  
  const subscription = supabase
    .channel('users-changes')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'users'
      },
      (payload) => {
        console.log('✅ Realtime event received:', payload);
      }
    )
    .subscribe((status) => {
      console.log('Subscription status:', status);
    });
  
  console.log('Listening for changes... (Press Ctrl+C to stop)');
  
  // Keep process alive
  process.stdin.resume();
}

testRealtime();
```

### Automated Test Suite

Run all tests:

```bash
# Run integration tests
npm run test:integration

# Run specific Supabase tests
npm test -- tests/integration/supabase
```

### Expected Test Results

All tests should pass:

```
✅ Supabase connection successful
✅ RLS policies working correctly
✅ Firebase JWT integration successful
✅ Cloud Function sync working
✅ Realtime subscriptions active

Test Suites: 5 passed, 5 total
Tests:       15 passed, 15 total
```

### Troubleshooting Tests

**Problem**: Connection timeout

**Solution**:
- Check SUPABASE_URL is correct
- Verify network connectivity
- Check firewall settings

---

**Problem**: "Invalid API key" error

**Solution**:
- Verify SUPABASE_ANON_KEY is correct
- Check for extra spaces or quotes
- Regenerate key if needed

---

**Problem**: RLS blocking all queries

**Solution**:
- Verify JWT token is being sent
- Check RLS policies are correct
- Use service role key for testing

---

**Problem**: Firebase JWT not accepted

**Solution**:
- Verify Firebase provider is enabled
- Check Firebase project ID matches
- Ensure JWT token is not expired

## Troubleshooting

### Common Issues and Solutions

#### Issue 1: Cannot Connect to Supabase

**Symptoms**:
- Connection timeout errors
- "Failed to fetch" errors
- Network errors

**Solutions**:

1. **Check Project Status**:
   - Go to Supabase Dashboard
   - Verify project is active (not paused)
   - Check for maintenance notifications

2. **Verify URL and Keys**:
   ```bash
   # Check environment variables
   echo $SUPABASE_URL
   echo $SUPABASE_ANON_KEY
   
   # Should not be empty or undefined
   ```

3. **Test Network Connectivity**:
   ```bash
   # Ping Supabase API
   curl https://xxxxxxxxxxxxx.supabase.co/rest/v1/
   
   # Should return: {"message":"Welcome to PostgREST"}
   ```

4. **Check Firewall/VPN**:
   - Disable VPN temporarily
   - Check corporate firewall rules
   - Verify no proxy blocking requests

#### Issue 2: JWT Verification Fails

**Symptoms**:
- "Invalid JWT" errors
- "Token expired" errors
- 401 Unauthorized responses

**Solutions**:

1. **Check Token Expiration**:
   ```typescript
   import jwt from 'jsonwebtoken';
   
   const decoded = jwt.decode(token);
   console.log('Token expires:', new Date(decoded.exp * 1000));
   ```

2. **Verify JWT Secret**:
   ```bash
   # Ensure JWT secret matches
   echo $SUPABASE_JWT_SECRET
   
   # Should be 32+ characters
   ```

3. **Check Firebase Configuration**:
   - Verify Firebase provider is enabled in Supabase
   - Check Firebase project ID matches
   - Ensure issuer URL is correct

4. **Refresh Token**:
   ```typescript
   // Get fresh token from Firebase
   const newToken = await user.getIdToken(true); // force refresh
   ```

#### Issue 3: RLS Policies Blocking Access

**Symptoms**:
- Empty result sets when data exists
- "Row level security policy violation" errors
- Queries work with service role but not anon key

**Solutions**:

1. **Verify RLS is Configured**:
   ```sql
   -- Check RLS status
   SELECT tablename, rowsecurity 
   FROM pg_tables 
   WHERE tablename = 'users';
   
   -- List policies
   SELECT * FROM pg_policies WHERE tablename = 'users';
   ```

2. **Check JWT Token Contains Required Claims**:
   ```typescript
   import jwt from 'jsonwebtoken';
   
   const decoded = jwt.decode(firebaseToken);
   console.log('Token claims:', decoded);
   // Should contain: sub (uid), email, etc.
   ```

3. **Test with Service Role Key**:
   ```typescript
   // Bypass RLS for testing
   const supabaseAdmin = createClient(
     process.env.SUPABASE_URL!,
     process.env.SUPABASE_SERVICE_ROLE_KEY!
   );
   
   const { data } = await supabaseAdmin.from('users').select('*');
   console.log('Data exists:', data.length);
   ```

4. **Review Policy Logic**:
   ```sql
   -- Check policy definition
   SELECT pg_get_expr(qual, 'public.users'::regclass) as policy_condition
   FROM pg_policy
   WHERE polname = 'Users can view own data';
   ```

#### Issue 4: Database Migration Errors

**Symptoms**:
- "Relation already exists" errors
- "Column does not exist" errors
- Migration scripts fail

**Solutions**:

1. **Check Existing Schema**:
   ```sql
   -- List all tables
   \dt public.*
   
   -- Describe users table
   \d public.users
   ```

2. **Drop and Recreate (Development Only)**:
   ```sql
   -- WARNING: This deletes all data!
   DROP TABLE IF EXISTS public.users CASCADE;
   
   -- Re-run migration
   \i init-scripts/01-create-schema.sql
   ```

3. **Fix Column Mismatches**:
   ```sql
   -- Add missing column
   ALTER TABLE public.users 
   ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
   
   -- Modify column type
   ALTER TABLE public.users 
   ALTER COLUMN email TYPE VARCHAR(255);
   ```

4. **Check Migration Order**:
   - Ensure migrations run in correct order
   - Schema before RLS policies
   - Tables before indexes

#### Issue 5: Cloud Function Not Syncing Users

**Symptoms**:
- Users created in Firebase but not in Supabase
- Cloud Function errors in logs
- Sync delays

**Solutions**:

1. **Check Cloud Function Logs**:
   ```bash
   firebase functions:log --only syncUserToSupabase
   ```

2. **Verify Supabase Configuration**:
   ```bash
   # Check Firebase Functions config
   firebase functions:config:get
   
   # Should show supabase.url and supabase.service_key
   ```

3. **Test Function Locally**:
   ```bash
   cd functions
   npm run serve
   
   # Trigger function manually in emulator
   ```

4. **Check Service Role Key Permissions**:
   ```typescript
   // Test service role key
   const supabase = createClient(
     process.env.SUPABASE_URL!,
     process.env.SUPABASE_SERVICE_ROLE_KEY!
   );
   
   const { error } = await supabase
     .from('users')
     .insert({ firebase_uid: 'test', email: 'test@test.com' });
   
   console.log('Insert error:', error);
   ```

#### Issue 6: Realtime Subscriptions Not Working

**Symptoms**:
- No events received
- Subscription status stuck on "connecting"
- WebSocket errors

**Solutions**:

1. **Enable Realtime in Supabase**:
   - Go to Database → Replication
   - Enable replication for `users` table

2. **Check Subscription Status**:
   ```typescript
   const subscription = supabase
     .channel('test')
     .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, 
       (payload) => console.log(payload)
     )
     .subscribe((status, err) => {
       console.log('Status:', status);
       if (err) console.error('Error:', err);
     });
   ```

3. **Verify WebSocket Connection**:
   ```bash
   # Check WebSocket endpoint
   wscat -c wss://xxxxxxxxxxxxx.supabase.co/realtime/v1/websocket
   ```

4. **Check RLS Policies**:
   - Realtime respects RLS policies
   - Ensure user has permission to receive updates

### Getting Help

If you're still experiencing issues:

1. **Check Supabase Status**:
   - Visit [status.supabase.com](https://status.supabase.com/)
   - Check for ongoing incidents

2. **Search Documentation**:
   - [Supabase Docs](https://supabase.com/docs)
   - [Supabase GitHub Discussions](https://github.com/supabase/supabase/discussions)

3. **Community Support**:
   - [Supabase Discord](https://discord.supabase.com/)
   - [Stack Overflow](https://stackoverflow.com/questions/tagged/supabase)

4. **Contact Support**:
   - Pro/Team plans: support@supabase.com
   - Include project ref and error logs

## Security Best Practices

### API Key Security

#### 1. Protect Service Role Key

**⚠️ CRITICAL**: The service role key bypasses ALL security policies!

**DO**:
- ✅ Store only in server-side environment variables
- ✅ Use secret managers (AWS Secrets Manager, Google Secret Manager)
- ✅ Rotate keys every 90 days
- ✅ Monitor usage and set up alerts
- ✅ Use different keys for dev/staging/prod

**DON'T**:
- ❌ Never expose in client-side code
- ❌ Never commit to Git
- ❌ Never share in Slack/email
- ❌ Never log in plain text
- ❌ Never use in mobile apps

#### 2. Anon Key Usage

The anon key is safe for client-side use but:

**DO**:
- ✅ Use with RLS policies enabled
- ✅ Implement rate limiting
- ✅ Monitor for abuse
- ✅ Rotate if compromised

**DON'T**:
- ❌ Rely on it alone for security
- ❌ Use without RLS policies
- ❌ Assume it's secret

### Row Level Security (RLS)

#### 1. Always Enable RLS

```sql
-- Enable RLS on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
```

#### 2. Write Secure Policies

**Good Policy** (Specific and restrictive):
```sql
CREATE POLICY "Users can only view their own data"
  ON public.users
  FOR SELECT
  USING (auth.uid() = firebase_uid);
```

**Bad Policy** (Too permissive):
```sql
CREATE POLICY "Anyone can view all data"
  ON public.users
  FOR SELECT
  USING (true); -- ❌ Allows access to all rows!
```

#### 3. Test RLS Policies

```typescript
// Test as different users
async function testRLSAsUser(userId: string, token: string) {
  const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: `Bearer ${token}` } }
    }
  );
  
  const { data } = await supabase
    .from('users')
    .select('*');
  
  console.log(`User ${userId} can see:`, data.length, 'rows');
}
```

### JWT Token Security

#### 1. Validate Token Expiration

```typescript
import jwt from 'jsonwebtoken';

function isTokenExpired(token: string): boolean {
  const decoded = jwt.decode(token) as any;
  if (!decoded || !decoded.exp) return true;
  
  return Date.now() >= decoded.exp * 1000;
}

// Refresh if expired
if (isTokenExpired(token)) {
  token = await user.getIdToken(true);
}
```

#### 2. Use Short Token Lifetimes

```typescript
// Firebase tokens expire after 1 hour by default
// Refresh tokens before expiration

setInterval(async () => {
  const newToken = await user.getIdToken(true);
  // Update token in your app
}, 50 * 60 * 1000); // Refresh every 50 minutes
```

#### 3. Secure Token Storage

**Client-side**:
```typescript
// ✅ Good: Use secure storage
import SecureStore from 'expo-secure-store';
await SecureStore.setItemAsync('auth_token', token);

// ❌ Bad: Plain localStorage
localStorage.setItem('auth_token', token); // Vulnerable to XSS
```

**Server-side**:
```typescript
// ✅ Good: Environment variables
const token = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ❌ Bad: Hardcoded
const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

### Database Security

#### 1. Use Prepared Statements

```typescript
// ✅ Good: Parameterized query (safe from SQL injection)
const { data } = await supabase
  .from('users')
  .select('*')
  .eq('email', userInput);

// ❌ Bad: String concatenation (vulnerable to SQL injection)
const { data } = await supabase
  .rpc('raw_query', { 
    query: `SELECT * FROM users WHERE email = '${userInput}'` 
  });
```

#### 2. Limit Database Permissions

```sql
-- Create role with limited permissions
CREATE ROLE app_user;

-- Grant only necessary permissions
GRANT SELECT, INSERT, UPDATE ON public.users TO app_user;

-- Revoke dangerous permissions
REVOKE DELETE ON public.users FROM app_user;
```

#### 3. Enable Audit Logging

```sql
-- Create audit log table
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  user_id TEXT,
  old_data JSONB,
  new_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create audit trigger
CREATE OR REPLACE FUNCTION audit_trigger()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_log (table_name, operation, user_id, old_data, new_data)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    auth.uid(),
    row_to_json(OLD),
    row_to_json(NEW)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to users table
CREATE TRIGGER users_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION audit_trigger();
```

### Network Security

#### 1. Use HTTPS Only

```typescript
// ✅ Good: HTTPS
const SUPABASE_URL = 'https://xxxxxxxxxxxxx.supabase.co';

// ❌ Bad: HTTP (never use in production)
const SUPABASE_URL = 'http://xxxxxxxxxxxxx.supabase.co';
```

#### 2. Configure CORS Properly

In Supabase Dashboard → Settings → API:

```
Allowed Origins:
- https://myapp.com
- https://www.myapp.com

❌ Don't use: *
```

#### 3. Implement Rate Limiting

```typescript
// Use rate limiting middleware
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use('/api/', limiter);
```

### Monitoring and Alerting

#### 1. Monitor Failed Authentication Attempts

```sql
-- Query failed auth attempts
SELECT 
  COUNT(*) as failed_attempts,
  user_id,
  DATE_TRUNC('hour', created_at) as hour
FROM auth.audit_log_entries
WHERE action = 'login'
  AND result = 'failure'
GROUP BY user_id, hour
HAVING COUNT(*) > 10;
```

#### 2. Set Up Alerts

Configure alerts for:
- Multiple failed login attempts
- Unusual API usage patterns
- Service role key usage
- Database errors
- Slow queries

#### 3. Regular Security Audits

```bash
# Check for security issues
npm audit

# Update dependencies
npm update

# Review RLS policies
npx supabase db query "SELECT * FROM pg_policies;"

# Check for exposed secrets
git secrets --scan
```

### Compliance and Privacy

#### 1. GDPR Compliance

```typescript
// Implement data deletion
async function deleteUserData(userId: string) {
  const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  );
  
  // Delete user data
  await supabase
    .from('users')
    .delete()
    .eq('firebase_uid', userId);
  
  // Log deletion for audit
  console.log(`User ${userId} data deleted at ${new Date()}`);
}
```

#### 2. Data Encryption

```sql
-- Enable encryption at rest (Supabase Pro+)
-- Automatically enabled for all data

-- Encrypt sensitive columns
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users 
ADD COLUMN encrypted_ssn TEXT;

-- Encrypt data
UPDATE users 
SET encrypted_ssn = pgp_sym_encrypt(ssn, 'encryption-key');
```

#### 3. Data Retention Policies

```sql
-- Auto-delete old audit logs
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM audit_log
  WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- Schedule cleanup (using pg_cron extension)
SELECT cron.schedule(
  'cleanup-audit-logs',
  '0 0 * * *', -- Daily at midnight
  'SELECT cleanup_old_audit_logs();'
);
```

### Security Checklist

Before going to production:

- [ ] Service role key stored securely (not in code)
- [ ] RLS enabled on all tables
- [ ] RLS policies tested thoroughly
- [ ] JWT tokens have short expiration times
- [ ] HTTPS enforced everywhere
- [ ] CORS configured properly (no wildcards)
- [ ] Rate limiting implemented
- [ ] Audit logging enabled
- [ ] Monitoring and alerts configured
- [ ] Regular security audits scheduled
- [ ] Backup and recovery procedures tested
- [ ] Incident response plan documented
- [ ] Dependencies updated and audited
- [ ] Secrets rotated regularly
- [ ] Team trained on security practices

---

## Additional Resources

- [Supabase Documentation](https://supabase.com/docs)
- [Supabase Security Guide](https://supabase.com/docs/guides/auth/row-level-security)
- [PostgreSQL Security](https://www.postgresql.org/docs/current/security.html)
- [JWT Best Practices](https://tools.ietf.org/html/rfc8725)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)

---

## Support

**Need Help?**

- **Documentation**: [supabase.com/docs](https://supabase.com/docs)
- **Community**: [Discord](https://discord.supabase.com/)
- **GitHub**: [github.com/supabase/supabase](https://github.com/supabase/supabase)
- **Stack Overflow**: [stackoverflow.com/questions/tagged/supabase](https://stackoverflow.com/questions/tagged/supabase)
- **Email Support**: support@supabase.com (Pro/Team plans)

**LumiBase Issues**:

- **GitHub Issues**: [github.com/khuepm/LumiBase/issues](https://github.com/khuepm/LumiBase/issues)
- **Discussions**: [github.com/khuepm/LumiBase/discussions](https://github.com/khuepm/LumiBase/discussions)

---

Made with ❤️ for the LumiBase project
