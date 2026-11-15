---
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:56:12.953Z
contentHash: c51a484b04f8fbf2
codeVerified: 2026-11-15T16:56:12.953Z
codeVerifiedHash: c51a484b04f8fbf2
codeVerifiedClaims: 24
---

# Studio performance and bundle budget

The Studio (`apps/studio`) is a React SPA built with Vite. Every admin page load downloads its **initial payload** — the HTML entry chunk, every chunk that chunk statically imports, and their CSS — before the first screen can render. This page is the policy for keeping that payload small, and how CI enforces it (#757).

## The budget

The limits live in `apps/studio/bundle-budget.json`, in gzip bytes:

| Metric | Budget | Measured when set |
| --- | --- | --- |
| `initialJsGzipBytes` | 200000 | 182502 |
| `initialCssGzipBytes` | 15000 | 13329 |

Only the initial graph counts. A chunk reached only through a dynamic `import()` — a lazy route, a lazy component — is listed in the report but is not budgeted, because it loads after first paint and only for the screens that need it.

## Running the check

```bash
pnpm -F @lumibase/studio exec vite build --manifest
pnpm studio:budget
```

`pnpm studio:budget` runs `scripts/check-studio-bundle-budget.mjs`. It reads `apps/studio/dist/.vite/manifest.json`, walks from each entry chunk through static `imports` only, measures every file (raw, gzip level 9, brotli quality 11), prints the largest chunks with an `initial`/`lazy` column, and exits non-zero when a budgeted metric is over its limit. A missing or non-positive limit is a configuration error and also fails.

CI runs the same two steps in `.github/workflows/studio-bundle-budget.yml` on every pull request that touches the Studio or the packages it bundles, and writes the table to the job summary.

## When the check fails

1. Read the table. A new `initial` row, or an `initial` row that grew, is the regression.
2. Move the weight behind a boundary instead of raising the limit:
   - a whole screen → a lazy route in `apps/studio/src/router.tsx` (`lazy(() => import(...))` + `withSuspense`);
   - a heavy component inside a screen → `React.lazy` + `Suspense` with a sized fallback (see `components/lazy-monaco-editor.tsx`);
   - interaction-only UI (palettes, drag-and-drop) → mount it only when opened (see `components/sortable-module-nav.tsx`).
3. Watch for a **static import that defeats a lazy boundary**. If a boot-path module imports a value from a lazily loaded module, the bundler keeps that module in the initial chunk and prints `INEFFECTIVE_DYNAMIC_IMPORT`. Move the shared value into a small dependency-free module (as `modules/setup/setup-drafts.ts` and `modules/setup/schemas/admin-path-rules.ts` do).
4. Only if the weight genuinely belongs on first paint, raise the limit in `apps/studio/bundle-budget.json` in the same PR and state why.

## Boot requests

A cold Studio boot makes **at most two** permission/identity requests: one `GET /api/v1/permissions/me` (the compiled permission bundle) and one `GET /api/v1/me/preferences`. Every caller — the app shell, `usePermissions`, the language sync, the save-action hook, the permission matrix — reads them through the shared query options in `apps/studio/src/lib/me-queries.ts`, so React Query de-duplicates them. Do not create a new query key for either endpoint; spread `permissionsQueryOptions()` / `mePreferencesQueryOptions()` and invalidate `PERMISSIONS_QUERY_KEY` / `ME_PREFERENCES_QUERY_KEY`. `components/__tests__/boot-requests.test.tsx` fails if a boot makes more than two such calls.

## Progressive dashboards

Dashboard widgets render independently: each one owns its query and its own loading placeholder, so the board paints as each source answers instead of waiting for the slowest. Wrap a widget in `DashboardWidget` (`apps/studio/src/components/dashboard-widget.tsx`) to give it a Suspense skeleton and an error boundary, so a widget that throws shows a contained "unavailable" card with a retry button instead of blanking the page. A stat card whose source is still loading shows a placeholder, never a fake `0`.

## Build tooling

The Studio and the docs site build with Vite 8 (Rolldown) and `@vitejs/plugin-react` 6; tests use Vitest 5. The root `pnpm.overrides.vite` range must intersect the apps' declared range (`pnpm drift:check`). `examples/extension-color-picker` is outside the pnpm workspace and pins its own Vite as a standalone template for extension authors.
