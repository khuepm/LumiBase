# Translation Memory + Glossary + MT Providers

POST-GA1: hỗ trợ workflow dịch nội dung với Translation Memory (TM), Glossary, và machine translation providers theo chain.

## Tables

### `translation_memory`

| Column | Mô tả |
|--------|-------|
| `sourceLang` / `targetLang` | Ngôn ngữ nguồn/đích |
| `sourceText` / `targetText` | Cặp văn bản |
| `context` | Optional — vd `posts.title`, `glossary` |
| `quality` | 0-100 (TM matches ≥85 thường đủ tốt để auto-apply) |
| `source` | `human` / `mt` / `imported` |
| `provider` | Khi `source='mt'`: `deepl`, `openai`, `workers-ai` |
| `hits` | Counter — tăng mỗi lần entry này được tái dùng |

### `glossary`

| Column | Mô tả |
|--------|-------|
| `term` | Term cần dịch nhất quán |
| `translation` | Bản dịch chính thức |
| `rule` | `do-not-translate` / `prefer` / `forbidden` |
| `note` | Ghi chú nội bộ |

Glossary có **priority cao hơn** fuzzy TM.

## API endpoints

```
GET  /api/v1/tm                      List/search TM entries
POST /api/v1/tm                      Upsert TM entry (learn từ một translation)
POST /api/v1/tm/lookup               Find fuzzy matches cho source string
POST /api/v1/tm/translate            Run MT pipeline: TM → glossary → provider
```

Implementation: `apps/cms/src/routes/translation-memory.ts` + service `apps/cms/src/services/translation-memory.ts`.

## MT pipeline

`POST /api/v1/tm/translate` body: `{ sourceText, sourceLang, targetLang, context?, providers? }`.

Xử lý theo thứ tự:

1. **TM exact match** — nếu có entry với `sourceText` chính xác và `quality≥85`, return luôn (tăng `hits`).
2. **TM fuzzy match** — tìm best match qua edit distance, nếu `quality≥75` return.
3. **Glossary substitution** — pre-process: substitute terms từ glossary trước khi gọi MT.
4. **MT provider chain** — gọi providers theo thứ tự config:
   - **DeepL** (nếu có `DEEPL_API_KEY`) — chất lượng cao cho European languages.
   - **OpenAI** (nếu có `OPENAI_API_KEY`) — flexible, hiểu context tốt.
   - **Workers AI** (nếu có CF AI binding) — chạy on-edge, miễn phí cho dùng nhẹ.
   - **Echo fallback** — luôn có sẵn cho dev (return `[ECHO]: <sourceText>`).
5. **Persist** — kết quả được upsert vào TM với `source='mt'` và `provider`.

## Configuration

```bash
DEEPL_API_KEY=...        # Optional
OPENAI_API_KEY=...       # Optional
# AI binding tự động được Cloudflare inject nếu wrangler.toml có ai = { binding = "AI" }
```

## Studio UI

Module Translations (`apps/studio/src/modules/translations/index.tsx`) tích hợp:

- Tab UI strings + Content tab.
- Inline TM suggestion khi đang edit field translatable.
- Glossary management.
- Bulk translate với progress bar.

## Multi-tenancy

Mọi truy vấn `translation_memory` và `glossary` đều scope `siteId`. Index `(siteId, sourceLang, targetLang)`.

## Privacy

- Provider OpenAI / DeepL gửi text ra third-party — admin có thể disable per-site qua `settings.translation.providers.disabled`.
- Workers AI chạy on-Cloudflare-edge, không gửi ra ngoài.
