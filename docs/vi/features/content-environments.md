---
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
version: 1
lastUpdated: 2026-11-25T04:00:48.877Z
sourceHash: a70da44e07706725
codeVerified: 2026-11-25T04:00:48.877Z
codeVerifiedHash: a70da44e07706725
codeVerifiedClaims: 14
---

# Content Environments

Một content environment là bản sao cô lập của một site — schema và, nếu bạn
chọn, cả nội dung — nơi bạn có thể thực hiện một thay đổi lớn (đổi tên field,
đổi kiểu, viết lại hàng trăm item theo cấu trúc mới) mà không chạm vào
production. Khi xong việc, bạn promote schema rồi đến nội dung về lại site
gốc, gọi là **origin**.

Environment được theo dõi ở [#853](https://github.com/khuepm/LumiBase/issues/853).
Tính năng ship ở trạng thái dark sau [release flag](./release-flags.md)
`content-environments`: cho tới khi flag được release trên deployment và được
bật cho site, mọi route đều trả `404`.

## Cách hoạt động

Một environment là một **site con** của origin, cùng organization. Mọi thứ vốn
đã cô lập theo site — query, row-level security, cache key, search index — cô
lập luôn environment mà không cần sửa gì. Ba bảng giữ những gì một dòng site
không giữ được (`packages/database/src/schema/environments.ts`, migration
`0045_content_environments`):

| Bảng | Thuộc về | Chứa |
|---|---|---|
| `lumibase_environments` | origin | key, tên, trạng thái, phạm vi nội dung, tiến độ fork |
| `lumibase_environment_lineage` | environment | ánh xạ danh tính từ mỗi dòng đã sao chép tới dòng ở origin, kèm **base**: trạng thái của origin lúc fork hoặc lúc promote gần nhất |
| `lumibase_environment_merge_runs` | origin | mỗi lần promote đã áp dụng, kèm kết quả từng item |

Item giữ nguyên id khi fork (cùng một id ở hai site). Collection, field,
relation, file và folder nhận id mới và được ánh xạ qua lineage.

## Fork

`POST /api/v1/environments` với `{ key, name, contentScope }` tạo site con và
trả `202` với `status: "forking"`. `contentScope` là `{ mode: "none" }` (chỉ
schema), `{ mode: "all" }` hoặc `{ mode: "collections", collections: [...] }`.

Fork chạy theo từng bước dưới một lease ngắn, giống background import: request
chạy những bước đầu, tick mỗi phút chạy tiếp phần còn lại trên cả Docker và
Workers. Mỗi bước idempotent, nên một fork dừng giữa chừng sẽ chạy tiếp mà
không nhân bản dòng nào. Fork thất bại có trạng thái `failed` kèm lý do;
`POST /api/v1/environments/:key/retry` chạy tiếp từ chỗ đã dừng.

Fork sao chép:

- mọi collection, field và relation;
- role, policy và permission — nhưng chỉ người fork trở thành thành viên của
  environment;
- settings, trừ secret và đích gửi ra ngoài (`revalidation.*`, mail, release
  flag, encryption và các key tương tự);
- webhook và flow, ở trạng thái **inactive**, webhook không kèm secret và
  header;
- folder và metadata file: bản sao trỏ tới cùng object storage, nên không byte
  nào bị nhân đôi;
- item của các collection trong phạm vi, giữ nguyên id. Field mã hoá được giải
  mã với ngữ cảnh khoá của origin rồi mã hoá lại cho environment. Tham chiếu
  tới file được ánh xạ sang dòng file của environment; tham chiếu many-to-one
  tới một collection ngoài phạm vi được giữ nguyên và đánh dấu external.

Fork không bao giờ sao chép: API key, session, audit log, revision, agent
memory và trust ledger, release, content version, materialized collection,
pipeline Firebase Sync, subscription Change Feed, deployment, intent và
extension. Không extension nào được bật trong một environment mới.

Giới hạn: `environments.maxPerSite` (mặc định 3) environment mỗi origin, và
`environments.maxItemsPerFork` (mặc định 50 000) item trong phạm vi nội dung.
Vượt giới hạn, fork bị từ chối với `409 ENVIRONMENT_LIMIT_REACHED` hoặc
`409 ENVIRONMENT_TOO_LARGE`. Không thể fork một environment
(`409 ENVIRONMENT_NESTING_UNSUPPORTED`).

## Làm việc trong environment

Trong Studio, **Settings → Environments → Open in Studio** chuyển site đang
dùng sang environment. Một banner hiển thị cố định trên mọi màn hình khi bạn ở
trong environment, kèm nút quay về origin.

Không gì trong environment đi ra thế giới bên ngoài:

- webhook và flow được sao chép ở trạng thái inactive, và flow dispatcher,
  webhook sender của Change Feed, Firebase Sync, ISR revalidation và push
  notification của agent cũng từ chối gửi cho environment, kể cả khi ai đó bật
  chúng lại;
- push notification tắt cho tới khi admin của environment đặt
  `environments.sideEffects.notifications` thành `true`;
- delivery công khai của environment trả `X-Robots-Tag: noindex, nofollow`.

Site con mang một setting của nền tảng, `environment.origin`, mà các kiểm tra
trên đọc. Settings API từ chối ghi hoặc xoá mọi key `environment.*`
(`403 SETTING_RESERVED`).

## Promote schema

`POST /api/v1/environments/:key/promote/schema` với `{ dryRun: true }` trả về
kế hoạch; với `dryRun: false` thì áp dụng.

Các dòng được ghép theo lineage, không theo tên. Với mỗi collection, field và
relation, kế hoạch so ba trạng thái — base, environment hiện tại và origin hiện
tại:

| Origin so với base | Environment so với base | Hành động |
|---|---|---|
| giống | giống | `unchanged` |
| giống | đã đổi | `create`, `update` hoặc `rename` |
| đã đổi | giống | `origin-only` (không làm gì) |
| đã đổi | đã đổi | `conflict` |

Một field đổi tên trong environment được promote là một **rename**, và giá trị
ở origin chuyển sang tên mới. Một số thay đổi bị từ chối kèm lý do (`blocked`):
đổi tên collection, đổi tên field mã hoá, bật hoặc tắt mã hoá của field, và đổi
field mà một relation nằm trên.

Lần áp dụng bị từ chối với `422` cho tới khi:

- mọi conflict có resolution: `resolutions: [{ kind, key, take: "origin" | "environment" }]`
  (`UNRESOLVED_CONFLICTS`);
- thay đổi rủi ro — đổi tên, đổi kiểu, xoá — kèm `confirmRiskyChange: true`
  (`RISKY_CHANGE_UNCONFIRMED`);
- thay đổi kiểu kèm một plan có strategy, ví dụ
  `migrationPlans: { "posts.rating": { "strategy": "cast-integer" } }`
  (`MIGRATION_PLAN_REQUIRED`).

Lần áp dụng chạy trong một transaction trên origin. **Không thể hoàn tác.** Đổi
kiểu cập nhật định nghĩa field; giống mọi thay đổi schema trong LumiBase, nó
không chuyển đổi các giá trị đã lưu.

## Promote nội dung

`POST /api/v1/environments/:key/promote/content` với `{ dryRun, items? }`
promote các item đã đổi trong environment; `items: [{ collection, itemId }]`
giới hạn lần chạy vào các item đó.

Mỗi item được so theo không gian của origin (id file được ánh xạ ngược, giá
trị mã hoá so bằng hash):

| Kết quả | Khi nào |
|---|---|
| `promote` | chỉ environment đã đổi item |
| `create` | item được tạo trong environment; nó được tạo ở origin với **cùng id** |
| `delete` | item đã bị xoá trong environment và origin không đổi nó |
| `conflict` | origin cũng đã đổi item — **nó không bao giờ bị ghi đè** |
| `blocked` | `SCHEMA_NOT_PROMOTED` (promote schema trước) hoặc `DEPENDENCY_NOT_PROMOTED` (nó tham chiếu một item không có ở origin và không nằm trong lần chạy này) |

Mọi lần ghi đi qua chính quyền của bạn ở origin, với validation, editorial
workflow và pinned field của nó, đúng như một lần sửa thường. Mỗi lần cập nhật
gửi kèm version của origin mà kế hoạch dựa vào, nên một lần sửa rơi vào origin
giữa lúc lập kế hoạch và lúc ghi sẽ biến item thành `conflict` thay vì bị mất.
Item mới được tạo theo thứ tự phụ thuộc; hai item mới tham chiếu lẫn nhau được
tạo trước rồi nối sau. File chỉ có trong environment được đăng ký ở origin, trên
cùng object storage.

Thứ được promote là `data` của item. Trạng thái, khung giờ publish và thứ tự
giữ nguyên như ở origin; item được tạo bởi promote nhận trạng thái của
environment thông qua editorial workflow.

Kết quả liệt kê mọi item kèm outcome (`promoted`, `created`, `deleted`,
`conflict`, `skipped`, `failed`, `unchanged`). Revision ghi ở origin nêu rõ
nguồn: `sources: [{ type: "environment", environmentId, mergeRunId }]`. Một lần
chạy dừng giữa chừng có thể chạy lại: item đã áp dụng giờ khớp base mới và
không bị ghi hai lần. Một lần chạy xét tối đa 2 000 item (`truncated: true` nếu
nhiều hơn; chạy lại).

Để đưa một item mà origin cũng đã đổi, hãy sửa trực tiếp ở origin, hoặc fork
một environment mới. Merge ba chiều và hoàn tác content promote được lên kế
hoạch cho phiên bản sau.

## Đồng thời và audit

Một lần promote chuyển environment sang `merging`; trong lúc một promote đang
chạy, mọi promote khác trên cùng origin trả `409 ENVIRONMENT_BUSY`, và xoá
environment đó cũng vậy. Khoá do một promote bị crash để lại sẽ được tiếp quản
sau 15 phút.

Sự kiện audit: `environment_forked`, `environment_deleted`,
`environment_schema_promoted`, `environment_content_promoted`. Metadata mang id
và số đếm, không bao giờ mang nội dung item.

## Ai được làm gì

Mọi route cần một staff user đã đăng nhập và là administrator của site origin.
API key bị từ chối, kể cả khi có `schema:write` (`403 STAFF_USER_REQUIRED`).
Environment luôn được tìm dưới chính site của request; key của site khác trả
`404`. Ở phiên bản này không agent skill nào có thể fork hay promote.

## Xoá

`DELETE /api/v1/environments/:key` xoá site con và mọi thứ trong đó. Origin
không bị chạm tới, và object storage dùng chung với origin không bị xoá.

## Giới hạn của phiên bản này

- Một cấp: không thể fork một environment.
- Content promote là một chiều; merge ba chiều, rebase từ origin và hoàn tác
  đến sau.
- Id file được ánh xạ ở các field có interface `file` hoặc `files`. Id file nằm
  trong rich text hoặc JSON tự do giữ giá trị của origin.
- Object chỉ có trong thư viện media theo tiền tố site (`/media`) không được
  dùng chung với environment.

## Studio

**Settings → Environments** (hiện khi flag đã bật): fork, theo dõi tiến độ, mở,
thử lại, xoá, và xem trước kế hoạch schema và nội dung trước khi áp dụng.

## Tóm tắt API

| Method | Path | Mục đích |
|---|---|---|
| `GET` | `/api/v1/environments` | Liệt kê |
| `POST` | `/api/v1/environments` | Fork (`202`) |
| `GET` | `/api/v1/environments/:key` | Chi tiết kèm `originChanged`, `changedItems`, `truncated` |
| `DELETE` | `/api/v1/environments/:key` | Xoá |
| `POST` | `/api/v1/environments/:key/retry` | Chạy tiếp một fork đã thất bại |
| `POST` | `/api/v1/environments/:key/promote/schema` | Kế hoạch / áp dụng schema |
| `POST` | `/api/v1/environments/:key/promote/content` | Kế hoạch / áp dụng nội dung |
| `GET` | `/api/v1/environments/:key/merge-runs` | Các lần promote đã áp dụng |

Tham chiếu đầy đủ request và lỗi: [API spec](../api/hono-api-spec.md#3d-content-environments-853).
