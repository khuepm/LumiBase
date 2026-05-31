# Đặc tả Giao diện Bộ dựng Mô hình Dữ liệu (Collections Builder Spec)

Collections Builder (Bộ dựng Mô hình Dữ liệu) cung cấp giao diện trực quan không cần viết mã (No-code) giúp các nhà thiết kế hệ thống và nhà phát triển dễ dàng tạo bảng dữ liệu (Collections), thêm các trường dữ liệu (Fields) và thiết lập mối quan hệ giữa các bảng.

---

## 1. Màn hình Tổng quan Lược đồ (Schema Canvas View - `/data-model`)

Màn hình hiển thị lược đồ quan hệ thực thể (ERD) trực quan dạng bản đồ nút (Nodes Map) sử dụng thư viện `@xyflow/react` (React Flow).

```
┌──────────────────────────────────────────────────────────┐
│ Lược đồ dữ liệu hệ thống               [ + Thêm bảng mới ]│
├──────────────────────────────────────────────────────────┤
│  ┌───────────────┐                                       │
│  │ Bảng: Bài viết │ ──────────────┐                       │
│  ├───────────────┤              │                        │
│  │ - id (uuid)   │              ▼                        │
│  │ - title       │      ┌───────────────┐                │
│  │ - author_id   │ ───> │ Bảng: Tác giả │                │
│  └───────────────┘      ├───────────────┤                │
│                         │ - id (uuid)   │                │
│                         │ - name        │                │
│                         └───────────────┘                │
└──────────────────────────────────────────────────────────┘
```

### 1.1 Khối biểu diễn Bảng (Collection Node)
* Mỗi bảng dữ liệu được biểu diễn bằng một khối hình chữ nhật bo tròn (Node).
* Thân khối hiển thị danh sách các trường chính kèm icon đại diện cho kiểu dữ liệu (chữ, số, quan hệ, ngày tháng).
* Khối có các đầu cắm tròn ở các cạnh để vẽ đường liên kết mối quan hệ.
* Cho phép rê chuột để di chuyển các khối trên không gian vô hạn, hỗ trợ phóng to/thu nhỏ (Zoom in/out) và thu nhỏ bản đồ góc (MiniMap).

### 1.2 Vẽ liên kết Quan hệ (Relationship Connector)
* Người dùng có thể kéo một đường nối từ cột quan hệ của bảng này sang đầu cắm của bảng khác. Khi thả chuột, một hộp thoại nhỏ sẽ xuất hiện tại điểm nối để cấu hình kiểu quan hệ:
  * **One-to-Many (1 - N)**
  * **Many-to-One (N - 1)**
  * **Many-to-Many (N - N)**
* Đường liên kết được vẽ dạng cong mượt mà, có mũi tên chỉ hướng quan hệ và nhãn text nhỏ hiển thị tên khóa ngoại (Foreign Key).

---

## 2. Trình tạo/Sửa bảng chi tiết (Collection Wizard & Inspector)

Khi nhấp đúp vào một bảng hoặc bấm "Thêm bảng mới", giao diện sẽ hiển thị chi tiết cấu hình bảng.

```
┌──────────────────────────────────────────────────────────┐
│ [Quay lại] Thiết lập Bảng: Tin tức       [Lưu cấu hình]  │
├───────────────────────────────┬──────────────────────────┤
│                               │ FIELD INSPECTOR (Right)  │
│   danh sách các trường (Fields) │ ┌──────────────────────┐ │
│  [+] Thêm trường dữ liệu mới   │ │ Cấu hình trường:       │ │
│  ┌──────────────────────────┐ │ │  - Nhãn (Label)        │ │
│  │ ☰ Title (Kiểu: Text)     │ │ │  - Bắt buộc (Required) │ │
│  │ ☰ Body (Kiểu: WYSIWYG)   │ │ │  - Giá trị mặc định   │ │
│  └──────────────────────────┘ │ └──────────────────────┘ │
└───────────────────────────────┴──────────────────────────┘
```

### 2.1 Trình tạo bảng nhanh (Wizard)
Sử dụng luồng 3 bước đơn giản khi tạo mới một bảng:
1. **Bước 1: Thông tin cơ bản**: Nhập tên bảng (định dạng snake_case tự động chuẩn hóa từ Tiếng Việt không dấu) và nhãn hiển thị trực quan.
2. **Bước 2: Cài đặt nâng cao**: Chọn bật/tắt các tính năng hệ thống tự động sinh như: Ghi nhận lịch sử sửa (Revisions), Thời gian tạo/sửa (`created_at`, `updated_at`), Người tạo/sửa (`user_created`, `user_updated`).
3. **Bước 3: Khởi tạo các trường mẫu**: Cho phép tích chọn tạo nhanh các trường phổ biến (ví dụ: Title, Description, Status) để có ngay bộ khung làm việc.

### 2.2 Sắp xếp trường dữ liệu & Bảng thuộc tính (Field Inspector)
* **Kéo thả sắp xếp thứ tự**: Danh sách các trường được sắp xếp theo dạng hàng dọc. Người dùng có thể dùng tay cầm kéo thả (drag handle `☰` sử dụng `@dnd-kit/sortable`) để thay đổi vị trí xuất hiện của trường dữ liệu trong form nhập liệu của biên tập viên.
* **Ngăn cấu hình trường (Field Inspector)**: Nhấp vào một trường dữ liệu sẽ mở ngăn trượt bên phải hiển thị chi tiết các thuộc tính:
  * **Validation Rules**: Cài đặt biểu thức chính quy (Regex) hoặc khoảng giới hạn (ví dụ: số từ 1 đến 100, độ dài chữ).
  * **Interface Config**: Chọn cách trường này hiển thị trong form (ví dụ: trường text thường, thanh trượt Slider, lịch chọn DatePicker, hoặc trình soạn thảo JSON).
  * **Display Config**: Chọn cách hiển thị trường này trong bảng danh sách (ví dụ: hiển thị dạng text thường, hiển thị dạng ảnh Avatar tròn, dạng chấm màu trạng thái).

---

## 3. Đáp ứng trên Thiết bị Di động (Mobile Spec)
* **Tắt tính năng kéo thả liên kết**: Trên điện thoại di động, bản đồ lược đồ (Schema Canvas) được chuyển đổi thành danh sách phẳng (List View) liệt kê các bảng và trường theo dạng phân cấp (Collapsible List/Accordion).
* **Bottom Sheet Inspector**: Nhấp vào một bảng hoặc trường sẽ mở ngăn cấu hình thuộc tính dạng Bottom Sheet vuốt lên từ cạnh dưới thay vì mở ngăn trượt bên phải như trên desktop.
