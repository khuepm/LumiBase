---
version: 1
lastUpdated: 2026-08-02T19:09:13.561Z
sourceLang: en
translatedFrom: en
sourceHash: 27831c129c2af649
mtEngine: manual
syncStatus: human-translated
---

# US — CCPA/CPRA & CAN-SPAM

> Các nghĩa vụ chính ở Mỹ liên quan đến CMS/Content OS. Mỹ không có một luật quyền
> riêng tư liên bang duy nhất; chế độ của California là chuẩn mực trên thực tế, kèm
> ngày càng nhiều luật bang khác.
>
> **⚠️ Đây không phải tư vấn pháp lý.** Khả năng áp dụng phụ thuộc doanh thu, khối
> lượng dữ liệu, và việc bạn có "bán"/"chia sẻ" dữ liệu không. Xác nhận ngưỡng với
> luật sư.

## 1. CCPA / CPRA (California)

- **CCPA** — California Consumer Privacy Act, hiệu lực **01/01/2020**.
- **CPRA** — California Privacy Rights Act, sửa đổi CCPA; phần lớn hiệu lực
  **01/01/2023**, thực thi từ **01/07/2023**. Lập ra Cơ quan Bảo vệ Quyền riêng tư
  California (CPPA).

`[Inference]` Khả năng áp dụng bị giới hạn bởi ngưỡng (doanh thu năm, số người tiêu
dùng/hộ gia đình, hoặc tỷ lệ doanh thu từ bán dữ liệu). Một triển khai self-host nhỏ
có thể dưới ngưỡng; cần kiểm chứng với ngưỡng hiện hành.

### Quyền của người tiêu dùng

| Quyền | Yêu cầu |
|-------|---------|
| Biết / truy cập | Tiết lộ nhóm và mục dữ liệu cụ thể được thu thập, nguồn, mục đích, bên nhận. |
| Xoá | Xoá dữ liệu cá nhân theo yêu cầu (có ngoại lệ). |
| Sửa | (CPRA) Sửa dữ liệu cá nhân sai. |
| Opt-out bán/chia sẻ | Cung cấp liên kết **"Do Not Sell or Share My Personal Information"**; tôn trọng tín hiệu opt-out (ví dụ Global Privacy Control). |
| Hạn chế dữ liệu nhạy cảm | (CPRA) Cho phép người dùng hạn chế dùng/tiết lộ dữ liệu nhạy cảm. |
| Không phân biệt đối xử | Không trừng phạt người dùng vì thực hiện quyền. |

### Thông báo & thời hạn

- **Thông báo khi thu thập** tại hoặc trước thời điểm thu thập.
- Phản hồi yêu cầu hợp lệ thường **trong 45 ngày** (có thể gia hạn).
- Trẻ vị thành niên: cần đồng ý **opt-in** để bán/chia sẻ dữ liệu (dưới 16 tuổi).

## 2. Đạo luật CAN-SPAM (email thương mại)

CAN-SPAM (2003) áp dụng cho email thương mại. Yêu cầu cốt lõi:

- **Không tiêu đề gây nhầm lẫn** — "From", "To", thông tin định tuyến và nguồn gốc
  phải chính xác.
- **Không dòng chủ đề gây nhầm lẫn.**
- **Nhận diện thông điệp là quảng cáo** (khi áp dụng).
- **Có địa chỉ bưu chính vật lý hợp lệ.**
- **Cung cấp cơ chế từ chối (unsubscribe) rõ ràng** và **xử lý kịp thời** (luật đặt ra
  một khoảng thời gian sau khi nhận yêu cầu; thường được trích dẫn là 10 ngày làm
  việc).
- **Giám sát bên làm thay bạn** — bạn vẫn chịu trách nhiệm nếu nhà cung cấp gửi thay.

`[Inference]` Với LumiBase, mọi tính năng gửi email (flows, thông báo, chiến dịch) cần
đính kèm liên kết unsubscribe và chặn gửi tới địa chỉ đã từ chối. Đây là khoảng trống
hiện tại — xem [gap-analysis.md](./gap-analysis.md).

## 3. Các luật quyền riêng tư bang khác

`[Unverified]` Ngoài California, nhiều bang đã ban hành luật quyền riêng tư toàn diện
(ví dụ Virginia VCDPA, Colorado CPA, Connecticut, Utah, Texas, và các bang khác), với
ngày hiệu lực so le và danh sách ngày càng tăng. Chúng nhìn chung phản chiếu quyền
truy cập / xoá / sửa / opt-out nhưng khác nhau về ngưỡng, định nghĩa, và opt-out quảng
cáo nhắm mục tiêu/lập hồ sơ. Hãy coi thiết kế theo CCPA/CPRA là chuẩn nền và xác nhận
từng bang cụ thể với luật sư.

## 4. Luật theo ngành & vi phạm dữ liệu

- **Luật thông báo vi phạm dữ liệu của các bang** tồn tại ở cả 50 bang với điều kiện
  kích hoạt và thời hạn khác nhau (`~`).
- `[Unverified]` Quy định theo ngành (HIPAA cho y tế, GLBA cho tài chính, COPPA cho
  trẻ dưới 13 tuổi) có thể áp dụng tuỳ nội dung/người dùng; kiểm chứng nếu liên quan.

## 5. Ý nghĩa với LumiBase

Khoảng trống lớn nhất do Mỹ thúc đẩy là: quy trình **xoá dữ liệu**, cơ chế **opt-out /
"Do Not Sell or Share"** kèm lưu tuỳ chọn, và xử lý **huỷ đăng ký email**. Xem
[gap-analysis.md](./gap-analysis.md).
