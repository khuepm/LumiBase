# Ops diagnostics plane — design

## Problem

On 2026-11-13 Studio's *Settings → Site* page showed "Failed to load site
configuration." in production. Diagnosing it needed one of: a signed-in
browser, `wrangler tail` with a Cloudflare token, or direct database access.
None of these is available to an operator's agent (Claude Code, an MCP
client) holding a static credential, and the evidence that mattered was
not recorded anywhere:

- `app.onError` answers `{ code: 'INTERNAL', requestId }` and `console.error`s the
  error. On Workers that line is gone unless someone was tailing.
- `formatSafeError` drops `err.cause`. Drizzle wraps every Postgres error in
  `DrizzleQueryError("Failed query: …\nparams: …")`, so the SQLSTATE that names
  the real fault (`42703 column "organization_id" does not exist`) lives only
  on the cause.
- Migrations and `rls-policies.sql` are applied by hand; Deploy CMS ships code
  on every push to `main`. Nothing reports schema drift between the deployed
  code and the database.
- The RLS role/flag sanity checks (`config/db-rls-startup.ts`) run only at
  Docker process startup. Workers never run them.

## Goal

A **read-only operator plane** an agent can use with one static secret to
answer "why is prod failing?" without a browser session, a Cloudflare token
or database credentials.

Non-goals: impersonating a user, calling tenant APIs as an operator, writing
anything, or replacing Logpush/APM.

## Trust boundary

- New secret `LUMIBASE_OPS_TOKEN` (Worker secret / Docker env). It is separate
  from `METRICS_TOKEN` because it reaches further: error messages, table and
  column names, per-site probes.
- Bearer token, constant-time compare. **Unset → every ops route answers the
  canonical 404**, in every environment (no dev fallback, unlike metrics:
  error rows can contain operational detail).
- The token is not a user, has no site and cannot reach `/api/v1/*` tenant
  routes. Each ops call is logged as a structured `ops_access` line.
- Responses never include row data: no item values, no query params, no
  emails, no tokens. A probe reports booleans and counts.

## Components

### 1. Error capture — `lumibase_ops_errors`

Platform table (no `site_id` FK, not tenant data). uuidv7 ids, like the audit tables.

| column | notes |
|---|---|
| `id` uuidv7 | |
| `request_id` | the id the client already sees in the 500 body and `x-request-id` |
| `method`, `path`, `status` | path only, never the query string |
| `site_id`, `principal` | nullable; principal = user id or `apikey:<id>`, never a token |
| `release` | `LUMIBASE_VERSION+LUMIBASE_GIT_SHA` |
| `error_code` | response `errors[0].code` (`INTERNAL`, `RLS_MISCONFIGURED`, …) |
| `error` jsonb | sanitized chain: `name`, `message`, Postgres `code`/`table`/`column`/`constraint`/`routine`/`hint`, recursing through `cause` (depth ≤ 4) |
| `stack` | first 4 KB of the top error's stack |
| `created_at` | |

Sanitizer rules (`modules/ops/sanitize.ts`):
- `DrizzleQueryError`: keep the SQL text (it is the statement, no values), **drop
  `params`** and strip a `\nparams:` tail from the message.
- Postgres `detail` and `where` are dropped (they echo row values, e.g.
  `Key (domain)=(acme.com) already exists`).
- Strings capped at 2 KB; bearer-looking substrings (`Bearer …`, `lb_…` keys,
  JWTs) are redacted.

Capture points:
- `app.onError`: the thrown error plus a 500.
- `withLogger` `finally`: any status ≥ 500 not already captured (503
  `RLS_MISCONFIGURED`, 502 upstream…), with the error code read from a clone
  of the JSON body.

Writes go through the **system connection**, detached (`runDetached`), and
never throw. They are capped at 60 inserts per isolate per minute so an error
storm cannot amplify load. The same insert prunes rows older than 14 days, at
about a 2% sample rate, so retention needs no new cron. RLS: the table is
`ENABLE`+`FORCE` with **no policies**, so the app role sees nothing and only
the BYPASSRLS system role reads it.

### 2. Routes — `/api/v1/ops/*` (mounted before `api`, outside tenant/auth)

| route | answers |
|---|---|
| `GET /ops/diagnostics` | release, runtime, env; `LUMIBASE_DB_RLS` mode (or its parse error); app/system role names and their `rolsuper`/`rolbypassrls`; whether `rls-policies.sql` is installed and which core tables have RLS on; **migrations**: bundled journal vs `drizzle.__drizzle_migrations` (applied count, latest applied, pending tags); a list of `findings` with severity, each one the same rule `db-rls-startup.ts` enforces on Docker; per-service health detail |
| `GET /ops/errors` | recent captured errors; filters `since`, `status`, `path` (prefix), `siteId`, `requestId`, `limit` ≤ 200 |
| `GET /ops/errors/:requestId` | every row for one request id |
| `GET /ops/sites/:siteId/probe` | for one site: does the row exist (system role)? Does it have `organization_id`? Is the row **visible to the app role under that site's RLS scope** (`createSiteScopedSql`)? Can the `GET /api/v1/site` statement run as the app role (catching the error, sanitized)? Member count. No row values are returned. |

Findings are typed (`code`, `severity: error|warn|info`, `message`, `fix`)
so an agent can act on them without parsing prose. For example:
`MIGRATIONS_PENDING`, `RLS_POLICIES_WITHOUT_FLAG`,
`APP_ROLE_BYPASSES_RLS_UNDER_ENFORCE`, `SYSTEM_ROLE_CANNOT_BYPASS`,
`SITE_ROW_HIDDEN_BY_RLS`, `SITE_QUERY_FAILS`.

### 3. MCP tools (`packages/mcp-server/src/tools/ops.ts`)

Registered only when `LUMIBASE_OPS_TOKEN` is set in the MCP server's env. They
call the ops routes with that token instead of the site API key:
`ops_diagnostics`, `ops_list_errors`, `ops_get_error`, `ops_probe_site`. All
are read-only, so the governed/HITL harness does not apply.

### Setup impact

New optional secret `LUMIBASE_OPS_TOKEN`; new migration `0029_ops_errors`;
`rls-policies.sql` gains the no-policy entry. The setup wizard is not involved.
The registry row says *n/a for the wizard; secret documented in deploy docs*.

### Shell impact (DoD §2d)

None. The ops routes are not called by the Studio SPA and do not touch auth,
token storage or the API base URL.
