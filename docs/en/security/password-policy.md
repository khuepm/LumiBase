---
sourceLang: en
version: 1
lastUpdated: 2026-11-14T02:11:57.440Z
contentHash: ead870c8af02e0df
codeVerified: 2026-11-14T02:11:57.440Z
codeVerifiedHash: ead870c8af02e0df
codeVerifiedClaims: 22
---

# Password Policy

> **Audience:** operators who decide how strong account passwords must be, and
> integrators building sign-up / reset pages against the LumiBase API.
>
> **TL;DR:** One configurable policy (length, character classes, a
> zxcvbn-style strength score, an optional breach check) is enforced on every
> path that sets a password. A rejected password gets a `PASSWORD_POLICY`
> error that names each failed rule. The breach check (Have I Been Pwned) is
> **off by default**.

## Where the policy applies

Every request that sets a new password goes through the same service,
`apps/cms/src/services/auth/password-policy.ts`:

| Path | Endpoint |
|---|---|
| Self-service registration | `POST /api/v1/auth/register` |
| Change own password | `POST /api/v1/me/change-password` |
| Reset via e-mailed link (also how an invited teammate sets a first password) | `POST /api/v1/auth/reset-password` |
| Setup wizard (bootstrap admin) | `POST /api/v1/setup/complete` |
| Backup-code recovery reset | `POST /api/v1/admin/security/reset-password` |

Signing in never re-checks the policy: an existing password keeps working
after the policy is tightened, and the new rules apply the next time that
password is changed.

## The rules

The rules live in `packages/contracts/src/schemas/password-policy.ts`, so the
Studio checklist and the server run the exact same code.

| Setting | Default | Rule id in errors |
|---|---|---|
| `minLength` (8–128) | `12` | `min_length` |
| — (fixed at 256) | — | `max_length` |
| `requireLowercase` | `true` | `lowercase` |
| `requireUppercase` | `true` | `uppercase` |
| `requireDigit` | `true` | `digit` |
| `requireSpecial` (one of `!@#$%^&*()-_=+[]{};:,.?/`) | `true` | `special` |
| `minStrength` (0–4, `0` turns it off) | `2` | `min_strength` |
| `breachCheck` | `false` | `not_breached` |

### Strength score

`minStrength` uses a zxcvbn-style score from 0 (very weak) to 4 (very strong),
computed by `packages/contracts/src/schemas/password-strength.ts`. The password
is split into the cheapest sequence of patterns an attacker would try first —
common passwords, the account's own e-mail or name, `abc` / `123` sequences,
repeats, keyboard walks such as `qwerty`, and years — and the estimated number
of guesses is mapped onto zxcvbn's buckets (`< 10^3`, `< 10^6`, `< 10^8`,
`< 10^10`, above).

It is in-house rather than the `zxcvbn` package so the same score comes out on
Cloudflare Workers, Node and the browser without shipping ~400 KB of
dictionaries into the Worker. Its built-in dictionary is short on purpose: it
catches the obvious; the breach check is the real "known leaked" test.

So `Password1234!` passes every character-class rule but fails `min_strength`
with the reason "it contains a commonly used password".

### Breach check (optional, off by default)

With `breachCheck: true`, a new password that already passes the local rules
is looked up in the Have I Been Pwned range API using k-anonymity:

- only the first 5 hex characters of its SHA-1 are sent to
  `api.pwnedpasswords.com`; the match happens locally;
- the request carries `Add-Padding: true`, so the response size does not
  reveal how many suffixes matched;
- a password found in the corpus fails with `not_breached`.

It is off by default because even a 5-character prefix leaves the instance on
every password change — an operator decision. If the lookup times out (3 s) or
the service errors, the check **fails open**: the password is accepted, a
warning is logged and a `password_breach_check_unavailable` audit event is
written, so an outage of a third party never blocks password changes.

## Error format

A rejected password returns `400`. For `Kx9mQz7wPa` under the default policy:

```json
{
  "errors": [
    {
      "code": "PASSWORD_POLICY",
      "message": "Password does not meet the policy: min_length — Use at least 12 characters (currently 10). special — Add a special character, one of !@#$%^&*()-_=+[]{};:,.?/",
      "rules": [
        { "rule": "min_length", "ok": false, "min": 12, "actual": 10, "message": "Use at least 12 characters (currently 10)." },
        { "rule": "max_length", "ok": true, "max": 256, "actual": 10, "message": "Use at most 256 characters." },
        { "rule": "lowercase", "ok": true, "message": "Add a lowercase letter (a–z)." },
        { "rule": "uppercase", "ok": true, "message": "Add an uppercase letter (A–Z)." },
        { "rule": "digit", "ok": true, "message": "Add a digit (0–9)." },
        { "rule": "special", "ok": false, "chars": "!@#$%^&*()-_=+[]{};:,.?/", "message": "Add a special character, one of !@#$%^&*()-_=+[]{};:,.?/" },
        { "rule": "min_strength", "ok": true, "min": 2, "actual": 4, "weaknesses": [], "message": "Strength is very strong." }
      ]
    }
  ]
}
```

`rules` lists every rule that was evaluated with `ok: true | false`; `message`
names each failed rule. Build your UI from `rules[].rule`, not from the
message text.

## Reading and changing the policy

| Endpoint | Who | Returns |
|---|---|---|
| `GET /api/v1/auth/password-policy` | anyone (no session) | the public rule set plus `maxLength` and `specialChars` |
| `GET /api/v1/admin/password-policy` | site admin | the stored policy |
| `PUT /api/v1/admin/password-policy` | bootstrap admin only | the saved policy (every change is audit-logged as `password_policy_changed`) |

The public endpoint exists so reset, registration and invite pages can render
a live checklist before the user has a session. It exposes only what a user
needs to pick a compliant password.

The policy is **instance-wide**. It is stored as the `password_policy` row of
`lumibase_settings` under the `__default__` site, because passwords belong to
the global `users` table: a per-site policy would let the weakest site set the
password every other site accepts. A `password_policy` row written into any
other site's settings is ignored. A missing or malformed row means the
default policy.

```bash
curl -X PUT "$CMS/api/v1/admin/password-policy" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"minLength": 14, "minStrength": 3, "breachCheck": true}'
```

Omitted fields take their defaults; unknown fields are rejected.

## Studio

Every Studio password form shows a strength meter and a live rule checklist
driven by the same evaluator (`apps/studio/src/components/password-policy-checklist.tsx`):
Settings → Security → **Change password**, and the backup-code recovery reset.
The setup wizard's account step keeps its zxcvbn meter (score ≥ 3) and also
requires the shared strength rule, so it never accepts a password the server
would reject at the last step. When the breach check is on, the checklist says
so and shows the server's verdict after submit.
