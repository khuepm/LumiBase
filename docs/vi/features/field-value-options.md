---
version: 2
lastUpdated: 2026-11-15T11:50:26.954Z
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
sourceHash: c22413ed3db6af98
codeVerified: 2026-11-15T11:50:26.954Z
codeVerifiedHash: c22413ed3db6af98
codeVerifiedClaims: 8
---

# Tùy chọn giá trị của field

Ba tùy chọn field nhỏ lấp các khoảng trống phổ biến so với những headless CMS
khác: lựa chọn đơn không cho xóa, độ dài văn bản cấu hình được, và chính sách
bộ ký tự cho slug. Cả ba nằm trong object `options` của field, cạnh các khóa
riêng của interface (`choices`, `placeholder`, `rows`, …), và đều:

- **được kiểm tra khi ghi schema** — mọi thao tác tạo, cập nhật, đổi tên field
  và schema apply đều chạy Zod schema dùng chung trong `packages/contracts/src/schemas/field-options.ts`
  (REST, config-as-code và MCP đều đi qua `apps/cms/src/services/schema-service.ts`).
  Tùy chọn không hợp lệ trả về `422 INVALID_FIELD_OPTIONS`, nêu tên field và khóa.
- **được thực thi khi ghi item** — pipeline kiểm tra trong
  `apps/cms/src/services/validation.ts` chạy bên trong `ItemService` cho create,
  update, replace, bulk, revert revision, mutation GraphQL và công cụ MCP/agent.
  Vi phạm trả về `400 VALIDATION` với thông điệp nêu tên field và giới hạn.
- **tự chọn bật** — field không có các khóa này hoạt động y như trước.

Trong Studio, mở một field, vào **Interface → Value options**. Phần kiểm tra
giống hệt chạy ngay tại đó, và nút **Save** bị khóa khi còn tùy chọn không hợp lệ.

## `allowClear` — lựa chọn đơn không cho xóa

Áp dụng cho interface lựa chọn đơn: `select-radio` và `select-dropdown`.

```json
{ "choices": [{ "value": "draft" }, { "value": "final" }], "allowClear": false }
```

| `allowClear` | Studio | API |
| --- | --- | --- |
| bỏ trống / `true` (mặc định) | radio hiện **Clear selection** khi đã có giá trị; dropdown giữ lựa chọn rỗng | chấp nhận `null` / `""` |
| `false` | không còn cách xóa khi đã có giá trị | update đặt `null` hoặc `""` lên item có giá trị đã lưu khác rỗng bị từ chối (`not_clearable`) |

Quan hệ với `required`:

- `required: true` vốn đã từ chối giá trị rỗng ở **mọi** lần ghi, nên
  `allowClear` không bổ sung gì ở đó (Studio luôn ẩn nút xóa với field bắt buộc).
- `required: false` + `allowClear: false` nghĩa là "được phép bắt đầu rỗng,
  nhưng một khi đã chọn thì chỉ được đổi, không được xóa". Tạo item không có
  giá trị, và cập nhật item vẫn còn rỗng, đều được phép.

Đặt `allowClear` trên interface khác sẽ bị từ chối khi ghi schema.

## `minLength` / `maxLength` — độ dài văn bản

Áp dụng cho field `string` và `text` (input, textarea, slug, …).

```json
{ "maxLength": 2000, "minLength": 20 }
```

- Độ dài được đếm theo **Unicode code point**, không phải đơn vị UTF-16: một
  emoji như `😀` hay một chữ tiếng Việt dựng sẵn như `ệ` tính là **một**.
  Bộ đếm trong Studio dùng cùng cách đếm và không còn đặt thuộc tính `maxLength`
  gốc của trình duyệt (vốn đếm theo UTF-16 và sẽ chặn cả dữ liệu hợp lệ).
- Chuỗi rỗng được coi là "không có giá trị" với `minLength`; dùng `required`
  để cấm giá trị rỗng.
- Giới hạn: số nguyên, `minLength` ≥ 0, `maxLength` ≥ 1, cả hai ≤ 1,000,000, và
  `minLength` ≤ `maxLength`.
- Nếu field khai báo `length` lưu trữ, `maxLength` không được vượt quá nó.
- Với kiểu field không phải văn bản, các khóa này vẫn được chấp nhận (chúng đã
  tồn tại từ trước dưới dạng gợi ý lỏng của Studio) nhưng không được thực thi.

Ví dụ lỗi: `excerpt: Field "excerpt" must be at most 2000 characters (Unicode code points); received 2001.`

## `slug` — chính sách bộ ký tự slug

Áp dụng cho field `string` / `text`, thường đi với interface `slug`.

```json
{ "slug": { "charset": "ascii", "lowercase": true, "separator": "-" } }
```

| Khóa | Giá trị | Mặc định |
| --- | --- | --- |
| `charset` | `ascii`, `unicode`, `custom` | — (bắt buộc) |
| `pattern` | pattern giới hạn, chỉ dùng với `custom` | — |
| `lowercase` | `true` / `false` | `true` |
| `separator` | `-`, `_`, `.` | `-` |

- **`ascii`** — chuyển dấu Latin về chữ gốc, rồi giữ các cụm `[a-z0-9]` nối
  bằng separator. Tiếng Việt được chuyển đúng: `Tiếng Việt` → `tieng-viet`,
  `Đà Nẵng` → `da-nang`, `Straße` → `strasse`.
- **`unicode`** — giữ chữ cái, chữ số và dấu kết hợp của mọi hệ chữ (lớp Unicode
  `\p{L}`, `\p{N}`, `\p{M}`), chuẩn hóa NFC: `Tiếng Việt` → `tiếng-việt`,
  `東京 タワー` → `東京-タワー`.
- **`custom`** — sinh giống `unicode`, sau đó phải khớp `pattern`.

Studio định dạng slug khi rời ô nhập bằng hàm `slugify` dùng chung trong
`packages/contracts/src/field/slug.ts` và hiện gợi ý khi giá trị vi phạm chính
sách. API **chỉ kiểm tra, không viết lại**: slug không đúng chính sách bị từ
chối (`invalid_slug`) nên giá trị được lưu luôn đúng là thứ client gửi lên.
`slugify` có tính idempotent — chạy lại trên kết quả của chính nó không đổi gì.

### Pattern custom an toàn trước ReDoS

`pattern` custom không bao giờ được engine biểu thức chính quy kiểu backtracking
chạy trên toàn bộ giá trị. Nó phải dùng một tập con giới hạn:

- cho phép: ký tự thường, dấu câu đã escape, `.`, `\d \w \s` và dạng phủ định,
  `\p{…}` / `\P{…}`, lớp ký tự như `[a-z0-9-]`, mỗi thành phần có thể kèm một
  lượng từ `* + ? {n} {n,} {n,m}` (cận ≤ 100); chấp nhận `^` ở đầu và `$` ở cuối
  (dù sao toàn bộ giá trị cũng phải khớp);
- từ chối: nhóm `( )`, phép hoặc `|`, backreference, lookaround, `\b`, lượng từ
  chồng nhau như `a**`, pattern dài hơn 200 ký tự hoặc mở rộng quá 512 vị trí
  của bộ so khớp.

Mỗi thành phần được biên dịch thành phép thử một ký tự và cả chuỗi được so khớp
bằng mô phỏng Thompson-NFA, nên thời gian so khớp tuyến tính theo độ dài giá trị
(`O(length × positions)`) bất kể pattern. Pattern như `(a+)+$` bị từ chối khi
ghi schema kèm lý do.

```json
{ "slug": { "charset": "custom", "pattern": "^[a-z]{2}/[a-z0-9-]+$" } }
```

### Hành vi mặc định

Khi không có `options.slug`, API không kiểm tra slug (giữ nguyên như cũ), còn
Studio định dạng khi rời ô nhập theo `ascii` / chữ thường / `-` với giới hạn 80
code point (hoặc `options.maxLength`). Studio giờ cũng chuyển `đ`/`Đ` thành `d`
thay vì bỏ mất.
