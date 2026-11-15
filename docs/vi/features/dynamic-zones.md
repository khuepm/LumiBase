---
version: 4
lastUpdated: 2026-11-15T12:00:14.900Z
sourceLang: en
translatedFrom: en
sourceHash: 9ff074b239a938f2
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T17:12:00.458Z
codeVerifiedHash: 9ff074b239a938f2
codeVerifiedClaims: 14
---

# Dynamic zones (field `blocks`)

> **Dynamic zone** là một field chứa danh sách block có kiểu và có thứ tự — một hero, rồi một call-to-action, rồi một layout hai cột — trong đó mỗi loại block có schema riêng. Trong LumiBase đó là field type `blocks` (issue #748, epic #676).

## 1. Mô hình

### 1.1 Block template là collection

**Block template** là một collection bình thường của cùng site. Các user field của nó là schema của block, và machine name của nó là `type` của block. Bạn tạo template bằng collection builder như thường; không cần gì thêm. Quy ước hay dùng là đánh dấu các collection template là `hidden` để biên tập viên không tạo item độc lập trong đó.

Dữ liệu block được lưu **inline** trong JSONB `data` của item sở hữu, không phải thành item của collection template. Xoá một page là xoá luôn các block của nó; template không tự giữ row nào.

### 1.2 Định nghĩa field

```json
{
  "name": "sections",
  "type": "blocks",
  "interface": "blocks",
  "options": { "allowedBlocks": ["hero", "cta", "columns"], "min": 1, "max": 20 }
}
```

| Option | Ý nghĩa |
|---|---|
| `allowedBlocks` | Bắt buộc, không rỗng, các machine name collection không trùng nhau. Thứ tự là thứ tự trong picker của Studio và trong GraphQL union. |
| `min` / `max` | Giới hạn số nguyên tuỳ chọn (0–500) cho số block. `min` không được lớn hơn `max`. |

Field blocks có `required` cần ít nhất một block. Field blocks không thể `encrypted`. Định nghĩa được kiểm tra khi tạo hoặc cập nhật field (`INVALID_FIELD_CONFIG`, HTTP 422). Việc template **có tồn tại** hay không được kiểm tra khi ghi item, nên một lần schema apply hoặc config import có thể tạo field trước các collection template của nó.

### 1.3 Giá trị lưu trữ

```json
[
  { "id": "V1StGXR8_Z5jdHi6B-myT", "type": "hero", "data": { "title": "Welcome" } },
  { "id": "Uakgb_J5m9g-0JDMbcJqL", "type": "cta", "data": { "label": "Start", "url": "https://example.com" } }
]
```

- `id` — một nanoid. Bỏ trống ở block mới thì server tự gán; id có sẵn được giữ nguyên, nên block giữ danh tính khi đổi thứ tự. Id phải duy nhất trong một danh sách.
- `type` — tên collection template; đây là discriminator của union ở mọi nơi (REST, GraphQL, type sinh ra).
- `data` — giá trị các field của block, được validate theo template.

## 2. Validation

Mọi thao tác ghi qua `ItemService` (REST, GraphQL mutation, import, agent tool) đều resolve các template có thể với tới và validate từng block bằng đúng validator mà field của collection dùng (`validateItem` trong `apps/cms/src/services/validation.ts`). Phần cài đặt: `apps/cms/src/services/blocks.ts`.

| Đầu vào | Kết quả |
|---|---|
| `null` | Lưu thành `[]` (không bao giờ làm reader crash — lớp lỗi Strapi #26816). |
| thiếu (field tuỳ chọn) | Giữ nguyên là thiếu; GraphQL đọc thành `[]`. |
| `[]` | Chấp nhận, trừ khi field `required` hoặc `min` > 0. |
| `data` của block là `null`/thiếu | Coi như `{}`, sau đó áp các field bắt buộc của template. |
| `type` không nằm trong `allowedBlocks` | Bị từ chối tại `<field>.<i>.type`. |
| collection template không tồn tại | Bị từ chối tại `<field>.<i>.type` (fail closed). |
| thuộc tính block lạ (vd. `__typename`) | Bị từ chối tại `<field>.<i>.<key>`. |
| key lạ bên trong `data` | Bị từ chối tại `<field>.<i>.data.<key>`. |
| giá trị cho field template `encrypted` hoặc `pii`/`phi` | Bị từ chối — mã hoá field chỉ áp dụng cho field cấp cao nhất. |
| `id` trùng hoặc sai định dạng | Bị từ chối tại `<field>.<i>.id`. |

Lỗi **chính xác tới path**: một title sai nằm sâu ba cấp sẽ báo `sections.0.data.items.1.data.title`. Mọi block sai đều được báo, không chỉ block đầu tiên.

Block có thể lồng nhau: một template có thể chứa field `blocks` của riêng nó. Độ lồng giới hạn ở `MAX_BLOCK_DEPTH` = 5 cấp, mỗi danh sách tối đa `MAX_BLOCKS_PER_FIELD` = 500 block, và một lần ghi resolve tối đa 64 template. Template cho phép chính nó (đệ quy) vẫn hợp lệ trong giới hạn độ sâu.

Cập nhật thay thế toàn bộ danh sách: một `PATCH` gửi `sections` là gửi trọn thứ tự mới. Vì vậy đổi thứ tự, chèn và xoá đều chỉ là sửa mảng thông thường.

## 3. Phân quyền và masking

Phân quyền và mask cấp field áp dụng cho **toàn bộ field `blocks` như một khối**: một role hoặc đọc/ghi được `sections`, hoặc không. Phân quyền không được đánh giá theo từng block hay từng field bên trong block, và cờ `hidden`/`readonly` ở cấp template chỉ là gợi ý biên tập. Dữ liệu cần phân quyền riêng hãy đặt ở một field riêng hoặc một relation, không đặt trong block.

## 4. Lọc

Dùng toán tử JSON containment có sẵn để tìm item chứa một block thuộc loại nhất định. Truyền filter dạng JSON (dạng `filter=`; key dạng ngoặc vuông gửi chuỗi chứ không phải mảng), URL-encode khi gửi:

```http
GET /api/v1/items/pages?filter={"sections":{"_json_contains":[{"type":"hero"}]}}
```

Đây là kiểu khớp `_some` theo loại block (cũng có thể khớp theo dữ liệu block, vd. `[{"type":"cta","data":{"label":"Start"}}]`). Không có toán tử `_every`/`_none` theo từng block, và field blocks không sort được.

## 5. GraphQL

Mỗi field blocks trở thành một danh sách non-null của một **union** gồm các object type của block (`apps/cms/src/graphql/schema-builder.ts`):

```graphql
union PagesSectionsBlocks = HeroBlock | CtaBlock | ColumnsBlock

type HeroBlock {
  id: ID!
  type: String!
  _data: JSON
  title: String
  subtitle: String
}
```

- Tên union: `<Collection><Field>Blocks`; tên block type: `<Template>Block`. Tên đã bị type khác dùng sẽ được thêm hậu tố số (`HeroBlock2`).
- Query bằng inline fragment và `__typename`:

```graphql
{ pages { sections { __typename ... on HeroBlock { id title } ... on CtaBlock { label url } } } }
```

- Giá trị `null`/thiếu/rác resolve thành `[]`; block có type không còn trong union (template đã bị xoá) bị bỏ khỏi response thay vì gây lỗi.
- Field mà mọi template được phép đều không còn tồn tại sẽ fallback về scalar `JSON`.

## 6. Type sinh ra và SDK

`GET /api/v1/typegen/schema` liệt kê `allowedBlocks` trên mỗi field blocks, và `generateTypes` sinh discriminated union theo `type`:

```ts
export interface HeroBlockData { title: string; subtitle?: string | null; }
export interface HeroBlock { id: string; type: "hero"; data: HeroBlockData; }

export interface Pages {
  sections?: Array<HeroBlock | CtaBlock> | null;
}
```

`<Template>BlockData` chỉ chứa các user field của template (dữ liệu block không có cột hệ thống). Template không có trong manifest sẽ thành `{ id: string; type: "name"; data: Record<string, unknown> }`. Với code viết tay, SDK export `LumibaseBlock<TType, TData>`.

## 7. Studio

Interface `blocks` (`apps/studio/src/modules/content/interfaces/blocks.tsx`) cung cấp:

- **Thêm** — mỗi loại được phép có một nút; bị vô hiệu khi đã đạt `max`.
- **Xoá**, **thu gọn/mở rộng** (`aria-expanded`), và **đổi thứ tự** bằng cách kéo tay nắm, bằng bàn phím trên tay nắm (Space để nhấc, phím mũi tên để di chuyển, Space để thả), hoặc bằng nút Move up / Move down. Thay đổi được thông báo qua một live region dạng polite.
- Form theo từng block, dựng từ các field của template bằng interface registry thông thường, nên field blocks lồng nhau hiển thị cùng editor.

Cấu hình `allowedBlocks`/`min`/`max` trong JSON **Interface options** của field inspector. Block thuộc loại không còn được phép vẫn hiển thị kèm cảnh báo thay vì bị lặng lẽ bỏ đi.

## 8. Multi-tenancy

- **Cô lập theo site:** block template là collection của site, được resolve qua `SchemaService.getCompiled` gắn site của request, nên một mục trong `allowedBlocks` không bao giờ chạm tới collection của site khác — tên không tồn tại trong site chỉ đơn giản làm validation thất bại. Dữ liệu block nằm trong chính các row item của site (`site_id`), sau cùng các lớp RLS và kiểm tra quyền như mọi field.
- **Dùng chung:** chỉ có mã — validator, GraphQL builder và các giới hạn ở trên. Không có bảng, cache key hay setting mới.
- **Cách kiểm:** `apps/cms/src/services/__tests__/blocks.db.integration.test.ts` chạy create/patch/filter trên Postgres và một ca hai site: zone của site B cho phép `hero` bị từ chối vì chỉ site A có collection `hero`, còn site A không bị ảnh hưởng.

## 9. Chưa hỗ trợ

- Bộ sinh OpenAPI live (#745, chưa có trên `main`) cần mapping `blocks` → JSON Schema (`oneOf` theo các template, phân biệt theo `type`).
- Relation bên trong block được lưu dạng id thuần và không được mở rộng bởi `fields=`/`deep`.
- Phân quyền theo từng block (xem §3).
