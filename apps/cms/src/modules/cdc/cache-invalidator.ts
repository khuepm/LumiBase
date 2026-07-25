/**
 * CacheInvalidator — Redis cache auto-refresh from CDC change events
 * (ClickHouse CDC — task 8.1; design §3, Requirement 5).
 *
 * Consumes CDC change events captured from the Source_Database and translates
 * them into Redis cache operations through the shared
 * {@link CacheProvider} abstraction:
 *
 *   - INSERT → SET (pre-warm the cache with the new record)        (Req 5.3)
 *   - UPDATE → SET (refresh the cached record)                     (Req 5.1)
 *   - DELETE → DEL (remove the cached record)                      (Req 5.2)
 *
 * Cache keys are derived deterministically from `(table, recordId)` using the
 * existing `CacheProvider` namespace convention (e.g. `config:settings:abc123`).
 *
 * Key behaviours:
 *   - **Deduplication window (Req 5.6 / Property 12)**: consecutive UPDATE
 *     events for the same cache key that fall inside a 1-second window are
 *     collapsed into a single refresh that carries the latest state. INSERT
 *     and DELETE events are NEVER deduplicated — they are processed
 *     immediately, flushing any pending UPDATE for that key first, so no
 *     INSERT/DELETE is dropped and per-key operation ordering is preserved.
 *   - **Bounded outage queue (Req 5.4, 5.5 / Property 13)**: while Redis is
 *     unavailable, resolved operations are queued (FIFO) up to 10,000 entries.
 *     On overflow the oldest entries are discarded with a warning log. On
 *     reconnection the queue is replayed in its original chronological order.
 *   - **Retry & skip (Req 5.7)**: a per-key operation is retried up to 3 times;
 *     if it still fails (while Redis remains reachable) the event is logged
 *     with table/record/operation/reason and skipped.
 *   - **Log completeness (Req 5.8 / Property 14)**: every handled event is
 *     logged with its table name, record identifier, and operation type.
 *
 * The Redis side-effects are abstracted behind the injectable
 * {@link CacheProvider} interface, and connectivity, logging, and (optional)
 * timer-based liveness are injectable too, so the deduplication, queue,
 * replay, retry, and logging logic can be unit/property tested without a live
 * Redis. Sensible in-memory defaults are provided.
 *
 * Concurrency: like the sibling CDC connectors, {@link CacheInvalidator}
 * assumes events are delivered sequentially (one `handleEvent` awaited before
 * the next). A single internal drainer guarantees the outage queue is never
 * processed by two overlapping calls.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8
 */

import type { CacheProvider } from '@lumibase/runtime';

// ── constants ────────────────────────────────────────────────────────────

/** Deduplication window for consecutive UPDATE events: 1 second (Req 5.6). */
export const DEDUP_WINDOW_MS = 1_000;

/** Maximum number of events buffered during a Redis outage (Req 5.4). */
export const MAX_QUEUE_SIZE = 10_000;

/**
 * Number of times a failed per-key operation is retried before it is skipped
 * (Req 5.7). The initial attempt plus these retries gives at most
 * `MAX_RETRIES + 1` total attempts.
 */
export const MAX_RETRIES = 3;

/** Default Redis key namespace for CDC-derived configuration cache entries. */
export const DEFAULT_CACHE_KEY_PREFIX = 'config';

// ── change-event model (design §3) ───────────────────────────────────────

/** The DML operation that produced a CDC change event. */
export type CdcOperation = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * A single row-level change captured from the Source_Database and delivered
 * to the {@link CacheInvalidator}.
 */
export interface CdcChangeEvent {
  /** Source table name (e.g. `settings`, `public.collections`). */
  readonly table: string;
  /** Identifier of the affected row. */
  readonly recordId: string;
  /** The DML operation that produced this event. */
  readonly operation: CdcOperation;
  /** Optional row payload (column values) used to pre-warm/refresh the cache. */
  readonly payload?: Record<string, unknown>;
  /** Unix-ms timestamp at which the change was committed. */
  readonly timestamp: number;
}

// ── resolved cache operation ─────────────────────────────────────────────

/** The Redis action a resolved cache operation applies. */
export type CacheActionKind = 'SET' | 'DEL';

/**
 * A change event resolved to the concrete Redis action and cache key it will
 * apply. Buffered in the outage queue and applied in FIFO order.
 */
export interface CacheOperation {
  readonly kind: CacheActionKind;
  readonly key: string;
  readonly event: CdcChangeEvent;
}

// ── structured logging (Req 5.5, 5.7, 5.8) ───────────────────────────────

/**
 * A structured log entry emitted by the {@link CacheInvalidator}. The
 * discriminated `type` selects the entry shape:
 *   - `event`          — one per handled event (Req 5.8 / Property 14).
 *   - `failure`        — a per-key operation skipped after retries (Req 5.7).
 *   - `queue_overflow` — oldest events discarded on queue overflow (Req 5.5).
 *   - `outage`         — Redis became unavailable; events are being queued.
 *   - `replay`         — queue replay started/finished on reconnection.
 */
export type CacheInvalidatorLogEntry =
  | {
      readonly type: 'event';
      readonly table: string;
      readonly recordId: string;
      readonly operation: CdcOperation;
      readonly key: string;
    }
  | {
      readonly type: 'failure';
      readonly table: string;
      readonly recordId: string;
      readonly operation: CdcOperation;
      readonly key: string;
      readonly reason: string;
    }
  | {
      readonly type: 'queue_overflow';
      readonly discardedNow: number;
      readonly discardedTotal: number;
      readonly queueDepth: number;
    }
  | {
      readonly type: 'outage';
      readonly queueDepth: number;
    }
  | {
      readonly type: 'replay';
      readonly phase: 'start' | 'end';
      readonly count: number;
    };

/**
 * Sink for {@link CacheInvalidatorLogEntry} records. Injectable so callers can
 * route entries to their preferred logger and tests can capture them.
 */
export interface CacheInvalidatorLogger {
  log(entry: CacheInvalidatorLogEntry): void;
}

// ── optional liveness scheduler ──────────────────────────────────────────

/**
 * Timer abstraction used to flush a lingering pending UPDATE once its
 * deduplication window elapses, even when no further events arrive (so an
 * idle key is still refreshed within the Req 5.1 budget). Injectable so tests
 * can drive flushing deterministically; defaults to `setTimeout`.
 */
export interface CacheInvalidatorScheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

// ── key derivation (design §3) ────────────────────────────────────────────

/**
 * Derive the Redis cache key for a `(table, recordId)` pair using the
 * `CacheProvider` namespace convention. Pure and deterministic.
 *
 * @example deriveCacheKey('settings', 'abc123')    // 'config:settings:abc123'
 * @example deriveCacheKey('collections', 'xyz789') // 'config:collections:xyz789'
 */
export function deriveCacheKey(
  table: string,
  recordId: string,
  prefix: string = DEFAULT_CACHE_KEY_PREFIX,
): string {
  return `${prefix}:${table}:${recordId}`;
}

/**
 * Map a CDC operation to the Redis action it triggers (Req 5.1–5.3 /
 * Property 11): INSERT and UPDATE both SET (pre-warm / refresh), DELETE
 * removes (DEL).
 */
export function cacheActionForOperation(operation: CdcOperation): CacheActionKind {
  return operation === 'DELETE' ? 'DEL' : 'SET';
}

// ── default collaborators ─────────────────────────────────────────────────

/**
 * In-memory {@link CacheProvider} suitable as a default in environments
 * without a real Redis and as a test double. Exposes {@link setAvailable} so
 * tests can simulate a Redis outage: while unavailable, all operations reject
 * (mirroring a dropped connection).
 */
export class InMemoryCacheProvider implements CacheProvider {
  readonly store = new Map<string, string>();
  private available = true;

  /** Toggle simulated Redis availability (test/diagnostic helper). */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /** Whether the simulated Redis is currently reachable. */
  isAvailable(): boolean {
    return this.available;
  }

  async get<T = string>(key: string): Promise<T | null> {
    if (!this.available) {
      throw new Error('Redis unavailable');
    }
    return (this.store.get(key) ?? null) as T | null;
  }

  async set(
    key: string,
    value: string,
    _options?: { ttl?: number },
  ): Promise<void> {
    if (!this.available) {
      throw new Error('Redis unavailable');
    }
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    if (!this.available) {
      throw new Error('Redis unavailable');
    }
    this.store.delete(key);
  }

  async increment(key: string, by = 1, _opts?: { ttl?: number }): Promise<number> {
    if (!this.available) {
      throw new Error('Redis unavailable');
    }
    const next = Number(this.store.get(key) ?? '0') + by;
    this.store.set(key, String(next));
    return next;
  }
}

/**
 * Logger that records every entry in memory. Default for tests asserting on
 * log completeness (Property 14) and discard/replay behaviour.
 */
export class InMemoryCacheInvalidatorLogger implements CacheInvalidatorLogger {
  readonly entries: CacheInvalidatorLogEntry[] = [];

  log(entry: CacheInvalidatorLogEntry): void {
    this.entries.push(entry);
  }

  /** Convenience: all entries of a given discriminated type. */
  entriesOfType<T extends CacheInvalidatorLogEntry['type']>(
    type: T,
  ): Extract<CacheInvalidatorLogEntry, { type: T }>[] {
    return this.entries.filter(
      (e): e is Extract<CacheInvalidatorLogEntry, { type: T }> =>
        e.type === type,
    );
  }
}

/**
 * Default logger that routes entries to the console using the structured
 * `[cdc/cache-invalidator]` pattern already used across the CMS modules.
 * Failures and overflows are warnings/errors; routine events and replay
 * notices are informational.
 */
export class ConsoleCacheInvalidatorLogger implements CacheInvalidatorLogger {
  log(entry: CacheInvalidatorLogEntry): void {
    const prefix = '[cdc/cache-invalidator]';
    switch (entry.type) {
      case 'failure':
        // eslint-disable-next-line no-console
        console.error(prefix, entry);
        break;
      case 'queue_overflow':
      case 'outage':
        // eslint-disable-next-line no-console
        console.warn(prefix, entry);
        break;
      default:
        // eslint-disable-next-line no-console
        console.info(prefix, entry);
        break;
    }
  }
}

/** Default {@link CacheInvalidatorScheduler} backed by `setTimeout`. */
const defaultScheduler: CacheInvalidatorScheduler = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms);
    // Don't keep the event loop alive solely for a pending dedup flush.
    if (typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

// ── dependencies ───────────────────────────────────────────────────────────

export interface CacheInvalidatorDeps {
  /** Backing cache. Defaults to an {@link InMemoryCacheProvider}. */
  readonly cache?: CacheProvider;
  /**
   * Connectivity probe used to distinguish a Redis outage (queue + replay,
   * Req 5.4) from a transient per-key failure (retry + skip, Req 5.7).
   * Defaults to probing the in-memory cache, otherwise always-available.
   */
  readonly isCacheAvailable?: () => boolean | Promise<boolean>;
  /** Structured log sink. Defaults to {@link ConsoleCacheInvalidatorLogger}. */
  readonly logger?: CacheInvalidatorLogger;
  /** Cache key namespace prefix. Defaults to {@link DEFAULT_CACHE_KEY_PREFIX}. */
  readonly keyPrefix?: string;
  /** Optional TTL (seconds) applied to SET (pre-warm/refresh) operations. */
  readonly cacheTtlSeconds?: number;
  /** Override the outage queue capacity (defaults to {@link MAX_QUEUE_SIZE}). */
  readonly maxQueueSize?: number;
  /** Override the dedup window (defaults to {@link DEDUP_WINDOW_MS}). */
  readonly dedupWindowMs?: number;
  /** Override the per-key retry count (defaults to {@link MAX_RETRIES}). */
  readonly maxRetries?: number;
  /**
   * Timer used to flush a lingering pending UPDATE once its window elapses.
   * Defaults to a `setTimeout`-backed scheduler. Pass `disableAutoFlush: true`
   * (or drive {@link CacheInvalidator.flush} yourself) for fully deterministic
   * behaviour with no timers.
   */
  readonly scheduler?: CacheInvalidatorScheduler;
  /** Disable timer-based auto-flush of pending UPDATE events. */
  readonly disableAutoFlush?: boolean;
}

// ── internal pending-UPDATE state ─────────────────────────────────────────

interface PendingUpdate {
  /** The latest UPDATE event collapsed into this window. */
  event: CdcChangeEvent;
  /** Timestamp of the first UPDATE that opened this window. */
  readonly windowStartTs: number;
  /** Optional liveness timer handle. */
  timer?: unknown;
}

// ── implementation ─────────────────────────────────────────────────────────

export class CacheInvalidator {
  private readonly cache: CacheProvider;
  private readonly isCacheAvailable: () => boolean | Promise<boolean>;
  private readonly logger: CacheInvalidatorLogger;
  private readonly keyPrefix: string;
  private readonly cacheTtlSeconds?: number;
  private readonly maxQueueSize: number;
  private readonly dedupWindowMs: number;
  private readonly maxRetries: number;
  private readonly scheduler?: CacheInvalidatorScheduler;

  /**
   * Per-key pending UPDATE events awaiting their dedup window. A `Map`
   * preserves insertion order, so {@link flush} resolves them in the order
   * their windows opened.
   */
  private readonly pendingUpdates = new Map<string, PendingUpdate>();

  /** FIFO outage queue of resolved operations (Req 5.4 / Property 13). */
  private readonly queue: CacheOperation[] = [];

  /** Cumulative number of events discarded on queue overflow (Req 5.5). */
  private discardedTotal = 0;

  /** Guards against overlapping queue drains. */
  private draining = false;

  /** Whether an outage has been logged (so it is logged at most once). */
  private outageLogged = false;

  constructor(deps: CacheInvalidatorDeps = {}) {
    const cache = deps.cache ?? new InMemoryCacheProvider();
    this.cache = cache;
    this.isCacheAvailable =
      deps.isCacheAvailable ??
      (cache instanceof InMemoryCacheProvider
        ? () => cache.isAvailable()
        : () => true);
    this.logger = deps.logger ?? new ConsoleCacheInvalidatorLogger();
    this.keyPrefix = deps.keyPrefix ?? DEFAULT_CACHE_KEY_PREFIX;
    this.cacheTtlSeconds = deps.cacheTtlSeconds;
    this.maxQueueSize = deps.maxQueueSize ?? MAX_QUEUE_SIZE;
    this.dedupWindowMs = deps.dedupWindowMs ?? DEDUP_WINDOW_MS;
    this.maxRetries = deps.maxRetries ?? MAX_RETRIES;
    this.scheduler = deps.disableAutoFlush
      ? undefined
      : (deps.scheduler ?? defaultScheduler);
  }

  // ── public API (design §3) ────────────────────────────────────────────

  /**
   * Handle a CDC change event. Logs the event (Req 5.8), applies the
   * deduplication rules (Req 5.6), and dispatches the resolved Redis
   * operation — applying it immediately when connected or queueing it during
   * an outage (Req 5.4).
   */
  async handleEvent(event: CdcChangeEvent): Promise<void> {
    const key = this.keyFor(event);

    // Req 5.8 / Property 14 — every handled event is logged with its
    // table, record id, and operation type.
    this.logger.log({
      type: 'event',
      table: event.table,
      recordId: event.recordId,
      operation: event.operation,
      key,
    });

    // Liveness: flush other keys' pending UPDATEs whose window has elapsed
    // relative to this event's commit time (keeps latency bounded while the
    // event stream is active). The current key is handled explicitly below.
    await this.flushExpiredPendingUpdates(event.timestamp, key);

    if (event.operation === 'UPDATE') {
      await this.handleUpdate(key, event);
      return;
    }

    // INSERT / DELETE are never deduplicated. Flush any pending UPDATE for
    // this key FIRST so per-key operation ordering is preserved (Req 5.6).
    if (this.pendingUpdates.has(key)) {
      await this.resolvePending(key);
    }

    await this.dispatch({
      kind: cacheActionForOperation(event.operation),
      key,
      event,
    });
  }

  /**
   * Flush all pending UPDATE events and drain the outage queue against Redis.
   * Call on Redis reconnection, or periodically, to bound the latency of
   * lingering pending UPDATEs and queued operations.
   */
  async flush(): Promise<void> {
    for (const key of [...this.pendingUpdates.keys()]) {
      await this.resolvePending(key);
    }
    await this.drainQueue();
  }

  /** Current depth of the outage replay queue (Req 5.4). */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /** Number of pending (held) UPDATE events awaiting their dedup window. */
  getPendingUpdateCount(): number {
    return this.pendingUpdates.size;
  }

  /** Cumulative number of events discarded due to queue overflow (Req 5.5). */
  getDiscardedCount(): number {
    return this.discardedTotal;
  }

  // ── deduplication (Req 5.6 / Property 12) ──────────────────────────────

  private async handleUpdate(key: string, event: CdcChangeEvent): Promise<void> {
    const pending = this.pendingUpdates.get(key);

    if (pending) {
      if (event.timestamp - pending.windowStartTs <= this.dedupWindowMs) {
        // Consecutive UPDATE within the window — collapse into the latest
        // state; the window anchor (windowStartTs) is preserved.
        pending.event = event;
        return;
      }
      // Window elapsed — flush the prior UPDATE, then open a new window.
      await this.resolvePending(key);
    }

    this.setPending(key, event);
  }

  private setPending(key: string, event: CdcChangeEvent): void {
    const timer = this.scheduler
      ? this.scheduler.set(() => {
          void this.onPendingTimeout(key);
        }, this.dedupWindowMs)
      : undefined;
    this.pendingUpdates.set(key, {
      event,
      windowStartTs: event.timestamp,
      timer,
    });
  }

  /** Resolve a single pending UPDATE into a dispatched SET operation. */
  private async resolvePending(key: string): Promise<void> {
    const pending = this.pendingUpdates.get(key);
    if (!pending) {
      return;
    }
    this.pendingUpdates.delete(key);
    if (pending.timer !== undefined && this.scheduler) {
      this.scheduler.clear(pending.timer);
    }
    await this.dispatch({ kind: 'SET', key, event: pending.event });
  }

  /** Flush pending UPDATEs whose dedup window has elapsed (excluding `skipKey`). */
  private async flushExpiredPendingUpdates(
    nowTs: number,
    skipKey?: string,
  ): Promise<void> {
    const expired: string[] = [];
    for (const [key, pending] of this.pendingUpdates) {
      if (key === skipKey) {
        continue;
      }
      if (nowTs - pending.windowStartTs > this.dedupWindowMs) {
        expired.push(key);
      }
    }
    for (const key of expired) {
      await this.resolvePending(key);
    }
  }

  /** Timer callback: flush a lingering pending UPDATE once its window elapses. */
  private async onPendingTimeout(key: string): Promise<void> {
    try {
      await this.resolvePending(key);
      await this.drainQueue();
    } catch {
      // Best-effort liveness flush; failures are surfaced via the per-key
      // failure log inside the drain path.
    }
  }

  // ── dispatch, queue & replay (Req 5.4, 5.5 / Property 13) ──────────────

  /**
   * Enqueue a resolved operation and attempt to drain the queue. All
   * operations flow through the FIFO queue so that, during an outage,
   * chronological order is preserved and replayed faithfully on recovery.
   */
  private async dispatch(op: CacheOperation): Promise<void> {
    this.enqueue(op);
    await this.drainQueue();
  }

  /** Append an operation, discarding the oldest on overflow (Req 5.5). */
  private enqueue(op: CacheOperation): void {
    if (this.queue.length >= this.maxQueueSize) {
      let discardedNow = 0;
      // Make room for the incoming op while respecting the cap.
      while (this.queue.length >= this.maxQueueSize) {
        this.queue.shift();
        discardedNow += 1;
      }
      this.discardedTotal += discardedNow;
      this.logger.log({
        type: 'queue_overflow',
        discardedNow,
        discardedTotal: this.discardedTotal,
        queueDepth: this.queue.length,
      });
    }
    this.queue.push(op);
  }

  /**
   * Drain the outage queue in FIFO order while Redis is reachable. Stops and
   * leaves the remaining operations queued (in order) if connectivity is lost
   * mid-drain; per-key failures are logged and skipped (Req 5.7).
   */
  private async drainQueue(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      let replayStarted = false;
      while (this.queue.length > 0) {
        const available = await this.available();
        if (!available) {
          this.noteOutage();
          return;
        }

        // We are connected; note the start of a replay if we were queueing.
        if (this.outageLogged && !replayStarted) {
          this.logger.log({
            type: 'replay',
            phase: 'start',
            count: this.queue.length,
          });
          replayStarted = true;
        }

        const op = this.queue[0]!;
        const result = await this.applyWithRetry(op);
        if (result === 'connectivity') {
          // Lost connection mid-drain — leave op + remainder queued in order.
          this.noteOutage();
          return;
        }
        // 'ok' or 'skipped' — the op is done with; advance the queue.
        this.queue.shift();
      }

      if (replayStarted) {
        this.logger.log({ type: 'replay', phase: 'end', count: 0 });
      }
      this.outageLogged = false;
    } finally {
      this.draining = false;
    }
  }

  private noteOutage(): void {
    if (!this.outageLogged) {
      this.logger.log({ type: 'outage', queueDepth: this.queue.length });
      this.outageLogged = true;
    }
  }

  // ── apply with retry (Req 5.7) ─────────────────────────────────────────

  /**
   * Apply a single operation, retrying transient per-key failures up to
   * {@link maxRetries} times. Returns:
   *   - `'ok'`           on success,
   *   - `'connectivity'` if Redis is unavailable (caller should re-queue),
   *   - `'skipped'`      if the operation failed after all retries while Redis
   *                      remained reachable (logged + skipped, Req 5.7).
   */
  private async applyWithRetry(
    op: CacheOperation,
  ): Promise<'ok' | 'skipped' | 'connectivity'> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        await this.execute(op);
        return 'ok';
      } catch (err) {
        lastError = err;
        // A connectivity loss is not a per-key failure: stop retrying and
        // signal the caller to queue for replay (Req 5.4).
        if (!(await this.available())) {
          return 'connectivity';
        }
        // Otherwise it is a transient per-key error — retry until exhausted.
      }
    }

    // Retries exhausted while Redis remained reachable — log and skip (Req 5.7).
    this.logger.log({
      type: 'failure',
      table: op.event.table,
      recordId: op.event.recordId,
      operation: op.event.operation,
      key: op.key,
      reason: errorReason(lastError),
    });
    return 'skipped';
  }

  /** Apply the resolved Redis action for an operation. */
  private async execute(op: CacheOperation): Promise<void> {
    if (op.kind === 'DEL') {
      await this.cache.delete(op.key);
      return;
    }
    const value = serializePayload(op.event.payload);
    await this.cache.set(
      op.key,
      value,
      this.cacheTtlSeconds !== undefined
        ? { ttl: this.cacheTtlSeconds }
        : undefined,
    );
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private keyFor(event: CdcChangeEvent): string {
    return deriveCacheKey(event.table, event.recordId, this.keyPrefix);
  }

  /** Connectivity probe wrapper; treats probe errors as "unavailable". */
  private async available(): Promise<boolean> {
    try {
      return await this.isCacheAvailable();
    } catch {
      return false;
    }
  }
}

// ── module-private helpers ─────────────────────────────────────────────────

/** Serialize a change-event payload for a SET (pre-warm/refresh) operation. */
function serializePayload(payload: Record<string, unknown> | undefined): string {
  return JSON.stringify(payload ?? null);
}

/** Extract a human-readable reason from a thrown value. */
function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
