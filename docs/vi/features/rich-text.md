---
version: 4
sourceLang: en
lastUpdated: 2026-11-17T07:36:34.866Z
translatedFrom: en
sourceHash: d57fc8f37ace9f78
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-17T19:26:37.076Z
codeVerifiedHash: d57fc8f37ace9f78
codeVerifiedClaims: 14
---

# Rich text

Trường `richtext` lưu một **tài liệu JSON khả chuyển (portable)**, không phải
HTML. Studio soạn nó bằng một trình soạn thảo dạng khối (thanh công cụ, menu
lệnh `/`, bảng, nhúng, chú thích cuối trang, nhập/xuất Markdown); API kiểm tra
và làm sạch mọi lần ghi; khâu phân phối dựng HTML, Markdown và văn bản thuần
từ cùng một tài liệu. Nội dung chuyển từ CMS khác (`lumibase migrate`) đã dùng
sẵn mô hình này.

## Mô hình tài liệu

```json
{
  "type": "doc",
  "version": 1,
  "content": [
    { "type": "heading", "level": 2, "content": [{ "type": "text", "text": "Hello" }] },
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "Bold", "marks": ["bold"] },
        { "type": "link", "href": "https://example.com", "content": [{ "type": "text", "text": " a link" }] }
      ]
    }
  ]
}
```

Kiểu và hàm tiện ích nằm trong `@lumibase/contracts/richtext`
(`packages/contracts/src/richtext/model.ts`).

| Node | Loại | Ghi chú |
|------|------|---------|
| `paragraph`, `heading` (`level` 1–6) | khối | Chứa node inline. |
| `quote` | khối | Chứa các khối. |
| `list` (`ordered`, `start` tuỳ chọn) | khối | Mỗi mục là một danh sách khối, nên mục lồng được nhau. |
| `code` (`language` tuỳ chọn) | khối | Văn bản thuần, server không tô màu cú pháp. |
| `rule` | khối | Đường phân cách. |
| `embed` (`ref`, `alt` tuỳ chọn) | khối / inline | Một file hoặc item của LumiBase, không bao giờ là URL ngoài. |
| `table` (`rows`, `caption`, `headerColumn`, `align` tuỳ chọn) | khối | Hàng có `header: true` là hàng tiêu đề. |
| `footnote` (`label`, `content`) | khối | Định nghĩa chú thích; được tham chiếu bởi node inline `footnote`. |
| `custom` (`name`, `data`) | khối | Khối từ block template hoặc plugin, dựng bởi renderer của nó. |
| `text` (`marks` tuỳ chọn) | inline | Mark: `bold`, `italic`, `underline`, `strike`, `code`, `superscript`, `subscript`. |
| `link` (`href`) · `ref` (`ref`) · `break` | inline | `ref` trỏ tới item hoặc file theo id. |

Version 1 chỉ mở rộng theo kiểu cộng thêm: các thuộc tính thêm sau bản đầu
(`caption` / `headerColumn` / `align` của bảng, `start` của danh sách, `alt`
của embed, chú thích cuối trang) đều tuỳ chọn, nên tài liệu ghi bởi bản cũ vẫn
hợp lệ.

Typegen sinh cùng mô hình đó: project có trường `richtext` sẽ có
`RichTextDocument` (và các kiểu node) trong file sinh ra; các target zod,
OpenAPI và GraphQL cũng phủ trường này.

## Tạo trường

Trong Studio, thêm trường với interface **Rich text (blocks)** (field type
`richtext`). Option của trường quyết định người soạn được dùng gì — thanh công
cụ và menu slash chỉ hiện tính năng được phép, còn API từ chối lần ghi dùng thứ
khác (`richtext_not_allowed`), nên thanh công cụ không phải ranh giới bảo mật. Field inspector chỉnh các option này bằng checkbox trong
mục **Rich text editor**; JSON option thô vẫn dùng được.

| Option | Mặc định | Tác dụng |
|--------|----------|----------|
| `headingLevels` | `[1…6]` (Studio gợi ý `[2, 3, 4]`) | Các cấp heading được phép. |
| `marks` | tất cả | Các mark được phép. |
| `blocks` | tất cả | Các loại khối được phép ngoài đoạn văn: `heading`, `quote`, `list`, `code`, `rule`, `table`, `embed`, `footnote`, `custom`. |
| `links` | `true` | Liên kết URL. |
| `references` | `true` | Tham chiếu và nhúng item/file. |
| `referenceCollections` | mọi collection | Collection mà tham chiếu item được trỏ tới. |
| `customBlocks` | mọi khối đã đăng ký | Tên custom block được phép. |
| `maxLength` | không giới hạn | Độ dài văn bản thuần tối đa (ký tự). |
| `placeholder` | — | Placeholder của trình soạn thảo. |

Option được đọc bởi `readRichTextFieldOptions` và được áp bởi
`checkRichTextOptions` (`packages/contracts/src/richtext/options.ts`).

## Soạn thảo trong Studio

Trình soạn thảo (`apps/studio/src/components/richtext/rich-text-editor.tsx`)
dựng trên TipTap / ProseMirror và được tải thành chunk riêng, nên không làm
tăng bundle ban đầu của Studio.

- **Thanh công cụ**: loại khối, mark, liên kết (`Ctrl+K`), liên kết tới item,
  danh sách, trích dẫn, khối code, đường phân cách, bảng, ảnh hoặc file (media
  picker), chú thích cuối trang, hoàn tác/làm lại, nhập và xuất Markdown. Bảng
  có thanh riêng: thêm/xoá hàng và cột, bật/tắt hàng tiêu đề / cột tiêu đề,
  chú thích bảng (caption). Ảnh đang chọn có ô nhập alt text; custom block
  đang chọn có ô soạn JSON cho dữ liệu của nó. **Link to item** nhận collection
  và id, hoặc **Browse…** mở bộ chọn quan hệ.
- **Menu slash**: gõ `/` ở đầu đoạn rồi lọc, ví dụ `/tab` → Table. Phím
  mũi tên để chọn, `Enter` để chèn, `Esc` để đóng. Custom block do extension
  đăng ký xuất hiện ở đây.
- **Bàn phím**: `Ctrl+B/I/U`, `Ctrl+Shift+7/8` cho danh sách, `Ctrl+Alt+1…6`
  cho heading, `Tab` / `Shift+Tab` để lồng và bỏ lồng mục danh sách, `Enter`
  trên mục rỗng thì thoát danh sách, `Shift+Enter` chèn ngắt dòng.
- **Khả năng tiếp cận**: thanh công cụ chỉ là một điểm dừng Tab
  (`role="toolbar"`, phím mũi tên di chuyển bên trong, `Alt+F10` nhảy từ vùng
  văn bản lên), mọi nút có nhãn và trạng thái `aria-pressed`, vùng soạn thảo là
  textbox nhiều dòng có nhãn.
- **Dán** từ Word, Google Docs hay trang web được chuyển sang mô hình trước
  (`htmlToRichText`): đoạn danh sách của Word thành danh sách thật, span định
  dạng của Google Docs thành mark, còn script, style, event handler, phần tử lạ
  và liên kết không an toàn bị bỏ. Ảnh không có tham chiếu LumiBase cũng bị bỏ —
  hãy tải lên media library rồi nhúng. Văn bản thuần trông giống Markdown được
  nhập như Markdown.
- Trường chỉ đọc hiển thị bản xem trước đã dựng. **Edit JSON** mở tài liệu thô;
  trường `json` chứa rich text đã chuyển theo từng locale
  (`{ "en": doc, "vi": doc }`) có nút chuyển locale.

## Bảo mật: làm sạch khi ghi và khi dựng

Rich text không bao giờ lưu hay tin HTML.

- **Đường ghi** (`apps/cms/src/services/validation.ts`): giá trị `richtext`
  phải là tài liệu đúng cấu trúc trong giới hạn (`RICHTEXT_LIMITS`: độ sâu lồng
  32, 50 000 node, 2 000 000 ký tự), qua được option của trường, rồi được lưu
  đúng như `sanitizeRichTextDocument` trả về — liên kết có scheme URL không được
  phép thì mất liên kết nhưng giữ chữ, ký tự điều khiển bị xoá, ngôn ngữ code,
  tên khối và nhãn chú thích sai định dạng bị bỏ. Chuỗi HTML bị từ chối
  (`invalid_richtext`). Trường `json` dùng interface `richtext` cũng được làm
  sạch như vậy khi nó chứa một tài liệu.
- **Danh sách URL được phép** (`safeHref`, `safeSrc` trong
  `packages/contracts/src/richtext/url.ts`): liên kết được dùng `http`,
  `https`, `mailto`, `tel` hoặc URL tương đối; media chỉ `http`, `https` hoặc
  tương đối. Khoảng trắng, ký tự điều khiển và ký tự độ rộng bằng 0 bị xoá trước
  khi đọc scheme, nên `java\tscript:` và các mẹo entity đều bị từ chối.
- **Đường dựng**: `richTextToHtml` escape mọi node văn bản và thuộc tính, rồi
  kết thúc bằng bộ làm sạch theo allowlist `sanitizeHtml`
  (`packages/contracts/src/richtext/html-sanitize.ts`). Kết quả không bao giờ
  chứa `<script>`, `<iframe>`, form, thuộc tính `style` hay event handler, nên
  an toàn dưới CSP không có `'unsafe-inline'`, kể cả HTML của renderer custom
  block.

Bộ test của contracts chạy một tập mẫu XSS qua bộ làm sạch và kiểm kết quả
bằng một HTML parser đúng chuẩn (parse5), kèm fuzz có seed và test thời gian
với đầu vào bệnh lý.

## Phân phối

REST trả về tài liệu JSON đã lưu. GraphQL đưa trường `richtext` ra dưới kiểu
dùng chung `RichText`:

```graphql
query {
  posts {
    body {
      json      # the document
      html      # sanitised HTML
      markdown  # CommonMark + GFM
      text      # plain text, one block per line
    }
  }
}
```

Custom block có `name` là một collection có display template (block
template) được dựng bằng template đó trên `data` của khối trong `html` và
`text` của GraphQL, dưới dạng văn bản đã escape — ví dụ `{{title}}` trong
template. Custom block khác cần renderer plugin.

Trong HTML, file nhúng trỏ tới `/api/v1/files/{id}/content`; tham chiếu item
giữ các thuộc tính `data-ref-kind` / `data-ref-collection` / `data-ref-id` và
không có URL, để front end tự quyết định liên kết tới đâu. Tự dựng bằng chính
các hàm đó:

```ts
import { richTextToHtml, richTextToMarkdown, richTextToPlainText } from '@lumibase/contracts/richtext';

const html = richTextToHtml(item.body, {
  resolveRef: (ref) => (ref.kind === 'file' ? `https://cdn.example.com/${ref.id}` : `/${ref.collection}/${ref.id}`),
});
```

Chỉ mục tìm kiếm lưu trường rich text dưới dạng văn bản thuần.

### Bảng có ngữ nghĩa

Bảng được dựng với `<caption>`, `<thead>` cho hàng tiêu đề, `<th scope="col">`
cho tiêu đề cột, `<th scope="row">` cho tiêu đề hàng khi bật `headerColumn`, và
`data-align` thay cho style inline. Bộ test của Studio kiểm bảng đã dựng bằng
axe-core.

```html
<table>
  <caption>Plans</caption>
  <thead><tr><th scope="col">Plan</th><th scope="col" data-align="right">Price</th></tr></thead>
  <tbody><tr><th scope="row">Pro</th><td data-align="right">10</td></tr></tbody>
</table>
```

## Nhập và xuất Markdown

`richTextToMarkdown` và `markdownToRichText` chuyển đổi không mất mát cho mọi
khối và mark cốt lõi: CommonMark cùng bảng GFM (có căn lề), gạch ngang và chú
thích cuối trang. Chi tiết mà cú pháp không có chỗ thì được ghi theo dạng mà
bộ nhập đọc lại được:

- bảng không có hàng tiêu đề được xuất kèm một hàng tiêu đề rỗng;
- caption và cột tiêu đề của bảng thành một dòng kiểu Pandoc sau bảng:
  `Table: Prices {.header-column}`;
- tham chiếu dùng URL `lumibase://item/{collection}/{id}` và
  `lumibase://file/{id}`;
- custom block không có renderer Markdown riêng thành một khối fenced
  `lumibase-block {name}` chứa dữ liệu JSON của nó.

HTML thô trong Markdown không được diễn giải, trừ các thẻ inline mà bộ xuất
tự ghi (`<u>`, `<sup>`, `<sub>`, `<br>`). Trong Studio, dùng **Import
Markdown** / **Export Markdown** trên thanh công cụ, hoặc dán văn bản Markdown.

## Custom block và plugin

UI extension thêm khối bằng `registerRichTextPlugin` từ
`@lumibase/extension-sdk`:

```ts
import { defineRichTextPlugin, registerRichTextPlugin } from '@lumibase/extension-sdk';

registerRichTextPlugin(
  defineRichTextPlugin({
    name: 'my-extension',
    blocks: {
      callout: {
        label: 'Callout',
        defaultData: { tone: 'info', text: '' },
        toHtml: (data, { escape }) => `<aside><p>${escape(String(data.text ?? ''))}</p></aside>`,
        toText: (data) => String(data.text ?? ''),
      },
    },
    // Optional: rewrite blocks after a Markdown import (remark-style).
    transformMarkdownImport: (blocks) => blocks,
  }),
);
```

Khối xuất hiện trong menu slash của mọi trường cho phép custom block (thu hẹp
theo `customBlocks` nếu có đặt). Kết quả của renderer không được tin — nó đi
qua bộ làm sạch theo allowlist — và kết quả của hook Markdown chỉ được dùng
nếu là tài liệu hợp lệ. Phía server, truyền cùng đối tượng plugin cho các
serialiser: `richTextToHtml(doc, { plugins: [plugin] })`.

## File và item được tham chiếu từ rich text

File nhúng trong rich text là tham chiếu theo id, nên báo cáo **Where used**
của media library liệt kê item đó, và việc xoá file tuân theo chính sách xoá
an toàn của site (từ chối, hoặc yêu cầu `?confirm=true`).

Item mà rich text liên kết tới hoặc nhúng — qua liên kết `ref`, `embed` inline
hoặc khối, hay `ref` / `refs` của custom block, ở bất kỳ trường nào kể cả block
lồng nhau — không thể bị xoá khi tham chiếu còn tồn tại. `DELETE` trả
**409 `DEPENDENT_RECORDS_EXIST`** kèm một nhóm phụ thuộc `kind: "richtext"`
cho mỗi collection và trường đang tham chiếu (`DependentsService.resolveRichTextDependents`
trong `apps/cms/src/services/dependents-service.ts`). Hộp thoại xoá của Studio
liệt kê các item đang tham chiếu kèm nút mở từng item; hãy gỡ liên kết hoặc
nhúng ở đó rồi xoá lại. Các nhóm này không xử lý hàng loạt được
(`resolve-dependents` trả `RICHTEXT_REFERENCE`). Liên kết của một item tới chính
nó, và tham chiếu từ item đã xoá hoặc từ site khác, không chặn việc xoá.

`collectRichTextRefs` trả về mọi tham chiếu trong một tài liệu.

## Multi-tenancy

Rich text không thêm bảng, cache key hay job nền: tài liệu nằm trong `data`
của item như mọi trường khác, được đọc ghi qua cùng các truy vấn item có phạm
vi site. Plugin do extension đăng ký là mã được tải theo phiên Studio và không
mang dữ liệu tenant. Kiểm tra file đang được dùng chạy truy vấn có phạm vi site
của media library, và kiểm tra phụ thuộc rich text chỉ quét các item còn sống
của site đang xoá.

## Chưa có

- Bản xem trước trực quan của file và item nhúng trong vùng soạn thảo (hiện
  là thẻ có nhãn).
- Mark do extension định nghĩa (hiện chỉ thêm được khối).
