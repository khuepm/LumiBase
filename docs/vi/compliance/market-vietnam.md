# Việt Nam — PDPD, An ninh mạng & Giấy phép nội dung

> Nghĩa vụ riêng của Việt Nam: bảo vệ dữ liệu cá nhân, nội địa hoá dữ liệu, và chế độ
> giấy phép xuất bản nội dung có thể áp dụng cho một CMS dùng để công bố nội dung công
> khai tại Việt Nam.
>
> **⚠️ Đây không phải tư vấn pháp lý.** Quy định Việt Nam trong lĩnh vực này đang thay
> đổi nhanh. Một số nội dung dưới đây gắn nhãn `[Inference]`/`[Unverified]`; hãy kiểm
> chứng với văn bản gốc tiếng Việt và luật sư trong nước.

## 1. Nghị định bảo vệ dữ liệu cá nhân (PDPD)

- **Nghị định 13/2023/NĐ-CP** về bảo vệ dữ liệu cá nhân, hiệu lực **01/07/2023**.

Khái niệm chính:

- **Dữ liệu cá nhân** chia thành **cơ bản** và **nhạy cảm**, với yêu cầu xử lý chặt
  hơn cho dữ liệu nhạy cảm.
- **Sự đồng ý** là căn cứ trọng yếu: phải được lấy trước khi xử lý, có thể rút lại, và
  chủ thể dữ liệu phải được thông báo mục đích.
- **Quyền của chủ thể dữ liệu** nhìn chung gồm: quyền được biết, đồng ý/rút lại đồng
  ý, truy cập, chỉnh sửa, xoá, hạn chế, phản đối, và khiếu nại/yêu cầu. `[Inference]`
  Các quyền này phản chiếu kiểu GDPR; xác nhận danh sách quyền và ngoại lệ chính xác
  trong văn bản nghị định.
- **Hồ sơ đánh giá tác động xử lý dữ liệu cá nhân (tương đương DPIA)** phải được lập và
  lưu sẵn sàng; trong một số trường hợp hồ sơ được nộp cho cơ quan (Bộ Công an / A05).
  `[Inference]` Xác nhận yêu cầu nộp hồ sơ và thời hạn hiện hành.
- **Chuyển dữ liệu xuyên biên giới** dữ liệu cá nhân của người Việt cần lập hồ sơ đánh
  giá tác động chuyển và có thể phải thông báo/sẵn sàng cung cấp cho cơ quan.
  `[Inference]` Kiểm chứng quy trình hiện hành.

> `[Unverified]` Một văn bản cấp **Luật Bảo vệ dữ liệu cá nhân** đã nằm trong lộ trình
> lập pháp nhằm nâng cấp/thay thế một phần Nghị định 13/2023. Hãy kiểm tra liệu nó đã
> được ban hành chưa và ngày hiệu lực trước khi chỉ dựa vào nghị định.

## 2. An ninh mạng & nội địa hoá dữ liệu

- **Luật An ninh mạng** số 24/2018/QH14, hiệu lực **01/01/2019**.
- **Nghị định 53/2022/NĐ-CP** hướng dẫn Luật An ninh mạng, hiệu lực **01/10/2022** —
  chứa yêu cầu về **nội địa hoá dữ liệu** và hiện diện trong nước với một số nhà cung
  cấp dịch vụ xử lý dữ liệu người dùng Việt Nam. `[Inference]` Phạm vi và điều kiện
  kích hoạt tuỳ loại dịch vụ và dữ liệu; kiểm chứng xem có áp dụng cho một triển khai
  LumiBase cụ thể không.
- **Luật An toàn thông tin mạng** ("ATTTM") số 86/2015/QH13, hiệu lực **01/07/2016** —
  về an toàn thông tin, bảo vệ thông tin cá nhân trên mạng, và nguyên tắc chống thư
  rác.

`[Inference]` Vì LumiBase có thể chạy trên hạ tầng edge phân tán toàn cầu, kỳ vọng
nội địa hoá dữ liệu là mối quan tâm thiết kế cụ thể khi phục vụ người dùng Việt Nam.
Hãy ghi rõ dữ liệu nằm vật lý ở đâu và liệu có bắt buộc lưu trong nước không.

## 3. Xuất bản nội dung & giấy phép

Nếu một triển khai LumiBase được dùng để **công bố nội dung/tin tức công khai tại Việt
Nam**, có thể phát sinh giấy phép lĩnh vực nội dung bên cạnh bảo vệ dữ liệu:

- **Nghị định 147/2024/NĐ-CP** về quản lý, cung cấp, sử dụng dịch vụ Internet và thông
  tin trên mạng (thay thế Nghị định 72/2013/NĐ-CP), `[Unverified]` được đưa tin hiệu
  lực **25/12/2024** — điều chỉnh trang thông tin tổng hợp, mạng xã hội, xác thực tài
  khoản, và nghĩa vụ quản lý nội dung.
- **Luật Báo chí** số 103/2016/QH13 — `[Inference]` áp dụng nếu nội dung là báo
  chí/báo chí; hoạt động báo chí cần giấy phép.
- **Luật Xuất bản** số 19/2012/QH13 — `[Inference]` áp dụng với hoạt động xuất bản
  chính thức.

`[Inference]` Việc có cần giấy phép xuất bản hay không phụ thuộc hoàn toàn vào **nội
dung gì** được công bố và bởi ai — một cơ sở tri thức nội bộ khác với một trang tin
công khai. LumiBase là công cụ; nghĩa vụ giấy phép thuộc về đơn vị vận hành/xuất bản.
Xác nhận với luật sư trong nước loại giấy phép (nếu có) cần cho trường hợp của bạn.

## 4. Ý nghĩa với LumiBase

- Tái sử dụng cùng các khối **xoá / truy cập / đồng ý** đã cần cho GDPR (xem
  [gap-analysis.md](./gap-analysis.md)).
- Bổ sung nhận thức về **data-residency / ghim vùng** cho nghĩa vụ nội địa hoá.
- Cung cấp hướng dẫn cho đơn vị vận hành rằng giấy phép xuất bản là trách nhiệm của
  **đơn vị vận hành**, không phải của nền tảng.
