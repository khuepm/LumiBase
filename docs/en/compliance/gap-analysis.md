---
version: 2
lastUpdated: 2026-09-01T19:24:39.765Z
sourceLang: en
contentHash: 1f15fcdd2bd8aaf8
codeVerified: 2026-09-01T19:24:39.765Z
codeVerifiedHash: 1f15fcdd2bd8aaf8
codeVerifiedClaims: 58
---

# Gap Analysis — Rights ↔ LumiBase Features

> Maps each user right/obligation to LumiBase's current implementation, with
> file-path evidence and the work needed to close each gap.
>
> Status legend: ✅ implemented · ⚠️ partial · ❌ missing.
>
> **⚠️ Not legal advice.** This is an engineering readiness assessment. The presence
> of a technical primitive does not by itself prove legal compliance.

## 1. Summary table

| Right / obligation | Status | Evidence (file path) | Work needed to close |
|--------------------|:------:|----------------------|----------------------|
| Erasure / right to be forgotten | ✅ | `apps/cms/src/services/erasure-service.ts`; `erasure_requests` table (`schema/regulated.ts`); admin `/api/v1/admin/erasure` + `/api/v1/admin/sar` (regulated-content-readiness) | Add a self-service `/me/erasure` request flow on top of the admin erasure service. |
| Access / right to know | ✅ | `apps/cms/src/modules/data-rights/export-service.ts`; `GET /api/v1/me/data-export` (profile, consents, activity, revisions authored, notifications) | Extend coverage as new PII-bearing tables are added. |
| Data portability | ✅ | `apps/cms/src/routes/data-export.ts` — structured JSON of the user's own data, with `Content-Disposition` download header | Offer a CSV variant if required; reuse for the erasure preview. |
| Rectification | ✅ | `apps/cms/src/routes/users.ts` (user update); profile editing | None for profile; ensure all PII fields are user-editable. |
| Restriction of processing | ✅ | `apps/cms/src/modules/data-rights/restriction-service.ts`; `processing_restrictions` table; self-service `GET`/`PUT /api/v1/me/restriction`; `isRestricted` helper for services | Wire `isRestricted` into agent runs + marketing as enforcement points. |
| Objection / opt-out (sale/share) | ✅ | `sale_share` consent type via `PUT /api/v1/me/consents/sale_share` (`packages/contracts/src/schemas/consent.ts`) | Wire a "Do Not Sell or Share" link + Global Privacy Control signal in the frontend. |
| Consent + withdrawal | ✅ | `packages/database/src/schema/consent.ts` (`user_consents`); `apps/cms/src/modules/consent/service.ts`; `apps/cms/src/routes/consent.ts` (`GET`/`PUT /api/v1/me/consents`); audit `consent_granted`/`consent_withdrawn` | Add preference-center UI. |
| Cookie / tracking consent | ⚠️ | Backend record store exists (`user_consents`, type `analytics`/`functional`); no frontend capture | Frontend consent banner + capture for non-essential cookies/tracking, recorded via `/me/consents`. |
| Email unsubscribe | ✅ | `packages/database/src/schema/compliance.ts` (`email_suppressions`); `apps/cms/src/modules/email/suppression.ts`; public `GET`/`POST /api/v1/email/unsubscribe`; send path filters marketing recipients | Add the `List-Unsubscribe` SMTP header (RFC 8058) once `OutboundEmail` supports custom headers. |
| Account deletion (in-app/web) | ⚠️ | Admin-driven erasure `/api/v1/admin/erasure` + SAR `/api/v1/admin/sar` (regulated) | Add a self-service + publicly reachable deletion-request URL (Apple 5.1.1(v) / Google Play). |
| Transparency / privacy notice | ⚠️ | Privacy page at `apps/landing/src/app/privacy/page.tsx` (generic) | Data map to back accurate store "data safety"/labels; per-deployment notice. |
| Breach notification | ⚠️ | `apps/cms/src/modules/audit/` provides detection trail; `modules/anomaly` | Incident-response runbook + 72h regulator notification process (organizational). |
| Cross-border transfer / localization | ⚠️ | Edge runtime; `apps/cms/src/middleware/rls.ts` isolates tenants | Region-pinning / data-residency configuration + documentation. |
| Automated decisions / human review | ✅ | `apps/cms/src/modules/data-rights/automated-decisions-service.ts`; `GET /api/v1/me/automated-decisions` surfaces agent revisions on the user's content with provenance; HITL via `ai_approvals` | Add a user-initiated "request human review" action. |
| Security measures (encryption/access) | ✅ | `apps/cms/src/services/crypto-service.ts` (AES-256-GCM); `fields.encrypted` (`cms.ts:124`); `middleware/rls.ts`; RBAC `schema/access.ts` | Maintain; document key management. |
| Retention / auto-purge | ✅ | Audit: `apps/cms/src/modules/audit/rotator.ts`; general: `apps/cms/src/modules/data-rights/retention-service.ts` (activity + read/archived notifications) via `POST /api/v1/retention/run` | Extend horizons to more PII tables; schedule on the rotation cron. |

## 2. What LumiBase already does well

These primitives are real and reusable when building compliance features:

- **Audit & provenance.** `apps/cms/src/modules/audit/logger.ts` writes
  secret-masked, append-only events; `routes.ts` offers cursor-paginated query and
  NDJSON export; `rotator.ts` prunes on a configurable horizon. Strong support for
  GDPR Art. 30/32 evidence and breach detection trails.
- **Multi-tenant isolation.** `apps/cms/src/middleware/rls.ts` enforces row-level
  security via `SET LOCAL app.site_id`, in addition to app-level `site_id` filters —
  defense-in-depth against cross-tenant leakage.
- **Encryption.** `apps/cms/src/services/crypto-service.ts` provides AES-256-GCM;
  fields can be marked `encrypted` (`packages/database/src/schema/cms.ts:124`).
- **Fine-grained access control.** `packages/database/src/schema/access.ts` defines
  roles, policies, permissions (row + field level), API keys, and shares.
- **Soft delete.** `items.deletedAt` (`packages/database/src/schema/cms.ts:201`) with
  partial indexes filtering `deleted_at is null` — a recovery window before purge.

## 3. The biggest gaps (and why they matter)

1. **Global account erasure (right to be forgotten).** ✅ *Implemented* by the
   regulated-content-readiness feature: `apps/cms/src/services/erasure-service.ts` +
   `erasure_requests` (`schema/regulated.ts`), exposed via admin `/api/v1/admin/erasure`
   and SAR `/api/v1/admin/sar`. Satisfies GDPR Art. 17, CCPA delete, PDPD. A
   self-service `/me/erasure` flow on top is a follow-up.
2. **Personal-data export ("download my data").** ✅ *Implemented (v0.8.x).*
   `GET /api/v1/me/data-export` (`apps/cms/src/modules/data-rights/export-service.ts`)
   assembles the caller's profile, consents, activity, authored revisions and
   notifications into a structured JSON download (secrets excluded). Satisfies GDPR
   Art. 15/20.
3. **Consent management.** ✅ *Implemented (v0.8.x).* The `user_consents` table
   (`packages/database/src/schema/consent.ts`) records the current decision per
   `(site_id, user_id, type)` with grant/withdraw timestamps; `ConsentService` +
   `GET`/`PUT /api/v1/me/consents` expose self-service management; every change is
   audited (`consent_granted`/`consent_withdrawn`). Satisfies the storage + API +
   audit primitive for GDPR Art. 7 / PDPD. Still open: a frontend preference center.
4. **Email unsubscribe / preference center.** ✅ *Implemented (v0.8.x).* A site-scoped
   `email_suppressions` list (`packages/database/src/schema/compliance.ts`), a public
   one-click unsubscribe endpoint (`GET`/`POST /api/v1/email/unsubscribe`) backed by a
   signed stateless token, and a send-path filter that strips suppressed recipients
   from `marketing` sends (`apps/cms/src/modules/email/suppression.ts`). Satisfies the
   CAN-SPAM mechanism; the `List-Unsubscribe` header remains a follow-up.
5. **General data retention.** ✅ *Implemented (v0.8.x).* `RetentionService`
   (`apps/cms/src/modules/data-rights/retention-service.ts`) prunes the `activity` log
   and handled `notifications` past operator-configured horizons
   (`LUMIBASE_ACTIVITY_RETENTION_DAYS` / `LUMIBASE_NOTIFICATION_RETENTION_DAYS`,
   `0`/unset = disabled), exposed via `POST /api/v1/retention/run`.

## 4. Notes on roles

`[Inference]` Most LumiBase deployments are **self-hosted**, making the operator the
**data controller** and therefore the party legally responsible for honoring these
rights. LumiBase's job is to provide the **capabilities** (endpoints, storage, audit)
that let an operator comply. The checklist treats the work from that angle.

---

**Next:** see [implementation-checklist.md](./implementation-checklist.md) for the
prioritized backlog.
