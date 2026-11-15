import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import {
  activationMilestones,
  agentGoals,
  agentRuns,
  collections,
  items,
  organizations,
  sites,
  telemetryState,
  type Database,
} from '@lumibase/database';
import { TelemetryEventSchema } from '@lumibase/contracts';
import type { AppEnv } from '../../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { ActivationService } from '../service';
import { deliverPathSiteId, resetDeliveryMarkMemory, withDeliveryMilestone } from '../delivery-mark';
import { runScheduledTelemetry } from '../telemetry';

/**
 * Activation milestones against real Postgres: derivation from the source
 * tables, write-once semantics, site isolation, the delivery mark, and one
 * full telemetry pass.
 */

const ORG = 'org_activation_it';
const SITE_A = 'site_activation_a';
const SITE_B = 'site_activation_b';
const CREATED_A = new Date('2026-10-01T08:00:00.000Z');
const ENDPOINT = 'https://collector.example.test/v1/events';

describe.skipIf(!hasDbIntegrationUrl)('activation milestones — DB integration', () => {
  let db: Database;

  const wipe = async () => {
    await db.delete(telemetryState);
    await db.delete(sites).where(inArray(sites.id, [SITE_A, SITE_B]));
    await db.delete(organizations).where(eq(organizations.id, ORG));
  };

  beforeAll(async () => {
    db = await connectDbIntegration('activation');
  });

  beforeEach(async () => {
    resetDeliveryMarkMemory();
    await wipe();
    await db.insert(organizations).values({ id: ORG, name: 'Activation IT', slug: 'activation-it' });
    await db.insert(sites).values([
      { id: SITE_A, organizationId: ORG, name: 'A', createdAt: CREATED_A },
      { id: SITE_B, organizationId: ORG, name: 'B', createdAt: new Date('2026-10-05T08:00:00.000Z') },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
  });

  const seedPublishedItem = async (siteId: string, updatedAt: Date) => {
    const [collection] = await db
      .insert(collections)
      .values({ siteId, name: `posts_${siteId}` })
      .returning({ id: collections.id });
    if (!collection) throw new Error('collection insert failed');
    const [item] = await db
      .insert(items)
      .values({ siteId, collectionId: collection.id, status: 'published', data: {}, updatedAt })
      .returning({ id: items.id });
    if (!item) throw new Error('item insert failed');
    return item.id;
  };

  const seedAgentRun = async (siteId: string, startedAt: Date) => {
    const [goal] = await db
      .insert(agentGoals)
      .values({ siteId, title: 'activation test goal' })
      .returning({ id: agentGoals.id });
    if (!goal) throw new Error('goal insert failed');
    await db.insert(agentRuns).values({ siteId, goalId: goal.id, status: 'succeeded', startedAt });
  };

  it('a fresh site has reached only site_created', async () => {
    const funnel = await new ActivationService({ db, siteId: SITE_A }).getFunnel();

    expect(funnel.reached).toBe(1);
    expect(funnel.total).toBe(4);
    expect(funnel.milestones.map((m) => m.key)).toEqual([
      'site_created',
      'item_published',
      'delivery_request',
      'agent_run',
    ]);
    expect(funnel.milestones[0]).toEqual({
      key: 'site_created',
      reachedAt: CREATED_A.toISOString(),
      source: 'derived',
      secondsSinceSiteCreated: 0,
    });
    expect(funnel.milestones.slice(1).every((m) => m.reachedAt === null && m.source === null)).toBe(true);
  });

  it('derives item_published and agent_run from the source tables, scoped to the site', async () => {
    await seedPublishedItem(SITE_A, new Date('2026-10-01T09:00:00.000Z'));
    await seedAgentRun(SITE_A, new Date('2026-10-02T08:00:00.000Z'));

    const a = await new ActivationService({ db, siteId: SITE_A }).getFunnel();
    const b = await new ActivationService({ db, siteId: SITE_B }).getFunnel();

    const byKey = Object.fromEntries(a.milestones.map((m) => [m.key, m]));
    expect(byKey.item_published?.secondsSinceSiteCreated).toBe(3600);
    expect(byKey.agent_run?.secondsSinceSiteCreated).toBe(86_400);
    expect(a.reached).toBe(3);
    // Site B has none of site A's rows.
    expect(b.reached).toBe(1);
  });

  it('a reached milestone stays reached after its source row is gone', async () => {
    const itemId = await seedPublishedItem(SITE_A, new Date('2026-10-01T09:00:00.000Z'));
    const service = new ActivationService({ db, siteId: SITE_A });
    const before = await service.getFunnel();

    await db.delete(items).where(eq(items.id, itemId));
    const after = await service.getFunnel();

    expect(after.milestones).toEqual(before.milestones);
  });

  it('record() is write-once', async () => {
    const service = new ActivationService({ db, siteId: SITE_A });
    await service.record('delivery_request', new Date('2026-10-03T08:00:00.000Z'));
    await service.record('delivery_request', new Date('2026-10-09T08:00:00.000Z'));

    const funnel = await service.getFunnel();
    const delivery = funnel.milestones.find((m) => m.key === 'delivery_request');
    expect(delivery).toMatchObject({ reachedAt: '2026-10-03T08:00:00.000Z', source: 'event' });
  });

  it('the delivery middleware marks only successful GETs, once per site', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('runtime', { cache: undefined } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    app.use('/api/v1/deliver/*', withDeliveryMilestone(deliverPathSiteId));
    app.get('/api/v1/deliver/page/:site_id/:slug', (c) =>
      c.req.param('slug') === 'home' ? c.json({ ok: true }) : c.json({ error: 'Page not found.' }, 404),
    );

    const rows = () =>
      db.select().from(activationMilestones).where(eq(activationMilestones.milestone, 'delivery_request'));

    await app.request(`/api/v1/deliver/page/${SITE_A}/missing`);
    expect(await rows()).toHaveLength(0);

    await app.request(`/api/v1/deliver/page/${SITE_A}/home`);
    await app.request(`/api/v1/deliver/page/${SITE_A}/home`);
    resetDeliveryMarkMemory(); // a second isolate with a cold memory
    await app.request(`/api/v1/deliver/page/${SITE_A}/home`);

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ siteId: SITE_A, source: 'event' });

    // A site that does not exist cannot be marked, and the read still succeeds.
    const ghost = await app.request('/api/v1/deliver/page/site_does_not_exist/home');
    expect(ghost.status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it('telemetry: no state row before opt-in; after opt-in each event goes out once', async () => {
    await seedPublishedItem(SITE_B, new Date('2026-10-06T09:00:00.000Z'));
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const base = { db, runtime: 'docker' as const, version: '2.0.0', fetch: fetchSpy };

    const off = await runScheduledTelemetry({ ...base, env: { LUMIBASE_TELEMETRY_ENDPOINT: ENDPOINT } });
    expect(off.active).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.select().from(telemetryState)).toHaveLength(0);

    const env = { LUMIBASE_TELEMETRY_ENABLED: 'true', LUMIBASE_TELEMETRY_ENDPOINT: ENDPOINT };
    const first = await runScheduledTelemetry({ ...base, env });
    // Other suites may share this database, so assert on what this one seeded.
    expect(first.sent).toEqual(expect.arrayContaining(['first_site_created', 'first_item_published']));
    expect(first.sent).not.toContain('first_delivery_request');

    const bodies = fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    for (const body of bodies) expect(() => TelemetryEventSchema.parse(body)).not.toThrow();
    const installIds = new Set(bodies.map((b) => b.installId));
    expect(installIds.size).toBe(1);
    // Nothing identifying this install's sites leaks into any request.
    const wire = JSON.stringify(fetchSpy.mock.calls.map(([url, init]) => [url, init?.headers, init?.body]));
    for (const secret of [SITE_A, SITE_B, ORG, 'Activation IT']) expect(wire).not.toContain(secret);

    const callsAfterFirst = fetchSpy.mock.calls.length;
    const second = await runScheduledTelemetry({ ...base, env });
    expect(second.sent.filter((e) => first.sent.includes(e))).toEqual([]);
    expect(fetchSpy.mock.calls.length - callsAfterFirst).toBe(second.sent.length);

    const [state] = await db.select().from(telemetryState);
    expect(state?.installId).toBe([...installIds][0]);
    expect(Object.keys(state?.sent ?? {})).toEqual(expect.arrayContaining(first.sent));
  });
});
