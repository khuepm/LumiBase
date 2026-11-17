---
version: 4
sourceLang: en
lastUpdated: 2026-11-17T07:36:34.866Z
contentHash: d57fc8f37ace9f78
codeVerified: 2026-11-17T07:36:34.866Z
codeVerifiedHash: d57fc8f37ace9f78
codeVerifiedClaims: 14
---

# Rich text

A `richtext` field stores a **portable JSON document**, not HTML. Studio edits
it in a block editor (toolbar, `/` slash menu, tables, embeds, footnotes,
Markdown import/export); the API validates and sanitises every write; delivery
renders HTML, Markdown and plain text from the same document. Content migrated
from other CMSs (`lumibase migrate`) already uses this model.

## The document model

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

Types and helpers live in `@lumibase/contracts/richtext`
(`packages/contracts/src/richtext/model.ts`).

| Node | Kind | Notes |
|------|------|-------|
| `paragraph`, `heading` (`level` 1–6) | block | Hold inline nodes. |
| `quote` | block | Holds blocks. |
| `list` (`ordered`, optional `start`) | block | Each item is a list of blocks, so items nest. |
| `code` (optional `language`) | block | Plain text, never highlighted server-side. |
| `rule` | block | Thematic break. |
| `embed` (`ref`, optional `alt`) | block / inline | A file or item from LumiBase, never an external URL. |
| `table` (`rows`, optional `caption`, `headerColumn`, `align`) | block | A row with `header: true` is a header row. |
| `footnote` (`label`, `content`) | block | Definition; referenced by the inline `footnote` node. |
| `custom` (`name`, `data`) | block | A block template or plugin block, rendered by its renderer. |
| `text` (optional `marks`) | inline | Marks: `bold`, `italic`, `underline`, `strike`, `code`, `superscript`, `subscript`. |
| `link` (`href`) · `ref` (`ref`) · `break` | inline | `ref` links to an item or file by id. |

Version 1 grows additively: properties added after the first release
(table `caption` / `headerColumn` / `align`, list `start`, embed `alt`,
footnotes) are optional, so documents written by earlier releases stay valid.

Typegen emits the same model: a project with a `richtext` field gets
`RichTextDocument` (and its node types) in the generated file; the zod,
OpenAPI and GraphQL targets cover the field too.

## Creating a field

In Studio, add a field with the **Rich text (blocks)** interface (field type
`richtext`). Its options decide what editors can use — the toolbar and slash
menu only show allowed features, and the API rejects a write that uses
anything else (`richtext_not_allowed`), so the toolbar is not the security
boundary. The field inspector edits them with checkboxes under **Rich text
editor**; the raw options JSON stays available.

| Option | Default | Effect |
|--------|---------|--------|
| `headingLevels` | `[1…6]` (Studio suggests `[2, 3, 4]`) | Allowed heading levels. |
| `marks` | all | Allowed marks. |
| `blocks` | all | Allowed block types besides paragraphs: `heading`, `quote`, `list`, `code`, `rule`, `table`, `embed`, `footnote`, `custom`. |
| `links` | `true` | URL links. |
| `references` | `true` | Item/file references and embeds. |
| `referenceCollections` | any | Collections an item reference may point to. |
| `customBlocks` | any registered | Custom block names allowed. |
| `maxLength` | none | Maximum plain-text length (characters). |
| `placeholder` | — | Editor placeholder. |

Options are read by `readRichTextFieldOptions` and enforced by
`checkRichTextOptions` (`packages/contracts/src/richtext/options.ts`).

## Editing in Studio

The editor (`apps/studio/src/components/richtext/rich-text-editor.tsx`) is
built on TipTap / ProseMirror and loaded as a separate chunk, so it does not
add to the Studio's initial bundle.

- **Toolbar**: block type, marks, link (`Ctrl+K`), link to item, lists,
  quote, code block, divider, table, image or file (the media picker),
  footnote, undo/redo, Markdown import and export. A table gets its own bar:
  add/delete rows and columns, toggle header row / header column, caption.
  A selected image gets an alt-text field; a selected custom block gets a
  JSON editor for its data. **Link to item** takes a collection and an id,
  or **Browse…** opens the relation picker.
- **Slash menu**: type `/` at the start of a paragraph and filter, e.g.
  `/tab` → Table. Arrow keys choose, `Enter` inserts, `Esc` closes. Custom
  blocks registered by extensions appear here.
- **Keyboard**: `Ctrl+B/I/U`, `Ctrl+Shift+7/8` lists, `Ctrl+Alt+1…6`
  headings, `Tab` / `Shift+Tab` nest and un-nest list items, `Enter` on an
  empty list item leaves the list, `Shift+Enter` inserts a line break.
- **Accessibility**: the toolbar is a single tab stop (`role="toolbar"`,
  arrow keys move inside it, `Alt+F10` jumps to it from the text), every
  button has a label and `aria-pressed` state, and the editing area is a
  labelled multi-line textbox.
- **Paste** from Word, Google Docs or a web page is converted into the model
  first (`htmlToRichText`): Word list paragraphs become real lists, Google
  Docs' styled spans become marks, and scripts, styles, event handlers,
  unknown elements and unsafe links are dropped. Images without a LumiBase
  reference are dropped too — upload them to the media library and embed
  them. Plain text that looks like Markdown is imported as Markdown.
- A field shown read-only displays the rendered preview. **Edit JSON** opens
  the raw document; a `json` field holding migrated rich text per locale
  (`{ "en": doc, "vi": doc }`) gets a locale switcher.

## Security: sanitisation on write and render

Rich text never stores or trusts HTML.

- **Write path** (`apps/cms/src/services/validation.ts`): a `richtext` value
  must be a well-formed document within limits (`RICHTEXT_LIMITS`: nesting
  depth 32, 50 000 nodes, 2 000 000 characters), pass the field options, and is
  then stored as `sanitizeRichTextDocument` returns it — links whose URL scheme
  is not allowed lose the link but keep their text, control characters are
  stripped, malformed code languages, block names and footnote labels are
  dropped. An HTML string is rejected (`invalid_richtext`). A `json` field with
  the `richtext` interface is sanitised the same way when it holds a document.
- **URL allowlist** (`safeHref`, `safeSrc` in
  `packages/contracts/src/richtext/url.ts`): links may use `http`, `https`,
  `mailto`, `tel` or a relative URL; media only `http`, `https` or relative.
  Whitespace, control and zero-width characters are removed before the scheme
  is read, so `java\tscript:` and entity tricks are refused.
- **Render path**: `richTextToHtml` escapes every text node and attribute and
  finishes with the allowlist sanitiser `sanitizeHtml`
  (`packages/contracts/src/richtext/html-sanitize.ts`). The output never
  contains `<script>`, `<iframe>`, forms, `style` attributes or event handlers,
  so it is safe under a CSP without `'unsafe-inline'`, including the HTML of
  custom block renderers.

The contracts test suite runs an XSS corpus through the sanitiser and checks
the result with a spec-compliant HTML parser (parse5), plus seeded fuzzing and
pathological-input timing tests.

## Delivery

REST returns the stored JSON document. GraphQL exposes a `richtext` field as
the shared `RichText` type:

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

A custom block whose `name` is a collection with a display template (a
block template) renders that template over the block's `data` in GraphQL
`html` and `text`, as escaped text — `{{title}}` in the template, for
example. Other custom blocks need a plugin renderer.

In HTML, file embeds resolve to `/api/v1/files/{id}/content`; item references
keep `data-ref-kind` / `data-ref-collection` / `data-ref-id` attributes and no
URL, so the front end decides where they link. Render it yourself with the
same functions:

```ts
import { richTextToHtml, richTextToMarkdown, richTextToPlainText } from '@lumibase/contracts/richtext';

const html = richTextToHtml(item.body, {
  resolveRef: (ref) => (ref.kind === 'file' ? `https://cdn.example.com/${ref.id}` : `/${ref.collection}/${ref.id}`),
});
```

Search indexing stores a rich-text field as its plain text.

### Semantic tables

Tables render with `<caption>`, a `<thead>` for header rows, `<th scope="col">`
column headers, `<th scope="row">` row headers when `headerColumn` is set, and
`data-align` instead of inline styles. The Studio test suite checks the
rendered table with axe-core.

```html
<table>
  <caption>Plans</caption>
  <thead><tr><th scope="col">Plan</th><th scope="col" data-align="right">Price</th></tr></thead>
  <tbody><tr><th scope="row">Pro</th><td data-align="right">10</td></tr></tbody>
</table>
```

## Markdown import and export

`richTextToMarkdown` and `markdownToRichText` convert losslessly for every core
block and mark: CommonMark plus GFM tables (with alignment), strikethrough and
footnotes. Details the syntax has no place for are written in forms the
importer reads back:

- a table without a header row exports an empty header row;
- a table caption and header column become a Pandoc-style line after the
  table: `Table: Prices {.header-column}`;
- references use `lumibase://item/{collection}/{id}` and
  `lumibase://file/{id}` URLs;
- a custom block without its own Markdown renderer becomes a fenced
  `lumibase-block {name}` block holding its JSON data.

Raw HTML in Markdown is not interpreted, except the inline tags the exporter
writes (`<u>`, `<sup>`, `<sub>`, `<br>`). In Studio, use **Import Markdown** /
**Export Markdown** on the toolbar, or paste Markdown text.

## Custom blocks and plugins

A UI extension adds blocks with `registerRichTextPlugin` from
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

The block appears in the slash menu of every field that allows custom blocks
(narrowed by `customBlocks` when set). Renderer output is untrusted — it goes
through the allowlist sanitiser — and a Markdown hook's result is used only if
it is a valid document. On the server, pass the same plugin object to the
serialisers: `richTextToHtml(doc, { plugins: [plugin] })`.

## Files and items referenced from rich text

A file embedded in rich text is a reference by id, so the media library's
**Where used** report lists the item, and deleting the file follows the
site's safe-delete policy (refuse, or require `?confirm=true`).

An item that rich text links to or embeds — through a `ref` link, an inline or
block `embed`, or a custom block's `ref` / `refs`, in any field including
nested blocks — cannot be deleted while the reference exists. `DELETE` answers
**409 `DEPENDENT_RECORDS_EXIST`** with a dependents group of `kind: "richtext"`
per referencing collection and field (`DependentsService.resolveRichTextDependents`
in `apps/cms/src/services/dependents-service.ts`). Studio's delete dialog lists
the referencing items with a button to open each one; remove the link or embed
there, then delete again. These groups cannot be batch-resolved
(`resolve-dependents` answers `RICHTEXT_REFERENCE`). A link from an item to
itself, and references from deleted items or other sites, do not block.

`collectRichTextRefs` returns every reference in a document.

## Multi-tenancy

Rich text adds no table, cache key or background job: documents live in the
item's `data` like any other field, read and written through the same
site-scoped item queries. Plugins registered by extensions are code loaded
per Studio session and carry no tenant data. The file-usage check runs the
site-scoped query of the media library, and the rich-text dependents check
scans only the deleting site's live items.

## Not yet included

- A visual preview of embedded files and items in the editor canvas (they
  show as labelled cards).
- Extension-defined marks (only blocks can be added today).
