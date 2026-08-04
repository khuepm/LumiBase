---
version: 1
lastUpdated: 2026-08-04T21:59:34.150Z
sourceLang: en
translatedFrom: en
sourceHash: 9d561ce21bd8e439
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-04T21:59:34.150Z
codeVerifiedHash: 9d561ce21bd8e439
codeVerifiedClaims: 12
---

# Phase D1: Quản lý người dùng & team

Tài liệu này tóm tắt các tính năng đã triển khai trong Phase D1 cho việc quản lý người dùng và team.

## 1. Mô hình dữ liệu
Nền tảng quản lý người dùng ở cấp toàn cục (identity qua Logto) và gắn họ vào từng site cụ thể bằng bảng junction `user_sites`. Team được scope hoàn toàn theo `siteId`, và `team_members` liên kết người dùng với các team đó.

## 2. API Endpoints (`apps/cms`)
- **`GET /api/v1/users`**: Liệt kê toàn bộ người dùng thuộc site đang hoạt động.
- **`POST /api/v1/users/invite`**: Mời một người dùng mới bằng email. Nếu người dùng chưa tồn tại ở cấp toàn cục, một người dùng "shadow" được tạo với `logtoId` giả cho tới khi họ đăng ký chính thức.
- **`PATCH /api/v1/users/:id`**: Cập nhật thông tin người dùng và role của họ trong site hiện tại.
- **`DELETE /api/v1/users/:id`**: Bỏ quyền truy cập của một người dùng khỏi site.
- **`POST /api/v1/users/:id/impersonate`**: Sinh một token impersonation mô phỏng cho admin dùng.
- **`GET/POST/PATCH/DELETE /api/v1/teams`**: CRUD tiêu chuẩn cho thực thể team.
- **`POST/DELETE /api/v1/teams/:id/members`**: Quản lý thành phần của team.

## 3. Module Frontend (`apps/studio`)
- **Users List**: Bảng đầy đủ hiển thị avatar, role, trạng thái và dữ liệu lần cuối truy cập.
- **Team Management**: Tổng quan team dạng card kèm giao diện gán thành viên bằng dialog.
- **Invitations**: UI mời trực tiếp, nối vào quy trình tạo shadow user ở backend.
