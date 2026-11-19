import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { agentRoles, aiApprovals, collections, items, pages, sites, users, type Database } from '@lumibase/database';
import { MemoryCacheProvider, type EdgeCacheProvider } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import { AISecureHarness } from '../services/ai-harness';
import { ItemService } from '../services/item-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { assignArm } from '../modules/experiments/stats';

vi.mock('../middleware/site-admin', () => ({
  requireSiteAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  isSiteAdmin: async () => true,
}));

const SITE = 'site_exp_it';
const ADMIN = 'usr_exp_it_admin';
/** Approval provenance: the requester whose current rights are re-checked on approval. */
const REQUESTER_ROLE = 'exp-it-requester';
const REQUESTER = { kind: 'agentRole', role: REQUESTER_ROLE } as const;
let db: Database;
const cache = new MemoryCacheProvider();

/** The promote route parks through the real harness, built for this site. */
const harness = () => new AISecureHarness({ db, siteId: SITE, cache, itemService: new ItemService({ db, siteId: SITE }) });
vi.mock('../routes/ai', () => ({ buildAuthorizedHarness: async () => harness() }));
vi.mock('../services/governed-capabilities', async (orig) => ({
  ...(await orig<typeof import('../services/governed-capabilities')>()),
  resolveRequestCapabilities: async () => ({ capabilities: ['items:read', 'items:write'], controlPlaneAdmin: true }),
  approvalRequesterFromAuth: () => REQUESTER,
}));

const { deliverRouter } = await import('../routes/deliver');
const { experimentsRouter } = await import('../modules/experiments/routes');
const { experimentEventsPublicRouter } = await import('../modules/experiments/beacon');

/**
 * A/B experiments end to end on real PostgreSQL (#763): the admin API,
 * deterministic arm assignment at delivery (consent-gated, one cached copy
 * per arm), the public event beacon, the Insights report, and promotion of
 * the winner only through an approval.
 */

function edge(): EdgeCacheProvider & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req: Request) {
      const hit = store.get(req.url);
      return hit ? hit.clone() : undefined;
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res.clone());
    },
    async purge(opts: { urls?: string[] }) {
      for (const u of opts.urls ?? []) store.delete(u);
      return (opts.urls ?? []).length;
    },
  } as EdgeCacheProvider & { store: Map<string, Response> };
}

/** Two visitor ids that land in different arms of `hero`. */
function visitorsFor(key: string, arms: Array<{ key: string; weight: number }>) {
  const out: Record<string, string> = {};
  for (let i = 0; Object.keys(out).length < arms.length && i < 1000; i += 1) {
    const v = `visitor-${i}-abc`;
    out[assignArm(key, v, arms)!] ??= v;
  }
  return out;
}

describe.skipIf(!hasDbIntegrationUrl)('experiments (real PostgreSQL)', () => {
  const edgeCache = edge();
  let pageId = '';
  let itemId = '';
  let expId = '';

  const app = () => {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      c.set('db', db as never);
      c.set('siteId', SITE);
      c.set('auth', { userId: ADMIN, roles: ['admin'], raw: {} } as AppEnv['Variables']['auth']);
      c.set('runtime', { cache, edgeCache } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    a.route('/api/v1/deliver', deliverRouter);
    a.route('/api/v1/experiments', experimentsRouter);
    a.route('/api/v1/experiment-events', experimentEventsPublicRouter);
    return a;
  };
  const admin = (path: string, method: string, body?: unknown) =>
    app().request(`/api/v1/experiments${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const deliver = (headers: Record<string, string> = {}) =>
    app().request(`https://cms.example/api/v1/deliver/page/${SITE}/home`, { headers });
  const beacon = (events: unknown[], headers: Record<string, string> = { 'X-Lumi-Consent': 'analytics' }) =>
    app().request(`/api/v1/experiment-events/${SITE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0', ...headers },
      body: JSON.stringify({ events }),
    });
  type Payload = { page: { title: string }; sections: Array<{ data: { items: Array<{ title: string }> } }>; experiments?: Array<{ key: string; arm: string }> };

  beforeAll(async () => {
    db = await connectDbIntegration('experiments');
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: SITE, name: SITE });
    await db.insert(users).values({ id: ADMIN, email: 'exp-it@example.dev' }).onConflictDoNothing();
    await db.insert(agentRoles).values({ siteId: SITE, name: REQUESTER_ROLE, description: 'Experiment requester fixture', capabilities: ['items:read', 'items:write'] }).onConflictDoNothing();
    const [col] = await db.insert(collections).values({ siteId: SITE, name: 'posts' }).returning();
    const [it] = await db.insert(items).values({ siteId: SITE, collectionId: col!.id, status: 'published', data: { title: 'Hello' } }).returning();
    itemId = it!.id;
    const [pg] = await db
      .insert(pages)
      .values({ siteId: SITE, slug: 'home', title: 'Home', layoutConfig: { sections: [{ id: 's1', component: 'list', source: { collection: 'posts' } }] } })
      .returning();
    pageId = pg!.id;
  });

  afterAll(async () => {
    if (db) await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  it('admin API validates experiments and their arms', async () => {
    const base = { key: 'hero', name: 'Hero headline', subjectType: 'page', subjectId: pageId, goal: 'signup', minSampleSize: 10 };
    expect((await admin('', 'POST', { ...base, arms: [{ key: 'b', overrides: { title: 'x' } }, { key: 'c', overrides: { title: 'y' } }] })).status).toBe(400); // no control
    expect((await admin('', 'POST', { ...base, arms: [{ key: 'control', overrides: { title: 'x' } }, { key: 'b', overrides: { title: 'y' } }] })).status).toBe(400); // control with overrides
    expect((await admin('', 'POST', { ...base, arms: [{ key: 'control' }, { key: 'b', overrides: { nope: 1 } }] })).status).toBe(400); // not a page override
    expect((await admin('', 'POST', { ...base, subjectId: 'nope', arms: [{ key: 'control' }, { key: 'b', overrides: { title: 'y' } }] })).status).toBe(404);
    const created = await admin('', 'POST', { ...base, arms: [{ key: 'control', weight: 50 }, { key: 'b', weight: 50, overrides: { title: 'Ship faster' } }] });
    expect(created.status).toBe(201);
    expId = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await admin('', 'POST', { ...base, arms: [{ key: 'control' }, { key: 'b', overrides: { title: 'y' } }] })).status).toBe(409);
    // Item experiment on the same site, for the "one at a time" checks below.
    const itemExp = await admin('', 'POST', { key: 'cta', name: 'CTA', subjectType: 'item', subjectId: itemId, goal: 'click', arms: [{ key: 'control' }, { key: 'b', overrides: { title: 'Item B' } }] });
    expect(itemExp.status).toBe(201);
  });

  it('a draft experiment changes nothing; a running one splits traffic per visitor, keyed per arm', async () => {
    const before = (await (await deliver({ 'X-Lumi-Consent': 'analytics', 'X-Lumi-Visitor': 'visitor-0-abc' })).json()) as Payload;
    expect(before.page.title).toBe('Home');
    expect(before.experiments).toBeUndefined();

    expect((await admin(`/${expId}/start`, 'POST')).status).toBe(200);
    expect((await admin(`/${expId}/start`, 'POST')).status).toBe(409);
    expect((await admin(`/${expId}`, 'PATCH', { arms: [{ key: 'control' }, { key: 'b', overrides: { title: 'z' } }] })).status).toBe(409);

    const v = visitorsFor('hero', [{ key: 'b', weight: 50 }, { key: 'control', weight: 50 }]);
    const asB = await deliver({ 'X-Lumi-Consent': 'analytics', 'X-Lumi-Visitor': v.b! });
    const bodyB = (await asB.json()) as Payload;
    expect(bodyB.page.title).toBe('Ship faster');
    expect(bodyB.experiments).toEqual([{ key: 'hero', arm: 'b' }]);
    expect(asB.headers.get('x-lumi-experiments')).toBe('hero=b');
    expect(asB.headers.get('vary')).toContain('X-Lumi-Visitor');

    const asControl = await deliver({ 'X-Lumi-Consent': 'analytics', 'X-Lumi-Visitor': v.control! });
    const bodyC = (await asControl.json()) as Payload;
    expect(bodyC.page.title).toBe('Home');
    expect(bodyC.experiments).toEqual([{ key: 'hero', arm: 'control' }]);

    // Same visitor, same arm, served from the edge copy of that arm.
    const again = await deliver({ 'X-Lumi-Consent': 'analytics', 'X-Lumi-Visitor': v.b! });
    expect(((await again.json()) as Payload).page.title).toBe('Ship faster');
    expect(again.headers.get('x-lumi-experiments')).toBe('hero=b');

    // No consent: control content, not in the experiment, its own cache copy.
    const anon = await deliver({ 'X-Lumi-Visitor': v.b! });
    const anonBody = (await anon.json()) as Payload;
    expect(anonBody.page.title).toBe('Home');
    expect(anonBody.experiments).toBeUndefined();
    expect(anon.headers.get('x-lumi-experiments')).toBeNull();

    const tokens = [...edgeCache.store.keys()].map((u) => new URL(u).searchParams.get('__exp')).filter(Boolean).sort();
    expect(tokens).toEqual(['hero:_', 'hero:b', 'hero:control']);
    expect(new Set([asB, asControl, anon].map((r) => r.headers.get('etag'))).size).toBe(3);
  });

  it('only one experiment runs per subject', async () => {
    const list = ((await (await admin('?status=draft', 'GET')).json()) as { data: Array<{ id: string; key: string }> }).data;
    const cta = list.find((e) => e.key === 'cta')!;
    const dup = await admin('', 'POST', { key: 'hero-2', name: 'Again', subjectType: 'page', subjectId: pageId, goal: 'signup', arms: [{ key: 'control' }, { key: 'b', overrides: { title: 'q' } }] });
    const dupId = ((await dup.json()) as { data: { id: string } }).data.id;
    const busy = await admin(`/${dupId}/start`, 'POST');
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('SUBJECT_BUSY');
    expect((await admin(`/${dupId}`, 'DELETE')).status).toBe(200);
    expect((await admin(`/${cta.id}`, 'DELETE')).status).toBe(200);
  });

  it('the beacon counts exposures and conversions only with analytics consent, for running arms and the goal', async () => {
    const ok = await beacon([
      { experiment: 'hero', arm: 'b', kind: 'exposure' },
      { experiment: 'hero', arm: 'b', kind: 'conversion', goal: 'signup' },
      { experiment: 'hero', arm: 'control', kind: 'exposure' },
      { experiment: 'hero', arm: 'zzz', kind: 'exposure' }, // unknown arm
      { experiment: 'nope', arm: 'b', kind: 'exposure' }, // unknown experiment
      { experiment: 'hero', arm: 'b', kind: 'conversion', goal: 'other' }, // wrong goal
    ]);
    expect(ok.status).toBe(204);
    expect((await beacon([{ experiment: 'hero', arm: 'b', kind: 'exposure' }], {})).status).toBe(204); // no consent: dropped
    expect((await beacon([{ experiment: 'hero', arm: 'b', kind: 'exposure' }], { 'X-Lumi-Consent': 'analytics', 'Sec-GPC': '1' })).status).toBe(204);
    expect((await beacon([{ experiment: 'hero', arm: 'b', kind: 'bounce' }])).status).toBe(400);

    const report = (await (await admin(`/${expId}/report`, 'GET')).json()) as {
      data: { report: { arms: Array<{ key: string; exposures: number; conversions: number }> }; daily: Array<{ armKey: string; kind: string; count: number }> };
    };
    expect(report.data.report.arms).toEqual([
      expect.objectContaining({ key: 'b', exposures: 1, conversions: 1 }),
      expect.objectContaining({ key: 'control', exposures: 1, conversions: 0 }),
    ]);
    expect(report.data.daily).toHaveLength(3);
  });

  it('reports a winner once the data supports it, and promotion goes through approval', async () => {
    const [exp] = await db.execute<{ id: string }>(sql`select id from lumibase_experiments where id = ${expId}`).then((r) => (Array.isArray(r) ? r : (r as unknown as { rows: Array<{ id: string }> }).rows));
    expect(exp).toBeTruthy();
    // 400 exposures each; b converts at 20%, control at 10%.
    const { ExperimentRepository } = await import('../modules/experiments/repo');
    const repo = new ExperimentRepository(db, SITE);
    await repo.recordEvent(expId, 'b', 'exposure', '2026-11-18', 399);
    await repo.recordEvent(expId, 'b', 'conversion', '2026-11-18', 79);
    await repo.recordEvent(expId, 'control', 'exposure', '2026-11-18', 399);
    await repo.recordEvent(expId, 'control', 'conversion', '2026-11-18', 40);

    const analysis = (await harness().execute('analyzeExperiment', { experimentId: expId }, ['items:read'])) as { status: string; data: { report: { recommendation: { arm: string } | null; sampleReached: boolean } } };
    expect(analysis.status).toBe('executed');
    expect(analysis.data.report.sampleReached).toBe(true);
    expect(analysis.data.report.recommendation?.arm).toBe('b');

    // The REST promote parks an approval and changes nothing yet.
    expect((await admin(`/${expId}/promote`, 'POST', { arm: 'nope' })).status).toBe(404);
    const parked = await admin(`/${expId}/promote`, 'POST', { arm: 'b', rationale: 'b wins at p<0.001' });
    expect(parked.status).toBe(202);
    const parkedBody = (await parked.json()) as { data: { status: string; approvalId: string } };
    expect(parkedBody.data.status).toBe('pending_approval');
    const [approval] = await db.select().from(aiApprovals).where(and(eq(aiApprovals.siteId, SITE), eq(aiApprovals.id, parkedBody.data.approvalId)));
    expect(approval).toMatchObject({ skillName: 'promoteExperimentWinner', status: 'pending' });
    const [stillHome] = await db.select().from(pages).where(eq(pages.id, pageId));
    expect(stillHome!.title).toBe('Home');

    // The agent path parks the same way.
    const agent = await harness().execute('promoteExperimentWinner', { experimentId: expId, arm: 'b' }, ['items:write'], undefined, { requestedByPrincipal: REQUESTER });
    expect(agent.status).toBe('pending_approval');

    // A human approves: the winner becomes the published page, the experiment completes.
    const approved = await harness().executeApproved(parkedBody.data.approvalId, ADMIN, ['items:read', 'items:write'], { kind: 'human', userId: ADMIN } as never);
    expect(approved.status, JSON.stringify(approved)).toBe('executed');
    const [home] = await db.select().from(pages).where(eq(pages.id, pageId));
    expect(home!.title).toBe('Ship faster');
    const detail = (await (await admin(`/${expId}`, 'GET')).json()) as { data: { status: string; winnerArm: string } };
    expect(detail.data).toMatchObject({ status: 'completed', winnerArm: 'b' });

    // Delivery no longer splits: everyone gets the promoted content, uncounted.
    const after = await deliver({ 'X-Lumi-Consent': 'analytics', 'X-Lumi-Visitor': 'visitor-0-abc' });
    const afterBody = (await after.json()) as Payload;
    expect(afterBody.page.title).toBe('Ship faster');
    expect(afterBody.experiments).toBeUndefined();

    // The second (agent) approval cannot promote a completed experiment.
    const late = await harness().executeApproved((agent as { approvalId: string }).approvalId, ADMIN, ['items:read', 'items:write'], { kind: 'human', userId: ADMIN } as never);
    expect(late.status).not.toBe('executed');
    expect((await admin(`/${expId}`, 'PATCH', { name: 'x' })).status).toBe(409);
  });

  it('promoting an item experiment patches the item through the ItemService', async () => {
    const created = await admin('', 'POST', { key: 'cta-2', name: 'CTA copy', subjectType: 'item', subjectId: itemId, goal: 'click', arms: [{ key: 'control' }, { key: 'b', overrides: { title: 'Hello B' } }] });
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await admin(`/${id}/start`, 'POST')).status).toBe(200);
    const v = visitorsFor('cta-2', [{ key: 'b', weight: 50 }, { key: 'control', weight: 50 }]);
    const asB = (await (await deliver({ 'X-Lumi-Consent': 'analytics', 'X-Lumi-Visitor': v.b! })).json()) as Payload;
    expect(asB.sections[0]!.data.items[0]!.title).toBe('Hello B');
    expect(asB.experiments).toEqual([{ key: 'cta-2', arm: 'b' }]);
    expect((await admin(`/${id}/stop`, 'POST')).status).toBe(200);
    const parked = (await harness().execute('promoteExperimentWinner', { experimentId: id, arm: 'b' }, ['items:write'], undefined, { requestedByPrincipal: REQUESTER })) as { approvalId: string };
    const done = await harness().executeApproved(parked.approvalId, ADMIN, ['items:read', 'items:write'], { kind: 'human', userId: ADMIN } as never);
    expect(done.status, JSON.stringify(done)).toBe('executed');
    const [row] = await db.select().from(items).where(eq(items.id, itemId));
    expect((row!.data as { title: string }).title).toBe('Hello B');
  });
});
