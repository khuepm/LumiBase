# Đặc tả Giao diện Thiết lập & Tiện ích mở rộng (Settings & Extensions Spec)

Module Thiết lập & Tiện ích mở rộng cung cấp các công cụ cấu hình toàn cục hệ thống, cá nhân hóa thương hiệu (Branding), quản lý Webhooks, cấu hình SCIM và chợ tiện ích mở rộng (Marketplace).

---

## 1. Tùy biến Thương hiệu & Giao diện (Branding Customizer)

Đây là nơi quản trị viên tùy biến giao diện của chính Lumibase Studio để đồng bộ với nhận diện thương hiệu của công ty.

```
┌──────────────────────────────────────────────────────────┐
│ Thiết lập thương hiệu                 [ Lưu cấu hình ]   │
├───────────────────────────────┬──────────────────────────┤
│ CẤU HÌNH LOGO & MÀU SẮC        │ LIVE PREVIEW (Xem trước) │
│ - Tải lên Logo chính          │ ┌──────────────────────┐ │
│ - Chọn màu nhấn (Primary)     │ │ Preview Studio App   │ │
│   [ Ô chọn mã màu HSL ]       │ │                      │ │
│ - Chọn chế độ mặc định        │ │ (Hiển thị màu mới    │ │
│   (Light / Dark / Auto)       │ │  ngay lập tức)       │ │
│                               │ └──────────────────────┘ │
└───────────────────────────────┴──────────────────────────┘
```

### 1.1 Khay thiết lập thuộc tính (Branding Config)
* **Tải lên Logo**: Ô tải lên logo ứng dụng (hỗ trợ tệp SVG, PNG). Tự động hiển thị hình ảnh xem trước ngay sau khi tải lên.
* **Bộ chọn màu nhấn (Color Picker)**: Chọn màu chủ đạo (`--primary`). Cung cấp bảng màu gợi ý các tông màu HSL hiện đại, sang trọng hoặc cho phép nhập mã màu HEX/RGB tùy chọn.
* **Tỷ lệ bo góc (Border Radius)**: Thanh trượt (Slider) để cấu hình độ bo góc của các nút bấm và thẻ card (từ `0px` - góc vuông sắc cạnh đến `16px` - bo tròn mềm mại).

### 1.2 Khung Xem trước Trực tiếp (Live Preview Pane)
* Phía bên phải màn hình hiển thị một phiên bản mô phỏng thu nhỏ (Mockup) của giao diện App Shell.
* Khi người dùng thay đổi màu nhấn hoặc tải lên logo mới ở cột trái, giao diện Mockup bên phải sẽ áp dụng ngay các CSS variables mới để hiển thị kết quả thay đổi ngay lập tức (không cần lưu cấu hình và tải lại trang) giúp người dùng dễ dàng căn chỉnh thẩm mỹ.

---

## 2. Quản lý Tiện ích mở rộng & Chợ ứng dụng (Extensions & Marketplace)

Lumibase hỗ trợ cài đặt các extension từ bên thứ ba chạy trong môi trường sandbox an toàn để mở rộng tính năng của CMS.

### 2.1 Quản lý Extension đã cài đặt (Extensions Manager - `/settings/extensions`)
* Danh sách tiện ích hiển thị dưới dạng lưới thẻ. Mỗi thẻ gồm: Tên extension, Tác giả, Phiên bản, và Mô tả ngắn.
* **Quản lý quyền hạn (Sandbox Permissions)**: Bấm vào một extension sẽ mở cửa sổ chi tiết hiển thị các quyền hạn mà extension này yêu cầu (ví dụ: quyền đọc bảng `Products`, quyền gọi API mạng ngoài).
* Quản trị viên có thể bật/tắt các quyền này riêng biệt thông qua các công tắc Toggle an toàn để bảo vệ dữ liệu hệ thống.

### 2.2 Chợ ứng dụng (Marketplace Browser - `/settings/marketplace`)
* Tải danh sách các extension được ký số an toàn từ hệ thống trung tâm. Hỗ trợ tìm kiếm theo từ khóa và lọc theo danh mục (Ví dụ: SEO, Analytics, Payment, AI Assistant).

```
┌──────────────────────────────────────────────────────────┐
│ Chi tiết Extension: Shopify Sync                         │
├──────────────────────────────────────────────────────────┤
│ Tác giả: Lumibase Team | Phiên bản: v1.2.0               │
│                                                          │
│ Mô tả: Đồng bộ sản phẩm từ Shopify về Lumibase tự động. │
│                                                          │
│ Mã cài đặt (Extension Slug):                             │
│ ┌───────────────────────────────────────────────┬──────┐ │
│ │ shopify-sync-extension                        │ Copy │ │
│ └───────────────────────────────────────────────┴──────┘ │
│                                                          │
│ [ Cài đặt ngay ]                                         │
└──────────────────────────────────────────────────────────┘
```

* **Sao chép mã cài đặt nhanh (Extension Slug Display)**:
  * Trong trang chi tiết của mỗi extension, ngoài nút "Cài đặt ngay" (Deep-link: `studio://install?slug=<slug>`), giao diện sẽ hiển thị một ô văn bản chứa **Extension Slug** kèm theo nút sao chép nhanh (Copy) dạng icon.
  * Điều này cung cấp giải pháp dự phòng đáng tin cậy. Nếu trình duyệt không hỗ trợ kích hoạt deep-link, người dùng có thể sao chép chuỗi slug này và dán trực tiếp vào ô cài đặt thủ công trong ứng dụng Studio để thực hiện cài đặt.

---

## 3. Đáp ứng trên Thiết bị Di động (Mobile Spec)
* **Tab chuyển đổi**: Trang cấu hình settings chia nhiều nhóm (General, Branding, Webhooks, Marketplace) sẽ hiển thị dạng thanh cuộn ngang các tab ở đầu trang trên thiết bị di động.
* **Ẩn Live Preview**: Khung xem trước trực tiếp (Live Preview) của Branding sẽ được ẩn đi trên màn hình điện thoại để tập trung không gian hiển thị cho form nhập liệu. Người dùng có thể bấm nút "Xem thử" nổi ở góc màn hình để mở popup xem trước kết quả.
* **Copy Slug chạm nhẹ**: Nút copy slug tiện ích mở rộng được thiết kế lớn, có phản hồi rung nhẹ (Haptic Feedback) và hiển thị tooltip "Đã sao chép!" màu xanh lá nổi bật trong 1.5 giây sau khi chạm.
