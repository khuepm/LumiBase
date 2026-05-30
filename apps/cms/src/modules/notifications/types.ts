/**
 * Shared types for the Notification subsystem (admin-setup-wizard
 * Phase E — task 9.1 / Req 13; design §9.1).
 *
 * Phase E wires the {@link LoginGuard} hooks (task 6.2, 8.1) into a
 * channel-agnostic dispatcher: when the guard records a
 * `user_locked`, `ip_blocked`, `anomaly_triggered`, or `anomaly_lock`
 * event (Req 13.1), it asks the dispatcher to fan the same
 * {@link NotificationPayload} out to every {@link NotificationChannel}
 * configured on `Lockout_Policy.notifyChannels` (Req 13.2, 13.3).
 *
 * Each concrete channel — email (task 9.2) and webhook (task 9.3) —
 * implements {@link NotificationChannelAdapter} so the dispatcher
 * (task 9.4) can call them uniformly, retry on failure, and feed
 * delivery outcomes back into the audit trail (Req 13.4).
 *
 * This module is intentionally **type-only**: it owns no runtime
 * behaviour. Channel implementations live in sibling files
 * (`email-channel.ts`, `webhook-channel.ts`); the dispatcher and its
 * retry queue live in `dispatcher.ts`.
 *
 * Validates: shared types only — see Req 13.1, 13.3 and design §9.1.
 */

// ── Channel name (Req 13; mirrors `policy-codec.ts`) ────────────────────

/**
 * Identifier of a delivery channel. Mirrors the `notifyChannels` enum
 * stored on `Lockout_Policy` (Req 6.3) so the dispatcher can match a
 * configured channel name to its adapter without translating between
 * vocabularies.
 *
 * The {@link import('../setup/policy-codec').NotificationChannel} alias
 * is re-derived from the same `'email' | 'webhook'` literal union; the
 * codec is the single source of truth for what channels the policy
 * codec accepts, and this file pins the runtime view used by the
 * dispatcher and adapters. If a new channel ever lands (e.g. `'slack'`)
 * both call sites must be updated together.
 */
export type NotificationChannel = 'email' | 'webhook';

// ── Security events that trigger notifications (Req 13.1) ──────────────

/**
 * The four security events that the LoginGuard publishes to the
 * notification dispatcher (Req 13.1). Each value mirrors the
 * corresponding `audit_log.event` string (Req 15.1) so a downstream
 * correlator can join a notification record back onto its audit row
 * by event code without translating vocabularies.
 *
 *   - `'user_locked'` — `users.lockedUntil` was just set because the
 *     per-user failed-attempt counter crossed `userMaxFailedAttempts`
 *     (Req 7.2 / design §6.3).
 *   - `'ip_blocked'` — the per-IP sliding-window counter crossed
 *     `ipMaxFailedAttempts` (Req 8.2 / design §6.3).
 *   - `'anomaly_triggered'` — a successful login crossed
 *     `anomalyScoreThreshold` while `anomalyAction='notify_only'`
 *     (Req 12.2). The login was *allowed*; the notification is the
 *     only out-of-band signal that something looked off.
 *   - `'anomaly_lock'` — a successful login crossed the threshold
 *     while `anomalyAction='lock'`, so the user was locked and the
 *     attempt was rejected with HTTP 423 (Req 12.3).
 *
 * `'mfa_required'` is **not** in this set: per Req 12.4, the
 * `'require_mfa'` action is a placeholder until an MFA module ships,
 * and Req 13.1 enumerates exactly the four codes above.
 *
 * Modelled as a string-literal union (rather than a TypeScript
 * `enum`) so the values are JSON-serialisable as-is and a downstream
 * webhook receiver can pattern-match on the literal without an
 * intermediate enum lookup.
 */
export type SecurityEvent =
  | 'user_locked'
  | 'ip_blocked'
  | 'anomaly_triggered'
  | 'anomaly_lock';

/**
 * The action the LoginGuard took as a result of the event. Carried
 * on {@link NotificationPayload.action} so a webhook receiver
 * (Req 13.3) can decide how to react without re-deriving it from
 * `event` — e.g. an `'allowed'` payload from `'anomaly_triggered'`
 * is informational, while `'locked'` from the same event would be
 * something the dispatcher should never produce.
 *
 *   - `'allowed'` — the request succeeded; pairs with
 *     `event='anomaly_triggered'` (Req 12.2).
 *   - `'locked'` — the user was locked (`users.lockedUntil` bumped);
 *     pairs with `event='user_locked'` or `'anomaly_lock'`
 *     (Req 7.2, 12.3).
 *   - `'blocked'` — the IP was blocked; pairs with
 *     `event='ip_blocked'` (Req 8.2).
 */
export type NotificationAction = 'allowed' | 'locked' | 'blocked';

// ── Payload (Req 13.3) ─────────────────────────────────────────────────

/**
 * The payload the dispatcher hands to every channel adapter. Mirrors
 * the JSON body shape Req 13.3 mandates for the webhook channel so
 * the dispatcher can build the payload exactly *once* per event and
 * pass the same object to every adapter (no per-channel rebuilds,
 * no field name drift between email body templating and webhook
 * JSON).
 *
 * All fields are `readonly` — the payload is data-class-shaped, and
 * adapters must not mutate it (the dispatcher reuses the same
 * reference across retries).
 *
 *   - `event` — see {@link SecurityEvent}.
 *   - `timestamp` — ISO-8601 UTC string of when the event was
 *     recorded by the LoginGuard. Format pinned at the dispatcher so
 *     adapters never have to format `Date` themselves; matches the
 *     "ISO 8601 UTC" wording in Req 13.2.
 *   - `email` — the email address of the user the event concerns.
 *     Stored verbatim (the LoginGuard normalises to lowercase before
 *     dispatch). For `'ip_blocked'` events that aren't tied to a
 *     specific user, the dispatcher writes the *triggering* attempt's
 *     email here so the receiver retains some signal.
 *   - `ip` — the client IP per
 *     {@link import('../login-guard/ip-extract').extractClientIp}.
 *   - `country` — ISO-3166 alpha-2 code from the geo subscore, or
 *     `null` when GeoIP was unavailable (Req 9.5). Modelled as
 *     nullable rather than `string | undefined` to match the JSON
 *     shape Req 13.3 implies (an explicit `null` field is friendlier
 *     to webhook receivers than a missing key).
 *   - `userAgent` — raw User-Agent header from the triggering
 *     request, capped at 1024 chars by the device subscore, or
 *     `null` when the header was missing.
 *   - `anomalyScore` — the aggregator's final score formatted to two
 *     decimal places (Req 12.1). The wire format is a number (not a
 *     string) so a webhook receiver can numerically threshold on it;
 *     the precision is bounded at the dispatcher via
 *     `Math.round(score * 100) / 100`. For `'user_locked'` and
 *     `'ip_blocked'` events that aren't anomaly-driven the value is
 *     `null`.
 *   - `action` — see {@link NotificationAction}.
 */
export interface NotificationPayload {
  readonly event: SecurityEvent;
  readonly timestamp: string;
  readonly email: string;
  readonly ip: string;
  readonly country: string | null;
  readonly userAgent: string | null;
  readonly anomalyScore: number | null;
  readonly action: NotificationAction;
}

// ── Channel adapter (design §9.1) ──────────────────────────────────────

/**
 * Outcome of a single delivery attempt. Modelled as a discriminated
 * shape rather than `boolean` so the dispatcher can:
 *
 *   1. Distinguish a 5xx-style "retry me" failure from a 4xx-style
 *      "stop trying" failure — adapters can populate `retryable` to
 *      hint the queue (task 9.4) whether the next backoff slot
 *      should bother. The default-on `retryable=true` keeps the
 *      contract conservative: an adapter that doesn't know just
 *      lets the queue retry up to the cap.
 *   2. Surface a structured `error` string for the audit trail
 *      (`event='notification_delivery_failed'`, Req 13.4) without
 *      forcing adapters to throw — exceptions and lifecycle errors
 *      remain genuine bugs, while expected delivery failures (SMTP
 *      4xx, webhook 5xx, timeout) round-trip through the result.
 *
 * `ok=true` implies `error` is absent. `ok=false` implies a
 * non-empty `error` and an explicit `retryable` decision.
 */
export type DeliveryResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: string;
      readonly retryable: boolean;
    };

/**
 * Adapter interface every concrete channel implementation must
 * satisfy. The dispatcher (task 9.4) holds a `Map<NotificationChannel,
 * NotificationChannelAdapter>` and dispatches in parallel by
 * iterating `Lockout_Policy.notifyChannels` (Req 13.1).
 *
 * The interface is deliberately tiny:
 *
 *   - `name` is read-only and pins the channel kind so the dispatcher
 *     can sanity-check that the registered adapter for `'email'` is
 *     actually an email adapter.
 *   - `send` returns a {@link DeliveryResult} rather than throwing on
 *     expected failures; the dispatcher relies on this contract to
 *     keep the retry/backoff path branch-free for the common case.
 *
 * Adapters MUST NOT mutate `payload`; the dispatcher passes the same
 * reference across retries.
 *
 * Adapters MAY enforce their own per-call timeout (the webhook
 * adapter caps at 10s per design §9.3); the dispatcher otherwise
 * treats the returned promise as authoritative.
 */
export interface NotificationChannelAdapter {
  readonly name: NotificationChannel;
  send(payload: NotificationPayload): Promise<DeliveryResult>;
}
