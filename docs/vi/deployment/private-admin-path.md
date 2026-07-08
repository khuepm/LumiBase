---
version: 1
lastUpdated: 2026-07-05T10:56:36.915Z
sourceLang: en
translatedFrom: en
sourceHash: 79cfea483ac84a02
mtEngine: claude
syncStatus: machine-translated
---

# Đường dẫn Admin riêng tư

Đường dẫn admin riêng tư là điểm vào Studio bí mật được tạo trong quá trình setup, ví dụ `/lumi-7f3a9c`. Nó thay thế các đường dẫn dễ đoán như `/admin` và giảm khả năng bị dò tìm trang đăng nhập tự động.

## Quy tắc bảo mật

- Chỉ lưu đường dẫn admin riêng tư dưới dạng trạng thái phía máy chủ sau khi setup.
- Không để lộ nó qua biến môi trường `VITE_*`, config tĩnh, metadata build, tài liệu công khai, analytics, hoặc các phản hồi API không xác thực.
- Không tự động chuyển hướng các URL công khai hoặc URL setup sang đường dẫn admin riêng tư trong môi trường production.
- Trả về phản hồi kiểu "Not found" dứt khoát cho các route setup đã khởi tạo và các đường dẫn Studio sai, thay vì tiết lộ URL admin đã cấu hình.
- Chỉ hiển thị đường dẫn admin riêng tư cho người vận hành ở cuối quá trình setup hoặc thông qua luồng khôi phục có xác thực.
- Che đường dẫn admin riêng tư trong log và payload audit, trừ khi một đường dẫn chẩn đoán đáng tin cậy thực sự cần đến nó.

## Chính sách chuyển hướng trong Production

Trong production, LumiBase không bao giờ được dùng đường dẫn admin đã lưu làm đích chuyển hướng tiện lợi. Các yêu cầu như `/`, `/setup`, `/setup/*`, hoặc một đường dẫn Studio không phải admin khác không được tự động điều hướng đến `/<private-admin-path>` hoặc `/<private-admin-path>/login`.

Điều này ngăn thanh địa chỉ trình duyệt, referrer, proxy, công cụ giám sát, hoặc ảnh chụp màn hình tiết lộ đường dẫn admin riêng tư trong lúc hoàn tất setup bình thường hoặc khi bị dò xét về sau.

Môi trường phát triển cục bộ có thể giữ các chuyển hướng tiện lợi để tăng tốc kiểm thử. Hành vi mặc định của production là không chuyển hướng.

Đối với các khoảng thời gian setup hoặc debug có kiểm soát, người vận hành có thể chủ động bật bằng cách đặt:

```bash
VITE_LUMIBASE_ALLOW_ADMIN_PATH_REDIRECT=true
```

Hãy xem đây là một tùy chọn ghi đè vận hành tạm thời. Tắt nó lại sau khi setup/debug để production quay về chính sách không chuyển hướng.

## Hướng dẫn cho người vận hành

Sau khi setup, hãy lưu URL đăng nhập admin đầy đủ và các mã dự phòng vào một trình quản lý mật khẩu an toàn. Mất cả đường dẫn admin riêng tư lẫn tài liệu khôi phục sẽ đòi hỏi một luồng khôi phục dành cho người vận hành hoặc sự can thiệp hành chính trực tiếp.
