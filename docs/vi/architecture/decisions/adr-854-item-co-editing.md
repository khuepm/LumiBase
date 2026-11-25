---
version: 1
lastUpdated: 2026-11-25T18:14:56.944Z
sourceLang: en
translatedFrom: en
sourceHash: 7e08c2ef9053979c
mtEngine: manual
syncStatus: human-translated
---

# Cùng chỉnh sửa nội dung (#854)

## Quyết định

Dùng Yjs 13.6.27 (MIT) cho trường văn bản định dạng. Mỗi trường có một Y.Doc riêng, định danh theo site, collection, item, phiên bản nội dung và trường. Phạm vi đồng bộ như vậy trùng với phạm vi cấp quyền. Nếu dùng chung tài liệu cho cả item, lịch sử nhị phân có thể lộ giá trị của trường bị ẩn. Với trường đơn, mảng và quan hệ, tiếp tục dùng API ghi có điều kiện. Khi bản lưu đã cũ, Studio giữ bản nháp để người sửa đối chiếu.

OT do máy chủ điều phối đòi hỏi cả hai runtime lưu lịch sử thao tác có thứ tự và biến đổi các thao tác ngoại tuyến. Với Yjs, trình soạn thảo dùng vector trạng thái để trao đổi phần còn thiếu khi kết nối lại. Automerge và Loro cũng hỗ trợ tài liệu có cấu trúc, nhưng phạm vi này chỉ cần chuỗi văn bản định dạng. Studio tải Yjs khi mở trình soạn thảo. Trước khi bật tính năng, đo mức tăng dung lượng nén của Studio và Worker so với nhánh epic. Kèm thông báo giấy phép MIT trong bản phân phối.

## Nguyên mẫu hiện tại

Loại bỏ cursor-protocol.ts, use-cursor.ts và cursor-overlay.tsx khi tích hợp phần thay thế. Giữ thông báo người cùng chỉnh sửa. Từ “ab”, Alice và Bob cùng chèn chữ cái đầu tên mình ở vị trí 1. Khi áp dụng gói thao tác từ xa vào bản cục bộ, Alice nhận “aBAb” còn Bob nhận “aABb”. Việc sắp xếp từng gói trong applyOps() không sắp lại được những thao tác đã áp dụng. Nhận lại gói còn làm ký tự bị chèn hai lần.

## Triển khai và kiểm chứng

- CE2 (#914) ánh xạ cấu trúc văn bản của #695 sang ảnh chụp trường có phiên bản. Ghi thay đổi đã duyệt và phiên bản JSON tương ứng trong cùng giao dịch. Lưu tác giả và định danh thay đổi để gửi lại chỉ tạo một phiên bản.
- CE3 (#915) dùng chung giao thức bắt tay và vector trạng thái cho SiteRoom và node-hub. Khôi phục từ dữ liệu bền vững sau khi khởi động lại.
- CE4 (#916) yêu cầu quyền đọc trường không bị che để tham gia và kiểm tra quyền ghi với từng thay đổi. Kiểm tra trên bản tạm trước khi lưu hoặc phát. Thu hồi phiên khi quyền thay đổi.
- CE5 (#917) gắn trình soạn thảo với trường và dùng vị trí con trỏ tương đối. Kiểm thử hai phiên Studio sửa trực tuyến và ngoại tuyến, sau đó kết nối lại và gửi lại. Hai phiên và JSON lưu trữ phải hội tụ trên Workers và Docker.
- CE6 (#918) tách riêng bản nháp phát hành và phiên bản nội dung. Agent ghi qua bước duyệt và kiểm tra phiên bản hiện có. Khi nguồn khác thay toàn bộ trường, tạo thế hệ tài liệu mới và đưa phần sửa ngoại tuyến cũ ra để người dùng đối chiếu.

Phạm vi này không bao gồm cùng sửa schema, media hoặc thứ tự quan hệ.
