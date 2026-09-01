---
version: 1
lastUpdated: 2026-08-02T19:12:32.781Z
sourceLang: en
contentHash: a5f42d06c14d4be3
codeVerified: 2026-08-02T19:12:32.781Z
codeVerifiedHash: a5f42d06c14d4be3
codeVerifiedClaims: 58
---

# Implementation Checklist

> Prioritized backlog to close the gaps in [gap-analysis.md](./gap-analysis.md).
> This is **direction**, not code — each item names the likely schema/module touch
> points so engineering can scope the work. Honor the project's non-negotiable rules
> (see `CLAUDE.md`): `nanoid()`/`uuidv7()` IDs, `site_id` on every domain table, RLS,
> runtime abstraction, and HITL for `schema:write`/`delete` skills.
>
> **⚠️ Not legal advice.** Prioritization is engineering judgment, not a legal
> determination of what is mandatory for your deployment.

## P0 — Must-have for basic legal + store compliance

### P0.1 Account erasure / right to be forgotten — ✅ Done (regulated-content-readiness)
- **Why:** GDPR Art. 17, CCPA delete, PDPD, Apple 5.1.1(v), Google data deletion.
- **Delivered (by the regulated-content-readiness feature):**
  - `erasure_requests` table (`packages/database/src/schema/regulated.ts`).
  - `apps/cms/src/services/erasure-service.ts` (erasure + retention sweep).
  - Admin `/api/v1/admin/erasure` and Subject Access Request `/api/v1/admin/sar`
    (`apps/cms/src/routes/admin-erasure.ts`, `admin-sar.ts`).
- **Follow-up:** add a self-service `/me/erasure` request flow + a publicly reachable
  deletion-request URL for the Google Play listing on top of the admin service.

### P0.2 Personal-data export ("download my data") — ✅ Done (v0.8.x)
- **Why:** GDPR Art. 15/20, access requests.
- **Delivered:** `DataExportService` (`apps/cms/src/modules/data-rights/export-service.ts`)
  assembles the caller's profile, consents, activity, authored revisions and
  notifications (secrets excluded, each section bounded with a `truncated` flag);
  `GET /api/v1/me/data-export` (`apps/cms/src/routes/data-export.ts`) returns structured
  JSON with a `Content-Disposition` download header; audits `data_exported`.
- **Follow-up:** a CSV/zip variant; include AI conversations once that table is in scope.

### P0.3 Consent management — ✅ Done (v0.8.x)
- **Why:** GDPR Art. 7, PDPD.
- **What:** A `user_consents` table — `id` (nanoid), `site_id`, `user_id`,
  `consent_type` (marketing, analytics, personalization, functional), `granted` (bool),
  `granted_at`, `withdrawn_at`, `source`/`version`. API to read/update; audit every
  change. Consent is **not** stored in the free-form `users.preferences` JSONB.
- **Delivered:**
  - Schema `packages/database/src/schema/consent.ts` (+ migration
    `drizzle/0000_lumibase_init.sql` (consolidated), RLS in `migrations/rls-policies.sql`).
  - DTOs `packages/contracts/src/schemas/consent.ts` (`CONSENT_TYPES`, `ConsentSetSchema`).
  - `ConsentService` (`apps/cms/src/modules/consent/service.ts`) — upsert on the
    `(site,user,type)` unique index.
  - Routes `apps/cms/src/routes/consent.ts` — `GET /api/v1/me/consents`,
    `PUT /api/v1/me/consents/:type`; audits `consent_granted`/`consent_withdrawn`.
- **Follow-up:** a Studio/frontend preference center; reuse this store for P0.4 and P1.1.

### P0.4 Email unsubscribe + suppression — ✅ Done (v0.8.x)
- **Why:** CAN-SPAM (mandatory), ePrivacy.
- **Delivered:**
  - `email_suppressions` table (`packages/database/src/schema/compliance.ts`) +
    migration `0000_lumibase_init.sql` (consolidated) + RLS.
  - `SuppressionService` (`apps/cms/src/modules/email/suppression.ts`) with
    `isSuppressed`/`filter`/`suppress`/`unsuppress`/`list` and stateless signed
    unsubscribe tokens (`createUnsubscribeToken`/`verifyUnsubscribeToken`).
  - Public one-click endpoint `GET`/`POST /api/v1/email/unsubscribe`
    (`apps/cms/src/routes/email-public.ts`); audits `email_unsubscribed`.
  - Admin management `GET`/`POST`/`DELETE /api/v1/email/suppressions`.
  - Send path: `EmailModuleService.send({ category: 'marketing' })` filters
    suppressed recipients before dispatch.
- **Follow-up:** add the `List-Unsubscribe` SMTP header (needs `OutboundEmail` to
  carry custom headers); include sender postal address in marketing templates.

## P1 — Strongly recommended

### P1.1 Opt-out of sale/share ("Do Not Sell or Share") — ✅ Done (v0.8.x)
- Implemented as the `sale_share` consent type (`packages/contracts/src/schemas/consent.ts`),
  recorded via `PUT /api/v1/me/consents/sale_share`. Semantics: `granted: false` (or
  no record) = opted out — the safe CCPA default.
- **Follow-up:** surface the required "Do Not Sell or Share" link and honor the
  Global Privacy Control browser signal in the frontend.

### P1.2 General data-retention policies — ✅ Done (v0.8.x)
- **Delivered:** `RetentionService` (`apps/cms/src/modules/data-rights/retention-service.ts`)
  prunes the `activity` log and read/archived `notifications` past operator-configured
  horizons (`LUMIBASE_ACTIVITY_RETENTION_DAYS` / `LUMIBASE_NOTIFICATION_RETENTION_DAYS`;
  `0`/unset disables). Admin trigger `GET`/`POST /api/v1/retention/run`
  (`apps/cms/src/routes/retention.ts`); audits `retention_pruned`.
- **Follow-up:** extend horizons to more PII tables (e.g. AI conversations); schedule
  on the existing rotation cron instead of a manual trigger.

### P1.3 Data map for transparency / store labels — ✅ Done (v0.8.x, doc)
- Documented in [data-map.md](./data-map.md): a field-level inventory of personal
  data per table, what the export includes, what erasure removes, and likely
  sub-processors. `[Inference]` A generated-from-schema artifact remains a future
  enhancement.

### P1.4 Cross-border / data-residency awareness — ✅ Done (v0.8.x, doc)
- Documented in [data-residency.md](./data-residency.md): where data lives, how to
  pin a region (database-first), transfer mechanisms (SCCs), and the VN Decree 53
  caveat. Built-in per-record region routing is **not** implemented; multi-region =
  separate deployments.

## P2 — Maturity / nice-to-have

- **P2.1 Restriction-of-processing state** — ✅ Done (v0.8.x). `processing_restrictions`
  table + `RestrictionService` + self-service `GET`/`PUT /api/v1/me/restriction`; audits
  `processing_restricted`/`processing_unrestricted`. The `isRestricted` helper is the
  enforcement hook for services (agent runs, marketing); wiring those call sites is the
  remaining integration step.
- **P2.2 Human-review path for agent actions** — ✅ Done (v0.8.x).
  `GET /api/v1/me/automated-decisions`
  (`apps/cms/src/modules/data-rights/automated-decisions-service.ts`) surfaces
  agent-authored revisions on the user's content with provenance (model, sources,
  confidence), satisfying GDPR Art. 22 transparency. A user-initiated "request human
  review" action (creating an `ai_approvals` entry) is the remaining enhancement.
- **P2.3 Field-level redaction on export** — ✅ Done (regulated-content-readiness).
  Fields classified `pii`/`phi` are masked by default unless the caller has
  `read_decrypted`, and decrypted reads are audited (`field_access_log`). The
  personal-data export also excludes credential secrets (`passwordHash`, `tfa`).
- **P2.4 Data classification** — ✅ Done (regulated-content-readiness).
  `fields.classification` (`none`/`internal`/`pii`/`phi`) with `pii`/`phi` requiring
  `encrypted=true` (`assertClassificationEncryptable` in `schema-service.ts`); also
  accepted on the field create/update API (`apps/cms/src/routes/collections.ts`).
- **P2.5 DPA template** — ✅ Done (v0.8.x, doc). See [dpa-template.md](./dpa-template.md).

## Sequencing suggestion

1. P0.3 consent table + P0.4 unsubscribe (foundational data model).
2. P0.1 erasure + P0.2 export (the two heaviest DSR workflows; reuse consent + audit).
3. P1 items once the core DSR plumbing exists.

> Each new table/endpoint must also be evaluated against the **Setup Impact
> Registry** (`.kiro/specs/admin-setup-wizard/setup-impact.md`) per the Definition of
> Done when it is actually implemented.
