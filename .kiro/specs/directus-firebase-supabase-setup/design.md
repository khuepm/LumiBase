# Tài liệu Thiết kế: Thiết lập Directus với Firebase và Supabase

## Tổng quan

Hệ thống này tích hợp ba nền tảng chính để tạo ra một kiến trúc backend hiện đại:

- **Firebase Authentication**: Xử lý xác thực người dùng (Google OAuth, Email/Password) và phát hành JWT tokens
- **Supabase (PostgreSQL)**: Cơ sở dữ liệu chính với Realtime capabilities và Row Level Security
- **Directus CMS**: Headless CMS kết nối trực tiếp với Supabase database để quản lý nội dung

Kiến trúc này cho phép:
- Xác thực tập trung qua Firebase với nhiều providers
- Lưu trữ dữ liệu an toàn trong Supabase với RLS
- Quản lý nội dung dễ dàng qua Directus UI
- Đồng bộ tự động giữa Firebase và Supabase
- Môi trường phát triển local nhất quán với Docker

## Kiến trúc

### Sơ đồ Tổng quan

```mermaid
graph TB
    Client[Client Application]
    Firebase[Firebase Auth]
    Functions[Cloud Functions]
    Supabase[Supabase PostgreSQL]
    Directus[Directus CMS]
    
    Client -->|1. Authenticate| Firebase
    Firebase -->|2. JWT Token| Client
    Client -->|3. API Request + JWT| Supabase
    Supabase -->|4. Verify JWT| Firebase
    Firebase -->|5. onCreate Trigger| Functions
    Functions -->|6. Sync User Data| Supabase
    Directus -->|7. Direct DB Connection| Supabase
    
    subgraph "Docker Environment"
        Directus
        Supabase
    end
```

### Luồng Xác thực

```mermaid
sequenceDiagram
    participant User
    participant Client
    participant Firebase
    participant CloudFn
    participant Supabase
    
    User->>Client: Đăng nhập
    Client->>Firebase: Authenticate (Google/Email)
    Firebase->>Firebase: Tạo user mới
    Firebase->>CloudFn: Trigger onCreate
    CloudFn->>Supabase: INSERT INTO public.users
    Firebase->>Client: JWT Token
    Client->>Supabase: API Request + JWT
    Supabase->>Firebase: Verify JWT signature
    Firebase->>Supabase: Valid + firebase_uid
    Supabase->>Supabase: Check RLS policies
    Supabase->>Client: Data response
```

### Docker Architecture

```mermaid
graph LR
    subgraph "Docker Compose"
        Directus[Directus Container<br/>Port 8055]
        Postgres[PostgreSQL Container<br/>Port 5432]
        Network[Docker Network<br/>directus-network]
        
        Directus -.->|connects via| Network
        Postgres -.->|connects via| Network
        Directus -->|DB Connection| Postgres
    end
    
    Host[Host Machine<br/>Windows] -->|Port Mapping| Directus
    Volumes[Docker Volumes] -->|Data Persistence| Postgres
    Volumes2[Docker Volumes] -->|Uploads/Extensions| Directus
```

## Các Thành phần và Giao diện

### 1. Docker Compose Configuration

**File: docker-compose.yml**

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    container_name: directus-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init-scripts:/docker-entrypoint-initdb.d
    networks:
      - directus-network
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

  directus:
    image: directus/directus:10-latest
    container_name: directus-cms
    restart: unless-stopped
    ports:
      - "8055:8055"
    environment:
      KEY: ${DIRECTUS_KEY}
      SECRET: ${DIRECTUS_SECRET}
      ADMIN_EMAIL: ${DIRECTUS_ADMIN_EMAIL}
      ADMIN_PASSWORD: ${DIRECTUS_ADMIN_PASSWORD}
      DB_CLIENT: pg
      DB_HOST: postgres
      DB_PORT: 5432
      DB_DATABASE: ${DB_NAME}
      DB_USER: ${DB_USER}
      DB_PASSWORD: ${DB_PASSWORD}
      CORS_ENABLED: true
      CORS_ORIGIN: true
      PUBLIC_URL: http://localhost:8055
    volumes:
      - directus_uploads:/directus/uploads
      - directus_extensions:/directus/extensions
    networks:
      - directus-network
    depends_on:
      postgres:
        condition: service_healthy

networks:
  directus-network:
    driver: bridge

volumes:
  postgres_data:
  directus_uploads:
  directus_extensions:
```

**Giải thích:**
- PostgreSQL 15 với Alpine Linux (nhẹ)
- Directus 10 latest version
- Health checks đảm bảo PostgreSQL sẵn sàng trước khi Directus khởi động
- Volumes cho data persistence
- Bridge network cho inter-container communication

### 2. Environment Variables

**File: .env.example**

```bash
# Database Configuration
DB_USER=directus
DB_PASSWORD=your_secure_password_here
DB_NAME=directus

# Directus Configuration
DIRECTUS_KEY=your_random_key_32_chars_min
DIRECTUS_SECRET=your_random_secret_32_chars_min
DIRECTUS_ADMIN_EMAIL=admin@example.com
DIRECTUS_ADMIN_PASSWORD=admin_password_here

# Firebase Configuration
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com
FIREBASE_WEB_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Supabase Configuration
SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_JWT_SECRET=your-super-secret-jwt-token-with-at-least-32-characters-long
```

**Security Notes:**
- Không commit file .env vào Git
- Sử dụng strong random strings cho keys và secrets
- Firebase private key phải được escape đúng cách với `\n`

### 3. Database Schema

**File: init-scripts/01-create-schema.sql**

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create users table
CREATE TABLE IF NOT EXISTS public.users (
    firebase_uid VARCHAR(128) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255),
    photo_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on email for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update updated_at
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add comment to table
COMMENT ON TABLE public.users IS 'User data synced from Firebase Authentication';
COMMENT ON COLUMN public.users.firebase_uid IS 'Unique identifier from Firebase Auth';
COMMENT ON COLUMN public.users.email IS 'User email address (unique)';
```

### 4. Row Level Security Policies

**File: init-scripts/02-setup-rls.sql**

```sql
-- Enable Row Level Security on users table
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own data
CREATE POLICY "Users can view own data"
    ON public.users
    FOR SELECT
    USING (auth.uid() = firebase_uid);

-- Policy: Users can update their own data
CREATE POLICY "Users can update own data"
    ON public.users
    FOR UPDATE
    USING (auth.uid() = firebase_uid)
    WITH CHECK (auth.uid() = firebase_uid);

-- Policy: Service role can do everything (bypass RLS)
CREATE POLICY "Service role has full access"
    ON public.users
    FOR ALL
    USING (auth.role() = 'service_role');

-- Policy: Allow insert for authenticated users (for initial sync)
CREATE POLICY "Allow insert for authenticated users"
    ON public.users
    FOR INSERT
    WITH CHECK (auth.uid() = firebase_uid);
```

**Lưu ý:** Supabase cung cấp helper functions như `auth.uid()` và `auth.role()` để trích xuất thông tin từ JWT token.

### 5. Firebase Cloud Function

**File: functions/src/index.ts**

```typescript
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

// Initialize Firebase Admin
admin.initializeApp();

// Initialize Supabase client with service role key
const supabaseUrl = functions.config().supabase.url;
const supabaseServiceKey = functions.config().supabase.service_key;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

/**
 * Cloud Function triggered when a new user is created in Firebase Auth
 * Syncs user data to Supabase database
 */
export const syncUserToSupabase = functions.auth.user().onCreate(async (user) => {
  const { uid, email, displayName, photoURL } = user;

  try {
    // Insert or update user in Supabase
    const { data, error } = await supabase
      .from('users')
      .upsert({
        firebase_uid: uid,
        email: email || '',
        display_name: displayName || null,
        photo_url: photoURL || null,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'firebase_uid'
      });

    if (error) {
      console.error('Error syncing user to Supabase:', error);
      throw error;
    }

    console.log('Successfully synced user to Supabase:', uid);
    return { success: true, uid };
  } catch (error) {
    console.error('Failed to sync user:', error);
    // Don't throw - we don't want to block user creation
    return { success: false, error: error.message };
  }
});

/**
 * Optional: Cloud Function to handle user deletion
 */
export const deleteUserFromSupabase = functions.auth.user().onDelete(async (user) => {
  const { uid } = user;

  try {
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('firebase_uid', uid);

    if (error) {
      console.error('Error deleting user from Supabase:', error);
      throw error;
    }

    console.log('Successfully deleted user from Supabase:', uid);
    return { success: true, uid };
  } catch (error) {
    console.error('Failed to delete user:', error);
    return { success: false, error: error.message };
  }
});
```

**File: functions/package.json**

```json
{
  "name": "firebase-functions",
  "version": "1.0.0",
  "engines": {
    "node": "18"
  },
  "main": "lib/index.js",
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^4.5.0",
    "@supabase/supabase-js": "^2.38.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/node": "^20.0.0"
  },
  "scripts": {
    "build": "tsc",
    "serve": "npm run build && firebase emulators:start --only functions",
    "deploy": "npm run build && firebase deploy --only functions"
  }
}
```

### 6. Supabase JWT Configuration

Để Supabase chấp nhận JWT tokens từ Firebase, cần cấu hình trong Supabase Dashboard:

**Authentication > Providers > Firebase**

```json
{
  "enabled": true,
  "project_id": "your-firebase-project-id",
  "issuer": "https://securetoken.google.com/your-firebase-project-id"
}
```

**Hoặc sử dụng Supabase CLI:**

```bash
supabase secrets set FIREBASE_PROJECT_ID=your-firebase-project-id
```

### 7. Client-side Integration Example

**File: client/auth.ts**

```typescript
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { createClient } from '@supabase/supabase-js';

// Firebase configuration
const firebaseConfig = {
  apiKey: process.env.FIREBASE_WEB_API_KEY,
  authDomain: `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: process.env.FIREBASE_PROJECT_ID,
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

/**
 * Sign in with Google and get Firebase JWT token
 */
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  const token = await result.user.getIdToken();
  
  // Set token for Supabase client
  await supabase.auth.setSession({
    access_token: token,
    refresh_token: '', // Firebase handles refresh
  });
  
  return result.user;
}

/**
 * Fetch user data from Supabase
 */
export async function getUserData(firebaseUid: string) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('firebase_uid', firebaseUid)
    .single();
  
  if (error) throw error;
  return data;
}
```

## Mô hình Dữ liệu

### Entity Relationship Diagram

```mermaid
erDiagram
    USERS {
        varchar firebase_uid PK
        varchar email UK
        varchar display_name
        text photo_url
        timestamp created_at
        timestamp updated_at
    }
```

### Data Types và Constraints

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| firebase_uid | VARCHAR(128) | PRIMARY KEY | Unique ID từ Firebase Auth |
| email | VARCHAR(255) | UNIQUE NOT NULL | Email người dùng |
| display_name | VARCHAR(255) | NULL | Tên hiển thị |
| photo_url | TEXT | NULL | URL ảnh đại diện |
| created_at | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | Thời gian tạo |
| updated_at | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | Thời gian cập nhật |

### Data Flow

1. **User Registration:**
   - User đăng ký qua Firebase Auth
   - Firebase tạo user với firebase_uid
   - Cloud Function trigger và sync data sang Supabase
   - Record được insert vào public.users

2. **User Authentication:**
   - User đăng nhập qua Firebase
   - Firebase phát hành JWT token
   - Client gửi JWT token trong header khi gọi Supabase API
   - Supabase verify JWT và extract firebase_uid
   - RLS policies kiểm tra quyền truy cập

3. **Data Access:**
   - Client request data từ Supabase với JWT token
   - Supabase verify token với Firebase public keys
   - RLS policies filter data dựa trên firebase_uid
   - Chỉ data của user được trả về



## Correctness Properties

*Property (tính chất đúng đắn) là một đặc điểm hoặc hành vi phải đúng trong tất cả các lần thực thi hợp lệ của hệ thống - về cơ bản, đây là một phát biểu chính thức về những gì hệ thống nên làm. Properties đóng vai trò là cầu nối giữa các đặc tả có thể đọc được bởi con người và các đảm bảo tính đúng đắn có thể xác minh được bằng máy.*

### Property Reflection

Sau khi phân tích prework, tôi nhận thấy hầu hết các tiêu chí là configuration checks và integration tests cụ thể. Đây là một dự án setup/infrastructure, không phải business logic, nên phần lớn testing sẽ là example-based tests thay vì property-based tests.

Các properties có thể kết hợp:
- Các kiểm tra schema (4.1, 4.2, 4.3, 4.6) có thể gộp thành một property về schema integrity
- Các kiểm tra RLS (5.2, 5.3, 5.4, 5.7) có thể gộp thành property về access control
- Các kiểm tra environment variables (8.3, 8.4, 8.5) có thể gộp thành một property về configuration completeness

### Properties

**Property 1: Database Schema Integrity**

*For any* database instance được tạo bởi migration scripts, schema của bảng public.users phải chứa tất cả các columns bắt buộc (firebase_uid, email, display_name, photo_url, created_at, updated_at) với đúng data types và constraints (firebase_uid là VARCHAR(128) PRIMARY KEY, email là VARCHAR(255) UNIQUE NOT NULL), và phải có indexes trên firebase_uid và email.

**Validates: Requirements 4.1, 4.2, 4.3, 4.6**

**Property 2: Row Level Security Access Control**

*For any* user với valid JWT token, khi query bảng public.users, RLS policies phải cho phép user đọc và cập nhật chỉ row có firebase_uid khớp với uid trong JWT token, và phải từ chối truy cập đến rows của users khác, trừ khi sử dụng service role key.

**Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**

**Property 3: Environment Configuration Completeness**

*For any* deployment environment, file .env.example phải chứa tất cả các environment variables bắt buộc (DATABASE_URL, DIRECTUS_KEY, DIRECTUS_SECRET, FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY) với comments giải thích, và các giá trị phải là placeholders chứ không phải giá trị thực.

**Validates: Requirements 8.1, 8.3, 8.4, 8.5, 8.6, 8.7**

**Property 4: Cloud Function Data Extraction**

*For any* Firebase user object được truyền vào Cloud Function, function phải trích xuất chính xác các fields (firebase_uid từ uid, email, display_name từ displayName, photo_url từ photoURL) và map chúng đến đúng columns trong Supabase database.

**Validates: Requirements 6.2**

**Property 5: JWT Token Validation**

*For any* JWT token được gửi đến Supabase API, nếu token có signature không hợp lệ hoặc đã hết hạn, Supabase phải trả về HTTP 401 Unauthorized và từ chối truy cập dữ liệu.

**Validates: Requirements 10.2, 10.4**

### Example-Based Tests

Do đây là infrastructure setup project, phần lớn testing sẽ là example-based integration tests:

**Docker Compose Configuration Tests:**
- Verify Directus service sử dụng image directus/directus:10 hoặc cao hơn
- Verify PostgreSQL service sử dụng image postgres:15 hoặc cao hơn
- Verify networks section định nghĩa directus-network
- Verify volumes được mount cho postgres_data, directus_uploads, directus_extensions
- Verify port 8055 được expose cho Directus
- Verify health check được định nghĩa cho PostgreSQL

**Firebase Integration Tests:**
- Verify JWT token được phát hành có đúng structure và claims
- Verify Cloud Function trigger khi tạo user mới
- Verify Cloud Function ghi data vào Supabase thành công
- Verify Cloud Function hoàn thành trong 5 giây

**Supabase Configuration Tests:**
- Verify bảng public.users tồn tại với đúng schema
- Verify RLS được enable trên public.users
- Verify JWT token hợp lệ cho phép truy cập data
- Verify Supabase API URL và keys được cấu hình đúng

**Directus Configuration Tests:**
- Verify Directus kết nối thành công với PostgreSQL
- Verify admin user được tạo tự động
- Verify REST API accessible tại http://localhost:8055
- Verify GraphQL API được enable
- Verify CORS được cấu hình đúng

**Development Workflow Tests:**
- Verify docker-compose up khởi động tất cả services
- Verify health checks pass cho tất cả services
- Verify seed scripts tồn tại và chạy được
- Verify reset scripts tồn tại và chạy được

## Error Handling

### Docker Compose Errors

**Scenario: PostgreSQL không khởi động**
- **Detection:** Health check fails sau 5 retries
- **Handling:** Docker Compose sẽ không start Directus (depends_on với condition)
- **Recovery:** Kiểm tra logs với `docker-compose logs postgres`, verify environment variables, kiểm tra port conflicts

**Scenario: Directus không kết nối được PostgreSQL**
- **Detection:** Directus container restart liên tục
- **Handling:** Docker restart policy: unless-stopped
- **Recovery:** Verify DB_HOST, DB_PORT, DB_USER, DB_PASSWORD trong environment variables

**Scenario: Port 8055 đã được sử dụng**
- **Detection:** Docker Compose báo lỗi port binding
- **Handling:** Thay đổi port mapping trong docker-compose.yml
- **Recovery:** Sử dụng port khác (ví dụ: 8056:8055)

### Firebase Cloud Function Errors

**Scenario: Supabase insert fails do duplicate email**
- **Detection:** Supabase trả về error code 23505 (unique_violation)
- **Handling:** Function sử dụng upsert thay vì insert để handle duplicates
- **Recovery:** Log error và continue (không block user creation)

**Scenario: Supabase service key không hợp lệ**
- **Detection:** Supabase trả về 401 Unauthorized
- **Handling:** Log error với message rõ ràng
- **Recovery:** Verify SUPABASE_SERVICE_ROLE_KEY trong Firebase config

**Scenario: Function timeout (>60s)**
- **Detection:** Firebase Functions timeout error
- **Handling:** Set timeout limit trong function config
- **Recovery:** Optimize function code, kiểm tra network latency

### JWT Verification Errors

**Scenario: JWT token expired**
- **Detection:** Supabase verify JWT và phát hiện exp claim < current time
- **Handling:** Trả về 401 Unauthorized với message "Token expired"
- **Recovery:** Client refresh token từ Firebase và retry request

**Scenario: JWT signature không hợp lệ**
- **Detection:** Signature verification fails với Firebase public keys
- **Handling:** Trả về 401 Unauthorized với message "Invalid token signature"
- **Recovery:** Client re-authenticate với Firebase

**Scenario: Firebase public keys không fetch được**
- **Detection:** HTTP request đến Firebase keys endpoint fails
- **Handling:** Sử dụng cached keys nếu có, fallback to reject token
- **Recovery:** Retry fetch keys với exponential backoff

### RLS Policy Errors

**Scenario: User cố gắng truy cập data của user khác**
- **Detection:** RLS policy filter out rows không match firebase_uid
- **Handling:** Trả về empty result set (không phải error)
- **Recovery:** Không cần recovery - đây là behavior mong muốn

**Scenario: JWT token không chứa firebase_uid claim**
- **Detection:** auth.uid() returns null trong RLS policy
- **Handling:** RLS policy reject tất cả access
- **Recovery:** Client phải gửi valid JWT token với firebase_uid claim

### Database Migration Errors

**Scenario: Migration script fails do syntax error**
- **Detection:** PostgreSQL trả về syntax error
- **Handling:** Transaction rollback, database giữ nguyên state
- **Recovery:** Fix SQL syntax và re-run migration

**Scenario: Migration script fails do constraint violation**
- **Detection:** PostgreSQL trả về constraint violation error
- **Handling:** Transaction rollback
- **Recovery:** Fix data hoặc adjust constraints và re-run

## Testing Strategy

### Dual Testing Approach

Dự án này sử dụng kết hợp **unit tests** và **property-based tests** để đảm bảo tính đúng đắn toàn diện:

- **Unit tests**: Verify các configuration cụ thể, integration points, và error conditions
- **Property tests**: Verify các universal properties về schema integrity, access control, và data mapping

Cả hai loại tests đều cần thiết và bổ sung cho nhau:
- Unit tests catch các bugs cụ thể trong configuration và integration
- Property tests verify tính đúng đắn tổng quát của system behavior

### Property-Based Testing Configuration

**Testing Library:** 
- Sử dụng **fast-check** cho TypeScript/JavaScript tests
- Sử dụng **Hypothesis** cho Python tests (nếu có)

**Configuration:**
- Mỗi property test phải chạy tối thiểu **100 iterations**
- Mỗi test phải có comment tag reference đến design property
- Tag format: `// Feature: directus-firebase-supabase-setup, Property {number}: {property_text}`

**Example Property Test:**

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
      { numRuns: 100 }
    );
  });
});
```

### Unit Testing Strategy

**Docker Compose Tests:**
```typescript
describe('Docker Compose Configuration', () => {
  it('should define Directus service with version 10+', () => {
    const config = parseDockerCompose('docker-compose.yml');
    expect(config.services.directus.image).toMatch(/directus\/directus:(10|1[1-9])/);
  });

  it('should define PostgreSQL service with version 15+', () => {
    const config = parseDockerCompose('docker-compose.yml');
    expect(config.services.postgres.image).toMatch(/postgres:(15|1[6-9]|[2-9][0-9])/);
  });

  it('should expose Directus on port 8055', () => {
    const config = parseDockerCompose('docker-compose.yml');
    expect(config.services.directus.ports).toContain('8055:8055');
  });
});
```

**Database Schema Tests:**
```typescript
describe('Database Schema', () => {
  it('should have users table with correct columns', async () => {
    const columns = await db.query(`
      SELECT column_name, data_type, character_maximum_length, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'users' AND table_schema = 'public'
    `);
    
    expect(columns).toContainEqual({
      column_name: 'firebase_uid',
      data_type: 'character varying',
      character_maximum_length: 128,
      is_nullable: 'NO'
    });
    
    expect(columns).toContainEqual({
      column_name: 'email',
      data_type: 'character varying',
      character_maximum_length: 255,
      is_nullable: 'NO'
    });
  });

  it('should have primary key on firebase_uid', async () => {
    const constraints = await db.query(`
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_name = 'users' AND constraint_type = 'PRIMARY KEY'
    `);
    
    expect(constraints).toHaveLength(1);
  });
});
```

**RLS Policy Tests:**
```typescript
describe('Row Level Security', () => {
  it('should allow user to read own data', async () => {
    const user1Token = await createTestUser('user1@test.com');
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${user1Token}` } }
    });
    
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('firebase_uid', 'user1-uid');
    
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('should prevent user from reading other user data', async () => {
    const user1Token = await createTestUser('user1@test.com');
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${user1Token}` } }
    });
    
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('firebase_uid', 'user2-uid');
    
    expect(data).toHaveLength(0); // RLS filters out
  });
});
```

**Cloud Function Tests:**
```typescript
describe('Firebase Cloud Function Sync', () => {
  it('should sync user to Supabase on creation', async () => {
    const testUser = {
      uid: 'test-uid-123',
      email: 'test@example.com',
      displayName: 'Test User',
      photoURL: 'https://example.com/photo.jpg'
    };
    
    await syncUserToSupabase(testUser);
    
    const { data } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('firebase_uid', testUser.uid)
      .single();
    
    expect(data.email).toBe(testUser.email);
    expect(data.display_name).toBe(testUser.displayName);
    expect(data.photo_url).toBe(testUser.photoURL);
  });

  it('should complete within 5 seconds', async () => {
    const startTime = Date.now();
    await syncUserToSupabase(createMockUser());
    const duration = Date.now() - startTime;
    
    expect(duration).toBeLessThan(5000);
  });
});
```

### Integration Testing

**End-to-End Authentication Flow:**
```typescript
describe('E2E Authentication Flow', () => {
  it('should complete full auth flow from Firebase to Supabase', async () => {
    // 1. Sign in with Firebase
    const userCredential = await signInWithEmailAndPassword(
      auth,
      'test@example.com',
      'password123'
    );
    
    // 2. Get JWT token
    const token = await userCredential.user.getIdToken();
    
    // 3. Wait for Cloud Function to sync
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 4. Query Supabase with JWT
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('firebase_uid', userCredential.user.uid)
      .single();
    
    // 5. Verify data synced correctly
    expect(error).toBeNull();
    expect(data.email).toBe('test@example.com');
  });
});
```

### Test Environment Setup

**Docker Test Environment:**
```bash
# Start test environment
docker-compose -f docker-compose.test.yml up -d

# Run migrations
docker-compose exec postgres psql -U directus -d directus -f /init-scripts/01-create-schema.sql

# Run tests
npm test

# Cleanup
docker-compose -f docker-compose.test.yml down -v
```

**Firebase Emulator:**
```bash
# Start Firebase emulators
firebase emulators:start --only auth,functions

# Run tests against emulators
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 npm test
```

### Continuous Integration

**GitHub Actions Workflow:**
```yaml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run unit tests
        run: npm test
      
      - name: Run property tests
        run: npm run test:property
      
      - name: Run integration tests
        run: npm run test:integration
```

## Deployment Notes

### Local Development Setup

1. **Clone repository và setup environment:**
```bash
git clone <repository-url>
cd <project-directory>
cp .env.example .env
# Edit .env với giá trị thực
```

2. **Start Docker services:**
```bash
docker-compose up -d
```

3. **Verify services:**
```bash
# Check Directus
curl http://localhost:8055/server/health

# Check PostgreSQL
docker-compose exec postgres psql -U directus -d directus -c "\dt"
```

4. **Setup Firebase:**
```bash
cd functions
npm install
firebase login
firebase use <project-id>
firebase deploy --only functions
```

5. **Configure Supabase:**
- Tạo project trên Supabase Dashboard
- Copy API URL và keys vào .env
- Chạy migration scripts trong SQL Editor
- Configure Firebase auth provider

### Production Considerations

**Security:**
- Sử dụng secrets management (AWS Secrets Manager, Google Secret Manager)
- Enable SSL/TLS cho tất cả connections
- Rotate keys và secrets định kỳ
- Enable audit logging

**Performance:**
- Setup connection pooling cho PostgreSQL
- Enable caching cho Firebase public keys
- Use CDN cho Directus static assets
- Monitor Cloud Function cold starts

**Monitoring:**
- Setup logging aggregation (CloudWatch, Stackdriver)
- Configure alerts cho errors và performance issues
- Monitor database query performance
- Track Cloud Function execution times

**Backup:**
- Automated daily backups cho PostgreSQL
- Point-in-time recovery enabled
- Test restore procedures định kỳ
- Backup retention policy (30 days minimum)
