---
version: 3
lastUpdated: 2026-08-30T16:44:53.762Z
sourceLang: en
contentHash: aee0ac3265b6420f
codeVerified: 2026-08-30T16:44:53.762Z
codeVerifiedHash: aee0ac3265b6420f
codeVerifiedClaims: 6
---

# Dependency Overrides & Patches

This document tracks every `overrides` pin, `patchedDependencies` patch, and
`auditConfig.ignoreGhsas` exclusion, why each exists, and the condition under which it
can be safely removed.

**All three are declared twice, on purpose.** pnpm 9 — the pinned version — reads them
from the `pnpm` key in root [`package.json`](../../../package.json). pnpm 10+ reads them
from [`pnpm-workspace.yaml`](../../../pnpm-workspace.yaml) instead, warning once about
the `package.json` key before ignoring it. Keeping both means a future pnpm bump does not
silently drop the security overrides, the `gray-matter` patch, or the audit ignore
(#295). `pnpm settings:check` fails CI when the two copies drift; when pnpm 9 support
ends, delete the `pnpm` key from `package.json` and that script with it.

> **Why this file exists:** overrides and patches are invisible footguns — they silently
> change what version of a transitive dependency the whole workspace resolves. Without a
> record of *why*, a future maintainer can't tell a deliberate security pin from leftover
> cruft, and removing one can silently reintroduce a vulnerability. Update this table
> whenever you add, change, or remove an entry — **in both files**.

## How overrides work here

- **`overrides`** force a single resolved version of a package across the entire
  workspace, including transitive dependencies that requested a different (often
  vulnerable) range.
- **`patchedDependencies`** apply a local source patch to an installed package.
  Patches live in [`patches/`](../../../patches/) and are referenced by exact version.
  Regenerate with `pnpm patch <pkg>@<version>` → edit → `pnpm patch-commit <dir>`.
- **`auditConfig.ignoreGhsas`** excludes a specific advisory from the
  `pnpm audit --prod --audit-level high` gate in
  [`ci.yml`](../../../.github/workflows/ci.yml). Use this **only** when the advisory is
  structurally inapplicable to how we consume the package and no patched version is
  installable — never to silence a real risk. Every entry needs a row below.

After changing either, run `pnpm install` so the lockfile (`pnpm-lock.yaml`) records the
new resolution / patch hash, then `pnpm settings:check` to confirm the two declarations
still agree.

## Overrides registry

| Package | Pinned to | Reason | Remove when |
| --- | --- | --- | --- |
| `js-yaml` | `^4.3.1` | [CVE-2026-53550](https://github.com/advisories/GHSA-h67p-54hq-rp68) — quadratic-complexity DoS in YAML merge-key handling (moderate), and [GHSA-mxjm-jjmh-r63x](https://github.com/advisories/GHSA-mxjm-jjmh-r63x) — quadratic CPU consumption resolving `!!omap`, unpatched below `4.3.1` (high). Pulled in transitively by `gray-matter@4.0.3`, which hard-pins js-yaml 3.x. See the patch note below. | `gray-matter` (or whatever consumes it) depends on js-yaml `>=4.2.0` directly, **and** no other dependency reintroduces a 3.x range. Verify with `pnpm why js-yaml`. |
| `dompurify` | `^3.4.13` | Security advisory (resolved via Dependabot), then raised for [GHSA-8v5p-ggcr-6q56](https://github.com/advisories/GHSA-8v5p-ggcr-6q56) — an `IN_PLACE` hook removal leaves a detached subtree, allowing sanitizer bypass at `<=3.4.12` (moderate). | A direct/transitive consumer requires `>=3.4.13` on its own. |
| `esbuild` | `^0.28.2` | esbuild dev-server request RCE advisory (`<=0.24.2`). | All consumers (vite, tsx, etc.) require `>=0.28.2`. |
| `form-data` | `^4.0.6` | Security advisory (unsafe random boundary). | All consumers require `>=4.0.6`. |
| `postcss` | `^8.5.26` | Security advisory (resolved via Dependabot). | All consumers require `>=8.5.26`. |
| `nanoid@3` | `^3.3.17` | [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) — a custom generator loops indefinitely when `size` is zero, unpatched below `3.3.17` (high). Reached only transitively: `next` → `postcss` → `nanoid@3`. Scoped to the 3.x range so it cannot raise the floor for the 6.x line `apps/cms` and `packages/database` declare directly. | `postcss` (or whatever consumes it) requires `nanoid >=3.3.17`. Verify with `pnpm why nanoid`. |
| `undici` | `^7.28.0` | Security advisory (resolved via Dependabot). | All consumers require `>=7.28.0`. |
| `ws` | `^8.21.3` | Security advisory (resolved via Dependabot). Declared directly by `apps/cms` for the realtime surface. | `apps/cms` declares `>=8.21.3` itself. |
| `uuid` | `^14.0.1` | Version unification / advisory (resolved via Dependabot). Only one import site exists (`apps/cms/src/modules/audit/worker.ts`, `v7`), so the major carries little surface — but v12+ reshaped the package `exports` map, so bumping it needs a real bundle check, not just a typecheck. | Version drift across packages is no longer a concern. |
| `vite` | `^8.2.0` | Unify on one Vite major and pull esbuild past the `0.28.1` RCE advisory. **This entry is why `pnpm drift:check` exists:** it sat at `^7.3.5` while `apps/studio` and `apps/docs` both declared `^8.1.3`, and because overrides apply to direct dependencies too, both apps were built with Vite 7 for as long as their manifests claimed Vite 8. Raise this in step with the manifests or the bump is cosmetic. | The workspace no longer needs a single forced Vite major. |
| `brace-expansion@1` | `^1.1.16` | [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) — DoS via exponential-time expansion of consecutive non-expanding `{}` groups (high), backported to the 1.x line in `1.1.16`. **Dev-only** — reached through `minimatch@3` from ESLint and its plugins, so it never appears in `pnpm audit --prod`. Keyed per-major (same shape as the `nanoid@3` scope) because two incompatible majors coexist; see [Known-unfixable alerts](#known-unfixable-alerts) for why 1.x cannot be folded into 5.x. | Nothing in the tree resolves `minimatch@3` any more (`pnpm why brace-expansion -r`), at which point both `brace-expansion@*` rows collapse into one. |
| `brace-expansion@5` | `^5.0.8` | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) — DoS via unbounded expansion length causing an OOM process crash (high), patched in `5.0.8`. **Dev-only** — reached through `minimatch@10` from `glob`, `eslint`, `@typescript-eslint/typescript-estree`. Natural drift already lifted most of the tree to `5.0.9`, but `minimatch@10.2.5` still pinned a `5.0.7` copy; this floor removes that straggler. | Same as the `@1` row. |
| `@types/react` | `19.2.18` | **Not a security pin** — enforces React 19 types workspace-wide so Studio/Docs/Landing/`@lumibase/ui` typecheck against the same major as runtime React 19. | Drift between apps is no longer a concern, or the workspace splits React majors again intentionally. |
| `@types/react-dom` | `19.2.4` | Same as `@types/react` — React 19 type consistency. | Same as `@types/react`. |

## Audit ignore registry

| Advisory | Package | Reason | Remove when |
| --- | --- | --- | --- |
| [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) | `react-router` `7.18.1` (via `apps/docs > react-router-dom@7.18.1`) | **High — RSC Mode CSRF bypass allows action execution before the 400 response.** Not applicable to how `apps/docs` consumes the router, and not fixable in place. See the analysis below. | `apps/docs` can move to `react-router@>=8.3.0`, which requires React `>=19.2.7` (see analysis). Then drop `react-router-dom`, migrate imports, and delete this row. |

### Why GHSA-qwww-vcr4-c8h2 is not exploitable here

**The vulnerable code path requires RSC mode with server actions.** `apps/docs` uses
neither:

- **No RSC mode.** The app is a plain Vite SPA using `createBrowserRouter`, plus
  `createStaticHandler` / `createStaticRouter` / `StaticRouterProvider` for build-time
  prerendering. None of React Router's RSC entry points are imported anywhere.
- **No actions to execute.** The advisory's impact is *action execution*; the docs viewer
  is read-only and defines no route `action`, `Form`, `useFetcher`, or `useSubmit`.
- **No server at runtime.** `pnpm build` renders to static HTML and then deletes the SSR
  bundle (`&& rm -rf dist-ssr` in [`apps/docs/package.json`](../../../apps/docs/package.json)),
  so the deployed artifact has no request-handling surface for CSRF to target.

**Why it can't simply be upgraded.** The advisory's patched range is `>=8.3.0`, and
`react-router-dom` was discontinued after `7.18.1` — no 8.x exists under that name, and
7.x received no backport (`7.18.1` is the final 7.x release). The fix therefore means
migrating `apps/docs` off `react-router-dom` onto `react-router@8`, which declares peers
`react >=19.2.7` / `react-dom >=19.2.7` and `engines.node >=22.22.0`. Neither of those
is an obstacle any more — the workspace targets React 19 for Studio/Docs/Landing
(`@lumibase/ui` peers `^18.3.1 || ^19.0.0`) and its `engines.node` floor is now
`^22.22.2 || ^24.15.0 || >=26.0.0`, which clears `>=22.22.0`. What remains is the
migration itself: `react-router@8` is a coordinated port of `apps/docs`, not a
straight version bump.

**Scope check:** `apps/studio` is unaffected — it uses `@tanstack/react-router`, an
unrelated package. `react-router-dom` appears in `apps/docs` only.

## Known-unfixable alerts

Advisories that stay open on GitHub but have no installable fix and no effect on the
`pnpm audit --prod --audit-level high` gate. They get no [audit ignore](#audit-ignore-registry)
entry — that gate is `--prod` and these live outside the production tree — so this section
is the only record.

### GHSA-mh99-v99m-4gvg still matches `brace-expansion@1.1.16`

The advisory's affected range is `<= 5.0.7`, which by plain semver **includes every 1.x
version** — so bumping the 1.x line to `1.1.16` closes
[GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) but not this one.
The only version that satisfies it is `>=5.0.8`.

**Folding 1.x into 5.x breaks ESLint.** `brace-expansion@1` exports the function itself
(`module.exports = expandTop`); the 5.x CommonJS build exports a namespace object
(`{ EXPANSION_MAX, EXPANSION_MAX_LENGTH, expand }`). `minimatch@3` — pulled in by
`eslint`, `@eslint/eslintrc`, `eslint-plugin-import`, `eslint-plugin-react`, and
`eslint-plugin-jsx-a11y` — does `require('brace-expansion')(...)`, which throws
`TypeError: m is not a function` against 5.x. Verify before revisiting:

```bash
node -e "const m=require('brace-expansion'); console.log(typeof m, Object.keys(m))"
```

**Why the residual risk is accepted:** `brace-expansion` is dev-only here (it does not
appear in `pnpm audit --prod`), and the expansion input is ESLint's own glob patterns from
repo-owned config — not attacker-controlled. The impact is a slow lint run on a
hand-crafted pattern, not a production DoS.

**Revisit when** nothing resolves `minimatch@3` any more, or upstream backports the length
cap to a `1.1.17`.

### `glib` 0.18.5 (Rust / Tauri) — GHSA-wrw7-89jp-8q8g

`apps/shell/src-tauri/Cargo.lock` pins `glib@0.18.5`; the advisory (moderate,
unsoundness in the `Iterator`/`DoubleEndedIterator` impls for `glib::VariantStrIter`)
wants `>=0.20.0`. `glib` is not a direct dependency — it arrives through the GTK stack
(`gtk`, `gdk`, `gdkx11`, `gdk-pixbuf`, `atk`, `pango`, `cairo-rs`, `gio`, `soup3`,
`webkit2gtk`, `javascriptcore-rs`, `libappindicator`), all of which pin `0.18.x`. `cargo
update -p glib` therefore cannot cross the minor, and this stack is **compiled only into
Linux builds** — the macOS (WebKit) and Windows (WebView2) targets never link it. Nothing
in `apps/shell` constructs a `VariantStrIter`.

**Revisit when** Tauri 2's Linux backend moves to the `glib` 0.20 / `gtk` 0.19+ generation.
Check with `cargo tree -i glib` after a `tauri` bump.

## Patches registry

### `gray-matter@4.0.3` → [`patches/gray-matter@4.0.3.patch`](../../../patches/gray-matter@4.0.3.patch)

**What it does:** rewrites gray-matter's YAML engine
(`lib/engines.js`) from the removed `yaml.safeLoad` / `yaml.safeDump` to
`yaml.load` / `yaml.dump`.

**Why it's needed:** `gray-matter@4.0.3` is the latest published release and is effectively
unmaintained. It hard-pins `js-yaml@^3.13.1` and calls `safeLoad`/`safeDump`. Those
functions were **removed** in js-yaml 4.x (where `load`/`dump` are safe by default — and
where `safeLoad` is a stub that *throws*). Because the `js-yaml: ^4.3.1` override (above)
upgrades js-yaml tree-wide to fix [CVE-2026-53550](https://github.com/advisories/GHSA-h67p-54hq-rp68),
gray-matter would crash at parse time without this patch. gray-matter is used only at
build/dev time in [`apps/docs`](../../../apps/docs/src/plugins/vite-plugin-docs-loader.ts)
to parse trusted, repo-owned Markdown front matter.

**Remove when:** `gray-matter` publishes a release compatible with js-yaml `>=4.2.0`
(at which point drop both the override-driven need and this patch), **or** `apps/docs`
stops using `gray-matter` (e.g. replaced with a small in-repo front-matter parser calling
js-yaml 4.x `load()` directly). After removing, delete this section, the
`patchedDependencies` entry in **both** `package.json` and `pnpm-workspace.yaml`, and the
patch file, then re-run
`pnpm install`.

## Override drift — why `pnpm drift:check` exists

An override applies to **direct** dependencies, not just transitive ones. That
makes it possible for an override to quietly overrule what a workspace package
declares, with nothing warning about it.

This happened. `overrides.vite` was `^7.3.5` while both `apps/studio` and
`apps/docs` declared `vite: ^8.1.3`. The override won, the lockfile importer
recorded `specifier: ^7.3.5 → 7.3.6`, and both apps were built with Vite 7 for
as long as their manifests claimed Vite 8. Every "we're on Vite 8" statement in
that window was false, and no gate said so.

`pnpm settings:check` cannot catch this class: the two override copies agreed
with each other perfectly: they were only both wrong relative to the manifests.
So [`scripts/check-override-drift.mjs`](../../../scripts/check-override-drift.mjs)
fails CI when an override range does not intersect a range some workspace
package declares directly. Overrides with no direct declaration anywhere are
skipped, because that is the intended use of a security override.

The guard is dependency-free for the same reason the parity script is: a check
on install settings must not itself depend on a successful install. Its range
logic is covered by [`scripts/__tests__/check-override-drift.test.mjs`](../../../scripts/__tests__/check-override-drift.test.mjs)
(`pnpm scripts:test`), including the vite case, so the guard cannot silently
degrade into one that always passes.

**When it fires, do not silence it.** Either raise the override to meet the
manifests, or lower the manifests to admit the override. Leaving them apart is
the bug.

## Dependabot note

`js-yaml` will keep surfacing as an *unfixable* transitive alert as long as `gray-matter`
exists in the tree, because Dependabot can't upgrade `gray-matter` past 3.x's js-yaml
constraint on its own — the override + patch above are what actually resolve it. If the
recurring alert becomes noisy, dismiss it on GitHub as **"this advisory is resolved via a
pnpm override + patch"** (link this doc), rather than ignoring the package wholesale — a
blanket ignore would also hide a *future, genuinely unpatched* js-yaml advisory.
