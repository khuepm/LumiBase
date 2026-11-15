---
title: Self-healing docs
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:50:12.145Z
contentHash: c645cb899aef55d3
codeVerified: 2026-11-15T16:50:12.145Z
codeVerifiedHash: c645cb899aef55d3
codeVerifiedClaims: 14
---

# Self-healing docs (doc/code drift)

Docs in LumiBase make claims about the code: a file lives at a path, an endpoint
is mounted, an env var is read, a function is exported. When the code changes,
those claims go stale silently — and because EN and VI are translated from each
other, both locales go stale *together*, which no hash comparison can notice.

The self-heal tooling closes that gap in two places:

| Where | What | Fails / writes |
|---|---|---|
| Every pull request | `gate-code-drift.mjs` — finds docs the PR made stale | Fails the check, with an annotation on the doc line |
| Every push to `main` (and manual dispatch) | `self-heal.mjs` — rewrites the mechanical drift | Opens or updates one PR on `docs/self-heal` |

Both live in `scripts/docs-i18n/` and run in `.github/workflows/docs-self-heal.yml`.

**Everything here is deterministic.** There is no model call, no translation and
no `ANTHROPIC_API_KEY` — the same project decision as the rest of the docs i18n
tooling (see [Docs i18n Sync](./docs-i18n.md)). "Healing" only ever rewrites
code: a path, an env-var name, a route, an identifier. Code is identical in EN
and VI (the structural parity check enforces that), so the same rewrite is
applied to both locales and nothing needs translating.

## The PR gate

The gate diffs the PR against its base with rename detection, then decides which
docs could have gone stale. A doc pair is checked when it:

- was edited in the PR (either locale);
- cites a source file the PR changed, moved or deleted (repo-rooted paths such as
  `apps/cms/src/index.ts`, and relative ones such as `middleware/auth.ts`, which
  resolve the same way the verifier resolves them);
- names an env var the PR stopped reading;
- claims a route whose path uses a segment the PR removed; or
- names, in a code span, an exported symbol the PR removed from a file the doc
  cites.

Each mapped doc is verified at the PR head **and** at the PR base with the same
checks `stamp-pair.mjs --verified` enforces (`verify-code-refs.mjs`). Only
claims that are stale at the head but were fine at the base fail the check — the
drift this PR introduced. Drift that was already on `main` is shown as a warning.

A failure points at the exact line, in the PR's "Files changed" view and in the log:

```text
::error file=docs/en/features/webhooks.md,line=42,title=Stale doc claim (route)::[route] /api/v1/webhooks/:id — no mount found for "webhooks". Cause: route segment "webhooks" renamed to "hooks" in apps/cms/src/index.ts. Mechanical fix available: …
```

The cause is one of: file moved to a new path (git rename), file deleted, env
var renamed or no longer read, route segment renamed or route removed, exported
symbol renamed or removed.

Run it locally against `main`:

```bash
pnpm docs:i18n:drift --base origin/main
pnpm docs:i18n:drift --base origin/main --all   # every doc, not only the mapped ones
```

## The fixers

`self-heal.mjs` rewrites only drift with exactly one correct answer:

| Kind | Example | Source of truth |
|---|---|---|
| File path | `src/old-name.ts` → `src/new-name.ts` | git rename, in the range or anywhere in history |
| Env var | `LUMIBASE_OLD` → `LUMIBASE_NEW` | one removed + one added name in the same source file |
| Route | `/api/v1/old/:id` → `/api/v1/new/:id` | one route literal renamed, one segment different, same method |
| Exported symbol | `oldName()` → `newName()` | one export removed + one added in a file the doc cites |

A rename is only treated as a rename when it is unambiguous — two names removed
and two added could be a swap or a split, and guessing would write a wrong name
into the docs. Those, and every removal (a deleted file, a dropped route, an env
var that is simply gone), are listed under **Needs a human** instead: the
sentence around them has to change, in both locales.

Paths are rewritten wherever they appear as a whole path (code spans, fenced
examples, link targets). Env names are rewritten as whole words. Routes are
rewritten where the claim occurs. Symbols are rewritten only inside code spans of
docs that cite the file. Front matter is never touched.

**Provenance.** After rewriting, a pair is re-stamped with
`stamp-pair.mjs <rel> <sourceLang> --verified` only when it was in sync before
the fix, both locales now verify with zero findings, and stamp-pair's own gates
pass. Otherwise the bodies are fixed but the provenance is left as it was, and the
PR says why — a pair that was waiting for a translator is not marked translated.

Run it locally:

```bash
pnpm docs:i18n:heal --base origin/main --dry-run
pnpm docs:i18n:heal --base origin/main --report /tmp/heal.md
```

## The self-heal PR

On each push to `main` the `heal` job runs the fixers. If anything changed it
force-pushes the result to the `docs/self-heal` branch and opens a pull request,
or edits the one already open — there is only ever one. The PR body lists each
fix (doc and line, old and new value, cause), every stale claim it could not fix,
and which pairs were re-stamped.

- **Idempotent.** The branch is rebuilt from `main` on every run. While the PR is
  open, its body records the revision the drift was measured from, and later runs
  reuse that base, so fixes from earlier pushes are regenerated rather than lost.
- **Never auto-merged.** A human reviews and merges it.
- **Closed automatically** when a run finds nothing left to fix.
- **Least privilege.** The job uses `GITHUB_TOKEN` with `contents: write` and
  `pull-requests: write` only; the PR gate is read-only.

Two repository settings matter. "Allow GitHub Actions to create and approve pull
requests" must be enabled for the job to open the PR. And a PR opened with
`GITHUB_TOKEN` does not trigger other workflows, so CI does not run on it until
someone pushes to the branch or closes and reopens the PR.

## Limits

- Prose is out of scope. If a sentence describes behaviour that changed, no tool
  here notices; only claims the verifier can extract are checked.
- Only the claim forms `verify-code-refs.mjs` recognises are checked (backticked
  repo paths and env names, routes in the forms it parses). A plain-text mention
  is invisible to it.
- Symbol checks need the doc to cite the file the symbol came from; a bare
  identifier is too generic to assert on its own.
