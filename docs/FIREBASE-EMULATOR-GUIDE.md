# Firebase Emulator Guide

## Tổng quan

Firebase Emulator Suite cho phép bạn test và debug Cloud Functions locally mà không cần deploy lên production. Guide này hướng dẫn cách setup và sử dụng Firebase Emulator để phát triển và test functions.

## Cấu hình Emulator

### Emulator Suite Components

Firebase Emulator Suite đã được cấu hình trong `firebase.json`:

```json
{
  "emulators": {
    "functions": {
      "port": 5001
    },
    "auth": {
      "port": 9099
    },
    "ui": {
      "enabled": true,
      "port": 4000
    },
    "singleProjectMode": true,
    "logging": {
      "level": "DEBUG"
    }
  }
}
```

**Các thành phần:**
- **Functions Emulator** (port 5001): Chạy Cloud Functions locally
- **Auth Emulator** (port 9099): Mô phỏng Firebase Authentication
- **Emulator UI** (port 4000): Web interface để quản lý emulators
- **Debug Logging**: Enabled để xem chi tiết execution logs

## Khởi động Emulator

### Cách 1: Sử dụng npm script (Recommended)

```bash
cd functions
npm run serve
```

Script này sẽ:
1. Build TypeScript code (`npm run build`)
2. Start Firebase emulators với functions và auth

### Cách 2: Sử dụng Firebase CLI trực tiếp

```bash
# Start tất cả emulators
firebase emulators:start

# Start chỉ functions và auth
firebase emulators:start --only functions,auth

# Start với import/export data
firebase emulators:start --import=./emulator-data --export-on-exit
```

### Verify Emulator đang chạy

Sau khi start, bạn sẽ thấy output:

```
┌─────────────────────────────────────────────────────────────┐
│ ✔  All emulators ready! It is now safe to connect your app. │
│ i  View Emulator UI at http://localhost:4000                │
└─────────────────────────────────────────────────────────────┘

┌───────────┬────────────────┬─────────────────────────────────┐
│ Emulator  │ Host:Port      │ View in Emulator UI             │
├───────────┼────────────────┼─────────────────────────────────┤
│ Functions │ localhost:5001 │ http://localhost:4000/functions │
├───────────┼────────────────┼─────────────────────────────────┤
│ Auth      │ localhost:9099 │ http://localhost:4000/auth      │
└───────────┴────────────────┴─────────────────────────────────┘
```

Truy cập http://localhost:4000 để mở Emulator UI.

## Testing với Emulator

### 1. Unit Tests với Emulator

Chạy unit tests với emulator environment:

```bash
cd functions

# Set environment variable để connect đến emulator
export FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
export FIRESTORE_EMULATOR_HOST=localhost:8080

# Run tests
npm test
```

**Trong test code:**

```typescript
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// Initialize với emulator
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';

const app = initializeApp({ projectId: 'demo-project' });
const auth = getAuth(app);

// Tạo test user
const testUser = await auth.createUser({
  uid: 'test-uid-123',
  email: 'test@example.com',
  displayName: 'Test User'
});
```

### 2. Integration Tests với Emulator

Test Cloud Functions với emulator:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as admin from 'firebase-admin';

describe('Cloud Function Integration Tests', () => {
  beforeAll(() => {
    // Connect to emulator
    process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
    admin.initializeApp({ projectId: 'demo-project' });
  });

  afterAll(async () => {
    // Cleanup
    await admin.app().delete();
  });

  it('should sync user to Supabase when created', async () => {
    const auth = admin.auth();
    
    // Create user in Auth emulator
    const userRecord = await auth.createUser({
      email: 'newuser@example.com',
      displayName: 'New User',
      password: 'password123'
    });

    // Wait for function to execute
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify user synced to Supabase
    const { data } = await supabase
      .from('users')
      .select('*')
      .eq('firebase_uid', userRecord.uid)
      .single();

    expect(data).toBeDefined();
    expect(data.email).toBe('newuser@example.com');
  });
});
```

### 3. Manual Testing với Emulator UI

#### Bước 1: Start Emulator

```bash
cd functions
npm run serve
```

#### Bước 2: Mở Emulator UI

Truy cập http://localhost:4000

#### Bước 3: Tạo Test User

1. Click vào **Authentication** tab
2. Click **Add user**
3. Nhập thông tin:
   - Email: `test@example.com`
   - Password: `password123`
   - Display Name: `Test User`
4. Click **Save**

#### Bước 4: Xem Function Logs

1. Click vào **Functions** tab
2. Bạn sẽ thấy function `syncUserToSupabase` được trigger
3. Click vào function để xem detailed logs
4. Verify function execution thành công

#### Bước 5: Verify Data trong Supabase

```bash
# Sử dụng Supabase client hoặc SQL query
psql -h localhost -U postgres -d directus -c "SELECT * FROM public.users WHERE email = 'test@example.com';"
```

## Debugging Cloud Functions

### 1. Sử dụng Console Logs

Thêm console.log statements trong function code:

```typescript
export const syncUserToSupabase = functions.auth.user().onCreate(async (user) => {
  console.log('Function triggered for user:', user.uid);
  console.log('User data:', { email: user.email, displayName: user.displayName });

  try {
    const result = await supabase.from('users').upsert({
      firebase_uid: user.uid,
      email: user.email || '',
      display_name: user.displayName || null,
    });

    console.log('Supabase upsert result:', result);
    return { success: true };
  } catch (error) {
    console.error('Error syncing user:', error);
    throw error;
  }
});
```

Logs sẽ hiển thị trong terminal và Emulator UI.

### 2. Sử dụng Firebase Functions Shell

```bash
cd functions
npm run shell
```

Trong shell, bạn có thể trigger functions manually:

```javascript
// Trigger syncUserToSupabase với mock data
syncUserToSupabase({
  uid: 'test-uid-123',
  email: 'test@example.com',
  displayName: 'Test User',
  photoURL: 'https://example.com/photo.jpg'
})
```

### 3. Sử dụng VS Code Debugger

**Bước 1:** Tạo `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to Firebase Emulator",
      "port": 9229,
      "restart": true,
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/functions/lib/**/*.js"]
    }
  ]
}
```

**Bước 2:** Start emulator với debug mode:

```bash
cd functions
firebase emulators:start --inspect-functions
```

**Bước 3:** Trong VS Code:
1. Set breakpoints trong TypeScript code
2. Press F5 hoặc click "Start Debugging"
3. Trigger function từ Emulator UI hoặc test code
4. Debugger sẽ pause tại breakpoints

### 4. Xem Detailed Logs

```bash
# Xem logs real-time
firebase emulators:start --debug

# Xem logs với specific log level
firebase emulators:start --only functions --debug
```

## Environment Variables cho Emulator

### Cấu hình Local Environment

Tạo file `functions/.runtimeconfig.json` cho local testing:

```json
{
  "supabase": {
    "url": "https://your-project.supabase.co",
    "service_key": "your-service-role-key"
  }
}
```

**Lưu ý:** File này chứa secrets, đảm bảo đã thêm vào `.gitignore`.

### Load Environment Variables

```bash
# Set environment variables trước khi start emulator
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_KEY="your-service-role-key"

firebase emulators:start
```

Hoặc sử dụng trong code:

```typescript
const supabaseUrl = process.env.SUPABASE_URL || functions.config().supabase.url;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || functions.config().supabase.service_key;
```

## Testing Workflows

### Workflow 1: Test User Creation Flow

```bash
# Terminal 1: Start emulator
cd functions
npm run serve

# Terminal 2: Run integration test
npm run test:integration

# Terminal 3: Monitor Supabase database
watch -n 2 'psql -h localhost -U postgres -d directus -c "SELECT * FROM public.users ORDER BY created_at DESC LIMIT 5;"'
```

### Workflow 2: Test với Property-Based Tests

```bash
# Start emulator
cd functions
npm run serve

# Trong terminal khác, run property tests
npm run test:property
```

Property tests sẽ generate nhiều test cases và verify functions hoạt động đúng với mọi input.

### Workflow 3: Manual End-to-End Testing

1. **Start tất cả services:**
   ```bash
   # Terminal 1: Docker services
   docker-compose up
   
   # Terminal 2: Firebase emulator
   cd functions
   npm run serve
   ```

2. **Tạo user qua client app:**
   ```bash
   cd client
   npm run dev
   # Mở browser và đăng ký user mới
   ```

3. **Verify trong Emulator UI:**
   - Mở http://localhost:4000/auth
   - Verify user được tạo
   - Mở http://localhost:4000/functions
   - Verify function được trigger

4. **Verify trong Supabase:**
   ```bash
   psql -h localhost -U postgres -d directus -c "SELECT * FROM public.users;"
   ```

## Troubleshooting

### Issue 1: Emulator không start

**Triệu chứng:**
```
Error: Port 5001 is already in use
```

**Giải pháp:**
```bash
# Tìm process đang sử dụng port
lsof -i :5001  # macOS/Linux
netstat -ano | findstr :5001  # Windows

# Kill process
kill -9 <PID>  # macOS/Linux
taskkill /PID <PID> /F  # Windows

# Hoặc thay đổi port trong firebase.json
```

### Issue 2: Functions không trigger

**Triệu chứng:**
- User được tạo trong Auth emulator
- Function không được trigger

**Giải pháp:**
1. Verify function được deploy đúng:
   ```bash
   cd functions
   npm run build
   ```

2. Check logs trong Emulator UI
3. Verify function name match với code
4. Restart emulator

### Issue 3: Environment variables không load

**Triệu chứng:**
```
Error: Cannot read property 'url' of undefined
```

**Giải pháp:**
1. Tạo `functions/.runtimeconfig.json`
2. Hoặc set environment variables:
   ```bash
   export SUPABASE_URL="..."
   export SUPABASE_SERVICE_KEY="..."
   ```

3. Verify trong code:
   ```typescript
   console.log('Supabase URL:', process.env.SUPABASE_URL);
   ```

### Issue 4: Supabase connection fails

**Triệu chứng:**
```
Error: connect ECONNREFUSED
```

**Giải pháp:**
1. Verify Supabase URL đúng
2. Verify service role key hợp lệ
3. Check network connectivity
4. Verify RLS policies không block service role

## Best Practices

### 1. Sử dụng Demo Project ID

Khi test với emulator, sử dụng demo project ID:

```typescript
admin.initializeApp({ projectId: 'demo-project' });
```

Điều này đảm bảo không accidentally connect đến production.

### 2. Clean Up Test Data

Sau mỗi test, clean up data:

```typescript
afterEach(async () => {
  // Delete test users
  const users = await admin.auth().listUsers();
  await Promise.all(
    users.users.map(user => admin.auth().deleteUser(user.uid))
  );
});
```

### 3. Sử dụng Import/Export Data

Save emulator state để reuse:

```bash
# Export data khi stop
firebase emulators:start --export-on-exit=./emulator-data

# Import data khi start
firebase emulators:start --import=./emulator-data
```

### 4. Isolate Tests

Mỗi test nên tạo unique test data:

```typescript
const testEmail = `test-${Date.now()}@example.com`;
const testUid = `test-uid-${Date.now()}`;
```

### 5. Monitor Performance

Track function execution time:

```typescript
const startTime = Date.now();
await syncUserToSupabase(user);
const duration = Date.now() - startTime;
console.log(`Function completed in ${duration}ms`);
expect(duration).toBeLessThan(5000); // Requirement 6.6
```

## Continuous Integration

### GitHub Actions với Emulator

```yaml
name: Test with Firebase Emulator

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install Firebase CLI
        run: npm install -g firebase-tools
      
      - name: Install dependencies
        run: |
          cd functions
          npm ci
      
      - name: Start Firebase Emulator
        run: |
          cd functions
          firebase emulators:start --only auth,functions &
          sleep 10
      
      - name: Run tests
        run: |
          cd functions
          npm test
        env:
          FIREBASE_AUTH_EMULATOR_HOST: localhost:9099
      
      - name: Stop Emulator
        run: |
          pkill -f firebase
```

## Tài liệu Tham khảo

- [Firebase Emulator Suite Documentation](https://firebase.google.com/docs/emulator-suite)
- [Testing Cloud Functions](https://firebase.google.com/docs/functions/local-emulator)
- [Firebase Auth Emulator](https://firebase.google.com/docs/emulator-suite/connect_auth)
- [Debugging Functions](https://firebase.google.com/docs/functions/local-shell)

## Liên quan

- [Test Environment Guide](./TEST-ENVIRONMENT-GUIDE.md)
- [Firebase Authentication Guide](./firebase-authentication-guide.md)
- [Cloud Functions README](../functions/README.md)
- [Testing Procedures](./TESTING-PROCEDURES.md)

---

**Validates Requirements:** 9.7, 11.1, 11.2, 11.3, 11.7
