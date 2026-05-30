/**
 * Shared scheduled-rotation glue for the AuditRotator
 * (admin-setup-wizard task 11.4; Req 15.5; design §10.2).
 *
 * Task 11.3 built the {@link AuditRotator} (the *what* — the two-table
 * retention prune). Task 11.4 is the *when/where*: actually firing
 * `rotate()` on a schedule. The two supported deployment runtimes have
 * fundamentally different scheduling primitives, so the cron wiring is
 * NECESSARILY split per runtime:
 *
 *   • Self-hosted Node (`serve.ts`, the esbuild `build:node` target):
 *     a long-lived process, so we schedule with `node-cron` at
 *     `0 * * * *` (hourly). `node-cron` is a **Node-only** dependency —
 *     it pulls in Node timers/`child_process`-ish internals that don't
 *     exist on the Workers isolate — so it is imported ONLY from
 *     `serve.ts` and MUST NOT leak into the Workers bundle.
 *
 *   • Cloudflare Workers (`cloudflare.ts`, the `wrangler deploy` target):
 *     isolates are not long-lived, so there's no in-process timer to
 *     hang a cron on. Instead Cloudflare **Cron Triggers** (configured
 *     via `[triggers] crons = ["0 * * * *"]` in `wrangler.toml`) invoke
 *     the Worker's `scheduled(controller, env, ctx)` handler on the
 *     same hourly cadence.
 *
 * Both paths converge on the SAME work: build a Drizzle `db`, construct
 * an {@link AuditRotator}, and call `rotate()`. This module is that
 * shared convergence point so the two entrypoints stay DRY and the
 * wiring is unit-testable without standing up either runtime.
 *
 * ── Why a thin wrapper and not just `new AuditRotator(db).rotate()` ──
 *
 * `rotate()` is already best-effort and never throws (task 11.3), but
 * the *callers* differ in how they want the result surfaced:
 *   - the Node cron callback wants a one-line log of the pruned count;
 *   - the Workers `scheduled` handler wants the same log AND a promise
 *     to feed `ctx.waitUntil(...)` so the isolate stays alive until the
 *     prune finishes.
 * {@link runScheduledRotation} gives both a single promise that logs
 * the count and, defensively, swallows anything `rotate()` might ever
 * throw in the future — so neither a cron tick nor a `scheduled`
 * invocation can ever reject.
 *
 * **Validates: Requirements 15.5**
 *
 * References: requirements §15.5; design.md §10.2.
 */

import type { Database } from '@lumibase/database';
import { AuditRotator, type RotateResult } from './rotator';

/** Log prefix shared with the rest of the CMS runtime logs. */
const LOG_PREFIX = '[lumibase-cms]';

/**
 * Construct the {@link AuditRotator} both entrypoints use.
 *
 * Kept as a one-liner factory so the construction lives in exactly one
 * place: if the rotator ever needs extra wiring (an injected clock, a
 * pre-resolved `retentionDays`), it changes here and both runtimes pick
 * it up. The rotator self-resolves `LUMIBASE_AUDIT_RETENTION_DAYS` from
 * the ambient env defensively (see `rotator.ts`), so no env plumbing is
 * required from the caller.
 */
export function buildAuditRotator(db: Database): AuditRotator {
  return new AuditRotator({ db });
}

/**
 * Run one audit-log retention prune and log the outcome. Designed to be
 * the body of a `node-cron` tick (self-hosted Node) and of the
 * Cloudflare `scheduled` handler (Workers).
 *
 * NEVER throws: `AuditRotator.rotate()` is already best-effort, but we
 * wrap defensively so a future change can't turn a cron tick or a
 * `scheduled` invocation into an unhandled rejection. On the (currently
 * unreachable) error path it logs and resolves to `{ deleted: 0 }`.
 *
 * @param db    a Drizzle client. On Node this is built from the runtime
 *              connection; on Workers from the Hyperdrive binding.
 * @param log   injectable logger (defaults to `console`) so the test can
 *              assert the pruned-count line without capturing stdout.
 * @returns the {@link RotateResult} from the prune.
 */
export async function runScheduledRotation(
  db: Database,
  log: Pick<Console, 'log' | 'error'> = console,
): Promise<RotateResult> {
  try {
    const result = await buildAuditRotator(db).rotate();
    log.log(`${LOG_PREFIX} audit rotation pruned ${result.deleted} rows`);
    return result;
  } catch (err) {
    // Defensive only — rotate() does not throw today (task 11.3).
    log.error(`${LOG_PREFIX} audit rotation failed unexpectedly`, err);
    return { deleted: 0 };
  }
}
