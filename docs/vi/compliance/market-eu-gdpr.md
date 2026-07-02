# EU — GDPR & ePrivacy

> Các nghĩa vụ tại Liên minh châu Âu / EEA liên quan nhất đến một CMS/Content OS.
>
> **⚠️ Đây không phải tư vấn pháp lý.** Số điều khoản cung cấp để tra cứu. Hãy xác
> nhận khả năng áp dụng (bạn có thể là bên kiểm soát, bên xử lý, hoặc ngoài phạm vi)
> với luật sư.

## 1. Văn bản nguồn

- **GDPR** — Quy định (EU) 2016/679. Có hiệu lực từ **25/05/2018**.
- **Chỉ thị ePrivacy** — Directive 2002/58/EC (sửa đổi bởi 2009/136/EC), nội luật hoá
  qua luật quốc gia; điều chỉnh cookie/theo dõi và tiếp thị điện tử. `[Unverified]`
  Một Quy định ePrivacy thay thế đã được đàm phán nhiều năm; cần kiểm chứng tình
  trạng hiện tại trước khi dựa vào.

## 2. Căn cứ pháp lý để xử lý (Điều 6)

Bạn phải có căn cứ hợp pháp cho mỗi mục đích xử lý. Sáu căn cứ: đồng ý, hợp đồng,
nghĩa vụ pháp lý, lợi ích thiết yếu, nhiệm vụ công, và lợi ích chính đáng. Hãy ghi rõ
căn cứ nào áp dụng cho từng mục đích (đầu vào cho hồ sơ Điều 30 bên dưới).

## 3. Quyền của chủ thể dữ liệu (Điều 12–22)

| Điều | Quyền | Yêu cầu thực tế |
|------|-------|-----------------|
| 12 | Thông tin minh bạch | Phản hồi yêu cầu, thường **trong 1 tháng**, miễn phí. |
| 13–14 | Thông tin khi thu thập | Thông báo quyền riêng tư: mục đích, căn cứ, thời gian lưu, bên nhận, quyền. |
| 15 | Truy cập | Cung cấp bản sao dữ liệu + chi tiết xử lý. |
| 16 | Chỉnh sửa | Sửa/bổ sung dữ liệu. |
| 17 | Xoá ("quyền được lãng quên") | Xoá theo yêu cầu khi không có căn cứ ưu tiên; lan truyền tới bên nhận. |
| 18 | Hạn chế | "Đóng băng" xử lý trong các tình huống xác định. |
| 20 | Di chuyển dữ liệu | Cung cấp dữ liệu ở dạng máy đọc được (căn cứ đồng ý/hợp đồng). |
| 21 | Phản đối | Ngừng xử lý cho tiếp thị trực tiếp (tuyệt đối) và mục đích lợi ích chính đáng. |
| 22 | Quyết định tự động | Quyền không bị áp quyết định hoàn toàn tự động có hệ quả lớn; được con người can thiệp. |

## 4. Đồng ý (Điều 7) và cookie (ePrivacy)

- Đồng ý phải **tự nguyện, cụ thể, được thông báo, rõ ràng**, chứng minh được, và
  **rút lại dễ như khi đồng ý**.
- **Cookie / lưu trữ trên thiết bị:** cookie không thiết yếu và định danh tương tự cần
  đồng ý trước. Banner phải có lối "từ chối" thực sự, ngang tầm với "chấp nhận"; ô tích
  sẵn là không hợp lệ.
- Lưu **hồ sơ đồng ý** (ai, khi nào, được hiển thị gì, đồng ý gì).

## 5. Hồ sơ hoạt động xử lý — ROPA (Điều 30)

Bên kiểm soát/xử lý (trên ngưỡng miễn trừ tổ chức nhỏ) phải duy trì hồ sơ hoạt động xử
lý: mục đích, nhóm dữ liệu/chủ thể, bên nhận, chuyển dữ liệu, thời gian lưu, biện pháp
an ninh. `[Inference]` Audit log và schema của LumiBase có thể cung cấp bằng chứng kỹ
thuật, nhưng bản thân ROPA là một tài liệu tổ chức.

## 6. An ninh & thông báo vi phạm (Điều 32–34)

- **Điều 32** — biện pháp kỹ thuật/tổ chức phù hợp (mã hoá, kiểm soát truy cập, khả
  năng phục hồi, kiểm thử). LumiBase cung cấp một số nguyên thuỷ — xem
  [gap-analysis.md](./gap-analysis.md).
- **Điều 33** — thông báo cơ quan giám sát **không chậm trễ và, khi khả thi, trong 72
  giờ** kể từ khi biết về vi phạm.
- **Điều 34** — thông báo cá nhân bị ảnh hưởng khi rủi ro cao.

## 7. Chuyển dữ liệu quốc tế (Chương V)

Chuyển dữ liệu cá nhân ra ngoài EEA cần một cơ chế chuyển:

- **Quyết định đầy đủ (adequacy)** cho nước đến, hoặc
- **Điều khoản hợp đồng chuẩn (SCCs)** — Quyết định thực thi (EU) 2021/914 — thường
  kèm **đánh giá tác động chuyển dữ liệu**, hoặc
- **Quy tắc doanh nghiệp ràng buộc (BCRs)** cho chuyển nội bộ tập đoàn, hoặc
- một ngoại lệ theo Điều 49.

`[Inference]` Vì LumiBase chạy trên hạ tầng edge (Cloudflare Workers) với các điểm hiện
diện phân tán toàn cầu, vị trí dữ liệu và cơ chế chuyển là mối quan tâm thiết kế thực
tế; hãy ghi rõ dữ liệu cá nhân được lưu/xử lý ở đâu và ghim vùng khi cần. Xác nhận tuỳ
chọn data-residency hiện tại với bên host.

## 8. Bên kiểm soát vs. bên xử lý & DPA (Điều 28)

Khi một bên xử lý dữ liệu cá nhân thay cho bên khác, cần một **Thoả thuận xử lý dữ
liệu (DPA)** quy định phạm vi, an ninh, bên xử lý phụ, và hỗ trợ xử lý yêu cầu của chủ
thể dữ liệu. `[Inference]` Bản LumiBase được host/quản lý sẽ cần một mẫu DPA; bên
self-host thuần thường là bên kiểm soát và có thể không cần.

## 9. Ý nghĩa với LumiBase

Xem [gap-analysis.md](./gap-analysis.md): xoá dữ liệu (Điều 17), truy cập/di chuyển
(Điều 15/20) và đồng ý (Điều 7) là các khoảng trống lớn nhất; audit, cô lập RLS và mã
hoá field hỗ trợ Điều 30/32.
