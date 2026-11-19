# Requirements — Release Flags & In-app Upgrade

Nguồn: issue [#869](https://github.com/khuepm/LumiBase/issues/869). Mục tiêu của owner: (1) phát triển tính năng và đưa hết vào `main`, nhưng tính năng chỉ chạy trên production khi LumiBase "ra lệnh" mở cờ; (2) có nút Upgrade trong ứng dụng.

## Glossary

- **Release_Flag**: một khai báo trong registry gắn với một đường code; có `stage` (`dark` | `beta` | `ga`), `siteToggle`, `siteDefault`, `owner`, `removeBy`.
- **Release_Gate**: quyết định cấp deployment "tính năng đã phát hành chưa".
- **Release_Manifest**: tài liệu do LumiBase ký Ed25519, liệt kê giá trị Release_Gate cho các flag.
- **Site_Choice**: lựa chọn bật/tắt của admin site cho flag `siteToggle` đã phát hành.

## Requirement 1 — Registry

1. THE CMS SHALL khai báo mọi Release_Flag ở một nơi duy nhất, key có kiểu (key không khai báo không biên dịch).
2. Mỗi flag SHALL có `owner` và `removeBy`; test SHALL fail khi `removeBy` đã qua.
3. Registry sai dạng (key trùng, key/stage/ngày không hợp lệ) SHALL làm lỗi ngay khi import.

## Requirement 2 — Đánh giá

1. Release_Gate SHALL theo thứ tự: `LUMIBASE_RELEASE_FLAGS` → manifest đã chấp nhận → stage mặc định (`ga` = phát hành).
2. Site_Choice SHALL chỉ có hiệu lực khi flag đã phát hành và khai báo `siteToggle`; vắng lựa chọn thì dùng `siteDefault`.
3. Một site SHALL không bật được flag mà Release_Gate đang tắt.
4. Trạng thái SHALL được tính tối đa một lần mỗi request.
5. Route gắn cờ SHALL trả `404 NOT_FOUND` giống route không tồn tại khi cờ tắt.

## Requirement 3 — Manifest

1. Instance SHALL chỉ chấp nhận manifest có chữ ký Ed25519 hợp lệ từ một key trong `LUMIBASE_RELEASE_PUBLIC_KEYS`; không cấu hình key thì từ chối mọi manifest.
2. Instance SHALL từ chối manifest: issued quá 5 phút trong tương lai, quá `notAfter`, sai `audience` (so với `LUMIBASE_INSTANCE_ID`), hoặc không mới hơn manifest đã chấp nhận (chống replay để quay ngược flag). Gửi lại đúng manifest đã chấp nhận là no-op.
3. Việc lưu SHALL nguyên tử ở DB: hai replica ghi đồng thời không thể lưu manifest cũ đè manifest mới.
4. Kênh push: `PUT /api/v1/release-flags/manifest`, chỉ bootstrap admin (người, không API key).
5. Kênh pull: opt-in qua `LUMIBASE_RELEASE_MANIFEST_URL` (https; http chỉ loopback), chạy nền, không chặn request.
6. Lỗi tải hoặc manifest bị từ chối SHALL không làm thay đổi manifest đang hiệu lực.

## Requirement 4 — Site_Choice

1. `PUT /api/v1/release-flags/site` SHALL chỉ cho admin site; từ chối key không tồn tại hoặc không `siteToggle`.
2. Ghi xong SHALL có hiệu lực ở request kế tiếp (xoá cache theo site).
3. Lựa chọn SHALL cô lập theo site.

## Requirement 5 — Nút Upgrade (Part 2, chưa làm)

1. Preflight: phiên bản hiện tại so với đích, `minimumSafeUpgradeVersion`, migration đang chờ, cảnh báo migration, xác nhận đã backup.
2. `POST /system/upgrade` (instance admin, có audit, không API key) kích hoạt deploy hook do operator cấu hình; CMS không tự thay code của chính nó và không được giữ Docker socket.
3. Theo dõi tiến độ bằng `/system/version` tới khi phiên bản đích trả lời; báo lỗi kèm hướng dẫn rollback.
4. Studio: chuyển trang Updates hiện có thành preflight → xác nhận → tiến độ.
