/**
 * Webhook channel adapter (admin-setup-wizard task 9.3 / Req 13.3;
 * design §9.3, §7.4).
 *
 * Posts the security-event payload as JSON to an operator-supplied
 * `webhookUrl`, signed with HMAC-SHA256 so the receiver can prove the
 * request came from this LumiBase instance and was not tampered with
 * or replayed.
 *
 * Wire format pinned by design §7.4:
 *
 *   ```
 *   X-LumiBase-Signature: sha256=<hex>
 *   X-LumiBase-Timestamp: <unix-seconds>
 *   Content-Type:         application/json
 *   body =                canonical JSON
 *   hex  =                HMAC_SHA256(secret, `${timestamp}.${body}`)
 *   ```
 *
 * The timestamp is included in the signed bytes (not just an
 * unsigned header) so a downstream replay-protection rule —
 * "reject if `|now - timestamp| > 5 min`" per design §7.4 — can be
 * enforced safely: an attacker cannot move the `X-LumiBase-Timestamp`
 * header forward without invalidating the signature.
 *
 * **Canonical body**: the payload object is serialised with a fixed
 * key order matching {@link NotificationPayload} (the same eight
 * fields Req 13.3 enumerates) so the bytes the receiver sees are
 * exactly the bytes we hashed. We don't reuse `JSON.stringify(payload)`
 * directly because `JSON.stringify` order tracks insertion order on
 * V8 / Node and that's not a contract the platform guarantees long
 * term — a fixed projection is cheap insurance.
 *
 * **HMAC implementation**: Web Crypto API (`crypto.subtle.importKey`
 * + `sign`) is the project-wide HMAC primitive (see
 * `apps/cms/src/services/auth/password.ts`, `setup-token.ts`,
 * `anomaly/device.ts` for the same `crypto.subtle` + Uint8Array
 * pattern). It works on Node ≥ 18, Cloudflare Workers, and modern
 * browsers — no polyfill needed, no dependency on `node:crypto`
 * (which Workers doesn't ship).
 *
 * **Failure semantics** (per {@link NotificationChannelAdapter}):
 *
 *   - HTTP 2xx → `{ ok: true }`.
 *   - HTTP 4xx → `{ ok: false, retryable: false, error }` — the
 *     receiver explicitly rejected; retrying won't help. Common in
 *     practice when a webhook secret rotates and the receiver's
 *     verification fails.
 *   - HTTP 5xx → `{ ok: false, retryable: true, error }` — receiver
 *     hiccup; the dispatcher (task 9.4) will retry within its
 *     1s/2s/4s backoff cap.
 *   - Network error / timeout → `{ ok: false, retryable: true, error }`
 *     — same treatment as 5xx; transient by definition.
 *
 * **Timeout**: 10s default via {@link AbortController} per design §9.3.
 * Bound rather than infinite so a misconfigured receiver (e.g. one
 * that opens a TCP connection but never returns headers) cannot
 * starve the dispatcher's retry tick or, on Workers, eat the whole
 * request budget.
 *
 * Validates: Requirements 13.3 — see also design §9.3, §7.4.
 */

import type {
  DeliveryResult,
  NotificationChannelAdapter,
  NotificationPayload,
} from './types';

// ── Constants pinned by design §7.4 ─────────────────────────────────────

/**
 * Header name carrying the HMAC. Format `sha256=<hex>` mirrors the
 * GitHub / Stripe convention so receivers built against either can
 * verify with minimal adapter code, and so a future migration to a
 * different MAC (e.g. `sha512=`) is forward-compatible — receivers
 * just match on the prefix.
 */
export const SIGNATURE_HEADER = 'X-LumiBase-Signature' as const;

/**
 * Header name carrying the unix-seconds timestamp the signature was
 * computed over. Receivers re-derive the signed bytes by reading the
 * header value and the body, then comparing against
 * {@link SIGNATURE_HEADER} — and reject if the skew exceeds the
 * design §7.4 cap (5 minutes).
 */
export const TIMESTAMP_HEADER = 'X-LumiBase-Timestamp' as const;

/**
 * Default per-call timeout (design §9.3). Operators can override on
 * the adapter via `opts.timeoutMs` for unusually slow downstreams,
 * but the default is bounded to keep the dispatcher responsive.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fixed projection used to serialise the payload for signing /
 * sending. The keys mirror {@link NotificationPayload} verbatim and
 * pin the wire shape Req 13.3 mandates:
 *
 *   `{ event, timestamp, email, ip, country, userAgent, anomalyScore, action }`
 *
 * `notification.payload` member, however, is in declaration order —
 * we don't sort alphabetically because Req 13.3 documents the field
 * list in this exact order, and a receiver doing field-by-field
 * unmarshalling is friendlier when the on-wire order matches the
 * documented one.
 *
 * The projection is the *only* path payload data takes to the wire.
 * If a future payload extension adds a field, it must be added here
 * **and** in {@link NotificationPayload}; otherwise the new field is
 * silently dropped from the signed body, which is the safe-by-default
 * direction (no unsigned bytes ever reach the receiver).
 */
const PAYLOAD_KEYS = [
  'event',
  'timestamp',
  'email',
  'ip',
  'country',
  'userAgent',
  'anomalyScore',
  'action',
] as const satisfies readonly (keyof NotificationPayload)[];

// ── Canonical body builder ──────────────────────────────────────────────

/**
 * Build the canonical JSON body for a payload. The output is the
 * exact byte sequence that gets:
 *
 *   1. Concatenated with `${timestamp}.` and signed.
 *   2. Sent as the HTTP request body.
 *
 * Doing both from the same string (rather than re-stringifying) is
 * essential — even a single-byte mismatch (e.g. trailing newline,
 * different unicode escape) between "what we signed" and "what we
 * sent" would cause every downstream signature verification to fail.
 *
 * Exported for the unit tests so they can verify the wire bytes
 * without re-implementing the serialiser.
 */
export function buildCanonicalBody(payload: NotificationPayload): string {
  // Project into a fresh object with the documented key order. We
  // don't pass `payload` directly to `JSON.stringify` because object
  // key ordering on the wire is not contractually fixed by ECMAScript
  // when objects are constructed via destructuring or spread — going
  // through an explicit projection makes the order part of *this*
  // module's contract.
  const ordered: Record<string, unknown> = {};
  for (const key of PAYLOAD_KEYS) {
    ordered[key] = payload[key];
  }
  return JSON.stringify(ordered);
}

// ── HMAC ────────────────────────────────────────────────────────────────

const textEncoder = new TextEncoder();

/**
 * Compute `HMAC_SHA256(secret, signedBytes)` and return the lowercase
 * hex digest. Mirrors the
 * `apps/cms/src/services/auth/password.ts` / `setup-token.ts` use of
 * `crypto.subtle` so the HMAC primitive stays uniform across the
 * codebase (one place to audit, one place to swap algorithms).
 *
 * Exported for the unit tests so they can independently rebuild the
 * signature and assert byte equality with the header value.
 */
export async function hmacSha256Hex(
  secret: string,
  signedBytes: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(signedBytes),
  );
  return toHex(new Uint8Array(signature));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

// ── Adapter ─────────────────────────────────────────────────────────────

/**
 * Optional knobs the dispatcher / tests can pass through. `fetchFn`
 * lets unit tests inject a `vi.fn()` without monkey-patching the
 * global; `timeoutMs` lets operators tighten the per-call budget on
 * unusually fast / slow downstreams.
 */
export interface WebhookChannelOptions {
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Webhook delivery adapter (Req 13.3 / design §9.3).
 *
 * One adapter instance corresponds to one `(webhookUrl, secret)`
 * pair — the dispatcher (task 9.4) constructs it from
 * `Lockout_Policy.webhookUrl` + `webhookSecret` whenever the policy
 * changes, and replaces the registered channel atomically. The
 * adapter holds no per-event state; the only transient state is the
 * AbortController for the in-flight request, which lives strictly
 * inside `send()`.
 *
 * Concurrency: `send()` is safe to invoke concurrently for distinct
 * payloads — the only shared state is the `fetchFn` reference and
 * the constructor args, both immutable after construction.
 */
export class WebhookChannel implements NotificationChannelAdapter {
  readonly name = 'webhook' as const;

  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly webhookUrl: string,
    private readonly secret: string,
    opts: WebhookChannelOptions = {},
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(payload: NotificationPayload): Promise<DeliveryResult> {
    // Compute the body and timestamp **once**, then sign over the
    // exact bytes we'll transmit. Doing this in a single block (no
    // `await` between `buildCanonicalBody` and the `fetch` call's
    // body argument) means there's no chance of a race where the
    // signed bytes drift from the sent bytes.
    const body = buildCanonicalBody(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signedBytes = `${timestamp}.${body}`;

    let signatureHex: string;
    try {
      signatureHex = await hmacSha256Hex(this.secret, signedBytes);
    } catch (err) {
      // `crypto.subtle.importKey` can reject on the empty-string
      // secret edge case in some runtimes; the factory below already
      // gates on `webhookSecret.length > 0`, but we belt-and-brace
      // here so a misuse from a future caller doesn't surface as an
      // uncaught rejection — it round-trips through DeliveryResult
      // like every other expected failure mode.
      return {
        ok: false,
        error: `hmac-failed:${errorMessage(err)}`,
        retryable: false,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchFn(this.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: `sha256=${signatureHex}`,
          [TIMESTAMP_HEADER]: String(timestamp),
        },
        body,
        signal: controller.signal,
      });

      if (res.status >= 200 && res.status < 300) {
        return { ok: true };
      }

      // 4xx → receiver rejected (bad signature, schema mismatch, auth
      // policy). Retrying with the same payload won't change the
      // outcome, so flag non-retryable; the dispatcher will drop and
      // audit `notification_delivery_failed` per Req 13.4.
      //
      // 5xx → receiver hiccup; transient by convention. Retryable so
      // the dispatcher's exponential backoff (1s / 2s / 4s, max 3
      // attempts per design §9.4) gets a chance.
      const retryable = res.status >= 500 && res.status < 600;
      const errBody = await safeReadShortText(res);
      return {
        ok: false,
        error: `webhook-${res.status}${errBody ? `:${errBody}` : ''}`,
        retryable,
      };
    } catch (err) {
      // `AbortError` from the timeout, plus anything `fetch` throws
      // (DNS failure, TLS handshake failure, connection reset). All
      // of these are transient under typical operator deployments,
      // so we mark retryable by default. The dispatcher's per-task
      // attempt cap (3) keeps a permanently-broken endpoint from
      // looping forever.
      const aborted =
        err instanceof Error && err.name === 'AbortError' ? true : false;
      return {
        ok: false,
        error: aborted ? 'webhook-timeout' : errorMessage(err),
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Subset of the policy fields the factory needs. Typed as a thin
 * structural shape rather than importing
 * `LockoutPolicy` from the setup module to keep the dependency
 * direction one-way (`setup` already depends on
 * `notifications/types.ts` for `NotificationChannel`; importing back
 * would form a cycle once task 9.5 wires LoginGuard → dispatcher →
 * channel-factory together).
 *
 * The fields match `LockoutPolicy` exactly so a `LockoutPolicy`
 * value is structurally assignable to this type — callers can pass
 * the policy object directly without an explicit cast.
 */
export interface WebhookPolicySlice {
  readonly webhookUrl?: string | undefined;
  readonly webhookSecret?: string | undefined;
}

export const WebhookChannelFactory = {
  /**
   * Build a {@link WebhookChannel} from a {@link LockoutPolicy} (or
   * any object satisfying {@link WebhookPolicySlice}).
   *
   * Returns `null` when either of the two required fields is missing
   * or empty — the dispatcher (task 9.4) treats this the same as a
   * disabled channel and skips dispatch silently per design §12.3
   * ("Webhook URL chưa set trong policy → webhook channel skip
   * silent"). The audit trail still records the underlying security
   * event; only the webhook delivery is suppressed.
   *
   * Both checks are explicit (no falsy coercion) so a future schema
   * change that allows e.g. `null` never silently passes through.
   */
  fromPolicy(
    policy: WebhookPolicySlice,
    opts: WebhookChannelOptions = {},
  ): WebhookChannel | null {
    const url = typeof policy.webhookUrl === 'string' ? policy.webhookUrl : '';
    const secret =
      typeof policy.webhookSecret === 'string' ? policy.webhookSecret : '';
    if (url.length === 0 || secret.length === 0) {
      return null;
    }
    return new WebhookChannel(url, secret, opts);
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────

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
