# Đặc tả Giao diện Quản lý Tệp tin (File Manager Spec)

File Manager là nơi lưu trữ, tổ chức thư mục và xử lý tài nguyên đa phương tiện (hình ảnh, video, tài liệu) được sử dụng trong các bảng nội dung của LumiBase.

---

## 1. Cấu trúc Layout Thư viện Tệp tin (File Library Layout - `/files`)

Giao diện được thiết kế dạng 3 cột để đảm bảo khả năng duyệt tệp tin nhanh chóng và quản trị siêu dữ liệu tiện lợi.

```
┌──────────────────────────────────────────────────────────┐
│ Thư viện tệp tin                     [ Tải lên tệp mới ] │
├──────────┬──────────────────────────┬────────────────────┤
│ Cây      │ LƯỚI TỆP TIN & THƯ MỤC   │ FILE INSPECTOR     │
│ thư mục  │ ┌──────────────────────┐ │ ┌────────────────┐ │
│          │ │ [Folder 1] [Folder 2]│ │ │ Ảnh: banner.jpg│ │
│ - Root   │ │ [Ảnh 1]    [Ảnh 2]   │ │ │ - Sửa / Cắt ảnh│ │
│   - Blog │ │ [PDF 1]    [Video 1] │ │ │ - Tiêu đề      │ │
│   - Asset│ └──────────────────────┘ │ │ - Thẻ (Tags)   │ │
└──────────┴──────────────────────────┴────────────────────┘
```

### 1.1 Cột Trái: Cây thư mục (Folder Tree)
* Hiển thị cấu trúc thư mục phân cấp. Cho phép nhấp mở rộng/thu gọn thư mục.
* Hỗ trợ kéo thả các tệp tin từ lưới bên phải trực tiếp vào các nhánh thư mục bên trái để di chuyển tệp tin nhanh chóng.
* Có nút "Tạo thư mục mới" nhanh ngay bên cạnh thư mục cha.

### 1.2 Cột Giữa: Lưới tệp tin (File Grid)
* **Khu vực thả tệp (Drag & Drop Zone)**: Toàn bộ vùng lưới hoạt động như một khu vực nhận tệp thả vào. Khi người dùng kéo tệp từ máy tính vào, giao diện sẽ hiển thị lớp phủ mờ màu xanh dương kèm thông điệp: "Thả tệp vào đây để tải lên".
* **Lưới hiển thị**: Hiển thị hình thu nhỏ (thumbnail) chất lượng cao cho hình ảnh/video, và icon định dạng rõ ràng cho các file tài liệu (PDF, Word, Zip).
* **Thanh trạng thái tải lên (Upload Queue Bar)**: Khi có tệp đang tải lên, một khay nhỏ trượt lên ở góc dưới màn hình hiển thị danh sách các tệp đang upload kèm thanh phần trăm tiến trình (Progress Bar) chạy thực tế theo presigned R2 upload.

### 1.3 Cột Phải: Bảng thuộc tính tệp (File Inspector)
* Tự động xuất hiện khi người dùng nhấp chọn một tệp tin trong lưới.
* Hiển thị thông tin tệp: Định dạng, Dung lượng, Độ phân giải, Ngày tải lên, Người tải lên.
* Form chỉnh sửa nhanh: Tiêu đề tệp (Title), Văn bản thay thế (Alt Text - cực kỳ quan trọng cho SEO/A11y), Thẻ mô tả (Tags) để tìm kiếm nhanh.
* **Danh sách sử dụng (Asset Usage)**: Hiển thị danh sách các bài viết hiện đang sử dụng tệp tin này (ví dụ: "Được dùng trong: Bài viết 'Giới thiệu', Bài viết 'Tin tức tháng 5'"). Điều này ngăn chặn việc vô tình xóa mất tệp tin đang hiển thị trên website công cộng.

---

## 2. Trình chỉnh sửa hình ảnh tích hợp (Image Editor)

Khi nhấp vào nút "Sửa ảnh" trong File Inspector, một cửa sổ modal lớn sẽ hiện ra chứa trình xử lý ảnh trực quan.

### 2.1 Cắt và xoay ảnh (Crop & Rotate)
* Cho phép chọn các tỷ lệ cắt ảnh phổ biến: Tự do, 1:1 (Square), 16:9 (Widescreen), 4:3.
* Hỗ trợ lật ảnh ngang/dọc và xoay ảnh góc 90 độ.

### 2.2 Điểm tiêu cự (Focal Point Definition)
* Tính năng độc đáo giúp tối ưu hóa hiển thị ảnh đáp ứng trên mọi thiết bị di động:
  * Người dùng nhấp chuột vào một vị trí quan trọng trên bức ảnh (ví dụ: khuôn mặt người mẫu). Một biểu tượng tâm ngắm nhỏ màu đỏ sẽ cố định tại vị trí đó.
  * Tâm ngắm này xác định tọa độ trọng tâm (focal point). Khi website hiển thị ảnh này trên điện thoại di động và bắt buộc phải cắt bớt ảnh để vừa màn hình dọc, hệ thống imgproxy sẽ tự động cắt ảnh xung quanh tiêu cự này, đảm bảo phần nội dung quan trọng nhất không bao giờ bị cắt mất.

---

## 3. Đáp ứng trên Thiết bị Di động (Mobile Spec)
* **Ẩn cây thư mục mặc định**: Cây thư mục bên trái sẽ ẩn đi, thay thế bằng nút dropdown chọn thư mục ở đầu trang.
* **Tải ảnh trực tiếp từ Camera**: Nút "Tải lên" trên di động mở Action Sheet cho phép người dùng chọn: Chụp ảnh trực tiếp bằng camera điện thoại hoặc Chọn ảnh từ Thư viện ảnh (Photo Library).
* **Lưới 2 cột**: Lưới tệp tin tự động chuyển thành cấu hình tối đa 2 cột thẻ lớn để dễ xem và chạm chọn trên màn hình cảm ứng di động.
