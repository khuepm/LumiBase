# Thoả thuận xử lý dữ liệu (DPA) — Mẫu

> **Khung mẫu** DPA cho trường hợp bạn cung cấp dịch vụ LumiBase được quản lý/hosted
> và đóng vai **bên xử lý (processor)** cho khách hàng (GDPR Điều 28). Điền các trường
> trong ngoặc.
>
> **⚠️ Không phải tư vấn pháp lý và không phải hợp đồng hoàn chỉnh.** Đây là danh sách
> điều khoản khởi đầu. Hãy để luật sư soạn và rà soát hợp đồng ràng buộc trước khi dùng.

## Các bên

- **Bên kiểm soát (Controller):** [Tên pháp lý khách hàng, địa chỉ]
- **Bên xử lý (Processor):** [Tên pháp lý của bạn, địa chỉ]
- **Ngày hiệu lực:** [ngày]

## 1. Đối tượng & thời hạn
Xử lý dữ liệu cá nhân bởi Processor thay mặt Controller trong thời hạn [Hợp đồng dịch
vụ chính].

## 2. Bản chất & mục đích
Vận hành LumiBase Content OS: lưu và phục vụ nội dung, tài khoản người dùng và dữ liệu
vận hành liên quan của Controller.

## 3. Loại dữ liệu & chủ thể dữ liệu
- **Chủ thể dữ liệu:** người dùng cuối, nhân sự, liên hệ của Controller.
- **Loại:** định danh (email, tên, avatar), dữ liệu xác thực, nội dung tự viết, log
  hoạt động/audit, bản ghi consent. Xem [data-map.md](./data-map.md) để có kiểm kê
  cấp field.

## 4. Chỉ thị của Controller
Processor chỉ xử lý dữ liệu cá nhân theo chỉ thị được ghi tài liệu của Controller, kể
cả việc chuyển dữ liệu, trừ khi luật yêu cầu.

## 5. Bảo mật
Nhân sự được phép xử lý dữ liệu bị ràng buộc nghĩa vụ bảo mật.

## 6. Biện pháp an ninh (Điều 32)
Tham chiếu các biện pháp kỹ thuật LumiBase cung cấp: mã hoá AES-256-GCM theo field
(`crypto-service.ts`), cô lập tenant row-level (`rls.ts`), RBAC (`schema/access.ts`),
audit log append-only có mask secret, và kiểm soát retention. Bổ sung mã hoá truyền tải
(TLS) và làm cứng host.

## 7. Bên xử lý phụ (sub-processor)
- Controller cho phép các sub-processor liệt kê trong [Phụ lục A].
- Processor thông báo khi thay đổi và cho phép phản đối.
- Thường gặp: host database, host edge/runtime, SMTP, sink CDC, Firebase sync.

## 8. Hỗ trợ quyền chủ thể dữ liệu
Processor hỗ trợ Controller đáp ứng yêu cầu truy cập, xoá, di chuyển, chỉnh sửa, phản
đối, dùng các endpoint sẵn có (`/me/data-export`, `/admin/erasure`, `/me/consents`).

## 9. Vi phạm dữ liệu cá nhân
Processor thông báo cho Controller không chậm trễ sau khi biết về vi phạm, kèm thông
tin cần cho nghĩa vụ Điều 33/34 của Controller.

## 10. Chuyển dữ liệu quốc tế
Nơi dữ liệu rời EEA, các bên dựa vào [SCCs / adequacy] theo
[data-residency.md](./data-residency.md).

## 11. Xoá hoặc trả lại
Khi chấm dứt, Processor xoá hoặc trả lại dữ liệu cá nhân theo lựa chọn của Controller,
tuỳ thuộc nghĩa vụ lưu giữ theo luật.

## 12. Kiểm toán
Processor cung cấp thông tin cần thiết để chứng minh tuân thủ và cho phép kiểm toán
theo [điều khoản].

---

### Phụ lục A — Sub-processor
| Sub-processor | Dịch vụ | Vị trí |
|---------------|---------|--------|
| [Host DB] | Database | [khu vực] |
| [Edge/host] | Runtime/CDN | [khu vực] |
| [SMTP] | Email | [khu vực] |
