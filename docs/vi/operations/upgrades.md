# Vận hành nâng cấp

Runbook này định nghĩa luồng nâng cấp tối thiểu cho LumiBase trên môi trường Cloudflare-hosted và Docker self-hosted. Hãy xem mỗi lần nâng cấp là một thay đổi vận hành: chọn phiên bản rõ ràng, sao lưu dữ liệu, chạy migration có kiểm soát, xác minh ứng dụng đang chạy và chuẩn bị kế hoạch rollback có giới hạn.

## Chính sách versioning: fixed-version

LumiBase dùng chính sách vận hành **fixed-version** cho nâng cấp production.

- Pin production vào một release channel hoặc một phiên bản bất biến thay vì tự động theo một target thay đổi liên tục mà chưa được duyệt.
- Ghi lại phiên bản app hiện tại, phiên bản app mục tiêu, migration identifier, Docker image digest nếu có, và thời điểm deploy trong change ticket.
- Promote phiên bản theo thứ tự: development, staging, rồi production.
- Tránh trộn app binary và database schema version ngoài compatibility window được ghi trong release note của từng bản phát hành.

## Release channels

Các release channel được hỗ trợ:

| Channel | Ý nghĩa | Khuyến nghị sử dụng |
|---------|---------|---------------------|
| `edge` | Kênh preview thay đổi nhanh, build từ các thay đổi mới nhất đã được chấp nhận. | Chỉ dùng cho development và tích hợp sớm. |
| `latest` | Bản hiện tại được khuyến nghị chung. | Deployment nhỏ, không quá critical, có review trước khi nhận patch mới. |
| `X.Y` | Nhánh minor release, ví dụ `1.4`. | Production fleet muốn nhận patch trong cùng một minor line. |
| `X.Y.Z` | Patch release cố định đầy đủ, ví dụ `1.4.2`. | Production cần deploy tái lập được và phê duyệt thay đổi rõ ràng. |

Ưu tiên `X.Y.Z` cho production có yêu cầu tuân thủ hoặc high availability. Chỉ dùng `X.Y` khi đội ngũ có cổng kiểm thử staging tự động cho patch release mới.

## Luồng nâng cấp Cloudflare-hosted

1. Đọc release notes của phiên bản mục tiêu và xác định thay đổi cần thiết cho environment variable, binding, queue, R2, KV, Hyperdrive, D1/Postgres và migration.
2. Snapshot cấu hình và metadata secrets mà không lộ giá trị secret.
3. Chạy [backup checklist](#backup-checklist).
4. Deploy phiên bản CMS Worker mục tiêu lên staging trước.
5. Chạy [migration checklist](#migration-checklist) trên staging.
6. Kiểm tra endpoint version của app:

   ```bash
   curl -fsS https://<cms-host>/api/v1/system/version
   ```

7. Smoke test authentication, truy cập Studio, đọc/ghi collection, thao tác file, flows/webhooks và realtime nếu bật.
8. Promote cùng fixed release lên production bằng quy trình deploy Cloudflare đã được duyệt.
9. Chạy lại kiểm tra version và smoke test production.
10. Giữ deployment app trước đó sẵn sàng cho đến khi hết rollback window.

## Luồng nâng cấp Docker self-host

1. Đọc release notes của phiên bản mục tiêu và xác nhận compose file, environment variables, volumes và database version đáp ứng yêu cầu của bản mục tiêu.
2. Chạy [backup checklist](#backup-checklist).
3. Pull image CMS mục tiêu:

   ```bash
   docker compose pull cms
   ```

4. Khởi động riêng service CMS bằng image mới:

   ```bash
   docker compose up -d cms
   ```

5. Chạy [migration checklist](#migration-checklist).
6. Kiểm tra endpoint version của app từ host hoặc load balancer:

   ```bash
   curl -fsS http://localhost:1989/api/v1/system/version
   ```

7. Kiểm tra trạng thái container và logs:

   ```bash
   docker compose ps cms
   docker compose logs --tail=200 cms
   ```

8. Smoke test authentication, truy cập Studio, đọc/ghi collection, thao tác file, flows/webhooks và realtime nếu bật.
9. Giữ image tag hoặc digest trước đó trong local cho đến khi hết rollback window.

## Backup checklist

Trước mọi lần nâng cấp, cần lưu đủ trạng thái để khôi phục dịch vụ ngoài đường rollback của ứng dụng:

- Database logical backup, kèm kiểm thử restore cho dataset production-critical.
- Backup object storage hoặc snapshot có versioning cho file upload và generated assets.
- Export cấu hình LumiBase cho collections, fields, roles, policies, permissions, flows, webhooks và extensions.
- Inventory environment variables và platform bindings.
- Phiên bản app hiện tại và phiên bản app mục tiêu.
- Docker image tag và digest hiện tại cho cài đặt self-hosted.
- Cloudflare Worker deployment ID hiện tại cho cài đặt Cloudflare-hosted.
- Nội dung migration history table và danh sách pending migration.
- Logs ứng dụng gần nhất và metrics baseline.

## Migration checklist

Chạy migration có chủ đích và xác minh cả schema lẫn hành vi ứng dụng:

- Đọc release notes để nhận diện migration phá huỷ dữ liệu, chạy lâu hoặc cần thao tác thủ công.
- Xác nhận backup database đã hoàn tất và có thể restore.
- Xác nhận không có pending migration bất ngờ trước khi bắt đầu.
- Chạy migration ở staging trước production.
- Với production, đặt maintenance window nếu migration thay đổi bảng lớn, index, constraint, permissions hoặc dữ liệu theo tenant.
- Apply migration bằng cùng phiên bản ứng dụng sẽ phục vụ traffic.
- Xác minh migration history sau khi hoàn tất.
- Smoke test core reads/writes cho ít nhất một site tenant đại diện.
- Ghi lại migration ID đã apply trong lần nâng cấp.

## Rollback app

Rollback app nghĩa là route traffic về deployment app trước đó trong khi database giữ nguyên trạng thái sau nâng cấp, trừ khi có phê duyệt restore database riêng.

- Cloudflare-hosted: rollback về Worker deployment trước đó hoặc redeploy fixed version trước đó.
- Docker self-host: khởi động lại fixed image tag hoặc digest trước đó.
- Sau rollback, kiểm tra `/api/v1/system/version` và chạy smoke test.
- Xác nhận phiên bản app trước đó tương thích với database schema hiện tại trước khi giữ nó phục vụ traffic.

## Rollback Docker image

Nên dùng tag hoặc digest bất biến khi có thể:

```bash
# Ví dụ: pin compose file hoặc override về image trước đó trước, rồi restart cms.
docker compose up -d cms
curl -fsS http://localhost:1989/api/v1/system/version
```

Nếu image trước đó chưa có ở local, pull đúng tag hoặc digest trước đó trước khi restart:

```bash
docker compose pull cms
docker compose up -d cms
```

Không rollback mù về `latest`; hãy cập nhật image reference trong compose về đúng tag `X.Y.Z` hoặc digest mong muốn trước.

## Giới hạn rollback database

Rollback database có giới hạn và rủi ro cao hơn rollback app.

- LumiBase không giả định mọi migration đều có thể đảo ngược.
- Downgrade migration có thể không tồn tại cho thay đổi schema phá huỷ, data rewrite, backfill hoặc thay đổi permission model.
- Restore database backup có thể làm mất các write phát sinh sau thời điểm backup.
- Chỉ restore database mà không khớp object storage và configuration exports có thể tạo trạng thái không nhất quán.
- Restore database phải được xem là hành động disaster recovery với phê duyệt rõ ràng, write freeze và kiểm tra nhất quán sau restore.
- Ưu tiên forward fix khi database sau nâng cấp vẫn khoẻ và chỉ hành vi ứng dụng cần sửa.
