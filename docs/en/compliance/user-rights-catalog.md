---
version: 1
lastUpdated: 2026-08-02T19:19:45.470Z
sourceLang: en
contentHash: ea5ce40da5193629
---

# User Rights Catalog

> Plain-language explanation of each right an end user may be entitled to. For
> each right: what it means, a real-world example, and which regimes recognize it.
> See the per-market documents for exact article references, thresholds, and
> exemptions.
>
> **⚠️ Not legal advice.** Verify scope and obligations with qualified counsel.

## 1. Right to erasure / "right to be forgotten"

**What it is.** The user can ask you to delete the personal data you hold about
them. When no overriding legal basis to keep it exists, you must erase it (and,
where applicable, ask downstream recipients to do the same).

**Example.** A user closes their account and requests that their profile, content
drafts, and activity history be permanently removed.

**Where it applies.** EU GDPR Art. 17 · CCPA/CPRA (right to delete) · Vietnam PDPD ·
required by Google Play and Apple App Store for any app with account creation.

**Nuance.** It is not absolute — you may retain data needed for legal obligations
(e.g., tax/audit records), to establish/defend legal claims, or for security/fraud
prevention. `[Inference]` In those cases the usual practice is to anonymize or
restrict rather than hard-delete; confirm retention bases with counsel.

## 2. Right of access / right to know

**What it is.** The user can ask what personal data you hold, why you process it,
who you share it with, and obtain a copy.

**Example.** A user requests a report listing their account fields, login history,
and the categories of third parties their data was disclosed to.

**Where it applies.** GDPR Art. 15 · CCPA/CPRA (right to know) · Vietnam PDPD.

## 3. Right to data portability

**What it is.** The user can receive their data in a structured, commonly used,
machine-readable format (e.g., JSON/CSV) and, where feasible, have it transmitted
to another provider.

**Example.** A "Download my data" button that produces a ZIP of JSON/CSV files.

**Where it applies.** GDPR Art. 20 (data provided by the user, processed by consent
or contract) · CPRA (partial) · Vietnam PDPD (`~`, verify scope).

## 4. Right to rectification

**What it is.** The user can correct inaccurate personal data and complete
incomplete data.

**Example.** A user edits a misspelled name or outdated email in their profile.

**Where it applies.** GDPR Art. 16 · CPRA (right to correct) · Vietnam PDPD.

## 5. Right to restriction of processing

**What it is.** The user can ask you to temporarily "freeze" processing (store but
don't use) — e.g., while a dispute about accuracy is resolved.

**Example.** A user contests the accuracy of a record; you stop using it until
verified.

**Where it applies.** GDPR Art. 18 · partial in US/Vietnam (`~`).

## 6. Right to object / opt-out

**What it is.** The user can object to certain processing — notably direct marketing
and, in the US, the "sale" or "sharing" of personal data.

**Example.** A "Do Not Sell or Share My Personal Information" link; an opt-out of
profiling for targeted ads.

**Where it applies.** GDPR Art. 21 (objection) · CCPA/CPRA (opt-out of sale/share,
opt-out of certain profiling) · Apple ATT for cross-app tracking (`~`).

## 7. Consent and withdrawal of consent

**What it is.** Where processing relies on consent, it must be freely given,
specific, informed, and unambiguous — and as easy to withdraw as to give.

**Example.** A granular preferences screen (marketing, analytics, personalization)
where each toggle can be switched off at any time, with the change logged.

**Where it applies.** GDPR Art. 6 & 7 · Vietnam PDPD (consent is a core basis) ·
opt-in for minors/sensitive data under CPRA (`~`).

## 8. Cookie / tracking consent

**What it is.** Before storing or reading non-essential cookies/identifiers on a
device, you must obtain consent and offer a real "reject" option.

**Example.** A cookie banner with "Accept all", "Reject all", and granular controls;
on iOS, an App Tracking Transparency prompt before cross-app tracking.

**Where it applies.** EU ePrivacy Directive + GDPR · Apple ATT (device-level) ·
partial under US/Vietnam (`~`).

## 9. Email marketing unsubscribe

**What it is.** Commercial email must include a clear, working way to opt out, honor
it promptly, and must not use deceptive headers/subject lines or hide the sender.

**Example.** Every marketing email has a one-click "Unsubscribe" footer; requests
are honored within the statutory window.

**Where it applies.** US CAN-SPAM Act (mandatory unsubscribe, sender identity,
physical postal address) · EU ePrivacy (consent-based, opt-out) · Vietnam (`~`,
anti-spam rules).

## 10. Right to account deletion (in-app)

**What it is.** Distinct from store policy: if an app lets users create an account,
it must let them **initiate account and data deletion from within the app** (and,
for Apple, also via an accessible method).

**Example.** Settings → "Delete account", which removes the account and associated
personal data (not merely deactivates it).

**Where it applies.** Apple App Store Guideline 5.1.1(v) · Google Play account/data
deletion requirements · reinforces GDPR Art. 17 / CCPA delete.

## 11. Right to transparency / privacy notice

**What it is.** Users must be told, in clear language, what data you collect, why,
the legal basis, retention, sharing, and their rights — at or before collection.

**Example.** A layered privacy policy plus a store "Data safety"/"Privacy nutrition
label" disclosure that matches actual behavior.

**Where it applies.** GDPR Art. 12–14 · CCPA notice at collection · Vietnam PDPD ·
Google Play Data safety · Apple Privacy Labels.

## 12. Right to breach notification

**What it is.** On a qualifying personal-data breach, you must notify the regulator
(and sometimes affected users) within statutory deadlines.

**Example.** A documented incident-response runbook that can produce a regulator
notification within 72 hours (GDPR) of becoming aware.

**Where it applies.** GDPR Art. 33–34 (72-hour regulator notice) · US state breach
laws (`~`, vary by state) · Vietnam PDPD (notification duties).

## 13. Rights specific to automated decisions / profiling

**What it is.** Users may have the right not to be subject to solely automated
decisions with legal/significant effects, and to obtain human review.

**Example.** If LumiBase **agents** auto-publish or moderate content affecting a
user, provide a path to human review. (LumiBase's earned-autonomy / HITL model and
provenance logging are relevant here — see [gap-analysis.md](./gap-analysis.md).)

**Where it applies.** GDPR Art. 22 · partial elsewhere (`~`).

---

**Next:** map these rights to LumiBase features in
[gap-analysis.md](./gap-analysis.md).
