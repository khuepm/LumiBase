# LumiBase agent memory

## Package manager / TypeScript
- Use **pnpm** (pnpm-lock.yaml present). Never yarn/npm for installs.
- Project is TypeScript throughout (`strict: true`).

## PR #303 (2026-07-28)
- Dependabot minor-and-patch group was `CONFLICTING` after #305 (`eslint-config-next` 16.2.12).
- Resolution: merge `main` into dependabot branch; keep `eslint-config-next@^16.2.12` + Dependabot bumps; regenerate lockfile.
- Conflict files: `apps/landing/package.json`, `pnpm-lock.yaml`.
- Companion branch: `cursor/resolve-dependabot-303-20f4` (same tip pushed to Dependabot ref).
