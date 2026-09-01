---
version: 1
lastUpdated: 2026-08-02T19:03:45.645Z
sourceLang: en
translatedFrom: en
sourceHash: 56a986f9e866d80c
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:03:45.645Z
codeVerifiedHash: 56a986f9e866d80c
codeVerifiedClaims: 2
---

# Lộ trình Post-v1

Trạng thái: Đang lập kế hoạch (planning). Không có mục nào trên trang này được lên lịch bắt đầu trước khi phát hành v1.0.0. Danh mục kiểm tra điều kiện phát hành v1 được theo dõi riêng ở issue #212.

Trang này là bản thuyết minh kèm theo cho project board "LumiBase Post-v1 Roadmap". Board giữ danh sách issue và trạng thái của chúng; trang này giữ lý do đằng sau việc sắp xếp thứ tự, và các hiệu chỉnh rút ra từ việc rà soát bốn chủ đề ứng viên đối chiếu với code thay vì đối chiếu với docs.

## Thực trạng của bốn chủ đề

| Chủ đề | Mức độ khác biệt (Differentiation) | Độ chín hiện tại (Maturity today) | Nỗ lực còn lại | Thứ tự | Epic |
| --- | --- | --- | --- | --- | --- |
| GitOps hai chiều | 7.5 | 6 | Cao | 1 | #362 |
| Tương tác MCP | 9.5 | 8.5 | Trung bình | 2 | #361 |
| Change Feed và realtime | 8 | 7 | Trung bình | 3 | #363 |
| Hoàn thiện phân quyền (Authorization) | 6 | 8.5 | Thấp | 4 | #364 |

Mức độ khác biệt được đo lường khi so sánh với Directus, Strapi, Sanity và Contentful. Độ chín là những gì có thể quan sát được trong codebase tại v0.25.0.

## Chủ đề 1 — Tương tác MCP

Đây là tài sản mạnh nhất trong dự án và là chủ đề duy nhất trong số bốn chủ đề mà chất lượng code vượt qua nội dung marketing. Hai bề mặt MCP đã tồn tại, cả hai đều chạy qua cùng một luồng code harness: một điểm cuối Streamable HTTP JSON-RPC tại POST /api/v1/mcp, và một stdio server được đóng gói dưới dạng mcp-server. Bất biến đồng dạng (parity invariant) — rằng một quyết định tools/call phải khớp với quyết định harness trực tiếp — được đảm bảo bởi một property test. Bao quanh đó là cơ chế quản trị (governance) thực sự: các mức tự trị từ L0 đến L4, một sổ bạ tin cậy (trust ledger) nơi việc nâng cấp do con người kiểm soát còn việc hạ cấp là tự động, một hiến pháp có quản lý phiên bản kèm theo hash pinning, một kill switch bốn phạm vi, và một bộ bảo vệ tải (load guard).

Những gì còn thiếu là bề mặt đặc tả (spec surface) chứ không phải độ sâu. Mới chỉ có các công cụ nguyên thủy (tools primitive) được triển khai; chưa có stream do server khởi tạo, khiến việc thay đổi registry công cụ không thể quan sát được cho đến khi client kết nối lại; và xác thực là bearer token thông thường thay vì OAuth 2.1 với metadata tài nguyên được bảo vệ. Lỗ hổng cuối cùng đó là lý do duy nhất LumiBase chưa thể cung cấp như một hosted connector trong các client quan trọng, và đây là mục có giá trị cao nhất trong chủ đề này.

Các issue liên quan: #344, #345, #346, #347.

## Chủ đề 2 — GitOps hai chiều

Các giai đoạn A đến E thực sự đã hoàn thành: sáu bảng git với bảo mật cấp dòng (row-level security), một trừu tượng hóa provider bao phủ GitHub và GitLab, token được mã hóa, webhook được xác minh kèm theo nhật ký sự kiện có tính đẳng trị (idempotent event log), một dashboard kiểm tra pull-request và CI với nhật ký được nạp vào, các status check đảo ngược, và một bản đồ xuất xứ từ commit đến mục lưu trữ.

Tuy nhiên, vòng lặp mới chỉ theo một chiều và dừng ở mức ý định (intent-only). syncFromRepo đọc lumibase/intents.json vào các intent nội dung và thực hiện đối soát; áp dụng schema bị hoãn lại; không có gì ghi ngược từ CMS về kho lưu trữ code; không có gì kích hoạt khi merge vào main; agent git-sync có một role được tạo sẵn nhưng chưa có vòng lặp thực thi; và các môi trường xem trước (preview environment) là tính năng opt-in, mặc định tắt, và được lưu ý là cần xác minh trên staging.

Do đó, mô tả trung thực hiện tại là "xuất cấu hình cộng với nhập ý định", chứ không phải GitOps hai chiều. Lấp đầy khoảng trống đó là khoảng cách lớn nhất giữa tuyên bố và thực tế trong sản phẩm và là điểm đau rõ ràng nhất của nhà phát triển, đó là lý do chủ đề này đứng đầu ngay cả khi điểm khác biệt thô của nó thấp hơn MCP.

Các issue liên quan: #348, #349, #350, #351, #352.

## Chủ đề 3 — Change Feed và realtime

Hợp đồng Change Feed được thiết kế tốt và không nên thay đổi: một transactional outbox, thứ tự hoàn toàn theo từng site trên keyset kết hợp giữa occurred_at và id với độ trễ an toàn hai giây, phân phối ít nhất một lần (at-least-once) với event id đóng vai trò là key đẳng trị, xác nhận chỉ theo chiều tiến (forward-only), phát lại (replay) trong khung thời gian lưu trữ, các lô webhook được ký HMAC với cơ chế lùi thời gian (backoff) và xử lý thư chết (dead-lettering), các subscriber extension trong môi trường cách ly (sandboxed), bảo mật cấp dòng trên cả ba bảng, và một bề mặt OpenAPI cùng SDK đã được lập tài liệu. Việc truy vấn dài (long-polling) và ghi nhận DDL cấp schema đều là thật.

Cần có hai điểm hiệu chỉnh. Thứ nhất, Change Feed không phải là sản phẩm WebSocket. Mặt phẳng realtime là một phân hệ riêng biệt xuất bản trực tiếp từ item service và không mang envelope, cursor hay replay của feed, nên việc mô tả feed như một đăng ký WebSocket realtime là nói quá. Thứ hai, và nghiêm trọng hơn, mặt phẳng realtime chỉ kiểm tra quyền đọc khi client đăng ký. Không có mặt nạ trường (field masking) theo từng subscriber và không có đánh giá lại quy tắc dòng khi fan-out, nghĩa là một trường bị ẩn có thể tới tay một subscriber mà vốn dĩ họ không thấy được qua REST. Đối với một sản phẩm có hệ thống phân quyền là một lợi thế điểm nhấn, đó là mắt xích yếu nhất, và nó cần được xử lý như nợ kỹ thuật về tính đúng đắn (correctness debt) thay vì một tính năng.

Khoảng trống thứ ba ảnh hưởng đến tự lưu trữ (self-hosting): hub fan-out Docker đang nằm trong tiến trình (in-process), nên bất kỳ bản triển khai nào có nhiều hơn một replica đều âm thầm làm rơi sự kiện.

Các issue liên quan: #353, #354, #355.

## Chủ đề 4 — Hoàn thiện phân quyền (Authorization completeness)

Bản phát hành v0.25.0 đã ship realm thứ ba từ ADR-011 và công việc rất vững chắc. Một request chưa xác thực sẽ được phân giải về role public công khai opt-in của site thay vì lỗi 401 hàng loạt, nên các bộ lọc dòng và mặt nạ trường vẫn giữ nguyên hiệu lực; truy cập admin và app được ghim tắt trên role public bằng ràng buộc check constraint; các thao tác đọc bị giới hạn ở GET và HEAD trên các tiền tố nội dung trong danh sách cho phép; và ba lớp phòng thủ chống thâm nhập cache đặt trước Postgres.

Cần lưu ý hai hiệu chỉnh về vị thế của tính năng này. Việc phân tách realm được thực thi bởi role, token audience, ràng buộc check constraint và biên dịch policy ở tầng ứng dụng, chứ không phải bởi bảo mật cấp dòng cơ sở dữ liệu theo từng realm; bảo mật cấp dòng bao phủ sự cô lập giữa các tenant. Và phân quyền cấp trường không phải là tính năng mới ở đây cũng như không phải hoàn toàn dành riêng cho bản doanh nghiệp: luận điểm này đúng khi so sánh với Contentful và Sanity, nhưng Directus đã ship phân quyền cấp trường trong mã nguồn mở.

Những gì còn lại là nhỏ: GraphQL bị loại khỏi realm public vì các thao tác gửi đến qua POST, làm bỏ sót luồng phân phối mà một frontend tự nhiên muốn dùng nhất; cột parentId trên các role gợi ý một sự kế thừa mà bộ đánh giá không bao giờ áp dụng; và việc chuyển đổi từ role-flag sang policy-flag vẫn mới xong một nửa, buộc mỗi bề mặt mới phải sàng lọc hai nguồn để tránh leo thang đặc quyền.

Các issue liên quan: #356, #357, #358.

## Thứ tự thực hiện

Wave 1 làm cho tuyên bố GitOps trở thành sự thật. Wave 2 làm cho MCP server có thể cài đặt được thay vì chỉ có độ sâu. Wave 3 trả nợ tính đúng đắn của realtime. Chạy song song với cả ba, issue #359 theo dõi ứng dụng tham chiếu và benchmark công khai.

Mục cuối cùng đó đáng được nhấn mạnh. Độ rộng của tính năng không còn là rào cản. Kho lưu trữ mã nguồn mới được vài tháng tuổi và đã bao phủ một bề mặt tương đương với một CMS lâu năm, nhưng chưa có bản triển khai công khai nào, chưa có số liệu độ trễ được công bố, và chưa có video walkthrough ghi lại một agent vận hành nội dung từ đầu đến cuối dưới sự giám sát của sổ bạ tin cậy. Mọi tuyên bố nổi bật hiện tại đều phải tin tưởng qua tài liệu. Việc tạo ra bằng chứng đó rẻ hơn bất kỳ công việc tính năng nào ở đây và có khả năng mang lại giá trị cao hơn.

## Quy tắc cơ bản cho lộ trình này

Mỗi issue được viết dựa trên mã nguồn và trích dẫn các file làm căn cứ cho giả định của nó, nên một issue lạc hậu có thể được nhận diện và đóng lại kèm theo link đến commit làm cho nó lạc hậu, thay vì âm thầm sửa đổi. Nếu điểm số của một chủ đề thay đổi, hãy cập nhật bảng trên trang này trong cùng một pull request.

## Tài liệu tham khảo

Project board: LumiBase Post-v1 Roadmap. Milestone: Post-v1. Label: post-v1.

Các tài liệu liên quan: docs/en/mcp/index.md, docs/en/roadmap/git-integration.md, docs/en/features/cdc-change-feed.md, docs/en/architecture/realtime-websocket-implementation.md, docs/en/features/permissions-rbac.md, docs/en/architecture/decisions/adr-011-user-management-realms.md.
