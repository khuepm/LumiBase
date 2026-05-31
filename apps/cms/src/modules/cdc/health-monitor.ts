/**
 * HealthMonitor — CDC pipeline metrics emission and alerting
 * (ClickHouse CDC — task 9.1; design §4, Requirement 8).
 *
 * Periodically collects metrics from active pipelines (via the connector's
 * {@link HealthMetricsSource}), persists health history, and raises the
 * notifications required by Requirement 8:
 *
 *   - **Metrics emission (Req 8.1)**: while monitoring, emit health metrics
 *     (replication lag in ms, throughput in events/sec, error count) every
 *     `emitIntervalMs` (default 30s) and append each sample to the health
 *     history store.
 *   - **Lag-threshold warning (Req 8.2 / Property 20)**: emit a `lag_warning`
 *     notification iff the measured replication lag exceeds the configured
 *     threshold (default 60s, configurable in [10s, 3600s]).
 *   - **Error-duration critical alert (Req 8.3)**: once a pipeline has been in
 *     the `error` state for more than 5 minutes, emit a single
 *     `error_critical` notification.
 *   - **Health-history retention (Req 8.4)**: retain samples for at least
 *     `retentionDays` (default 7) at the emission granularity; older samples
 *     are pruned.
 *   - **Connectivity health check (Req 8.5)**: {@link HealthMonitor.checkHealth}
 *     delegates to the connector's `healthCheck`, which verifies each service
 *     (Source_Database, ClickHouse_Sink, intermediary) with a 10s per-service
 *     timeout and returns a per-service reachable/unreachable status.
 *   - **Recovery notification (Req 8.6 / Property 21)**: emit exactly one
 *     `recovery` notification when a pipeline transitions from `error` back to
 *     `active`.
 *   - **Missed-metrics critical (Req 8.7)**: if metrics emission is missed for
 *     3 consecutive intervals (90s), set the pipeline status to `error` and
 *     emit a single `missed_metrics_critical` notification.
 *
 * All side-effecting collaborators — the metrics source, the history store,
 * the notification sink, the pipeline-status gateway, the interval scheduler,
 * and the timeout timers — are injectable, with in-memory defaults, so the
 * threshold-alerting, recovery, missed-metrics, and retention logic can be
 * unit/property tested without live infrastructure. The threshold-alerting
 * and recovery-transition rules are also exposed as pure helpers
 * ({@link shouldEmitLagWarning}, {@link isRecoveryTransition}) for direct
 * property testing.
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */

import { and, eq, gte, lt } from 'drizzle-orm';
import { cdcPipelineHealth, type Database } from '@lumibase/database';
import { MonitorConfigSchema } from '@lumibase/shared';

import type {
  HealthCheckResult,
  PipelineMetrics,
} from './connectors/types';

// ── constants ────────────────────────────────────────────────────────────

/** Default metrics emission interval: 30 seconds (Req 8.1). */
export const DEFAULT_EMIT_INTERVAL_MS = 30_000;

/** Default replication-lag warning threshold: 60 seconds (Req 8.2). */
export const DEFAULT_LAG_THRESHOLD_MS = 60_000;

/** Minimum configurable lag threshold: 10 seconds (Req 8.2). */
export const MIN_LAG_THRESHOLD_MS = 10_000;

/** Maximum configurable lag threshold: 3600 seconds (Req 8.2). */
export const MAX_LAG_THRESHOLD_MS = 3_600_000;

/** Default health-history retention: 7 days (Req 8.4). */
export const DEFAULT_RETENTION_DAYS = 7;

/** Milliseconds in one day (for retention windows). */
export const MS_PER_DAY = 86_400_000;

/**
 * Duration a pipeline may remain in the `error` state before a critical alert
 * is raised: 5 minutes (Req 8.3).
 */
export const ERROR_ALERT_THRESHOLD_MS = 5 * 60_000;

/**
 * Number of consecutive missed emission intervals that drives a pipeline to
 * `error` status: 3 intervals / 90 seconds (Req 8.7).
 */
export const MISSED_INTERVALS_LIMIT = 3;

/** Per-service connectivity health-check timeout: 10 seconds (Req 8.5). */
export const HEALTH_CHECK_TIMEOUT_MS = 10_000;

// ── status model ──────────────────────────────────────────────────────────

/** Operational state of a CDC pipeline (mirrors the registry/connectors). */
export type PipelineStatus = 'active' | 'paused' | 'error' | 'provisioning';

// ── monitor configuration (design §4) ──────────────────────────────────

/**
 * Resolved monitor configuration. Mirrors the design's `MonitorConfig`
 * interface (camelCase). Use {@link resolveMonitorConfig} to fill defaults
 * and validate ranges via the shared `MonitorConfigSchema`.
 */
export interface MonitorConfig {
  /** Metrics emission interval in ms (default {@link DEFAULT_EMIT_INTERVAL_MS}). */
  readonly emitIntervalMs: number;
  /**
   * Replication-lag warning threshold in ms
   * (default {@link DEFAULT_LAG_THRESHOLD_MS}, range
   * [{@link MIN_LAG_THRESHOLD_MS}, {@link MAX_LAG_THRESHOLD_MS}]).
   */
  readonly lagThresholdMs: number;
  /** Health-history retention in days (default {@link DEFAULT_RETENTION_DAYS}). */
  readonly retentionDays: number;
}

// ── health history (Req 8.4) ──────────────────────────────────────────────

/**
 * A single health metrics sample, retained in the health history at the
 * emission granularity (Req 8.4). Mirrors the `cdc_pipeline_health` table.
 */
export interface HealthMetricEntry {
  /** Identifier of the pipeline this sample belongs to. */
  readonly pipelineId: string;
  /** Replication lag in milliseconds at the time of the sample (Req 8.1). */
  readonly replicationLagMs: number;
  /** Throughput in events per second (Req 8.1). */
  readonly eventsPerSecond: number;
  /** Cumulative error count (Req 8.1). */
  readonly errorCount: number;
  /** ISO-8601 timestamp of when the sample was recorded. */
  readonly recordedAt: string;
}

// ── notifications (Req 8.1, 8.2, 8.3, 8.6, 8.7) ──────────────────────────

/**
 * A structured notification emitted by the {@link HealthMonitor}. The
 * discriminated `type` selects the payload shape and implies severity:
 *   - `metrics`                  — routine emission of a health sample (8.1).
 *   - `lag_warning`              — replication lag exceeded threshold (8.2).
 *   - `error_critical`           — pipeline in error state > 5 minutes (8.3).
 *   - `missed_metrics_critical`  — 3 consecutive missed intervals (8.7).
 *   - `recovery`                 — error → active transition (8.6).
 */
export type HealthNotification =
  | {
      readonly type: 'metrics';
      readonly pipelineId: string;
      readonly metrics: PipelineMetrics;
      readonly at: string;
    }
  | {
      readonly type: 'lag_warning';
      readonly pipelineId: string;
      readonly lagMs: number;
      readonly thresholdMs: number;
      readonly at: string;
    }
  | {
      readonly type: 'error_critical';
      readonly pipelineId: string;
      readonly errorDurationMs: number;
      readonly at: string;
    }
  | {
      readonly type: 'missed_metrics_critical';
      readonly pipelineId: string;
      readonly missedIntervals: number;
      readonly at: string;
    }
  | {
      readonly type: 'recovery';
      readonly pipelineId: string;
      readonly at: string;
    };

/** Severity label for a notification type (used by the console sink). */
export type HealthNotificationSeverity = 'info' | 'warning' | 'critical';

/** Map a notification to its severity. */
export function notificationSeverity(
  notification: HealthNotification,
): HealthNotificationSeverity {
  switch (notification.type) {
    case 'lag_warning':
      return 'warning';
    case 'error_critical':
    case 'missed_metrics_critical':
      return 'critical';
    default:
      return 'info';
  }
}

/**
 * Sink for {@link HealthNotification}s. Injectable so callers can route alerts
 * to their notification system and tests can capture them.
 */
export interface HealthNotificationSink {
  notify(notification: HealthNotification): void;
}

// ── collaborators ──────────────────────────────────────────────────────────

/**
 * Source of per-pipeline metrics and connectivity health. A structural subset
 * of {@link CdcConnector} (its `getMetrics` and `healthCheck` methods) so any
 * connector can be used directly.
 */
export interface HealthMetricsSource {
  getMetrics(pipelineId: string): Promise<PipelineMetrics>;
  healthCheck(pipelineId: string): Promise<HealthCheckResult>;
}

/**
 * Resolves the {@link HealthMetricsSource} for a pipeline. Returns
 * `null`/`undefined` when no source is registered for the pipeline.
 */
export type HealthMetricsSourceResolver = (
  pipelineId: string,
) => HealthMetricsSource | null | undefined;

/**
 * Persists and queries health history (Req 8.4). The default in-memory store
 * is suitable for tests; {@link DrizzleHealthHistoryStore} persists to the
 * `cdc_pipeline_health` table for production.
 */
export interface HealthHistoryStore {
  /** Append a health sample. */
  append(entry: HealthMetricEntry): Promise<void>;
  /** Return samples for a pipeline recorded at or after `since`, oldest first. */
  query(pipelineId: string, since: Date): Promise<HealthMetricEntry[]>;
  /** Remove samples older than `before` (retention pruning, Req 8.4). */
  prune(before: Date): Promise<void>;
}

/**
 * Reads and writes pipeline status. The monitor reads status to detect
 * error→active recovery (Req 8.6) and error-duration (Req 8.3), and writes
 * `error` when emission is missed for 3 intervals (Req 8.7). Maps onto the
 * Pipeline Registry's `get`/`updateStatus`.
 */
export interface PipelineStatusGateway {
  getStatus(pipelineId: string): Promise<PipelineStatus> | PipelineStatus;
  setStatus(
    pipelineId: string,
    status: PipelineStatus,
    message?: string,
  ): Promise<void> | void;
}

/** Periodic scheduler abstraction for the per-pipeline emission interval. */
export interface IntervalScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** One-shot timer abstraction used to bound metric-fetch latency. */
export interface MonitorTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// ── pure helpers (Property 20, 21) ────────────────────────────────────────

/**
 * Whether a replication-lag warning should be emitted (Req 8.2 / Property 20):
 * the warning fires **iff** the measured lag strictly exceeds the configured
 * threshold. Pure and deterministic.
 */
export function shouldEmitLagWarning(lagMs: number, thresholdMs: number): boolean {
  return lagMs > thresholdMs;
}

/**
 * Whether a status change is a recovery transition (Req 8.6 / Property 21):
 * a transition is a recovery **iff** it moves directly from `error` to
 * `active`. Pure and deterministic.
 */
export function isRecoveryTransition(
  previous: PipelineStatus | null,
  next: PipelineStatus,
): boolean {
  return previous === 'error' && next === 'active';
}

/**
 * Resolve a (possibly partial) monitor configuration to a fully-populated
 * {@link MonitorConfig}, applying defaults and validating ranges via the
 * shared `MonitorConfigSchema` (which enforces the lag threshold range
 * [{@link MIN_LAG_THRESHOLD_MS}, {@link MAX_LAG_THRESHOLD_MS}] and a minimum
 * 1-day retention). Throws a `ZodError` if a provided value is out of range.
 */
export function resolveMonitorConfig(
  input: Partial<MonitorConfig> = {},
): MonitorConfig {
  const parsed = MonitorConfigSchema.parse({
    lag_threshold_ms: input.lagThresholdMs,
    emit_interval_ms: input.emitIntervalMs,
    retention_days: input.retentionDays,
  });
  return {
    emitIntervalMs: parsed.emit_interval_ms,
    lagThresholdMs: parsed.lag_threshold_ms,
    retentionDays: parsed.retention_days,
  };
}

// ── default collaborators ─────────────────────────────────────────────────

/**
 * In-memory {@link HealthHistoryStore} suitable as a default in environments
 * without a database and as a test double. Keeps samples in insertion order
 * per pipeline.
 */
export class InMemoryHealthHistoryStore implements HealthHistoryStore {
  readonly samples = new Map<string, HealthMetricEntry[]>();

  async append(entry: HealthMetricEntry): Promise<void> {
    const list = this.samples.get(entry.pipelineId) ?? [];
    list.push(entry);
    this.samples.set(entry.pipelineId, list);
  }

  async query(pipelineId: string, since: Date): Promise<HealthMetricEntry[]> {
    const sinceMs = since.getTime();
    return (this.samples.get(pipelineId) ?? [])
      .filter((e) => Date.parse(e.recordedAt) >= sinceMs)
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  }

  async prune(before: Date): Promise<void> {
    const beforeMs = before.getTime();
    for (const [pipelineId, list] of this.samples) {
      this.samples.set(
        pipelineId,
        list.filter((e) => Date.parse(e.recordedAt) >= beforeMs),
      );
    }
  }
}

/**
 * Drizzle-backed {@link HealthHistoryStore} that persists samples to the
 * `cdc_pipeline_health` table (Req 8.4). Use in production so health history
 * is retained across restarts at the emission granularity.
 */
export class DrizzleHealthHistoryStore implements HealthHistoryStore {
  constructor(private readonly db: Database) {}

  async append(entry: HealthMetricEntry): Promise<void> {
    await this.db.insert(cdcPipelineHealth).values({
      pipelineId: entry.pipelineId,
      replicationLagMs: entry.replicationLagMs,
      eventsPerSecond: entry.eventsPerSecond,
      errorCount: entry.errorCount,
      recordedAt: new Date(entry.recordedAt),
    });
  }

  async query(pipelineId: string, since: Date): Promise<HealthMetricEntry[]> {
    const rows = await this.db
      .select()
      .from(cdcPipelineHealth)
      .where(
        and(
          eq(cdcPipelineHealth.pipelineId, pipelineId),
          gte(cdcPipelineHealth.recordedAt, since),
        ),
      );
    return rows
      .map((row) => ({
        pipelineId: row.pipelineId,
        replicationLagMs: row.replicationLagMs,
        eventsPerSecond: row.eventsPerSecond,
        errorCount: row.errorCount,
        recordedAt: row.recordedAt.toISOString(),
      }))
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  }

  async prune(before: Date): Promise<void> {
    await this.db
      .delete(cdcPipelineHealth)
      .where(lt(cdcPipelineHealth.recordedAt, before));
  }
}

/** Notification sink that records every notification in memory (for tests). */
export class InMemoryHealthNotificationSink implements HealthNotificationSink {
  readonly notifications: HealthNotification[] = [];

  notify(notification: HealthNotification): void {
    this.notifications.push(notification);
  }

  /** Convenience: all notifications of a given discriminated type. */
  notificationsOfType<T extends HealthNotification['type']>(
    type: T,
  ): Extract<HealthNotification, { type: T }>[] {
    return this.notifications.filter(
      (n): n is Extract<HealthNotification, { type: T }> => n.type === type,
    );
  }
}

/**
 * Default notification sink that routes notifications to the console using the
 * structured `[cdc/health-monitor]` pattern used across the CMS modules.
 */
export class ConsoleHealthNotificationSink implements HealthNotificationSink {
  notify(notification: HealthNotification): void {
    const prefix = '[cdc/health-monitor]';
    switch (notificationSeverity(notification)) {
      case 'critical':
        // eslint-disable-next-line no-console
        console.error(prefix, notification);
        break;
      case 'warning':
        // eslint-disable-next-line no-console
        console.warn(prefix, notification);
        break;
      default:
        // eslint-disable-next-line no-console
        console.info(prefix, notification);
        break;
    }
  }
}

/**
 * In-memory {@link PipelineStatusGateway} suitable as a default and test
 * double. Statuses default to `active` unless explicitly set.
 */
export class InMemoryPipelineStatusGateway implements PipelineStatusGateway {
  readonly statuses = new Map<string, PipelineStatus>();

  getStatus(pipelineId: string): PipelineStatus {
    return this.statuses.get(pipelineId) ?? 'active';
  }

  setStatus(pipelineId: string, status: PipelineStatus): void {
    this.statuses.set(pipelineId, status);
  }
}

/** Default {@link IntervalScheduler} backed by `setInterval`. */
const defaultIntervalScheduler: IntervalScheduler = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    // Don't keep the event loop alive solely for the emission timer.
    if (typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** Default {@link MonitorTimers} backed by `setTimeout`. */
const defaultMonitorTimers: MonitorTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    if (typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

// ── dependencies ───────────────────────────────────────────────────────────

export interface HealthMonitorDeps {
  /**
   * Resolves the metrics/health source (typically a {@link CdcConnector}) for
   * a pipeline. Required for {@link HealthMonitor.tick} and
   * {@link HealthMonitor.checkHealth} to obtain real data; if omitted, those
   * operations treat the source as unavailable.
   */
  readonly metricsSourceResolver?: HealthMetricsSourceResolver;
  /** Health history store. Defaults to {@link InMemoryHealthHistoryStore}. */
  readonly historyStore?: HealthHistoryStore;
  /** Notification sink. Defaults to {@link ConsoleHealthNotificationSink}. */
  readonly notificationSink?: HealthNotificationSink;
  /** Pipeline status gateway. Defaults to {@link InMemoryPipelineStatusGateway}. */
  readonly statusGateway?: PipelineStatusGateway;
  /** Interval scheduler. Defaults to a `setInterval`-backed scheduler. */
  readonly scheduler?: IntervalScheduler;
  /** One-shot timers (for metric-fetch timeouts). Defaults to `setTimeout`. */
  readonly timers?: MonitorTimers;
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  readonly clock?: () => number;
  /**
   * Per-service connectivity health-check timeout in ms (Req 8.5).
   * Defaults to {@link HEALTH_CHECK_TIMEOUT_MS}.
   */
  readonly healthCheckTimeoutMs?: number;
}

// ── per-pipeline runtime state ──────────────────────────────────────────

interface MonitorState {
  readonly config: MonitorConfig;
  /** Handle for the emission interval (scheduler-specific). */
  intervalHandle: unknown;
  /** Most recently observed pipeline status (for transition detection). */
  lastObservedStatus: PipelineStatus | null;
  /** Timestamp (ms) the pipeline entered the current error episode, if any. */
  errorSince: number | null;
  /** Whether an error_critical alert was emitted for the current episode. */
  errorAlertEmitted: boolean;
  /** Consecutive missed emission intervals (Req 8.7). */
  consecutiveMissed: number;
  /** Whether a missed_metrics_critical alert was emitted for this streak. */
  missedAlertEmitted: boolean;
  /** Guards against overlapping ticks for a single pipeline. */
  ticking: boolean;
}

// ── implementation ─────────────────────────────────────────────────────────

export class HealthMonitor {
  private readonly metricsSourceResolver: HealthMetricsSourceResolver;
  private readonly historyStore: HealthHistoryStore;
  private readonly notificationSink: HealthNotificationSink;
  private readonly statusGateway: PipelineStatusGateway;
  private readonly scheduler: IntervalScheduler;
  private readonly timers: MonitorTimers;
  private readonly clock: () => number;
  private readonly healthCheckTimeoutMs: number;

  private readonly states = new Map<string, MonitorState>();

  constructor(deps: HealthMonitorDeps = {}) {
    this.metricsSourceResolver = deps.metricsSourceResolver ?? (() => null);
    this.historyStore = deps.historyStore ?? new InMemoryHealthHistoryStore();
    this.notificationSink =
      deps.notificationSink ?? new ConsoleHealthNotificationSink();
    this.statusGateway =
      deps.statusGateway ?? new InMemoryPipelineStatusGateway();
    this.scheduler = deps.scheduler ?? defaultIntervalScheduler;
    this.timers = deps.timers ?? defaultMonitorTimers;
    this.clock = deps.clock ?? (() => Date.now());
    this.healthCheckTimeoutMs =
      deps.healthCheckTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  }

  // ── public API (design §4) ────────────────────────────────────────────

  /**
   * Begin monitoring a pipeline. Resolves and validates the (possibly partial)
   * monitor configuration, then schedules metrics emission every
   * `emitIntervalMs` (Req 8.1). Starting an already-monitored pipeline
   * restarts it with the new configuration.
   *
   * @throws ZodError if a provided config value is out of range (Req 8.2).
   */
  start(pipelineId: string, config: Partial<MonitorConfig> = {}): void {
    // Restart cleanly if already monitoring.
    this.stop(pipelineId);

    const resolved = resolveMonitorConfig(config);
    const state: MonitorState = {
      config: resolved,
      intervalHandle: undefined,
      lastObservedStatus: null,
      errorSince: null,
      errorAlertEmitted: false,
      consecutiveMissed: 0,
      missedAlertEmitted: false,
      ticking: false,
    };
    state.intervalHandle = this.scheduler.setInterval(() => {
      void this.tick(pipelineId);
    }, resolved.emitIntervalMs);

    this.states.set(pipelineId, state);
  }

  /** Stop monitoring a pipeline and release its emission timer. */
  stop(pipelineId: string): void {
    const state = this.states.get(pipelineId);
    if (!state) return;
    if (state.intervalHandle !== undefined) {
      this.scheduler.clearInterval(state.intervalHandle);
    }
    this.states.delete(pipelineId);
  }

  /**
   * Run a connectivity health check (Req 8.5): delegates to the resolved
   * source's `healthCheck`, which verifies each service (Source_Database,
   * ClickHouse_Sink, intermediary) with a per-service timeout and returns a
   * per-service reachable/unreachable status. The whole check is bounded by
   * {@link healthCheckTimeoutMs} as a safety net.
   *
   * @throws if no metrics source is registered for the pipeline.
   */
  async checkHealth(pipelineId: string): Promise<HealthCheckResult> {
    const source = this.metricsSourceResolver(pipelineId);
    if (!source) {
      throw new Error(
        `No metrics source registered for pipeline "${pipelineId}"`,
      );
    }
    return this.withTimeout(
      source.healthCheck(pipelineId),
      this.healthCheckTimeoutMs,
    );
  }

  /**
   * Return the retained health history for a pipeline recorded at or after
   * `since`, oldest first (Req 8.4).
   */
  async getHistory(pipelineId: string, since: Date): Promise<HealthMetricEntry[]> {
    return this.historyStore.query(pipelineId, since);
  }

  // ── status observation (Req 8.3, 8.6) ──────────────────────────────────

  /**
   * Observe the current status of a monitored pipeline. Detects an
   * error→active recovery and emits exactly one `recovery` notification per
   * transition (Req 8.6 / Property 21), and tracks the start of an error
   * episode so the 5-minute critical alert can fire (Req 8.3).
   *
   * Call this from the registry/orchestrator whenever a pipeline's status
   * changes, or rely on the periodic {@link tick} which observes the status
   * gateway each interval. No-op for pipelines that are not being monitored.
   */
  observeStatus(pipelineId: string, status: PipelineStatus): void {
    const state = this.states.get(pipelineId);
    if (!state) return;
    this.applyStatus(state, pipelineId, status);
  }

  /**
   * Run a single monitoring cycle for a pipeline: observe status, evaluate the
   * error-duration alert, then fetch and record metrics (emitting metric and
   * lag-threshold notifications) or account for a missed interval. The
   * scheduler invokes this every `emitIntervalMs`; tests may call it directly
   * for deterministic behaviour.
   */
  async tick(pipelineId: string): Promise<void> {
    const state = this.states.get(pipelineId);
    if (!state || state.ticking) return;
    state.ticking = true;
    try {
      const at = this.isoNow();

      // 1. Observe status (recovery detection + error-episode tracking).
      const status = await this.statusGateway.getStatus(pipelineId);
      this.applyStatus(state, pipelineId, status);

      // 2. Error-duration critical alert (Req 8.3) — independent of metrics.
      this.checkErrorDuration(state, pipelineId);

      // 3. Fetch metrics, bounded by the per-tick timeout.
      const source = this.metricsSourceResolver(pipelineId);
      let metrics: PipelineMetrics;
      try {
        if (!source) {
          throw new Error('no metrics source');
        }
        metrics = await this.withTimeout(
          source.getMetrics(pipelineId),
          state.config.emitIntervalMs,
        );
      } catch {
        // Missed emission interval (Req 8.7).
        await this.handleMissedInterval(state, pipelineId);
        return;
      }

      // 4. Successful emission — reset the missed-interval streak.
      state.consecutiveMissed = 0;
      state.missedAlertEmitted = false;

      // 5. Persist the sample (Req 8.1, 8.4) and emit the metrics notification.
      const entry: HealthMetricEntry = {
        pipelineId,
        replicationLagMs: metrics.replicationLagMs,
        eventsPerSecond: metrics.eventsPerSecond,
        errorCount: metrics.errorCount,
        recordedAt: metrics.collectedAt ?? at,
      };
      await this.historyStore.append(entry);
      this.notificationSink.notify({
        type: 'metrics',
        pipelineId,
        metrics,
        at,
      });

      // 6. Lag-threshold warning (Req 8.2 / Property 20).
      if (
        shouldEmitLagWarning(metrics.replicationLagMs, state.config.lagThresholdMs)
      ) {
        this.notificationSink.notify({
          type: 'lag_warning',
          pipelineId,
          lagMs: metrics.replicationLagMs,
          thresholdMs: state.config.lagThresholdMs,
          at,
        });
      }

      // 7. Prune history beyond the retention window (Req 8.4).
      await this.historyStore.prune(this.retentionCutoff(state));
    } finally {
      state.ticking = false;
    }
  }

  // ── introspection (tests / diagnostics) ────────────────────────────────

  /** Whether a pipeline is currently being monitored. */
  isMonitoring(pipelineId: string): boolean {
    return this.states.has(pipelineId);
  }

  /** Resolved monitor configuration for a monitored pipeline, if any. */
  getConfig(pipelineId: string): MonitorConfig | undefined {
    return this.states.get(pipelineId)?.config;
  }

  /** Identifiers of all currently-monitored pipelines. */
  getMonitoredPipelines(): string[] {
    return [...this.states.keys()];
  }

  /** Consecutive missed emission intervals for a pipeline (Req 8.7). */
  getConsecutiveMissed(pipelineId: string): number {
    return this.states.get(pipelineId)?.consecutiveMissed ?? 0;
  }

  // ── internals ────────────────────────────────────────────────────────

  /**
   * Apply an observed status to a pipeline's tracking state: emit a recovery
   * notification on error→active (Req 8.6), and open/close the error episode
   * window used by the 5-minute critical alert (Req 8.3).
   */
  private applyStatus(
    state: MonitorState,
    pipelineId: string,
    status: PipelineStatus,
  ): void {
    const previous = state.lastObservedStatus;

    if (isRecoveryTransition(previous, status)) {
      this.notificationSink.notify({
        type: 'recovery',
        pipelineId,
        at: this.isoNow(),
      });
    }

    if (status === 'error') {
      if (previous !== 'error') {
        // Entering a new error episode.
        state.errorSince = this.clock();
        state.errorAlertEmitted = false;
      }
    } else {
      // Left the error state — reset the episode window.
      state.errorSince = null;
      state.errorAlertEmitted = false;
    }

    state.lastObservedStatus = status;
  }

  /**
   * Emit a single critical alert once a pipeline has been in the error state
   * for more than 5 minutes (Req 8.3).
   */
  private checkErrorDuration(state: MonitorState, pipelineId: string): void {
    if (state.errorSince === null || state.errorAlertEmitted) return;
    const errorDurationMs = this.clock() - state.errorSince;
    if (errorDurationMs > ERROR_ALERT_THRESHOLD_MS) {
      state.errorAlertEmitted = true;
      this.notificationSink.notify({
        type: 'error_critical',
        pipelineId,
        errorDurationMs,
        at: this.isoNow(),
      });
    }
  }

  /**
   * Account for a missed emission interval. After
   * {@link MISSED_INTERVALS_LIMIT} consecutive misses (90s), drive the
   * pipeline to `error` status and emit a single critical alert (Req 8.7).
   */
  private async handleMissedInterval(
    state: MonitorState,
    pipelineId: string,
  ): Promise<void> {
    state.consecutiveMissed += 1;
    if (
      state.consecutiveMissed >= MISSED_INTERVALS_LIMIT &&
      !state.missedAlertEmitted
    ) {
      state.missedAlertEmitted = true;
      const missedIntervals = state.consecutiveMissed;
      await this.transitionTo(
        state,
        pipelineId,
        'error',
        `No health metrics emitted for ${missedIntervals} consecutive intervals`,
      );
      this.notificationSink.notify({
        type: 'missed_metrics_critical',
        pipelineId,
        missedIntervals,
        at: this.isoNow(),
      });
    }
  }

  /** Persist a status change and apply it to the tracking state. */
  private async transitionTo(
    state: MonitorState,
    pipelineId: string,
    status: PipelineStatus,
    message?: string,
  ): Promise<void> {
    await this.statusGateway.setStatus(pipelineId, status, message);
    this.applyStatus(state, pipelineId, status);
  }

  /** Retention cutoff: samples older than this are pruned (Req 8.4). */
  private retentionCutoff(state: MonitorState): Date {
    return new Date(this.clock() - state.config.retentionDays * MS_PER_DAY);
  }

  /** Current time as an ISO-8601 string, from the injectable clock. */
  private isoNow(): string {
    return new Date(this.clock()).toISOString();
  }

  /**
   * Resolve a promise within `ms`, rejecting with a timeout error otherwise.
   * Uses the injectable {@link MonitorTimers} so tests can drive timeouts
   * deterministically.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = this.timers.setTimeout(() => {
        reject(new Error(`operation timed out after ${ms}ms`));
      }, ms);
      promise.then(
        (value) => {
          this.timers.clearTimeout(handle);
          resolve(value);
        },
        (err) => {
          this.timers.clearTimeout(handle);
          reject(err);
        },
      );
    });
  }
}
