# Đặc tả Giao diện Phân quyền & Bảo mật (Access Control Spec)

Module Phân quyền & Bảo mật (Access Control) là nơi quản trị viên thiết lập vai trò (Roles), chính sách bảo mật (Policies) chi tiết đến từng trường dữ liệu, ma trận quyền và chạy thử nghiệm bảo mật trong môi trường giả lập (Sandbox).

---

## 1. Màn hình Vai trò & Nhóm người dùng (Roles & Teams - `/access/roles`)

Giao diện quản lý các vai trò trong hệ thống được thiết kế dạng lưới thẻ (Card Grid) trực quan.

```
┌──────────────────────────────────────────────────────────┐
│ Vai trò & Nhóm người dùng                [ + Thêm vai trò ]│
├──────────────────────────────────────────────────────────┤
│  ┌────────────────────────┐  ┌────────────────────────┐  │
│  │ Thẻ: Biên tập viên     │  │ Thẻ: Lập trình viên    │  │
│  ├────────────────────────┤  ├────────────────────────┤  │
│  │ - 5 thành viên         │  │ - 2 thành viên         │  │
│  │ - 12 chính sách áp dụng│  │ - 8 chính sách áp dụng │  │
│  │ [ Avatars thành viên ] │  │ [ Avatars thành viên ] │  │
│  └────────────────────────┘  └────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 1.1 Thẻ Vai trò (Role Card)
* Mỗi thẻ hiển thị: Tên vai trò (ví dụ: Administrator, Editor, Guest), Số lượng thành viên thuộc nhóm, số lượng chính sách (Policies) đang được gán cho vai trò này.
* Hiển thị danh sách Avatar tròn xếp chồng của các thành viên đầu tiên trong nhóm.
* **Gán nhanh thành viên (Quick Assign)**: Quản trị viên có thể mở Drawer chứa danh sách người dùng ở bên phải, kéo thả (Drag and Drop) một tài khoản người dùng trực tiếp vào Thẻ Vai trò để thêm họ vào nhóm quyền đó một cách nhanh chóng.

---

## 2. Trình soạn thảo Chính sách (Policy Editor - `/access/policies/$id`)

Policy Editor cung cấp hai chế độ soạn thảo song song tùy chọn phù hợp cho cả quản trị viên không chuyên lẫn lập trình viên.

```
┌──────────────────────────────────────────────────────────┐
│ Sửa chính sách: "Chỉ sửa bài viết cá nhân"                │
├──────────────────────────────────────────────────────────┤
│ Chế độ: [ Trực quan (GUI) ] [ Mã nguồn (JSON Code) ]       │
├──────────────────────────────────────────────────────────┤
│                                                          │
│   [ TRÌNH SOẠN THẢO QUY TẮC BẢO MẬT TRỰC QUAN - GUI ]     │
│   - Chọn bảng dữ liệu: [ Tin tức ]                       │
│   - Quyền hạn: [ ] Đọc  [x] Sửa  [ ] Thêm  [ ] Xóa       │
│   - Điều kiện lọc:                                       │
│     * `author_id` BẰNG `$user.id`                         │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 2.1 Chế độ Trực quan (GUI Mode)
* **Bảng dữ liệu & Hành động**: Menu lựa chọn bảng dữ liệu áp dụng chính sách, đi kèm là các checkbox chọn hành động: Đọc (Read), Thêm (Create), Sửa (Update), Xóa (Delete).
* **Bộ dựng điều kiện lọc (Rule Builder)**:
  * Cho phép thiết lập các quy tắc động.
  * Sử dụng các biến hệ thống đặc biệt như `$user.id` (ID người dùng đang đăng nhập), `$user.role` (Vai trò hiện tại).
  * Ví dụ: Cho phép sửa bài viết khi `author_id` BẰNG `$user.id`.
* **Bộ lọc Trường dữ liệu (Field Whitelist)**:
  * Hiển thị danh sách tất cả các trường trong bảng kèm checkbox.
  * Quản trị viên có thể tích chọn để giới hạn người dùng thuộc chính sách này chỉ được đọc/sửa một số trường nhất định (ví dụ: Biên tập viên được sửa `title`, `body` nhưng không được sửa trường `status` và `view_count`).

### 2.2 Chế độ Mã nguồn (JSON Code Mode)
* Chuyển đổi sang Monaco Editor hỗ trợ đầy đủ tính năng:
  * Tự động hoàn thành mã (Autocomplete) dựa trên JSON Schema của chính sách LumiBase.
  * Làm nổi bật cú pháp (Syntax Highlighting) và báo lỗi cú pháp trực tiếp (Linter).
  * Định dạng code nhanh (Auto format) giúp các nhà phát triển copy-paste hoặc chỉnh sửa các policy phức tạp nhanh chóng.

---

## 3. Ma trận Quyền & Sandbox thử nghiệm (Matrix & Sandbox)

### 3.1 Ma trận Quyền hạn (Permission Matrix - `/access/matrix`)
* Giao diện dạng bảng hai chiều hiển thị tổng quan quyền hạn của toàn hệ thống:
  * **Cột**: Các vai trò (Roles) trong hệ thống.
  * **Hàng**: Các bảng dữ liệu (Collections).
  * **Ô giao cắt**: Hiển thị trạng thái các quyền cơ bản (R - Read, C - Create, U - Update, D - Delete) dưới dạng các ký tự nhỏ có màu (Xanh lá: Cho phép, Đỏ: Cấm hoàn toàn, Vàng: Cho phép có điều kiện).
  * Nhấp chuột vào một ô giao cắt sẽ mở ngăn Drawer bên phải hiển thị danh sách các chính sách (Policies) đang kiểm soát ô đó để chỉnh sửa nhanh.

### 3.2 Hộp thử nghiệm Sandbox (Security Sandbox - `/access/sandbox`)
* Giao diện giả lập giúp kiểm tra bảo mật trước khi áp dụng chính sách vào môi trường thực tế.
* **Cấu hình giả lập**: Quản trị viên chọn một User cần test, chọn một Bảng dữ liệu và chọn Hành động muốn thử nghiệm (ví dụ: Sửa bài viết).
* **Kết quả giả lập**:
  * Trả về kết quả trực quan lớn: **ALLOW (Cho phép)** màu xanh lá hoặc **DENY (Từ chối)** màu đỏ.
  * Hiển thị dòng giải thích chi tiết quy trình xử lý (Rule Evaluation Logs): Chỉ ra chính xác chính sách nào đã chặn hành động đó, hoặc trường dữ liệu nào bị từ chối truy cập.

---

## 4. Đáp ứng trên Thiết bị Di động (Mobile Spec)
* **Ma trận tối giản**: Trên màn hình di động, bảng Ma trận quyền (Matrix) quá rộng sẽ tự động ẩn các cột phụ, chỉ hiển thị vai trò được chọn qua trình dropdown ở trên cùng màn hình.
* **Tab-based Policy**: Form soạn thảo Policy trên mobile sẽ tách các bước: Thiết lập cơ bản -> Bộ dựng quy tắc -> Whitelist trường thành các màn hình Tab độc lập để giảm thiểu cuộn màn hình.
