# US — CCPA/CPRA & CAN-SPAM

> Key US obligations relevant to a CMS/Content OS. The US has no single federal
> privacy law; California's regime is the de-facto baseline, with a growing set of
> other state laws.
>
> **⚠️ Not legal advice.** Applicability depends on revenue, data volume, and
> whether you "sell"/"share" data. Confirm thresholds with counsel.

## 1. CCPA / CPRA (California)

- **CCPA** — California Consumer Privacy Act, effective **1 Jan 2020**.
- **CPRA** — California Privacy Rights Act, amended CCPA; most provisions effective
  **1 Jan 2023**, enforcement from **1 July 2023**. Established the California
  Privacy Protection Agency (CPPA).

`[Inference]` Applicability is gated by thresholds (e.g., annual revenue, number of
consumers/households, or share of revenue from selling data). A small self-hosted
deployment may fall below them; verify against current thresholds.

### Consumer rights

| Right | Requirement |
|-------|-------------|
| Know / access | Disclose categories and specific pieces of personal information collected, sources, purposes, and recipients. |
| Delete | Delete personal information on request (with exceptions). |
| Correct | (CPRA) Correct inaccurate personal information. |
| Opt-out of sale/sharing | Provide a **"Do Not Sell or Share My Personal Information"** link; honor opt-out preference signals (e.g., Global Privacy Control). |
| Limit use of sensitive PI | (CPRA) Let consumers limit use/disclosure of sensitive personal information. |
| Non-discrimination | Don't penalize users for exercising rights. |

### Notices & timing

- **Notice at collection** at or before the point of collection.
- Respond to verifiable consumer requests generally **within 45 days** (extendable).
- For minors: opt-**in** consent to sell/share data is required (under 16).

## 2. CAN-SPAM Act (commercial email)

The CAN-SPAM Act (2003) applies to commercial email. Core requirements:

- **No deceptive headers** — "From", "To", routing, and originating info must be
  accurate.
- **No deceptive subject lines.**
- **Identify the message as an ad** (where applicable).
- **Include a valid physical postal address.**
- **Provide a clear opt-out (unsubscribe)** mechanism and **honor it promptly**
  (the statute sets a window after the request; commonly cited as 10 business days).
- **Monitor what others do on your behalf** — you remain responsible if a vendor
  sends on your behalf.

`[Inference]` For LumiBase, any feature that sends email (flows, notifications,
campaigns) should attach an unsubscribe link and suppress messages to opted-out
addresses. This is a current gap — see [gap-analysis.md](./gap-analysis.md).

## 3. Other state privacy laws

`[Unverified]` Beyond California, multiple states have enacted comprehensive privacy
laws (e.g., Virginia VCDPA, Colorado CPA, Connecticut, Utah, Texas, and others), and
the list keeps growing with staggered effective dates. They broadly mirror access /
delete / correct / opt-out rights but differ on thresholds, definitions, and
opt-out of targeted advertising/profiling. Treat the CCPA/CPRA design as a baseline
and confirm the specific states you operate in with counsel.

## 4. Sector & breach laws

- **State data-breach notification laws** exist in all 50 states with differing
  triggers and timelines (`~`).
- `[Unverified]` Sector rules (e.g., HIPAA for health, GLBA for finance, COPPA for
  children under 13) may apply depending on content/users; verify if relevant.

## 5. What this means for LumiBase

The largest US-driven gaps are: a **delete/erasure** workflow, an **opt-out / "Do
Not Sell or Share"** mechanism and preference storage, and **email unsubscribe**
handling. See [gap-analysis.md](./gap-analysis.md).
