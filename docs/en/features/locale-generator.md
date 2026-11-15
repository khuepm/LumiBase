---
version: 2
lastUpdated: 2026-11-15T19:56:17.582Z
sourceLang: en
contentHash: eaf803d4e34db9d2
codeVerified: 2026-11-15T19:56:17.582Z
codeVerifiedHash: eaf803d4e34db9d2
codeVerifiedClaims: 20
---

# Locale generator

**Settings → Localization → Add a locale** (`/settings/locale-generator`) sets up a new locale in one
step: it adds the locale to the site's `locales` setting, then translates every missing value of the
chosen collections and the site's UI strings into a **review queue** (#714, epic #671 A06).
Nothing machine-translated reaches content until a reviewer approves it.

## How a value is translated

For every item of each chosen collection, every `translatable-text` field whose map has text in the
source locale and nothing in the new locale becomes one suggestion. UI strings are rows of the
`translations` table in the `ui` namespace with no row in the new locale.

Each value goes through the existing [translation memory](./translation-memory.md) pipeline:
translation memory first (a hit at or above the default threshold is used as is, `origin: tm`), then
the glossary and the MT provider (`origin: mt`, with the provider recorded). The provider is the one
named in the request, else Workers AI when the binding exists, else the first configured provider
(`DEEPL_API_KEY`, `OPENAI_API_KEY`). With no provider configured the request is refused with
`PROVIDER_UNAVAILABLE`; the `echo` test provider is used only when asked for by name.

## Jobs

`POST /api/v1/locale-generation/jobs` with `{ locale, sourceLocale?, collections, includeUi?, provider? }`
validates the request (`VALIDATION`, `NO_TRANSLATABLE_FIELDS`, `409 JOB_ACTIVE` when the locale
already has a running job), scaffolds the locale setting and returns `202` with the job. The request
drives the job for up to 20 seconds; a minute tick on both Docker (`serve.ts`) and Cloudflare
(`cloudflare.ts`) resumes it from its cursor whenever its lease is free, so a restart never repeats or
skips a chunk. Progress (`counters`: items, suggestions, from memory, machine, skipped, failed) and the
review state of its suggestions are on `GET /jobs/:id`. `POST /jobs/:id/cancel` stops a running job
between chunks; `POST /jobs/:id/resume` re-queues a failed or cancelled one at its cursor. A value that
fails to translate is counted and the job continues; an unknown provider fails the job.

A suggestion is unique per site, target and locale, so running the generator again only queues what
is still missing.

## Review

`GET /api/v1/locale-generation/suggestions?locale=…&status=pending` lists the queue with its
provenance (`origin`, `provider`, `tmScore`, `jobId`). `POST /suggestions/:id/decide` with
`{ decision: 'approve', text? }` or `{ decision: 'reject' }` applies one decision;
`POST /suggestions/decide-bulk` applies up to 200.

Approval re-reads the item **with the reviewer's own permissions** and writes the new locale into the
field's map through the item service, so field permissions, validation, pinned fields, revisions and
the audit log all apply. It is refused as `stale` (and nothing is written) when the source text
changed since the suggestion was made or someone already wrote the new locale. A write the item
service refuses leaves the suggestion pending (`422`). An approved UI string becomes a `translations`
row. Every approved value is added to translation memory (`source: human` when the reviewer edited
it), so the next run reuses it.

## Access

`/api/v1/locale-generation` is a control-plane prefix: only site administrators reach it. Source texts
are read on the job's connection, scoped to the site; content is written only on approval, as the
reviewer.

## Multi-tenancy

Jobs and suggestions carry `site_id` and are in `rls-policies.sql`; every query is filtered by the
request's site, and the resume tick handles each job within its own site. Verified by
`locale-generation.db.integration.test.ts` (real PostgreSQL, two sites, fake MT provider).
