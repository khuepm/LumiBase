/**
 * Teammate-invite email helper.
 *
 * Best-effort: renders the site's `teammate_invite` template if one exists,
 * otherwise falls back to a built-in message, then sends via the
 * general-purpose EmailService. Never throws — the invite DB row is the source
 * of truth, the email is a courtesy. Returns a small result the caller can
 * audit/log but does not have to act on.
 *
 * Wire this AFTER the invite row is committed so a mail failure can't roll the
 * invite back, mirroring the security dispatcher's degrade-cleanly posture.
 */

import type { Database } from '@lumibase/database';
import { sites } from '@lumibase/database';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../../env';
import { EmailService } from '../../services/email/email-service';
import { EmailModuleService } from './service';

const DEFAULT_TEMPLATE_KEY = 'teammate_invite';

export interface InviteEmailResult {
  attempted: boolean;
  ok: boolean;
  reason?: string;
}

export async function sendTeammateInvite(opts: {
  db: Database;
  siteId: string;
  env: AppEnv['Bindings'];
  email: string;
  /** Display name of the inviter, for the message body. */
  invitedBy?: string;
}): Promise<InviteEmailResult> {
  const emailService = EmailService.fromEnv(opts.env);
  if (!emailService) {
    return { attempted: false, ok: false, reason: 'email-not-configured' };
  }

  // Resolve the site's public URL for the call-to-action link.
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

  const service = new EmailModuleService({ db: opts.db, siteId: opts.siteId, emailService });
  const vars = {
    email: opts.email,
    siteName: siteTitle,
    siteUrl,
    invitedBy: opts.invitedBy ?? siteTitle,
  };

  try {
    // Prefer a stored template; fall back to a built-in message.
    const templates = await service.listTemplates();
    const hasTemplate = templates.some((t) => t.key === DEFAULT_TEMPLATE_KEY && t.enabled);

    const { result } = hasTemplate
      ? await service.send({ to: [opts.email], templateKey: DEFAULT_TEMPLATE_KEY, variables: vars })
      : await service.send({
          to: [opts.email],
          inline: {
            subject: `You've been invited to ${siteTitle}`,
            html: `<p>You've been invited to join <strong>${escape(siteTitle)}</strong> on LumiBase.</p>${
              siteUrl ? `<p><a href="${escape(siteUrl)}">Open ${escape(siteTitle)}</a></p>` : ''
            }<p>Sign in with this email address to accept.</p>`,
            text: `You've been invited to join ${siteTitle} on LumiBase.${
              siteUrl ? `\nOpen: ${siteUrl}` : ''
            }\nSign in with this email address to accept.`,
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
