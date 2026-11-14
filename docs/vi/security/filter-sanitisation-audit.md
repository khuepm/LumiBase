---
version: 2
sourceLang: en
lastUpdated: 2026-11-14T02:05:03.371Z
translatedFrom: en
sourceHash: 3565f2c1a877a259
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T02:05:03.371Z
codeVerifiedHash: 3565f2c1a877a259
codeVerifiedClaims: 12
---

# Kiểm toán làm sạch bộ lọc (oracle trên trường bị ẩn)

Issue #738 (epic #674, S09). Trang này ghi lại cách LumiBase ngăn một caller suy
ra giá trị của trường mà họ không được đọc, thông qua bộ lọc, sắp xếp, mở rộng
quan hệ, biểu thức tìm kiếm hay số đếm. Mỗi vector có trạng thái và test chứng minh.

## Mô hình mối đe dọa

Caller có quyền `read` trên một collection, nhưng whitelist trường của policy ẩn
một số trường: `fields: ['title']`, `fields: ['*', '-salary']`, hoặc role public
với danh sách trường hẹp. Đường đọc đã gỡ trường ẩn khỏi response
(`PermissionService.maskItem`). Nhưng bộ lọc, sắp xếp và biểu thức tìm kiếm được
database hoặc search engine đánh giá trên row đã lưu. Vì vậy nếu không có lớp
chặn, caller vẫn có thể đặt câu hỏi về giá trị bị ẩn:

- **Oracle boolean.** `?filter[salary][_gt]=100000` trả row về hoặc không, và
  `meta.total` vẫn đếm nó. Với `_starts_with`, caller có thể dò ra giá trị từng
  ký tự một.
- **Oracle thứ tự.** `?sort=salary` xếp các row theo thứ tự của giá trị bị ẩn.
- **Oracle tồn tại.** `?filter[secret][_null]=true` cho biết giá trị có được đặt
  hay không.
- **Ký tự đại diện.** `_contains: '%'` khớp mọi row, còn `_` khớp một ký tự bất
  kỳ. Chúng giúp dò nhanh hơn, và còn nới rộng permission rule có giá trị đến từ
  caller (ví dụ `$CURRENT_USER.email` chứa `%`).
- **Quan hệ.** Gom các row con theo khóa ngoại mà caller không được đọc sẽ cho
  thấy row con nào thuộc row cha nào.
- **Tìm kiếm.** Engine khớp `q` với `_title`. `_title` là bản sao của một trường
  item, và trường đó có thể bị ẩn. Tổng số của engine cũng đếm cả những row
  caller không thấy.

## Lớp chặn

`apps/cms/src/services/filter-guard.ts` quyết định **trước khi chạy bất kỳ truy
vấn nào**. Mọi trường được bộ lọc nhắc tới (duyệt qua `_and` / `_or`, xét segment
cấp cao nhất của JSON path có dấu chấm) hoặc được token sắp xếp nhắc tới đều phải
đọc được theo quyền `read` của caller. Cột cấu trúc (`id`, `status`, `sort`,
timestamp, `user_*`) không bao giờ bị che nên luôn được phép. Quyết định chỉ dựa
vào permission và truy vấn, không bao giờ dựa vào dữ liệu, nên bản thân việc từ
chối không thể làm lộ gì:

- Cùng một response cho mọi tập dữ liệu: HTTP **403**, mã `FIELD_FORBIDDEN`.
  Thông báo nêu tên trường mà chính caller đã gửi.
- Không có round-trip tới database, nên không có gì về dữ liệu lộ qua thời gian
  phản hồi.
- Trường không tồn tại bị từ chối y hệt trường bị ẩn, nên caller bị giới hạn
  không thể dùng việc từ chối để dò schema.
- Caller có `fields: ['*']` (hoặc không có permission context: đường nội bộ và
  admin) không bị giới hạn.

`ItemService.list` chạy lớp chặn. REST `GET /items/:collection`, endpoint export,
truy vấn list của GraphQL, đọc item qua MCP / AI và truy cập dữ liệu của
extension đều đi qua đó. Route tìm kiếm áp dụng cùng quy tắc cho chuỗi `filter` /
`sort` của Meili.

## Các vector

| # | Vector | Trạng thái | Test |
|---|---|---|---|
| 1 | `_eq` / `_neq` / `_in` / `_gt`… trên trường ẩn | Đã sửa: `FIELD_FORBIDDEN` trước mọi truy vấn | `filter-sanitisation.property.test.ts` (thuộc tính oracle) |
| 2 | `_contains` / `_starts_with` / `_ends_with` trên trường ẩn | Đã sửa (cùng lớp chặn) | như trên, danh sách hồi quy |
| 3 | `_null` / `_nnull` trên trường ẩn (tồn tại) | Đã sửa (cùng lớp chặn) | như trên |
| 4 | Mệnh đề ẩn lồng trong `_or` / `_and` | Đã sửa: lớp chặn duyệt cùng cây với bộ dựng SQL; độ lồng giới hạn 16 tầng (`INVALID_FILTER`) | như trên, `MAX_FILTER_DEPTH` |
| 5 | JSON path vào trường ẩn (`secret.x`) | Đã sửa: kiểm theo segment cấp cao nhất; `author.name` được phép khi `author` đọc được | như trên |
| 6 | `_json_contains` / `_has_key` trên trường ẩn | Đã sửa (cùng lớp chặn) | như trên |
| 7 | `sort=secret` (oracle thứ tự) | Đã sửa (cùng lớp chặn) | như trên |
| 8 | Phân biệt "bị ẩn" với "không tồn tại" | Không thể: cả hai bị từ chối như nhau | test lớp chặn thuần |
| 9 | `%` / `_` / `\` trong bộ lọc item họ `_contains` | Đã sửa: được escape, khớp theo nghĩa đen | thuộc tính ngữ nghĩa LIKE |
| 10 | Ký tự đại diện trong permission rule (giá trị magic như `$CURRENT_USER.email`) | Đã sửa: SQL nay khớp với bộ đánh giá trong bộ nhớ | thuộc tính tương đương SQL ↔ `evaluate` |
| 11 | `filter` của SCIM so khớp chuỗi con trên e-mail | Đã sửa: được escape (bề mặt chỉ dành cho admin) | n/a (thay đổi một dòng) |
| 12 | SQL injection qua tên trường, JSON path, toán tử, giá trị, sort | Vốn đã an toàn: segment theo allow-list `^[A-Za-z0-9_]+$`, giá trị và khóa được bind làm tham số, toán tử lạ bị từ chối | thuộc tính injection (marker không bao giờ lọt vào text SQL) |
| 13 | Bộ lọc quan hệ `author.secret_field` | Không phải join: khóa có dấu chấm là JSON path trong cùng row và không bao giờ chạm tới collection khác | lớp chặn + #5 |
| 14 | Mở rộng o2m (`fields=comments.*`) khi FK của row con bị ẩn | Đã sửa: mở rộng thành `[]` mà không nạp row con | `o2m expansion yields nothing…` |
| 15 | Mở rộng m2m qua junction mà caller không được đọc | Đã sửa: cần quyền `read` trên junction, áp row rule của nó, và cả hai trường liên kết phải đọc được; nếu không thì `[]` | `m2m expansion yields nothing…` |
| 16 | Mở rộng m2o | Vốn đã an toàn: đọc FK từ row đã được che | các test quan hệ hiện có |
| 17 | Tham số `filter` / `sort` của GraphQL | Đã sửa: cùng đường `ItemService.list` | được #1–#7 bao phủ |
| 18 | Trường o2m của GraphQL khi FK bị ẩn | Đã sửa: trả `[]` cho mọi row cha, không báo lỗi | `schema-builder.test.ts` |
| 19 | Keyset cursor mã hóa giá trị sắp xếp bị ẩn | N/A: item dùng phân trang offset. Export phân trang keyset theo `id` (cột cấu trúc), và cursor của audit log (chỉ admin) mã hóa `(timestamp, id)` | — |
| 20 | Oracle số đếm `meta.total` | An toàn: đếm với cùng WHERE (có cả row rule); bộ lọc trên trường ẩn không bao giờ được chạy | thuộc tính oracle |
| 21 | Aggregate / groupBy | N/A: item không có endpoint aggregate | — |
| 22 | `q` của tìm kiếm khớp `_title` được chép từ trường ẩn | Đã sửa: hit có `_title` đã lưu khác với title suy ra từ các trường đọc được thì bị bỏ | `search-hidden-fields.test.ts` |
| 23 | `totalHits` của tìm kiếm đếm cả row caller không thấy | Đã sửa: caller bị giới hạn nhận số hit thấy được | như trên |
| 24 | `filter` / `sort` của tìm kiếm trên thuộc tính ẩn (hoặc `_title`) | Đã sửa: `FIELD_FORBIDDEN` trước khi gọi engine. Giá trị không đặt trong dấu nháy bị coi là thuộc tính, nên hãy đặt giá trị trong dấu nháy | như trên + thuộc tính về attribute |
| 25 | Mặt nạ tìm kiếm với `['*', '-x']` gỡ hết mọi trường | Đã sửa (tính đúng): loại trừ nay được áp dụng đúng | như trên |
| 26 | Các section trang của `/deliver` | N/A: caller không cung cấp filter hay sort; `orderBy` và `status` lấy từ layout trang do admin soạn | — |
| 27 | Thời gian phản hồi khi từ chối | An toàn: quyết định trước mọi I/O | thuộc tính oracle (không có select nào) |

Các test nằm ở `apps/cms/src/services/__tests__/filter-sanitisation.property.test.ts`,
`apps/cms/src/routes/__tests__/search-hidden-fields.test.ts` và
`apps/cms/src/graphql/__tests__/schema-builder.test.ts`.

## Rủi ro còn lại

- **Cách suy ra title khi tìm kiếm (1 bit).** `_title` lấy từ giá trị không rỗng
  đầu tiên trong `title` / `name` / `label` / `heading` / `slug`, nếu không có thì
  từ trường chuỗi đầu tiên. Nếu một trong các trường đó bị ẩn, việc hit có bị bỏ
  hay không phụ thuộc vào việc trường ẩn đó có rỗng hay không. *Nội dung* trường
  ẩn không bao giờ lộ, nhưng "rỗng hay không" thì có. Muốn đóng hẳn cần sửa phía
  index: trường hiển thị được cấu hình, thuộc tính searchable theo từng trường và
  `attributesToSearchOn` theo role. Việc này được theo dõi trong backlog
  ngoài phạm vi.
- **Row rule trên trường ẩn.** Policy có row rule kiểm tra một trường ẩn
  (`{ salary: { _lt: 1000 } }`) sẽ cho thấy row nào thỏa. Đó là lựa chọn của người
  viết policy, không phải input của caller.

## Quy tắc cho code mới

- Mọi filter, sort, cursor hay aggregate mới do caller cung cấp phải đi qua
  `ItemService.list` hoặc tự gọi `findUnreadableQueryField`, trước khi truy vấn.
- Giá trị họ `_contains` phải đi qua `apps/cms/src/services/like-pattern.ts`, không
  bao giờ ghép thô `'%' + value + '%'`.
- Cursor chỉ được mã hóa cột cấu trúc, hoặc trường caller đọc được, và phải được
  kiểm bằng lớp chặn khi giải mã.
