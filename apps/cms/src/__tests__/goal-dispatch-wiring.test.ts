import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GoalDispatchService,
  runGoalDispatchTick,
} from '../services/goal-dispatch-service';

/**
 * Regression guard for the "written but never wired" class (#455).
 *
 * ## Background
 *
 * `ReconcilerService` created reconciler goals and flipped drifts to `assigned`.
 * Nothing executed them: no cron, no queue consumer, no route. The only
 * `agent-runs` enqueue in the codebase belonged to the human-triggered
 * `POST /agent/goals`. Measured before the fix: one reconcile plus three further
 * cycles left `agent_runs` empty and the drift `assigned` forever — and because
 * `planReconciliation` skips drifts that already carry a `goalId`, that goal
 * *locked* the drift out of every later cycle.
 *
 * This is the same shape as `B9` (nav item with no route), `B10` (queue producer
 * with no Cloudflare consumer) and the `CacheInvalidator` that was written and
 * never called: the unit is correct in isolation and unreachable in production.
 * Unit tests on `GoalDispatchService` cannot catch it, because the service being
 * right is not the failure mode — not being called is.
 *
 * So the wiring itself is asserted here, by source scan, the same way
 * `ai-harness-keys-context.test.ts` and `security-guards.wiring.test.ts` do.
 *
 * **Validates: #455 acceptance — a reconciler goal produces a traceable run
 * rather than only an assigned drift row**
 */

const SRC = join(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8');
}

describe('reconciler goal dispatch is wired, not merely implemented', () => {
  it('the Node/Docker entrypoint schedules the dispatch tick', () => {
    const serve = read('serve.ts');
    expect(serve).toContain('runGoalDispatchTick');
    expect(serve).toContain("'goal-dispatch'");
  });

  it('the dispatch tick runs under the leader lock', () => {
    // Two processes dispatching the same goal would create two runs for one
    // drift, which is exactly the duplicated side effect the loop must avoid.
    const serve = read('serve.ts');
    const tick = serve.slice(serve.indexOf('runGoalDispatchTick'));
    const registration = tick.slice(0, tick.indexOf('deployment-poll'));
    expect(registration).toContain('leaderLockedCallback');
  });

  it('the dispatch tick is stopped on SIGTERM like every other cron task', () => {
    expect(read('serve.ts')).toContain('goalDispatchTask?.stop()');
  });

  it('the manual reconcile endpoint dispatches instead of stopping at goal creation', () => {
    // `POST /intents/:id/scan` is the human-facing cycle. Leaving it at
    // scan+reconcile is what made a "successful" cycle response describe work
    // that never happened.
    const intents = read('routes/intents.ts');
    expect(intents).toContain('GoalDispatchService');
    const scanHandler = intents.slice(
      intents.indexOf("intentsRouter.post('/:id/scan'"),
      intents.indexOf("intentsRouter.post('/compile'"),
    );
    expect(scanHandler).toContain('dispatchReconcilerGoals');
  });

  it('the worker forwards the governance envelope it was given', () => {
    // Dropping any of these silently moves enforcement out of execution: the cap
    // would be recorded on the payload and ignored by the resolver.
    const worker = read('services/agent-run-worker.ts');
    const executeCall = worker.slice(worker.indexOf('await harness.execute('));
    for (const field of ['origin', 'intentId', 'autonomyCap', 'agentRole']) {
      expect(executeCall).toContain(`payload.${field}`);
    }
  });

  it('exposes both the per-site service and the multi-tenant tick', () => {
    expect(typeof runGoalDispatchTick).toBe('function');
    expect(typeof GoalDispatchService.prototype.dispatchReconcilerGoals).toBe('function');
  });

  it('documents that async runs remain Node/Docker-only', () => {
    // `cloudflare.ts` has no `queue()` consumer export (backlog B10), so a
    // Cloudflare deployment enqueues nothing and dispatch is a no-op there. The
    // limit is stated in the worker rather than implied by its absence.
    expect(read('services/agent-run-worker.ts')).toMatch(/Cloudflare Workers/);
    expect(read('cloudflare.ts')).not.toMatch(/^\s*async queue\(/m);
  });
});
