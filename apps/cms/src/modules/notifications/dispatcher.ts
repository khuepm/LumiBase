/**
 * Notification dispatcher — in-process retry queue + per-(event,email)
 * rate-limiter (admin-setup-wizard task 9.4 / Req 13.4, 13.5;
 * design §9.4, §9.5).
 *
 * The LoginGuard hooks (task 6.2 / 8.1) publish a security event —
 * one of {@link SecurityEvent} — and ask the dispatcher to fan the
 * matching {@link NotificationPayload} out to every channel the
 * operator enabled on `Lockout_Policy.notifyChannels` (Req 13.1).
 * Delivery must be **best-effort and non-blocking**: a failed email
 * or webhook must never hold up (or fail) the login request, even
 * for the serious `user_locked` / `anomaly_lock` events (Req 13.4).
 *
 * That decoupling is exactly what an in-process queue buys us. Rather
 * than `await channel.send()` on the request path, `dispatch()`
 * enqueues one {@link DispatchTask} per channel and returns
 * immediately; a worker tick drains the queue out-of-band.
 *
 * ── Retry / backoff (Req 13.4 / design §9.4) ───────────────────────────
 *
 * Each task carries an `attempts` counter (starts at 0) and a
 * `nextAttemptAt` timestamp (starts at "now", so the first tick that
 * sees it sends immediately). On every tick, tasks whose
 * `nextAttemptAt` is still in the future are skipped; the rest are
 * sent via {@link NotificationChannelAdapter.send}.
 *
 * The adapter returns a {@link DeliveryResult} rather than throwing
 * (see `types.ts`), so the tick branches without a try/catch in the
 * common case:
 *
 *   - `{ ok: true }` → the task is removed from the queue. Done.
 *   - `{ ok: false, retryable: false }` → a permanent failure (SMTP
 *     auth rejection, webhook 4xx, missing transport). Retrying
 *     won't help, so the task is dropped **immediately** and a
 *     `notification_delivery_failed` audit entry is written
 *     (Req 13.4). No backoff slots are consumed.
 *   - `{ ok: false, retryable: true }` → a transient failure
 *     (webhook 5xx, network blip, timeout). The backoff for the
 *     *next* attempt is `1000 * 2 ** attempts` milliseconds — i.e.
 *     **1s / 2s / 4s** as `attempts` walks 0 → 1 → 2 — and `attempts`
 *     is then incremented. Once `attempts` reaches {@link MAX_ATTEMPTS}
 *     (3) the task is dropped and `notification_delivery_failed` is
 *     audited (Req 13.4). So a permanently-flaky endpoint is tried at
 *     most three times: at t, t+1s, t+3s (1s then 2s of cumulative
 *     wait), then given up on.
 *
 * The backoff is computed from the *pre-increment* `attempts` value
 * on purpose: that's what makes the delay sequence start at
 * `2**0 = 1s` (design §9.4 annotates the schedule as "1s/2s/4s",
 * i.e. `2**0 / 2**1 / 2**2`). Because the attempt cap is 3, the 4s
 * slot (`2**2`, reached when `attempts` would step 2 → 3) coincides
 * with the drop, so only the 1s and 2s waits are ever actually
 * observed; the 4s value is the formula's next term, surfaced here
 * for symmetry with the design's annotation and so raising
 * {@link MAX_ATTEMPTS} needs no formula change.
 *
 * ── Rate-limiting (Req 13.5 / design §9.5) ─────────────────────────────
 *
 * To stop an attacker who keeps tripping the same lock from spamming
 * the admin's inbox, the dispatcher rate-limits notifications keyed
 * on `(event, emailLower)` to at most one per 60s. The state is an
 * in-memory `Map<string, number>` keyed `${event}:${emailLower}`
 * whose value is the wall-clock of the **last accepted** dispatch.
 *
 * Eviction is **lazy** (design §9.5): there's no sweeper. On each
 * `dispatch()` we look up the key; if a timestamp exists and is
 * within the 60s TTL the notification is dropped and a
 * `notification_rate_limited` audit entry is written — explicitly,
 * **not** a silent drop (Req 13.5 is emphatic about this: the
 * suppression must be observable in the audit trail). If the stored
 * timestamp is older than the TTL it's deleted (the "check on insert"
 * eviction) and the new dispatch proceeds. The window therefore
 * slides from the last *accepted* dispatch, which is what "1 per 60s"
 * means operationally.
 *
 * Note the rate-limit is per `(event, email)` — **not** per channel.
 * A single suppressed dispatch suppresses *all* channels for that
 * event+email and writes exactly one audit entry, matching the design
 * key shape.
 *
 * ── Runtime model ──────────────────────────────────────────────────────
 *
 * {@link start} / {@link stop} drive the 250ms worker tick via
 * `setInterval` for the self-hosted Node runtime, which can host a
 * long-running background loop. On Cloudflare Workers there is no
 * long-running process, so task 9.6 wires `ctx.waitUntil(...)` per
 * event instead — that path drives the queue through the public
 * {@link InProcessNotificationDispatcher.processTick} method without
 * ever calling {@link start}. Keeping `processTick(now)` public and
 * accepting an explicit `now` also makes the backoff schedule
 * deterministically testable without real timers.
 *
 * ── Secret hygiene ─────────────────────────────────────────────────────
 *
 * The audit entries this module emits carry only the event code, the
 * security event, the channel name, the affected email, and the
 * adapter's short error string (e.g. `webhook-503`,
 * `mailchannels-timeout`). They never carry tokens, password hashes,
 * or raw secrets — the {@link NotificationPayload} contract doesn't
 * expose any, and the adapter `error` strings are bounded, structured
 * codes. This mirrors the masking discipline of design §10.1.
 *
 * Validates: Requirements 13.4, 13.5 — see also design §9.4, §9.5.
 */

import type {
  DeliveryResult,
  NotificationChannel,
  NotificationChannelAdapter,
  NotificationPayload,
  SecurityEvent,
} from './types';

// ── Tunables (design §9.4, §9.5) ───────────────────────────────────────

/**
 * Worker tick cadence in milliseconds (design §9.4). The queue is
 * polled every 250ms; a task whose `nextAttemptAt` falls between two
 * ticks waits at most one extra tick (≤250ms) beyond its scheduled
 * time, which is well within tolerance for a best-effort security
 * notification.
 */
export const TICK_INTERVAL_MS = 250;

/**
 * Maximum number of `send()` attempts per task before it's dropped
 * and audited as `notification_delivery_failed` (design §9.4 — "drop
 * after 3 attempts"). Counts the initial send plus retries: a task
 * is sent at most three times total.
 */
export const MAX_ATTEMPTS = 3;

/**
 * Rate-limit window in milliseconds (Req 13.5 — "1 notification mỗi
 * 60 giây"). A second dispatch for the same `(event, email)` within
 * this window is dropped and audited `notification_rate_limited`.
 */
export const RATE_LIMIT_TTL_MS = 60_000;

// ── Audit contract ─────────────────────────────────────────────────────

/**
 * The two audit event codes this module emits. Both mirror the
 * `audit_log.event` vocabulary the real {@link AuditLogger}
 * (task 11.x) will persist, so swapping the default console writer
 * for the DB-backed logger is a drop-in.
 *
 *   - `'notification_delivery_failed'` — a task exhausted its retry
 *     budget, or hit a non-retryable failure (Req 13.4).
 *   - `'notification_rate_limited'` — a dispatch was suppressed by
 *     the per-`(event, email)` 60s window (Req 13.5). Explicit, not
 *     a silent drop.
 */
export type NotificationAuditEvent =
  | 'notification_delivery_failed'
  | 'notification_rate_limited';

/**
 * A single audit record emitted by the dispatcher. Intentionally
 * narrow — the fields are exactly what Req 13.4 / 13.5 forensics need
 * and nothing that could leak a secret:
 *
 *   - `event` — the audit code (see {@link NotificationAuditEvent}).
 *   - `securityEvent` — the originating {@link SecurityEvent} so the
 *     record joins back onto the login attempt / lockout that
 *     triggered the notification.
 *   - `email` — the affected user's email, already lowercased (the
 *     same form used for the rate-limit key).
 *   - `channel` — which channel failed. Present for
 *     `notification_delivery_failed`; absent for
 *     `notification_rate_limited` (the suppression covers all
 *     channels at once, so no single channel is implicated).
 *   - `error` — the adapter's short error string (e.g.
 *     `webhook-503`). Present only for delivery failures.
 */
export interface NotificationAuditEntry {
  readonly event: NotificationAuditEvent;
  readonly securityEvent: SecurityEvent;
  readonly email: string;
  readonly channel?: NotificationChannel;
  readonly error?: string;
}

/**
 * Injectable audit sink. Mirrors the dependency-injection pattern the
 * LoginGuard hooks (`login-guard/hooks.ts`) and admin-security routes
 * (`routes/admin-security.ts`) already use while the real
 * {@link AuditLogger} (task 11.x) is built: callers pass a writer so
 * the dispatcher stays unit-testable, and production wiring (task 9.5)
 * supplies one backed by the DB logger. May be sync or async; the
 * dispatcher awaits it but never lets a writer error break the tick.
 */
export type NotificationAuditWriter = (
  entry: NotificationAuditEntry,
) => void | Promise<void>;

/**
 * Default audit sink used when no writer is injected. Mirrors the
 * design §10.1 fallback shape (`console.warn` / `console.info` with a
 * structured object) and the placeholder pattern already used in
 * `login-guard/hooks.ts` and `routes/admin-security.ts`, so operators
 * tailing logs see the event until the DB-backed logger lands.
 *
 * Delivery failures go to `console.warn` (operator-actionable —
 * something couldn't be delivered); rate-limit suppressions go to
 * `console.info` (expected under attack, informational).
 *
 * The record carries only non-secret fields; `channel` / `error`
 * collapse to `null` when absent so the log shape is stable.
 */
export function defaultNotificationAuditWriter(
  entry: NotificationAuditEntry,
): void {
  const record = {
    event: entry.event,
    securityEvent: entry.securityEvent,
    email: entry.email,
    channel: entry.channel ?? null,
    error: entry.error ?? null,
  };
  if (entry.event === 'notification_delivery_failed') {
    // eslint-disable-next-line no-console
    console.warn('[notifications]', record);
  } else {
    // eslint-disable-next-line no-console
    console.info('[notifications]', record);
  }
}

// ── Dispatcher interface (design §6.3 / §9) ────────────────────────────

/**
 * The public contract the LoginGuard depends on (design §6.3 line
 * 472). `dispatch` is fire-and-forget: it enqueues work and resolves
 * immediately, so the caller (a login request handler) never blocks
 * on delivery.
 */
export interface NotificationDispatcher {
  dispatch(
    event: SecurityEvent,
    channels: readonly NotificationChannel[],
    payload: NotificationPayload,
  ): Promise<void>;
}

// ── Internal task shape ────────────────────────────────────────────────

/**
 * One queued delivery to one channel. Per design §9.4 the fan-out is
 * per-channel: a single `dispatch()` to `['email', 'webhook']`
 * produces **two** independent tasks so each channel retries (and
 * gives up) on its own schedule — a flaky webhook never delays or
 * blocks the email, and vice versa.
 *
 * Mutable `attempts` / `nextAttemptAt` are the only per-task state;
 * everything else is fixed at enqueue time.
 */
interface DispatchTask {
  readonly event: SecurityEvent;
  readonly adapter: NotificationChannelAdapter;
  readonly payload: NotificationPayload;
  /** Number of `send()` calls completed for this task. */
  attempts: number;
  /** Earliest wall-clock (ms) at which the next `send()` may run. */
  nextAttemptAt: number;
}

// ── Options ─────────────────────────────────────────────────────────────

export interface NotificationDispatcherOptions {
  /**
   * Channel adapters to register up front. The dispatcher builds a
   * `Map<NotificationChannel, adapter>` keyed on `adapter.name`; if
   * two adapters share a name the later one wins. Adapters can also
   * be added after construction via
   * {@link InProcessNotificationDispatcher.registerChannel}.
   *
   * A `dispatch()` to a channel with no registered adapter is a
   * no-op for that channel (the operator simply hasn't configured
   * it) and does not, by itself, consume the rate-limit window.
   */
  readonly channels?: readonly NotificationChannelAdapter[];
  /** Audit sink. Defaults to {@link defaultNotificationAuditWriter}. */
  readonly audit?: NotificationAuditWriter;
  /**
   * Clock source. Defaults to `Date.now`. Injected so the backoff
   * schedule and rate-limit window can be driven deterministically
   * in tests (and so task 9.6 can pass a Workers-friendly clock).
   */
  readonly now?: () => number;
  /** Override the 250ms tick cadence (tests / tuning). */
  readonly tickIntervalMs?: number;
  /** Override the 3-attempt cap (tests / tuning). */
  readonly maxAttempts?: number;
  /** Override the 60s rate-limit window (tests / tuning). */
  readonly rateLimitTtlMs?: number;
}

// ── Implementation ──────────────────────────────────────────────────────

/**
 * In-process implementation of {@link NotificationDispatcher}
 * (design §9.4, §9.5). Holds no external dependency: the queue is a
 * plain array, the rate-limit table a plain `Map`, and the worker a
 * single `setInterval`. Suitable for the self-hosted Node runtime;
 * the Workers runtime drives {@link processTick} via `ctx.waitUntil`
 * instead of {@link start} (task 9.6).
 */
export class InProcessNotificationDispatcher
  implements NotificationDispatcher
{
  private readonly adapters = new Map<
    NotificationChannel,
    NotificationChannelAdapter
  >();
  private readonly audit: NotificationAuditWriter;
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly rateLimitTtlMs: number;

  /** FIFO-ish queue of outstanding deliveries. */
  private readonly pending: DispatchTask[] = [];
  /** `${event}:${emailLower}` → wall-clock of last accepted dispatch. */
  private readonly lastDispatchAt = new Map<string, number>();

  /** Handle for the running tick interval, or `null` when stopped. */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard so a slow tick never overlaps the next fire. */
  private ticking = false;

  constructor(options: NotificationDispatcherOptions = {}) {
    this.audit = options.audit ?? defaultNotificationAuditWriter;
    this.now = options.now ?? (() => Date.now());
    this.tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.rateLimitTtlMs = options.rateLimitTtlMs ?? RATE_LIMIT_TTL_MS;
    for (const adapter of options.channels ?? []) {
      this.adapters.set(adapter.name, adapter);
    }
  }

  /**
   * Register (or replace) the adapter for a channel. The dispatcher
   * keys on `adapter.name`, so calling this with a fresh
   * {@link WebhookChannel} after a policy change atomically swaps the
   * registered webhook channel without touching in-flight tasks
   * (which hold their own adapter reference).
   */
  registerChannel(adapter: NotificationChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** Number of deliveries still queued. Exposed for tests / metrics. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Enqueue a notification for delivery (Req 13.1). Fire-and-forget:
   * resolves as soon as the rate-limit check and enqueue are done, so
   * the login request path never blocks on `send()`.
   *
   * Flow:
   *   1. Build the rate-limit key `${event}:${emailLower}`.
   *   2. If a recent accepted dispatch exists within the TTL → drop
   *      and audit `notification_rate_limited` (Req 13.5). If it
   *      exists but is stale → lazily evict it (design §9.5).
   *   3. Resolve the requested channels to registered adapters. If
   *      none resolve, return without consuming the rate-limit
   *      window (nothing was actually scheduled).
   *   4. Record the accepted-dispatch timestamp and push one task per
   *      resolved channel, each ready to send on the next tick.
   */
  async dispatch(
    event: SecurityEvent,
    channels: readonly NotificationChannel[],
    payload: NotificationPayload,
  ): Promise<void> {
    const emailLower = toEmailKey(payload.email);
    const key = `${event}:${emailLower}`;
    const now = this.now();

    // 1 + 2. Rate-limit gate with lazy eviction.
    const last = this.lastDispatchAt.get(key);
    if (last !== undefined) {
      if (now - last < this.rateLimitTtlMs) {
        // Within the window — explicit (non-silent) drop per Req 13.5.
        await this.writeAudit({
          event: 'notification_rate_limited',
          securityEvent: event,
          email: emailLower,
        });
        return;
      }
      // Stale entry: evict on insert (design §9.5) and fall through.
      this.lastDispatchAt.delete(key);
    }

    // 3. Resolve channels → adapters.
    const adapters: NotificationChannelAdapter[] = [];
    for (const name of channels) {
      const adapter = this.adapters.get(name);
      if (adapter) adapters.push(adapter);
    }
    if (adapters.length === 0) {
      // No deliverable channel configured; don't burn the rate-limit
      // window on a dispatch that scheduled nothing.
      return;
    }

    // 4. Accept: record timestamp and fan out one task per channel.
    this.lastDispatchAt.set(key, now);
    for (const adapter of adapters) {
      this.pending.push({
        event,
        adapter,
        payload,
        attempts: 0,
        nextAttemptAt: now,
      });
    }
  }

  /**
   * Process one worker tick at the given wall-clock (defaults to the
   * injected clock). Every task whose `nextAttemptAt <= now` is sent
   * once; the result drives the retry/backoff/drop logic described in
   * the module header.
   *
   * Public and `now`-parameterised so:
   *   - tests can step the backoff schedule deterministically without
   *     real timers, and
   *   - the Workers runtime (task 9.6) can drive draining from inside
   *     `ctx.waitUntil` without {@link start}.
   *
   * Ready tasks are snapshotted before sending so rescheduling a task
   * (pushing its `nextAttemptAt` into the future) can't cause it to be
   * re-sent within the same tick, and dropped tasks are spliced out of
   * the live queue as they resolve.
   */
  async processTick(now: number = this.now()): Promise<void> {
    if (this.pending.length === 0) return;

    const ready = this.pending.filter((task) => now >= task.nextAttemptAt);
    for (const task of ready) {
      const result = await this.safeSend(task);

      if (result.ok) {
        this.removeTask(task);
        continue;
      }

      if (!result.retryable) {
        // Permanent failure — no point retrying. Drop + audit now.
        this.removeTask(task);
        await this.writeAudit({
          event: 'notification_delivery_failed',
          securityEvent: task.event,
          email: toEmailKey(task.payload.email),
          channel: task.adapter.name,
          error: result.error,
        });
        continue;
      }

      // Retryable failure. Compute the backoff from the *pre-increment*
      // attempts value (so the first retry waits 2**0 = 1s), then
      // advance the counter and either reschedule or give up.
      const backoffMs = 1000 * 2 ** task.attempts;
      task.attempts += 1;
      if (task.attempts >= this.maxAttempts) {
        this.removeTask(task);
        await this.writeAudit({
          event: 'notification_delivery_failed',
          securityEvent: task.event,
          email: toEmailKey(task.payload.email),
          channel: task.adapter.name,
          error: result.error,
        });
      } else {
        task.nextAttemptAt = now + backoffMs;
      }
    }
  }

  /**
   * Start the 250ms background worker (self-hosted Node runtime).
   * Idempotent: a second call while already running is a no-op.
   *
   * The tick is guarded by {@link ticking} so a `processTick` that
   * outlives the interval (e.g. a slow SMTP send) can't overlap with
   * the next fire. On Node we `unref()` the timer when available so
   * the dispatcher's loop never keeps the process alive on its own.
   */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.processTick(this.now()).finally(() => {
        this.ticking = false;
      });
    }, this.tickIntervalMs);
    // Node's Timeout exposes unref(); the browser/Workers number does
    // not. Guard so we don't crash on runtimes without it.
    const handle = this.timer as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') handle.unref();
  }

  /** Stop the background worker. Idempotent. Queued tasks remain. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Send a task, normalising an unexpected throw into a retryable
   * {@link DeliveryResult}. The {@link NotificationChannelAdapter}
   * contract says expected failures round-trip through the result and
   * adapters shouldn't throw — but a programming error or lifecycle
   * bug shouldn't kill the tick (and with it every other queued
   * notification), so we belt-and-brace.
   */
  private async safeSend(task: DispatchTask): Promise<DeliveryResult> {
    try {
      return await task.adapter.send(task.payload);
    } catch (err) {
      return { ok: false, error: errorMessage(err), retryable: true };
    }
  }

  private removeTask(task: DispatchTask): void {
    const idx = this.pending.indexOf(task);
    if (idx >= 0) this.pending.splice(idx, 1);
  }

  /**
   * Invoke the audit sink, swallowing any error it throws. An audit
   * failure must never break the tick or bubble up to the (already
   * decoupled) login path — Req 13.4 wants delivery failures recorded
   * best-effort, and the same applies to the recording itself.
   */
  private async writeAudit(entry: NotificationAuditEntry): Promise<void> {
    try {
      await this.audit(entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        '[notifications] audit writer threw; dropping audit entry',
        errorMessage(err),
      );
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Construct an {@link InProcessNotificationDispatcher}. A thin
 * convenience wrapper mirroring the `*Factory` helpers in the sibling
 * channel modules so call sites read uniformly and don't `new` the
 * class directly.
 */
export function createNotificationDispatcher(
  options: NotificationDispatcherOptions = {},
): InProcessNotificationDispatcher {
  return new InProcessNotificationDispatcher(options);
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Normalise an email into the rate-limit key form: trimmed +
 * lowercased. Inlined (rather than importing
 * `login-guard/email-normalize`) to keep the dependency direction
 * one-way — once task 9.5 wires LoginGuard → dispatcher, importing
 * back into login-guard would risk a cycle. The two implementations
 * agree on `trim().toLowerCase()`.
 */
function toEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 256);
  if (typeof err === 'string') return err.slice(0, 256);
  return 'unknown-error';
}
