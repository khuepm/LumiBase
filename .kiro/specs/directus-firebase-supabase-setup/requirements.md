# Tài liệu Yêu cầu: Thiết lập Directus với Firebase và Supabase

## Giới thiệu

Hệ thống này tích hợp ba nền tảng chính để xây dựng một ứng dụng web hiện đại:
- **Firebase Authentication**: Quản lý xác thực người dùng (Google OAuth, Email/Password) và phát hành JWT tokens
- **Supabase (PostgreSQL)**: Cơ sở dữ liệu chính với khả năng Realtime subscriptions
- **Directus CMS**: Hệ thống quản lý nội dung kết nối trực tiếp với Supabase database

Mục tiêu là thiết lập môi trường phát triển local sử dụng Docker trên Windows, đảm bảo các dịch vụ hoạt động đồng bộ và bảo mật.

## Thuật ngữ

- **Directus**: Hệ thống quản lý nội dung (CMS) mã nguồn mở
- **Firebase_Auth**: Dịch vụ xác thực của Firebase
- **Supabase**: Nền tảng Backend-as-a-Service dựa trên PostgreSQL
- **Docker_Compose**: Công cụ định nghĩa và chạy ứng dụng Docker multi-container
- **JWT**: JSON Web Token dùng cho xác thực
- **RLS**: Row Level Security - bảo mật cấp hàng trong PostgreSQL
- **Cloud_Functions**: Dịch vụ serverless functions của Firebase
- **Firebase_UID**: ID duy nhất của người dùng trong Firebase
- **Supabase_JWT_Secret**: Khóa bí mật để xác thực JWT trong Supabase
- **Docker_Network**: Mạng ảo kết nối các container Docker
- **Environment_Variables**: Biến môi trường chứa cấu hình và secrets

## Yêu cầu

### Yêu cầu 1: Thiết lập Docker Environment

**User Story:** Là một developer, tôi muốn chạy Directus và PostgreSQL trong Docker containers, để có môi trường phát triển nhất quán và dễ dàng quản lý.

#### Tiêu chí chấp nhận

1. THE Docker_Compose SHALL định nghĩa service cho Directus phiên bản 10 trở lên
2. THE Docker_Compose SHALL định nghĩa service cho PostgreSQL phiên bản 15 trở lên
3. THE Docker_Compose SHALL tạo Docker_Network để kết nối các containers
4. THE Docker_Compose SHALL mount volumes cho PostgreSQL data persistence
5. THE Docker_Compose SHALL mount volumes cho Directus uploads và extensions
6. WHEN Docker_Compose khởi động, THE Directus SHALL kết nối thành công với PostgreSQL
7. THE Docker_Compose SHALL expose Directus port 8055 ra host machine
8. THE Docker_Compose SHALL load environment variables từ file .env

### Yêu cầu 2: Cấu hình Firebase Project

**User Story:** Là một developer, tôi muốn thiết lập Firebase project với Authentication và Cloud Functions, để quản lý người dùng và đồng bộ dữ liệu.

#### Tiêu chí chấp nhận

1. THE Firebase_Auth SHALL hỗ trợ Google OAuth provider
2. THE Firebase_Auth SHALL hỗ trợ Email/Password authentication
3. THE Firebase_Auth SHALL phát hành JWT tokens với custom claims
4. THE Cloud_Functions SHALL trigger khi người dùng mới được tạo trong Firebase
5. WHEN người dùng đăng ký, THE Cloud_Functions SHALL ghi thông tin vào Supabase database
6. THE Firebase_Project SHALL có Analytics được kích hoạt
7. THE Firebase_Project SHALL cung cấp service account credentials cho server-side operations

### Yêu cầu 3: Cấu hình Supabase Project

**User Story:** Là một developer, tôi muốn cấu hình Supabase để chấp nhận Firebase JWT tokens, để người dùng có thể xác thực với cả hai hệ thống.

#### Tiêu chí chấp nhận

1. THE Supabase SHALL có bảng public.users với firebase_uid làm primary key
2. THE Supabase SHALL cấu hình Firebase làm third-party auth provider
3. THE Supabase SHALL xác thực JWT tokens được phát hành bởi Firebase
4. THE Supabase SHALL có Supabase_JWT_Secret được cấu hình trong Directus
5. WHEN JWT token hợp lệ được gửi đến, THE Supabase SHALL cho phép truy cập dữ liệu
6. THE Supabase SHALL có Realtime subscriptions được kích hoạt
7. THE Supabase SHALL có API URL và anon key được cấu hình trong client applications

### Yêu cầu 4: Database Schema và Migrations

**User Story:** Là một developer, tôi muốn có database schema được định nghĩa rõ ràng, để đảm bảo tính nhất quán của dữ liệu.

#### Tiêu chí chấp nhận

1. THE Database SHALL có bảng public.users với các cột: firebase_uid, email, display_name, photo_url, created_at, updated_at
2. THE public.users.firebase_uid SHALL là VARCHAR(128) và là primary key
3. THE public.users.email SHALL là VARCHAR(255) và là UNIQUE NOT NULL
4. THE Database SHALL có migration scripts để tạo schema
5. WHEN Directus khởi động lần đầu, THE Database SHALL tự động chạy migrations
6. THE Database SHALL có indexes trên firebase_uid và email columns
7. THE Database SHALL có timestamps tự động cập nhật cho created_at và updated_at

### Yêu cầu 5: Row Level Security (RLS)

**User Story:** Là một system architect, tôi muốn thiết lập RLS policies, để đảm bảo người dùng chỉ truy cập được dữ liệu của họ.

#### Tiêu chí chấp nhận

1. THE public.users SHALL có RLS được kích hoạt
2. THE RLS_Policy SHALL cho phép người dùng đọc row của chính họ
3. THE RLS_Policy SHALL cho phép người dùng cập nhật row của chính họ
4. THE RLS_Policy SHALL ngăn người dùng xóa row của người khác
5. WHEN JWT token chứa firebase_uid, THE RLS SHALL sử dụng nó để xác định quyền truy cập
6. THE RLS_Policy SHALL cho phép service role bypass tất cả restrictions
7. IF người dùng không có JWT token hợp lệ, THEN THE Database SHALL từ chối truy cập

### Yêu cầu 6: Firebase Cloud Function Sync

**User Story:** Là một developer, tôi muốn tự động đồng bộ người dùng từ Firebase sang Supabase, để dữ liệu luôn nhất quán giữa hai hệ thống.

#### Tiêu chí chấp nhận

1. WHEN người dùng mới được tạo trong Firebase_Auth, THE Cloud_Functions SHALL trigger onCreate event
2. THE Cloud_Functions SHALL trích xuất firebase_uid, email, displayName, photoURL từ Firebase user object
3. THE Cloud_Functions SHALL insert hoặc update record trong public.users table
4. THE Cloud_Functions SHALL sử dụng Supabase service role key để bypass RLS
5. IF insert thất bại do duplicate email, THEN THE Cloud_Functions SHALL log error và retry
6. THE Cloud_Functions SHALL hoàn thành trong vòng 5 giây
7. THE Cloud_Functions SHALL có error handling và logging đầy đủ

### Yêu cầu 7: Directus Configuration

**User Story:** Là một content manager, tôi muốn sử dụng Directus để quản lý nội dung, với kết nối an toàn đến Supabase database.

#### Tiêu chí chấp nhận

1. THE Directus SHALL kết nối đến PostgreSQL sử dụng Environment_Variables
2. THE Directus SHALL có admin user được tạo tự động khi khởi động lần đầu
3. THE Directus SHALL expose REST API tại http://localhost:8055
4. THE Directus SHALL có GraphQL API được kích hoạt
5. THE Directus SHALL có CORS được cấu hình cho local development
6. THE Directus SHALL có public folder cho file uploads
7. THE Directus SHALL có extensions folder cho custom extensions

### Yêu cầu 8: Environment Variables Management

**User Story:** Là một developer, tôi muốn quản lý secrets và configuration một cách an toàn, để tránh lộ thông tin nhạy cảm.

#### Tiêu chí chấp nhận

1. THE Project SHALL có file .env.example với tất cả required variables
2. THE .env file SHALL được thêm vào .gitignore
3. THE Environment_Variables SHALL bao gồm: DATABASE_URL, DIRECTUS_KEY, DIRECTUS_SECRET
4. THE Environment_Variables SHALL bao gồm: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL
5. THE Environment_Variables SHALL bao gồm: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
6. THE Environment_Variables SHALL có comments giải thích từng variable
7. THE Environment_Variables SHALL không chứa giá trị thực trong version control

### Yêu cầu 9: Local Development Workflow

**User Story:** Là một developer, tôi muốn có quy trình phát triển local đơn giản, để có thể bắt đầu làm việc nhanh chóng.

#### Tiêu chí chấp nhận

1. THE Project SHALL có README.md với hướng dẫn setup từng bước
2. WHEN developer chạy `docker-compose up`, THE System SHALL khởi động tất cả services
3. THE System SHALL có health checks cho mỗi service
4. THE System SHALL có scripts để seed initial data
5. THE System SHALL có scripts để reset database về trạng thái ban đầu
6. THE Documentation SHALL bao gồm cách test authentication flow locally
7. THE Documentation SHALL bao gồm cách debug Cloud Functions locally

### Yêu cầu 10: JWT Token Verification

**User Story:** Là một system architect, tôi muốn đảm bảo JWT tokens được xác thực đúng cách, để bảo vệ dữ liệu khỏi truy cập trái phép.

#### Tiêu chí chấp nhận

1. THE Supabase SHALL xác thực JWT signature sử dụng Firebase public keys
2. THE Supabase SHALL kiểm tra JWT expiration time
3. THE Supabase SHALL trích xuất firebase_uid từ JWT claims
4. IF JWT token không hợp lệ, THEN THE Supabase SHALL trả về 401 Unauthorized
5. THE System SHALL có endpoint để test JWT verification
6. THE System SHALL cache Firebase public keys với TTL 24 giờ
7. THE System SHALL tự động refresh public keys khi hết hạn

### Yêu cầu 11: Version Control và Git Workflow

**User Story:** Là một developer, tôi muốn tất cả thay đổi được commit và push lên Git repository sau mỗi task hoàn thành, để có lịch sử thay đổi rõ ràng và backup code liên tục.

#### Tiêu chí chấp nhận

1. WHEN một task hoàn thành, THE System SHALL commit tất cả thay đổi với descriptive message
2. THE Commit_Message SHALL bao gồm task number và mô tả ngắn gọn
3. THE System SHALL push commits lên remote repository sau mỗi task
4. THE System SHALL verify Git repository đã được initialized trước khi commit
5. THE System SHALL verify remote repository đã được configured
6. IF commit hoặc push fails, THEN THE System SHALL báo lỗi và hỏi user cách xử lý
7. THE Commit_Message SHALL follow format: "feat(task-X): [description]" hoặc "chore(task-X): [description]"
