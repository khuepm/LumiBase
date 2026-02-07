# Task 10: Firebase và Supabase Integration Checkpoint

## 📋 Overview

This checkpoint verifies that your Firebase Authentication and Supabase database are properly integrated and working together. We'll test the complete authentication flow from user creation to data synchronization.

## ✅ Prerequisites

Before starting this checkpoint, ensure you have completed:

- ✅ Task 1-2: Docker environment setup
- ✅ Task 4-5: Database schema and RLS policies
- ✅ Task 7: Firebase Cloud Functions implementation
- ✅ Task 8: Firebase Authentication configuration
- ✅ Task 9: Supabase project configuration

## 🎯 Verification Steps

### Step 1: Deploy Cloud Functions to Firebase

#### 1.1 Verify Firebase CLI is Installed

```bash
firebase --version
```

Expected output: `12.x.x` or higher

If not installed:
```bash
npm install -g firebase-tools
```

#### 1.2 Login to Firebase

```bash
firebase login
```

This will open a browser window for authentication.

#### 1.3 Verify Project Configuration

```bash
# Check current project
firebase use

# If not set, select your project
firebase use <your-firebase-project-id>

# List available projects
firebase projects:list
```

#### 1.4 Configure Supabase Credentials

```bash
# Set Supabase URL
firebase functions:config:set supabase.url="<your-supabase-url>"

# Set Supabase Service Role Key
firebase functions:config:set supabase.service_key="<your-supabase-service-role-key>"

# Verify configuration
firebase functions:config:get
```

Expected output:
```json
{
  "supabase": {
    "url": "https://xxxxxxxxxxxxx.supabase.co",
    "service_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

#### 1.5 Build and Deploy Functions

```bash
cd functions

# Install dependencies (if not already done)
npm install

# Build TypeScript
npm run build

# Deploy to Firebase
npm run deploy
```

Expected output:
```
✔  functions: Finished running predeploy script.
i  functions: ensuring required API cloudfunctions.googleapis.com is enabled...
✔  functions: required API cloudfunctions.googleapis.com is enabled
i  functions: preparing functions directory for uploading...
i  functions: packaged functions (XX.XX KB) for uploading
✔  functions: functions folder uploaded successfully
i  functions: creating Node.js 18 function syncUserToSupabase...
✔  functions[syncUserToSupabase]: Successful create operation.
i  functions: creating Node.js 18 function deleteUserFromSupabase...
✔  functions[deleteUserFromSupabase]: Successful create operation.

✔  Deploy complete!
```

#### 1.6 Verify Deployed Functions

```bash
# List deployed functions
firebase functions:list

# Expected output:
# syncUserToSupabase (us-central1)
# deleteUserFromSupabase (us-central1)
```

---

### Step 2: Test Creating New User in Firebase Auth

#### 2.1 Using Firebase Console (Recommended for Testing)

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Navigate to **Authentication** → **Users**
4. Click **Add user** button
5. Enter test credentials:
   - **Email**: `test-checkpoint@example.com`
   - **Password**: `TestPassword123!`
6. Click **Add user**

#### 2.2 Using Firebase CLI (Alternative)

```bash
# Create test user via CLI
firebase auth:import test-users.json --project <your-project-id>
```

Where `test-users.json` contains:
```json
{
  "users": [
    {
      "localId": "test-uid-checkpoint",
      "email": "test-checkpoint@example.com",
      "emailVerified": false,
      "passwordHash": "...",
      "salt": "...",
      "createdAt": "1234567890000"
    }
  ]
}
```

#### 2.3 Using Client SDK (Most Realistic)

Create a test file `test-create-user.ts`:

```typescript
import { initializeApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword } from 'firebase/auth';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_WEB_API_KEY,
  authDomain: `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: process.env.FIREBASE_PROJECT_ID,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

async function createTestUser() {
  try {
    const userCredential = await createUserWithEmailAndPassword(
      auth,
      'test-checkpoint@example.com',
      'TestPassword123!'
    );
    
    console.log('✅ User created successfully!');
    console.log('   UID:', userCredential.user.uid);
    console.log('   Email:', userCredential.user.email);
    
    return userCredential.user;
  } catch (error: any) {
    console.error('❌ Failed to create user:', error.message);
    throw error;
  }
}

createTestUser();
```

Run:
```bash
npx ts-node test-create-user.ts
```

---

### Step 3: Verify User Synced to Supabase Database

#### 3.1 Check Cloud Function Logs

```bash
# View recent function logs
firebase functions:log --only syncUserToSupabase

# Or view all logs
firebase functions:log
```

Look for log entries like:
```
[syncUserToSupabase] Starting sync for user: <uid>
[syncUserToSupabase] Successfully synced user <uid> in XXXms
```

#### 3.2 Query Supabase Database

**Option A: Using Supabase Dashboard**

1. Go to [Supabase Dashboard](https://app.supabase.com/)
2. Select your project
3. Navigate to **Table Editor**
4. Select `users` table
5. Look for the newly created user with email `test-checkpoint@example.com`

**Option B: Using SQL Editor**

1. Go to **SQL Editor** in Supabase Dashboard
2. Run this query:

```sql
SELECT * FROM public.users 
WHERE email = 'test-checkpoint@example.com';
```

Expected result:
```
firebase_uid | email                        | display_name | photo_url | created_at           | updated_at
-------------|------------------------------|--------------|-----------|----------------------|----------------------
abc123...    | test-checkpoint@example.com  | NULL         | NULL      | 2024-01-15 10:30:00  | 2024-01-15 10:30:00
```

**Option C: Using psql (Local Docker)**

```bash
# Connect to local PostgreSQL
docker-compose exec postgres psql -U directus -d directus

# Query users table
SELECT * FROM public.users WHERE email = 'test-checkpoint@example.com';

# Exit
\q
```

**Option D: Using Test Script**

Create `test-supabase-sync.ts`:

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // Use service role to bypass RLS
);

async function checkUserSync(email: string) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    
    if (error) {
      console.error('❌ User not found in Supabase:', error.message);
      return false;
    }
    
    console.log('✅ User found in Supabase!');
    console.log('   Firebase UID:', data.firebase_uid);
    console.log('   Email:', data.email);
    console.log('   Display Name:', data.display_name || 'NULL');
    console.log('   Photo URL:', data.photo_url || 'NULL');
    console.log('   Created At:', data.created_at);
    console.log('   Updated At:', data.updated_at);
    
    return true;
  } catch (error) {
    console.error('❌ Error checking sync:', error);
    return false;
  }
}

checkUserSync('test-checkpoint@example.com');
```

Run:
```bash
npx ts-node test-supabase-sync.ts
```

---

### Step 4: Test Authentication Flow with JWT Tokens

#### 4.1 Sign In and Get JWT Token

Create `test-auth-flow.ts`:

```typescript
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

async function testAuthFlow() {
  try {
    console.log('=== Testing Complete Authentication Flow ===\n');
    
    // Step 1: Sign in with Firebase
    console.log('Step 1: Signing in with Firebase...');
    const userCredential = await signInWithEmailAndPassword(
      auth,
      'test-checkpoint@example.com',
      'TestPassword123!'
    );
    console.log('✅ Firebase sign-in successful');
    console.log('   UID:', userCredential.user.uid);
    console.log('   Email:', userCredential.user.email);
    
    // Step 2: Get JWT token
    console.log('\nStep 2: Getting Firebase JWT token...');
    const token = await userCredential.user.getIdToken();
    console.log('✅ JWT token obtained');
    console.log('   Token (first 50 chars):', token.substring(0, 50) + '...');
    
    // Step 3: Decode JWT to see claims
    console.log('\nStep 3: Decoding JWT token...');
    const tokenParts = token.split('.');
    const payload = JSON.parse(atob(tokenParts[1]));
    console.log('✅ JWT decoded');
    console.log('   Issuer:', payload.iss);
    console.log('   Subject (UID):', payload.sub);
    console.log('   Email:', payload.email);
    console.log('   Expires:', new Date(payload.exp * 1000).toISOString());
    
    // Step 4: Use JWT with Supabase
    console.log('\nStep 4: Querying Supabase with Firebase JWT...');
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
    
    if (error) {
      console.error('❌ Supabase query failed:', error);
      return false;
    }
    
    console.log('✅ Supabase query successful!');
    console.log('   Records found:', data.length);
    if (data.length > 0) {
      console.log('   User data:', JSON.stringify(data[0], null, 2));
    }
    
    // Step 5: Test RLS policies
    console.log('\nStep 5: Testing RLS policies...');
    
    // Try to access own data (should succeed)
    const { data: ownData, error: ownError } = await supabase
      .from('users')
      .select('*')
      .eq('firebase_uid', userCredential.user.uid);
    
    if (ownError) {
      console.error('❌ Failed to access own data:', ownError);
    } else {
      console.log('✅ Can access own data (RLS working correctly)');
    }
    
    // Try to access all users (should be filtered by RLS)
    const { data: allData, error: allError } = await supabase
      .from('users')
      .select('*');
    
    if (allError) {
      console.log('⚠️  Cannot access all users (RLS working correctly)');
    } else {
      console.log('✅ RLS filtering applied, returned', allData.length, 'records');
    }
    
    console.log('\n=== ✅ Authentication Flow Test Complete ===');
    return true;
    
  } catch (error: any) {
    console.error('\n❌ Authentication flow test failed:', error.message);
    return false;
  }
}

testAuthFlow();
```

Run:
```bash
npx ts-node test-auth-flow.ts
```

Expected output:
```
=== Testing Complete Authentication Flow ===

Step 1: Signing in with Firebase...
✅ Firebase sign-in successful
   UID: abc123xyz...
   Email: test-checkpoint@example.com

Step 2: Getting Firebase JWT token...
✅ JWT token obtained
   Token (first 50 chars): eyJhbGciOiJSUzI1NiIsImtpZCI6IjFlOWdkazcifQ...

Step 3: Decoding JWT token...
✅ JWT decoded
   Issuer: https://securetoken.google.com/your-project-id
   Subject (UID): abc123xyz...
   Email: test-checkpoint@example.com
   Expires: 2024-01-15T11:30:00.000Z

Step 4: Querying Supabase with Firebase JWT...
✅ Supabase query successful!
   Records found: 1
   User data: {
     "firebase_uid": "abc123xyz...",
     "email": "test-checkpoint@example.com",
     "display_name": null,
     "photo_url": null,
     "created_at": "2024-01-15T10:30:00.000Z",
     "updated_at": "2024-01-15T10:30:00.000Z"
   }

Step 5: Testing RLS policies...
✅ Can access own data (RLS working correctly)
✅ RLS filtering applied, returned 1 records

=== ✅ Authentication Flow Test Complete ===
```

---

### Step 5: Run Integration Tests

#### 5.1 Run All Tests

```bash
# Run all tests
npm test

# Or run specific test suites
npm run test:integration
```

#### 5.2 Run Specific Integration Tests

```bash
# Test Supabase JWT verification
npm test tests/integration/supabase-jwt-verification.test.ts

# Test RLS policies
npm test tests/integration/rls-policies.integration.test.ts

# Test Cloud Functions (if you have local tests)
cd functions
npm test
```

#### 5.3 Expected Test Results

All tests should pass:
```
✓ Supabase accepts valid Firebase JWT tokens
✓ Supabase rejects invalid JWT signatures
✓ Supabase rejects expired JWT tokens
✓ Supabase extracts firebase_uid from JWT
✓ Supabase returns 401 for invalid tokens
✓ Users can read own data with valid JWT
✓ Users cannot read other users' data
✓ Users can update own data
✓ Service role bypasses RLS
```

---

## 🔍 Troubleshooting

### Issue 1: Cloud Functions Not Deploying

**Symptoms:**
- `firebase deploy` fails
- "Permission denied" errors
- "Billing account required" errors

**Solutions:**

1. **Check Firebase login:**
```bash
firebase login --reauth
```

2. **Verify project:**
```bash
firebase use <your-project-id>
firebase projects:list
```

3. **Check billing (Functions require Blaze plan):**
- Go to Firebase Console → Settings → Usage and billing
- Upgrade to Blaze (pay-as-you-go) plan
- Note: Free tier includes generous limits

4. **Check IAM permissions:**
- Ensure your account has "Cloud Functions Developer" role
- Go to Google Cloud Console → IAM & Admin

---

### Issue 2: User Not Syncing to Supabase

**Symptoms:**
- User created in Firebase but not in Supabase
- No errors in Firebase logs
- Cloud Function not triggering

**Solutions:**

1. **Check Cloud Function logs:**
```bash
firebase functions:log --only syncUserToSupabase --limit 50
```

2. **Verify function configuration:**
```bash
firebase functions:config:get
```

Ensure `supabase.url` and `supabase.service_key` are set correctly.

3. **Test function manually:**
```bash
# Trigger function with test data
firebase functions:shell
> syncUserToSupabase({uid: 'test', email: 'test@example.com'})
```

4. **Check Supabase service role key:**
- Verify key has correct permissions
- Test key with direct API call:
```bash
curl -X GET "https://xxxxxxxxxxxxx.supabase.co/rest/v1/users" \
  -H "apikey: <service-role-key>" \
  -H "Authorization: Bearer <service-role-key>"
```

5. **Check network connectivity:**
- Ensure Cloud Functions can reach Supabase
- Check firewall rules
- Verify Supabase project is not paused

---

### Issue 3: JWT Token Not Accepted by Supabase

**Symptoms:**
- "Invalid JWT" errors
- 401 Unauthorized responses
- Token verification fails

**Solutions:**

1. **Verify Firebase configuration in Supabase:**
- Go to Supabase Dashboard → Authentication → Providers
- Ensure Firebase provider is enabled
- Check Firebase Project ID matches
- Verify Issuer URL: `https://securetoken.google.com/<project-id>`

2. **Check JWT token format:**
```typescript
// Decode token to inspect claims
const tokenParts = token.split('.');
const payload = JSON.parse(atob(tokenParts[1]));
console.log('Token payload:', payload);

// Verify issuer
console.log('Issuer:', payload.iss);
// Should be: https://securetoken.google.com/<your-project-id>
```

3. **Verify token expiration:**
```typescript
const expiresAt = new Date(payload.exp * 1000);
console.log('Token expires:', expiresAt);
console.log('Is expired:', expiresAt < new Date());
```

4. **Test with fresh token:**
```typescript
// Get a new token
const freshToken = await user.getIdToken(true); // Force refresh
```

5. **Check Supabase JWT secret:**
- Ensure JWT secret matches Firebase configuration
- Verify in Supabase Dashboard → Settings → API

---

### Issue 4: RLS Policies Not Working

**Symptoms:**
- Users can access other users' data
- Service role key doesn't bypass RLS
- Unexpected permission errors

**Solutions:**

1. **Verify RLS is enabled:**
```sql
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE tablename = 'users';
```

Should return `rowsecurity = true`.

2. **Check RLS policies exist:**
```sql
SELECT policyname, cmd, qual 
FROM pg_policies 
WHERE tablename = 'users';
```

3. **Re-apply RLS policies:**
```bash
# Connect to database
docker-compose exec postgres psql -U directus -d directus

# Re-run RLS script
\i init-scripts/02-setup-rls.sql
```

4. **Test RLS with different keys:**
```typescript
// Test with anon key (should be restricted)
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Test with service role (should bypass)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
```

---

### Issue 5: Integration Tests Failing

**Symptoms:**
- Tests timeout
- Connection errors
- Unexpected test failures

**Solutions:**

1. **Check environment variables:**
```bash
# Verify all required variables are set
echo $FIREBASE_PROJECT_ID
echo $FIREBASE_WEB_API_KEY
echo $SUPABASE_URL
echo $SUPABASE_ANON_KEY
```

2. **Ensure services are running:**
```bash
# Check Docker containers
docker-compose ps

# Check Firebase emulator (if using)
firebase emulators:start
```

3. **Clean and rebuild:**
```bash
# Clean node_modules
rm -rf node_modules package-lock.json
npm install

# Rebuild TypeScript
npm run build

# Re-run tests
npm test
```

4. **Run tests individually:**
```bash
# Run one test at a time to isolate issues
npm test -- --testNamePattern="specific test name"
```

---

## ✅ Success Criteria

Your integration is successful if:

- ✅ Cloud Functions deployed without errors
- ✅ New Firebase users automatically sync to Supabase
- ✅ JWT tokens from Firebase are accepted by Supabase
- ✅ RLS policies correctly restrict data access
- ✅ Users can access their own data with JWT tokens
- ✅ Service role key bypasses RLS for admin operations
- ✅ All integration tests pass
- ✅ Cloud Function logs show successful syncs
- ✅ No errors in Firebase or Supabase logs

---

## 📝 Checkpoint Completion

Once all verification steps pass, you can mark Task 10 as complete!

**Next Steps:**
- Proceed to Task 11: Implement client-side integration example
- Or continue with Task 12: Create development workflow scripts

---

## 🆘 Need Help?

If you encounter issues not covered in this guide:

1. **Check logs:**
   - Firebase: `firebase functions:log`
   - Supabase: Dashboard → Logs
   - Docker: `docker-compose logs`

2. **Review documentation:**
   - [Firebase Authentication Guide](./firebase-authentication-guide.md)
   - [Supabase Project Setup Guide](./supabase-project-setup-guide.md)

3. **Ask for help:**
   - Create an issue on GitHub
   - Check Stack Overflow
   - Contact support

---

**Good luck with your checkpoint! 🚀**
