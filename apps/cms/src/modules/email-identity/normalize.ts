/**
 * Email identity normalisation (#794).
 *
 * Two keys are derived from an address:
 *
 *   - {@link emailRoot}: the mailbox the address is *treated as* delivering
 *     to. `+tag` is stripped from the local part on every domain (a leading
 *     `+` is kept so the result never has an empty local part); for Gmail the
 *     local part also loses its dots and `googlemail.com` folds to `gmail.com`.
 *
 *     Stripping `+tag` on every domain is a **product-policy choice**, not a
 *     fact about mail delivery: sub-addressing is a provider convention, and on
 *     a domain that does not implement it `a+b@x` may be a different mailbox
 *     from `a@x`. Operators opt into that trade-off by choosing `root` mode (or
 *     a strict site); the default `exact` mode never applies it.
 *   - {@link canonicalEmail}: the account key under the instance's
 *     {@link EmailIdentityMode} — `exact` keeps today's behaviour (case-folded
 *     address), `root` collapses every alias onto its root mailbox.
 *
 * The database derives the same values in `lumibase_email_root()` /
 * `lumibase_users_email_identity()` (migration 0027), which is what actually
 * populates `users.email_root` / `users.email_canonical`. This module is the
 * request-side mirror used for lookups; an integration test pins both to the
 * same fixture list so they cannot drift.
 */

import { normalizeEmail } from '../login-guard/email-normalize';

export const EMAIL_IDENTITY_MODES = ['exact', 'root'] as const;
export type EmailIdentityMode = (typeof EMAIL_IDENTITY_MODES)[number];

const GMAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

export function isEmailIdentityMode(value: unknown): value is EmailIdentityMode {
  return typeof value === 'string' && (EMAIL_IDENTITY_MODES as readonly string[]).includes(value);
}

/** Root mailbox of `input`. Inputs without a usable `local@domain` shape are only case-folded. */
export function emailRoot(input: string | null | undefined): string {
  const email = normalizeEmail(input);
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return email;

  let local = email.slice(0, at);
  let domain = email.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);

  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    const undotted = local.replace(/\./g, '');
    if (undotted !== '') local = undotted;
  }
  return `${local}@${domain}`;
}

/** Account key for `input` under `mode` — the value compared with `users.email_canonical`. */
export function canonicalEmail(input: string | null | undefined, mode: EmailIdentityMode): string {
  return mode === 'root' ? emailRoot(input) : normalizeEmail(input);
}
