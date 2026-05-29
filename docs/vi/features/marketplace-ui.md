# Extension Marketplace UI

LumiBase Studio đi kèm giao diện **Extension Marketplace** trực quan giúp nhà quản trị tìm kiếm, xem chi tiết và cài đặt các tiện ích mở rộng (extensions) nhằm nâng cao sức mạnh cho hệ thống CMS.

## Các chức năng chính

Trang Marketplace được tích hợp trực tiếp tại menu **Settings → Marketplace** (`/settings/marketplace`) với các chức năng chính:

### 1. Trình duyệt Extension (Extension Browser)
- **Grid Layout**: Hiển thị danh sách các tiện ích mở rộng dưới dạng card responsive, bao gồm thông tin: Tên extension, Nhà phát hành, Phiên bản hiện tại, và Nhãn phân loại (badges).
- **Bộ lọc động (Filters)**: Cho phép tìm kiếm nhanh theo từ khóa (tên, nhà phát hành, slug) và lọc theo phân loại (Module, Interface, Display, Layout, Panel, Endpoint).

### 2. Chi tiết và Cấp quyền (Detailed Modal & Permissions)
Nhấp vào **View details** trên bất kỳ card nào để mở hộp thoại thông tin chi tiết:
- **Mô tả chi tiết (Description)**: Giới thiệu tính năng và tác dụng của tiện ích mở rộng.
- **Capabilities**: Các khả năng bổ sung mà extension cung cấp cho CMS.
- **Requested Permissions**: Danh sách quyền hạn mà tiện ích yêu cầu truy cập (được hiển thị bằng các nhãn màu hổ phách để cảnh báo an toàn).
- **Chữ ký bảo mật (Cryptographic Signature)**: Hệ thống tự động xác thực chữ ký của tiện ích với Key ID của nhà phát hành đã được kiểm duyệt nhằm đảm bảo tính toàn vẹn và chống giả mạo mã nguồn.

### 3. Cài đặt Một chạm (One-click Install)
- Nhấn **Install** để tiến hành tải xuống và đăng ký extension vào site hiện tại.
- Trạng thái cài đặt được phản ánh ngay lập tức trên giao diện qua nhãn **Installed** (màu xanh lá) giúp tránh cài đặt trùng lặp.

---

## Kiến trúc API & Tích hợp

Giao diện kết nối trực tiếp đến các cổng API sau:

- `GET /api/v1/marketplace/extensions` — Trả về danh sách các extension đã được xuất bản và xác thực trên hệ thống Marketplace.
- `GET /api/v1/marketplace/extensions/:slug` — Lấy chi tiết thông tin manifest (description, capabilities, permissions, bundle URL...) của một extension cụ thể.
- `POST /api/v1/marketplace/extensions/:slug/install` — Thực hiện cài đặt extension vào site hiện tại của người dùng.
- `GET /api/v1/extensions` — Trích xuất danh sách các extension đã được cài đặt thành công để đối chiếu hiển thị trạng thái.

## Phân quyền hệ thống
Để truy cập và thao tác trên Marketplace, người dùng cần có quyền `extensions:read` và `extensions:write` được cấu hình trong bảng phân quyền (Policies).
