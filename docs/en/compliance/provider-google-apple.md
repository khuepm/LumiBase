# Distributor Policy — Google Play & Apple App Store

> App-store policies are **contractual** requirements: violating them can get an app
> rejected or removed, independent of statutory law. They matter for any app that
> uses LumiBase as a backend and ships on these stores.
>
> **⚠️ Not legal advice, and store policies change frequently.** Always check the
> current official guidelines. Dates below are marked `[Unverified]` where I could
> not confirm them against a primary source.

## 1. Apple App Store

### 1.1 Account deletion — Guideline 5.1.1(v)

Apps that support **account creation** must also let users **initiate account
deletion from within the app**. Merely deactivating or letting users contact support
is not sufficient; the deletion path must be discoverable in-app. `[Unverified]`
This requirement has been enforced since around **30 June 2022**.

`[Inference]` For a LumiBase-backed app, this means exposing a backend endpoint that
performs full account + personal-data deletion (a current gap — see
[gap-analysis.md](./gap-analysis.md)).

### 1.2 Privacy Nutrition Labels

App Store product pages must display **privacy "nutrition labels"** declaring the
data types collected, whether they are linked to the user, and whether used for
tracking. The disclosure must match actual app behavior. `[Unverified]` Required
since **December 2020**.

### 1.3 App Tracking Transparency (ATT)

Before tracking users across other companies' apps and websites (using IDFA or
similar), the app must obtain permission via the **ATT** prompt. `[Unverified]`
Enforced since **iOS 14.5 (2021)**.

### 1.4 Sign in with Apple

`[Inference]` If an app offers third-party/social login (e.g., Google/Facebook
sign-in) as the only/primary option, it generally must also offer **Sign in with
Apple**. Exceptions exist (e.g., apps using only your own account system). Verify
current scope.

### 1.5 Privacy policy

A link to a privacy policy is required in the app metadata and, typically, within
the app.

## 2. Google Play

### 2.1 Account & data deletion

Apps that allow **account creation** must offer users a way to **request deletion of
their account and associated data**, and must provide this both **in-app and via a
web URL** that can be reached without re-installing the app. `[Unverified]` The
account-deletion data-safety requirements were rolled out across **2023–2024**;
verify the current deadline and exact form.

### 2.2 Data safety section

The Play Console **Data safety** form requires declaring what data the app
collects/shares, the purposes, security practices, and whether data can be deleted on
request. The declaration must be accurate and consistent with the privacy policy.

### 2.3 User Data policy & permissions

Google Play's **User Data policy** requires transparent collection/use, a privacy
policy, requesting only necessary permissions, and prominent disclosure + consent for
sensitive data access.

## 3. Common denominator for a LumiBase-backed product

| Store requirement | Backend capability needed | LumiBase status |
|-------------------|---------------------------|:---------------:|
| In-app account deletion | Full account + data erasure endpoint | ❌ (gap) |
| Web URL for data deletion (Google) | Public, authenticated deletion request flow | ❌ (gap) |
| Accurate data-safety / privacy labels | Inventory of what's collected & shared | `~` (needs data map) |
| Privacy policy link | Operator-provided | n/a (operator) |
| Tracking consent (ATT) | Respect tracking choice; don't track without consent | `~` |

See [gap-analysis.md](./gap-analysis.md) and
[implementation-checklist.md](./implementation-checklist.md) for the backend work
implied by these store policies.
