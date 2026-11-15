---
version: 2
sourceLang: en
lastUpdated: 2026-11-14T02:09:40.218Z
contentHash: 8650a495d7a9cd06
codeVerified: 2026-11-14T02:09:40.218Z
codeVerifiedHash: 8650a495d7a9cd06
codeVerifiedClaims: 14
---

# Security History and New-Device Sign-in Email

> **Audience:** staff using the Studio, frontend developers building a member
> account page, and operators configuring email.
>
> **TL;DR:** every signed-in user can read their own security events —
> sign-ins, failed attempts, new devices, password and two-factor changes,
> signed-out sessions — from `GET /api/v1/me/security-history`, and export
> them as CSV or JSON. A sign-in from a device the account has not used before
> sends an email to the account owner.

## 1. What the history contains

The history is read from the security audit log (`lumibase_audit_log`). Only
the audit events below are ever returned, each under a friendly `kind`. Other
audit events, such as setup, policy changes or exports, are never shown.

| `kind` | Audit event | Recorded when |
| --- | --- | --- |
| `sign_in` | `login_success` | A password or TOTP sign-in succeeded. `details.method` is `password` or `totp`. |
| `sign_in_failed` | `login_failed` | A wrong password was entered for the account. `details.reason` gives the cause. |
| `mfa_challenge_failed` | `mfa_verify_failed` | A wrong two-factor code was entered. |
| `new_device` | `new_device_login` | A sign-in came from a device the account had not used before (see §3). `details.notified` says whether the email was sent. |
| `suspicious_sign_in` | `anomaly_triggered` | The anomaly detector flagged a sign-in. |
| `account_locked` | `user_locked` | Too many failed attempts locked the account. |
| `account_unlocked` | `user_unlocked` | An administrator unlocked the account. |
| `password_changed` | `password_changed` | The password was changed from the profile. |
| `password_reset_requested` | `password_reset_requested` | A reset link was requested. |
| `password_reset` | `password_reset_completed` | The password was reset through a link. |
| `mfa_enabled` | `mfa_enrolled` | Two-factor authentication was turned on. |
| `mfa_disabled` | `mfa_disabled` | Two-factor authentication was turned off. |
| `session_revoked` | `session_revoked` | One session was signed out. |
| `sessions_revoked` | `sessions_revoked` | Other sessions, or all of them, were signed out. |
| `session_token_reuse` | `refresh_token_reuse_detected` | A refresh token was used twice, so the session was ended. |

The kinds are defined once in `packages/contracts/src/security-history.ts`
and mapped in `apps/cms/src/modules/security-history/events.ts`.

### Redaction

- **Your events only.** The subject of each audit row is resolved from
  `metadata.targetUserId`, then `metadata.userId`, then the target email, then
  the actor email. An administrator's action on someone else never appears in
  the administrator's own history. Rows older than the account are excluded,
  so failed attempts against an address before it was registered stay hidden.
- **Approximate IP.** `ipApprox` keeps the network part only: `203.0.113.x`
  for IPv4, the first 48 bits (`2001:db8:85a3::/48`) for IPv6.
- **Other people's details are dropped.** When an administrator performed the
  action (for example `account_unlocked`), the item carries no IP, User-Agent
  or country.
- **No secrets.** `details` is a per-kind allow-list of small values. Session
  ids, token ids, request ids, emails and anomaly scores are never returned.

## 2. API

Both endpoints require a signed-in user. They work for staff (`studio`
tokens) and for members (`frontend` tokens). An API key or anonymous caller
gets `401`.

### `GET /api/v1/me/security-history`

| Query | Default | Meaning |
| --- | --- | --- |
| `limit` | `25` | Page size, `1`–`100`. |
| `cursor` | — | The `meta.nextCursor` of the previous page. |
| `scope` | `site` | `site` or `account`, see below. |

```json
{
  "data": [
    {
      "id": "0193…",
      "kind": "new_device",
      "occurredAt": "2026-11-14T10:00:00.000Z",
      "siteId": "site_abc",
      "ipApprox": "203.0.113.x",
      "userAgent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) …",
      "countryCode": "VN",
      "details": { "deviceLabel": "Chrome on Android", "notified": true }
    }
  ],
  "meta": { "nextCursor": "MjAyNi0xMS0xNFQxMDowMDowMC4wMDBafDAxOTM…", "limit": 25, "scope": "site" }
}
```

Items are newest first. `nextCursor` is `null` on the last page. A malformed
`cursor`, `limit` or `scope` returns `400 VALIDATION_ERROR`.

### `GET /api/v1/me/security-history/export`

`?format=json` (default) or `?format=csv`, plus `scope`. The response is a
download (`Content-Disposition: attachment`) of every event in scope, newest
first, up to 5,000 rows; `X-Export-Truncated: true` says the cap was hit.
JSON comes as `{ data, meta: { exportedAt, count, truncated, scope } }`.
CSV has the columns `occurredAt,kind,siteId,ipApprox,countryCode,userAgent,details`;
cells starting with `=`, `+`, `-` or `@` get a leading `'` so a spreadsheet
does not run them as formulas. Exports are limited to 10 per user per
15 minutes (`429 RATE_LIMITED`).

### Users with several sites

Each request runs under one site (`X-Lumi-Site`), and every audit row is
stored with the site it was recorded under.

- `scope=site` (default) returns the events recorded under the current site.
- `scope=account` also returns events from every site the user is a direct
  member of (`lumibase_user_sites`). Use it to see account-wide changes made
  through another site: the password, two-factor setting and lockout state
  belong to the account, not to one site. Rows of sites the user does not
  belong to are never read. Each item carries its `siteId`.

The history is kept as long as the audit log keeps it:
`LUMIBASE_AUDIT_RETENTION_DAYS`, 90 days by default.

## 3. New-device sign-in email

After a successful sign-in, by password or by password plus TOTP, the server
checks whether the device is new for the account. If it is, it emails the
account's own address.

**What counts as a device.** The anomaly detector's device fingerprint: a
SHA-256 of the User-Agent with version numbers removed, plus the
`Accept-Language` header (`apps/cms/src/modules/anomaly/device.ts`). Known
devices are the last 20 fingerprints kept in
`lumibase_login_baselines.device_fingerprints`. No extra table is used. A
browser update does not make a new device. The IP address is not part of the
key, because home and mobile IPs change often; it is reported in the email
instead. The device is learned even when the anomaly detector's device check
is turned off in the lockout policy.

**When the email is sent.** All of these must be true:

- the account has signed in successfully before;
- at least one device is already recorded for it, so the first sign-in after
  upgrading records the device without sending an email;
- the fingerprint is not among the known devices;
- the request has a User-Agent.

**What it says.** The time, the device label (for example "Chrome on
Android"), the approximate IP and country, and where to sign the session out:
for staff, **Settings → Security → Active sessions** in the Studio, linked when
`LUMIBASE_SECURITY_SETTINGS_URL` is set; for members, the site URL. It never
contains a token, session id or the full IP. A site can replace the built-in
text with an email template whose key is `new_device_login`. The template
variables are `email`, `siteName`, `siteUrl`, `signedInAt`, `signedInAtText`,
`ipApprox`, `country`, `device` and `securityUrl`.

**Delivery.** The email is sent after the response, so sign-in never waits
for the mail server. On Cloudflare Workers the send runs under `waitUntil`;
on Docker it runs detached in the same process. It normally leaves within
seconds of the sign-in. Email must be configured (SMTP or MailChannels);
without it, the event is still recorded with `notified: false`.

**Limits and privacy.** At most 3 new-device emails per user per hour. Further
new devices in that hour are still recorded in the history
(`notified: false`). The email goes only to the account owner, after the
password (and code) were accepted. The sign-in response, its status and its
timing are the same whether or not an email is sent, so the feature reveals
nothing about whether an account exists.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LUMIBASE_SECURITY_SETTINGS_URL` | unset | Absolute URL of the Studio security page, for example `https://cms.example.com/settings/security#active-sessions`. Linked from the email sent to staff. |

## 4. Studio

**Settings → Security → Security history** lists the events with the device
name, approximate IP and country. Events worth a second look (failed
attempts, new devices, flagged sign-ins, lockouts, token reuse) are marked
**Review**. A selector switches between **This site** and **All my sites**,
and **Export CSV** / **Export JSON** download the file through the export
endpoint.

## 5. Related

- [User management](./user-management.md) — sessions (§4e), realms and roles.
- [Anti-abuse](./anti-abuse.md) — lockout and anomaly detection.
