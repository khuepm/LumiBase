# Dependency Overrides & Patches

This document tracks every `pnpm.overrides` pin and `pnpm.patchedDependencies` patch
in the root [`package.json`](../../../package.json), why each exists, and the condition
under which it can be safely removed.

> **Why this file exists:** overrides and patches are invisible footguns — they silently
> change what version of a transitive dependency the whole workspace resolves. Without a
> record of *why*, a future maintainer can't tell a deliberate security pin from leftover
> cruft, and removing one can silently reintroduce a vulnerability. Update this table
> whenever you add, change, or remove an entry under the `pnpm` key in `package.json`.

## How overrides work here

- **`pnpm.overrides`** force a single resolved version of a package across the entire
  workspace, including transitive dependencies that requested a different (often
  vulnerable) range.
- **`pnpm.patchedDependencies`** apply a local source patch to an installed package.
  Patches live in [`patches/`](../../../patches/) and are referenced by exact version.
  Regenerate with `pnpm patch <pkg>@<version>` → edit → `pnpm patch-commit <dir>`.

After changing either, run `pnpm install` so the lockfile (`pnpm-lock.yaml`) records the
new resolution / patch hash.

## Overrides registry

| Package | Pinned to | Reason | Remove when |
| --- | --- | --- | --- |
| `js-yaml` | `^4.2.0` | [CVE-2026-53550](https://github.com/advisories/GHSA-h67p-54hq-rp68) — quadratic-complexity DoS in YAML merge-key handling (moderate). Pulled in transitively by `gray-matter@4.0.3`, which hard-pins js-yaml 3.x. See the patch note below. | `gray-matter` (or whatever consumes it) depends on js-yaml `>=4.2.0` directly, **and** no other dependency reintroduces a 3.x range. Verify with `pnpm why js-yaml`. |
| `dompurify` | `^3.4.11` | Security advisory (resolved via Dependabot). | A direct/transitive consumer requires `>=3.4.11` on its own. |
| `esbuild` | `^0.28.1` | esbuild dev-server request RCE advisory (`<=0.24.2`). | All consumers (vite, tsx, etc.) require `>=0.28.1`. |
| `form-data` | `^4.0.6` | Security advisory (unsafe random boundary). | All consumers require `>=4.0.6`. |
| `postcss` | `^8.5.14` | Security advisory (resolved via Dependabot). | All consumers require `>=8.5.14`. |
| `undici` | `^7.28.0` | Security advisory (resolved via Dependabot). | All consumers require `>=7.28.0`. |
| `uuid` | `^11.1.1` | Version unification / advisory (resolved via Dependabot). | Version drift across packages is no longer a concern. |
| `vite` | `^7.3.5` | Unify on Vite 7 and pull esbuild past the `0.28.1` RCE advisory. | The workspace no longer needs a single forced Vite major. |
| `@types/react` | `18.3.3` | **Not a security pin** — enforces React 18 types workspace-wide to prevent type drift between apps. | The workspace migrates to a single React major where drift can't occur. |
| `@types/react-dom` | `18.3.0` | Same as `@types/react` — React 18 type consistency. | Same as `@types/react`. |

## Patches registry

### `gray-matter@4.0.3` → [`patches/gray-matter@4.0.3.patch`](../../../patches/gray-matter@4.0.3.patch)

**What it does:** rewrites gray-matter's YAML engine
(`lib/engines.js`) from the removed `yaml.safeLoad` / `yaml.safeDump` to
`yaml.load` / `yaml.dump`.

**Why it's needed:** `gray-matter@4.0.3` is the latest published release and is effectively
unmaintained. It hard-pins `js-yaml@^3.13.1` and calls `safeLoad`/`safeDump`. Those
functions were **removed** in js-yaml 4.x (where `load`/`dump` are safe by default — and
where `safeLoad` is a stub that *throws*). Because the `js-yaml: ^4.2.0` override (above)
upgrades js-yaml tree-wide to fix [CVE-2026-53550](https://github.com/advisories/GHSA-h67p-54hq-rp68),
gray-matter would crash at parse time without this patch. gray-matter is used only at
build/dev time in [`apps/docs`](../../../apps/docs/src/plugins/vite-plugin-docs-loader.ts)
to parse trusted, repo-owned Markdown front matter.

**Remove when:** `gray-matter` publishes a release compatible with js-yaml `>=4.2.0`
(at which point drop both the override-driven need and this patch), **or** `apps/docs`
stops using `gray-matter` (e.g. replaced with a small in-repo front-matter parser calling
js-yaml 4.x `load()` directly). After removing, delete this section, the
`patchedDependencies` entry in `package.json`, and the patch file, then re-run
`pnpm install`.

## Dependabot note

`js-yaml` will keep surfacing as an *unfixable* transitive alert as long as `gray-matter`
exists in the tree, because Dependabot can't upgrade `gray-matter` past 3.x's js-yaml
constraint on its own — the override + patch above are what actually resolve it. If the
recurring alert becomes noisy, dismiss it on GitHub as **"this advisory is resolved via a
pnpm override + patch"** (link this doc), rather than ignoring the package wholesale — a
blanket ignore would also hide a *future, genuinely unpatched* js-yaml advisory.
