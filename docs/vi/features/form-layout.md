---
version: 2
lastUpdated: 2026-11-15T11:59:59.297Z
sourceLang: en
translatedFrom: en
sourceHash: 652c956ad412697f
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T11:59:59.297Z
codeVerifiedHash: 652c956ad412697f
codeVerifiedClaims: 24
---

# Bố cục form: Tab, Nhóm và Trường có điều kiện

Form chỉnh sửa item của một collection có thể được sắp xếp thành **tab**, **nhóm** (có thể thu gọn) và **đường phân cách**; bất kỳ node nào trong số đó, hoặc một trường đơn lẻ, đều có thể chỉ hiển thị khi các trường khác mang giá trị nhất định. Bố cục là cấu hình ở cấp schema: được lưu trong `meta.formLayout` của collection, kiểm tra bằng Zod và không cần migration.

Collection chưa có bố cục hiển thị đúng như trước đây. Các trường mà bố cục không đặt vào vẫn hiển thị trong một phần mặc định phía trên bố cục, nên bạn có thể áp dụng bố cục dần dần từng trường.

## Dựng bố cục trong Studio

Mở **Data model → _collection_ → Form layout**.

- **Add tab / Add group / Add divider** tạo node ở cấp cao nhất. Bên trong một container, **+ group** và **+ divider** tạo node lồng bên trong.
- Kéo một trường từ **Unplaced fields** thả vào vùng thả của container (hoặc vùng cấp cao nhất). Không dùng chuột thì chọn qua bộ chọn **Place…** của trường. Đặt một trường đã được đặt sẽ di chuyển nó, nên một trường không bao giờ xuất hiện hai lần.
- Nút **settings** trên mỗi node mở các quy tắc hiển thị, tùy chọn required/giá trị khi ẩn, tùy chọn thu gọn (với nhóm) và bộ chọn **Move to**. Các mũi tên đổi thứ tự giữa các node cùng cấp.
- **Visibility** là một danh sách quy tắc ("hiển thị khi tất cả/bất kỳ quy tắc nào khớp"). Điều kiện cần `not` hoặc lồng nhau thì sửa bằng **Edit as JSON**.
- **Save layout** kiểm tra ngay trên trình duyệt trước (cùng bộ kiểm tra mà server chạy); **Remove layout** đưa collection về form cổ điển.

Các node tab liền nhau tạo thành một dải tab. Trình sửa item hiển thị tab theo chuẩn WAI-ARIA: một điểm dừng tab với `tabindex` luân chuyển (roving), phím Arrow Left/Right (quay vòng), Home và End, `aria-selected`/`aria-controls` trên mỗi tab và `role="tabpanel"` trên panel. Tab chứa trường không hợp lệ hiển thị huy hiệu lỗi kèm số lỗi. Nhóm thu gọn được có `aria-expanded`; đường phân cách hiển thị với `role="separator"`.

## Định dạng bố cục

```json
{
  "version": 1,
  "nodes": [
    {
      "type": "tab", "id": "content", "label": "Content",
      "children": [
        { "type": "field", "field": "title" },
        { "type": "field", "field": "kind" },
        { "type": "divider", "id": "sep", "label": "Link details" },
        {
          "type": "group", "id": "link", "label": "Link",
          "collapsible": true, "collapsed": false,
          "visibleWhen": { "field": "kind", "op": "eq", "value": "link" },
          "skipRequiredWhenHidden": true,
          "children": [{ "type": "field", "field": "url" }]
        }
      ]
    },
    { "type": "tab", "id": "seo", "label": "SEO",
      "children": [{ "type": "field", "field": "seo_title", "hiddenValue": "clear" }] }
  ]
}
```

| Node | Khóa |
|---|---|
| `field` | `field` (khóa trường), `visibleWhen?`, `skipRequiredWhenHidden?`, `hiddenValue?` |
| `tab` | `id`, `label`, `children`, `visibleWhen?`, `skipRequiredWhenHidden?`, `hiddenValue?` |
| `group` | `id`, `label?`, `collapsible?`, `collapsed?`, `children`, `visibleWhen?`, `skipRequiredWhenHidden?`, `hiddenValue?` |
| `divider` | `id`, `label?`, `visibleWhen?` |

Quy tắc kiểm tra (bị từ chối với `INVALID_FORM_LAYOUT`, HTTP 400):

- mỗi trường được đặt **tối đa một lần**, và mỗi trường được đặt phải tồn tại trong collection;
- mọi trường mà điều kiện đọc phải tồn tại, và một trường không thể phụ thuộc vào chính giá trị của nó;
- `id` của node là duy nhất (chữ thường, chữ số, `-`, `_`);
- container lồng tối đa 6 cấp, một bố cục có tối đa 500 node, và một điều kiện tối đa 8 cấp / 64 node;
- khóa lạ và loại node lạ đều bị từ chối (schema `strict`).

Đổi tên một trường sẽ viết lại các vị trí đặt và tham chiếu điều kiện tới nó. Xóa một trường để lại tham chiếu treo: trình sửa item bỏ qua nó, và trình dựng bỏ vị trí đặt đó khi tải (điều kiện đọc trường đã xóa phải được sửa trước lần lưu kế tiếp).

## Điều kiện

`visibleWhen` là một cây khai báo được đánh giá trên giá trị các trường của chính item. Không có `eval`, không có `Function` và không có regex dựng từ cấu hình: đó là dữ liệu được diễn giải bằng một `switch`, và chỉ đọc các khóa riêng của item (không bao giờ đi theo prototype chain).

```json
{ "and": [
  { "field": "type", "op": "in", "value": ["video", "audio"] },
  { "not": { "field": "url", "op": "empty" } }
] }
```

| `op` | `value` | Đúng khi |
|---|---|---|
| `eq` / `neq` | một giá trị vô hướng | bằng / khác nhau tuyệt đối (không ép kiểu; chưa đặt được coi như `null`) |
| `in` / `nin` | mảng | giá trị có / không có trong danh sách (trường nhiều giá trị: chỉ cần giao nhau) |
| `empty` / `nempty` | không có | chưa đặt, `null`, `""`, `[]`, `{}` được coi là rỗng (`0` và `false` thì không) |
| `gt` `lt` `gte` `lte` | số hoặc chuỗi | cả hai vế là số, hoặc cả hai là chuỗi (ngày ISO so sánh đúng thứ tự); khác kiểu thì là false |
| `contains` | một giá trị vô hướng | trường mảng chứa giá trị đó, hoặc trường chuỗi chứa chuỗi con đó |

Toán tử kết hợp: `and` (tất cả, ít nhất một con), `or` (bất kỳ), `not`. Một node bị ẩn khi điều kiện của chính nó là false **hoặc** bất kỳ node cha nào bị ẩn.

Bộ máy đánh giá nằm trong `packages/contracts/src/form-layout/`, và Studio cùng CMS import chung một mã nguồn, nên form ẩn đúng những trường mà server coi là ẩn.

## Trường bắt buộc và giá trị khi ẩn

**Kiểm tra required.** Mặc định, một trường bị điều kiện ẩn vẫn là bắt buộc. Nó chỉ bỏ qua kiểm tra required **khi và chỉ khi** `skipRequiredWhenHidden: true` được đặt trên node trường hoặc kế thừa từ node cha gần nhất có đặt cờ này (một giá trị `false` tường minh ở gần hơn sẽ thắng). Kiểm tra kiểu và quy tắc vẫn chạy trên mọi giá trị mà trường ẩn đang mang. Khi tạo mới, điều kiện đọc dữ liệu được gửi lên; khi cập nhật (`PATCH`), điều kiện đọc item đã lưu gộp với bản vá, nên một bản vá chỉ xóa `url` vẫn được kiểm tra theo `kind` đã lưu.

Studio chạy cùng quy tắc này trước khi lưu và hiển thị lỗi ngay tại trường và trên huy hiệu của tab; lỗi `VALIDATION` từ server cũng được ánh xạ về đúng trường theo cách đó.

**Giá trị cũ (`hiddenValue`).** Khi một trường bị ẩn, giá trị cũ của nó có thể:

- `keep` (mặc định): được lưu nguyên vẹn, nên sẽ hiện lại nếu trường được hiển thị lần nữa;
- `clear`: bị xóa khỏi item khi lưu.

`hiddenValue` kế thừa giống `skipRequiredWhenHidden`. Server áp dụng nó khi tạo mới và ở mọi lần cập nhật có ghi dữ liệu (cập nhật chỉ đổi trạng thái thì không động tới dữ liệu). Giá trị mà quy tắc required vẫn đòi hỏi (bắt buộc, không bỏ qua) không bao giờ bị xóa. Việc xóa là một quy tắc của schema và áp dụng cho bất kỳ ai ghi item, kể cả API key và agent.

Một bố cục đã lưu nhưng không parse được sẽ bị bỏ qua: mọi trường quay về phần mặc định và quy tắc required áp dụng đầy đủ.

## API

| Method | Path | Quyền | Body / phản hồi |
|---|---|---|---|
| `GET` | `/api/v1/collections/:name/form-layout` | `schema:read` | `{ data: { layout: FormLayout \| null } }` |
| `PUT` | `/api/v1/collections/:name/form-layout` | `schema:update` | body `{ layout: FormLayout \| null }` → `{ data: { layout } }` |

`PUT` với `null` sẽ xóa bố cục. Các khóa `meta` khác được giữ nguyên. Ghi `meta.formLayout` qua `PATCH /api/v1/collections/:name` hoặc `PUT /api/v1/collections/:name/schema` cũng chạy cùng bước kiểm tra. SDK cung cấp `client.schema.getFormLayout(name)` và `client.schema.setFormLayout(name, layout)`.

## Multi-tenancy

Bố cục là một khoá trong row của collection (`lumibase_collections`, có `site_id`), nên được cô lập theo site giống phần cấu hình còn lại của collection: mọi lần đọc và ghi đều đi qua `SchemaService`, nơi các truy vấn được giới hạn theo site, và không thêm bảng, cache key hay tài nguyên dùng chung nào. Bộ máy điều kiện là mã dùng chung toàn deployment, không giữ trạng thái. Kiểm chứng bằng các lần tra cứu theo site của `SchemaService` mà endpoint dùng lại (`getCollection`, `listFields`) và bằng `apps/cms/src/services/__tests__/form-layout-schema.test.ts`.

## Mã nguồn

- Bộ máy điều kiện và schema bố cục: `packages/contracts/src/form-layout/condition.ts`, `packages/contracts/src/form-layout/layout.ts`
- Kiểm tra phía server: `apps/cms/src/services/validation.ts`, `apps/cms/src/services/item-service.ts`, `apps/cms/src/services/schema-service.ts`, `apps/cms/src/routes/collections.ts`
- Studio: `apps/studio/src/modules/content/form-layout-renderer.tsx`, `apps/studio/src/modules/data-model/form-layout-tab.tsx`
