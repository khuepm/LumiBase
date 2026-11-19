---
sourceLang: en
version: 4
lastUpdated: 2026-11-17T19:32:44.376Z
translatedFrom: en
sourceHash: bcf35b8f84e91252
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-17T19:32:44.376Z
codeVerifiedHash: bcf35b8f84e91252
codeVerifiedClaims: 22
---

# Editorial UX

Những tiện ích nhỏ cho người biên tập mà các headless CMS khác đã có và người
biên tập luôn trông đợi: biết item được xuất bản lần đầu khi nào và đã thay đổi
kể từ đó chưa, đọc bản nháp lẫn nội dung đang chạy trong một truy vấn, sao chép
một item, và giữ autosave ngoài lịch sử revision. Chúng thuộc epic #668.

## Trạng thái xuất bản

Mỗi item mang ba trường bên cạnh `status`:

| Trường | Ý nghĩa |
|-------|---------|
| `firstPublishedAt` | Gán ở lần xuất bản đầu tiên của item. Các lần xuất bản sau không bao giờ đổi nó. |
| `publishedAt` | Lần xuất bản gần nhất. Gỡ xuất bản vẫn giữ nguyên, nên nó có nghĩa là "xuất bản lần cuối lúc". |
| `hasUnpublishedChanges` | `true` khi dữ liệu của một item đã từng được xuất bản bị sửa; lần xuất bản kế tiếp đặt lại `false`. |

Một lần ghi được tính là **xuất bản** khi item chuyển sang `published`, hoặc khi
body của request gửi rõ `status: "published"` trong lúc item đang live (xuất bản
lại — điều mà nút **Publish** của Studio và một release thực hiện). Lần xuất bản
hẹn giờ của scheduler cũng được tính. Lưu dữ liệu mà không đổi gì (lưu rỗng)
không đặt cũng không xoá cờ, và sửa một bản nháp chưa từng được xuất bản thì
không bao giờ đặt cờ.

Item đã ở trạng thái `published` trước migration `0037_item_publication_state`
được backfill bằng thời điểm xuất bản đã hẹn, hoặc lần cập nhật cuối nếu không
có thời điểm hẹn.

Chỉ liệt kê các item đã bị sửa bằng `?modifiedSincePublish=true`:

```bash
curl "$API/api/v1/items/articles?modifiedSincePublish=true" \
  -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE"
```

Trong Studio, panel bên của trình soạn item hiển thị **First published**, **Last
published** và nhãn **Modified since publish**, còn danh sách collection có nút
bật/tắt **Modified since publish**. GraphQL trả các trường này dưới tên
`_firstPublishedAt`, `_publishedAt` và `_hasUnpublishedChanges` (có gạch dưới để
trường nội dung tên `publishedAt` giữ nguyên tên), và trường danh sách nhận đối
số `modifiedSincePublish: Boolean`.

## Đọc theo cohort xuất bản

`GET /items/:collection` và `GET /items/:collection/:id` nhận
`publicationState`:

| Giá trị | Trả về |
|-------|---------|
| `live` | Item `published` nằm trong khung xuất bản (đã tới `publishAt`, chưa tới `unpublishAt`). |
| `preview` | Item `draft` và `published` — đúng thứ một site preview cần. |
| `all` | Không lọc theo cohort (gồm cả archived). |

Quan hệ lồng nhau được mở rộng bằng `fields=author.*` hoặc `deep` đi theo cùng
cohort, nên một trang live không bao giờ nhúng tác giả đang là bản nháp. Trường
danh sách và `_by_id` của GraphQL nhận cùng đối số (`publicationState: live`), và
các trường quan hệ lồng nhau đi theo nó.

Người gọi ẩn danh và người dùng realm frontend luôn nhận `live`, bất kể yêu cầu
gì: `?publicationState=preview` không thể làm lộ bản nháp ra công chúng. Không
truyền tham số thì không có gì thay đổi — chỉ RBAC quyết định người gọi đọc được
gì, như trước. Giá trị lạ bị từ chối với `400 VALIDATION`.

## Nhân bản (lưu thành bản sao)

`POST /items/:collection/:id/duplicate` tạo một bản sao ở trạng thái **draft**
qua đường tạo item thông thường, nên người gọi cần `read` trên bản gốc và
`create` trên collection, đồng thời validation, hook, revision khởi tạo và change
feed đều áp dụng. Trường người gọi không đọc được thì không được sao chép.

```json
{ "relations": "reference", "translations": true }
```

| Tuỳ chọn | Giá trị | Mặc định | Ý nghĩa |
|--------|--------|---------|---------|
| `relations` | `reference`, `deep`, `none` | `reference` | `reference` sao chép liên kết nhiều-nhiều (bản sao trỏ tới cùng các đích). `deep` sao chép thêm một tầng item con một-nhiều sang bản sao. `none` chỉ sao chép item. Khoá ngoại nhiều-một là dữ liệu thường và luôn được giữ. |
| `translations` | `true` / `false` | `true` | `false` chỉ giữ một locale của mọi trường `translatable-text`. |
| `locale` | mã locale | mặc định của site | Locale được giữ khi `translations` là `false`. |
| `overrides` | object | — | Giá trị trường đặt lên bản sao, áp dụng sau cùng. |

Trường chuỗi duy nhất (`unique: true`) và trường tên `slug` được thêm hậu tố mà
chưa item live nào giữ: `my-post-copy`, rồi `my-post-copy-2`, và cứ thế. Bản sao
của bản sao không bị chồng hậu tố. Giá trị duy nhất khác (số, object) bị bỏ để
bản sao không bị trùng. Collection có khoá chính do người dùng cung cấp sẽ nhận
một id sinh tự động cho bản sao.

Phản hồi là `201 { data: <copy>, meta: { sourceId, related } }`, trong đó
`related` liệt kê id của các item con và dòng junction đã sao chép theo từng
collection, và một mục audit `item_duplicated` ghi lại bản gốc và bản sao. Trong
Studio, nút **Duplicate** ở đầu trình soạn item đưa ra ba chế độ quan hệ và mở
bản sao. Trong danh sách collection, **Duplicate (n)** sao chép mọi item đang
chọn (theo tham chiếu), mỗi item một request, nên mỗi bản sao có kiểm tra quyền,
revision và mục audit riêng; một bản sao thất bại không chặn các bản còn lại và
được báo cạnh nút.

## Ghi không tạo revision

Autosave và lần ghi bằng máy có thể bỏ dòng revision bằng
`PATCH /items/:collection/:id?saveRevision=false` (cả `PUT`). Item, activity log,
change feed và realtime vẫn cập nhật như thường; chỉ lịch sử revision bị bỏ qua.
Lần lưu rõ ràng không kèm cờ vẫn ghi revision như trước. Lần ghi do agent thực
hiện luôn ghi revision, bất kể cờ: revision đó là bản ghi provenance của agent.

Trong SDK: `client.items('articles').patchWithoutRevision(id, { data })`.

### Giới hạn lưu revision

Collection có thể giới hạn lịch sử trong meta:

```json
{ "meta": { "revisionRetention": { "maxRevisions": 50, "maxAgeDays": 90 } } }
```

Lượt quét `revision-retention` mỗi giờ (Docker ở phút :23; trên Cloudflare
Workers bằng Cron Trigger hằng giờ) xoá, theo từng item, các revision vượt quá
`maxRevisions` bản mới nhất và các revision cũ hơn `maxAgeDays`. Nó không bao giờ
xoá revision mới nhất của một item, revision đang staged (veto window còn mở),
revision được release ghim, hay revision do agent tạo. Mỗi collection bị xoá dòng
ghi một mục audit `revision_retention_applied`.

## Sắp xếp thủ công

Đặt `meta.manualSort: true` trên một collection để người biên tập tự sắp xếp
item. Khi đó item được liệt kê theo giá trị `sort` (tăng dần, hoà thì theo thời
điểm tạo) mỗi khi request không chỉ định cách sắp xếp khác, item mới được thêm
vào cuối, và delivery API dùng cùng thứ tự khi một section không đặt `orderBy`.

Di chuyển một item bằng `POST /items/:collection/:id/reorder` với một trong các
dạng:

```json
{ "after": "item_a" }
{ "after": null }
{ "before": "item_c" }
```

`after: null` đưa item lên đầu. Mốc là id của item chứ không phải vị trí, nên
dùng được trên mọi trang của một danh sách đã lọc. Giá trị `sort` cách nhau
1024, nên một lần di chuyển thường chỉ ghi đúng item được di chuyển, ở điểm giữa
hai item kề mới. Khi không còn khoảng trống (ví dụ mọi item cũ vẫn ở giá trị mặc
định `0`), collection được đánh số lại một lần theo thứ tự hiện tại, rồi mới áp
dụng lần di chuyển. Lần di chuyển đi qua đường cập nhật thông thường — cần quyền
`update` trên item và quyền ghi `sort` — và không ghi revision. Collection không
bật `manualSort` trả `400 MANUAL_SORT_DISABLED`; đặt một item cạnh chính nó trả
`400 INVALID_REORDER`.

Trong Studio, collection sắp xếp thủ công mở ra theo `sort`, và các dòng có thể
kéo thả: thả phía dưới đích sẽ đặt item sau nó, thả phía trên sẽ đặt trước nó.
SDK có `client.items('menu').reorder(id, { after })`.

## Tóm tắt kiểm tra hợp lệ của release

Trước khi một release xuất bản, mọi item mà nó sẽ xuất bản được kiểm tra đầy đủ
— gồm cả trường bắt buộc và điều kiện form-layout, dựa trên snapshot của revision
được ghim nếu release có ghim. `GET /releases/:id/validate` trả về bản tóm tắt
mà không xuất bản:

```json
{ "data": { "valid": false, "checked": 2, "items": [
  { "collection": "pages", "itemId": "p2",
    "issues": [{ "field": "body", "code": "invalid_type", "message": "Invalid input: expected string, received undefined" }] }
] } }
```

Khi xuất bản, cùng phép kiểm tra này chạy trước. Item không hợp lệ không bao giờ
được xuất bản; outcome của nó là `failed` với lý do `VALIDATION_FAILED` kèm
`issues`. Vì vậy release `all_or_nothing` thất bại toàn bộ khi còn item không hợp
lệ; release `best_effort` vẫn xuất bản các item hợp lệ. Release hẹn giờ đi qua
cùng cổng kiểm tra.

Trong Studio, **Content → Releases** liệt kê các release. **Check** hiển thị bản
tóm tắt; mỗi lỗi liên kết tới trình soạn item với `#field=<name>`, cuộn tới
trường, focus và làm nổi bật nó. **Publish** bị vô hiệu khi lần kiểm tra gần
nhất còn lỗi. Trường nằm trong một tab form-layout chưa mở sẽ không được focus
tự động — hãy mở tab đó.

## So sánh revision

`GET /items/:collection/:id/revisions/compare?from=&to=` so sánh hai snapshot
bất kỳ của một item: `from` là id của một revision hoặc `empty` (trạng thái
trước khi item tồn tại, mặc định), `to` là id của một revision hoặc `current`
(item đang live, mặc định). Người gọi cần quyền `read` trên item; cả hai phía
được giải mã và che theo quyền đọc trường của người gọi, đúng như một lần đọc
thông thường, nên phép so sánh không bao giờ hiện trường mà chính item sẽ ẩn.
Phản hồi là `{ data: { from, to, before, after, changes } }`, trong đó
`from`/`to` cho biết các revision (`null` cho empty, `"current"` cho item live)
và `changes` là danh sách theo từng trường (`added`, `removed`, `changed`,
`unchanged`).

`POST /items/:collection/:id/revisions/:revisionId/restore` đặt các trường trở
lại giá trị của chúng trong revision đó. Với `{ "fields": ["title"] }` chỉ các
trường đó thay đổi; với body rỗng mọi trường của snapshot được khôi phục. Trường
mà revision chưa có được khôi phục thành `null`, và tên trường lạ trả
`400 UNKNOWN_FIELD`. Việc khôi phục là một lần cập nhật thông thường, nên
validation, pin Law Zero, hook và quyền đều áp dụng, và nó ghi một revision mới
mang provenance của người gọi (không có gì trong lịch sử bị viết lại).

Trong Studio, tab **Revisions** của item có chế độ **Compare**: chọn snapshot
**From** và **To**, mọi trường hiện cạnh nhau theo dạng giá trị — văn bản theo
từng từ, danh sách id hoặc tag theo phần tử thêm và bớt, object và block theo
các đường dẫn lá đã đổi. Khi **From** là một revision, mỗi trường đã đổi có nút
**Restore**. Phép so sánh ở tab **Versions** dùng cùng cách hiển thị. SDK có
`items(name).compareRevisions(id, { from, to })` và
`items(name).restoreRevisionFields(id, revisionId, fields?)`.

## Tóm tắt API

| Method | Path | Ghi chú |
|--------|------|-------|
| `GET` | `/api/v1/items/:collection?publicationState=&modifiedSincePublish=` | Lọc theo cohort và "đã sửa kể từ khi xuất bản". |
| `GET` | `/api/v1/items/:collection/:id?publicationState=` | `404` khi item nằm ngoài cohort. |
| `PATCH`/`PUT` | `/api/v1/items/:collection/:id?saveRevision=false` | Ghi không tạo revision. |
| `POST` | `/api/v1/items/:collection/:id/duplicate` | Bản sao dạng draft. |
| `POST` | `/api/v1/items/:collection/:id/reorder` | Sắp xếp thủ công. |
| `GET` | `/api/v1/releases/:id/validate` | Tóm tắt kiểm tra hợp lệ của release. |
| `GET` | `/api/v1/items/:collection/:id/revisions/compare?from=&to=` | So sánh hai snapshot. |
| `POST` | `/api/v1/items/:collection/:id/revisions/:revisionId/restore` | Khôi phục trường từ một revision. |

Xem thêm [Content releases](./content-releases.md) và
[tài liệu API](../api/hono-api-spec.md#3-items-generic-crud).
