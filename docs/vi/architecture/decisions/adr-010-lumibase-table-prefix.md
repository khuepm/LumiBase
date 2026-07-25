---
version: 1
lastUpdated: 2026-07-05T10:56:37.304Z
sourceLang: en
translatedFrom: en
sourceHash: aa38dc3991e5b3dd
mtEngine: claude
syncStatus: machine-translated
---

# ADR-010: Tiền tố `lumibase_` cho toàn bộ bảng hệ thống

**Date:** 2026-07-01
**Status:** Accepted

## Context

LumiBase lưu nội dung no-code dưới dạng các hàng JSONB trong một bảng `items` tổng quát, nhưng
tính năng **materialization** của Phase-2 (`apps/cms/src/services/materialize-service.ts`)
tạo động các bảng Postgres *vật lý* được đặt tên theo các collection của người dùng
(`mat_<id>`). Các bảng hệ thống (`users`, `sites`, `items`, `agent_runs`, …) nằm trong
cùng schema `public` mà không có dấu hiệu nào phân biệt bảng do nền tảng sở hữu với
bất kỳ thứ gì mà một tenant có thể gây ra việc tạo. Sự mơ hồ đó là một mối nguy va chạm tiềm ẩn
và mối nguy về suy luận bảo mật: không có một quy tắc duy nhất để trả lời "bảng này
là của chúng ta hay của người dùng?".

Chỉ hai bảng đã mang sẵn tiền tố (`lumibase_firebase_sync_*`), được đặt như một
tiền lệ tự phát mà không có quy ước được ghi lại.

## Decision

Đặt tiền tố `lumibase_` cho **mọi** bảng hệ thống, áp dụng đồng nhất — bao gồm cả
các bảng vốn đã có tiền tố phụ theo ngữ nghĩa (`agent_*`, `ai_*`, `cdc_*` →
`lumibase_agent_*`, `lumibase_ai_*`, `lumibase_cdc_*`). Điều này tạo ra một bất biến:

> Một bảng có tên bắt đầu bằng `lumibase_` là do nền tảng sở hữu. Bất kỳ bảng nào khác
> là do người dùng tạo (hoặc là một materialization `mat_*`).

**Tiền tố tên, không phải một namespace schema Postgres.** Chúng ta giữ mọi bảng trong `public`
và đặt tiền tố cho tên của chúng thay vì chuyển chúng vào một schema `lumibase` riêng
qua `pgSchema()`. Lý do:

- **Không phụ thuộc `search_path`.** LumiBase chạy trên Cloudflare Workers qua
  Hyperdrive (kết nối gộp). Một namespace schema sẽ đòi hỏi một `search_path` đáng tin cậy
  trên mọi kết nối gộp hoặc tên đầy đủ ở khắp nơi;
  một tiền tố tên không có rủi ro nào trong hai điều đó.
- **RLS đơn giản hơn.** File `rls-policies.sql` viết tay định địa chỉ các bảng bằng tên trần
  định dạng `%I`; chỉ danh sách tên thay đổi.
- **Rẻ để đặt lại.** Vì chưa có instance nào được phát hành, toàn bộ lịch sử migration
  có thể được nén lại thành một init duy nhất tạo trực tiếp các bảng có tiền tố
  (xem phần Consequences), thay vì mang theo một bước rename.

**Các literal tên index tường minh được để không tiền tố** (ví dụ `items_data_gin_idx`).
Chúng không phải bảng, nên không nằm trong namespace dễ va chạm; giữ nguyên
các literal hiện có tránh biến động. Tuy nhiên, các tên ràng buộc FK tự động suy ra vẫn mang
tiền tố vì `drizzle-kit` suy chúng ra từ các tên bảng (đã có tiền tố).

## Consequences

- **Đặt lại migration greenfield.** 39 migration cũ cộng với migration rename trung gian
  đã bị loại bỏ và lịch sử được nén lại thành một
  `packages/database/drizzle/0000_lumibase_init.sql` duy nhất, được tái sinh bởi `drizzle-kit
  generate` từ schema (giờ đã có tiền tố). Các bảng được tạo với tên `lumibase_`
  ngay từ đầu — không có bước rename riêng. Đây là một thay đổi **chỉ dành cho cài đặt mới**:
  **không có đường nâng cấp** từ một cơ sở dữ liệu trước-tiền-tố; một DB hiện có
  phải bị hủy và tạo lại. (Được chọn vì chưa có instance nào được triển khai.)
  Bộ chạy migrate bảo vệ điều này: nó so sánh các hash trong
  `drizzle.__drizzle_migrations` với journal cục bộ và từ chối áp dụng lên
  một cơ sở dữ liệu mang lịch sử trước-khi-nén (`FORCE_MIGRATE=true` bỏ qua).
- **Tên dành riêng được thực thi tại API.** Các tên collection bắt đầu bằng `lumibase_`
  hoặc `mat_` bị từ chối (Zod refine trong `routes/collections.ts` + lỗi `RESERVED_NAME`
  trong `SchemaService.ensureName`), giữ nguyên bất biến namespace.
- **Schema giờ là nguồn chân lý hoàn chỉnh.** Ba artifact DDL vốn
  trước đây chỉ được viết tay trong migration — các ràng buộc CHECK của `shares`
  (`max_uses`, `used_count`) và index một phần `agent_approvals_veto_due_idx` —
  đã được thêm vào schema Drizzle (`check()` / `index().where()` một phần), nên
  `generate` tái tạo toàn bộ schema (GIN partial index, mọi index một phần,
  mọi ràng buộc CHECK) không mất mát và không trôi.
- **Snapshot được tái sinh sạch.** Mọi `meta/*_snapshot.json` cũ đã bị loại bỏ và
  một `0000_snapshot.json` mới duy nhất giờ khớp với schema chính xác — `drizzle-kit
  generate` báo "No schema changes". Điều này giải quyết sự trôi trước đó (snapshot đã
  tụt lại ở `0031` trong khi journal ở `0038`).
- **Mã Drizzle ORM không bị ảnh hưởng.** Các export `const` của bảng giữ nguyên tên
  (`export const users = pgTable('lumibase_users', …)`), nên mọi FK `references()`
  và mã truy vấn lan truyền tự động. Các tên ràng buộc FK tự động suy ra giờ
  phản ánh các bảng có tiền tố (ví dụ `lumibase_collections_site_id_lumibase_sites_id_fk`);
  các literal tên index tường minh (ví dụ `items_data_gin_idx`) được giữ nguyên. Các điểm chạm
  Raw-SQL (RLS, script seed, trigger `materialize-service`, đọc setting login-guard,
  các `TRUNCATE` trong integration-test) và các unit test DB-mock switch trên
  `getTableName()` đã được cập nhật bằng tay.
- **Cần áp dụng lại RLS.** Sau init migration, chạy `rls-policies.sql` (nó
  nhắm đến các tên `lumibase_*`). Trong khi cập nhật nó, một lỗi dollar-quote `$$` lồng nhau
  có sẵn trong khối `DO` của nó đã được sửa (tag bên trong đổi thành `$pol$`) để
  script áp dụng được qua `psql`.
