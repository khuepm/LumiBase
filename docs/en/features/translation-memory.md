---
version: 1
lastUpdated: 2026-07-25T08:19:21.358Z
sourceLang: vi
translatedFrom: vi
sourceHash: 26e55f9bc5735338
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:19:21.358Z
codeVerifiedHash: 26e55f9bc5735338
codeVerifiedClaims: 14
---

# Translation Memory + Glossary + MT Providers

POST-GA1: support a content translation workflow with Translation Memory (TM), a glossary, and a chain of machine-translation providers.

## Tables

### `translation_memory`

| Column | Description |
|--------|-------------|
| `sourceLang` / `targetLang` | Source/target language |
| `sourceText` / `targetText` | The text pair |
| `context` | Optional — e.g. `posts.title`, `glossary` |
| `quality` | 0-100 (TM matches ≥85 are usually good enough to auto-apply) |
| `source` | `human` / `mt` / `imported` |
| `provider` | When `source='mt'`: `deepl`, `openai`, `workers-ai` |
| `hits` | Counter — incremented every time the entry is reused |

### `glossary`

| Column | Description |
|--------|-------------|
| `term` | A term that must be translated consistently |
| `translation` | The official translation |
| `rule` | `do-not-translate` / `prefer` / `forbidden` |
| `note` | Internal note |

The glossary has **higher priority** than a fuzzy TM match.

## API endpoints

```
GET  /api/v1/tm                      List/search TM entries
POST /api/v1/tm                      Upsert a TM entry (learn from a translation)
POST /api/v1/tm/lookup               Find fuzzy matches for a source string
POST /api/v1/tm/translate            Run the MT pipeline: TM → glossary → provider
```

Implementation: `apps/cms/src/routes/translation-memory.ts` plus the `apps/cms/src/services/translation-memory.ts` service.

## MT pipeline

`POST /api/v1/tm/translate` with body `{ sourceText, sourceLang, targetLang, context?, providers? }`.

Processed in order:

1. **TM exact match** — if an entry exists with an exact `sourceText` and `quality≥85`, return it immediately (and increment `hits`).
2. **TM fuzzy match** — find the best match by edit distance; return it if `quality≥75`.
3. **Glossary substitution** — pre-processing: substitute glossary terms before calling MT.
4. **MT provider chain** — call providers in configured order:
   - **DeepL** (when `DEEPL_API_KEY` is set) — high quality for European languages.
   - **OpenAI** (when `OPENAI_API_KEY` is set) — flexible, good at understanding context.
   - **Workers AI** (when a CF AI binding exists) — runs on-edge, free for light usage.
   - **Echo fallback** — always available for dev (returns `[ECHO]: <sourceText>`).
5. **Persist** — the result is upserted into TM with `source='mt'` and the `provider`.

## Configuration

```bash
DEEPL_API_KEY=...        # Optional
OPENAI_API_KEY=...       # Optional
# Cloudflare injects the AI binding automatically when wrangler.toml has ai = { binding = "AI" }
```

## Studio UI

The Translations module (`apps/studio/src/modules/translations/index.tsx`) integrates:

- The UI strings tab and the Content tab.
- Inline TM suggestions while editing a translatable field.
- Glossary management.
- Bulk translate with a progress bar.

## Multi-tenancy

Every `translation_memory` and `glossary` query is scoped by `siteId`. Indexed on `(siteId, sourceLang, targetLang)`.

## Privacy

- The OpenAI / DeepL providers send text to a third party — an admin can disable them per site via `settings.translation.providers.disabled`.
- Workers AI runs on the Cloudflare edge and sends nothing outside.
