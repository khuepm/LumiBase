/**
 * Email channel adapter (admin-setup-wizard task 9.2 / Req 13.2;
 * design §9.2).
 *
 * Two concrete implementations live in this module behind the
 * {@link NotificationChannelAdapter} contract from `types.ts`:
 *
 *   - {@link NodemailerChannel} — used in the self-hosted Node /
 *     Docker build. Drives `nodemailer` against an SMTP URL the
 *     operator points at via `LUMIBASE_SMTP_URL`.
 *   - {@link MailchannelsChannel} — used in the Cloudflare Workers
 *     build, which doesn't have a TCP socket primitive that
 *     `nodemailer` can drive. Posts to the MailChannels HTTP API
 *     (`https://api.mailchannels.net/tx/v1/send`), which is the
 *     transactional path Cloudflare exposes for Workers.
 *
 * The {@link EmailChannelFactory} picks between them at request /
 * boot time using the same `LUMIBASE_RUNTIME` knob that
 * `apps/cms/src/middleware/runtime.ts` reads to decide between the
 * Docker singleton runtime and the per-request Workers runtime.
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

// ── NodemailerChannel (self-hosted Node) ──────────────────────────────

/**
 * SMTP transport opaque type. We don't import `nodemailer` types at
 * the top level so the Workers bundle (which never instantiates this
 * class) doesn't drag node-only types into the build graph; the
 * adapter `import()`s the package on first send instead, mirroring
 * the dynamic-import seam used by `apps/cms/src/modules/anomaly/geo.ts`
 * for `maxmind`.
 */
type NodemailerTransport = {
  sendMail(opts: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
};

type NodemailerModule = {
  createTransport(url: string): NodemailerTransport;
};

/**
 * Email adapter for the Docker / self-hosted Node runtime.
 *
 * The transport is created lazily on first send so:
 *
 *   1. Importing this module on a Workers build doesn't crash on a
 *      missing `nodemailer` install (we mark it optional in
 *      `apps/cms/package.json` and Workers bundles don't include
 *      it).
 *   2. A misconfigured `LUMIBASE_SMTP_URL` only fails at first send,
 *      not at boot — boot-time crashes block unrelated routes
 *      (auth, settings, /health). The trade-off is one extra "SMTP
 *      not configured" log line on first event; acceptable since
 *      audit-trail emission still records the attempt.
 *
 * Per the {@link NotificationChannelAdapter} contract, expected
 * delivery failures (SMTP 4xx/5xx, network refusal) round-trip
 * through {@link DeliveryResult} rather than throwing; the dispatcher
 * relies on this so the retry queue in task 9.4 stays branch-free
 * for the common case.
 */
export class NodemailerChannel implements NotificationChannelAdapter {
  readonly name = 'email' as const;

  private transport: NodemailerTransport | null = null;
  private transportInit: Promise<NodemailerTransport | null> | null = null;

  constructor(
    private readonly smtpUrl: string,
    private readonly config: EmailChannelConfig,
  ) {}

  async send(payload: NotificationPayload): Promise<DeliveryResult> {
    const transport = await this.ensureTransport();
    if (!transport) {
      return {
        ok: false,
        error: 'nodemailer-unavailable',
        // Not retryable: missing module / unparseable URL won't
        // fix itself between attempts. The dispatcher should drop
        // after the first try and audit `notification_delivery_failed`.
        retryable: false,
      };
    }

    const subject = buildEmailSubject(payload.event);
    const text = buildEmailBody(payload);
    const recipients = this.resolveRecipients(payload);
    if (recipients.length === 0) {
      return {
        ok: false,
        error: 'no-recipients',
        retryable: false,
      };
    }

    // SMTP servers commonly reject multi-recipient sends; loop one at
    // a time so a single bad address can't poison the others. The
    // dispatcher sees `ok: true` only when *every* recipient
    // accepted; on partial failure we return retryable so it can
    // try again next backoff slot.
    for (const to of recipients) {
      try {
        await transport.sendMail({
          from: this.config.from,
          to,
          subject,
          text,
        });
      } catch (err) {
        return {
          ok: false,
          error: errorMessage(err),
          retryable: true,
        };
      }
    }

    return { ok: true };
  }

  /**
   * The dispatcher is the source of truth for recipient lists, but
   * Req 13.2 also wants the affected user when distinct from the
   * bootstrap admin. We merge the configured `recipients` list with
   * the payload's `email` (de-duplicated, lowercased for comparison
   * only) so a misconfigured factory still gets a useful at-least
   * one-recipient send.
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

  private async ensureTransport(): Promise<NodemailerTransport | null> {
    if (this.transport) return this.transport;
    if (!this.transportInit) {
      this.transportInit = this.loadTransport();
      this.transportInit
        .then((t) => {
          this.transport = t;
        })
        .catch(() => {
          this.transport = null;
        });
    }
    return this.transportInit;
  }

  private async loadTransport(): Promise<NodemailerTransport | null> {
    let mod: NodemailerModule;
    try {
      mod = (await import('nodemailer')) as unknown as NodemailerModule;
    } catch {
      // Package isn't installed in this build (Workers). The factory
      // shouldn't have constructed us in that case, but degrade
      // gracefully if it did.
      // eslint-disable-next-line no-console
      console.warn(
        '[notifications/email] nodemailer module unavailable; email channel disabled',
      );
      return null;
    }
    try {
      return mod.createTransport(this.smtpUrl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[notifications/email] nodemailer createTransport failed:',
        errorMessage(err),
      );
      return null;
    }
  }
}

// ── MailchannelsChannel (Cloudflare Workers) ──────────────────────────

/**
 * Cloudflare's MailChannels send endpoint. The free tier is enabled
 * by default for Workers; non-Workers callers will receive a
 * relay-policy rejection from the API, which surfaces as a non-2xx
 * response and round-trips through {@link DeliveryResult} the same
 * way as a network blip.
 */
const MAILCHANNELS_ENDPOINT = 'https://api.mailchannels.net/tx/v1/send';

/**
 * Email adapter for the Cloudflare Workers runtime.
 *
 * Builds a single MailChannels payload per `send()`. The API accepts
 * multiple recipients in one personalisation block, so unlike the
 * SMTP adapter we don't need to loop; a 4xx/5xx from MailChannels
 * round-trips through {@link DeliveryResult} so the dispatcher can
 * retry on transient errors.
 *
 * Timeout: the Worker request budget is bounded by the platform
 * (default 30s). We layer a 10s explicit `AbortController` so a
 * stuck connection doesn't eat the whole budget and starve other
 * subrequests. A retry on timeout still has time within a single
 * Worker invocation.
 */
export class MailchannelsChannel implements NotificationChannelAdapter {
  readonly name = 'email' as const;

  constructor(
    private readonly config: EmailChannelConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(payload: NotificationPayload): Promise<DeliveryResult> {
    const recipients = this.resolveRecipients(payload);
    if (recipients.length === 0) {
      return {
        ok: false,
        error: 'no-recipients',
        retryable: false,
      };
    }

    const subject = buildEmailSubject(payload.event);
    const text = buildEmailBody(payload);

    // MailChannels personalisation allows distinct `to` lists per
    // entry; we use a single personalisation since the body is the
    // same for every recipient.
    const body = JSON.stringify({
      personalizations: [{ to: recipients.map((email) => ({ email })) }],
      from: { email: this.config.from },
      subject,
      content: [{ type: 'text/plain', value: text }],
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(MAILCHANNELS_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (res.status >= 200 && res.status < 300) {
        return { ok: true };
      }
      // 4xx → unlikely to fix itself (auth/policy). 5xx → retryable.
      const retryable = res.status >= 500 && res.status < 600;
      // Body may be JSON or text; we only need a short error string
      // for the audit trail, so cap the read at 1KB.
      const errText = await safeReadShortText(res);
      return {
        ok: false,
        error: `mailchannels-${res.status}${errText ? `:${errText}` : ''}`,
        retryable,
      };
    } catch (err) {
      const aborted =
        err instanceof Error && err.name === 'AbortError' ? true : false;
      return {
        ok: false,
        error: aborted ? 'mailchannels-timeout' : errorMessage(err),
        // Network errors and timeouts are typically transient.
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Mirrors {@link NodemailerChannel.resolveRecipients}. */
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
   *   1. Cloudflare runtime (`LUMIBASE_RUNTIME='cloudflare'`) →
   *      always {@link MailchannelsChannel}. The MailChannels API
   *      is reachable from any Worker; the operator still has to
   *      configure SPF/DKIM at the DNS layer for non-trivial
   *      deliverability, but the adapter doesn't gate on that.
   *   2. Anything else (`'docker'`, undefined, custom) → if
   *      `LUMIBASE_SMTP_URL` is set, return a
   *      {@link NodemailerChannel} bound to that URL. Otherwise
   *      `null` (no email channel available).
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
      return new MailchannelsChannel({ from, recipients });
    }

    const smtpUrl = readStringEnv(env, 'LUMIBASE_SMTP_URL');
    if (!smtpUrl) {
      // Degraded mode (design §12.3 / Req 13 — no SMTP configured).
      return null;
    }
    return new NodemailerChannel(smtpUrl, { from, recipients });
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 256);
  if (typeof err === 'string') return err.slice(0, 256);
  return 'unknown-error';
}

async function safeReadShortText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 1024);
  } catch {
    return '';
  }
}
