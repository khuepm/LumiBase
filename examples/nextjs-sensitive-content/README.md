# Next.js — Sensitive / Regulated Content example

A reference frontend for a **Tier 2** LumiBase project (regulated/sensitive
content, e.g. a health app's public marketing site backed by the same CMS that
stores PHI/PII). It demonstrates the *public* surface only and the hard
boundary between public content and sensitive data.

What it shows:

- **Publish_Window** — the list/detail pages fetch `status=published` items; the
  Delivery API excludes items whose `publishAt` is in the future or whose
  `unpublishAt` has elapsed, so the frontend never reasons about scheduling.
- **Structured SEO/AIO** — `generateMetadata` maps the Delivery API's `_seo`
  block via the SDK's `toNextMetadata`, and a `<script type="application/ld+json">`
  tag renders `jsonLdScript(item)` (schema.org).
- **ISR by tag** — `export const revalidate = 60`; pair with a LumiBase
  revalidation target so publish/unpublish/erasure purge the `articles` tag.

## Setup

```bash
cp .env.example .env.local
# fill in LUMIBASE_URL, LUMIBASE_TOKEN, LUMIBASE_SITE_ID
pnpm install
pnpm --filter example-nextjs-sensitive-content dev
```

## Security boundaries (read this)

This is a **public** frontend. Treat the token and schema accordingly:

1. **Never put a `read_decrypted` token here.** Fields classified `pii`/`phi`
   are encrypted and masked (`***`) for any caller without `read_decrypted`.
   Decrypting them is an *audited, server-side, authenticated* operation — it
   does not belong in a public site. Use a token scoped to public read only.
2. **Never render `pii`/`phi` fields on a public page.** This example's schema
   (`src/lib/lumi.ts`) deliberately contains only public fields. Sensitive
   fields live in separate, access-controlled collections/fields and are not
   fetched here.
3. **The `_seo` block is leak-safe.** The builder skips masked (`***`) and
   ciphertext values, so a misconfigured field can't leak through SEO — but
   you should still never map a sensitive field into `seo`.

## Environment variables

| Variable           | Purpose                                            |
|--------------------|----------------------------------------------------|
| `LUMIBASE_URL`     | LumiBase API base URL                              |
| `LUMIBASE_TOKEN`   | **Public-scoped** bearer token / API key           |
| `LUMIBASE_SITE_ID` | Tenant site id                                     |
