# @lumibase/database

Drizzle ORM schema and migration tooling for LumiBase.

## Layout

- `src/schema.ts` — Single source of truth for all tables. Follows the strict architectural rules in `.cursorrules` (nanoid PKs, `site_id` on every domain table, JSONB for dynamic config).
- `src/client.ts` — `createDb(connectionString)` factory using `drizzle-orm/postgres-js`. Intended to be called from the CMS Worker with `env.HYPERDRIVE.connectionString`.
- `drizzle.config.ts` — drizzle-kit config; reads `DATABASE_URL` from the environment.

## Commands

Run from the repo root:

```bash
pnpm db:generate   # Generate SQL migrations from schema.ts
pnpm db:migrate:preflight # Check DB connectivity, current schema version, and pending migrations
pnpm db:migrate    # Apply migrations to DATABASE_URL
pnpm db:migrate:version # Print the current schema version recorded by Drizzle
pnpm db:studio     # Open Drizzle Studio
```


## Migration safety policy

Every committed migration must remain backward-compatible for at least one release window:

- Do not drop a column, table, index, enum value, or constraint while the previous app release can still read or write it.
- Add new columns as nullable or with a safe default first; tighten `NOT NULL` or stricter constraints only after the app no longer writes invalid data.
- Use a separate backfill step when existing rows need new values, and make that backfill restart-safe.
- Defer destructive cleanup, including dropping legacy columns, to the next release after all supported app versions no longer depend on the old shape.
- Release notes for every release must include a `Migrations` section. State whether migrations are present, whether they are backward-compatible, and any operator action required before or after deploy.

## Preflight and version checks

The migration runner supports read-only checks before applying DDL:

```bash
# Verify DATABASE_URL connectivity, print the current schema version, and list pending migrations.
pnpm db:migrate:preflight

# Alias for automation that expects a dry-run command name.
pnpm db:migrate:dry-run

# Print the schema version recorded in drizzle.__drizzle_migrations.
pnpm db:migrate:version

# Equivalent package-scoped commands.
pnpm --filter @lumibase/database migrate:preflight
pnpm --filter @lumibase/database migrate:version
```

The current version is the latest applied Drizzle migration tag from `drizzle/meta/_journal.json`; `none` means the Drizzle migrations table does not exist yet.

## Environment

Copy `.env.example` to `.env` and set `DATABASE_URL` for local development.

## Seeding access control

`scripts/seed-dev.ts` seeds the default dev site, `system_state`, and the
baseline access-control graph:

- admin policy with `adminAccess=true`, `appAccess=true`, and TFA required;
- administrator role attached to the admin policy;
- studio self-service policy with Studio access but no default system grants;
- public policy with no Studio access and no broad content grants;
- explicit system-collection permissions for schema/access managers;
- read-only sensitive collection permissions for the security manager policy.

Do not seed plaintext API keys or broad public read permissions. Sensitive
system collections such as `system_state`, `audit_log`, `login_attempts`,
`admin_backup_codes`, `scim_tokens`, and `api_keys` tables are
admin/security-only. See `docs/en/features/system-collections-access.md` for
the system collection access contract.
