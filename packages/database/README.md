# @lumibase/database

Drizzle ORM schema and migration tooling for Lumibase.

## Layout

- `src/schema.ts` — Single source of truth for all tables. Follows the strict architectural rules in `.cursorrules` (nanoid PKs, `site_id` on every domain table, JSONB for dynamic config).
- `src/client.ts` — `createDb(connectionString)` factory using `drizzle-orm/postgres-js`. Intended to be called from the CMS Worker with `env.HYPERDRIVE.connectionString`.
- `drizzle.config.ts` — drizzle-kit config; reads `DATABASE_URL` from the environment.

## Commands

Run from the repo root:

```bash
pnpm db:generate   # Generate SQL migrations from schema.ts
pnpm db:migrate    # Apply migrations to DATABASE_URL
pnpm db:studio     # Open Drizzle Studio
```

## Environment

Copy `.env.example` to `.env` and set `DATABASE_URL` for local development.

## Seeding access control

`scripts/seed-dev.ts` currently seeds only the default dev site and `system_state`.
When the advanced Permission Builder lands, seed data must also create the
baseline access-control graph:

- admin policy with `adminAccess=true`, `appAccess=true`, and TFA required;
- administrator role attached to the admin policy;
- studio self-service policy for reading/updating the current user's profile,
  notifications, and presets;
- public policy with no Studio access and no broad content grants;
- explicit system-collection permissions for schema/access managers.

Do not seed plaintext API keys or broad public read permissions. Sensitive
system collections such as `system_state`, `audit_log`, `login_attempts`,
`admin_backup_codes`, `scim_tokens`, and future `api_keys` tables must be
admin/security-only. See
`docs/vi/features/permission-builder-directus-investigation.md` for the full
RBAC import/export and seeding blueprint.
