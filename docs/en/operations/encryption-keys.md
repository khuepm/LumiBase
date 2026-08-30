---
version: 2
lastUpdated: 2026-08-30T09:36:17.873Z
sourceLang: en
contentHash: 5c222ffed069414f
codeVerified: 2026-08-30T09:36:17.873Z
codeVerifiedHash: 5c222ffed069414f
codeVerifiedClaims: 16
---

# Encryption Key Operations

How `ENCRYPTION_KEY` is used, what "rotation" does and does not cover, and what to do when a key is lost or leaked.

This matters because the same variable protects two things with **different lifecycles**: encrypted item fields, which a migration can re-wrap, and TOTP two-factor seeds, which it cannot. Treating them the same is how operators lock users out of their own accounts.

## The key set

| Variable | Meaning |
|----------|---------|
| `ENCRYPTION_KEY` | Legacy single key. Resolved as version `v0` |
| `ENCRYPTION_KEY_<id>` | Versioned key material, e.g. `ENCRYPTION_KEY_v1` |
| `ENCRYPTION_ACTIVE_KEY_ID` | Which version encrypts new data. Defaults to the only configured key, otherwise `v0` |
| `ENCRYPTION_KEY[_<id>]_FILE` | Read the key from a file instead (Docker secrets). The direct variable wins |

Each key is base64 of 32 random bytes:

```bash
openssl rand -base64 32
```

Every ciphertext is stored as a **versioned envelope**, `<keyId>:<base64(iv‖ciphertext‖tag)>`, so the row records which key wrapped it. AES-256-GCM throughout.

## What rotation covers

Adding `ENCRYPTION_KEY_v1` and setting `ENCRYPTION_ACTIVE_KEY_ID=v1` changes the key used for **new** writes. Existing rows keep their old `keyId` until something re-wraps them.

| Data | Re-wrapped by `POST /api/v1/admin/encryption/envelope/migrate`? |
|------|---|
| Encrypted item fields (`items.dek_wrapped`) | **Yes** |
| TOTP seeds (`lumibase_user_totp_credentials.secret_ciphertext`) | **No** |

The migration worker walks `items` only — see the imports at the top of `apps/cms/src/services/envelope-migration-worker.ts`. Nothing re-wraps a TOTP seed.

> **Never remove a key that TOTP seeds still reference.** `decryptTotpSecret`
> resolves the key from the envelope's `keyId`, so dropping `ENCRYPTION_KEY`
> after rotating to `v1` breaks every enrollment made under `v0`.

Check what is still in use before retiring a key:

```sql
SELECT secret_key_id, count(*)
FROM lumibase_user_totp_credentials
GROUP BY secret_key_id;
```

Keep every key id that appears here configured, indefinitely.

## Failure mode: a referenced key is missing

If the key an enrollment needs is not configured, the 2FA endpoints fail closed — no seed is ever read or written in plaintext — and report `409` with `TFA_KEY_UNAVAILABLE`, naming the key id so you know which one to restore:

```
POST /api/v1/auth/verify-totp        -> 409  TFA_KEY_UNAVAILABLE
POST /api/v1/me/tfa/recovery-codes   -> 409  TFA_KEY_UNAVAILABLE
```

Recovery codes keep working, because they are PBKDF2 hashes rather than KEK-wrapped:

```
POST /api/v1/auth/verify-totp  { recoveryCode }  -> 200
```

So an affected user signs in with a recovery code and then **removes the dead factor themselves** — `DELETE /me/tfa` accepts a recovery code in place of a TOTP code for exactly this case, and re-enrolling afterwards wraps a fresh seed under the current key:

```
DELETE /api/v1/me/tfa  { password, recoveryCode }  -> 200
POST   /api/v1/me/tfa/setup                        -> 200
```

Regenerating recovery codes is deliberately **not** available this way: topping up codes for an enrollment that can never produce a valid TOTP code again would only extend the outage.

If the key is unrecoverable and you would rather not wait for each user to notice, an operator can clear the affected enrollments in bulk. There is **no admin endpoint** for this today:

```sql
-- Per user. Removes the credential and its recovery codes (FK cascade),
-- then clears the non-secret enrollment state the Studio UI reads.
DELETE FROM lumibase_user_totp_credentials WHERE user_id = $1;
UPDATE lumibase_users SET tfa = '{}'::jsonb WHERE id = $1;
```

Tell the affected users: their second factor is gone until they re-enroll, so the account is password-only in the meantime.

## Failure mode: a key leaked

**Rotation is not remediation.** There is no per-user key derivation — one KEK wraps every seed, and the AAD (`totp-secret|<userId>`) only binds an envelope to its owner so ciphertext cannot be replayed under another user id. It is not a confidentiality boundary. Anyone holding the leaked key can decrypt every seed enrolled under it and generate valid codes indefinitely, silently, leaving nothing in the audit trail.

This is inherent to TOTP: the server has to keep the shared secret recoverable in order to verify a code. Compare the recovery codes in the same feature, which are one-way hashes and therefore not recoverable even by an operator.

Response:

1. Rotate: add a new `ENCRYPTION_KEY_<id>`, point `ENCRYPTION_ACTIVE_KEY_ID` at it. New enrollments and new item writes are protected from this point on.
2. Re-wrap item fields: `POST /api/v1/admin/encryption/envelope/migrate`, then poll it to `done`.
3. **Force TOTP re-enrollment** for everyone enrolled under the leaked key — step 2 does not touch them, and step 1 does not protect them. Use the SQL above per user, and keep the old key configured until every row has moved off it.
4. Treat sessions as suspect: disabling 2FA bumps `tokenVersion` and revokes refresh tokens for that user, which is the intended side effect here.

Escaping the property altogether means changing the mechanism rather than the storage — WebAuthn/passkeys keep only a public key server-side, so there is nothing for a leaked KEK to unlock.

## Before first enrollment

`ENCRYPTION_KEY` must be configured **before** anyone enrolls in 2FA or writes an encrypted field. Without it, `POST /api/v1/me/tfa/setup` returns `503` with `ENCRYPTION_NOT_CONFIGURED`; nothing is half-written, so enrollment works as soon as the key is in place.

Set it as a real secret, never in committed config:

```bash
# Cloudflare
wrangler secret put ENCRYPTION_KEY --env production

# Docker
ENCRYPTION_KEY_FILE=/run/secrets/encryption_key
```

## See also

- [User management → §4f Two-factor authentication](../security/user-management.md#4f-two-factor-authentication-totp)
- [Environment variables → Encryption](../deployment/environment-variables.md#encryption)
- [Upgrade operations](./upgrades.md)
