---
version: 1
lastUpdated: 2026-07-25T08:15:55.263Z
sourceLang: vi
translatedFrom: vi
sourceHash: 5a181f4e4146ecd4
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:15:55.263Z
codeVerifiedHash: 5a181f4e4146ecd4
codeVerifiedClaims: 2
---

# Raw Data Editing (every field)

> LumiBase commitment: **every field** can be edited in Raw mode — the sole exception being an `encrypted` field the user lacks permission for.

## 1. UX

- Every field has a **"{ }"** icon in the corner of its input to toggle Raw mode.
- Either a modal or an inline collapse, with a Monaco editor providing:
  - Language chosen by type (`json`, `html`, `markdown`, `plain`).
  - Schema validation (a JSON Schema derived from `type` + `validation`).
  - Side-by-side preview for `wysiwyg`, `markdown`, `image`.
- Actions: `Apply`, `Cancel`, `Reset to last saved`, `Format`.

## 2. Bulk raw editor

- The item detail page has a **"Raw item JSON"** button that opens the whole document in Monaco.
- You can paste JSON, have it validated against the collection schema, and see the list of errors.

## 3. Contract

```ts
interface RawTransport<TValue> {
  toRaw(value: TValue): string;
  fromRaw(raw: string): TValue;
  language: 'json' | 'html' | 'markdown' | 'plain' | 'sql' | 'yaml';
  schema?: JSONSchema7; // used for monaco validation
}
```
- Default for every interface: `JSON.stringify/parse` with 2 spaces.
- An interface may override it (e.g. `wysiwyg.toRaw` returns plain HTML).

## 4. Server-side

- The item update endpoint receives an ordinary payload — `fromRaw` has already run on the client. The server does **not** distinguish raw from non-raw.
- There is, however, a `POST /items/:c/:id/raw` endpoint for submitting the whole document as one JSON block; it validates against the full collection schema and applies the `update` permission plus the field mask.

## 5. Security

- `encrypted` fields: Raw mode is only offered when the user holds the `read:decrypted` permission. Otherwise the field renders read-only as `*** (encrypted)`.
- Audit: a `raw_edit` entry is written to activity with the before/after diff.

## 6. Edge cases

- Field type `csv`: the raw form is a CSV string, with a "convert to array preview" button.
- Relation fields: the raw form is an array of foreign keys; the preview renders the target collection's display template.
- `geometry` fields: the raw form is GeoJSON; the preview renders a map.

## 7. Tasks: Phase MVP-B (interface contract) + Phase B3 (bulk).
