---
version: 1
lastUpdated: 2026-07-25T08:15:55.423Z
sourceLang: vi
translatedFrom: vi
sourceHash: 23c08db0a48a13c5
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:15:55.423Z
codeVerifiedHash: 23c08db0a48a13c5
codeVerifiedClaims: 6
---

# Translations & i18n

## 1. Three layers of i18n

1. **UI strings** — the Studio interface, translated through the `translations` table under the `ui` namespace, plus fallback packs shipped with the bundle.
2. **Schema labels** — `fields.translations.<locale>.label/help` and `collections.translations` (via the `meta.translations` field).
3. **Content** — translating field values. Two strategies:
   - **Field-level repeat** (the Directus translations pattern): create a linked `<col>_translations` collection (m2o → parent, m2o → languages).
   - **JSONB locale map** (simpler for small content): a `text` field with the `translatable-text` interface storing `{ en: "...", vi: "..." }`.

LumiBase supports **both** — JSONB by default for a single field, collection-link for complex items.

## 2. Locale management

- `settings.locales.available = ["en","vi","ja"]`, `settings.locales.default = "en"`.
- **Settings → Locales** page: add/remove a locale, set the default, configure the fallback chain.

## 3. Glossary & Translation Memory (USP)

- A `translation_memory` table (Phase 2): `siteId`, `sourceLang`, `targetLang`, `source`, `target`, `context`.
- Glossary: fixed terms that must not be translated.

## 4. Machine translation plug-in

- An `MTProvider` interface: `translate(text, from, to, glossary?)`.
- Built-in: DeepL, OpenAI, Workers AI. Configured in Settings.
- The editor gets a "Translate from <lang>" button → calls MT and marks the result `status: machine-translated` for a reviewer to approve.

## 5. Workflow status per locale

- Every translated value carries a `status`: `missing | machine | draft | review | approved`.
- The list view shows a badge with the translation completion percentage.

## 6. API

- `GET /translations?namespace=ui&language=vi`
- `POST /translations/bulk` (upsert)
- `POST /translations/auto` with body `{ collection, item, fromLocale, toLocale }` → returns candidates.

## 7. UI

- The **Translations** module:
  - *UI Strings* tab — a key/value table per locale, with search and a missing-only filter.
  - *Content* tab — pick a collection → an item × locale matrix → click a cell to open the editor.
  - *Glossary* tab.
  - *Memory* tab.
- Item editor: locale tabs down the left side, side-by-side comparison against the default locale.

## 8. Tasks: Phase MVP-C2 (UI strings + JSONB content) → POST-MVP-F (MT, memory).
