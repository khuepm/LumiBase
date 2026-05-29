# Raw Data Editing (Mọi field)

> Cam kết LumiBase: **bất kỳ field nào** (trừ `encrypted` thiếu quyền) cũng có thể chỉnh ở chế độ Raw.

## 1. UX

- Mỗi field có icon **"{ }"** ở góc input để toggle Raw mode.
- Modal hoặc inline collapse, Monaco editor với:
  - Language theo type (`json`, `html`, `markdown`, `plain`).
  - Schema validation (JSON Schema derived từ `type` + `validation`).
  - Side-by-side preview cho `wysiwyg`, `markdown`, `image`.
- Action: `Apply`, `Cancel`, `Reset to last saved`, `Format`.

## 2. Bulk raw editor

- Trang detail item có nút **"Raw item JSON"** mở toàn bộ document ở Monaco.
- Cho phép paste JSON, validate qua schema collection, hiển thị danh sách lỗi.

## 3. Contract

```ts
interface RawTransport<TValue> {
  toRaw(value: TValue): string;
  fromRaw(raw: string): TValue;
  language: 'json' | 'html' | 'markdown' | 'plain' | 'sql' | 'yaml';
  schema?: JSONSchema7; // dùng cho monaco validate
}
```
- Mặc định cho mọi interface: `JSON.stringify/parse` với 2 spaces.
- Interface có thể override (vd. `wysiwyg.toRaw = html` thuần).

## 4. Server-side

- Endpoint cập nhật item nhận payload bình thường (đã `fromRaw` ở client). Server **không** phân biệt raw hay không.
- Tuy nhiên có endpoint `POST /items/:c/:id/raw` để gửi nguyên block JSON toàn document (sẽ validate toàn bộ schema collection, áp permission `update` + field mask).

## 5. Bảo mật

- `encrypted` field: Raw mode chỉ hiển thị khi user có permission `read:decrypted`. Ngược lại field hiển thị `*** (encrypted)` read-only.
- Audit: ghi `raw_edit` vào activity với diff (trước/sau).

## 6. Edge cases

- Field type `csv`: raw là chuỗi CSV, có button "convert to array preview".
- Field relation: raw là array of foreign keys; preview hiển thị display template của target collection.
- Field `geometry`: raw là GeoJSON; preview render map.

## 7. Tasks: Phase MVP-B (interface contract) + Phase B3 (bulk).
