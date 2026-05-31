# Tài liệu Thiết kế Giao diện Lumibase Studio (UI Redesign Specification)

Tài liệu này định nghĩa hệ thống thiết kế (Design System) và đặc tả chi tiết giao diện người dùng (UI/UX Specification) cho **Lumibase Studio** — Ứng dụng quản trị (Admin SPA) của hệ thống Edge-native Headless CMS.

---

## 1. Trụ cột Thiết kế UI/UX (Design Pillars)

Để đạt mục tiêu vượt qua Directus và mang lại trải nghiệm đột phá cho người vận hành không chuyên lẫn lập trình viên, giao diện Lumibase Studio được xây dựng dựa trên 5 trụ cột:

1. **Rich Aesthetics & Premium Feel**:
   * Thiết kế giao diện phẳng kết hợp kính mờ (glassmorphic panels) với độ tương phản cao, tối giản viền (borderless) và sử dụng đổ bóng mềm (ambient shadows) để phân cấp thông tin.
   * Sử dụng bảng màu tinh tế, gradient mượt mà thay vì các khối màu đơn sắc thô cứng.
   * Hiệu ứng chuyển động vi mô (micro-animations) mượt mà phản hồi nhanh khi hover/active giúp giao diện "sống động".
2. **Mobile-First & Adaptive Layout**:
   * Toàn bộ màn hình được thiết kế đáp ứng (Responsive) hoàn hảo từ màn hình Ultra-wide đến điện thoại di động thông minh màn hình dọc.
   * Chuyển đổi thông minh: Các menu bên (sidebars) và panel kéo-thả sẽ tự động gập gọn thành các tab dưới đáy (bottom tabs) hoặc drawer/bottom sheet vuốt mở trên mobile.
3. **Meticulous Detail & Frictionless Flows**:
   * Thiết kế giao diện tập trung giảm tải nhận thức (Cognitive Load). Mọi form nhập liệu đều có validation động (`:user-valid`), hỗ trợ tự động điền (autofill) và hướng dẫn inline.
   * Các hành động nguy hiểm hoặc phức tạp được chia bước rõ ràng (Step-by-step Wizards) với thanh trạng thái trực quan.
4. **Realtime Collaborative & Presence**:
   * Tích hợp chỉ báo sự hiện diện realtime (Presence Avatars) và khóa trường dữ liệu (Field Locking) hiển thị rõ ràng ai đang xem hoặc chỉnh sửa phần nào nhằm tránh ghi đè dữ liệu.
5. **Developer-Friendly & Accessible (A11y)**:
   * Tuân thủ tiêu chuẩn WCAG 2.1 AA với tỷ lệ tương phản chữ đạt chuẩn, hỗ trợ điều hướng hoàn toàn bằng bàn phím (Keyboard Navigation) và phím tắt toàn cục (Cmd-K).
   * Tương thích tốt với các phần mềm đọc màn hình (screen reader) thông qua các nhãn ARIA mô tả chính xác.

---

## 2. Hệ thống Tokens Thiết kế (Design Tokens)

Hệ thống token được triển khai qua CSS Variables (`index.css`) tích hợp chặt chẽ với Tailwind CSS và Tailwind Variant (CVA).

### 2.1 Bảng màu (Color Palette - HSL Tailored)

Lumibase sử dụng bảng màu HSL hiện đại giúp dễ dàng tinh chỉnh độ sáng/tương phản giữa hai chế độ Light và Dark Mode.

| Token | Light Mode (CSS HSL) | Dark Mode (CSS HSL) | Mục đích sử dụng |
| :--- | :--- | :--- | :--- |
| `--background` | `0 0% 100%` | `240 10% 3.9%` | Nền ứng dụng chính |
| `--card` | `0 0% 98%` | `240 10% 6%` | Nền của các thẻ thông tin, bảng điều khiển |
| `--primary` | `262 83% 58%` (Indigo Purple) | `263 90% 65%` | Màu nhấn chủ đạo, CTA chính, trạng thái active |
| `--secondary` | `240 5% 96%` | `240 4% 16%` | Nền nút phụ, nhãn tag phụ |
| `--muted` | `240 5% 96%` | `240 4% 12%` | Chữ mờ hoặc nền tắt, trạng thái disable |
| `--accent` | `262 80% 95%` | `263 30% 18%` | Highlight các phần tử cần chú ý |
| `--border` | `240 6% 90%` | `240 4% 16%` | Màu đường viền mảnh ngăn cách các panel |
| `--ring` | `262 83% 58%` | `263 90% 65%` | Viền focus rõ ràng khi tab qua các phần tử |

### 2.2 Kiểu chữ (Typography)

* **Font chữ chính (Sans-Serif)**: `Outfit` (dành cho Headings/Title tạo cảm giác cao cấp, hiện đại) kết hợp với `Inter` (dành cho Body text nhằm tối ưu khả năng đọc ở kích thước nhỏ).
* **Font chữ code (Monospace)**: `JetBrains Mono` dành cho JSON Editor, Monaco Editor, và các hiển thị biến/code.

### 2.3 Phân cấp độ sâu (Shadows & Blurs)

* **Glassmorphism**: Áp dụng hiệu ứng kính mờ cho các thanh điều hướng và popup:
  ```css
  backdrop-filter: blur(12px) saturate(180%);
  background-color: hsla(var(--background), 0.75);
  border: 1px solid hsla(var(--border), 0.5);
  ```
* **Shadows**:
  * `sm`: Dành cho các phần tử nhỏ (buttons, tags).
  * `md`: Dành cho dropdown, popover và thẻ card.
  * `lg`: Dành cho các modal lớn, drawer trượt ra từ bên phải.

---

## 3. Cấu trúc Tài liệu Chi tiết

Hệ thống tài liệu UI được tổ chức thành các chủ đề chuyên sâu:

1. **[Đánh giá UI/UX & Đề xuất Cải tiến](./ui-ux-assessment.md)**: Phân tích các điểm nghẽn trải nghiệm hiện tại và giải pháp khắc phục.
2. **Đặc tả chi tiết các màn hình chức năng (`screens/`)**:
   * **[App Shell & Điều hướng chung](./screens/app-shell.md)**: Layout tổng thể ứng dụng, TopBar, Sidebar, Command Palette (Cmd-K) và Collaborative Presence.
   * **[Setup & Recovery UIs](./screens/setup-recovery.md)**: Luồng thiết lập ban đầu (Setup Wizard) và Phục hồi khẩn cấp (Account Recovery).
   * **[Quản lý Nội dung (Content Manager)](./screens/content-manager.md)**: Trình soạn thảo chi tiết (Item Editor) và các chế độ xem danh sách (Table, Kanban, Cards).
   * **[Bộ dựng mô hình dữ liệu (Collections Builder)](./screens/collections-builder.md)**: Giao diện kéo thả visual để tạo bảng và quản lý quan hệ thực thể.
   * **[Phân quyền & Kiểm soát truy cập (Access Control)](./screens/access-control.md)**: Trình soạn thảo policy trực quan, ma trận quyền và hộp thử nghiệm sandbox.
   * **[Quản lý Tệp tin (File Manager)](./screens/file-manager.md)**: Cây thư mục, lưới tệp tin, trình tải lên trực tiếp và sửa ảnh tích hợp.
   * **[Thiết lập & Tiện ích mở rộng (Settings & Extensions)](./screens/settings-extensions.md)**: Tùy biến thương hiệu, quản lý extensions và chợ ứng dụng Marketplace.
   * **[Tự động hóa luồng (Automation Flows)](./screens/automation.md)**: Bộ thiết kế luồng tự động trực quan (Node-based workflow designer).
