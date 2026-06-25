# Data Map — Personal Data Inventory

> An inventory of where LumiBase stores personal data, to back accurate privacy
> notices and store disclosures (Google Play **Data safety**, Apple **Privacy
> Nutrition Labels**) and to scope data-subject requests.
>
> **⚠️ Not legal advice.** This is an engineering reference. Your deployment may
> add custom collections/fields that hold additional personal data — extend this
> map accordingly. `[Inference]` Classifications below reflect the default schema,
> not your content model.

## 1. Identity & access

| Table | Personal data | Purpose | Retention |
|-------|---------------|---------|-----------|
| `users` | email, first/last name, avatar, preferences, `external_id`, `password_hash`*, `tfa`* | Authentication, profile | Until erasure (anonymized in place) |
| `user_sites`, `user_roles`, `user_policies` | user↔site/role/policy links | Authorization | Removed on erasure |
| `api_keys` | token hash*, created-by, last-used IP | Programmatic access | Until revoked |
| `login_attempts` | email, IP, result | Brute-force defense | `LUMIBASE_AUDIT_RETENTION_DAYS` (default 90d) |
| `login_baselines` | per-user country/device/hour histogram | Anomaly detection | Removed on erasure |
| `admin_backup_codes` | hashed recovery codes* | Account recovery | Removed on erasure |

\* Secret/credential material — masked in audit logs and **excluded** from data export.

## 2. Consent & communication

| Table | Personal data | Purpose | Retention |
|-------|---------------|---------|-----------|
| `user_consents` | user id, consent type, grant/withdraw timestamps | Consent record (GDPR Art. 7) | Current-state; history in `audit_log` |
| `email_suppressions` | normalized email | Unsubscribe / opt-out enforcement | Until re-subscribe |
| `notifications` | recipient/sender ids, subject, message | In-app notifications | `LUMIBASE_NOTIFICATION_RETENTION_DAYS` (opt-in) |

## 3. Content & activity

| Table | Personal data | Purpose | Retention |
|-------|---------------|---------|-----------|
| `items` | author-supplied content; `user_created`/`user_updated` | Content store | Soft-delete (`deleted_at`) then purge |
| `revisions` | `user_id` (author), delta, agent provenance | Change history | With the item |
| `activity` | `user_id`, IP, user-agent, payload | Operation log | `LUMIBASE_ACTIVITY_RETENTION_DAYS` (opt-in) |
| `audit_log` | actor/target email, IP, country, metadata (masked) | Security audit trail | `LUMIBASE_AUDIT_RETENTION_DAYS` (default 90d) |

## 4. What a data export includes

`GET /api/v1/me/data-export` returns the caller's: profile (secrets excluded),
consents, activity, authored revisions, and notifications. See
[gap-analysis.md](./gap-analysis.md) for the implementation.

## 5. What erasure removes

`POST /api/v1/me/erasure` (or admin `/api/v1/erasure/:userId`) anonymizes the
`users` row (PII nulled), drops memberships + credentials, and suppresses the
email. Content authorship references survive but point to an anonymized user —
see [user-rights-catalog.md](./user-rights-catalog.md).

## 6. Field classification

Custom content fields can be tagged via `fields.classification` (`none` / `pii` /
`sensitive`) on create/update. The `redactByClassification` utility
(`apps/cms/src/modules/data-rights/redaction.ts`) uses these tags to mask sensitive
values in any redacted view/export.

## 7. Third-party processors

`[Inference]` Depends on deployment. Common: the database host (Postgres/Neon/
Supabase), the edge/runtime host (Cloudflare/Docker host), the SMTP/email
transport, and any configured CDC sink (ClickHouse) or Firebase sync target.
List your actual sub-processors in your DPA — see [dpa-template.md](./dpa-template.md).
