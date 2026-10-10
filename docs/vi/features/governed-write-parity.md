---
version: 3
lastUpdated: 2026-10-10T03:37:18.452Z
sourceLang: en
translatedFrom: en
sourceHash: 1cb0acffafbc3ac2
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-10T03:37:18.452Z
codeVerifiedHash: 1cb0acffafbc3ac2
codeVerifiedClaims: 8
---

# Đồng bộ kiểm tra thao tác ghi có governance

AI skills dùng cùng kiểm tra ghi với REST cho flow, đăng ký extension tổng quát
và subscription của change feed. Gate capability và duyệt của con người
vẫn nằm trong harness; approval không thay thế validation đầu vào hoặc
quyền tại service.

Các công cụ MCP stdio `create_flow`, `install_extension`, `update_extension` và
`create_cdc_subscription` đi qua harness có quản trị ở chế độ `on` và ở chế độ `auto` khi endpoint quản trị
khả dụng. Hành vi fallback hiện có của `auto` được giữ nguyên.
Ánh xạ CDC giữ nguyên `payload_mode`; contract chuẩn và fixture transport được
kiểm tra cùng nhau để tránh làm mất tham số.

## Flows

`apps/cms/src/services/flow-management.ts` được dùng chung bởi route flow và
skill `createFlow`. Flow active cần graph operation hợp lệ. Trigger
schedule kiểm tra cron, yêu cầu cron khi active và tính `nextRunAt` lúc
tạo. Draft được phép giữ graph chưa hoàn chỉnh. Đường REST PATCH dùng
cùng validator graph và cron trên trạng thái hiệu lực sau khi lưu.

## Extensions

`apps/cms/src/services/extensions-service.ts` xử lý ghi từ cả REST lẫn skill.
Service yêu cầu permission context gắn với tenant, kiểm tra quyền install/enable/configure/
grant_capability/delete tương ứng, áp chính sách chữ ký
và dành namespace `lumibase-*` cho chữ ký chính thức. Trạng thái official và thời điểm
xác minh đến từ verifier, không lấy từ input client. Bật extension official
chưa xác minh sẽ bị từ chối.

Cập nhật bundle/version sẽ xoá module khỏi cache sandbox và đồng bộ subscription
hook với change feed. Đồng bộ subscription vẫn thực hiện theo cơ chế best
effort như đường REST hiện tại. Đăng ký tổng quát vẫn không resolve
slug marketplace hoặc tải provenance marketplace; đây là các contract riêng biệt.

Thao tác extension sau duyệt gắn lại service với permission context hiện tại
của người yêu cầu ban đầu. Thiếu context principal sẽ bị từ chối, kể cả requester
là agent-role không có policy gắn với principal. Quyền người duyệt không được
thay thế quyền người yêu cầu.

## Change feed

Skill `createCdcSubscription` nhận `payload_mode` (`reference` hoặc `snapshot`)
và chuyển tới `SubscriptionService`. Khi dựng harness, cache runtime được truyền
vào và service nhận audit sink. Tạo subscription xoá cờ feed-enabled
đã cache và ghi `cdc_subscription_created`.

## Multi-tenancy và kiểm thử

Chính sách chữ ký và publisher key là cấu hình tin cậy cấp deployment.
Các hàng extension, flow, subscription, audit event và cache key vẫn được cô lập
theo site. Không cần migration, bước wizard hoặc secret mới.

`apps/cms/src/services/__tests__/p2-recovery-parity.db.integration.test.ts` kiểm tra
cả hai transport trên PostgreSQL tạm: từ chối ghi, schedule active, quyền/chữ ký
extension, xoá cache CDC, audit và cô lập hai site. Chạy với
`DATABASE_URL` trỏ tới database dùng riêng cho test, không dùng DB phát triển chung.
