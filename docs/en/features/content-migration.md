---
sourceLang: en
version: 1
lastUpdated: 2026-11-12T20:47:42.877Z
contentHash: f6db806a7a4f94a8
codeVerified: 2026-11-12T20:47:42.877Z
codeVerifiedHash: f6db806a7a4f94a8
codeVerifiedClaims: 2
---

# Content migration

Move a site from another headless CMS into LumiBase: the content model becomes
collections and fields, entries become items, assets become files, and rich text
becomes LumiBase's portable rich-text document. Contentful is supported today;
Sanity, WordPress and Strapi use the same framework and follow.

There are two ways in, and both stop for a human before the schema changes:

- **CLI** — `lumibase migrate contentful`: dry run by default, `--apply` asks for
  confirmation, then creates the schema and imports entries and assets.
- **Agent skills** — `planContentMigration` and `applyContentMigrationSchema` on
  the governed harness. The apply skill changes the schema, so it always waits for
  approval. Entries are then imported with the CLI.

## Quick start (Contentful)

```bash
# 1. Export the space, drafts included (Contentful CLI)
contentful space export --space-id <space> --include-drafts --content-file space.json

# 2. Dry run: prints the plan, writes nothing
lumibase migrate contentful --file space.json --locale-map en-US=en

# 3. Apply: confirms, creates the schema, uploads assets, imports entries
lumibase migrate contentful --file space.json --locale-map en-US=en --apply
```

The connection comes from `--url` / `--site` / `--token`, the environment, or
`lumibase.config.json`, as for every [CLI command](../cli/index.md). The token
needs schema-admin rights and `create`/`update` on the new collections.

| Flag | Effect |
|------|--------|
| `--file <path>` | The `contentful space export` JSON. Required. |
| `--apply` | Write the schema and content. Without it the command is a dry run. |
| `--yes` | Skip the confirmation prompt. Required in a non-interactive shell (CI). |
| `--prefix <p>` | Prefix for new collection names, e.g. `cf_`. |
| `--locale-map <a=b,…>` | Rename source locales, e.g. `en-US=en,de-DE=de`. Unmapped locales keep their code. |
| `--skip-assets` | Do not download or upload assets; file fields stay empty. |
| `--state <path>` | Resume file for uploaded assets (default `.lumibase/migrate-contentful-<space id>.json`, or `.lumibase/migrate-contentful.json` when the export has no space id). |
| `--json` | Print the plan as JSON instead of the readable report. |

## What the dry run shows

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

`+` is created, `=` already exists with a compatible type, `~` is an existing
collection. Warnings list what cannot be carried over, such as links to entries
missing from the export. Nothing is written in a dry run.

## Field mapping

| Contentful | LumiBase type · interface | Stored value |
|------------|---------------------------|--------------|
| Symbol | `string` · `input` (`select-dropdown` with an *in* validation) | text |
| Symbol / Text, localized | `json` · `translatable-text` | `{ en: "…", vi: "…" }` |
| Text | `text` · `markdown` | text |
| RichText | `json` · `richtext` | [rich-text document](#rich-text) (localized: `{ locale: document }`) |
| Integer / Number | `integer` / `decimal` · `input-number` | number |
| Boolean | `boolean` · `toggle` | boolean |
| Date | `datetime` · `datetime` | ISO string |
| Location | `geometry` · `map` | GeoJSON `{ type: "Point", coordinates: [lon, lat] }` |
| Object | `json` · `json-raw` | as is |
| Array of Symbol | `json` · `tags` | `["a", "b"]` |
| Link to Asset | `string` · `file` | file storage key |
| Array of Asset links | `json` · `files` | storage keys |
| Link to Entry (one content type) | `string` · `relation-m2o` + m2o relation | item id |
| Link to Entry (several content types) | `json` · `json-raw` | `{ collection, id }` |
| Array of Entry links | `json` · `json-raw` | ids (one type) or `{ collection, id }` |
| Other localized types | `json` · `json-raw` | `{ locale: value }` |

Collection and field names become `snake_case` (`blogPost` → `blog_post`).
Names that would shadow a system column (`id`, `status`, `sort`, `created_at`, …)
get a `_field` suffix.

## Rich text

Rich text is stored as a portable JSON document (`@lumibase/contracts/richtext`),
not HTML:

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

Blocks: paragraph, heading, quote, list, code, rule, embed, table, custom. Inline:
text with marks (bold, italic, underline, strike, code, superscript, subscript),
link, ref (to an item or file), embed, break. Contentful embedded entries and
assets become `embed` nodes; entry and asset hyperlinks become `ref` nodes, both
pointing at the migrated item or file.

`richTextToHtml`, `richTextToMarkdown` and `richTextToPlainText` render a document.
The HTML renderer escapes every text node and keeps only `http(s)`, `mailto`, `tel`
and relative links, so stored content cannot inject markup or `javascript:` URLs.
Studio shows `richtext` fields as a rendered preview with a raw JSON toggle; the
block editor is tracked in #669 and the `richtext` field type in #695.

## Apply: what happens

1. **Schema.** New collections are created with a **string primary key**, then
   missing fields, then relations. For a collection that already exists, only
   missing fields are added; an existing field is never changed or removed, and a
   name clash with a different type goes to `<name>_contentful` instead.
2. **Assets.** Each asset (default-locale file) is downloaded from the Contentful
   CDN and uploaded through the presigned upload flow, then registered as a file.
   Its storage key is saved to the state file after each upload.
3. **Entries.** Each entry is created with its Contentful id as the item id, keeping
   its status (`published`, `draft`, `archived`). Links therefore resolve in one
   pass.

Re-running `--apply` is safe: an item that already exists is updated in place
(create returns `409 ITEM_ID_EXISTS`, the CLI patches it), and assets in the state file are not
uploaded again. A `429` from the rate limiter is retried after `Retry-After`.

## Agent skills

| Skill | Capability | Effect |
|-------|------------|--------|
| `planContentMigration` | `schema:read` | Returns the plan and the dry-run report for the given content types, compared with the site's schema. |
| `applyContentMigrationSchema` | `schema:create`, `schema:update` | Creates the collections, fields and relations of the plan (additive only). Control-plane: always parks for human approval. |

Both take `{ source: "contentful", contentTypes, locales?, collectionPrefix?, localeMap? }`
— the `contentTypes` and `locales` arrays of the space export. Entries and assets
are not sent to the agent; import them with `lumibase migrate --apply`, which
finds the schema already in place.

## Limits

- Only Contentful today. Sanity (NDJSON export), WordPress (WXR) and Strapi are
  planned on the same adapter interface.
- Many-references are stored as JSON id lists, not m2m relations.
- An existing collection keeps its own primary-key type; with a non-string key,
  items get new ids and links to them do not resolve.
- Collections with an editorial workflow refuse `published` on create; migrate
  into collections without one, or publish through the workflow afterwards.
- Entries are written one request at a time. For very large spaces, expect the
  API rate limit (`LUMIBASE_API_RATE_LIMIT`, 600 requests/min by default) to set
  the pace.

## Related

- [CLI](../cli/index.md)
- [Data import](./data-import.md)
- [AI skills](../ai-skills.md)
- [Field types and configuration](./field-types-and-config.md)
