# Compliance & User Rights

> This section maps the **legal rights end users are entitled to** under major
> markets (EU, US, Vietnam) and the **policy requirements of app distributors**
> (Google Play, Apple App Store) to LumiBase's current capabilities.
>
> **⚠️ Not legal advice.** This documentation is an engineering-oriented summary
> for product and platform teams. It does **not** constitute legal advice. Statutes
> change and interpretation depends on your specific data flows, jurisdiction, and
> role (controller vs. processor). Validate every obligation with qualified legal
> counsel or a data protection officer (DPO) before relying on it. Where a claim
> could not be verified against a primary source, it is marked `[Inference]`,
> `[Speculation]`, or `[Unverified]`.

## 1. How to use this section

| Document | Purpose |
|----------|---------|
| [user-rights-catalog.md](./user-rights-catalog.md) | Plain-language explanation of each user right (what it is, real-world example, where it applies). Start here. |
| [market-eu-gdpr.md](./market-eu-gdpr.md) | EU: GDPR + ePrivacy/cookies + cross-border transfers. |
| [market-us.md](./market-us.md) | US: CCPA/CPRA + CAN-SPAM + other state laws. |
| [market-vietnam.md](./market-vietnam.md) | Vietnam: PDPD (Decree 13/2023), cybersecurity & data localization, content publishing licensing. |
| [provider-google-apple.md](./provider-google-apple.md) | Distributor policy: Google Play Data safety + Apple Privacy Labels & account deletion. |
| [gap-analysis.md](./gap-analysis.md) | Right ↔ LumiBase feature mapping with status (✅/⚠️/❌) and file-path evidence. |
| [data-map.md](./data-map.md) | Inventory of where personal data lives, to back privacy notices and store labels. |
| [data-residency.md](./data-residency.md) | Region pinning & cross-border transfer guidance (EU SCCs, VN Decree 53). |
| [dpa-template.md](./dpa-template.md) | Skeleton Data Processing Agreement (GDPR Art. 28) for managed offerings. |
| [implementation-checklist.md](./implementation-checklist.md) | Prioritized backlog (P0/P1/P2) to close the gaps. |

A Vietnamese mirror of this section lives in `docs/vi/compliance/`.

## 2. Rights × Market matrix

This is a quick orientation map. A ✔ means the right/obligation is **explicitly**
recognized; a `~` means it is **partially or indirectly** covered; blank means not
a direct statutory requirement in that regime. See the per-market documents for the
authoritative scope, exemptions, and thresholds.

| Right / obligation | EU (GDPR) | US (CCPA/CPRA) | Vietnam (PDPD) | Google Play | Apple App Store |
|--------------------|:---------:|:--------------:|:--------------:|:-----------:|:---------------:|
| Right to erasure / be forgotten | ✔ (Art. 17) | ✔ (delete) | ✔ | ✔ (data deletion) | ✔ (5.1.1(v)) |
| Right of access (know) | ✔ (Art. 15) | ✔ (right to know) | ✔ | `~` | `~` |
| Data portability | ✔ (Art. 20) | `~` (CPRA) | `~` | | |
| Rectification | ✔ (Art. 16) | ✔ (correct, CPRA) | ✔ | | |
| Restriction of processing | ✔ (Art. 18) | `~` | `~` | | |
| Objection / opt-out | ✔ (Art. 21) | ✔ (opt-out of sale/share) | `~` | | `~` (ATT) |
| Consent + withdrawal | ✔ (Art. 6/7) | `~` (opt-in for minors/sensitive) | ✔ | `~` | `~` |
| Cookie / tracking consent | ✔ (ePrivacy) | `~` | `~` | | ✔ (ATT) |
| Email unsubscribe | `~` (ePrivacy) | ✔ (CAN-SPAM) | `~` | | |
| Account deletion (in-app + web) | ✔ | ✔ | ✔ | ✔ | ✔ |
| Transparency / privacy notice | ✔ (Art. 12–14) | ✔ (notice at collection) | ✔ | ✔ (Data safety) | ✔ (Privacy labels) |
| Breach notification | ✔ (Art. 33–34) | `~` (state breach laws) | ✔ | | |
| Cross-border transfer controls | ✔ (Ch. V / SCCs) | | ✔ (localization) | | |

> `[Inference]` Cell values are a simplified orientation aid derived from the
> per-market analysis in this section; they are not a substitute for the statutory
> text. Treat `~` as "verify the exact trigger and exemption with counsel."

## 3. LumiBase readiness at a glance

| Capability | Status | Evidence |
|------------|:------:|----------|
| Audit log + provenance | ✅ | `apps/cms/src/modules/audit/` |
| Audit retention (configurable purge) | ✅ | `apps/cms/src/modules/audit/rotator.ts` |
| Multi-tenant isolation (RLS) | ✅ | `apps/cms/src/middleware/rls.ts` |
| Field-level encryption (AES-256-GCM) | ✅ | `apps/cms/src/services/crypto-service.ts` |
| RBAC / fine-grained permissions | ✅ | `packages/database/src/schema/access.ts` |
| Soft-delete of content items | ✅ | `packages/database/src/schema/cms.ts` (`items.deletedAt`) |
| Global account erasure (right to be forgotten) | ❌ | — (see gap-analysis) |
| Personal-data export ("download my data") | ❌ | — |
| Consent management & withdrawal | ❌ | — |
| Email subscription / unsubscribe center | ❌ | — |
| General data-retention policies | ❌ | — |

See [gap-analysis.md](./gap-analysis.md) for the full mapping and
[implementation-checklist.md](./implementation-checklist.md) for the backlog.

## 4. Key terms

- **Data subject / user** — the individual the personal data is about.
- **Controller** — decides why and how personal data is processed. A self-hosted
  LumiBase operator (the customer running it) is typically the controller.
- **Processor** — processes data on the controller's behalf. `[Inference]` In a
  managed/hosted LumiBase offering, the host may be a processor; in pure
  self-hosting there may be no separate processor. Confirm your role with counsel.
- **PII / personal data** — any information relating to an identified or
  identifiable person.
- **DSR / DSAR** — Data Subject (Access) Request: a user exercising one of the
  rights above.
