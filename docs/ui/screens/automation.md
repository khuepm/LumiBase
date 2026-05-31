# Đặc tả Giao diện Tự động hóa Luồng (Automation Flows Spec)

Module Tự động hóa (Automation Flows) cung cấp trình thiết kế quy trình làm việc trực quan (Visual Workflow Designer) dạng sơ đồ khối (Node Canvas). Trình chỉnh sửa cho phép thiết lập các Trigger (Sự kiện kích hoạt) và chuỗi các Action/Operation (Hành động xử lý tiếp theo) tự động.

---

## 1. Màn hình Danh sách Luồng (Flows List - `/automation/flows`)

Hiển thị danh sách các luồng tự động hóa đang hoạt động trong hệ thống dưới dạng lưới thẻ (Grid) trực trực quan.

* **Thẻ thông tin luồng (Flow Card)**:
  * Hiển thị tên luồng (ví dụ: "Gửi tin nhắn Slack khi có đơn hàng mới").
  * Biểu tượng đại diện của sự kiện kích hoạt (ví dụ: biểu tượng Webhook, biểu tượng Lịch biểu Cron, biểu tượng thay đổi Database).
  * Công tắc bật/tắt (Toggle Switch) nhanh trạng thái hoạt động (Active/Inactive) của luồng trực tiếp trên thẻ.
  * Chỉ báo số liệu hiệu suất: Số lần chạy thành công và số lần chạy thất bại trong 24 giờ qua.

---

## 2. Trình thiết kế quy trình trực quan (Visual Flow Designer - `/automation/flows/$id`)

Trình thiết kế dòng công việc là một không gian canvas lớn sử dụng công nghệ kết nối các Node mạng (`@xyflow/react`).

```
┌──────────────────────────────────────────────────────────┐
│ Thiết lập Luồng: Gửi Mail chào mừng       [ Xem lịch sử ] │
├──────────────────────────────────────────────────────────┤
│  [ Trigger: Thêm User mới ]                              │
│              │                                           │
│              ▼                                           │
│     [ Action: Gửi Email ]                                │
│              │                                           │
│              ▼                                           │
│     [ Điều kiện: Thành công? ] ── (Sai) ──> [ Ghi Log ]  │
│              │ (Đúng)                                    │
│              ▼                                           │
│     [ Action: Đổi Role ]                                 │
└──────────────────────────────────────────────────────────┘
```

### 2.1 Loại Node thiết kế (Flow Nodes)
1. **Trigger Node (Nút Kích hoạt - Màu tím)**:
   * **Event-based**: Khi một hàng dữ liệu trong Collection được thêm mới, cập nhật hoặc xóa.
   * **Cron-based**: Kích hoạt theo lịch biểu (ví dụ: 8 giờ sáng mỗi ngày).
   * **Webhook-based**: Kích hoạt khi có một request HTTP POST gửi tới URL được hệ thống cấp riêng cho luồng này.
2. **Operation Node (Nút Hành động - Màu xanh dương)**:
   * **Webhook Request**: Gửi một HTTP request (GET/POST/PUT) tới một dịch vụ bên thứ ba.
   * **Data Mutation**: Tự động tạo mới, cập nhật hoặc xóa một hàng dữ liệu trong bảng khác.
   * **Condition Block (Nhánh điều kiện)**: Chia luồng thành hai nhánh Đúng (True) / Sai (False) dựa trên biểu thức so sánh dữ liệu đầu vào.
   * **AI Copilot Action**: Tự động gửi dữ liệu qua một LLM Agent để tóm tắt văn bản, phân tích tâm lý khách hàng, hoặc dịch thuật trước khi lưu vào DB.

### 2.2 Panel Cấu hình Node (Node Config Drawer)
* Nhấp chuột vào một Node trên Canvas sẽ mở ngăn Drawer trượt từ bên phải ra để cấu hình chi tiết thông số:
  * Ví dụ đối với Nút "Gửi Email": Nhập tiêu đề email, địa chỉ người nhận, và nội dung mail (hỗ trợ kéo thả các biến động lấy từ dữ liệu của Trigger trước đó qua định dạng thẻ Mustache `{{trigger.data.email}}`).
  * Có nút "Chạy thử Node" (Test step) cô lập để kiểm tra kết quả trả về của riêng bước đó.

### 2.3 Nhật ký chạy luồng (Execution History Pane)
* Nhấp vào nút "Xem lịch sử" ở TopBar để mở panel lịch sử chạy luồng ở đáy màn hình.
* Hiển thị danh sách tất cả các lượt chạy trong quá khứ kèm trạng thái (Xanh lá: Thành công, Đỏ: Lỗi).
* Click vào một lượt chạy lỗi sẽ tô đỏ nút (Node) bị lỗi trực tiếp trên Canvas, đồng thời hiển thị log chi tiết dữ liệu Input/Output của bước đó để lập trình viên dễ dàng debug.

---

## 3. Đáp ứng trên Thiết bị Di động (Mobile Spec)
* **Collapse to Sequential Steps**: Trên điện thoại di động, sơ đồ Canvas kéo thả 2D sẽ tự động chuyển đổi thành danh sách các bước dọc tuần tự (Step-by-step Sequential List).
* **Thêm bước đơn giản**: Người dùng không kéo thả nữa mà bấm vào nút dấu cộng `+` giữa các bước để chèn thêm một Nút hành động mới từ danh sách menu chọn sẵn.
* **Cấu hình dạng cuộn**: Bảng thuộc tính của bước (Node Config) sẽ mở rộng toàn màn hình để dễ dàng nhập văn bản và chọn cấu hình bằng tay.
