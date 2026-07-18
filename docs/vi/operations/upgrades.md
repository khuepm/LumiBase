---
version: 1
lastUpdated: 2026-07-11T03:49:05.879Z
sourceLang: en
translatedFrom: en
sourceHash: dc7a160b08b512cb
mtEngine: claude
syncStatus: machine-translated
---

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

## Nâng cấp lên 1.0

`1.0.0` là bản phát hành đầu tiên có cam kết ổn định theo semver (xem [chính sách versioning](#) trong README). Vì nó freeze public surface, đường nâng cấp lên 1.0 phụ thuộc vào version bạn đang chạy. Đọc hết mục này trước khi bắt đầu — một số version nâng cấp tại chỗ được, số khác cần một bước trung gian, và có một dải version không thể migrate tiến lên.

### Các nguồn nâng cấp được hỗ trợ

| Từ | Đường lên 1.0.0 | Ghi chú |
|------|---------------|-------|
| `0.18.x` – `0.21.x` | Trực tiếp. | Table prefix và mô hình RBAC đã khớp 1.0. Chạy [migration checklist](#migration-checklist); không có bước dữ liệu thủ công. |
| `0.6.x` – `0.17.x` | Trực tiếp, **kèm RBAC backfill bên dưới**. | Migration schema là cộng dồn và idempotent. Bước thủ công duy nhất là backfill role→policy (xem [RBAC backfill role→policy](#rbac-backfill-rolepolicy)). |
| Trước `0.17.0` (bảng chưa có prefix) | **Không hỗ trợ nâng cấp tại chỗ.** | Thay đổi table-prefix ở `0.17.x` chỉ áp dụng cho fresh-install. Instance tạo trước `0.17.0` phải export dữ liệu (collections, items, files, roles/policies/permissions, flows, webhooks) và re-import vào một bản `1.0.0` mới. Không có migration tiến lên cho schema chưa prefix. |
| Trước `0.6.0` | Qua một bản trung gian `0.17.x` – `0.21.x` trước. | Nâng lên một bản `0.x` gần đây (bản này áp dụng RBAC backfill và xử lý prefix), verify, rồi nâng lên `1.0.0`. Không nhảy thẳng. |

Xác định version hiện tại qua `/api/v1/system/version` trước khi chọn dòng phù hợp.

### RBAC backfill role→policy

`1.0.0` coi **policy** là nguồn sự thật cho `admin_access` và `app_access` (cùng `enforce_tfa`, IP guard, và time window). Instance có trước mô hình policy lưu các cờ này trên **role**. Trong compatibility window, `PermissionService` vẫn đọc `cờ role OR cờ policy đang active`, nên access không vỡ khi nâng cấp — nhưng trước `1.0.0` bạn nên materialize cờ role legacy thành policy row để riêng lớp policy là authoritative.

Backfill là idempotent và **không** sửa cờ role (chúng giữ nguyên làm mỏ neo rollback). Với mỗi role có `admin_access` hoặc `app_access` bằng true, nó tạo một policy chỉ chứa cờ — key `legacy_role_flags_<role_key>`, tên `Legacy role flags: <role name>`, copy đúng giá trị cờ, với `enforce_tfa=false`, IP guard rỗng, và time window null — rồi attach vào role qua `role_policies`. Hợp đồng đầy đủ và SQL: [Role Flag to Policy Flag Migration](../features/role-policy-flag-migration.md).

Chạy trên staging trước, rồi verify. Post-check phải trả về **không dòng nào** — mọi role mang cờ legacy đều phải có policy tương ứng:

```sql
SELECT r.id, r.site_id, r.name, r.admin_access, r.app_access
FROM lumibase_roles r
WHERE (r.admin_access = true OR r.app_access = true)
AND NOT EXISTS (
  SELECT 1
  FROM lumibase_role_policies rp
  JOIN lumibase_policies p ON p.id = rp.policy_id
  WHERE rp.role_id = r.id
    AND p.admin_access = r.admin_access
    AND p.app_access = r.app_access
);
```

Rồi xác nhận effective access không đổi: role admin legacy vẫn là admin, role chỉ-app legacy vẫn vào được Studio, và role không có app access vẫn không vào được. Bước verify này đã được chạy trên fixture của bản 1.0 và trả về sạch. Cột cờ role vẫn giữ nguyên qua 1.0 để rollback; chúng chỉ được lên lịch xoá ở một bản sau khi `LUMIBASE_RBAC_LEGACY_ROLE_FLAGS=false` đã ship và được verify.

### Rollback từ 1.0

- **Application:** rollback về deployment `0.21.x` trước đó theo [rollback app](#rollback-app). `1.0.0` không thêm thay đổi schema phá huỷ nào so với `0.21.x`, nên app version cũ vẫn tương thích với database 1.0.
- **RBAC backfill:** có thể đảo ngược riêng trong compatibility window — xoá các policy `legacy_role_flags_%` và các dòng `role_policies` của chúng (cờ role không đụng đến, nên access được bảo toàn). Xem [§6 Rollback](../features/role-policy-flag-migration.md#6-rollback).
- **Đường re-import pre-0.17:** không có rollback về schema chưa prefix cũ; giữ instance nguồn chạy read-only cho tới khi bản cài 1.0 được verify.

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
