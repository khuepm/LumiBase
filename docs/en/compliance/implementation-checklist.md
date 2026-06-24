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

### P0.1 Account erasure / right to be forgotten
- **Why:** GDPR Art. 17, CCPA delete, PDPD, Apple 5.1.1(v), Google data deletion.
- **What:** A self-service endpoint (and admin counterpart) that performs full
  account + personal-data deletion — not just `userSites` removal as
  `apps/cms/src/routes/users.ts` does today.
- **Touch points:**
  - Cascade/anonymize across `users` and child tables in
    `packages/database/src/schema/core.ts` and `access.ts` (user_roles,
    user_policies, api_keys created_by, etc.).
  - Anonymize references that must survive (e.g., `items.userCreated`,
    `revisions.userId`) rather than orphaning them.
  - Emit a dedicated audit event via `apps/cms/src/modules/audit/logger.ts`.
  - Consider a **grace period** (soft-flag, then purge) reusing the soft-delete
    pattern (`items.deletedAt`).
- **Web URL:** expose a publicly reachable deletion-request flow (Google Play
  requirement) distinct from the in-app path.

### P0.2 Personal-data export ("download my data")
- **Why:** GDPR Art. 20, access requests.
- **What:** Endpoint that assembles the requesting user's own data (profile,
  preferences, activity, revisions authored, notifications, AI conversations) into
  structured JSON/CSV (optionally zipped).
- **Touch points:** new service mirroring the streaming pattern in
  `apps/cms/src/modules/audit/routes.ts` and `apps/cms/src/services/access-export.ts`.

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

### P0.4 Email unsubscribe + suppression
- **Why:** CAN-SPAM (mandatory), ePrivacy.
- **What:** Unsubscribe link/token in every commercial email; a suppression list
  checked before any send; honor opt-out promptly; include sender identity +
  physical address in templates.
- **Touch points:** `email_templates`/`email_layouts`, the `flows` send path, and
  the new `user_consents`/suppression store.

## P1 — Strongly recommended

### P1.1 Opt-out of sale/share ("Do Not Sell or Share")
- Store an opt-out flag (extend `user_consents`); honor preference signals (e.g.,
  Global Privacy Control); surface the required link/notice.

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
