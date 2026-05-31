# Đặc tả App Shell & Điều hướng (App Shell & Navigation Spec)

App Shell là khung giao diện bao bọc toàn bộ ứng dụng Lumibase Studio, chịu trách nhiệm điều hướng, tìm kiếm toàn cục, quản lý phiên làm việc và hiển thị cộng tác thời gian thực.

---

## 1. Cấu trúc Layout Tổng quan (Desktop vs Mobile)

### 1.1 Giao diện Desktop (Màn hình lớn)

Giao diện desktop chia thành 4 khu vực chính:

```
┌──────────────────────────────────────────────────────────┐
│ TopBar: site switcher · search (cmd-k) · presence · me   │
100vh ┌──────────┬───────────────────────────────────────────────┤
│ ModuleBar│ Content Area                                  │
│ (Icon    │   Header (breadcrumb, action buttons)         │
│  sidebar)│   ┌─────────────────────────────────────────┐ │
│          │   │ Page Content (list/detail/builder)      │ │
│          │   └─────────────────────────────────────────┘ │
└──────────┴───────────────────────────────────────────────┘
```

* **TopBar (Thanh đỉnh - Chiều cao: `64px`)**:
  * Chứa trình chuyển đổi trang web (`Site Switcher`) dạng dropdown ở góc trái.
  * Ô tìm kiếm toàn cục (`Omni Search`) ở giữa (kích hoạt bằng `Cmd+K`).
  * Chỉ báo cộng tác (`Presence Avatars`) hiển thị các admin khác đang trực tuyến trên cùng trang.
  * Menu tài khoản cá nhân (`Me Menu`) ở góc phải ngoài cùng.
  * Thiết kế: Kính mờ (glassmorphism), cố định trên cùng (`sticky top-0`).
* **ModuleBar (Thanh bên - Chiều rộng: `80px` thu gọn, `240px` mở rộng)**:
  * Chứa danh sách các biểu tượng lớn đại diện cho các module: **Content**, **Data Model**, **Access Control**, **Files**, **Automation**, **Settings**.
  * Có nút toggle ở đáy để mở rộng hiển thị đầy đủ nhãn văn bản.
  * Hỗ trợ cắm thêm biểu tượng (mount) từ các ứng dụng bên thứ ba (Extensions).
* **Content Area (Vùng hiển thị nội dung)**:
  * Sử dụng hệ thống cuộn độc lập (`overflow-y-auto`) để tránh cuộn toàn trang.
* **Right Drawer (Ngăn phụ trượt phải)**:
  * Dành cho các tính năng bổ trợ như xem lịch sử chỉnh sửa (Revisions), bình luận (Comments), hoặc xem mã JSON thô.

### 1.2 Giao diện Mobile (Màn hình dọc điện thoại)

```
┌──────────────────────────────────────────────────────────┐
│ TopBar: Menu Hamburger · Site Icon · Presence · Me       │
├──────────────────────────────────────────────────────────┤
│                                                          │
│               Vùng hiển thị nội dung chính               │
│               (Đã chuyển thành Layout 1 cột)              │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ Bottom Nav Bar: Content · Files · Automation · Settings  │
└──────────────────────────────────────────────────────────┘
```

* **ModuleBar bị ẩn đi**: Thay thế bằng **Bottom Nav Bar** ở cạnh dưới cùng màn hình (chứa 4 icon quan trọng nhất). Các chức năng phụ được gộp vào menu "More" dạng Bottom Sheet.
* **TopBar tối giản**: Ô tìm kiếm thu nhỏ thành biểu tượng kính lúp. Menu Hamburger ở góc trái dùng để vuốt nhanh ra danh sách các collection nội dung.
* **Thao tác cử chỉ**: Vuốt từ mép trái sang phải để mở danh sách collections; vuốt từ mép phải sang trái để mở các panel thuộc tính (inspectors).

---

## 2. Bảng tìm kiếm thông minh (Command Palette - Cmd+K)

Bảng tìm kiếm toàn cục là trung tâm điều khiển bằng bàn phím giúp tối ưu hiệu suất làm việc của admin chuyên nghiệp.

### 2.1 Giao diện & Hành vi
* Kích hoạt bằng phím tắt `Cmd + K` (Mac) hoặc `Ctrl + K` (Windows/Linux).
* Hiển thị dạng hộp thoại modal nổi bật ở trung tâm màn hình với lớp overlay tối phía sau.
* Tự động đặt tiêu điểm (focus) vào ô nhập liệu ngay khi mở ra.
* Cho phép dùng phím mũi tên `Lên/Xuống` để di chuyển tiêu điểm và phím `Enter` để chọn, phím `Esc` để đóng.

### 2.2 Phân nhóm Kết quả Tìm kiếm
Kết quả tìm kiếm được trả về cực nhanh và phân loại thành các nhóm trực quan:

1. **Điều hướng nhanh (Go to)**:
   * Đi đến các bảng nội dung: "Go to Collections: Products", "Go to Users", "Go to API Keys"...
2. **Tìm kiếm dữ liệu (Search Items)**:
   * Tìm kiếm nội dung cụ thể trong các bảng dữ liệu: "Product: iPhone 15 Pro", "User: John Doe"...
3. **Hành động nhanh (Quick Actions)**:
   * Thực hiện trực tiếp các lệnh hệ thống: "Create New Collection", "Clear System Cache", "Generate API SDK Types", "Toggle Dark Mode"...
4. **Tài liệu hướng dẫn (Docs)**:
   * Tìm nhanh hướng dẫn sử dụng Lumibase tích hợp sẵn: "How to configure field policy", "Connecting to S3"...

---

## 3. Cộng tác thời gian thực (Collaborative Presence)

Ứng dụng websocket tích hợp mang lại trải nghiệm làm việc nhóm mượt mà và trực quan.

### 3.1 Presence Avatars (Chỉ báo người dùng)
* Ở góc trên bên phải của TopBar, hiển thị một danh sách các bong bóng avatar xếp đè lên nhau (Avatars stack).
* Mỗi avatar đại diện cho một người dùng đang mở trang hiện tại. Hover vào avatar hiển thị tên và email người đó.
* Bong bóng avatar có viền màu sáng khác nhau. Khi một người dùng rời trang, avatar của họ sẽ mờ dần và biến mất với hiệu ứng fade-out mượt mà.

### 3.2 Khóa trường động & Collaborative Cursors (Trong trang chi tiết)
* **Chỉ báo tiêu điểm (Field Presence)**: Khi biên tập viên B đang focus vào nhập liệu ở ô "Meta Title", biên tập viên A sẽ thấy ô đó sáng lên một đường viền màu (ví dụ màu tím) kèm theo một thẻ tên nhỏ ghi tên B ở góc trên của ô nhập liệu.
* **Khóa ghi đè (Field Lock)**: Trường dữ liệu đang được B chỉnh sửa sẽ tạm thời bị khóa (disabled) trên màn hình của A để tránh việc gõ đè nội dung lên nhau. A chỉ có thể chỉnh sửa sau khi B di chuyển tiêu điểm sang ô khác (hoặc hết hạn timeout 30 giây không hoạt động).
