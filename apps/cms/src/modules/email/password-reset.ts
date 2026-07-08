/**
 * Password-reset email helper.
 *
 * Best-effort sibling of {@link import('./verify-email').sendVerificationEmail}:
 * renders the site's `password_reset` template if one exists, otherwise a
 * built-in fallback, then sends via the EmailService. Never throws. The
 * reset link points at the site frontend, which reads `?token=` and POSTs
 * it (with the new password) to `/api/v1/auth/reset-password`.
 */

import type { Database } from '@lumibase/database';
import { sites } from '@lumibase/database';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../../env';
import { EmailService } from '../../services/email/email-service';
import { EmailModuleService } from './service';

const DEFAULT_TEMPLATE_KEY = 'password_reset';

export interface PasswordResetEmailResult {
  attempted: boolean;
  ok: boolean;
  reason?: string;
}

export async function sendPasswordResetEmail(opts: {
  db: Database;
  siteId: string;
  env: AppEnv['Bindings'];
  email: string;
  /** Raw reset token to embed in the link. */
  token: string;
}): Promise<PasswordResetEmailResult> {
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

  const resetUrl = siteUrl
    ? `${siteUrl}/reset-password?token=${encodeURIComponent(opts.token)}`
    : '';

  const service = new EmailModuleService({ db: opts.db, siteId: opts.siteId, emailService });
  const vars = {
    email: opts.email,
    siteName: siteTitle,
    siteUrl,
    resetUrl,
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
            subject: `Reset your password for ${siteTitle}`,
            html: `<p>We received a request to reset your <strong>${escape(siteTitle)}</strong> password.</p>${
              resetUrl
                ? `<p><a href="${escape(resetUrl)}">Reset your password</a></p>`
                : '<p>Use the reset token provided to set a new password.</p>'
            }<p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>`,
            text: `We received a request to reset your ${siteTitle} password.${
              resetUrl ? `\nReset your password: ${resetUrl}` : ''
            }\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
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
