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

### P0.1 Account erasure / right to be forgotten — ✅ Done (v0.8.x)
- **Why:** GDPR Art. 17, CCPA delete, PDPD, Apple 5.1.1(v), Google data deletion.
- **Delivered:**
  - `erasure_requests` table (`packages/database/src/schema/compliance.ts`) +
    migration `0033_erasure_requests.sql` + RLS.
  - `ErasureService` (`apps/cms/src/modules/data-rights/erasure-service.ts`):
    `request` (grace period), `cancel`, `getStatus`, `eraseNow` (transactional
    anonymize-in-place: nulls PII, drops memberships/credentials, suppresses the
    email), and `processDue` (grace-period processor).
  - Self-service `GET`/`POST`/`DELETE /api/v1/me/erasure`; admin force-erase
    `POST /api/v1/erasure/:userId` + `POST /api/v1/erasure/process-due`
    (`apps/cms/src/routes/erasure.ts`). Audits `erasure_requested`/
    `erasure_cancelled`/`account_erased`.
  - **Anonymize, not delete:** the `users` row survives so content provenance
    (`items.userCreated`, `revisions.userId`) stays intact while PII is removed.
- **Follow-up:** schedule `processDue` on the existing rotation cron; expose a
  public deletion-request URL for the Google Play listing.

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
    `drizzle/0031_user_consents.sql`, RLS in `migrations/rls-policies.sql`).
  - DTOs `packages/shared/src/schemas/consent.ts` (`CONSENT_TYPES`, `ConsentSetSchema`).
  - `ConsentService` (`apps/cms/src/modules/consent/service.ts`) — upsert on the
    `(site,user,type)` unique index.
  - Routes `apps/cms/src/routes/consent.ts` — `GET /api/v1/me/consents`,
    `PUT /api/v1/me/consents/:type`; audits `consent_granted`/`consent_withdrawn`.
- **Follow-up:** a Studio/frontend preference center; reuse this store for P0.4 and P1.1.

### P0.4 Email unsubscribe + suppression — ✅ Done (v0.8.x)
- **Why:** CAN-SPAM (mandatory), ePrivacy.
- **Delivered:**
  - `email_suppressions` table (`packages/database/src/schema/compliance.ts`) +
    migration `0032_email_suppressions.sql` + RLS.
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
- Implemented as the `sale_share` consent type (`packages/shared/src/schemas/consent.ts`),
  recorded via `PUT /api/v1/me/consents/sale_share`. Semantics: `granted: false` (or
  no record) = opted out — the safe CCPA default.
- **Follow-up:** surface the required "Do Not Sell or Share" link and honor the
  Global Privacy Control browser signal in the frontend.

### P1.2 General data-retention policies
- Extend the audit `rotator.ts` retention concept (`LUMIBASE_AUDIT_RETENTION_DAYS`)
  to other PII-bearing tables (e.g., stale items, old AI conversations) with
  configurable horizons and a documented schedule.

### P1.3 Data map for transparency / store labels
- Maintain an inventory of what personal data each feature collects and shares, to
  back accurate Google Data-safety and Apple Privacy-label disclosures and the
  privacy notice. `[Inference]` Could be a generated artifact from schema metadata.

### P1.4 Cross-border / data-residency awareness
- Document and, where required, pin storage regions on edge infrastructure; surface
  data-residency configuration for localization obligations (PDPD/Decree 53).

## P2 — Maturity / nice-to-have

- **P2.1 Restriction-of-processing state** — a "restricted" flag honored by services.
- **P2.2 Human-review path for agent actions** — surface the existing provenance
  (`revisions.authorType/model/sources`) and HITL `ai_approvals` to users affected by
  automated decisions (GDPR Art. 22).
- **P2.3 Field-level redaction on export** — mask sensitive fields in exports.
- **P2.4 Data classification** — tag fields as PII/sensitive to drive retention,
  export redaction, and the data map.
- **P2.5 DPA template** — for any managed/hosted offering (Art. 28).

## Sequencing suggestion

1. P0.3 consent table + P0.4 unsubscribe (foundational data model).
2. P0.1 erasure + P0.2 export (the two heaviest DSR workflows; reuse consent + audit).
3. P1 items once the core DSR plumbing exists.

> Each new table/endpoint must also be evaluated against the **Setup Impact
> Registry** (`.kiro/specs/admin-setup-wizard/setup-impact.md`) per the Definition of
> Done when it is actually implemented.
