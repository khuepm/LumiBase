import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { agentApprovals, agentGoals, agentRuns, sites, type Database } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import type { AppEnv, AuthPrincipal } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { agentRouter } from '../agent';

/**
 * `GET /api/v1/agent/approvals?status=` (B209, #710) against REAL PostgreSQL.
 *
 * The API spec always said `status` defaults to `pending`; the route ignored
 * it and returned the latest 100 rows of every status, so on a busy site a
 * pending approval could fall off the page Studio's inbox reads.
 */

const SITE = 'site_b209_a';
const OTHER = 'site_b209_b';
const ADMIN: AuthPrincipal = { type: 'user', userId: 'usr_b209', roles: [], raw: {} };

describe.skipIf(!hasDbIntegrationUrl)('GET /agent/approvals status filter (B209) — DB integration', () => {
  let db: Database;

  function app(siteId = SITE) {
    const router = new Hono<AppEnv>();
    router.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('auth', ADMIN);
      c.set('runtime', {} as RuntimeContext);
      await next();
    });
    router.route('/agent', agentRouter);
    return { request: (path: string) => router.request(path, undefined, {}) };
  }

  async function list(query = '', siteId = SITE) {
    const res = await app(siteId).request(`/agent/approvals${query}`);
    return { status: res.status, body: (await res.json()) as { data?: Array<{ status: string; kind: string }>; errors?: Array<{ code: string }> } };
  }

  beforeAll(async () => {
    db = await connectDbIntegration('agent-approvals-list');
  });
  const cleanup = () => db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER})`);
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });
  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: SITE, name: 'B209 A' },
      { organizationId: org, id: OTHER, name: 'B209 B' },
    ]);
    for (const siteId of [SITE, OTHER]) {
      const [goal] = await db.insert(agentGoals).values({ siteId, title: 'g' }).returning();
      const [run] = await db.insert(agentRuns).values({ siteId, goalId: goal!.id }).returning();
      const row = (status: string, kind = 'approval', minutesAgo = 0) => ({
        siteId,
        runId: run!.id,
        subjectType: 'tool_call',
        subjectId: 'x',
        status,
        kind,
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
      });
      // 120 decided rows newer than the one pending approval: the old route's
      // 100-row page never reached it.
      await db.insert(agentApprovals).values([
        row('pending', 'approval', 500),
        ...Array.from({ length: 120 }, (_, i) => row(i % 2 ? 'approved' : 'rejected', 'approval', i)),
        row('pending', 'veto', 1),
        row('pending', 'question', 1),
      ]);
    }
  });

  it('defaults to pending, so an old pending approval is never pushed off the page', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.data!.map((r) => `${r.kind}:${r.status}`).sort()).toEqual(['approval:pending', 'veto:pending']);
  });

  it('filters by an explicit status and lists every status with `all`, never questions', async () => {
    const approved = await list('?status=approved');
    expect(approved.body.data).toHaveLength(60);
    expect(new Set(approved.body.data!.map((r) => r.status))).toEqual(new Set(['approved']));
    const all = await list('?status=all');
    expect(all.body.data).toHaveLength(100);
    expect(all.body.data!.some((r) => r.kind === 'question')).toBe(false);
  });

  it('refuses an unknown status', async () => {
    const { status, body } = await list('?status=done');
    expect(status).toBe(400);
    expect(body.errors![0]!.code).toBe('VALIDATION');
  });

  it('is site-scoped', async () => {
    await db.delete(agentApprovals).where(sql`${agentApprovals.siteId} = ${OTHER}`);
    expect((await list('', OTHER)).body.data).toEqual([]);
    expect((await list('')).body.data).toHaveLength(2);
  });
});
