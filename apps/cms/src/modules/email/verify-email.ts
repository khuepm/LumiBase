/**
 * Email-verification email helper for self-service registration.
 *
 * Best-effort sibling of {@link import('./invite').sendTeammateInvite}:
 * renders the site's `email_verification` template if one exists,
 * otherwise falls back to a built-in message, then sends via the
 * general-purpose EmailService. Never throws — the (unverified) user row
 * is the source of truth; the email is the courtesy that lets them
 * activate. Wire this AFTER the user row is committed so a mail failure
 * can't roll the registration back.
 *
 * The verification link points at the site's frontend, which is expected
 * to read the `token` query param and POST it to
 * `/api/v1/auth/verify-email`. We never email the raw token on its own —
 * it travels only inside the link.
 */

import type { Database } from '@lumibase/database';
import { sites } from '@lumibase/database';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../../env';
import { EmailService } from '../../services/email/email-service';
import { EmailModuleService } from './service';

const DEFAULT_TEMPLATE_KEY = 'email_verification';

export interface VerifyEmailResult {
  attempted: boolean;
  ok: boolean;
  reason?: string;
}

export async function sendVerificationEmail(opts: {
  db: Database;
  siteId: string;
  env: AppEnv['Bindings'];
  email: string;
  /** Raw verification token to embed in the activation link. */
  token: string;
}): Promise<VerifyEmailResult> {
  const emailService = EmailService.fromEnv(opts.env);
  if (!emailService) {
    return { attempted: false, ok: false, reason: 'email-not-configured' };
  }

  let siteUrl = '';
  let siteTitle = 'LumiBase';
  try {
    const [site] = await opts.db
      .select({ siteUrl: sites.siteUrl, displayTitle: sites.displayTitle })
      .from(sites)
      .where(eq(sites.id, opts.siteId))
      .limit(1);
    siteUrl = site?.siteUrl ?? '';
    siteTitle = site?.displayTitle ?? siteTitle;
  } catch {
    // Best-effort; fall through with defaults.
  }

  // The frontend owns the verification page; it reads `?token=` and calls
  // POST /api/v1/auth/verify-email. When the site has no public URL
  // configured we still send the token so an operator can wire a link.
  const verifyUrl = siteUrl
    ? `${siteUrl}/verify-email?token=${encodeURIComponent(opts.token)}`
    : '';

  const service = new EmailModuleService({ db: opts.db, siteId: opts.siteId, emailService });
  const vars = {
    email: opts.email,
    siteName: siteTitle,
    siteUrl,
    verifyUrl,
    token: opts.token,
  };

  try {
    const templates = await service.listTemplates();
    const hasTemplate = templates.some((t) => t.key === DEFAULT_TEMPLATE_KEY && t.enabled);

    const { result } = hasTemplate
      ? await service.send({ to: [opts.email], templateKey: DEFAULT_TEMPLATE_KEY, variables: vars })
      : await service.send({
          to: [opts.email],
          inline: {
            subject: `Confirm your email for ${siteTitle}`,
            html: `<p>Thanks for signing up to <strong>${escape(siteTitle)}</strong>.</p>${
              verifyUrl
                ? `<p><a href="${escape(verifyUrl)}">Confirm your email address</a></p>`
                : '<p>Use the verification token provided by your administrator to activate your account.</p>'
            }<p>This link expires in 24 hours. If you didn't request this, you can ignore this email.</p>`,
            text: `Thanks for signing up to ${siteTitle}.${
              verifyUrl ? `\nConfirm your email: ${verifyUrl}` : ''
            }\nThis link expires in 24 hours. If you didn't request this, you can ignore this email.`,
          },
          variables: vars,
        });

    return { attempted: true, ok: result.ok, reason: result.ok ? undefined : result.error };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown-error',
    };
  }
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
