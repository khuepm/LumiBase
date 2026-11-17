---
sourceLang: en
version: 3
lastUpdated: 2026-11-16T15:44:59.118Z
contentHash: 2c7b37b7c7e92681
codeVerified: 2026-11-16T15:44:59.118Z
codeVerifiedHash: 2c7b37b7c7e92681
codeVerifiedClaims: 6
---

# Data export

Export a collection as **CSV** or **JSON** from Studio (**Content → collection →
Export**) or from the API. The export streams page by page, so collection size
is not limited by memory. The same file can be read back as an import, and an
export → import → export round-trip keeps every value, translations included.

## Endpoint

```
GET /api/v1/items/{collection}/export
```

| Query | Values | Default | Notes |
|-------|--------|---------|-------|
| `format` | `csv`, `json` | `csv` | |
| `fields` | comma-separated field names | every stored field | `id`, `status`, `sort`, `created_at`, `updated_at` are always written. An unknown field is `400 UNKNOWN_FIELD`. |
| `locales` | comma-separated locales | CSV: the site's `locales` setting · JSON: every locale | Applies to translatable fields (`translatable-text` interface). |
| `relations` | `id`, `slug`, `embed` | `id` | See [Relations](#relations). |
| `filter` | JSON or `filter[field][_op]=value` | none | Same syntax as the list endpoint. |
| `sort` | comma-separated, `-` for descending | `id` | |
| `status` | item status | any | |

The response is a download (`Content-Disposition: attachment; filename="<collection>-<date>.<format>"`,
`Cache-Control: no-store`). Bad input and missing permissions are rejected
before the first byte is sent. That includes `read` on every collection that
`relations=slug` or `relations=embed` expands: without it the export is
`403 FORBIDDEN`, not a file.
The request uses the caller's `read` permission: row rules filter the rows and
field rules mask the values, exactly as in the list endpoint. Each export writes
an `items_exported` entry to the audit log (collection, format, fields, locales,
relation mode, whether a filter was used).

```bash
curl -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE" \
  "https://api.example.com/api/v1/items/products/export?format=csv&locales=en,vi" -o products.csv
```

A failure after streaming has started (a database error, or an
`items.export.before` hook that throws) cannot change the `200` that was already
sent, so it is marked in the body and the stream then ends with an error:

- CSV: the last line is `#lumibase-export-error,<CODE>` (for example
  `FORBIDDEN`, or `EXPORT_FAILED` when there is no code). The error message is
  not written.
- JSON: the document is left unclosed, so it does not parse.

Treat either as a failed export and run it again. Reading such a file back as an
import is refused.

With the SDK:

```ts
const res = await client.items('products').export({ format: 'json', fields: ['title', 'price'] });
const doc = await res.json(); // or pipe res.body to a file
```

## CSV layout

- UTF-8 with a byte-order mark, CRLF line endings, RFC 4180 quoting.
- Columns: `id,status,sort,created_at,updated_at`, then one column per field.
- A translatable field becomes one column per locale: `title.en`, `title.vi`.
- Objects and arrays (`json` fields, embedded relations) are written as JSON text.
- An empty cell is `null`; `""` is an empty string.
- A text value that starts with `=`, `+`, `-`, `@`, a tab, a carriage return or
  `'` is written with a leading `'`, so spreadsheet apps do not run it as a
  formula. Reading the file back as an import removes that `'`.

## JSON layout

```json
{
  "collection": "products",
  "format": "lumibase-export@1",
  "exportedAt": "2026-11-12T08:00:00.000Z",
  "fields": ["title", "price"],
  "locales": null,
  "relations": "id",
  "items": [
    {
      "id": "x8Kq…",
      "status": "published",
      "sort": 1,
      "created_at": "2026-11-01T10:00:00.000Z",
      "updated_at": "2026-11-02T10:00:00.000Z",
      "data": { "title": { "en": "Coffee", "vi": "Cà phê" }, "price": 10.5 }
    }
  ]
}
```

`locales` is `null` when every locale was kept. JSON preserves value types exactly;
CSV restores numbers, booleans and JSON from the collection's field types.

## Relations

| Mode | Effect |
|------|--------|
| `id` | The stored foreign id, as saved. Use this to re-import. |
| `slug` | For many-to-one fields, the related item's `slug` replaces the id (the id stays when the related item has no slug). |
| `embed` | Adds the related record under the relation's alias (`author` for `author_id`), as JSON. The foreign id is kept. |

## Extension hook

Hook extensions can transform each row with `items.export.before`. The hook
receives `{ collection, item, itemId, userId, siteId }`, where `item` is the
export record (`{ id, status, sort, created_at, updated_at, data }`). Returning
`{ item }` replaces the row; throwing stops the export.

```ts
export default {
  hooks: {
    'items.export.before': async ({ item }) => ({
      item: { ...item, data: { ...item.data, internal_notes: null } },
    }),
  },
};
```

## Re-importing

Upload the file as a [background import job](./data-import.md#background-import-jobs):
`POST /api/v1/imports?collection=…` reads both formats as written here, with
progress, cancel and a row-level error report. Use `mode=upsert` to update the
items whose `id` matches instead of creating copies.

## Related

- [Data import](./data-import.md)
- [Hono API spec → Items](../api/hono-api-spec.md)
- [Extensions system](./extensions-system.md)
