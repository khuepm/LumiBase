---
title: Docs i18n Sync
sourceLang: en
---

# Documentation i18n Sync (EN ⇄ VI)

LumiBase ships docs in two locales: `docs/en` (canonical) and `docs/vi`. The
i18n sync tooling under `scripts/docs-i18n/` keeps them aligned, detects when a
file is written in the wrong language, translates stale or missing targets, and
stamps every managed file with a version and update timestamp.

Translation is performed by Claude (the Anthropic Messages API) — there are no
third-party machine-translation services. Translation runs in CI where the
`ANTHROPIC_API_KEY` lives as a secret; locally you can run detection (and the
no-loss preservation step) without any key.

## What it does

1. **Language detection.** A heuristic detector (`lang-detect.mjs`) classifies
   each doc as `vi` or `en` from its prose, ignoring code blocks, links and
   front matter. It is tuned for the vi/en pair only.
2. **Source-of-truth resolution.** Per file pair the tooling decides which side
   is authored content and which is a translation. A file under `docs/en` that
   actually contains Vietnamese is treated as Vietnamese-authored.
3. **No-loss preservation.** When an `en` file holds Vietnamese and there is no
   `docs/vi` counterpart, that Vietnamese content is copied into `docs/vi`
   *before* anything translates over the `en` file. When a Vietnamese `en` file
   conflicts with an existing, different `docs/vi` file, the tooling does **not**
   overwrite anything — it copies the at-risk content to
   `docs/.i18n/preserved/` and flags a conflict for manual review.
4. **Machine translation.** Stale or missing targets are translated with
   markdown-safe placeholder protection (code, links, inline code and HTML are
   never sent to the translator).
5. **Versioning.** Each written file gets front matter: `version`,
   `lastUpdated`, `sourceLang`, `translatedFrom`, `sourceHash`, `mtEngine`, and
   `syncStatus` (`machine-translated` or `needs-review`). Re-translation only
   happens when the source `sourceHash` changes, so output is stable.
6. **Audit trail.** Every run appends to `docs/i18n-sync-log.md` and writes a
   machine-readable `docs/.i18n/last-report.json`.

## Running it

```bash
# Detect only — classify files, write log + report, change no docs.
pnpm docs:i18n:detect

# Preserve at-risk Vietnamese content + stamp versions, but do not translate
# (safe to run without an API key).
pnpm docs:i18n:preserve

# Full sync: preserve + translate with Claude + version. Needs ANTHROPIC_API_KEY.
ANTHROPIC_API_KEY=*** pnpm docs:i18n:sync
```

Environment variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (required to translate) | — |
| `ANTHROPIC_MODEL` | Claude model id | `claude-sonnet-4-6` |
| `ANTHROPIC_BASE_URL` | API base URL (proxy override) | `https://api.anthropic.com` |
| `ANTHROPIC_MAX_TOKENS` | Max output tokens per request | `8192` |
| `DOCS_ROOT` | Override docs root (testing/CI) | repo `docs/` |

Without an API key, `--apply` automatically degrades to preservation +
versioning and records why in the log.

## CI

`.github/workflows/docs-i18n-sync.yml` runs on changes under `docs/**` or
`scripts/docs-i18n/**`:

- **Pull requests:** detect-only. Uploads the report as an artifact; writes
  nothing.
- **Push to `main`:** full sync, then commits the result back.

Configure `ANTHROPIC_API_KEY` as a repository secret for translation to run.

## Front-matter fields

| Field | Meaning |
|-------|---------|
| `version` | Integer, bumped when content changes |
| `lastUpdated` | ISO-8601 timestamp of the last write |
| `sourceLang` | Authored language of this file |
| `translatedFrom` | Source locale a translated file came from |
| `sourceHash` | Hash of the source body the translation was built from |
| `contentHash` | Hash of an authored file's own body (change detection) |
| `mtEngine` | Engine used (`claude`) |
| `syncStatus` | `machine-translated` or `needs-review` |

The docs viewer reads `lastUpdated` for the displayed "last modified" date,
falling back to filesystem mtime when the field is absent.

## Limitations

- Detection is heuristic, not a statistical language model; borderline files
  (mostly English with a few Vietnamese terms) may need a manual `sourceLang`
  stamp.
- The default authoring direction for an in-sync pair is `en → vi`. Files
  authored in Vietnamese under `docs/en` are detected and handled, but routine
  pairs assume English is canonical.
- Translations are produced by Claude and `needs-review` output should be
  proofread before release.
- Each document is translated in a single request; very long docs may hit the
  `ANTHROPIC_MAX_TOKENS` limit and need a higher value (the run fails loudly
  rather than writing a truncated file).
