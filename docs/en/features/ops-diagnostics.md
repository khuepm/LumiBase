---
sourceLang: en
version: 1
lastUpdated: 2026-11-13T15:46:34.785Z
contentHash: d69e70aa06baefd9
codeVerified: 2026-11-13T19:16:05.746Z
codeVerifiedHash: d69e70aa06baefd9
codeVerifiedClaims: 26
---

# Ops diagnostics

A read-only operator plane for answering "why is production failing?" with one static secret: no signed-in browser, no Cloudflare API token, no database credentials. It is built for agents (Claude Code, any MCP client) as much as for people with `curl`.

It covers the failures that otherwise need `wrangler tail` or a `psql` session:

- a 500 that only says `{ "code": "INTERNAL", "requestId": "…" }`;
- code deployed ahead of its migrations (`column … does not exist`);
- `rls-policies.sql` applied while `LUMIBASE_DB_RLS` and the database roles disagree (requests see no rows, so pages answer 404);
- a degraded service behind `/health`.

Design: `.kiro/specs/ops-diagnostics/design.md`.

## Enable it

Set `LUMIBASE_OPS_TOKEN` to a random secret of at least 32 characters:

```bash
openssl rand -base64 36 | wrangler secret put LUMIBASE_OPS_TOKEN --env production
```

On Docker, set it in the CMS environment. If the token is unset or shorter than 32 characters, every ops route answers the same 404 as an unknown route, in every environment, so the plane cannot be discovered.

The token is separate from `METRICS_TOKEN` because it reaches further (error messages, table and column names, per-site probes). It is not a user, has no site and cannot call tenant routes under `/api/v1/*`.

Then apply migration `0029_ops_errors` and re-apply `packages/database/migrations/rls-policies.sql` (`pnpm db:migrate` does not apply that file).

## Routes

All are `GET`, take `Authorization: Bearer $LUMIBASE_OPS_TOKEN`, answer `Cache-Control: no-store`, and are implemented in `apps/cms/src/modules/ops/routes.ts`.

| Route | Answers |
|---|---|
| `/api/v1/ops/diagnostics` | Release (`LUMIBASE_VERSION` + `LUMIBASE_GIT_SHA`); pending migrations (the bundled journal against `drizzle.__drizzle_migrations`); schema drift (tables and columns the deployed code selects that the database lacks); the RLS mode, the app and system roles and whether they bypass RLS, and whether the policies are installed; service health; and `findings`. |
| `/api/v1/ops/errors` | Captured 5xx errors, newest first. Filters: `since` (ISO time), `status` (500–599), `path` (prefix), `siteId`, `requestId`, `limit` (≤ 200). |
| `/api/v1/ops/errors/:requestId` | The captured error for the `requestId` a client saw in a 500 body or the `x-request-id` header. |
| `/api/v1/ops/sites/:siteId/probe` | Runs the statement `GET /api/v1/site` runs, on the connection a request would use: does the row exist (system role), does the request connection see it, does it under the site's RLS scope, does the statement fail (sanitized, with SQLSTATE), and the member count. |

Each finding has `code`, `severity` (`error`, `warn` or `info`), `message`, and usually a `fix`, so an agent can act without parsing prose. Codes include `MIGRATIONS_PENDING`, `SCHEMA_DRIFT`, `RLS_POLICIES_WITHOUT_FLAG`, `ENFORCE_WITHOUT_SYSTEM_CONNECTION`, `SYSTEM_ROLE_CANNOT_BYPASS`, `APP_ROLE_BYPASSES_RLS_UNDER_ENFORCE`, `OPS_ERRORS_TABLE_MISSING`, `SERVICE_UNHEALTHY`, and from the probe `SITE_NOT_FOUND`, `SITE_QUERY_FAILS` and `SITE_ROW_HIDDEN_BY_RLS`. The RLS rules are the same ones `apps/cms/src/config/db-rls-startup.ts` checks when a Docker process starts. Workers have no process start, so on Workers this route is the only place they are checked.

```bash
curl -s -H "Authorization: Bearer $LUMIBASE_OPS_TOKEN" \
  https://api.example.com/api/v1/ops/diagnostics | jq '.data.findings'
```

## Error capture

Every response with status 500 or higher is written to `lumibase_ops_errors`: thrown errors from `app.onError`, and answered ones such as `503 RLS_MISCONFIGURED` from the request logger. Each row is keyed by `requestId` and holds the method, the path (never the query string), status, site, principal (`user:<id>` or `apikey:<id>`, never a token), release, the response's error code, and the sanitized error chain.

The sanitizer (`apps/cms/src/modules/ops/sanitize.ts`) follows `cause`, so the Postgres SQLSTATE that Drizzle wraps is kept. It keeps the SQL statement text but drops query parameters, drops Postgres `detail` and `where` (they echo row values), and redacts bearer tokens, JWTs, API keys and connection-string passwords.

Writes are best-effort: they run detached on the system connection, never fail the request, and are capped at 60 per isolate per minute. Rows older than 14 days are pruned by the writer. The table has RLS enabled and forced with no policy, so the app role reads nothing and only the system role (BYPASSRLS) can.

## MCP

`@lumibase/mcp-server` registers four read-only tools when its environment has `LUMIBASE_OPS_TOKEN`: `ops_diagnostics`, `ops_list_errors`, `ops_get_error` and `ops_probe_site`. They send the ops token, never the site API key, and no site header. With `LUMIBASE_URL` and `LUMIBASE_OPS_TOKEN` but no `LUMIBASE_TOKEN`, the server starts in ops-only mode with just these four tools, which is useful when tenant auth itself is what is broken.

```json
{
  "mcpServers": {
    "lumibase-ops": {
      "command": "npx",
      "args": ["-y", "@lumibase/mcp-server"],
      "env": {
        "LUMIBASE_URL": "https://api.example.com",
        "LUMIBASE_OPS_TOKEN": "<ops token>"
      }
    }
  }
}
```

## Security notes

- Responses carry no row data: the probe returns booleans and counts, errors are sanitized, and the diagnostics report schema and role names only.
- Every ops call logs a structured `ops_access` line with its `requestId`.
- Rotate the token like any secret. It grants read access to operational metadata only and no write path exists.
