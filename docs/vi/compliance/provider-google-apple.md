# Chính sách nền tảng — Google Play & Apple App Store

> Chính sách app-store là yêu cầu **hợp đồng**: vi phạm có thể khiến ứng dụng bị từ
> chối hoặc gỡ bỏ, độc lập với luật định. Chúng quan trọng với mọi ứng dụng dùng
> LumiBase làm backend và phát hành trên các store này.
>
> **⚠️ Không phải tư vấn pháp lý, và chính sách store thay đổi thường xuyên.** Luôn
> kiểm tra hướng dẫn chính thức hiện hành. Ngày tháng dưới đây gắn nhãn `[Unverified]`
> khi tôi không xác nhận được với nguồn gốc.

## 1. Apple App Store

### 1.1 Xoá tài khoản — Guideline 5.1.1(v)

Ứng dụng hỗ trợ **tạo tài khoản** cũng phải cho phép người dùng **khởi tạo việc xoá
tài khoản ngay trong ứng dụng**. Chỉ vô hiệu hoá hoặc bảo người dùng liên hệ hỗ trợ là
chưa đủ; lối xoá phải tìm thấy được trong ứng dụng. `[Unverified]` Yêu cầu này được
thực thi từ khoảng **30/06/2022**.

`[Inference]` Với ứng dụng dùng LumiBase backend, điều này nghĩa là cần một endpoint
backend thực hiện xoá đầy đủ tài khoản + dữ liệu cá nhân (một khoảng trống hiện tại —
xem [gap-analysis.md](./gap-analysis.md)).

### 1.2 Nhãn quyền riêng tư (Privacy Nutrition Labels)

Trang sản phẩm App Store phải hiển thị **"nhãn dinh dưỡng" quyền riêng tư** khai báo
loại dữ liệu thu thập, có liên kết với người dùng không, và có dùng để theo dõi không.
Khai báo phải khớp hành vi thực tế. `[Unverified]` Bắt buộc từ **tháng 12/2020**.

### 1.3 App Tracking Transparency (ATT)

Trước khi theo dõi người dùng xuyên ứng dụng và website của công ty khác (dùng IDFA
hoặc tương tự), ứng dụng phải xin phép qua prompt **ATT**. `[Unverified]` Thực thi từ
**iOS 14.5 (2021)**.

### 1.4 Sign in with Apple

`[Inference]` Nếu ứng dụng cung cấp đăng nhập bên thứ ba/mạng xã hội (Google/Facebook)
làm lựa chọn duy nhất/chính, nhìn chung phải cung cấp thêm **Sign in with Apple**. Có
ngoại lệ (ví dụ ứng dụng chỉ dùng hệ tài khoản riêng). Kiểm chứng phạm vi hiện hành.

### 1.5 Chính sách quyền riêng tư

Cần có liên kết tới chính sách quyền riêng tư trong metadata ứng dụng và, thường, ngay
trong ứng dụng.

## 2. Google Play

### 2.1 Xoá tài khoản & dữ liệu

Ứng dụng cho phép **tạo tài khoản** phải cung cấp cách để người dùng **yêu cầu xoá tài
khoản và dữ liệu liên quan**, cả **trong ứng dụng và qua một URL web** truy cập được
mà không cần cài lại ứng dụng. `[Unverified]` Yêu cầu xoá tài khoản trong Data safety
được triển khai trong **2023–2024**; kiểm chứng thời hạn và hình thức chính xác hiện
hành.

### 2.2 Mục Data safety

Biểu mẫu **Data safety** trong Play Console yêu cầu khai báo ứng dụng thu thập/chia sẻ
dữ liệu gì, mục đích, thực hành bảo mật, và có thể xoá dữ liệu theo yêu cầu không. Khai
báo phải chính xác và nhất quán với chính sách quyền riêng tư.

### 2.3 Chính sách Dữ liệu người dùng & quyền truy cập

**User Data policy** của Google Play yêu cầu thu thập/sử dụng minh bạch, có chính sách
quyền riêng tư, chỉ xin quyền cần thiết, và phải nổi bật khai báo + đồng ý khi truy cập
dữ liệu nhạy cảm.

## 3. Mẫu số chung cho sản phẩm dùng LumiBase

| Yêu cầu store | Năng lực backend cần có | Trạng thái LumiBase |
|---------------|-------------------------|:-------------------:|
| Xoá tài khoản trong ứng dụng | Endpoint xoá đầy đủ tài khoản + dữ liệu | ❌ (khoảng trống) |
| URL web xoá dữ liệu (Google) | Luồng yêu cầu xoá công khai, có xác thực | ❌ (khoảng trống) |
| Nhãn data-safety/quyền riêng tư chính xác | Bản kiểm kê dữ liệu thu thập & chia sẻ | `~` (cần bản đồ dữ liệu) |
| Liên kết chính sách quyền riêng tư | Đơn vị vận hành cung cấp | n/a (vận hành) |
| Đồng ý theo dõi (ATT) | Tôn trọng lựa chọn theo dõi; không theo dõi khi chưa đồng ý | `~` |

Xem [gap-analysis.md](./gap-analysis.md) và
[implementation-checklist.md](./implementation-checklist.md) cho phần việc backend mà
các chính sách store này hàm ý.
