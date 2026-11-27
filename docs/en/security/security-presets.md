---
sourceLang: en
version: 2
lastUpdated: 2026-11-26T21:45:23.936Z
contentHash: fd45573286a198c3
codeVerified: 2026-11-26T21:45:23.936Z
codeVerifiedHash: fd45573286a198c3
codeVerifiedClaims: 4
---

# Setup Security Presets

> **Audience:** operators running the Setup Wizard on a new instance.
>
> **TL;DR:** The wizard offers three login-security presets: **Standard**
> (the default), **Strict** and **Lenient**. A preset fills in the lockout,
> anomaly-detection and notification fields, and picks the instance email
> identity mode. Pick a preset, then switch to **Advanced setup** if you need
> to tune an individual field before the first admin account is created.

## Where the presets are defined

The values below come from `apps/studio/src/modules/setup/schemas/policy.ts`
(`STANDARD_PRESET`, `STRICT_PRESET`, `LENIENT_PRESET`, collected in
`POLICY_PRESETS`). The email identity mode each preset selects comes from
`PRESET_EMAIL_IDENTITY_MODE` in `apps/studio/src/modules/setup/setup-drafts.ts`.

## Comparison

| Field | Standard | Strict | Lenient |
|---|---|---|---|
| Failed attempts before a user lockout (`userMaxFailedAttempts`) | 5 | 3 | 10 |
| User lockout duration (`userLockoutDurationSeconds`) | 900 s (15 min) | 3600 s (60 min) | 300 s (5 min) |
| Failed attempts before an IP lockout (`ipMaxFailedAttempts`) | 20 | 10 | 50 |
| IP lockout duration (`ipLockoutDurationSeconds`) | 3600 s (60 min) | 14400 s (4 h) | 900 s (15 min) |
| Sliding window for counting failures (`lockoutWindowSeconds`) | 900 s (15 min) | 1800 s (30 min) | 300 s (5 min) |
| Geographic anomaly (`geoAnomalyEnabled`) | on | on | on |
| Time-of-day anomaly (`timeAnomalyEnabled`) | off | on | off |
| New-device anomaly (`deviceAnomalyEnabled`) | on | on | off |
| Anomaly score threshold (`anomalyScoreThreshold`) | 0.7 | 0.5 | 0.85 |
| Action on an anomaly (`anomalyAction`) | `notify_only` | `lock` | `notify_only` |
| Notification channels (`notifyChannels`) | `email` | `email` | `email` |
| Email identity mode | `exact` | `root` | `exact` |

## Choosing a preset

- **Standard**: recommended defaults for a new production project.
- **Strict**: tighter lockouts and every anomaly check. A suspicious sign-in
  locks the account instead of only notifying. Use it for instances that hold
  sensitive data or have a small, known set of staff.
- **Lenient**: lower-friction lockouts for a private development instance.
  Do not use it on a public deployment.

## Email identity mode

The email identity mode decides how address aliases map to accounts, and it
applies to registration, invites and SCIM:

- `exact`: every distinct address is its own account, so
  `test+a@gmail.com` and `test+b@gmail.com` can register separately.
- `root` (**One account per mailbox**): `+tag` aliases (and, for Gmail, dots
  and `googlemail.com`) resolve to one account instance-wide.

**Strict** selects `root`, so one mailbox cannot be used to create many
accounts. The other presets select `exact`. Choosing a preset sets the mode,
but the radio stays editable: pick the other mode afterwards if you need to.

## Customising a preset

The quick-setup review step shows every value the preset will apply. To change
a single field (custom webhook notifications, anomaly thresholds, exact lockout
windows), use **Switch to advanced setup** on that step. The advanced Security
step starts from the preset you picked, and choosing a preset card there applies
the same values, email identity mode included.

## Related docs

- [Anti-abuse mechanisms](./anti-abuse.md): how lockouts and anomaly detection
  work at runtime.
- [User management & auth realms](./user-management.md): accounts, invites and
  the email identity mode in detail.
