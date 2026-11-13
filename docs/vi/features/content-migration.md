---
sourceLang: en
version: 2
lastUpdated: 2026-11-13T06:07:20.634Z
translatedFrom: en
sourceHash: aba9a12e52557a17
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-13T06:07:20.634Z
codeVerifiedHash: aba9a12e52557a17
codeVerifiedClaims: 2
---

# Content migration

Chuyển một site từ headless CMS khác sang LumiBase: mô hình nội dung thành
collection và field, entry thành item, asset thành file, và rich text thành
document rich-text portable của LumiBase. Hiện hỗ trợ Contentful; Sanity,
WordPress và Strapi dùng cùng framework và sẽ được bổ sung sau.

Có hai cách, và cả hai đều dừng lại chờ con người trước khi đổi schema:

- **CLI** — `lumibase migrate contentful`: mặc định là dry run, `--apply` hỏi xác
  nhận rồi mới tạo schema và import entry cùng asset.
- **Agent skills** — `planContentMigration` và `applyContentMigrationSchema` trên
  harness có quản trị. Skill apply đổi schema nên luôn chờ phê duyệt. Sau đó entry
  được import bằng CLI.

## Bắt đầu nhanh (Contentful)

```bash
# 1. Export the space, drafts included (Contentful CLI)
contentful space export --space-id <space> --include-drafts --content-file space.json

# 2. Dry run: prints the plan, writes nothing
lumibase migrate contentful --file space.json --locale-map en-US=en

# 3. Apply: confirms, creates the schema, uploads assets, imports entries
lumibase migrate contentful --file space.json --locale-map en-US=en --apply
```

Kết nối lấy từ `--url` / `--site` / `--token`, biến môi trường, hoặc
`lumibase.config.json`, như mọi [lệnh CLI](../cli/index.md). Token cần quyền quản
trị schema và quyền `create`/`update` trên các collection mới.

| Flag | Tác dụng |
|------|----------|
| `--file <path>` | File JSON từ `contentful space export`. Bắt buộc. |
| `--apply` | Ghi schema và nội dung. Không có flag này thì lệnh chỉ là dry run. |
| `--yes` | Bỏ qua câu hỏi xác nhận. Bắt buộc trong shell không tương tác (CI). |
| `--prefix <p>` | Tiền tố cho tên collection mới, ví dụ `cf_`. |
| `--locale-map <a=b,…>` | Đổi tên locale nguồn, ví dụ `en-US=en,de-DE=de`. Locale không được map giữ nguyên mã. |
| `--skip-assets` | Không tải xuống hay upload asset; các field file để trống. |
| `--state <path>` | File để chạy tiếp cho các asset đã upload (mặc định `.lumibase/migrate-contentful-<space id>-<site>-<hash>.json`, mỗi space và mỗi đích một file). |
| `--json` | In kế hoạch dạng JSON thay vì báo cáo dễ đọc. |

## Dry run cho thấy gì

```
Source: contentful · 5 content types · 7 entries · 2 assets
Locales: en-US → en, vi (default en)

~ update collection author  (author)
    = name: string [input]  — Required in the source.
    + bio_contentful: json [translatable-text]
    + avatar: string [file]

+ create collection blog_post  (blogPost)
    + title: json [translatable-text]  — Required in the source.
    + body: json [richtext]  — Localized rich text: stored as { locale: document }.
    + author: string [relation-m2o]
    + categories: json [json-raw]  — List of category ids.
    + relation blog_post.author → author (m2o)
…

Conflicts:
  ! author.bio exists as integer; author.bio (json) goes to bio_contentful.

Warnings:
  - blogPost/post-brew.body: inline embed of missing entry missing-entry dropped.
```

`+` là sẽ tạo, `=` là đã có với kiểu tương thích, `~` là collection đã có.
Warnings liệt kê những gì không chuyển được, ví dụ link tới entry không có trong
file export. Dry run không ghi gì.

## Ánh xạ field

| Contentful | Kiểu · interface LumiBase | Giá trị lưu |
|------------|---------------------------|-------------|
| Symbol | `string` · `input` (`select-dropdown` nếu có validation *in*) | chuỗi |
| Symbol / Text, có bản địa hoá | `json` · `translatable-text` | `{ en: "…", vi: "…" }` |
| Text | `text` · `markdown` | chuỗi |
| RichText | `json` · `richtext` | [document rich-text](#rich-text) (bản địa hoá: `{ locale: document }`) |
| Integer / Number | `integer` / `decimal` · `input-number` | số |
| Boolean | `boolean` · `toggle` | boolean |
| Date | `datetime` · `datetime` | chuỗi ISO |
| Location | `geometry` · `map` | GeoJSON `{ type: "Point", coordinates: [lon, lat] }` |
| Object | `json` · `json-raw` | giữ nguyên |
| Array of Symbol | `json` · `tags` | `["a", "b"]` |
| Link to Asset | `string` · `file` | storage key của file |
| Array of Asset links | `json` · `files` | các storage key |
| Link to Entry (một content type) | `string` · `relation-m2o` + quan hệ m2o | id của item |
| Link to Entry (nhiều content type) | `json` · `json-raw` | `{ collection, id }` |
| Array of Entry links | `json` · `json-raw` | danh sách id (một type) hoặc `{ collection, id }` |
| Các kiểu khác có bản địa hoá | `json` · `json-raw` | `{ locale: value }` |

Tên collection và field chuyển sang `snake_case` (`blogPost` → `blog_post`). Tên
trùng với cột hệ thống (`id`, `status`, `sort`, `created_at`, …) được thêm hậu tố
`_field`.

## Rich text

Rich text được lưu thành document JSON portable (`@lumibase/contracts/richtext`),
không phải HTML:

```json
{
  "type": "doc",
  "version": 1,
  "content": [
    { "type": "heading", "level": 2, "content": [{ "type": "text", "text": "Brewing" }] },
    { "type": "paragraph", "content": [
      { "type": "text", "text": "fresh", "marks": ["bold"] },
      { "type": "ref", "ref": { "kind": "item", "collection": "author", "id": "author-lan" },
        "content": [{ "type": "text", "text": "Lan" }] }
    ] },
    { "type": "embed", "ref": { "kind": "file", "id": "<storage key>" } }
  ]
}
```

Block: paragraph, heading, quote, list, code, rule, embed, table, custom. Inline:
text kèm mark (bold, italic, underline, strike, code, superscript, subscript),
link, ref (tới item hoặc file), embed, break. Entry và asset nhúng của Contentful
thành node `embed`; hyperlink tới entry và asset thành node `ref`, cả hai trỏ tới
item hoặc file đã migrate.

`richTextToHtml`, `richTextToMarkdown` và `richTextToPlainText` render một
document. Bộ render HTML escape mọi node text và chỉ giữ link `http(s)`, `mailto`,
`tel` và link tương đối, nên nội dung đã lưu không thể chèn markup hay URL
`javascript:`. Studio hiển thị field `richtext` dưới dạng bản xem trước đã render
kèm nút chuyển sang JSON thô; block editor được theo dõi ở #669 và kiểu field `richtext` ở #695.

## Apply: chuyện gì xảy ra

1. **Schema.** Collection mới được tạo với **khoá chính kiểu chuỗi**, rồi tới các
   field còn thiếu, rồi các quan hệ. Với collection đã có, chỉ thêm field còn
   thiếu; field đã có không bao giờ bị đổi hay xoá, và tên trùng nhưng khác kiểu
   sẽ được đặt thành `<name>_contentful`.
2. **Asset.** Mỗi asset (file của locale mặc định) được tải từ CDN của Contentful
   và upload qua luồng presigned upload, rồi đăng ký thành file. Storage key được
   lưu vào file state sau mỗi lần upload. File state ghi lại đích của nó (URL
   CMS và site); file state viết cho một đích khác bị từ chối trước khi ghi bất
   cứ thứ gì, nên một site không bao giờ dùng lại asset key của site khác.
3. **Entry.** Mỗi entry được tạo với id Contentful làm id của item, giữ nguyên
   trạng thái (`published`, `draft`, `archived`). Nhờ vậy link được resolve trong
   một lượt.

Chạy lại `--apply` là an toàn: item đã có được cập nhật tại chỗ (create trả `409 ITEM_ID_EXISTS`,
CLI patch item đó; mọi `409` khác được báo là lỗi), và asset đã có trong file state không bị upload lại. Lỗi `429`
từ rate limiter được thử lại sau `Retry-After`.

## Agent skills

| Skill | Capability | Tác dụng |
|-------|------------|----------|
| `planContentMigration` | `schema:read` | Trả về kế hoạch và báo cáo dry run cho các content type đã cho, so với schema của site. |
| `applyContentMigrationSchema` | `schema:create`, `schema:update` | Tạo collection, field và quan hệ theo kế hoạch (chỉ thêm). Control-plane: luôn chờ con người phê duyệt. |

Cả hai nhận `{ source: "contentful", contentTypes, locales?, collectionPrefix?, localeMap? }`
— chính là hai mảng `contentTypes` và `locales` của file export. Entry và asset
không gửi cho agent; import chúng bằng `lumibase migrate --apply`, lệnh này sẽ
thấy schema đã sẵn sàng.

## Giới hạn

- Hiện chỉ có Contentful. Sanity (export NDJSON), WordPress (WXR) và Strapi đã lên
  kế hoạch trên cùng interface adapter.
- Tham chiếu nhiều item được lưu thành danh sách id dạng JSON, không phải quan hệ
  m2m.
- Collection đã có giữ nguyên kiểu khoá chính của nó; nếu khoá không phải chuỗi,
  item nhận id mới và link tới chúng không resolve được.
- Collection có editorial workflow từ chối `published` khi tạo; hãy migrate vào
  collection không có workflow, hoặc xuất bản qua workflow sau đó.
- Id của item là duy nhất trên mỗi instance LumiBase, không phải mỗi site:
  migrate cùng một space vào hai site của một instance sẽ lỗi ở các entry của
  site thứ hai. Asset và schema không bị ảnh hưởng.
- Entry được ghi từng request một. Với space rất lớn, rate limit của API
  (`LUMIBASE_API_RATE_LIMIT`, mặc định 600 request/phút) quyết định tốc độ.

## Liên quan

- [CLI](../cli/index.md)
- [Data import](./data-import.md)
- [AI skills](../ai-skills.md)
- [Field types and configuration](./field-types-and-config.md)
