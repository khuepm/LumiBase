# Data Residency & Cross-Border Transfers

> Guidance for keeping personal data in required regions (EU adequacy/SCCs,
> Vietnam Decree 53 localization) given LumiBase's dual edge/Docker deployment.
>
> **⚠️ Not legal advice.** Localization and transfer rules are fact-specific and
> change frequently. Confirm your obligations with counsel. `[Unverified]`
> statutory specifics below should be checked against primary sources.

## 1. Why it matters

| Market | Obligation (summary) |
|--------|----------------------|
| EU (GDPR Ch. V) | Transfers outside the EEA need a lawful mechanism — adequacy decision, Standard Contractual Clauses (SCCs), or BCRs. |
| Vietnam (Decree 53/2022, Law on Cybersecurity) | `[Unverified]` Certain providers must store specified data in Vietnam and may need a local entity/branch. Verify scope for your service. |
| US (sectoral) | No general residency rule; contractual/state requirements may apply. |

## 2. Where LumiBase stores data

- **Database** — the single source of truth for all personal data. Its region is
  determined by your Postgres host (Neon/Supabase/self-hosted). **This is the
  primary residency control.**
- **Edge cache / runtime** — Cloudflare Workers run globally; cached responses may
  be replicated to edge PoPs. Treat cache as transient and avoid caching PII-bearing
  authenticated responses.
- **Object storage / files** — region of your R2/S3 bucket.
- **Email transport, CDC sink, Firebase sync** — each is a cross-border transfer to
  that provider's region.

## 3. How to pin a region

1. **Database:** provision the Postgres instance in the required region; this pins
   the authoritative copy of all personal data.
2. **Docker deployment:** run the CMS container in-region for full control —
   LumiBase's dual deployment (`apps/cms/src/serve.ts`) supports a single-region
   Node host, the simplest model for strict localization.
3. **Edge deployment:** keep the database in-region; configure object storage and
   any sinks in-region; minimize PII in cached/edge state.
4. **Sub-processors:** choose in-region SMTP/CDC/Firebase endpoints, or disable
   those features where cross-border transfer is not permitted.

## 4. Transfer mechanisms (EU)

`[Inference]` For any processor outside the EEA, put SCCs in place via your DPA
(see [dpa-template.md](./dpa-template.md)) and record the transfer in your ROPA.

## 5. Status in LumiBase

- ✅ Multi-tenant isolation (`apps/cms/src/middleware/rls.ts`) keeps tenants separate
  but does **not** by itself pin a region.
- ⚠️ Region pinning is an **operational/deployment** choice, not an app setting today.
  There is no built-in per-record region routing. `[Inference]` For multi-region
  residency, run separate per-region deployments.
