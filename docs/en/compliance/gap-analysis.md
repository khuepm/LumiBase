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
| Access / right to know | ⚠️ | `apps/cms/src/modules/audit/routes.ts` (audit export); `apps/cms/src/services/access-export.ts` (RBAC export) | A user-facing "what we hold about you" report (profile, activity, revisions, conversations). |
| Data portability | ❌ | — | "Download my data" endpoint producing structured JSON/CSV of the user's own data. |
| Rectification | ✅ | `apps/cms/src/routes/users.ts` (user update); profile editing | None for profile; ensure all PII fields are user-editable. |
| Restriction of processing | ❌ | — | A "frozen"/"restricted" state flag and enforcement. |
| Objection / opt-out (sale/share) | ❌ | — | Opt-out flag storage + "Do Not Sell or Share" handling; honor preference signals. |
| Consent + withdrawal | ❌ | `users.preferences` JSONB exists (`core.ts:62`) but no consent semantics | A `user_consents` table (type, value, timestamp, withdrawn_at) + API + audit. |
| Cookie / tracking consent | ❌ | — | Consent capture for non-essential cookies/tracking (largely a frontend concern + backend record). |
| Email unsubscribe | ❌ | `email_templates`, `flows` can send mail; no suppression | Unsubscribe link, preference center, suppression list checked before sending. |
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
2. **Personal-data export ("download my data").** No endpoint assembles a user's own
   data into a portable file. Required by GDPR Art. 20; expected by access requests.
3. **Consent management.** `users.preferences` (`core.ts:62`) is a free-form JSONB
   blob with no consent semantics, no withdrawal log, no audit. Needed for GDPR
   Art. 7 and PDPD consent.
4. **Email unsubscribe / preference center.** Email-sending paths (`email_templates`,
   `flows`) have no opt-out link or suppression check. Required by CAN-SPAM.
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
