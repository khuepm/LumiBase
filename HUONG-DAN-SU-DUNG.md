# 📖 HƯỚNG DẪN SỬ DỤNG LUMIBASE

> **Hướng dẫn toàn diện để thiết lập và sử dụng LumiBase - Nền tảng khởi động cho ứng dụng hiện đại**

## 📑 Mục Lục

1. [Giới Thiệu](#giới-thiệu)
2. [Yêu Cầu Hệ Thống](#yêu-cầu-hệ-thống)
3. [Cài Đặt Ban Đầu](#cài-đặt-ban-đầu)
4. [Cấu Hình Firebase](#cấu-hình-firebase)
5. [Cấu Hình Supabase](#cấu-hình-supabase)
6. [Cấu Hình Directus](#cấu-hình-directus)
7. [Khởi Động Dự Án](#khởi-động-dự-án)
8. [Kiểm Tra Hệ Thống](#kiểm-tra-hệ-thống)
9. [Phát Triển Ứng Dụng](#phát-triển-ứng-dụng)
10. [Triển Khai Production](#triển-khai-production)
11. [Xử Lý Sự Cố](#xử-lý-sự-cố)

---

## 🎯 Giới Thiệu

### LumiBase là gì?

LumiBase là một nền tảng kỹ thuật hoàn chỉnh kết hợp:
- **Firebase** (Xác thực người dùng & Analytics)
- **Supabase** (Cơ sở dữ liệu PostgreSQL)
- **Directus** (Quản trị nội dung CMS)

### Lợi ích chính

- ⚡ **Tốc độ**: Tiết kiệm hàng tuần thiết lập Auth, Database, CMS
- 🔒 **Bảo mật**: Row Level Security (RLS) và JWT token validation
- 📈 **Mở rộng**: Từ MVP nhỏ đến hệ thống triệu người dùng
- 🎨 **Linh hoạt**: Dễ dàng tùy chỉnh theo nhu cầu dự án

### Kiến trúc hệ thống

```
Người dùng → Firebase Auth → JWT Token → Supabase Database
                ↓                              ↓
         Cloud Functions              Directus CMS
                ↓                              ↓
         Đồng bộ dữ liệu ← ← ← ← ← ← ← ← ← ← ←
```

---

## 💻 Yêu Cầu Hệ Thống

### Phần mềm cần thiết


| Phần mềm | Phiên bản | Tải về |
|----------|-----------|--------|
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) |
| Docker Desktop | Mới nhất | [docker.com](https://www.docker.com/products/docker-desktop/) |
| Git | Mới nhất | [git-scm.com](https://git-scm.com/) |

### Tài khoản cần tạo

- ✅ **Firebase Account** - [firebase.google.com](https://firebase.google.com/)
- ✅ **Supabase Account** - [supabase.com](https://supabase.com/)

### Kiến thức khuyến nghị

- Hiểu biết cơ bản về JavaScript/TypeScript
- Quen thuộc với dòng lệnh (Command Line)
- Kinh nghiệm với Git (cơ bản)

---

## 🚀 Cài Đặt Ban Đầu

### Bước 1: Clone dự án

```bash
# Clone repository
git clone https://github.com/khuepm/LumiBase.git
cd LumiBase

# Cài đặt dependencies
npm install
```

### Bước 2: Tạo file cấu hình

```bash
# Sao chép file mẫu
cp .env.example .env
cp .env.test.example .env.test
```

### Bước 3: Cài đặt công cụ

```bash
# Cài đặt Firebase CLI
npm install -g firebase-tools

# Đăng nhập Firebase
firebase login

# Cài đặt dependencies cho Cloud Functions
cd functions
npm install
cd ..

# Cài đặt dependencies cho Client
cd client
npm install
cd ..
```

---

## 🔥 Cấu Hình Firebase

### Bước 1: Tạo Firebase Project

1. Truy cập [Firebase Console](https://console.firebase.google.com/)
2. Click **"Add project"** (Thêm dự án)
3. Nhập tên dự án (ví dụ: "LumiBase-Demo")
4. (Tùy chọn) Bật Google Analytics
5. Click **"Create project"** và đợi hoàn tất

### Bước 2: Bật Google OAuth

1. Vào **Authentication** → **Sign-in method**
2. Click vào **Google** provider
3. Bật **Enable**
4. Cấu hình:
   - **Support email**: Chọn email của bạn
   - **Project name**: Nhập tên hiển thị
5. Click **Save**

### Bước 3: Bật Email/Password Authentication

1. Vào **Authentication** → **Sign-in method**
2. Click vào **Email/Password**
3. Bật **Enable**
4. Click **Save**

### Bước 4: Lấy Service Account Key

1. Vào **Project Settings** (biểu tượng bánh răng) → **Service Accounts**
2. Click **"Generate New Private Key"**
3. Click **"Generate Key"** - file JSON sẽ được tải về

⚠️ **Cảnh báo bảo mật**: KHÔNG BAO GIỜ commit file này lên Git!

4. Mở file JSON và copy các giá trị vào `.env`:

```bash
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### Bước 5: Lấy Web API Key

1. Vào **Project Settings** → **General**
2. Cuộn xuống **"Your apps"**
3. Nếu chưa có web app:
   - Click biểu tượng **</>** (Web)
   - Đăng ký app với nickname (ví dụ: "LumiBase Web")
   - Click **"Register app"**
4. Copy **Web API Key** và thêm vào `.env`:

```bash
FIREBASE_WEB_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

### Bước 6: Cấu hình Firebase Project

```bash
# Chọn project
firebase use <your-project-id>
```

**Lưu ý**: Cấu hình Supabase cho Cloud Functions sẽ được thực hiện sau khi có Supabase (xem Bước 7).

📖 **Hướng dẫn chi tiết**: Xem [docs/firebase-authentication-guide.md](docs/firebase-authentication-guide.md)

---

## 🗄️ Cấu Hình Supabase

### Bước 1: Tạo Supabase Project

1. Truy cập [Supabase Dashboard](https://app.supabase.com/)
2. Click **"New project"**
3. Nhập thông tin:
   - **Name**: Tên dự án (ví dụ: "LumiBase")
   - **Database Password**: Mật khẩu mạnh (lưu lại!)
   - **Region**: Chọn gần người dùng nhất
4. Click **"Create new project"** và đợi ~2 phút

### Bước 2: Lấy API Keys

1. Vào **Settings** → **API**
2. Copy các giá trị sau vào `.env`:

```bash
SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_JWT_SECRET=your-super-secret-jwt-token-with-at-least-32-characters-long
```

⚠️ **Cảnh báo**: `SUPABASE_SERVICE_ROLE_KEY` có quyền admin - KHÔNG BAO GIỜ dùng ở client!

### Bước 3: Cấu hình Firebase Authentication

1. Vào **Authentication** → **Providers**
2. Tìm **Firebase** trong danh sách
3. Click **Enable**
4. Nhập thông tin:
   - **Project ID**: Firebase Project ID của bạn
   - **Issuer URL**: `https://securetoken.google.com/your-firebase-project-id`
5. Click **Save**

### Bước 4: Cấu hình Firebase Cloud Functions với Supabase

Sau khi có Supabase URL và Service Role Key, cấu hình cho Firebase Functions:

#### Phương pháp 1: Sử dụng .env file (Khuyến nghị)

1. Tạo file `.env` trong thư mục `functions/`:

```bash
cd functions
```

2. Tạo file `.env` với nội dung:

```bash
SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

3. Cập nhật `functions/.gitignore` để không commit file này:

```bash
# Đã có sẵn trong .gitignore
.env
.env.*
```

#### Phương pháp 2: Sử dụng Firebase Secrets (Production)

```bash
# Set secrets cho production
firebase functions:secrets:set SUPABASE_URL
# Nhập URL khi được hỏi: https://xxxxx.supabase.co

firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
# Nhập service role key khi được hỏi
```

#### Phương pháp 3: Legacy Config (Deprecated - Không khuyến nghị)

⚠️ **Cảnh báo**: Phương pháp này sẽ ngừng hoạt động vào tháng 3/2026.

```bash
# Chỉ dùng nếu cần thiết
firebase experiments:enable legacyRuntimeConfigCommands
firebase functions:config:set supabase.url="https://xxxxx.supabase.co"
firebase functions:config:set supabase.service_key="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Khuyến nghị**: Sử dụng Phương pháp 1 cho development và Phương pháp 2 cho production.

### Bước 5: Tạo Database Schema

Schema sẽ được tạo tự động khi khởi động Docker (xem bước tiếp theo).

📖 **Hướng dẫn chi tiết**: Xem [docs/supabase-project-setup-guide.md](docs/supabase-project-setup-guide.md)

---

## 💎 Cấu Hình Directus

### Bước 1: Tạo Secret Keys

```bash
# Tạo random key cho Directus
openssl rand -base64 32
```

Chạy lệnh này 2 lần để có 2 keys khác nhau.

### Bước 2: Cập nhật file .env

```bash
# Directus Configuration
DIRECTUS_KEY=<key-thứ-nhất-từ-lệnh-trên>
DIRECTUS_SECRET=<key-thứ-hai-từ-lệnh-trên>
DIRECTUS_ADMIN_EMAIL=admin@example.com
DIRECTUS_ADMIN_PASSWORD=<mật-khẩu-mạnh-của-bạn>

# Database Configuration
DB_USER=directus
DB_PASSWORD=<mật-khẩu-database-mạnh>
DB_NAME=directus
```

⚠️ **Lưu ý**: Sử dụng mật khẩu mạnh (tối thiểu 16 ký tự, có chữ hoa, chữ thường, số, ký tự đặc biệt)

---

## 🎬 Khởi Động Dự Án

### Bước 1: Khởi động Docker Services

```bash
# Khởi động PostgreSQL và Directus
docker-compose up -d

# Kiểm tra trạng thái
docker-compose ps

# Xem logs (nếu cần)
docker-compose logs -f
```

Kết quả mong đợi:
```
NAME                 STATUS
directus-cms         Up
directus-postgres    Up
```

### Bước 2: Kiểm tra Directus

1. Mở trình duyệt: [http://localhost:8055](http://localhost:8055)
2. Đăng nhập với:
   - **Email**: Giá trị `DIRECTUS_ADMIN_EMAIL` trong `.env`
   - **Password**: Giá trị `DIRECTUS_ADMIN_PASSWORD` trong `.env`
3. Bạn sẽ thấy giao diện quản trị Directus

### Bước 3: Kiểm tra Database

```bash
# Kết nối vào PostgreSQL
docker-compose exec postgres psql -U directus -d directus

# Xem các bảng
\dt

# Xem bảng users
\d public.users

# Thoát
\q
```

### Bước 4: Deploy Firebase Cloud Functions

```bash
# Di chuyển vào thư mục functions
cd functions

# Build code
npm run build

# Deploy lên Firebase
npm run deploy

# Quay lại thư mục gốc
cd ..
```

Kết quả mong đợi:
```
✔ functions[syncUserToSupabase(us-central1)] Successful create operation.
✔ functions[deleteUserFromSupabase(us-central1)] Successful create operation.
```

---

## ✅ Kiểm Tra Hệ Thống

### Kiểm tra tự động

**Trên Linux/Mac:**
```bash
chmod +x scripts/verify-database-setup.sh
./scripts/verify-database-setup.sh
```

**Trên Windows PowerShell:**
```powershell
.\scripts\verify-database-setup.ps1
```

### Kiểm tra thủ công

#### 1. Kiểm tra Docker

```bash
# Kiểm tra containers đang chạy
docker-compose ps

# Kiểm tra PostgreSQL
docker-compose exec postgres pg_isready -U directus

# Kiểm tra Directus health
curl http://localhost:8055/server/health
```

#### 2. Kiểm tra Database Schema

```bash
docker-compose exec postgres psql -U directus -d directus -c "\d public.users"
```

Kết quả mong đợi: Bảng `users` với các cột:
- `firebase_uid` (PRIMARY KEY)
- `email` (UNIQUE)
- `display_name`
- `photo_url`
- `created_at`
- `updated_at`

#### 3. Kiểm tra RLS Policies

```bash
docker-compose exec postgres psql -U directus -d directus -c "SELECT policyname FROM pg_policies WHERE tablename = 'users';"
```

Kết quả mong đợi: 4 policies
- `Users can read own data`
- `Users can update own data`
- `Service role has full access`
- `Allow insert for authenticated users`

#### 4. Kiểm tra Firebase Functions

```bash
# Xem danh sách functions
firebase functions:list

# Xem logs
firebase functions:log
```

#### 5. Test Authentication Flow

```bash
# Mở file example
cd client
open example.html  # Mac
start example.html # Windows
xdg-open example.html # Linux
```

Thử đăng nhập bằng Google hoặc Email/Password, sau đó kiểm tra database:

```bash
docker-compose exec postgres psql -U directus -d directus -c "SELECT * FROM public.users;"
```

Bạn sẽ thấy user vừa đăng ký xuất hiện trong database!

📖 **Hướng dẫn chi tiết**: 
- [docs/docker-verification-guide.md](docs/docker-verification-guide.md)
- [docs/TASK-6-DATABASE-VERIFICATION.md](docs/TASK-6-DATABASE-VERIFICATION.md)

---

## 🛠️ Phát Triển Ứng Dụng

### Cấu trúc dự án

```
LumiBase/
├── client/              # Code client-side
│   ├── auth.ts         # Firebase & Supabase integration
│   └── example.html    # Ví dụ sử dụng
├── functions/          # Firebase Cloud Functions
│   └── src/index.ts    # User sync logic
├── init-scripts/       # Database migrations
│   ├── 01-create-schema.sql
│   └── 02-setup-rls.sql
├── scripts/            # Development scripts
└── tests/              # Test suites
```

### Tích hợp vào ứng dụng của bạn

#### 1. Cài đặt dependencies

```bash
npm install firebase @supabase/supabase-js
```

#### 2. Khởi tạo Firebase và Supabase

```typescript
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { createClient } from '@supabase/supabase-js';

// Firebase config
const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_WEB_API_KEY",
  authDomain: "your-project-id.firebaseapp.com",
  projectId: "your-project-id",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// Supabase config
const supabase = createClient(
  'YOUR_SUPABASE_URL',
  'YOUR_SUPABASE_ANON_KEY'
);
```

#### 3. Đăng nhập với Google

```typescript
import { signInWithPopup } from 'firebase/auth';

async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;
    const token = await user.getIdToken();
    
    console.log('Đăng nhập thành công!', user);
    return { user, token };
  } catch (error) {
    console.error('Lỗi đăng nhập:', error);
    throw error;
  }
}
```

#### 4. Lấy dữ liệu từ Supabase

```typescript
async function getUserData(firebaseUid: string, token: string) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('firebase_uid', firebaseUid)
    .single();
    
  if (error) {
    console.error('Lỗi lấy dữ liệu:', error);
    throw error;
  }
  
  return data;
}
```

#### 5. Cập nhật profile

```typescript
async function updateProfile(firebaseUid: string, updates: any) {
  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('firebase_uid', firebaseUid)
    .select()
    .single();
    
  if (error) {
    console.error('Lỗi cập nhật:', error);
    throw error;
  }
  
  return data;
}
```

📖 **Ví dụ đầy đủ**: Xem [client/auth.ts](client/auth.ts) và [client/example.html](client/example.html)

### Quản lý nội dung với Directus

#### Truy cập Directus CMS

1. Mở [http://localhost:8055](http://localhost:8055)
2. Đăng nhập với admin credentials
3. Xem và chỉnh sửa dữ liệu trong bảng `users`

#### Sử dụng Directus REST API

```typescript
// Lấy tất cả users
fetch('http://localhost:8055/items/users', {
  headers: {
    'Authorization': 'Bearer YOUR_DIRECTUS_TOKEN'
  }
})

// Tạo user mới
fetch('http://localhost:8055/items/users', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_DIRECTUS_TOKEN',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    firebase_uid: 'abc123',
    email: 'user@example.com',
    display_name: 'John Doe'
  })
})
```

### Development Scripts

```bash
# Seed dữ liệu mẫu
npm run seed

# Reset database
npm run reset-db

# Chạy tests
npm test

# Xem logs
docker-compose logs -f
```

---

## 🧪 Testing

### Chạy tests

```bash
# Tất cả tests
npm test

# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# Property-based tests
npm run test:property

# Test với coverage
npm run test:coverage
```

### Test environment

```bash
# Khởi động test environment
npm run test:env:up

# Chạy tests
npm test

# Dừng test environment
npm run test:env:down
```

📖 **Hướng dẫn chi tiết**: 
- [docs/TESTING-PROCEDURES.md](docs/TESTING-PROCEDURES.md)
- [docs/TEST-ENVIRONMENT-GUIDE.md](docs/TEST-ENVIRONMENT-GUIDE.md)

---

## 🚀 Triển Khai Production

### Checklist trước khi deploy

- [ ] Đã test đầy đủ trên môi trường development
- [ ] Đã cấu hình production environment variables
- [ ] Đã tạo Firebase project riêng cho production
- [ ] Đã tạo Supabase project riêng cho production
- [ ] Đã cấu hình SSL/TLS certificates
- [ ] Đã thiết lập monitoring và logging
- [ ] Đã cấu hình backup tự động
- [ ] Đã review security checklist

### Deploy Firebase Functions

```bash
cd functions

# Chọn production project
firebase use production

# Deploy
firebase deploy --only functions

cd ..
```

### Deploy Directus

Directus có thể deploy lên:
- **Railway.app** (Khuyến nghị - dễ nhất)
- **Render.com**
- **AWS/GCP/Azure**
- **VPS riêng**

### Cấu hình Production Environment

Tạo file `.env.production`:

```bash
# Firebase Production
FIREBASE_PROJECT_ID=your-prod-project-id
FIREBASE_WEB_API_KEY=your-prod-api-key
# ... các biến khác

# Supabase Production
SUPABASE_URL=https://your-prod-project.supabase.co
SUPABASE_ANON_KEY=your-prod-anon-key
# ... các biến khác

# Directus Production
DIRECTUS_URL=https://your-directus-domain.com
# ... các biến khác
```

### Security Best Practices

1. ✅ Sử dụng HTTPS cho tất cả endpoints
2. ✅ Rotate keys định kỳ (mỗi 90 ngày)
3. ✅ Bật 2FA cho tất cả admin accounts
4. ✅ Giới hạn CORS origins
5. ✅ Thiết lập rate limiting
6. ✅ Monitor logs cho suspicious activities
7. ✅ Backup database hàng ngày
8. ✅ Sử dụng environment variables cho secrets

📖 **Hướng dẫn chi tiết**: 
- [docs/DEPLOYMENT-PROCEDURES.md](docs/DEPLOYMENT-PROCEDURES.md)
- [docs/CI-CD-SETUP-GUIDE.md](docs/CI-CD-SETUP-GUIDE.md)

---

## 🔧 Xử Lý Sự Cố

### Docker không khởi động được

**Triệu chứng**: `docker-compose up -d` báo lỗi

**Giải pháp**:
```bash
# Kiểm tra Docker đang chạy
docker --version

# Xóa containers cũ
docker-compose down -v

# Khởi động lại
docker-compose up -d

# Xem logs chi tiết
docker-compose logs
```

### Directus không truy cập được

**Triệu chứng**: Không mở được http://localhost:8055

**Giải pháp**:
```bash
# Kiểm tra container status
docker-compose ps

# Xem logs Directus
docker-compose logs directus

# Restart Directus
docker-compose restart directus
```

### Database connection failed

**Triệu chứng**: Directus báo lỗi kết nối database

**Giải pháp**:
```bash
# Kiểm tra PostgreSQL
docker-compose exec postgres pg_isready -U directus

# Kiểm tra credentials trong .env
cat .env | grep DB_

# Restart cả 2 services
docker-compose restart postgres directus
```

### Firebase Functions không deploy được

**Triệu chứng**: `firebase deploy` báo lỗi

**Giải pháp**:
```bash
# Kiểm tra đã login
firebase login

# Kiểm tra project
firebase projects:list
firebase use <your-project-id>

# Kiểm tra billing (Functions cần Blaze plan)
# Vào Firebase Console → Upgrade to Blaze plan

# Kiểm tra cấu hình
cd functions
cat .env  # Kiểm tra environment variables

# Build lại
npm run build
npm run deploy
```

**Lỗi "functions.config() is deprecated":**

Firebase đã ngừng hỗ trợ `functions:config` API. Sử dụng environment variables thay thế:

```bash
# Tạo file .env trong thư mục functions
cd functions
echo "SUPABASE_URL=https://xxxxx.supabase.co" > .env
echo "SUPABASE_SERVICE_ROLE_KEY=your-key" >> .env

# Deploy lại
npm run deploy
```

📖 **Chi tiết**: Xem [Firebase Config Migration Guide](docs/FIREBASE-CONFIG-MIGRATION.md)

### User không được sync vào Supabase

**Triệu chứng**: Đăng ký Firebase thành công nhưng không thấy trong Supabase

**Giải pháp**:
```bash
# Kiểm tra Firebase Functions logs
firebase functions:log

# Kiểm tra environment variables
cd functions
cat .env

# Nếu dùng secrets, kiểm tra:
firebase functions:secrets:list

# Set lại config nếu cần (environment variables)
cd functions
nano .env  # Hoặc notepad .env trên Windows

# Hoặc dùng secrets (production)
firebase functions:secrets:set SUPABASE_URL
firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY

# Deploy lại functions
npm run deploy
```

📖 **Chi tiết**: Xem [Firebase Config Migration Guide](docs/FIREBASE-CONFIG-MIGRATION.md)

### RLS policies chặn truy cập

**Triệu chứng**: API trả về 403 Forbidden

**Giải pháp**:
```bash
# Kiểm tra RLS policies
docker-compose exec postgres psql -U directus -d directus

# Trong psql:
SELECT * FROM pg_policies WHERE tablename = 'users';

# Kiểm tra JWT token có đúng firebase_uid không
# Token phải có claim: { sub: "firebase_uid" }
```

### Port đã được sử dụng

**Triệu chứng**: `Error: Port 8055 is already in use`

**Giải pháp**:
```bash
# Tìm process đang dùng port
# Windows:
netstat -ano | findstr :8055

# Mac/Linux:
lsof -i :8055

# Kill process hoặc đổi port trong docker-compose.yml
```

### Các lỗi thường gặp khác

| Lỗi | Nguyên nhân | Giải pháp |
|-----|-------------|-----------|
| `ECONNREFUSED` | Service chưa khởi động | Đợi thêm vài giây, kiểm tra `docker-compose ps` |
| `Invalid JWT` | Token hết hạn hoặc sai | Đăng nhập lại để lấy token mới |
| `Permission denied` | RLS policy chặn | Kiểm tra `firebase_uid` trong token và database |
| `Module not found` | Thiếu dependencies | Chạy `npm install` |
| `Build failed` | Lỗi TypeScript | Kiểm tra `npm run build` output |

📖 **Troubleshooting chi tiết**: Xem [docs/DEPLOYMENT-PROCEDURES.md](docs/DEPLOYMENT-PROCEDURES.md#troubleshooting)

---

## 📚 Tài Liệu Tham Khảo

### Tài liệu dự án

- [README.md](README.md) - Tổng quan dự án (English)
- [project_specs.md](project_specs.md) - Đặc tả kỹ thuật
- [docs/firebase-authentication-guide.md](docs/firebase-authentication-guide.md) - Hướng dẫn Firebase
- [docs/FIREBASE-CONFIG-MIGRATION.md](docs/FIREBASE-CONFIG-MIGRATION.md) - Migration từ functions:config sang environment variables
- [docs/supabase-project-setup-guide.md](docs/supabase-project-setup-guide.md) - Hướng dẫn Supabase
- [docs/TESTING-PROCEDURES.md](docs/TESTING-PROCEDURES.md) - Hướng dẫn testing
- [docs/DEPLOYMENT-PROCEDURES.md](docs/DEPLOYMENT-PROCEDURES.md) - Hướng dẫn deployment

### Tài liệu bên ngoài

- [Firebase Documentation](https://firebase.google.com/docs)
- [Supabase Documentation](https://supabase.com/docs)
- [Directus Documentation](https://docs.directus.io/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Docker Documentation](https://docs.docker.com/)

### Video tutorials (Khuyến nghị)

- Firebase Authentication: [YouTube](https://www.youtube.com/results?search_query=firebase+authentication+tutorial)
- Supabase Getting Started: [YouTube](https://www.youtube.com/results?search_query=supabase+tutorial)
- Directus CMS: [YouTube](https://www.youtube.com/results?search_query=directus+cms+tutorial)

---

## 💬 Hỗ Trợ

### Cần giúp đỡ?

1. **Kiểm tra tài liệu** - Hầu hết câu hỏi đã được trả lời trong docs
2. **Xem Issues** - Tìm kiếm trong GitHub Issues
3. **Tạo Issue mới** - Nếu không tìm thấy giải pháp
4. **Community** - Tham gia Discord/Slack của Firebase, Supabase, Directus

### Báo lỗi

Khi báo lỗi, vui lòng cung cấp:
- Mô tả chi tiết vấn đề
- Các bước để tái hiện lỗi
- Logs/Screenshots
- Môi trường (OS, Node version, Docker version)
- File `.env` (đã xóa sensitive data)

---

## 🎉 Kết Luận

Chúc mừng! Bạn đã hoàn thành việc thiết lập LumiBase. Giờ đây bạn có:

- ✅ Hệ thống xác thực hoàn chỉnh với Firebase
- ✅ Database PostgreSQL mạnh mẽ với Supabase
- ✅ CMS quản trị nội dung với Directus
- ✅ Tự động đồng bộ dữ liệu
- ✅ Bảo mật với RLS và JWT
- ✅ Sẵn sàng cho production

### Bước tiếp theo

1. Tùy chỉnh database schema theo nhu cầu dự án
2. Xây dựng UI/UX cho ứng dụng
3. Thêm các tính năng business logic
4. Deploy lên production
5. Monitor và tối ưu hóa

**Happy coding! 🚀**

---

**Phiên bản**: 1.0.0  
**Cập nhật lần cuối**: 2026-02-09  
**Tác giả**: LumiBase Team
