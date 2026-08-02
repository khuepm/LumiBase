---
title: Docs i18n Sync
sourceLang: en
version: 2
lastUpdated: 2026-08-02T16:58:45.665Z
contentHash: 62d2d2e9de759062
codeVerified: 2026-08-02T16:58:45.665Z
codeVerifiedHash: 62d2d2e9de759062
codeVerifiedClaims: 10
---

# Documentation i18n Sync (EN ⇄ VI)

LumiBase ships docs in two locales: `docs/en` (canonical) and `docs/vi`. The
i18n sync tooling under `scripts/docs-i18n/` keeps them aligned, detects when a
file is written in the wrong language, reports which pairs are out of sync, and
stamps every managed file with a version and update timestamp.

**Translations are written by hand, not machine-translated.** A person — in
practice an LLM reading the source document in the editor — writes the target
side, then `stamp-pair.mjs` records the provenance. This is a deliberate project
decision (cost, plus reviewable quality over an unsupervised pipeline); it is
recorded in `docs/.i18n/TASKS.md` §6. There is **no `ANTHROPIC_API_KEY` secret
in CI and none is wanted**, so nothing in this repository translates
automatically.

The machine-translation path (`--apply`, Anthropic Messages API) still exists in
the code for anyone who reverses that decision, but it is unused: without a key
it now **fails loudly** instead of quietly doing nothing. For a while it did the
quiet thing, and CI committed "sync en/vi translations" on every docs push while
translating nothing at all.

## What it does

1. **Language detection.** A heuristic detector (`lang-detect.mjs`) classifies
   each doc as `vi` or `en` from its prose, ignoring code blocks, links and
   front matter. It is tuned for the vi/en pair only.
2. **Source-of-truth resolution.** Per file pair the tooling decides which side
   is authored content and which is a translation. A file under `docs/en` that
   actually contains Vietnamese is treated as Vietnamese-authored.
3. **No-loss preservation.** When an `en` file holds Vietnamese and there is no
   `docs/vi` counterpart, that Vietnamese content is copied into `docs/vi`
   *before* the `en` side is ever rewritten in English. When a Vietnamese `en` file
   conflicts with an existing, different `docs/vi` file, the tooling does **not**
   overwrite anything — it copies the at-risk content to
   `docs/.i18n/preserved/` and flags a conflict for manual review.
4. **Translation planning.** Stale or missing targets are listed as pending work
   — the tooling reports *what* needs translating and in which direction; a human
   writes the text. (The unused `--apply` path would translate with markdown-safe
   placeholder protection, so code, links, inline code and HTML are never sent to
   an API.)
5. **Versioning.** Each written file gets front matter: `version`,
   `lastUpdated`, `sourceLang`, `translatedFrom`, `sourceHash`, `mtEngine`, and
   `syncStatus`. A target is considered stale only when the source `sourceHash`
   changes, so re-stamping is idempotent and the two locales' version numbers
   stay comparable.
6. **Audit trail.** Every run appends to `docs/i18n-sync-log.md` and writes a
   machine-readable `docs/.i18n/last-report.json`.

## Running it

```bash
# Detect only — classify files, write log + report, change no docs.
pnpm docs:i18n:detect

# Preserve at-risk Vietnamese content + stamp versions, but do not translate.
pnpm docs:i18n:preserve

# Not used by this project: needs ANTHROPIC_API_KEY and exits 2 without one.
pnpm docs:i18n:sync
```

Translating a file by hand — the actual workflow — is four steps:

```bash
# 1. Read docs/<src>/<rel>, write the translation into docs/<tgt>/<rel>.
# 2. Check the doc's claims against the source tree (mandatory before stamping).
pnpm docs:i18n:verify <rel>

# 3. Record provenance for both locales (never hand-write this front matter).
node scripts/docs-i18n/stamp-pair.mjs <rel> <en|vi> --verified

# 4. Confirm the pair now reads up-to-date, then drop the machine artifacts.
pnpm docs:i18n:detect
git checkout -- docs/.i18n/last-report.json docs/i18n-sync-log.md
```

`--verified` refuses to write the `codeVerified` marker while any claim is stale,
and also refuses when a doc makes no testable claim at all — "nothing to check"
is not a pass, so such a file is stamped without the marker and needs a human
read. Per-file rules and the outstanding backlog live in `docs/.i18n/TASKS.md`.

Environment variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key — only for the unused `--apply` path | — |
| `ANTHROPIC_MODEL` | Claude model id | `claude-sonnet-4-6` |
| `ANTHROPIC_BASE_URL` | API base URL (proxy override) | `https://api.anthropic.com` |
| `ANTHROPIC_MAX_TOKENS` | Max output tokens per request | `8192` |
| `DOCS_ROOT` | Override docs root (testing/CI) | repo `docs/` |

Without an API key, `--apply` exits `2` and points you at `docs:i18n:detect` /
`docs:i18n:preserve`. It does not fall back silently.

## CI

`.github/workflows/docs-i18n-sync.yml` runs on changes under `docs/**` or
`scripts/docs-i18n/**`:

- **Pull requests:** detect-only. Uploads the report as an artifact; writes
  nothing.
- **Push to `main`:** preservation + version stamps, committed back. It does
  **not** translate, and the outstanding-pair count is echoed into the job
  summary so the backlog stays visible.

No repository secret is involved. Translations land through pull requests, by
hand, in the same commit as the change that made them necessary — see the
bilingual-docs rule in `CLAUDE.md`.

## Front-matter fields

| Field | Meaning |
|-------|---------|
| `version` | Integer, bumped when content changes |
| `lastUpdated` | ISO-8601 timestamp of the last write |
| `sourceLang` | Authored language of this file |
| `translatedFrom` | Source locale a translated file came from |
| `sourceHash` | Hash of the source body the translation was built from |
| `contentHash` | Hash of an authored file's own body (change detection) |
| `mtEngine` | How the translation was produced: `manual` (hand-written, current) or `claude` (legacy `--apply` output) |
| `syncStatus` | `human-translated` (current), or `machine-translated` / `needs-review` from the legacy path |
| `codeVerified` | Timestamp at which the doc's code-facing claims were checked |
| `codeVerifiedHash` | Body hash the check was pinned to — editing the body invalidates the assurance |

`syncStatus`/`sourceHash` answer "do both locales describe the same source
revision?"; `codeVerified` answers "were this doc's claims about the repository
checked?". Two separate questions: two translations can agree perfectly and be
wrong together. A full match needs both markers.

The docs viewer reads `lastUpdated` for the displayed "last modified" date,
falling back to filesystem mtime when the field is absent.

## Limitations

- Detection is heuristic, not a statistical language model; borderline files
  (mostly English with a few Vietnamese terms) may need a manual `sourceLang`
  stamp.
- The default authoring direction for an in-sync pair is `en → vi`. Files
  authored in Vietnamese under `docs/en` are detected and handled, but routine
  pairs assume English is canonical.
- Translation throughput is human, so a large backlog clears slowly: run
  `pnpm docs:i18n:detect` for the current count rather than assuming CI caught up.
- Legacy `machine-translated` pages predate the manual policy and have not all
  been proofread.
