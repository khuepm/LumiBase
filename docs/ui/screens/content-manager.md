# Đặc tả Giao diện Quản lý Nội dung (Content Manager Spec)

Màn hình Quản lý Nội dung là nơi biên tập viên thao tác thường xuyên nhất để đăng tải, lọc tìm và cập nhật dữ liệu. Giao diện được thiết kế để xử lý dữ liệu lớn một cách nhanh chóng và chính xác.

---

## 1. Màn hình Danh sách Nội dung (List Page - `/content/$collection`)

Màn hình danh sách hỗ trợ hiển thị dữ liệu linh hoạt dưới nhiều chế độ xem khác nhau để phù hợp với từng loại nội dung.

```
┌──────────────────────────────────────────────────────────┐
│ [Crumbs] Collection Name             [Realtime Live Toggle]│
├──────────────────────────────────────────────────────────┤
│ [ Tìm kiếm... ] [ Lọc bộ lọc ] [ Sắp xếp ] [ Layout Switch ]│
├──────────────────────────────────────────────────────────┤
│                                                          │
│                 VÙNG HIỂN THỊ DỮ LIỆU                    │
│           (Lưới Bảng / Kanban / Grid Thẻ)               │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ [x] Chọn 3 hàng: [ Đóng băng ] [ Xóa ] [ Xuất CSV ]      │
└──────────────────────────────────────────────────────────┘
```

### 1.1 Trình chuyển đổi Chế độ xem (Layout Switcher)
Người dùng có thể chuyển đổi nhanh hiển thị dữ liệu qua 3 chế độ xem chính:
1. **Tabular (Bảng biểu - Mặc định)**:
   * Hiển thị bảng dữ liệu truyền thống với tính năng cuộn vô hạn (Infinite Scroll) kết hợp ảo hóa hàng (Virtualization - qua React Virtual) giúp hiển thị hàng chục nghìn dòng mà không gây lag trình duyệt.
   * Cột có thể kéo rộng/hẹp tùy ý. Click tiêu đề cột để sắp xếp nhanh.
2. **Cards (Lưới thẻ)**:
   * Thích hợp cho các collection nhiều hình ảnh (ví dụ: Tin tức, Sản phẩm, Portfolio).
   * Thẻ hiển thị hình ảnh cover, tiêu đề lớn, ngày tháng và trạng thái (Draft, Published).
3. **Kanban (Bảng phân trạng thái)**:
   * Chia cột dọc dựa trên một trường trạng thái (ví dụ: `status`: Draft, Under Review, Published).
   * Hỗ trợ kéo thả thẻ qua lại giữa các cột để cập nhật nhanh trạng thái của bài viết (ứng dụng `@dnd-kit`).

### 1.2 Thanh công cụ nâng cao (Toolbar & Filter Builder)
* **Realtime Sync Switch**: Nút toggle "Theo dõi trực tiếp" ở góc phải. Khi bật, danh sách sẽ tự động cập nhật khi có thay đổi từ DB qua WebSockets mà không cần tải lại trang.
* **Bộ dựng bộ lọc trực quan (Advanced Filter Builder)**:
   * Cho phép thêm nhiều điều kiện lồng nhau bằng toán tử `AND` / `OR`.
   * Ví dụ: `Trạng thái` BẰNG `Published` VÀ (`Giá tiền` LỚN HƠN `500` HOẶC `Đánh giá` BẰNG `5 sao`).
   * Giao diện thiết kế dạng các dòng khối chữ nhật bo tròn có thể xóa nhanh bằng icon `x`.
* **Lưu bộ lọc (Presets/Bookmarks)**: Cho phép lưu bộ lọc phức tạp hiện tại thành một "Preset" cá nhân hoặc dùng chung để truy cập nhanh lần sau qua menu bên.

### 1.3 Thao tác hàng loạt (Bulk Actions)
* Khi tích chọn một hoặc nhiều ô đầu dòng trong bảng, một thanh công cụ màu đen (Floating Black Bar) sẽ nổi lên ở đáy màn hình:
  * **Actions**: Đổi trạng thái hàng loạt (Publish/Archive), Xóa hàng loạt, Xuất Excel/CSV, Nhân bản dữ liệu.
  * Hiển thị rõ số lượng hàng đang chọn (ví dụ: "Đã chọn 12 sản phẩm").

---

## 2. Trình biên tập chi tiết (Detail Editor - `/content/$collection/$id`)

Trình biên tập chi tiết được thiết kế theo tỷ lệ 2 cột để tận dụng không gian màn hình ngang của máy tính làm việc.

```
┌──────────────────────────────────────────────────────────┐
│ Back ── Sửa bài viết: "Giới thiệu Lumibase"              │
├───────────────────────────────┬──────────────────────────┤
│                               │ TAB PANEL (Right Drawer)  │
│  [ FORM NHẬP LIỆU CHÍNH ]      │ ┌──────────────────────┐ │
│  - Title (Text)               │ │ Comments | Revisions | │ │
│  - Body (Rich WYSIWYG)        │ │  History | Raw JSON  │ │
│  - Category (Relation Picker) │ └──────────────────────┘ │
│                               │                          │
├───────────────────────────────┴──────────────────────────┤
│ [ Đáy: Sticky Save Bar ]  [ Bản nháp ]   [ Hủy ] [ Lưu ]  │
└──────────────────────────────────────────────────────────┘
```

### 2.1 Cột Trái: Form nhập liệu chính
* Phân vùng thông tin: Các trường dữ liệu được gộp nhóm trực quan bằng các thẻ card bo tròn hoặc chia tab ngang nếu form quá dài.
* **Relation Picker (Chọn quan hệ)**: Ô chọn thực thể liên kết (ví dụ: liên kết bài viết tới Tác giả). Hiển thị dưới dạng thẻ nhỏ có ảnh và tên tác giả. Bấm vào nút `+` mở cửa sổ modal lưới để tìm kiếm và chọn nhanh tác giả, hoặc tạo mới tác giả ngay tại chỗ mà không cần thoát trang soạn thảo.

### 2.2 Cột Phải (Tab Panel / Drawer bổ trợ)
Cột phụ bên phải gồm các tab chức năng có thể ẩn/hiển thị tùy chọn:
* **Lịch sử & So sánh phiên bản (Revisions)**:
  * Hiển thị danh sách các phiên bản đã lưu trong quá khứ kèm tên người sửa và thời gian.
  * Click chọn hai phiên bản bất kỳ để so sánh sự khác biệt (Diff View): Các phần văn bản bị xóa sẽ được tô màu đỏ gạch ngang, các phần được thêm mới tô màu xanh lá cây đậm.
* **Bình luận & Ghi chú (Comments)**:
  * Nơi các admin trao đổi trực tiếp trên bài viết. Hỗ trợ tag tên bằng ký tự `@` (ví dụ: `@alex xem hộ bài viết này`).
* **Trình soạn thảo JSON thô (Raw JSON Editor)**:
  * Tích hợp trình soạn thảo Monaco Editor (hoặc phiên bản gọn nhẹ) cho phép xem và sửa trực tiếp cấu hình JSON thô của hàng dữ liệu hiện tại dành cho các chuyên gia và nhà phát triển.

### 2.3 Sticky Save Bar (Thanh lưu trữ cố định)
* Cố định ở đáy vùng soạn thảo, luôn hiển thị bất kể cuộn form đến đâu.
* Các tùy chọn lưu: "Save & Stay" (Lưu và ở lại trang), "Save as Draft" (Lưu nháp), "Publish" (Đăng công khai).
* Chỉ báo tự động lưu (Auto-saved) hiển thị dạng chữ mờ nhỏ kèm thời gian cập nhật cuối cùng.

---

## 3. Trải nghiệm trên thiết bị di động (Mobile Spec)
* **Collapse to Single Column**: Giao diện 2 cột trên máy tính tự động xếp chồng thành 1 cột trên mobile. Cột thuộc tính phụ (Comments, Revisions, Raw JSON) sẽ được ẩn đi và chỉ xuất hiện dưới dạng một thanh Tab nằm ngang cạnh tiêu đề bài viết.
* **Swipe to Action**: Trên màn hình danh sách di động, vuốt một mục sang trái để hiện nút Xóa (màu đỏ) và Lưu trữ (màu xám). Vuốt sang phải để mở màn hình chỉnh sửa nhanh.
* **Bottom Sheet Editors**: Các form nhập liệu quan hệ (Relation Picker) thay vì mở modal tràn màn hình sẽ mở lên dạng Bottom Sheet trượt lên từ đáy màn hình giúp dễ thao tác bằng một ngón tay.
