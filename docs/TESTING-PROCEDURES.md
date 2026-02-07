# Testing Procedures Guide

This guide provides comprehensive instructions for running all types of tests in LumiBase, including unit tests, property-based tests, integration tests, and local authentication flow testing.

## Table of Contents

- [Overview](#overview)
- [Test Environment Setup](#test-environment-setup)
- [Running Unit Tests](#running-unit-tests)
- [Running Property-Based Tests](#running-property-based-tests)
- [Running Integration Tests](#running-integration-tests)
- [Testing Authentication Flow Locally](#testing-authentication-flow-locally)
- [Debugging Cloud Functions Locally](#debugging-cloud-functions-locally)
- [Continuous Integration](#continuous-integration)
- [Troubleshooting Tests](#troubleshooting-tests)

## Overview

LumiBase uses a comprehensive testing strategy with three types of tests:

- **Unit Tests**: Test individual functions and components in isolation
- **Property-Based Tests**: Test universal properties across many generated inputs
- **Integration Tests**: Test interactions between components (database, API, authentication)

### Testing Stack

- **Test Framework**: [Vitest](https://vitest.dev/) - Fast unit test framework
- **Property Testing**: [fast-check](https://github.com/dubzzz/fast-check) - Property-based testing library
- **Database**: PostgreSQL in Docker (isolated test environment)
- **Firebase**: Firebase Emulator Suite for local testing
- **Supabase**: Test instance with separate database

## Test Environment Setup

### Isolated Test Environment

LumiBase uses a separate Docker environment for testing to avoid conflicts with development:

**Development Environment:**
- PostgreSQL: Port `5432`
- Directus: Port `8055`

**Test Environment:**
- PostgreSQL: Port `5433`
- Directus: Port `8056`

### Starting Test Environment

```bash
# Start test environment
npm run test:env:up

# Check status
npm run test:env:status

# View logs
npm run test:env:logs

# Stop test environment
npm run test:env:down

# Clean test environment (remove all data)
npm run test:env:clean
```

### Manual Test Environment Setup

If you prefer manual control:

```bash
# Start test containers
docker-compose -f docker-compose.test.yml up -d

# Wait for services to be ready
sleep 10

# Verify services are running
docker-compose -f docker-compose.test.yml ps

# Stop test containers
docker-compose -f docker-compose.test.yml down

# Clean up test data
docker-compose -f docker-compose.test.yml down -v
```

### Environment Variables for Testing

Create `.env.test` file (already exists in project):

```bash
# Test Database Configuration
DB_USER=directus_test
DB_PASSWORD=test_password
DB_NAME=directus_test

# Test Directus Configuration
DIRECTUS_KEY=test-key-32-characters-minimum
DIRECTUS_SECRET=test-secret-32-characters-minimum
DIRECTUS_ADMIN_EMAIL=admin@test.com
DIRECTUS_ADMIN_PASSWORD=test_admin_password

# Test Supabase Configuration (use test project)
SUPABASE_URL=https://test-project.supabase.co
SUPABASE_ANON_KEY=test-anon-key
SUPABASE_SERVICE_ROLE_KEY=test-service-role-key
SUPABASE_JWT_SECRET=test-jwt-secret

# Test Firebase Configuration
FIREBASE_PROJECT_ID=test-project-id
FIREBASE_PRIVATE_KEY="test-private-key"
FIREBASE_CLIENT_EMAIL=test@test-project.iam.gserviceaccount.com
FIREBASE_WEB_API_KEY=test-api-key
```

## Running Unit Tests

Unit tests verify specific functionality of individual components.

### Run All Unit Tests

```bash
# Run all unit tests
npm run test:unit

# Run with coverage
npm run test:unit -- --coverage

# Run in watch mode (auto-rerun on changes)
npm run test:unit -- --watch

# Run specific test file
npm run test:unit tests/unit/database-schema.test.ts
```

### Unit Test Examples

**Database Schema Tests** (`tests/unit/database-schema.test.ts`):
- Verify users table exists with correct columns
- Verify data types and constraints
- Verify indexes exist
- Verify triggers work correctly

**Docker Compose Tests** (`tests/unit/docker-compose.test.ts`):
- Verify Directus service configuration
- Verify PostgreSQL service configuration
- Verify network setup
- Verify volume mounts

### Writing Unit Tests

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

describe('Database Schema', () => {
  let supabase;

  beforeAll(async () => {
    // Setup test database connection
    supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  });

  it('should have users table with correct columns', async () => {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .limit(0);
    
    expect(error).toBeNull();
    // Verify columns exist by checking metadata
  });

  afterAll(async () => {
    // Cleanup
  });
});
```

## Running Property-Based Tests

Property-based tests verify universal properties hold across many generated inputs.

### Run All Property Tests

```bash
# Run all property-based tests
npm run test:property

# Run with coverage
npm run test:property -- --coverage

# Run specific property test
npm run test:property tests/property/database-schema-integrity.property.test.ts
```

### Property Test Examples

**Property 1: Database Schema Integrity** (`tests/property/database-schema-integrity.property.test.ts`):
- Verifies schema consistency across different database states
- Tests that all required columns exist with correct types
- Validates constraints and indexes

**Property 2: RLS Access Control** (`tests/property/rls-access-control.property.test.ts`):
- Verifies users can only access their own data
- Tests that RLS policies work correctly for all user combinations
- Validates service role bypass

**Property 3: Environment Configuration Completeness** (`tests/property/environment-config-completeness.property.test.ts`):
- Verifies all required environment variables are defined
- Tests that .env.example contains all necessary variables
- Validates no sensitive data in example file

**Property 4: Cloud Function Data Extraction** (`functions/test/data-extraction.property.test.ts`):
- Verifies correct field mapping from Firebase to Supabase
- Tests data extraction across many user object variations
- Validates handling of optional fields

**Property 5: JWT Token Validation** (`tests/property/jwt-token-validation.property.test.ts`):
- Verifies JWT tokens are validated correctly
- Tests rejection of invalid/expired tokens
- Validates claim extraction

### Writing Property Tests

```typescript
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

describe('Property 4: Cloud Function Data Extraction', () => {
  // Feature: directus-firebase-supabase-setup, Property 4: Cloud Function Data Extraction
  it('should correctly extract and map all fields from Firebase user object', () => {
    fc.assert(
      fc.property(
        fc.record({
          uid: fc.string({ minLength: 1, maxLength: 128 }),
          email: fc.emailAddress(),
          displayName: fc.option(fc.string(), { nil: null }),
          photoURL: fc.option(fc.webUrl(), { nil: null }),
        }),
        (firebaseUser) => {
          const mapped = extractUserData(firebaseUser);
          
          expect(mapped.firebase_uid).toBe(firebaseUser.uid);
          expect(mapped.email).toBe(firebaseUser.email);
          expect(mapped.display_name).toBe(firebaseUser.displayName);
          expect(mapped.photo_url).toBe(firebaseUser.photoURL);
        }
      ),
      { numRuns: 100 }  // Run 100 iterations
    );
  });
});
```

### Property Test Configuration

- **Minimum iterations**: 100 runs per property
- **Timeout**: 10 seconds per test
- **Shrinking**: Enabled (fast-check automatically finds minimal failing case)

## Running Integration Tests

Integration tests verify that components work together correctly.

### Run All Integration Tests

```bash
# Run all integration tests
npm run test:integration

# Run with coverage
npm run test:integration -- --coverage

# Run specific integration test
npm run test:integration tests/integration/rls-policies.integration.test.ts
```

### Integration Test Examples

**RLS Policies Integration** (`tests/integration/rls-policies.integration.test.ts`):
- Test user can read own data with valid JWT
- Test user cannot read other user's data
- Test user can update own data
- Test user cannot delete other user's data
- Test service role bypasses RLS
- Test access denied without JWT token

**Supabase JWT Verification** (`tests/integration/supabase-jwt-verification.test.ts`):
- Test Supabase accepts valid Firebase JWT tokens
- Test Supabase rejects invalid JWT signatures
- Test Supabase rejects expired JWT tokens
- Test Supabase extracts firebase_uid from JWT
- Test Supabase returns 401 for invalid tokens

### Prerequisites for Integration Tests

1. **Test environment must be running**:
   ```bash
   npm run test:env:up
   ```

2. **Database schema must be applied**:
   ```bash
   # Schema is automatically applied when test environment starts
   # Verify with:
   docker-compose -f docker-compose.test.yml exec postgres psql -U directus_test -d directus_test -c "\d public.users"
   ```

3. **Environment variables must be set** in `.env.test`

### Writing Integration Tests

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

describe('RLS Policies Integration', () => {
  let supabaseAdmin;
  let supabaseUser1;
  let user1Token;

  beforeAll(async () => {
    // Setup admin client
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Create test user and get JWT token
    user1Token = await createTestUser('user1@test.com');
    
    // Setup user client with JWT
    supabaseUser1 = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
      {
        global: {
          headers: { Authorization: `Bearer ${user1Token}` }
        }
      }
    );
  });

  it('should allow user to read own data', async () => {
    const { data, error } = await supabaseUser1
      .from('users')
      .select('*')
      .eq('firebase_uid', 'user1-uid');
    
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  afterAll(async () => {
    // Cleanup test data
    await supabaseAdmin
      .from('users')
      .delete()
      .eq('email', 'user1@test.com');
  });
});
```

## Testing Authentication Flow Locally

Test the complete authentication flow from Firebase to Supabase locally.

### Prerequisites

1. **Firebase Emulator running**:
   ```bash
   cd functions
   firebase emulators:start
   ```

2. **Test environment running**:
   ```bash
   npm run test:env:up
   ```

3. **Client example ready**:
   ```bash
   cd client
   npm install
   ```

### Step-by-Step Testing

#### 1. Start Firebase Emulator

```bash
cd functions
firebase emulators:start
```

This starts:
- **Auth Emulator**: http://localhost:9099
- **Functions Emulator**: http://localhost:5001
- **Emulator UI**: http://localhost:4000

#### 2. Configure Client for Emulator

Update `client/auth.ts` to use emulator:

```typescript
import { connectAuthEmulator } from 'firebase/auth';

const auth = getAuth(app);

// Connect to emulator (only in development)
if (process.env.NODE_ENV === 'development') {
  connectAuthEmulator(auth, 'http://localhost:9099');
}
```

#### 3. Test Sign Up Flow

```bash
# Open client example
cd client
npm run dev

# Or open example.html in browser
open example.html
```

**Manual Testing Steps:**

1. Click "Sign in with Google" button
2. Emulator will show fake Google sign-in page
3. Enter any email (e.g., test@example.com)
4. Click "Sign in"
5. Check browser console for JWT token
6. Verify user synced to Supabase:
   ```bash
   docker-compose -f docker-compose.test.yml exec postgres psql -U directus_test -d directus_test -c "SELECT * FROM public.users;"
   ```

#### 4. Test Data Access

```typescript
// In browser console or client code
const token = await user.getIdToken();
console.log('JWT Token:', token);

// Set token for Supabase
await supabase.auth.setSession({
  access_token: token,
  refresh_token: '',
});

// Fetch user data
const { data, error } = await supabase
  .from('users')
  .select('*')
  .eq('firebase_uid', user.uid)
  .single();

console.log('User data:', data);
```

#### 5. Test RLS Policies

```typescript
// Try to access another user's data (should fail)
const { data, error } = await supabase
  .from('users')
  .select('*')
  .eq('firebase_uid', 'different-user-uid');

console.log('Should be empty:', data);  // RLS filters it out
```

### Automated E2E Test

Create `client/tests/e2e-auth-flow.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, connectAuthEmulator } from 'firebase/auth';
import { createClient } from '@supabase/supabase-js';

describe('E2E Authentication Flow', () => {
  let auth;
  let supabase;

  beforeAll(() => {
    const app = initializeApp({
      apiKey: 'fake-api-key',
      projectId: 'test-project',
    });
    
    auth = getAuth(app);
    connectAuthEmulator(auth, 'http://localhost:9099');
    
    supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!
    );
  });

  it('should complete full auth flow', async () => {
    // 1. Sign in with Firebase
    const userCredential = await signInWithEmailAndPassword(
      auth,
      'test@example.com',
      'password123'
    );
    
    // 2. Get JWT token
    const token = await userCredential.user.getIdToken();
    expect(token).toBeTruthy();
    
    // 3. Wait for Cloud Function to sync
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 4. Set token for Supabase
    await supabase.auth.setSession({
      access_token: token,
      refresh_token: '',
    });
    
    // 5. Query Supabase with JWT
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('firebase_uid', userCredential.user.uid)
      .single();
    
    // 6. Verify data synced correctly
    expect(error).toBeNull();
    expect(data.email).toBe('test@example.com');
  }, 15000);  // 15 second timeout
});
```

Run the E2E test:

```bash
cd client
npm test
```

## Debugging Cloud Functions Locally

Debug Firebase Cloud Functions locally using the emulator.

### Setup Debugging

#### 1. Start Emulator with Inspect

```bash
cd functions

# Start with Node.js inspector
firebase emulators:start --inspect-functions
```

This starts the debugger on port `9229`.

#### 2. Attach Debugger (VS Code)

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to Firebase Functions",
      "port": 9229,
      "restart": true,
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/functions/lib/**/*.js"]
    }
  ]
}
```

**Steps:**
1. Start emulator with `--inspect-functions`
2. In VS Code, press `F5` or go to Run → Start Debugging
3. Select "Attach to Firebase Functions"
4. Set breakpoints in `functions/src/index.ts`
5. Trigger function (create user in Auth Emulator)
6. Debugger will pause at breakpoints

#### 3. View Function Logs

```bash
# View all logs
firebase emulators:start --debug

# View specific function logs
# Logs appear in terminal where emulator is running
```

### Testing Functions Locally

#### Test syncUserToSupabase

```bash
# 1. Start emulator
cd functions
firebase emulators:start

# 2. Open Emulator UI
open http://localhost:4000

# 3. Go to Authentication tab
# 4. Click "Add user"
# 5. Enter email and password
# 6. Click "Save"

# 7. Check function logs in terminal
# Should see: "Successfully synced user to Supabase: <uid>"

# 8. Verify in Supabase
docker-compose -f docker-compose.test.yml exec postgres psql -U directus_test -d directus_test -c "SELECT * FROM public.users;"
```

#### Test with Unit Tests

```bash
cd functions
npm test

# Run specific test
npm test -- data-extraction.property.test.ts

# Run with coverage
npm test -- --coverage
```

### Common Debugging Scenarios

#### Function Not Triggering

**Check:**
1. Emulator is running: `firebase emulators:start`
2. Function is deployed to emulator (check terminal output)
3. Trigger event is correct (onCreate for new users)

**Solution:**
```bash
# Restart emulator
# Ctrl+C to stop
firebase emulators:start --debug
```

#### Function Fails Silently

**Check logs:**
```bash
# In emulator terminal, look for error messages
# Common issues:
# - Supabase credentials not set
# - Network connectivity
# - Invalid data format
```

**Add more logging:**
```typescript
export const syncUserToSupabase = functions.auth.user().onCreate(async (user) => {
  console.log('Function triggered for user:', user.uid);
  console.log('User data:', JSON.stringify(user, null, 2));
  
  try {
    // ... function code
    console.log('Successfully synced user');
  } catch (error) {
    console.error('Error syncing user:', error);
    console.error('Error stack:', error.stack);
  }
});
```

#### Supabase Connection Fails

**Check configuration:**
```bash
# Verify .runtimeconfig.json exists
cat functions/.runtimeconfig.json

# Should contain:
# {
#   "supabase": {
#     "url": "https://...",
#     "service_key": "eyJ..."
#   }
# }
```

**Test connection:**
```typescript
// Add to function
const { data, error } = await supabase
  .from('users')
  .select('count')
  .limit(1);

console.log('Supabase connection test:', { data, error });
```

## Continuous Integration

Tests run automatically on every push and pull request via GitHub Actions.

### CI Workflow

See `.github/workflows/test.yml`:

```yaml
name: Test Suite

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Start test environment
        run: npm run test:env:up
      
      - name: Run tests
        run: npm test
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

### Viewing CI Results

1. Go to repository on GitHub
2. Click "Actions" tab
3. Select workflow run
4. View test results and logs

### Running Tests Like CI

```bash
# Run exactly like CI does
npm ci  # Clean install
npm run test:env:up
npm test
npm run test:env:down
```

## Troubleshooting Tests

### Tests Fail with "Connection Refused"

**Problem**: Can't connect to test database

**Solution:**
```bash
# Start test environment
npm run test:env:up

# Wait for services
sleep 10

# Verify services are running
docker-compose -f docker-compose.test.yml ps

# Check logs
npm run test:env:logs
```

### Property Tests Fail Intermittently

**Problem**: Tests pass sometimes, fail other times

**Solution:**
```typescript
// Use deterministic seed
fc.assert(
  fc.property(/* ... */),
  { seed: 42, numRuns: 100 }
);

// Increase timeout
it('property test', async () => {
  // ... test code
}, 10000);  // 10 seconds

// Add proper cleanup
afterEach(async () => {
  await cleanupTestData();
});
```

### Integration Tests Timeout

**Problem**: Tests take too long and timeout

**Solution:**
```typescript
// Increase timeout for slow tests
it('integration test', async () => {
  // ... test code
}, 30000);  // 30 seconds

// Or globally in vitest.config.ts
export default defineConfig({
  test: {
    testTimeout: 30000,
  },
});
```

### Firebase Emulator Issues

**Problem**: Emulator won't start or functions don't trigger

**Solution:**
```bash
# Clear emulator data
firebase emulators:start --clear-data

# Check port availability
lsof -i :9099  # Auth emulator
lsof -i :5001  # Functions emulator

# Update Firebase CLI
npm install -g firebase-tools@latest
```

### Test Data Cleanup

**Problem**: Tests fail due to leftover data from previous runs

**Solution:**
```bash
# Clean test environment completely
npm run test:env:clean

# Or manually
docker-compose -f docker-compose.test.yml down -v
docker-compose -f docker-compose.test.yml up -d
```

### Coverage Reports

**Generate coverage report:**
```bash
# Run all tests with coverage
npm run test:coverage

# View HTML report
open coverage/index.html
```

**Coverage thresholds** (configured in `vitest.config.ts`):
- Statements: 80%
- Branches: 75%
- Functions: 80%
- Lines: 80%

## Best Practices

### Test Organization

- **Unit tests**: `tests/unit/` - Fast, isolated tests
- **Integration tests**: `tests/integration/` - Test component interactions
- **Property tests**: `tests/property/` - Test universal properties
- **E2E tests**: `client/tests/` - Test complete user flows

### Test Naming

```typescript
// Good: Descriptive test names
it('should allow user to read own data with valid JWT', async () => {});

// Bad: Vague test names
it('test 1', async () => {});
```

### Test Independence

```typescript
// Each test should be independent
describe('User Tests', () => {
  beforeEach(async () => {
    // Setup fresh state for each test
    await cleanupTestData();
    await seedTestData();
  });

  afterEach(async () => {
    // Cleanup after each test
    await cleanupTestData();
  });
});
```

### Avoid Test Flakiness

```typescript
// Bad: Relies on timing
await createUser();
const user = await getUser();  // Might fail if not ready

// Good: Wait for condition
await createUser();
await waitFor(() => getUser(), { timeout: 5000 });
```

### Mock External Services

```typescript
// Mock Firebase Admin SDK in unit tests
vi.mock('firebase-admin', () => ({
  auth: () => ({
    getUser: vi.fn().mockResolvedValue({ uid: 'test-uid' }),
  }),
}));
```

## Additional Resources

- [Vitest Documentation](https://vitest.dev/)
- [fast-check Documentation](https://github.com/dubzzz/fast-check)
- [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite)
- [Supabase Testing Guide](https://supabase.com/docs/guides/getting-started/local-development)
- [Test Environment Guide](./TEST-ENVIRONMENT-GUIDE.md)
- [Firebase Emulator Guide](./FIREBASE-EMULATOR-GUIDE.md)

---

**Need help?** Open an issue on [GitHub](https://github.com/khuepm/LumiBase/issues) or check the [Troubleshooting section](#troubleshooting-tests).
