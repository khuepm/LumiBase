/**
 * Flow schedule runner — selects schedule-triggered flows whose `nextRunAt` is
 * due, enqueues them, and advances `nextRunAt` from their cron expression.
 *
 * Cron math is self-contained (standard 5-field: minute hour day-of-month month
 * day-of-week) so it works identically on Cloudflare Cron Triggers and the
 * Docker scheduled handler — the runtime only has to call `runDueScheduledFlows`
 * on a tick; no Node-only scheduler is required. See
 * `.kiro/specs/visual-flow-builder` (task 4).
 */

import { flows } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import type { QueueProvider } from '@lumibase/runtime';

export const FLOW_SCHEDULE_QUEUE = 'flow-schedule';

// ── Cron ───────────────────────────────────────────────────────────────────

const FIELD_BOUNDS: [min: number, max: number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

/** Parse one cron field into the set of matching values, or throw. */
function parseField(field: string, [min, max]: [number, number]): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart = '*', stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${part}`);
    let lo = min;
    let hi = max;
    if (rangePart !== '*') {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = b !== undefined ? Number(b) : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`Invalid cron range: ${part}`);
      }
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

/** Parse a 5-field cron expression; throws on malformed input. */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron must have 5 fields');
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, FIELD_BOUNDS[i]!));
  return { minute: minute!, hour: hour!, dom: dom!, month: month!, dow: dow! };
}

/** True when `expr` is a valid 5-field cron expression. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Next UTC time strictly after `from` that matches `expr`. Scans minute by
 * minute (bounded to ~4 years) — simple and correct for standard schedules.
 */
export function nextCron(expr: string, from: Date): Date {
  const spec = parseCron(expr);
  const d = new Date(from.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1); // strictly after `from`
  const limit = 366 * 24 * 60 * 4; // ~4 years of minutes
  for (let i = 0; i < limit; i++) {
    if (
      spec.minute.has(d.getUTCMinutes()) &&
      spec.hour.has(d.getUTCHours()) &&
      spec.month.has(d.getUTCMonth() + 1) &&
      spec.dom.has(d.getUTCDate()) &&
      spec.dow.has(d.getUTCDay())
    ) {
      return new Date(d.getTime());
    }
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error(`No cron match within horizon for "${expr}"`);
}

// ── Runner ───────────────────────────────────────────────────────────────────

export interface FlowScheduleJob {
  siteId: string;
  flowId: string;
}

export interface SchedulerDeps {
  db: Database;
  queue?: QueueProvider;
}

interface ScheduleTriggerOptions {
  cron?: string;
}

/**
 * Enqueue every active schedule flow whose `nextRunAt` is due, then advance
 * `nextRunAt` from its cron. Idempotent per tick: only rows whose `nextRunAt`
 * was `<= now` are picked up, and each is rescheduled before the next tick.
 * Returns the number of flows dispatched.
 */
export async function runDueScheduledFlows(deps: SchedulerDeps, now = new Date()): Promise<number> {
  const due = await deps.db
    .select({ id: flows.id, siteId: flows.siteId, triggerOptions: flows.triggerOptions })
    .from(flows)
    .where(
      and(
        eq(flows.status, 'active'),
        eq(flows.triggerType, 'schedule'),
        isNotNull(flows.nextRunAt),
        lte(flows.nextRunAt, now),
      ),
    );

  let dispatched = 0;
  for (const flow of due) {
    const opts = (flow.triggerOptions ?? {}) as ScheduleTriggerOptions;
    // Advance the schedule first so a slow/failed enqueue can't wedge the flow
    // on a permanently-due nextRunAt (which would re-fire every tick).
    let next: Date | null = null;
    if (opts.cron && isValidCron(opts.cron)) {
      next = nextCron(opts.cron, now);
    }
    await deps.db
      .update(flows)
      .set({ nextRunAt: next })
      .where(and(eq(flows.id, flow.id), eq(flows.siteId, flow.siteId)));

    if (!deps.queue) continue;
    try {
      const job: FlowScheduleJob = { siteId: flow.siteId, flowId: flow.id };
      await deps.queue.enqueue(FLOW_SCHEDULE_QUEUE, 'run-scheduled-flow', job);
      dispatched += 1;
    } catch (err) {
      console.error('[flow-scheduler] enqueue failed', {
        flowId: flow.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return dispatched;
}
