---
sourceLang: en
version: 4
lastUpdated: 2026-11-15T15:29:22.118Z
translatedFrom: en
sourceHash: d25424a17a2f2579
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T17:02:46.305Z
codeVerifiedHash: d25424a17a2f2579
codeVerifiedClaims: 22
---

# Collection phân cấp

Một collection có thể lưu item dưới dạng **cây**: mỗi item có thể có một item cha
trong cùng collection, và Studio hiển thị collection thành một dàn ý có thể mở
rộng (trang nằm dưới mục, danh mục nằm dưới danh mục, tài liệu nằm trong thư mục).
Di chuyển một item sẽ di chuyển cả cây con của nó. Kết hợp với một policy cấp
`read` và `update` nhưng không cấp `create` hoặc `delete`, cây trở thành một cấu
trúc thư mục cố định mà biên tập viên có thể điền nội dung và sắp xếp lại nhưng
không thể thêm hay bớt ("folder mode").

## Bật tính năng

Đặt `meta.tree` cho collection — trong Studio tại **Data model → collection →
Raw JSON** (schema apply), hoặc qua API collections:

```json
{ "meta": { "tree": { "enabled": true, "maxDepth": 4, "onDelete": "restrict" } } }
```

| Tùy chọn | Giá trị | Mặc định | Ý nghĩa |
|----------|---------|----------|---------|
| `enabled` | `true` / `false` | — (bắt buộc) | Bật hành vi cây. |
| `maxDepth` | số nguyên `1`–`32` | `32` | Cấp sâu nhất được phép; item gốc có độ sâu 1. Được kiểm tra khi tạo và khi di chuyển (với hậu duệ sâu nhất của cây con được di chuyển). |
| `onDelete` | `restrict`, `cascade`, `reparent` | `restrict` | Điều xảy ra khi xóa một item vẫn còn con. Xem [Xóa một item cha](#xóa-một-item-cha). |

Một `meta.tree` không hợp lệ bị từ chối với `400 INVALID_TREE_CONFIG` khi tạo,
cập nhật collection và khi schema apply (`PUT /api/v1/collections/{name}/schema`).
Tắt cây sau đó vẫn giữ nguyên cấu trúc đã lưu; khi đó các endpoint cây trả về
`400 TREE_NOT_ENABLED`.

Các item đã tồn tại trước khi bật cây (và item được ghi bằng bulk create) không có
cha và được đọc như item gốc. Không có bước backfill nào.

## Cách lưu cây

Mỗi dòng item trong `lumibase_items` có thêm hai cột (migration
`packages/database/drizzle/0032_item_tree.sql`):

- `parent_id` — id của item cha, `NULL` với item gốc;
- `path` — chuỗi id được vật chất hóa từ gốc xuống tới chính item đó, ví dụ
  `/root/section/page/`.

Cả hai chỉ do server duy trì; client không bao giờ ghi `path`. Các item con được
sắp theo cột `sort` có sẵn. Mọi thao tác ghi suy ra một path từ path khác (tạo dưới
một cha, di chuyển, xóa kiểu `cascade`/`reparent`) chạy trong một transaction giữ
advisory lock theo từng collection, nên các thao tác di chuyển đồng thời được tuần
tự hóa và không thể làm hỏng cây. Các dòng item do API items trả về có thêm
`parentId` và `path`.

Item cha luôn là một item cùng site và cùng collection. Cột `parent_id` không có
foreign key ở database: mọi thao tác đọc và ghi cây đều tìm item theo cả
`site_id`, `collection_id` và `id`, không bao giờ chỉ theo id, nên cây vẫn đúng
dù id item là duy nhất trên toàn instance hay chỉ duy nhất trong một site. Một id
thuộc site khác trả về `404`, giống hệt một id không tồn tại.

## API

Mọi route nằm dưới `/api/v1/items/{collection}` và cần quyền thông thường của hành
động tương ứng.

### Tạo dưới một item cha

```http
POST /api/v1/items/pages
{ "data": { "title": "Install" }, "parentId": "k3J9x…" }
```

`parentId` là tùy chọn (không có hoặc `null` = item gốc). Item cha phải tồn tại
trong cùng collection và người gọi phải **đọc được** nó, nếu không sẽ trả về `404 PARENT_NOT_FOUND`.
Khi không truyền `sort`, item mới được nối vào sau các item
anh em. `400 TREE_NOT_ENABLED` với collection phẳng, `409 TREE_MAX_DEPTH` khi item
cha đã ở độ sâu `maxDepth`.

### Đọc cây

Endpoint danh sách nhận một chế độ `tree`. Filter, `fields`, `limit`/`offset` và
`status` vẫn áp dụng; khi không có `sort`, thứ tự là thứ tự của cây.

| Query | Trả về | Thứ tự mặc định |
|-------|--------|-----------------|
| `?tree=children&parent={id}` | Các con trực tiếp của `{id}`. `parent` không có, rỗng hoặc `null` = các item gốc. | `sort`, sau đó thời điểm tạo |
| `?tree=subtree&parent={id}` | Mọi hậu duệ của `{id}` (không gồm `{id}`). Không có `parent`: toàn bộ cây. | độ sâu, sau đó `sort` |
| `?tree=ancestors&node={id}` | Các tổ tiên của `{id}`, gốc trước. | độ sâu |

```http
GET /api/v1/items/pages?tree=children&parent=null
GET /api/v1/items/pages?tree=subtree&parent=k3J9x…&fields=title
GET /api/v1/items/pages?tree=ancestors&node=Zp0q…
```

Một query cây sai dạng (`tree=ancestors` thiếu `node`, có `parent` mà thiếu `tree`)
trả về `400 VALIDATION`.

### Di chuyển một cây con

```http
POST /api/v1/items/pages/{id}/move
{ "parentId": "k3J9x…", "position": 0 }
```

- `parentId` — item cha mới, hoặc `null` để biến item thành item gốc.
- `position` — chỉ số (tính từ 0) tùy chọn trong số các item anh em mới. Các item
  anh em được đánh số lại `0..n-1` (chỉ `sort` của chúng thay đổi). Nếu không có,
  item giữ nguyên `sort` khi cha không đổi và được nối vào cuối trong trường hợp
  còn lại.

Sắp xếp lại trong cùng một cha là một lần di chuyển tới chính cha đó kèm
`position`. Path của toàn bộ cây con được viết lại trong cùng transaction. Phản hồi:

| Status | Code | Khi nào |
|--------|------|---------|
| `200` | — | `{ "data": { "id", "parentId", "path", "sort" } }` |
| `404` | `NOT_FOUND` | Item không tồn tại hoặc rule `update` của người gọi không khớp với nó. |
| `404` | `PARENT_NOT_FOUND` | Item cha mới không tồn tại hoặc người gọi không đọc được. |
| `409` | `TREE_CYCLE` | Item cha mới là chính item đó hoặc một hậu duệ của nó. |
| `409` | `TREE_MAX_DEPTH` | Item sâu nhất của cây con sẽ vượt quá `maxDepth`. |

Di chuyển cần quyền `update` trên item được di chuyển. Khi có `position`, danh sách
field được phép `update` của người gọi phải bao gồm `sort`.

### Xóa một item cha

`DELETE /api/v1/items/{collection}/{id}` tuân theo `onDelete` của collection:

- `restrict` (mặc định) — bị từ chối với `409 TREE_HAS_CHILDREN` khi item vẫn còn
  hậu duệ chưa bị xóa. Hãy di chuyển hoặc xóa chúng trước.
- `cascade` — item và toàn bộ cây con còn sống bị xóa mềm cùng lúc. Mọi hậu duệ
  cũng phải thỏa rule `delete` của người gọi; nếu có một item không thỏa, không gì
  bị xóa (`403 FORBIDDEN`).
- `reparent` — các con của item được chuyển lên cha của nó (hoặc trở thành gốc) và
  path của cây con của chúng được viết lại.

## Phân quyền và item bị ẩn

Row rule áp dụng cho mọi query cây, nên cây không bao giờ trả về dữ liệu mà người
gọi không thể đọc qua danh sách phẳng:

- điểm neo của query (`parent`, `node`) phải đọc được, nếu không trả về `404` —
  giống hệt câu trả lời cho một id không tồn tại;
- mọi dòng trả về đều thỏa rule `read` của người gọi; một tổ tiên bị ẩn đơn giản là
  không có trong kết quả `ancestors`, và một item bị ẩn không có trong
  `children`/`subtree`;
- không thể dùng một item cha bị ẩn làm đích cho thao tác tạo hay di chuyển
  (`PARENT_NOT_FOUND`).

**Quyết định:** `parentId` và `path` của một item đọc được được trả về như đã lưu,
kể cả khi chúng nêu tên các item mà người gọi không đọc được. Đó là các id không
mang nội dung — không field nào của item bị ẩn bị lộ — và việc che chúng đi sẽ làm
cấu trúc của các item đọc được trở nên không nhất quán. Trong Studio, cây được tải
từng cấp từ các item gốc, nên một item bị ẩn và mọi thứ bên dưới nó sẽ không xuất
hiện ở đó; các hậu duệ như vậy vẫn truy cập được qua chế độ xem bảng nếu chúng đọc
được.

## Folder mode

Mô hình policy vốn đã cấp từng hành động theo collection, nên "folder mode" không
cần thiết lập thêm: cấp cho policy của biên tập viên quyền `read` và `update` trên
collection và bỏ `create` và/hoặc `delete` (**Access → Policies**). Khi đó API trả
về `403 FORBIDDEN` cho tạo/xóa, còn duyệt, chỉnh sửa và di chuyển vẫn hoạt động.
Studio tuân theo cùng permission bundle (`GET /api/v1/permissions/me`):

- không có `create`: không có nút **New item**, không có thao tác **Add child**
  trong cây, và **Import** bị vô hiệu hóa;
- không có `delete`: không có nút **Delete** trong trình chỉnh sửa item;
- không có `update`: cây không có các nút di chuyển / indent / outdent;
- mở rộng cây và mở item luôn hoạt động khi có `read`.

## Studio

Với một collection dạng cây, **Content → collection** mở ở chế độ xem **Tree**
(nút chuyển **Table** hiển thị danh sách phẳng). Mỗi cấp được tải khi được mở rộng.
Khi có `update`, mỗi dòng có **Move up / Move down** (sắp xếp lại giữa các item anh
em), **Indent** (lồng dưới item anh em phía trước) và **Outdent** (lên một cấp, ngay
sau item cha cũ). Khi có `create`, **Add child** mở form tạo item mới với item cha
được điền sẵn.

## Multi-tenancy

Không có gì dùng chung giữa các site. `parent_id` và `path` nằm trên chính các dòng
item của site; mọi thao tác đọc và ghi cây đều được scope theo `site_id` và
collection, nên một id cha thuộc site khác nhận `404 PARENT_NOT_FOUND`. Khoá của
advisory lock chứa site id và collection id, nên các thao tác ghi của các site (hoặc
collection) khác nhau không bao giờ phải chờ nhau. Bộ test DB integration
`apps/cms/src/services/__tests__/item-tree.db.integration.test.ts` kiểm tra cả việc
scope theo site lẫn hành vi di chuyển đồng thời trên PostgreSQL.

## Mã nguồn

- `apps/cms/src/services/tree-service.ts` — kiểm tra cấu hình, các helper path, tree lock.
- `apps/cms/src/services/item-service.ts` — tích hợp tạo/di chuyển/xóa/liệt kê.
- `apps/cms/src/routes/items.ts` — tham số `tree` của danh sách và route move.
- `apps/studio/src/modules/content/tree-view.tsx` — chế độ xem cây của Studio.
