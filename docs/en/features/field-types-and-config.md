# Field Types And Configuration

LumiBase treats each field as a first-class schema object. A field has independent storage, editor, display, validation, permission, and runtime metadata. The same field contract is used by Studio, REST schema endpoints, SDK schema resources, and typegen.

## 1. Storage Types

| Type | Runtime value | Notes |
|---|---|---|
| `string` | `string` | Short text. May use `length`. |
| `text` | `string` | Long text. |
| `integer` / `bigInteger` | `number` | Sequence-backed primary keys are reserved for non-JSONB storage modes. |
| `decimal` | `number` | Uses `precision` and `scale`. |
| `boolean` | `boolean` | Boolean flag. |
| `json` | `unknown` | Raw JSON object/value. |
| `uuid` | `string` or branded ID | UUID value, often used for primary keys or relations. |
| `date` / `datetime` / `time` / `timestamp` | `string` | ISO-like serialized date/time values. |
| `csv` | `string` | CSV serialized text. |
| `hash` | `string` | One-way stored hash. |
| `geometry` | `GeoJSON.Geometry` | Stored as GeoJSON-like JSON. |
| `alias` | virtual | Used for relation aliases, groups, and presentation-only fields. |

## 2. Field Metadata

Field definitions can include:

```json
{
  "name": "cover",
  "type": "uuid",
  "interface": "file",
  "display": "image",
  "label": "Cover",
  "note": "16:9 hero image",
  "defaultValue": null,
  "nullable": true,
  "required": false,
  "readonly": false,
  "hidden": false,
  "encrypted": false,
  "versioned": true,
  "rawEnabled": true,
  "unique": false,
  "indexed": true,
  "searchable": true,
  "special": ["file"],
  "options": { "folder": "covers" },
  "displayOptions": { "size": "medium" },
  "validation": {
    "rules": [
      { "type": "mime", "allow": ["image/png", "image/jpeg", "image/webp"] }
    ]
  },
  "conditions": [
    { "rule": "$.status == 'published'", "set": { "required": true } }
  ],
  "translations": {
    "en": { "label": "Cover", "help": "16:9 image" }
  },
  "width": "full",
  "group": "media",
  "sortOrder": 20
}
```

`required` means the value must be present when creating/updating an item. `nullable` describes whether the stored value may be `null`. Typegen preserves both: required fields are emitted as required TypeScript properties, optional fields get `?`, and nullable fields include `| null`.

## 3. Readonly, Generated, And System Fields

Readonly fields cannot be updated through item writes or raw schema edits unless the backend explicitly allows a safe system-field override. Generated fields are produced by LumiBase or by the storage runtime and should be treated as read-only from client code.

System fields are compiled for every collection:

- `id`
- `status`
- `sort`
- `user_created`
- `user_updated`
- `created_at`
- `updated_at`
- `deleted_at`

Typegen emits readonly TypeScript properties for fields marked `readonly` or `generated`.

## 4. Interface Registry

Interfaces define how Studio edits a field. The registry contract is:

```ts
interface FieldInterface<TOptions> {
  id: string;
  types: string[];
  optionsSchema: unknown;
  Component: React.ComponentType<{
    value: unknown;
    onChange(value: unknown): void;
    options: TOptions;
    field: unknown;
  }>;
  supportsRaw: boolean;
}
```

Current Studio interfaces (Directus-parity set) include:

- **Text & utility**: `input`, `input-multiline`, `wysiwyg`, `markdown`, `code`, `slug`, `color`, `input-hash` (secret hashed on save), `input-autocomplete-api` (API-driven suggestions).
- **Number**: `input-number`, `rating`, `slider`.
- **Choice**: `select-dropdown`, `select-multiple-dropdown`, `select-radio`, `select-multiple-checkbox`, `select-multiple-checkbox-tree`, `select-icon`, `tags`.
- **Boolean / Date**: `toggle`, `datetime`.
- **Relation**: `relation-m2o`, `relation-o2m`, `relation-m2m`, `relation-o2m-tree-view`, `relation-m2a` (the **Builder** — links across multiple collections), `collection-item-dropdown`, `file`, `files`.
- **Presentation / Group**: `presentation-divider`, `presentation-notice`, `presentation-header`, `presentation-links`, `group-raw`, `group-detail`, `group-accordion`.
- **Special**: `json-raw`, `repeater`, `map` (GeoJSON), `seo`, `aio`, `translatable-text`.

Relational multi-item interfaces (`relation-o2m`, `relation-m2m`, `relation-m2a`) expose **Create new** and **Add existing** actions via the shared `RelationDrawer` (`apps/studio/src/modules/content/interfaces/relation-drawer.tsx`) and support drag-to-reorder. The M2A Builder stores `Array<{ collection, id }>` and lets the editor pick the target collection per linked record. The form honors `field.width` (`half`/`full`/`fill`) and nests fields under `group-*` containers via `field.group`. The implementation source of truth is `apps/studio/src/modules/content/interfaces/registry.tsx`.

## 5. Display Registry

Displays control read/list rendering and are independent from editor interfaces.

| Display | Purpose |
|---|---|
| `formatted-value` / `raw` | Generic scalar rendering. |
| `boolean-icon` | Boolean icon rendering. |
| `datetime` | Date/time formatting. |
| `image` | Image preview. |
| `labels` / `badge` | Choice/status labels. |
| `relation-related-values` | Related item display using the target collection template. |
| `mustache-template` | Mustache-based composed display. |
| `color-swatch` | Color chip. |
| `rating-stars` | Rating display. |
| `tags-pills` | Tag list. |

Authors edit collection `displayTemplate` in the collection Display tab. Relation displays can use the related collection's template.

## 6. Validation And Conditions

Validation rules run server-side before writes and can also power Studio validation:

- Built-ins: `required`, `regex`, `minLength`, `maxLength`, `min`, `max`, `enum`, `unique`, `filesize`, `mime`, `email`, `url`.
- Expression rule: `{ "type": "expression", "expr": "$count(value) <= 5" }`.

Conditions use item context to override field state:

```json
{ "rule": "$.status == 'published'", "set": { "required": true, "readonly": true } }
```

Condition output may override `required`, `readonly`, `hidden`, or `options`.

## 7. Encryption And Versioning

`encrypted: true` tells the item service to encrypt the field before storage. Read permission determines whether the caller receives the decrypted value. Because typegen cannot know the caller's permissions at compile time, encrypted string-like fields are emitted as `T | '***'` plus nullability.

`versioned: true` records field-level deltas in `revisions` when the field changes. Non-versioned fields are omitted from revision deltas to reduce noise and storage.

## 8. Relation Fields

Relations are stored in the `relations` table and may also annotate a field with `kind` and `target` in the typegen manifest.

- `m2o`: the many-side field stores the target primary key. Generated base types use the target branded ID where possible.
- `o2m` and `m2m`: generated expanded types expose arrays of target items.
- `m2a`: reserved for many-to-any and emitted as `Array<{ collection: string; item: unknown }>` until a concrete collection union is available.

Generated base collection interfaces represent stored values. Generated `CollectionExpanded` types replace relation fields with expanded object shapes.

## 9. Risky Field Mutations

The schema service classifies risky field mutations before apply:

- Rename: use `renameFrom` and preserve current `type`/`interface` in the SDK rename helper.
- Type change with existing data: requires `migrationPlan` and `confirmRiskyChange`.
- Delete with existing data: requires an explicit destructive path. The SDK accepts delete options such as `confirmRiskyChange`, `migrationPlan`, `force`, and `backupToRevisions`.

Schema diff reports `risk` and `runtimeImpact` so Studio and automation can require confirmation before destructive changes.

## 10. Raw Mode

Any field with `rawEnabled !== false` can be edited in raw mode. Interfaces should expose safe `toRaw(value)` and `fromRaw(raw)` behavior, with JSON stringify/parse as the default fallback. The Field Inspector preserves unknown JSON options so older Studio builds do not erase newer field configuration.
