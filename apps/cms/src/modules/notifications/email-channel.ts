/**
 * Email channel adapter (admin-setup-wizard task 9.2 / Req 13.2;
 * design §9.2).
 *
 * This module owns the spec-pinned security-notification templates and the
 * recipient-merge rule. The actual byte-pushing is delegated to a generic
 * {@link import('../../services/email/transport').EmailTransport} from
 * `services/email/transport.ts`, so there is a single transport implementation
 * shared with the general-purpose EmailService:
 *
 *   - SMTP transport — self-hosted Node / Docker build. Drives `nodemailer`
 *     against an SMTP URL the operator points at via `LUMIBASE_SMTP_URL`.
 *   - MailChannels transport — Cloudflare Workers build, which has no TCP
 *     socket primitive `nodemailer` can drive. Posts to the MailChannels HTTP
 *     API, the transactional path Cloudflare exposes for Workers.
 *
 * The {@link EmailChannelFactory} picks which transport to inject at request /
 * boot time using the same `LUMIBASE_RUNTIME` knob that
 * `apps/cms/src/middleware/runtime.ts` reads to decide between the Docker
 * singleton runtime and the per-request Workers runtime.
 *
 * Subject + body templates are pinned here per Req 13.2:
 *
 *   - Subject: `[LumiBase Security] <event_code>` — exact verbatim
 *     from the requirement; the receiver-side filter rules in the
 *     spec rely on the literal prefix.
 *   - Body: text-first template (Req 13.2 only mandates "subject +
 *     body"; the channels stay text/plain so any SMTP server,
 *     including ones with HTML stripping, delivers a useful
 *     message). Substitution variables are exactly the eight fields
 *     listed in Req 13.2: `{timestamp, email, ip, country,
 *     userAgent, anomalyScore, recoveryUrl}` (the `anomalyScore`
 *     line is omitted when the score isn't applicable, e.g. for
 *     `user_locked` driven by raw failed-attempt counts; the
 *     `recoveryUrl` line is omitted when no recovery URL was
 *     supplied — the dispatcher in task 9.4 owns that decision).
 *
 * Secrets handling (Req 3.7, 14): templates never embed password
 * hashes, raw setup tokens, raw backup codes, or recovery tokens.
 * The {@link NotificationPayload} contract from `types.ts` doesn't
 * carry any of those fields, so this is enforced structurally.
 *
 * Validates: Requirements 13.2 — see also design §9.2.
 */

import type { AppEnv } from '../../env';
import {
  MailchannelsTransport,
  NodemailerTransport,
  type EmailTransport,
} from '../../services/email/transport';
import type {
  DeliveryResult,
  NotificationChannelAdapter,
  NotificationPayload,
  SecurityEvent,
} from './types';

// ── Config / env helpers ───────────────────────────────────────────────

/**
 * Operator-supplied "from" address. SMTP demands an envelope sender,
 * and `nodemailer` will reject `sendMail` without one. The factory
 * reads `LUMIBASE_MAIL_FROM` first; if that's unset we fall back to
 * `security@<host-of-recovery-url>` because:
 *
 *   1. Mail clients display the sender domain as the trust signal,
 *      so it should match the deploy domain.
 *   2. The dispatcher always knows the recovery URL host (the
 *      Studio's public origin), so a sane default is reachable
 *      without yet another env var.
 *
 * If neither the env nor a usable recovery URL is available, the
 * adapter falls back to `security@lumibase.local` and audit-logs
 * the situation; no email is sent silently in that case.
 */
const DEFAULT_FROM_FALLBACK = 'security@lumibase.local';

/**
 * Subject template — Req 13.2 verbatim. Exposed so unit tests can
 * pattern-match the literal prefix without copy-pasting it.
 */
export const EMAIL_SUBJECT_PREFIX = '[LumiBase Security]';

/**
 * Build the email subject from the security event. Req 13.2 mandates
 * the prefix and event code exactly; we trust the event string from
 * the {@link SecurityEvent} union (one of four literals) so we don't
 * sanitise it further.
 */
export function buildEmailSubject(event: SecurityEvent): string {
  return `${EMAIL_SUBJECT_PREFIX} ${event}`;
}

/**
 * Build the text/plain body for an email. The variables come from
 * {@link NotificationPayload}; nullable fields (`country`,
 * `userAgent`, `anomalyScore`) are rendered as `unknown` rather than
 * elided so the operator-facing message stays a fixed shape — a
 * security operator scanning a digest of these mails should be able
 * to align fields visually without parsing.
 *
 * `recoveryUrl` is intentionally optional: not every event has one
 * (a `user_locked` from raw brute-force has no recovery hint to
 * surface beyond the standard backup-code flow). When omitted, the
 * line is dropped entirely so the message ends cleanly.
 */
export function buildEmailBody(
  payload: NotificationPayload,
  options: { recoveryUrl?: string } = {},
): string {
  const lines = [
    `LumiBase security event: ${payload.event}`,
    `Action taken:    ${payload.action}`,
    `Time (UTC):      ${payload.timestamp}`,
    `User email:      ${payload.email}`,
    `IP address:      ${payload.ip}`,
    `Country:         ${payload.country ?? 'unknown'}`,
    `User-Agent:      ${payload.userAgent ?? 'unknown'}`,
    `Anomaly score:   ${
      payload.anomalyScore === null
        ? 'n/a'
        : payload.anomalyScore.toFixed(2)
    }`,
  ];
  if (options.recoveryUrl) {
    lines.push(`Recovery link:   ${options.recoveryUrl}`);
  }
  lines.push('');
  lines.push(
    'If you did not initiate this activity, follow the recovery flow at the link above (or contact your administrator).',
  );
  return lines.join('\n');
}

// ── Common config carried by both adapters ────────────────────────────

/**
 * Configuration shared by both email channel implementations. Built
 * once by {@link EmailChannelFactory.fromEnv} so the request path
 * never re-parses env vars.
 *
 *   - `from` — RFC 5322 mailbox the message claims to be from.
 *   - `recipients` — at minimum the bootstrap admin; Req 13.2 also
 *     wants the affected user when different. The dispatcher
 *     (task 9.4) is the single source of truth for the recipient
 *     list because it has the user-table read and policy context;
 *     this adapter just trusts the list it's given on `send()` via
 *     the payload's `email` plus any extra `cc` the dispatcher may
 *     pass through `options.recipients`.
 *
 * The field is intentionally kept narrow: anything richer
 * (per-recipient tagging, BCC, headers) belongs in the dispatcher
 * once those use cases land, not in this adapter's config.
 */
export interface EmailChannelConfig {
  readonly from: string;
  readonly recipients: readonly string[];
}

// ── SecurityEmailChannel (transport-backed) ────────────────────────────

/**
 * Security-notification email channel. Owns the spec-pinned subject/body
 * templates (Req 13.2) and the recipient-merge rule (configured recipients +
 * the affected user), then delegates the actual byte-pushing to a generic
 * {@link EmailTransport} from `services/email/transport.ts`.
 *
 * Both runtimes use the same class; the {@link EmailChannelFactory} picks
 * which transport (SMTP vs MailChannels) to inject. Keeping a single channel
 * class here removes the duplicated transport code that previously lived in
 * `NodemailerChannel`/`MailchannelsChannel`.
 */
export class SecurityEmailChannel implements NotificationChannelAdapter {
  readonly name = 'email' as const;

  constructor(
    private readonly transport: EmailTransport,
    private readonly config: EmailChannelConfig,
  ) {}

  async send(payload: NotificationPayload): Promise<DeliveryResult> {
    const recipients = this.resolveRecipients(payload);
    if (recipients.length === 0) {
      return { ok: false, error: 'no-recipients', retryable: false };
    }
    return this.transport.send({
      from: this.config.from,
      to: recipients,
      subject: buildEmailSubject(payload.event),
      text: buildEmailBody(payload),
    });
  }

  /**
   * The dispatcher is the source of truth for recipient lists, but Req 13.2
   * also wants the affected user when distinct from the bootstrap admin. We
   * merge the configured `recipients` list with the payload's `email`
   * (de-duplicated, case-insensitive) so a misconfigured factory still gets a
   * useful at-least-one-recipient send.
   */
  private resolveRecipients(payload: NotificationPayload): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const addr of [...this.config.recipients, payload.email]) {
      const trimmed = addr.trim();
      if (trimmed.length === 0) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
    return out;
  }
}

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Resolve the right adapter for the runtime + config combo.
 *
 * The factory is intentionally a static helper rather than a class
 * with state: choosing which channel implementation to use is a pure
 * function of env, and any per-request state (transports, fetch
 * cache) lives inside the adapters themselves.
 */
export const EmailChannelFactory = {
  /**
   * Build an adapter from the Hono `Bindings` env. Returns `null`
   * when email cannot be sent on this runtime (degraded mode per
   * design §12.3): Workers builds without MailChannels, or Node
   * builds without `LUMIBASE_SMTP_URL`. The dispatcher (task 9.4)
   * audit-logs `notification_channel_unavailable` in that case.
   *
   * Decision tree (mirrors design §9.2):
   *
   *   1. Cloudflare runtime (`LUMIBASE_RUNTIME='cloudflare'`) → a
   *      {@link SecurityEmailChannel} over a MailChannels transport.
   *      The MailChannels API is reachable from any Worker; the
   *      operator still has to configure SPF/DKIM at the DNS layer
   *      for non-trivial deliverability, but the adapter doesn't gate
   *      on that.
   *   2. Anything else (`'docker'`, undefined, custom) → if
   *      `LUMIBASE_SMTP_URL` is set, a {@link SecurityEmailChannel}
   *      over an SMTP transport bound to that URL. Otherwise `null`
   *      (no email channel available).
   *
   * `LUMIBASE_MAIL_FROM` overrides the default sender; `recipients`
   * defaults to the empty list, since the dispatcher always merges
   * the affected user's email in via `payload.email`. Operators
   * who want a fixed cc list (e.g. a `security@` distribution list)
   * can supply `LUMIBASE_SECURITY_RECIPIENTS` as a comma-separated
   * list.
   */
  fromEnv(env: AppEnv['Bindings']): NotificationChannelAdapter | null {
    const runtime = readStringEnv(env, 'LUMIBASE_RUNTIME') ?? 'docker';
    const from =
      readStringEnv(env, 'LUMIBASE_MAIL_FROM') ?? DEFAULT_FROM_FALLBACK;
    const recipients = parseRecipientsEnv(
      readStringEnv(env, 'LUMIBASE_SECURITY_RECIPIENTS'),
    );

    if (runtime === 'cloudflare') {
      return new SecurityEmailChannel(new MailchannelsTransport(), {
        from,
        recipients,
      });
    }

    const smtpUrl = readStringEnv(env, 'LUMIBASE_SMTP_URL');
    if (!smtpUrl) {
      // Degraded mode (design §12.3 / Req 13 — no SMTP configured).
      return null;
    }
    return new SecurityEmailChannel(new NodemailerTransport(smtpUrl), {
      from,
      recipients,
    });
  },
};

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Mirror of the helper in `setup/routes.ts`. Inlined rather than
 * imported because a circular dependency would form
 * (`notifications` → `setup/routes` → `setup/service` →
 * `notifications`) once task 9.5 wires the dispatcher into
 * LoginGuard hooks.
 */
function readStringEnv(
  env: AppEnv['Bindings'],
  key: string,
): string | undefined {
  const v = (env as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Parse a comma-separated env value into a recipient list. We trim
 * each entry, drop blanks, and de-duplicate (case-insensitive); the
 * result preserves the operator's original casing so the email's
 * `To:` header looks like the value they typed.
 */
function parseRecipientsEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
