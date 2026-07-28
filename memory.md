# LumiBase agent memory

## Package manager / TypeScript

- Use **pnpm** (`pnpm-lock.yaml` present). Never yarn/npm for installs.
- Project is TypeScript throughout — keep it that way.

## Decisions / recurring notes

- **Studio setup-state gate (2026-07-28):** When `GET /api/v1/setup/state` fails, `SetupStateGate` / `AdminReadyGate` must show a stable unreachable alert and only retry on explicit "Try again". Do not `refetchOnWindowFocus` / `refetchOnReconnect` while errored (`staleTime: 0` made focus feel like continuous refresh). TanStack Query can flip an errored query (no cached data) back to `pending` during manual `refetch()` — use a sticky `hasFailed` latch (`shouldShowSetupStateError`) so the alert is not replaced by the full-page spinner. Shared hook: `apps/studio/src/modules/setup/use-setup-state-query.ts`.
- **Production outage (2026-07-28):** `studio.lumibase.dev` SPA loads, but CMS `api.lumibase.dev` returns 500 on `/api/v1/setup/state` and `/health/ready` is 503 (likely Hyperdrive/Postgres). Studio unreachable UI is expected until API is healthy. Production Studio bundle may also lack inlined `VITE_API_URL` (optional chaining on `import.meta.env?.VITE_API_URL`).

## PR #303 (2026-07-28)

- Dependabot minor-and-patch group was `CONFLICTING` after #305 (`eslint-config-next` 16.2.12) and again after #316.
- Resolution: merge `main` into dependabot branch; keep `eslint-config-next@^16.2.12` + Dependabot bumps; regenerate lockfile.
- Conflict files: `apps/landing/package.json`, `pnpm-lock.yaml`, then `memory.md`.
- Companion branch: `cursor/resolve-dependabot-303-20f4` (same tip pushed to Dependabot ref).
