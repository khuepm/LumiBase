/**
 * New-device sign-in email (#739, epic #674 S10).
 *
 * Best-effort sibling of `password-reset.ts`: renders the site's
 * `new_device_login` template when one is enabled, otherwise a built-in
 * fallback, and sends it through the EmailService. Never throws.
 *
 * Content: when, approximate IP, country (if known), a device label and a
 * pointer to Settings → Security → Active sessions. No token, session id or
 * full IP is ever included. The mail goes only to the account's own address,
 * only after a successful sign-in, so it reveals nothing to the person who
 * signed in that they did not already know.
 */

import type { Database } from '@lumibase/database';
import { sites } from '@lumibase/database';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../../env';
import { EmailService } from '../../services/email/email-service';
import { TOKEN_AUDIENCE } from '../../services/auth/token-audience';
import { EmailModuleService } from './service';

export const NEW_DEVICE_TEMPLATE_KEY = 'new_device_login';

export interface NewDeviceEmailInput {
  readonly db: Database;
  readonly siteId: string;
  readonly env: AppEnv['Bindings'];
  readonly email: string;
  /** `studio` (staff) or `frontend` (member) — picks the settings link. */
  readonly audience: string;
  readonly signedInAt: Date;
  readonly ipApprox: string | null;
  readonly countryCode: string | null;
  readonly deviceLabel: string;
}

export interface NewDeviceEmailResult {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly reason?: string;
}

/** An absolute http(s) URL, or null. Anything else is ignored. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function sendNewDeviceLoginEmail(input: NewDeviceEmailInput): Promise<NewDeviceEmailResult> {
  const emailService = EmailService.fromEnv(input.env);
  if (!emailService) {
    return { attempted: false, ok: false, reason: 'email-not-configured' };
  }

  let siteUrl = '';
  let siteTitle = 'LumiBase';
  try {
    const [site] = await input.db
      .select({ siteUrl: sites.siteUrl, displayTitle: sites.displayTitle })
      .from(sites)
      .where(eq(sites.id, input.siteId))
      .limit(1);
    siteUrl = site?.siteUrl ?? '';
    siteTitle = site?.displayTitle ?? siteTitle;
  } catch {
    // Best-effort; fall through with defaults.
  }

  // Staff manage sessions in the Studio; members on the site's own frontend.
  const securityUrl =
    input.audience === TOKEN_AUDIENCE.studio
      ? safeHttpUrl(input.env.LUMIBASE_SECURITY_SETTINGS_URL) ?? ''
      : safeHttpUrl(siteUrl) ?? '';
  const where = input.audience === TOKEN_AUDIENCE.studio
    ? 'Settings → Security → Active sessions'
    : 'your account security settings';

  const when = input.signedInAt.toUTCString();
  const ip = input.ipApprox ?? 'unknown';
  const location = input.countryCode ?? '';
  const vars = {
    email: input.email,
    siteName: siteTitle,
    siteUrl,
    signedInAt: input.signedInAt.toISOString(),
    signedInAtText: when,
    ipApprox: ip,
    country: location,
    device: input.deviceLabel,
    securityUrl,
  };

  const lines = [
    `Time: ${when}`,
    `Device: ${input.deviceLabel}`,
    `Approximate IP: ${ip}${location ? ` (${location})` : ''}`,
  ];

  try {
    const service = new EmailModuleService({ db: input.db, siteId: input.siteId, emailService });
    const templates = await service.listTemplates();
    const hasTemplate = templates.some((t) => t.key === NEW_DEVICE_TEMPLATE_KEY && t.enabled);

    const { result } = hasTemplate
      ? await service.send({ to: [input.email], templateKey: NEW_DEVICE_TEMPLATE_KEY, variables: vars })
      : await service.send({
          to: [input.email],
          inline: {
            subject: `New sign-in to your ${siteTitle} account`,
            html:
              `<p>Your <strong>${escape(siteTitle)}</strong> account was just signed in to from a device we have not seen before.</p>` +
              `<ul>${lines.map((l) => `<li>${escape(l)}</li>`).join('')}</ul>` +
              `<p>If this was you, there is nothing to do.</p>` +
              `<p>If it was not you, sign that session out in ${
                securityUrl
                  ? `<a href="${escape(securityUrl)}">${escape(where)}</a>`
                  : `<strong>${escape(where)}</strong>`
              } and change your password.</p>`,
            text:
              `Your ${siteTitle} account was just signed in to from a device we have not seen before.\n\n` +
              `${lines.join('\n')}\n\n` +
              `If this was you, there is nothing to do.\n` +
              `If it was not you, sign that session out in ${where}${securityUrl ? ` (${securityUrl})` : ''} and change your password.`,
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
