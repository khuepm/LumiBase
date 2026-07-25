# Đặc tả Setup Wizard & Recovery UIs

Tài liệu này đặc tả chi tiết giao diện cho hai luồng bảo mật quan trọng nhất trong việc vận hành hệ thống: **Setup Wizard** (Cài đặt hệ thống ban đầu) và **Account Recovery** (Khôi phục quyền truy cập khẩn cấp).

---

## 1. Trình cài đặt hệ thống (Setup Wizard)

Setup Wizard là giao diện bắt buộc xuất hiện khi hệ thống LumiBase chưa được khởi tạo. Giao diện sử dụng cấu trúc `BareLayout` (không chứa App Shell) để tạo không gian sạch sẽ, giúp người dùng tập trung tối đa.

```
┌──────────────────────────────────────────────────────────┐
│                      LUMIBASE LOGO                       │
│     [Bước 1: Account] ── (Bước 2: Path) ── [Bước 3: Security]     │
│ ┌──────────────────────────────────────────────────────┐ │
│ │                                                      │ │
│ │                   CARD NỘI DUNG                      │ │
│ │               (Form nhập liệu chi tiết)              │ │
│ │                                                      │ │
│ │  [ Quay lại ]                       [ Tiếp tục ]     │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### 1.1 Bước 1: Đăng ký tài khoản Admin (`/setup/account`)
* **Nội dung hiển thị**: Tiêu đề lớn "Tạo tài khoản quản trị tối cao". Form bao gồm các trường: Họ tên, Email, Mật khẩu, Nhập lại mật khẩu.
* **UX Tỉ mỉ**:
  * Đánh giá độ mạnh mật khẩu trực quan (Password Strength Meter) sử dụng thư viện `zxcvbn`. Cung cấp chỉ báo màu từ đỏ (yếu) đến xanh lá (rất mạnh) kèm gợi ý khắc phục (ví dụ: "Thêm ký tự đặc biệt").
  * Validator kiểm tra mật khẩu trùng khớp tức thì khi người dùng gõ vào ô nhập lại mật khẩu (`onChange`).
  * Nút "Tiếp tục" chỉ sáng lên khi tất cả dữ liệu hợp lệ.

### 1.2 Bước 2: Thiết lập Đường dẫn ẩn danh (`/setup/path`)
* **Mô tả tính năng**: Để ngăn chặn các cuộc tấn công quét bot tự động, LumiBase ẩn trang đăng nhập đằng sau một đường dẫn tùy chỉnh (Custom Admin Path, ví dụ: `/my-secret-admin-login-path`).
* **Thiết kế màn hình**:
  * Trường nhập liệu dạng Prefix tĩnh: `https://ten-mien.com/` + `[ Ô nhập custom path ]`.
  * Có nút "Tự động tạo ngẫu nhiên" (Generate Random) tạo ra chuỗi an toàn như `admin-7f8a-9c2b`.
  * Hộp cảnh báo màu vàng nổi bật: **"HÃY LƯU LẠI ĐƯỜNG DẪN NÀY. Bạn sẽ không thể tìm thấy trang đăng nhập nếu làm mất nó."**
  * Tích hợp nút sao chép nhanh (Copy to Clipboard) ngay bên cạnh đường dẫn được tạo.

### 1.3 Bước 3: Cấu hình Bảo mật nâng cao (`/setup/security`)
* **Nội dung cấu hình**:
  * Giới hạn số lần đăng nhập sai (Login Limit Rate): Chọn số lần tối đa (Dropdown: 3, 5, 10 lần) và thời gian khóa (ví dụ: 15 phút, 1 giờ).
  * Kênh nhận mã cảnh báo khẩn cấp: Đăng ký Webhook gửi tin nhắn Telegram, Slack hoặc gửi Email khi phát hiện đăng nhập trái phép.
* **Giao diện xác nhận hoàn tất (`/setup/done`)**:
  * Tải xuống File Phục hồi (Download Recovery Keyfile): Cung cấp nút tải xuống file chứa mã backup khẩn cấp để phục hồi hệ thống.
  * Nút bấm lớn "Khám phá Studio" để chuyển hướng về trang admin mới khởi tạo.

---

## 2. Luồng Phục hồi quyền truy cập (Account Recovery)

Khi admin quên đường dẫn ẩn hoặc bị khóa tài khoản do gõ sai mật khẩu quá nhiều lần, họ có thể tự khôi phục thông qua các cổng khẩn cấp công khai (không yêu cầu đăng nhập).

### 2.1 Màn hình Yêu cầu tìm lại đường dẫn (`/recovery/forgot-path`)
* **Mục đích**: Người dùng nhập email admin để nhận lại đường dẫn ẩn qua hòm thư điện tử.
* **UX Chống rò rỉ thông tin (Information Leakage Protection)**:
  * Khi bấm gửi, hệ thống luôn hiển thị thông báo thành công: *"Nếu email tồn tại trong hệ thống, bạn sẽ nhận được hướng dẫn..."* kể cả khi email đó không tồn tại. Điều này ngăn kẻ tấn công dò tìm các email admin hợp lệ.
  * Form hỗ trợ validate email chuẩn RFC 5322 trực tiếp trên client trước khi gửi request.

### 2.2 Màn hình Đăng nhập bằng mã Backup (`/recovery/backup-code`)
* **Trường hợp sử dụng**: Tài khoản bị khóa hoặc cần ghi đè khẩn cấp.
* **Giao diện**:
  * Form yêu cầu: Địa chỉ Email + Ô nhập mã khôi phục (Backup Code) gồm 16 ký tự phân cách bằng dấu gạch ngang (ví dụ: `XXXX-XXXX-XXXX-XXXX`).
  * Ô nhập mã backup tự động định dạng: Người dùng gõ chữ thường tự động chuyển thành chữ in hoa, và tự động chèn dấu gạch ngang `-` sau mỗi 4 ký tự giúp nhập liệu nhanh chóng.
  * Tích hợp validator kiểm tra định dạng ngay lập tức trên UI trước khi gửi lên API để tránh tốn thời gian chờ của người dùng.

---

## 3. Đáp ứng trên Thiết bị Di động (Mobile Adaptations)
* Trên mobile, toàn bộ khối card căn giữa sẽ mở rộng sát mép màn hình (`px-4`) để tận dụng tối đa chiều rộng.
* Bàn phím số (Numeric Keypad) tự động được kích hoạt cho các ô nhập mã khôi phục hoặc mã OTP (`inputmode="numeric"`).
* Cảnh báo quan trọng được phóng to chữ và đổi màu nền vàng nhạt để đảm bảo người dùng đọc kỹ trước khi bấm xác nhận trên màn hình nhỏ.
