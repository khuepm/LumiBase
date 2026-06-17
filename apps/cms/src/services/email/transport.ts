/**
 * Generic email transport layer.
 *
 * This is the single byte-pushing implementation for the whole CMS. It
 * generalises the two transports that previously lived (security-only) in
 * `apps/cms/src/modules/notifications/email-channel.ts`:
 *
 *   - {@link NodemailerTransport} — self-hosted Node / Docker build. Drives
 *     `nodemailer` against an SMTP URL (`LUMIBASE_SMTP_URL`). Imported lazily
 *     so the Workers bundle never drags node-only types into the build graph.
 *   - {@link MailchannelsTransport} — Cloudflare Workers build. Posts to the
 *     MailChannels HTTP API, the transactional path Cloudflare exposes for
 *     Workers (which has no TCP socket primitive `nodemailer` can drive).
 *
 * Both accept a provider-agnostic {@link EmailMessage} (arbitrary subject,
 * recipients, and HTML/text bodies) and return a {@link DeliveryResult} from
 * the notifications module — expected delivery failures (SMTP 4xx/5xx, network
 * refusal, timeout) round-trip through the result rather than throwing, so the
 * callers stay branch-free for the common case.
 *
 * The security notification channel now composes these transports rather than
 * owning its own copy; its spec-pinned subject/body templates (Req 13.2) stay
 * in `modules/notifications/email-channel.ts`.
 */

import type { DeliveryResult } from '../../modules/notifications/types';

// ── Message contract ───────────────────────────────────────────────────

/**
 * A single outbound email. `html` and `text` are both optional but at least
 * one must be present; the transports fall back to whichever is supplied.
 * Recipients are pre-resolved by the caller (the email module renders +
 * de-duplicates before handing the message over).
 */
export interface EmailMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly replyTo?: string;
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
}

/**
 * Transport abstraction. Mirrors the `NotificationChannelAdapter.send`
 * contract so the security channel can wrap a transport directly.
 */
export interface EmailTransport {
  readonly kind: 'smtp' | 'mailchannels';
  send(message: EmailMessage): Promise<DeliveryResult>;
}

// ── Nodemailer (self-hosted Node / Docker) ─────────────────────────────

type NodemailerTransportHandle = {
  sendMail(opts: {
    from: string;
    to: string;
    cc?: string;
    replyTo?: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<unknown>;
};

type NodemailerModule = {
  createTransport(url: string): NodemailerTransportHandle;
};

/**
 * SMTP transport for the Docker / self-hosted Node runtime.
 *
 * The underlying `nodemailer` transport is created lazily on first send so
 * (1) importing this module on a Workers build doesn't crash on a missing
 * `nodemailer` install, and (2) a misconfigured `LUMIBASE_SMTP_URL` fails at
 * first send rather than at boot. Mirrors the seam in the original
 * `NodemailerChannel`.
 */
export class NodemailerTransport implements EmailTransport {
  readonly kind = 'smtp' as const;

  private handle: NodemailerTransportHandle | null = null;
  private handleInit: Promise<NodemailerTransportHandle | null> | null = null;

  constructor(private readonly smtpUrl: string) {}

  async send(message: EmailMessage): Promise<DeliveryResult> {
    const handle = await this.ensureHandle();
    if (!handle) {
      return { ok: false, error: 'nodemailer-unavailable', retryable: false };
    }

    const recipients = dedupeAddresses(message.to);
    if (recipients.length === 0) {
      return { ok: false, error: 'no-recipients', retryable: false };
    }
    const cc = message.cc ? dedupeAddresses(message.cc) : [];

    // SMTP servers commonly reject multi-recipient sends; loop one `to` at a
    // time so a single bad address can't poison the others. `ok: true` only
    // when *every* recipient accepted.
    for (const to of recipients) {
      try {
        await handle.sendMail({
          from: message.from,
          to,
          cc: cc.length > 0 ? cc.join(', ') : undefined,
          replyTo: message.replyTo,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (err) {
        return { ok: false, error: errorMessage(err), retryable: true };
      }
    }
    return { ok: true };
  }

  private async ensureHandle(): Promise<NodemailerTransportHandle | null> {
    if (this.handle) return this.handle;
    if (!this.handleInit) {
      this.handleInit = this.loadHandle();
      this.handleInit
        .then((h) => {
          this.handle = h;
        })
        .catch(() => {
          this.handle = null;
        });
    }
    return this.handleInit;
  }

  private async loadHandle(): Promise<NodemailerTransportHandle | null> {
    let mod: NodemailerModule;
    try {
      mod = (await import('nodemailer')) as unknown as NodemailerModule;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[email/transport] nodemailer module unavailable; SMTP disabled');
      return null;
    }
    try {
      return mod.createTransport(this.smtpUrl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[email/transport] nodemailer createTransport failed:', errorMessage(err));
      return null;
    }
  }
}

// ── MailChannels (Cloudflare Workers) ──────────────────────────────────

const MAILCHANNELS_ENDPOINT = 'https://api.mailchannels.net/tx/v1/send';

/**
 * Email transport for the Cloudflare Workers runtime. Builds one MailChannels
 * payload per send; the API accepts multiple recipients per personalisation,
 * so unlike SMTP we don't loop. A 4xx is treated as non-retryable (auth/policy)
 * and 5xx / network / timeout as retryable. A 10s `AbortController` keeps a
 * stuck connection from eating the whole Worker request budget.
 */
export class MailchannelsTransport implements EmailTransport {
  readonly kind = 'mailchannels' as const;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(message: EmailMessage): Promise<DeliveryResult> {
    const recipients = dedupeAddresses(message.to);
    if (recipients.length === 0) {
      return { ok: false, error: 'no-recipients', retryable: false };
    }
    const cc = message.cc ? dedupeAddresses(message.cc) : [];

    const content: Array<{ type: string; value: string }> = [];
    // MailChannels requires text/plain to precede text/html when both present.
    if (message.text) content.push({ type: 'text/plain', value: message.text });
    if (message.html) content.push({ type: 'text/html', value: message.html });
    if (content.length === 0) {
      return { ok: false, error: 'empty-body', retryable: false };
    }

    const personalization: Record<string, unknown> = {
      to: recipients.map((email) => ({ email })),
    };
    if (cc.length > 0) personalization.cc = cc.map((email) => ({ email }));

    const body = JSON.stringify({
      personalizations: [personalization],
      from: { email: message.from },
      ...(message.replyTo ? { reply_to: { email: message.replyTo } } : {}),
      subject: message.subject,
      content,
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
      const retryable = res.status >= 500 && res.status < 600;
      const errText = await safeReadShortText(res);
      return {
        ok: false,
        error: `mailchannels-${res.status}${errText ? `:${errText}` : ''}`,
        retryable,
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        error: aborted ? 'mailchannels-timeout' : errorMessage(err),
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Trim, drop blanks, de-duplicate (case-insensitive) while preserving the
 * caller's original casing for the `To:` header.
 */
export function dedupeAddresses(addrs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const addr of addrs) {
    const trimmed = addr.trim();
    if (trimmed.length === 0) continue;
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
