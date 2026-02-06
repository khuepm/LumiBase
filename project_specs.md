# 📑 BẢN MÔ TẢ KỸ THUẬT (PROJECT SPECS)

## 1. Kiến trúc hệ thống (System Architecture)

- **Identity Provider**: Firebase Auth
  - Quản lý User, Login qua Google/Email.
  - Cấp JWT.
- **Primary Database**: Supabase (PostgreSQL)
  - Lưu trữ dữ liệu ứng dụng.
  - Xử lý Realtime.
- **Content Management (CMS)**: Directus
  - Kết nối trực tiếp vào DB của Supabase.
  - Quản trị nội dung.
- **Data Analytics**: Firebase Analytics
  - Theo dõi hành vi người dùng trên App.
- **Glue Logic**: Firebase Cloud Functions
  - Đồng bộ User ID từ Firebase sang bảng `users` trong Supabase khi có đăng ký mới.

## 2. Luồng dữ liệu (Data Flow)

- **Auth Flow**:
  - App $\rightarrow$ Firebase Auth (Login) $\rightarrow$ Nhận Firebase ID Token (JWT).
- **Access Flow**:
  - App $\rightarrow$ Gửi JWT kèm Request $\rightarrow$ Supabase (Verify JWT qua Firebase Secret) $\rightarrow$ Trả dữ liệu dựa trên RLS (Row Level Security).
- **Admin Flow**:
  - Admin $\rightarrow$ Giao diện Directus CMS $\rightarrow$ Thao tác trực tiếp trên DB Supabase.

## 3. Thông số cấu hình chi tiết

| Thành phần | Yêu cầu kỹ thuật |
| :--- | :--- |
| **Firebase** | Bật Authentication (Google/Email), Bật Analytics. Cấu hình JWT Custom Claims (nếu cần). |
| **Supabase** | PostgreSQL 15+, Bật "Third-party Auth" cho Firebase. Thiết lập RLS cho mọi bảng. |
| **Directus** | Phiên bản v10+. Chạy Docker (Node 18+). Kết nối qua Postgre Standard Connection. |
| **Xác thực** | Sử dụng mã bí mật JWT từ Firebase Project để Supabase giải mã token. |

## 🛠 DANH SÁCH CHUẨN BỊ (PREPARATION CHECKLIST)

### 1. Tài khoản & Tài nguyên
- [ ] **Google Account**: Để tạo dự án trên Firebase Console.
- [ ] **Supabase Account**: Đăng ký gói Free (tối đa 2 dự án).
- [ ] **Hạ tầng Host Directus**: Nơi chạy Directus (Railway.app, Render.com, VPS).
- [ ] **Domain (Tùy chọn)**: Để cấu hình API (ví dụ: `api.yourproject.com`).

### 2. Thông tin kỹ thuật cần lấy
- [ ] **Firebase Project ID**
- [ ] **Firebase Web API Key**
- [ ] **Supabase Connection String**: `postgres://postgres:[PASSWORD]@db.[PROJECT-ID].supabase.co:5432/postgres`
- [ ] **JWT Secret của Firebase**: Tìm trong Service Accounts của Google Cloud Project.

### 3. Thiết lập Database ban đầu
- [ ] **Schema**: Thiết kế sơ bộ bảng nào cần đồng bộ, bảng nào chỉ dành cho CMS.
- [ ] **Public Users Table**: Tạo bảng `public.users` trong Supabase, khóa chính `firebase_uid` (text/uuid).

## 🚀 MILESTONES (Các bước triển khai đầu tiên)

1. **Khởi tạo**: Tạo dự án Firebase và Supabase.
2. **Kết nối DB**: Cài đặt Directus và trỏ về PostgreSQL của Supabase.
3. **Cấu hình "Bắc cầu"**: Thiết lập để Supabase chấp nhận Token từ Firebase.
4. **Viết Trigger**: Tạo Cloud Function đồng bộ User đăng ký từ Firebase sang Supabase.
