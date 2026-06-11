import {
  agentBackpressureActivationsTotal,
  agentWriteBudgetDenialsTotal,
} from './agent-metrics';

/**
 * Load Guard — load-aware autonomy (Content OS task 9).
 *
 * A system that generates load must also sense load. The guard bounds
 * agent-originated work three ways:
 *
 * 1. **Write coalescing** (Req 9.1): item writes inside one tool call defer
 *    their expensive invalidation work (materialized-view refresh, tag
 *    revalidation) and flush once per collection at the tool-call boundary.
 * 2. **Write rate budget** (Req 9.3): per-intent `maxWritesPerMinute` is a
 *    sliding-window limit; an exhausted budget defers the tool call at the
 *    boundary (the run is not failed — it retries when quota returns).
 * 3. **Backpressure** (Req 9.4/9.5): runtime overload signals (event-loop
 *    pressure, anomaly thresholds) pause reconciler-origin runs only —
 *    human-triggered work is never auto-paused — and auto-resume after a
 *    hold-down period of continuous calm.
 *
 * All decision logic is in pure classes so it can be property-tested.
 */

// ---------------------------------------------------------------------------
// Write coalescing (Property 9)
// ---------------------------------------------------------------------------

/**
 * Collects collections written during one coalescing window. N writes to the
 * same collection flush exactly one invalidation.
 */
export class WriteCoalescer {
  private pending = new Set<string>();

  /** Returns true on the first write for this collection in the window. */
  record(collection: string): boolean {
    if (this.pending.has(collection)) return false;
    this.pending.add(collection);
    return true;
  }

  /** Unique collections written since the last flush; clears the window. */
  flush(): string[] {
    const collections = [...this.pending];
    this.pending.clear();
    return collections;
  }

  get size(): number {
    return this.pending.size;
  }
}

// ---------------------------------------------------------------------------
// Write rate budget (sliding window)
// ---------------------------------------------------------------------------

export interface WriteBudgetCheck {
  allowed: boolean;
  /** When denied: how long until the oldest write leaves the window. */
  retryAfterMs: number;
}

const WINDOW_MS = 60_000;

/** Sliding-window writes/minute limiter keyed by caller-chosen scope. */
export class WriteRateLimiter {
  private windows = new Map<string, number[]>();

  tryConsume(key: string, maxWritesPerMinute: number, now = Date.now()): WriteBudgetCheck {
    const limit = Math.max(1, Math.trunc(maxWritesPerMinute));
    const cutoff = now - WINDOW_MS;
    const timestamps = (this.windows.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= limit) {
      this.windows.set(key, timestamps);
      return { allowed: false, retryAfterMs: Math.max(0, timestamps[0]! + WINDOW_MS - now) };
    }
    timestamps.push(now);
    this.windows.set(key, timestamps);
    return { allowed: true, retryAfterMs: 0 };
  }
}

// ---------------------------------------------------------------------------
// Maintenance window (Req 9.2)
// ---------------------------------------------------------------------------

export interface MaintenanceWindow {
  tz: string;
  windows: Array<{ dow: number; start: string; end: string }>;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(date: Date, tz: string): { dow: number; minutes: number } {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => formatted.find((p) => p.type === type)?.value ?? '';
  // `hour12: false` can yield "24" at midnight in some ICU versions.
  const hour = Number(get('hour')) % 24;
  return {
    dow: WEEKDAYS[get('weekday')] ?? 0,
    minutes: hour * 60 + Number(get('minute')),
  };
}

/**
 * True when `date` falls inside the declared window (or no window declared).
 * Overnight windows (end < start) span into the following day. An invalid
 * timezone fails open — a typo must not silently freeze reconciliation.
 */
export function isWithinMaintenanceWindow(
  window: MaintenanceWindow | null | undefined,
  date = new Date(),
): boolean {
  if (!window || window.windows.length === 0) return true;
  let parts: { dow: number; minutes: number };
  try {
    parts = localParts(date, window.tz);
  } catch {
    return true;
  }

  for (const slot of window.windows) {
    const start = minutesOf(slot.start);
    const end = minutesOf(slot.end);
    if (end >= start) {
      if (parts.dow === slot.dow && parts.minutes >= start && parts.minutes < end) return true;
    } else {
      // Overnight: [start, midnight) on slot.dow, [midnight, end) next day.
      if (parts.dow === slot.dow && parts.minutes >= start) return true;
      if (parts.dow === (slot.dow + 1) % 7 && parts.minutes < end) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Backpressure controller (Req 9.4/9.5)
// ---------------------------------------------------------------------------

export interface LoadSignal {
  overloaded: boolean;
  reason?: string | null;
}

export interface BackpressureOptions {
  /** Continuous calm required before resuming (Req 9.5). */
  holdDownMs?: number;
}

/**
 * normal → paused on an overload signal; paused → normal only after the
 * load has stayed below threshold for the whole hold-down period.
 */
export class BackpressureController {
  private paused = false;
  private calmSince: number | null = null;
  private activationCounter = 0;
  private readonly holdDownMs: number;

  constructor(options: BackpressureOptions = {}) {
    this.holdDownMs = Math.max(0, options.holdDownMs ?? 60_000);
  }

  signal(input: LoadSignal, now = Date.now()): void {
    if (input.overloaded) {
      this.calmSince = null;
      if (!this.paused) {
        this.paused = true;
        this.activationCounter += 1;
        agentBackpressureActivationsTotal.inc({ reason: input.reason ?? 'overload' });
      }
      return;
    }
    if (!this.paused) return;
    if (this.calmSince === null) {
      this.calmSince = now;
      return;
    }
    if (now - this.calmSince >= this.holdDownMs) {
      this.paused = false;
      this.calmSince = null;
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Monotonic id of the current/last activation (for incident dedupe). */
  get activationId(): number {
    return this.activationCounter;
  }
}

// ---------------------------------------------------------------------------
// Service facade
// ---------------------------------------------------------------------------

export class LoadGuardService {
  readonly backpressure: BackpressureController;
  private readonly rateLimiter = new WriteRateLimiter();
  /** `${siteId}:${activationId}` incidents already recorded. */
  private readonly incidentsRecorded = new Set<string>();

  constructor(options: BackpressureOptions = {}) {
    this.backpressure = new BackpressureController(options);
  }

  /** Feed a runtime load sample (pressure limiter, anomaly thresholds…). */
  signal(input: LoadSignal, now = Date.now()): void {
    this.backpressure.signal(input, now);
  }

  /** Reconciler-origin work pauses under backpressure; human work never does. */
  shouldPause(origin: string | undefined): boolean {
    return origin === 'reconciler' && this.backpressure.isPaused();
  }

  /**
   * True exactly once per (site, activation) — callers record the incident
   * when this returns true (Req 9.4).
   */
  markIncidentOnce(siteId: string): boolean {
    const key = `${siteId}:${this.backpressure.activationId}`;
    if (this.incidentsRecorded.has(key)) return false;
    this.incidentsRecorded.add(key);
    return true;
  }

  tryConsumeWrite(key: string, maxWritesPerMinute: number, now = Date.now()): WriteBudgetCheck {
    const check = this.rateLimiter.tryConsume(key, maxWritesPerMinute, now);
    if (!check.allowed) {
      agentWriteBudgetDenialsTotal.inc();
    }
    return check;
  }
}

/**
 * Process-wide guard instance. Per-isolate on Cloudflare Workers; the Node
 * entrypoint feeds it pressure-limiter samples on an interval.
 */
let globalGuard: LoadGuardService | null = null;

export function getLoadGuard(): LoadGuardService {
  if (!globalGuard) {
    globalGuard = new LoadGuardService();
  }
  return globalGuard;
}

/** Test hook: replace/reset the process-wide guard. */
export function setLoadGuard(guard: LoadGuardService | null): void {
  globalGuard = guard;
}
