# Vietnam — PDPD, Cybersecurity & Content Licensing

> Vietnam-specific obligations: personal data protection, data localization, and the
> content-publishing licensing regime that can apply to a CMS used to publish public
> content in Vietnam.
>
> **⚠️ Not legal advice.** Vietnamese regulation in this area is evolving quickly.
> Several claims below are marked `[Inference]`/`[Unverified]`; verify against the
> original Vietnamese-language texts and with local counsel.

## 1. Personal Data Protection Decree (PDPD)

- **Decree 13/2023/NĐ-CP** on protection of personal data ("Nghị định 13/2023/NĐ-CP
  về bảo vệ dữ liệu cá nhân"), effective **1 July 2023**.

Key concepts:

- **Personal data** is split into **basic** and **sensitive** categories, with
  stricter handling for sensitive data.
- **Consent** is a central lawful basis: it must be obtained for processing, can be
  withdrawn, and the data subject must be informed of purposes.
- **Data subject rights** broadly include the right to be informed, to consent/
  withdraw consent, to access, to correct, to delete, to restrict, to object, and
  to complain/claim. `[Inference]` These mirror GDPR-style rights; confirm the exact
  enumerated rights and exceptions in the decree text.
- **Personal Data Processing Impact Assessment ("hồ sơ đánh giá tác động xử lý dữ
  liệu cá nhân", DPIA-equivalent)** must be prepared and kept available; in some
  cases dossiers are filed with the authority (the Ministry of Public Security /
  A05). `[Inference]` Confirm current filing requirements and deadlines.
- **Cross-border transfer** of Vietnamese personal data requires preparing a
  transfer impact dossier and may require notification/availability to the
  authority. `[Inference]` Verify the current procedure.

> `[Unverified]` A higher-level **Law on Personal Data Protection** ("Luật Bảo vệ dữ
> liệu cá nhân") has been in the legislative pipeline to elevate/replace parts of
> Decree 13/2023. Check whether it has been enacted and its effective date before
> relying on the decree alone.

## 2. Cybersecurity & data localization

- **Law on Cybersecurity** ("Luật An ninh mạng") No. 24/2018/QH14, effective
  **1 Jan 2019**.
- **Decree 53/2022/NĐ-CP** guiding the Law on Cybersecurity, effective
  **1 Oct 2022** — contains **data localization** and local-presence expectations
  for certain service providers handling Vietnamese users' data. `[Inference]` Scope
  and triggers depend on the type of service and data; verify whether they apply to
  a given LumiBase deployment.
- **Law on Network Information Security** ("Luật An toàn thông tin mạng", "ATTTM")
  No. 86/2015/QH13, effective **1 July 2016** — covers information security,
  protection of personal information in cyberspace, and anti-spam principles.

`[Inference]` Because LumiBase can run on globally distributed edge infrastructure,
data-localization expectations are a concrete design concern when serving Vietnamese
users. Document where data physically resides and whether in-country storage is
required.

## 3. Content publishing & licensing

If a LumiBase deployment is used to **publish public-facing content/news in
Vietnam**, content-sector licensing may apply on top of data protection:

- **Decree 147/2024/NĐ-CP** on management, provision, and use of internet services
  and online information (replacing Decree 72/2013/NĐ-CP), `[Unverified]` reported
  effective **25 Dec 2024** — governs general/aggregated information sites, social
  networks, account verification, and content-management obligations.
- **Law on Press** ("Luật Báo chí") No. 103/2016/QH13 — `[Inference]` applies if the
  content qualifies as press/journalism; press activity requires a license.
- **Law on Publishing** ("Luật Xuất bản") No. 19/2012/QH13 — `[Inference]` applies to
  formal publishing activities.

`[Inference]` Whether a publishing license is required depends entirely on **what**
is published and by whom — a private knowledge base differs from a public news site.
LumiBase is a tool; the licensing obligation sits with the operator/publisher.
Confirm with local counsel which (if any) license is needed for your use case.

## 4. What this means for LumiBase

- Reuse the same **erasure / access / consent** building blocks needed for GDPR (see
  [gap-analysis.md](./gap-analysis.md)).
- Add **data-residency / region pinning** awareness for localization obligations.
- Provide operator guidance that publishing licensing is the **operator's**
  responsibility, not the platform's.
