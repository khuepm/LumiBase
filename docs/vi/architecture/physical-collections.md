---
version: 1
lastUpdated: 2026-07-28T10:17:05.104Z
sourceLang: en
translatedFrom: en
sourceHash: fee0876eebc40c46
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T10:17:05.104Z
codeVerifiedHash: fee0876eebc40c46
codeVerifiedClaims: 2
---

# Physical và External Collections

Trạng thái: decision record cho Directus Data Model Parity.

## Quyết định

Hoãn các mode collection `physical` và `external` dùng chung cho giai đoạn parity POST-GA8 hiện tại. Giữ `jsonb` làm source of truth mặc định và dùng projection `materialized` làm cầu nối hiệu năng.

Cách này giữ cho thay đổi schema nhanh và khả chuyển giữa runtime Cloudflare và Docker, đồng thời vẫn nói rõ các đánh đổi về storage trong Studio và trong schema diff.

## Contract hiện tại

| Mode | Sở hữu | Source of truth | Ghi ở runtime | Trạng thái hiện tại |
|---|---|---|---|---|
| `jsonb` | Schema logic của LumiBase | `items.data` JSONB | ItemService ghi JSONB | Mặc định, đã triển khai |
| `materialized` | Schema logic của LumiBase cộng projection được quản lý | JSONB | ItemService ghi JSONB, projection refresh riêng | Đã triển khai như tối ưu opt-in |
| `physical` | Table do LumiBase sở hữu | Table vật lý | Ghi dựa trên DDL trong tương lai | Để dành |
| `external` | Chủ sở hữu database/table bên ngoài | Table bên ngoài | Truy cập qua introspect trong tương lai | Để dành |

Schema diff đánh dấu thay đổi `storageMode`, chiến lược primary key, thay đổi field phá huỷ, và topology relation là các thay đổi ảnh hưởng runtime. Studio phơi những rủi ro đó ra trước khi `PUT /collections/:name/schema` áp thay đổi.

## Vì sao hoãn table vật lý

Table vật lý kiểu Directus có giá trị cho tương thích SQL, constraint native của database, và báo cáo từ bên ngoài dễ hơn. Chúng cũng đòi hỏi một engine migration thật, không chỉ là cập nhật schema thuần metadata.

Những mảnh còn thiếu là đáng kể:

- đặt tên table an toàn theo tenant và tránh xung đột;
- chiến lược online DDL cho từng runtime và database adapter;
- rollback cho migration field, relation và index bị lỗi;
- sequence integer và big integer được sinh theo từng collection;
- constraint relation vật lý, junction table, và ngữ nghĩa `onDelete`;
- DDL index/unique theo từng field kèm đường rebuild an toàn;
- định tuyến item API giữa JSONB, projection materialized, table vật lý và table bên ngoài;
- contract typegen/OpenAPI cho hành vi riêng theo storage;
- hành vi backup và disaster recovery cho các table vật lý mà ta sở hữu.

Xuất một engine DDL nửa vời sẽ làm schema apply trông giống Directus hơn nhưng lại tăng nguy cơ migration bị áp nửa chừng. Vì vậy POST-GA8 coi `physical` và `external` là các mode tương lai tường minh, không phải hành vi ẩn.

## Các lựa chọn cách ly tenant

Nếu mode `physical` được triển khai về sau, hãy chọn một trong các pattern sau:

| Lựa chọn | Hình dạng | Ưu | Nhược |
|---|---|---|---|
| Table prefix | `lb_<siteId>_<collection>` | Đơn giản với một schema; chạy được trên phần lớn setup Postgres | Tên dài, grant khó hơn, namespace nhiễu |
| Schema theo site | `<siteId>.<collection>` | Cách ly rõ ràng, dọn dẹp dễ hơn | Cần grant schema và adapter hỗ trợ |
| Table có type dùng chung | Một table cho mỗi hình dạng logic | Hiệu quả với các template lặp lại | Khó map schema custom tuỳ ý |

Mặc định tương lai được khuyến nghị: schema theo site khi runtime/database hỗ trợ, với table prefix làm phương án dự phòng cho môi trường bị hạn chế.

## Quy tắc cho table bên ngoài

Mode `external` nên là read-first cho đến khi tích hợp chứng minh được việc ghi là an toàn.

Các guardrail bắt buộc:

- introspection phải ghi lại định danh table bất biến, primary key, các field nullable và các ứng viên relation;
- LumiBase không được phát DDL phá huỷ cho table bên ngoài;
- `onDelete: cascade` và `set null` phải bị chặn trừ khi chủ sở hữu bên ngoài phơi ra một contract constraint tương thích;
- schema apply phải sinh ra diff nhưng đòi hỏi một migration adapter tường minh để ghi;
- kiểm tra permission vẫn chạy trong LumiBase dù dữ liệu đến từ nguồn bên ngoài.

## Đường migration

1. Giữ các collection do người biên tập tạo ở `jsonb` theo mặc định.
2. Thêm hoặc refresh projection `materialized` cho các đường đọc nóng.
3. Với `physical` trong tương lai, triển khai một planner chuyển schema diff thành các bước DDL trước khi apply bất cứ gì.
4. Yêu cầu output dry-run kèm lock dự kiến, kế hoạch rollback, và các index bị ảnh hưởng.
5. Chỉ khi đó mới cho phép `storageMode: physical` là một migration chạy được, thay vì một badge để dành.

## Tiêu chí chấp nhận cho lần triển khai tương lai

- `schema.diff` bao gồm các bước DDL, rủi ro lock, chiến lược rollback, và các yêu cầu migrate dữ liệu.
- `schema.apply` chạy mọi thay đổi DDL/dữ liệu trong transaction ở nơi được hỗ trợ, và fail closed ở nơi không.
- Item create/update/read/delete định tuyến đúng storage backend mà không đổi ngữ nghĩa permission.
- Typegen phản ánh kiểu primary key vật lý, field được sinh, field nullable, và response có relation được expand.
- Studio hiện badge riêng theo storage và chặn các tổ hợp primary key/index/relation không được hỗ trợ.

Đến khi các tiêu chí này được đáp ứng, `jsonb` và `materialized` là hai mode được hỗ trợ ở production.
