import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { flows, sites, type Database } from '@lumibase/database';
import { runDueScheduledFlows } from '../flow-scheduler';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Conditional `next_run_at` advance on Postgres (B128). Docker sweeps from two
 * leader-locked crons with different locks and Workers has no lock, so a sweep
 * can act on a row another sweep has already advanced. Only the sweep whose
 * UPDATE still finds the flow due may enqueue it.
 */

const SITE = 'site_flow_scheduler_it';

describe.skipIf(!hasDbIntegrationUrl)('Schedule-flow sweep — DB integration (B128)', () => {
  let db: Database;
  let flowId: string;
  const now = new Date();

  beforeAll(async () => {
    db = await connectDbIntegration('flow-scheduler');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Flow scheduler IT' });
    const [flow] = await db
      .insert(flows)
      .values({
        siteId: SITE,
        name: 'every minute',
        status: 'active',
        triggerType: 'schedule',
        triggerOptions: { cron: '* * * * *' },
        graph: { entry: 'a', nodes: [{ id: 'a', key: 'log', options: {} }] },
        nextRunAt: new Date(now.getTime() - 60_000),
      })
      .returning({ id: flows.id });
    flowId = flow!.id;
  });

  const queue = () => ({ enqueue: vi.fn(async () => 'job'), process: vi.fn(), getStatus: vi.fn(), supportsQueue: () => true });
  const ours = (q: ReturnType<typeof queue>) =>
    q.enqueue.mock.calls.filter((call) => (call as unknown[])[2] && ((call as unknown[])[2] as { flowId: string }).flowId === flowId);

  it('a sweep that read the row before another sweep advanced it does not enqueue it again', async () => {
    // What a concurrent sweep read before the first one committed.
    const stale = await db.select().from(flows).where(eq(flows.siteId, SITE));
    const first = queue();
    await runDueScheduledFlows({ db, queue: first }, now);
    expect(ours(first)).toHaveLength(1);

    // Same instant, stale read, real UPDATE.
    const staleDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select') return () => ({ from: () => ({ where: async () => stale }) });
        return Reflect.get(target, prop, receiver);
      },
    });
    const second = queue();
    await runDueScheduledFlows({ db: staleDb, queue: second }, now);
    expect(ours(second)).toHaveLength(0);

    const [row] = await db.select().from(flows).where(eq(flows.id, flowId));
    expect(row!.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  // Timing-dependent: the two sweeps may also run one after the other. The
  // stale-read case above is the deterministic proof (it fails without the
  // conditional advance); this one guards the end state.
  it('two concurrent sweeps enqueue the due flow once', async () => {
    const a = queue();
    const b = queue();
    await Promise.all([runDueScheduledFlows({ db, queue: a }, now), runDueScheduledFlows({ db, queue: b }, now)]);
    expect(ours(a).length + ours(b).length).toBe(1);
  });

  it('the next due minute is enqueued again', async () => {
    const q = queue();
    await runDueScheduledFlows({ db, queue: q }, now);
    await runDueScheduledFlows({ db, queue: q }, new Date(now.getTime() + 120_000));
    expect(ours(q)).toHaveLength(2);
  });
});
