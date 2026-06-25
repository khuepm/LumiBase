# Data Processing Agreement (DPA) — Template

> A **skeleton** DPA for when you offer a managed/hosted LumiBase service and act
> as a **processor** for your customers (GDPR Art. 28). Fill the bracketed fields.
>
> **⚠️ Not legal advice and not a finished contract.** This is a starting
> checklist of clauses. Have qualified counsel draft and review the binding
> agreement before use.

## Parties

- **Controller:** [Customer legal name, address]
- **Processor:** [Your legal name, address]
- **Effective date:** [date]

## 1. Subject matter & duration
Processing of personal data by the Processor on the Controller's behalf for the
term of the [Main Services Agreement].

## 2. Nature & purpose
Operating the LumiBase Content OS: storing and serving the Controller's content,
user accounts, and related operational data.

## 3. Categories of data & data subjects
- **Data subjects:** the Controller's end users, staff, and contacts.
- **Categories:** identity (email, name, avatar), authentication data, content
  authored, activity/audit logs, consent records. See
  [data-map.md](./data-map.md) for the field-level inventory.

## 4. Controller instructions
The Processor processes personal data only on documented instructions from the
Controller, including for transfers, unless required by law.

## 5. Confidentiality
Personnel authorized to process data are bound by confidentiality.

## 6. Security measures (Art. 32)
Reference the technical measures LumiBase provides: per-field AES-256-GCM
encryption (`crypto-service.ts`), row-level tenant isolation (`rls.ts`), RBAC
(`schema/access.ts`), append-only audit logging with secret masking, and
retention controls. Add transport encryption (TLS) and host hardening.

## 7. Sub-processors
- The Controller authorizes the sub-processors listed in [Annex A].
- The Processor notifies the Controller of changes and allows objection.
- Typical: database host, edge/runtime host, SMTP, CDC sink, Firebase sync.

## 8. Data-subject rights assistance
The Processor assists the Controller in responding to access, erasure,
portability, rectification, and objection requests, using the built-in
endpoints (`/me/data-export`, `/me/erasure`, `/me/consents`).

## 9. Personal-data breach
The Processor notifies the Controller without undue delay after becoming aware
of a breach, with the information needed for the Controller's Art. 33/34 duties.

## 10. International transfers
Where data leaves the EEA, the parties rely on [SCCs / adequacy] per
[data-residency.md](./data-residency.md).

## 11. Deletion or return
On termination, the Processor deletes or returns personal data at the
Controller's choice, subject to legal retention.

## 12. Audits
The Processor makes available information necessary to demonstrate compliance
and allows for audits per [terms].

---

### Annex A — Sub-processors
| Sub-processor | Service | Location |
|---------------|---------|----------|
| [DB host] | Database | [region] |
| [Edge/host] | Runtime/CDN | [region] |
| [SMTP] | Email | [region] |
