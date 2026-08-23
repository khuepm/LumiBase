---
version: 1
lastUpdated: 2026-08-02T19:10:24.794Z
sourceLang: en
contentHash: 46a5838fdd03d299
---

# EU — GDPR & ePrivacy

> Obligations in the European Union / EEA most relevant to a CMS/Content OS.
>
> **⚠️ Not legal advice.** Article references are provided for navigation. Confirm
> applicability (you may be a controller, a processor, or out of scope) with counsel.

## 1. Source instruments

- **GDPR** — Regulation (EU) 2016/679. In application since **25 May 2018**.
- **ePrivacy Directive** — Directive 2002/58/EC (as amended by 2009/136/EC),
  implemented via national laws; governs cookies/tracking and electronic marketing.
  `[Unverified]` A replacement ePrivacy Regulation has been under negotiation for
  years; verify current status before relying on it.

## 2. Legal bases for processing (Art. 6)

You must have a lawful basis for each processing purpose. The six bases:
consent, contract, legal obligation, vital interests, public task, and legitimate
interests. Document which basis applies to each purpose (this feeds the Art. 30
record below).

## 3. Data subject rights (Art. 12–22)

| Article | Right | Practical requirement |
|---------|-------|-----------------------|
| 12 | Transparent communication | Respond to requests, generally **within 1 month**, free of charge. |
| 13–14 | Information at collection | Privacy notice with purposes, basis, retention, recipients, rights. |
| 15 | Access | Provide a copy of the data + processing details. |
| 16 | Rectification | Correct/complete data. |
| 17 | Erasure ("right to be forgotten") | Delete on request when no overriding basis; propagate to recipients. |
| 18 | Restriction | "Freeze" processing in defined situations. |
| 20 | Portability | Provide data in structured, machine-readable form (consent/contract bases). |
| 21 | Objection | Stop processing for direct marketing (absolute) and legitimate-interest purposes. |
| 22 | Automated decisions | Right not to be subject to solely automated decisions with significant effects; obtain human intervention. |

## 4. Consent (Art. 7) and cookies (ePrivacy)

- Consent must be **freely given, specific, informed, unambiguous**, demonstrable,
  and **as easy to withdraw as to give**.
- **Cookies / device storage:** non-essential cookies and similar identifiers
  require prior consent. Banners must offer a genuine "reject" path equal in
  prominence to "accept"; pre-ticked boxes are invalid.
- Keep **records of consent** (who, when, what they were shown, what they agreed to).

## 5. Records of processing activities — ROPA (Art. 30)

Controllers/processors (above the small-org exemption) must maintain a record of
processing activities: purposes, categories of data/subjects, recipients, transfers,
retention, and security measures. `[Inference]` LumiBase's audit log and schema can
supply technical evidence, but the ROPA itself is an organizational document.

## 6. Security & breach notification (Art. 32–34)

- **Art. 32** — appropriate technical/organizational measures (encryption,
  access control, resilience, testing). LumiBase provides several primitives —
  see [gap-analysis.md](./gap-analysis.md).
- **Art. 33** — notify the supervisory authority **without undue delay and, where
  feasible, within 72 hours** of becoming aware of a breach.
- **Art. 34** — notify affected individuals when there is a high risk.

## 7. International data transfers (Chapter V)

Transfers of personal data outside the EEA require a transfer mechanism:

- **Adequacy decision** for the destination country, or
- **Standard Contractual Clauses (SCCs)** — Commission Implementing Decision
  (EU) 2021/914 — often with a **transfer impact assessment**, or
- **Binding Corporate Rules (BCRs)** for intra-group transfers, or
- a derogation under Art. 49.

`[Inference]` Because LumiBase runs on edge infrastructure (Cloudflare Workers) with
globally distributed points of presence, data residency and transfer mechanisms are
a real design concern; document where personal data is stored/processed and pin
regions where required. Verify the current data-residency options with your host.

## 8. Controller vs. processor & DPAs (Art. 28)

When one party processes personal data on another's behalf, a **Data Processing
Agreement** is required, specifying scope, security, sub-processors, and assistance
with data-subject requests. `[Inference]` A managed LumiBase offering would need a
DPA template; a pure self-host operator is typically the controller and may not.

## 9. What this means for LumiBase

See [gap-analysis.md](./gap-analysis.md): erasure (Art. 17), access/portability
(Art. 15/20), and consent (Art. 7) are the largest gaps; audit, RLS isolation, and
field encryption support Art. 30/32.
