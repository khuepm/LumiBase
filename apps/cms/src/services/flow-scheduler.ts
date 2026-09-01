import { flows, type Database } from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/contracts/utils';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { FLOW_EVENTS_QUEUE, type FlowEventJob } from './flow-dispatch';

/**
 * Scheduled flow runner (visual-flow-builder Req 2).
 *
 * Active `schedule` flows carry a cron expression in `triggerOptions.cron` and
 * their next due time in `flows.next_run_at` (indexed). Each scheduler tick
 * calls `runDueScheduledFlows`, which enqueues due flows on the same
 * `flow-events` queue the event trigger uses (one consumer, one execution
 * path) and advances `next_run_at` — advancing BEFORE the run executes keeps
 * the sweep idempotent: a second tick in the same minute finds nothing due.
 *
 * The cron helper supports standard 5-field expressions (minute hour
 * day-of-month month day-of-week) with wildcards, lists, ranges and step
 * values (slash syntax) — deliberately no seconds field and no named aliases,
 * mirroring node-cron's core syntax without pulling in a parser dependency.
 */

// ── Cron (5-field) ───────────────────────────────────────────────────────────

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

/** Parse one cron field into the set of matching values, or null when invalid. */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (rangePart === '*' || rangePart === '') {
      lo = min;
      hi = max;
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      lo = a!;
      hi = b!;
    } else {
      const v = Number(rangePart);
      if (!Number.isInteger(v)) return null;
      lo = v;
      hi = stepPart === undefined ? v : max;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domIsWildcard: boolean;
  dowIsWildcard: boolean;
}

function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = fields.map((f, i) => parseField(f, FIELD_RANGES[i]![0], FIELD_RANGES[i]![1]));
  if (sets.some((s) => s === null)) return null;
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dayOfMonth: sets[2]!,
    month: sets[3]!,
    dayOfWeek: sets[4]!,
    domIsWildcard: fields[2] === '*',
    dowIsWildcard: fields[4] === '*',
  };
}

/** True when `expr` is a valid 5-field cron expression. */
export function isValidCron(expr: unknown): expr is string {
  return typeof expr === 'string' && parseCron(expr) !== null;
}

/**
 * Next occurrence strictly after `from` (UTC), or null when the expression is
 * invalid / matches nothing within 366 days. Standard cron semantics: when
 * both day-of-month and day-of-week are restricted, either matching suffices.
 */
export function nextCronRun(expr: string, from: Date): Date | null {
  const spec = parseCron(expr);
  if (!spec) return null;

  const t = new Date(from);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);

  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (t <= limit) {
    const domMatch = spec.dayOfMonth.has(t.getUTCDate());
    const dowMatch = spec.dayOfWeek.has(t.getUTCDay());
    const dayMatch =
      spec.domIsWildcard && spec.dowIsWildcard
        ? true
        : spec.domIsWildcard
          ? dowMatch
          : spec.dowIsWildcard
            ? domMatch
            : domMatch || dowMatch;
    if (spec.month.has(t.getUTCMonth() + 1) && dayMatch && spec.hour.has(t.getUTCHours())) {
      if (spec.minute.has(t.getUTCMinutes())) return t;
      t.setUTCMinutes(t.getUTCMinutes() + 1);
      continue;
    }
    // Day/hour mismatch — jump to the next hour boundary to keep the scan cheap.
    t.setUTCMinutes(60, 0);
  }
  return null;
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export interface FlowSchedulerDeps {
  db: Database;
  queue?: QueueProvider;
}

/**
 * Enqueue every active scheduled flow whose `next_run_at` is due and advance
 * its `next_run_at`. Returns the number of flows enqueued. Per-flow failures
 * are logged and skipped so one broken flow cannot stall the sweep.
 */
export async function runDueScheduledFlows(deps: FlowSchedulerDeps, now = new Date()): Promise<number> {
  const { db, queue } = deps;
  if (!queue) return 0;

  const due = await db
    .select()
    .from(flows)
    .where(
      and(
        eq(flows.status, 'active'),
        eq(flows.triggerType, 'schedule'),
        isNotNull(flows.nextRunAt),
        lte(flows.nextRunAt, now),
      ),
    );

  let enqueued = 0;
  for (const flow of due) {
    try {
      const cron = (flow.triggerOptions as { cron?: string } | null)?.cron;
      // Advance next_run_at first (idempotency guard); invalid/missing cron →
      // clear it so the flow stops being swept instead of firing every tick.
      const next = cron ? nextCronRun(cron, now) : null;
      await db
        .update(flows)
        .set({ nextRunAt: next, updatedAt: new Date() })
        .where(and(eq(flows.id, flow.id), eq(flows.siteId, flow.siteId)));

      await queue.enqueue<FlowEventJob>(FLOW_EVENTS_QUEUE, 'flow:scheduled', {
        siteId: flow.siteId,
        flowId: flow.id,
        input: { trigger: 'schedule', scheduledAt: now.toISOString() },
      });
      enqueued += 1;
    } catch (err) {
      console.error('[flow-scheduler] enqueue failed', { flowId: flow.id, err: formatSafeError(err) });
    }
  }
  return enqueued;
}
