---
version: 1
lastUpdated: 2026-08-02T19:01:41.017Z
sourceLang: en
translatedFrom: en
sourceHash: 9d561ce21bd8e439
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:01:41.017Z
codeVerifiedHash: 9d561ce21bd8e439
codeVerifiedClaims: 12
---

# Phase D1: Quản lý Người dùng & Nhóm

Tài liệu này tóm tắt các tính năng được triển khai trong Phase D1 phục vụ việc quản lý người dùng và nhóm.

## 1. Mô hình dữ liệu
Nền tảng quản lý người dùng ở cấp độ toàn cục (xác thực danh tính qua Logto) và liên kết họ với các trang (site) cụ thể bằng bảng trung gian `user_sites`. Các nhóm (team) hoàn toàn thuộc phạm vi của một `siteId`, và bảng `team_members` liên kết người dùng với các nhóm đó.

## 2. Các điểm cuối API (`apps/cms`)
- **`GET /api/v1/users`**: Liệt kê tất cả người dùng thuộc về site đang hoạt động.
- **`POST /api/v1/users/invite`**: Mời người dùng mới qua email. Nếu người dùng chưa tồn tại toàn cục, một người dùng "shadow" sẽ được tạo với một `logtoId` giả định cho đến khi họ đăng ký chính thức.
- **`PATCH /api/v1/users/:id`**: Cập nhật thông tin chi tiết của người dùng và vai trò của họ trong site hiện tại.
- **`DELETE /api/v1/users/:id`**: Xóa quyền truy cập của người dùng khỏi site.
- **`POST /api/v1/users/:id/impersonate`**: Tạo token giả lập (impersonation token) dùng cho quản trị viên.
- **`GET/POST/PATCH/DELETE /api/v1/teams`**: Các thao tác CRUD chuẩn cho thực thể nhóm.
- **`POST/DELETE /api/v1/teams/:id/members`**: Quản lý thành viên trong nhóm.

## 3. Các mô-đun Frontend (`apps/studio`)
- **Danh sách người dùng (Users List)**: Bảng tổng hợp hiển thị avatar, vai trò, trạng thái và dữ liệu thời điểm hoạt động gần nhất.
- **Quản lý nhóm (Team Management)**: Giao diện tổng quan dạng thẻ (card) kèm hộp thoại gán thành viên.
- **Lời mời (Invitations)**: Giao diện mời trực tiếp kết nối với quy trình tạo shadow user ở backend.
