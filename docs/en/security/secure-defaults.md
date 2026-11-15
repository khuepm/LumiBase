---
title: Secure defaults and lumibase doctor --security
sourceLang: en
version: 1
lastUpdated: 2026-11-14T02:04:01.435Z
contentHash: 23ef15e31d018d14
codeVerified: 2026-11-14T02:04:01.435Z
codeVerifiedHash: 23ef15e31d018d14
codeVerifiedClaims: 34
---

# Secure defaults and `lumibase doctor --security`

> A new project starts with no shared secret and no default admin. `lumibase doctor --security` audits its configuration against the production checklist.

## What `create-lumibase` generates

No template contains a secret. The committed example file lists every secret with an **empty** value. The scaffolder then writes a gitignored local file with fresh CSPRNG values and mode `0600`. The secret generators live in `packages/create-lumibase/src/secrets.ts`.

| Template | Example file (committed) | Local file (generated) | Generated keys |
| --- | --- | --- | --- |
| `nextjs` | `.env.example` | `.env` | `JWT_SECRET`, `ENCRYPTION_KEY`, `LUMIBASE_ADMIN_PASSWORD` |
| `default` | `.env.example` | `.env` | `JWT_SECRET`, `ENCRYPTION_KEY` |
| `cloudflare` | `.dev.vars.example` | `.dev.vars` | `JWT_SECRET`, `ENCRYPTION_KEY` |

- `JWT_SECRET` is 48 random bytes in base64url (64 characters).
- `ENCRYPTION_KEY` is base64 of 32 random bytes, the exact format the CMS validates in `apps/cms/src/config/production.ts`.
- `LUMIBASE_ADMIN_PASSWORD` is random and meets the 12+ character, four-class policy. The starter has no default admin: `cms:bootstrap` fails if the password is missing.
- An existing `.env` / `.dev.vars` is never overwritten, because regenerating `ENCRYPTION_KEY` would make stored ciphertext unreadable. Generated values are never printed.

Earlier templates shipped `JWT_SECRET=change-me-in-production`, `dev_secret_key` and a fixed admin password. Every project generated from them shared one signing key. Anyone who knows that key can sign a token the CMS accepts.

### Other defaults per template

| Template | Defaults |
| --- | --- |
| `nextjs` | `docker-compose.yml` reads `JWT_SECRET` and `ENCRYPTION_KEY` as `${VAR:?…}`, so compose refuses to start without them instead of using a known value. CORS is an exact origin (`LUMIBASE_PUBLIC_ORIGIN`). `LUMIBASE_API_RATE_LIMIT` and `LUMIBASE_DB_RLS` are set explicitly, with guidance. Every port is bound to `127.0.0.1`. The refresh cookie keeps the CMS defaults (HttpOnly, Secure, SameSite=Lax). |
| `default` | Hono `secureHeaders` with a strict CSP, an exact-origin CORS allowlist that refuses `*`, a per-IP rate limit (`LUMIBASE_API_RATE_LIMIT`), and a startup check that fails when `JWT_SECRET` is shorter than 32 characters. Postgres and Redis are bound to `127.0.0.1`. |
| `cloudflare` | No secrets in `wrangler.toml` `[vars]`: use `.dev.vars` locally and `wrangler secret put` in production. The template also ships CSP headers, an exact-origin CORS allowlist and a fail-closed `JWT_SECRET` check. |

## `lumibase doctor --security`

```bash
npx lumibase doctor --security               # rules for the current environment
npx lumibase doctor --security --production  # force the production checklist
npx lumibase doctor --security --json        # machine-readable report
npx lumibase doctor --security --env-file deploy/prod.env
```

The check reads the configuration the CMS would run with. It executes nothing and contacts no server. Sources, lowest precedence first:

1. dotenv files: `.env`, `.env.local`, `.dev.vars`, or the files named by `--env-file` (comma-separated)
2. the process environment, limited to LumiBase-relevant names
3. `wrangler.toml` `[vars]`, which also selects the Cloudflare runtime
4. `environment:` entries in `docker-compose.yml` / `compose.yaml`. `${VAR}`, `${VAR:-default}` and `${VAR:?error}` are resolved against 1 and 2, the same way Compose resolves them.

Production rules apply when `NODE_ENV` or `LUMIBASE_ENV` is `production`, or when `--production` is passed. The command exits `1` if any finding is critical and `0` otherwise. Reports never contain a secret value, only key names and sources. The implementation is in `packages/cli/src/security/checks.ts`.

### Rules

| Rule id | Severity (dev / production) | What it checks |
| --- | --- | --- |
| `jwt-secret-missing` | critical / critical | `JWT_SECRET` unset |
| `jwt-secret-weak` | critical / critical | `JWT_SECRET` is a published default (`dev_secret_key`, `change-me-in-production`, …) |
| `jwt-secret-short` | warning / critical | `JWT_SECRET` shorter than 32 characters |
| `encryption-key-missing` | warning / critical | no `ENCRYPTION_KEY` (or `ENCRYPTION_KEY_<id>`) |
| `encryption-key-weak` / `encryption-key-format` | critical / critical | known default, or not base64 of a 16/24/32-byte AES key |
| `dev-auth-enabled` | warning / critical | `LUMIBASE_DEV_AUTH=true` (accepts forged `dev:` tokens) |
| `dev-credential` | warning / critical | `S3_ACCESS_KEY`, `S3_SECRET_KEY` or `MEILISEARCH_API_KEY` is a development default |
| `cors-wildcard` | critical / critical | `*` in `CORS_ALLOWED_ORIGINS` (responses are credentialed) |
| `cors-unset` | info / critical | no `CORS_ALLOWED_ORIGINS` |
| `cors-insecure-origin` | — / warning | `http://` or loopback origins in production |
| `cookie-insecure` | info / critical | `REFRESH_COOKIE_SECURE=false` |
| `cookie-samesite-none` / `cookie-samesite-invalid` | info / warning; warning | `REFRESH_COOKIE_SAMESITE` is `None`, or an unknown value |
| `setup-token-off` | info / warning | `LUMIBASE_REQUIRE_SETUP_TOKEN` is not on (Node/Docker only) |
| `rls-invalid` | critical / critical | `LUMIBASE_DB_RLS` is not `off` or `enforce` (the CMS fails closed) |
| `rls-no-system-url` | critical / critical | `enforce` without `DATABASE_SYSTEM_URL` (startup error) |
| `rls-off` | info / warning | RLS not enforced (Node/Docker only) |
| `rate-limit-invalid` / `rate-limit-disabled` | warning / warning | `LUMIBASE_API_RATE_LIMIT` is not an integer, or is `0` |
| `rate-limit-fail-open` | — / info | `LUMIBASE_RATE_LIMIT_FAIL_CLOSED` is not `true` |
| `redis-unset` | info / critical | no `REDIS_URL` (Node/Docker; required in production) |
| `database-url-missing` / `database-tls` | — / critical | `DATABASE_URL` missing, or no `sslmode=require\|verify-ca\|verify-full` (unless `DATABASE_SSL_MODE=disable`) |
| `admin-password-default` | critical / critical | `LUMIBASE_ADMIN_PASSWORD` / `ADMIN_PASSWORD` is a published default |
| `admin-password-weak` | warning / warning | the admin password fails the 12+ character, four-class policy |
| `secret-in-public-env` | critical / critical | a `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_` variable that looks like a credential |
| `secret-committed` | warning / critical | a secret written literally in `wrangler.toml` `[vars]` or a compose file |

Each rule mirrors what the CMS itself does with the variable. Critical findings are startup refusals from `validateProductionConfig` or `assertDbRlsStartup`, and settings that give an attacker a credential. The source files are listed at the top of `checks.ts`, so a rule can be re-checked when the CMS changes.

### Acceptance

A fresh scaffold of every template passes `doctor --security` with zero critical findings. `packages/cli/src/security/scaffold-acceptance.test.ts` scaffolds each template into a temporary directory with the real scaffolder and runs the real command against it. With `--production`, the same scaffold still reports what a local stack cannot meet, such as database TLS, an `http://localhost` origin and the setup-token gate. No finding is about a secret.

## Related docs

- [CLI](../cli/index.md)
- [Anti-abuse mechanisms](./anti-abuse.md)
- [Deployment checklist](../DEPLOYMENT-CHECKLIST.md)
