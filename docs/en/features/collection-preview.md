---
version: 2
lastUpdated: 2026-09-01T19:25:54.674Z
sourceLang: vi
translatedFrom: vi
sourceHash: 17fd5198b3a06b2c
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-09-01T19:25:54.674Z
codeVerifiedHash: 17fd5198b3a06b2c
codeVerifiedClaims: 20
---

# Collection Preview (iframe)

> Preview = embedding an `<iframe>` in Studio's record editor, pointed at a URL template configured on the collection and interpolated with the fields of the record being edited — so an author can see the real website inside the admin. Inspired by Directus' Live Preview feature.

**Status:** design proposal (not implemented). No migration needed for the MVP.

## 1. The idea

Each collection configures **one URL template**, for example:

```
https://staging.mysite.com/blog/{{slug}}
https://mysite.com/posts/{{id}}?preview=1
```

When a user opens a record editor, Studio interpolates the template with the record's field values (client-side, reusing the existing Mustache renderer) and embeds the resulting URL in an `<iframe>` beside the form. Change a field → the iframe reloads (debounced).

The key security point: **the URL template (configured by an editor) is separate from the origin allowlist (configured by an operator via env)**. The editor picks the *path*; the operator decides *which origins may be embedded*. Even if an editor account is compromised, the iframe still cannot point at an unfamiliar origin to phish or leak a token.

## 2. Data model

No new column, no migration. Use `collections.meta` (the jsonb "UI hints" blob, `packages/database/src/schema/cms.ts`) with a new `preview` namespace — the same pattern as the existing `meta.systemFields` (`schema-service.ts`). The data already round-trips: DB → `CompiledCollection.meta` → SDK `Collection.meta` → Studio, with no route/service/diff changes needed.

```jsonc
// collections.meta
{
  "preview": {
    "enabled": true,
    "url": "https://staging.mysite.com/blog/{{slug}}",
    "refreshField": "*",       // "*" = reload on any field change; or a single field name
    "width": "responsive"       // responsive | mobile | desktop
  }
}
```

Zod (placed in `packages/contracts/src/schemas/`, exported for both CMS and Studio):

```ts
export const previewConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().max(2048).default(''),   // Mustache template
  refreshField: z.string().default('*'),
  width: z.enum(['responsive', 'mobile', 'desktop']).default('responsive'),
});
```

> Alternative (not chosen for the MVP): a dedicated `previewUrl text('preview_url')` column mirroring `displayTemplate` across `CollectionInput` / `collectionInputSchema` / `CollectionConfigSchema` (`.strict()`) / the compiled shape / `buildSchemaDiff`. More typed and discoverable, but considerably more work and it needs a migration.

## 3. Render flow (Studio, React)

```
draft record (item-detail.tsx state)
  ─► interpolate(meta.preview.url, draft)      // Mustache client-side
  ─► validate origin ∈ PREVIEW_ALLOWED_ORIGINS // defense-in-depth
  ─► <iframe src={resolvedUrl} sandbox=... />
```

- **UI:** add a `preview` tab to the tab set in `apps/studio/src/modules/content/item-detail.tsx` (currently `'fields' | 'revisions' | 'versions' | 'raw'`). Shown only when `meta.preview.enabled`. The toggle sits next to the Share button in the toolbar.
- Interpolation is entirely client-side (no extra API call) — reusing the renderer shared with `content/mustache-template-editor.tsx` and `displays/mustache.tsx`.
- Debounce the iframe reload as `draft` changes (~500ms), honouring `refreshField`.
- Show the resolved URL plus an "Open in new tab" button. An empty field renders as `[fieldName]` so the author can see what data is missing.
- The preview **must** be a first-class component and must NOT pass through `sanitize-html` (the sanitizer strips iframe tags).

## 4. iframe security

Two trust layers:

| Layer | Who controls it | Risk if left open |
|---|---|---|
| **URL template** (`meta.preview.url`) | an editor with data-model edit rights | point the iframe at an unfamiliar origin → phishing inside the admin, token leakage via Referer, tabnabbing |
| **Origin allowlist** (env) | operator/DevOps at deploy time | — (this is the hard boundary) |

### 4.1 Origin allowlist via env

Add a variable (matching the `CORS_ALLOWED_ORIGINS` and `EXTENSION_BUNDLE_ORIGINS` precedent in `apps/cms/src/env.ts`):

```
# comma-separated for multiple origins
PREVIEW_ALLOWED_ORIGINS=https://staging.mysite.com,https://mysite.com
```

- Declare it in `Bindings` (`env.ts`) and set it per environment in `apps/cms/wrangler.toml` (`[env.staging.vars]` / `[env.production.vars]`).
- Parse it with the existing `parseAllowedOrigins` (`apps/cms/src/config/cors.ts`, already tested).
- **Production guard:** validate in `apps/cms/src/config/production.ts` — forbid `*` when `LUMIBASE_ENV=production` (same as `CORS_ALLOWED_ORIGINS`).

**Two-tier enforcement:**

1. **Backend (source of truth):** when saving `meta.preview.url`, parse the template's origin and reject it if it is not in the allowlist → `VALIDATION_FAILED`. This stops a bad configuration from ever being stored.
2. **Frontend (defense-in-depth):** Studio receives the allowlist (exposed through the existing public config endpoint, never hard-coded) so it can (a) render the iframe only for a valid origin and (b) stay consistent with the `frame-src` CSP.

### 4.2 CSP `frame-src` — **required**

`apps/cms/src/middleware/security-headers.ts` currently sets `default-src 'none'` and has **no `frame-src`** → every remote iframe is blocked. A `frame-src` directive set to the allowlist must be added:

```ts
'frame-src': parseAllowedOrigins(env.PREVIEW_ALLOWED_ORIGINS),
```

- `serializeContentSecurityPolicy` is currently a static const and does not read `c.env`. The env needs threading into the middleware (only for building this directive).
- Do **NOT** touch `frame-ancestors 'none'` or `X-Frame-Options: DENY` — those protect Studio *from being* embedded (anti-clickjacking) and have nothing to do with Studio *doing* the embedding.
- **Deploy topology:** if Studio is served standalone on Cloudflare Pages (not through the CMS worker — see `apps/studio/src/lib/api-base.ts`), the `frame-src` CSP must be added on the Pages side (`_headers`). If the CMS worker serves the Studio HTML (marked `responseType: 'STUDIO_HTML'` via `admin-path-guard.ts`), `frame-src` can be applied to that surface alone.

### 4.3 Hardened iframe attributes

```html
<iframe
  src={resolvedUrl}
  sandbox="allow-scripts allow-same-origin allow-forms"
  referrerpolicy="no-referrer"
  loading="lazy"
  allow="" />
```

- `referrerpolicy="no-referrer"` → the admin URL (which may contain an id or token) never leaks to the preview site.
- Minimal `sandbox`. `allow-scripts` + `allow-same-origin` are only safe because the preview origin is always **different** from Studio's origin (guaranteed by the allowlist holding external origins) — the iframe cannot reach back into Studio.
- `allow=""` disables camera/mic/geolocation.
- **Never** put an access token or API key in the URL template — only interpolate the record's fields.

## 5. Configuration UX

In the collection settings screen (`apps/studio/src/modules/data-model/detail.tsx`, adding a "Preview" tab alongside `display`/`archive`/`raw`), copying the pattern from `display-tab.tsx`:

- An **Enable preview** toggle.
- A URL input that **reuses `MustacheTemplateEditor`**: field autocomplete on `{{`, with a live URL preview against a sample record.
- An origin outside the allowlist → an inline warning that states the fix directly: *"Origin not allowed yet. Ask your operator to add it to `PREVIEW_ALLOWED_ORIGINS`."*
- A Responsive / Mobile / Desktop frame selector.

## 6. Implementation scope

**Stage 1 (MVP):**

1. `packages/contracts`: `previewConfigSchema`.
2. `apps/cms`: the `PREVIEW_ALLOWED_ORIGINS` env (`env.ts` + `wrangler.toml`) · origin validation when saving `meta.preview.url` · the production guard · exposing the allowlist to Studio · `frame-src` CSP in `security-headers.ts`.
3. `apps/studio/data-model`: the Preview configuration tab (reusing the Mustache editor).
4. `apps/studio/content`: the Preview tab in `item-detail.tsx` plus the iframe component (sandbox + debounced reload).
5. Docs + the Setup Impact Registry (`.kiro/specs/admin-setup-wizard/setup-impact.md`) per the Definition of Done.

**Stage 2 (optional):**

- **Draft preview token:** a short-lived, read-only preview secret issued by the CMS for a preview session (NOT the admin session token) so the frontend can render the draft version — like Directus'/Next.js' preview mode.
- **postMessage:** sync scroll / hot-reload without reloading the whole iframe.

## 7. Compared with Directus

| | Directus | LumiBase (proposed) |
|---|---|---|
| Storage | `collections.preview_url` (meta) | `collections.meta.preview.url` |
| Template | `{{ field }}` | Mustache `{{ field }}` (reusing the display template) |
| Origin blocking | (no env allowlist) | `PREVIEW_ALLOWED_ORIGINS` + `frame-src` CSP + validation on save |
| Draft | preview mode + token | Stage 2 |
