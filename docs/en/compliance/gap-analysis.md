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
| Erasure / right to be forgotten | ⚠️ | `packages/database/src/schema/cms.ts` (`items.deletedAt`, line 201); `apps/cms/src/routes/users.ts` (removes from `userSites` only) | Global account-erasure workflow that cascades/anonymizes across `users` and references; audit event; grace period. |
| Access / right to know | ✅ | `apps/cms/src/modules/data-rights/export-service.ts`; `GET /api/v1/me/data-export` (profile, consents, activity, revisions authored, notifications) | Extend coverage as new PII-bearing tables are added. |
| Data portability | ✅ | `apps/cms/src/routes/data-export.ts` — structured JSON of the user's own data, with `Content-Disposition` download header | Offer a CSV variant if required; reuse for the erasure preview. |
| Rectification | ✅ | `apps/cms/src/routes/users.ts` (user update); profile editing | None for profile; ensure all PII fields are user-editable. |
| Restriction of processing | ❌ | — | A "frozen"/"restricted" state flag and enforcement. |
| Objection / opt-out (sale/share) | ✅ | `sale_share` consent type via `PUT /api/v1/me/consents/sale_share` (`packages/shared/src/schemas/consent.ts`) | Wire a "Do Not Sell or Share" link + Global Privacy Control signal in the frontend. |
| Consent + withdrawal | ✅ | `packages/database/src/schema/consent.ts` (`user_consents`); `apps/cms/src/modules/consent/service.ts`; `apps/cms/src/routes/consent.ts` (`GET`/`PUT /api/v1/me/consents`); audit `consent_granted`/`consent_withdrawn` | Add preference-center UI. |
| Cookie / tracking consent | ⚠️ | Backend record store exists (`user_consents`, type `analytics`/`functional`); no frontend capture | Frontend consent banner + capture for non-essential cookies/tracking, recorded via `/me/consents`. |
| Email unsubscribe | ✅ | `packages/database/src/schema/compliance.ts` (`email_suppressions`); `apps/cms/src/modules/email/suppression.ts`; public `GET`/`POST /api/v1/email/unsubscribe`; send path filters marketing recipients | Add the `List-Unsubscribe` SMTP header (RFC 8058) once `OutboundEmail` supports custom headers. |
| Account deletion (in-app/web) | ❌ | — | Self-service deletion endpoint (powers Apple 5.1.1(v) / Google web-URL requirement). |
| Transparency / privacy notice | ⚠️ | Privacy page at `apps/landing/src/app/privacy/page.tsx` (generic) | Data map to back accurate store "data safety"/labels; per-deployment notice. |
| Breach notification | ⚠️ | `apps/cms/src/modules/audit/` provides detection trail; `modules/anomaly` | Incident-response runbook + 72h regulator notification process (organizational). |
| Cross-border transfer / localization | ⚠️ | Edge runtime; `apps/cms/src/middleware/rls.ts` isolates tenants | Region-pinning / data-residency configuration + documentation. |
| Automated decisions / human review | ⚠️ | Provenance in `revisions` (authorType, model, sources, confidence); HITL via `ai_approvals` | Surface human-review path for user-affecting agent actions. |
| Security measures (encryption/access) | ✅ | `apps/cms/src/services/crypto-service.ts` (AES-256-GCM); `fields.encrypted` (`cms.ts:124`); `middleware/rls.ts`; RBAC `schema/access.ts` | Maintain; document key management. |
| Retention / auto-purge | ⚠️ | `apps/cms/src/modules/audit/rotator.ts` (`LUMIBASE_AUDIT_RETENTION_DAYS`, default 90) — **audit only** | General retention policies for PII-bearing tables (users, items, conversations). |

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

1. **Global account erasure (right to be forgotten).** `DELETE` on users today only
   removes a `userSites` membership row — the `users` record and PII persist.
   Required by GDPR Art. 17, CCPA delete, PDPD, and both stores. **Highest priority.**
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
5. **General data retention.** Only audit/login data auto-purges; other PII tables
   have no retention policy.

## 4. Notes on roles

`[Inference]` Most LumiBase deployments are **self-hosted**, making the operator the
**data controller** and therefore the party legally responsible for honoring these
rights. LumiBase's job is to provide the **capabilities** (endpoints, storage, audit)
that let an operator comply. The checklist treats the work from that angle.

---

**Next:** see [implementation-checklist.md](./implementation-checklist.md) for the
prioritized backlog.
