import { type Database } from '@lumibase/database';
import { getTableName, type SQL, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { PermissionService } from '../../services/permission-service';
import { intentsRouter } from '../intents';
import { webhooksRouter } from '../webhooks';
import { flowsRouter } from '../flows';
import { extensionsRouter } from '../extensions';

const dialect = new PgDialect();
const cases = [
  { name: 'intent', table: 'lumibase_content_intents', router: intentsRouter,
    stored: { name: 'before', autonomyCap: 0, budget: { maxGoalsPerCycle: 1, maxWritesPerMinute: 1, maxCostUsd: 0.1 } }, patch: { name: 'after' } },
  { name: 'webhook', table: 'lumibase_webhooks', router: webhooksRouter,
    stored: { name: 'before', status: 'inactive', actions: ['items.create'], collections: ['posts'], headers: { 'x-test': 'keep' } }, patch: { name: 'after' } },
  { name: 'flow', table: 'lumibase_flows', router: flowsRouter,
    stored: { name: 'before', status: 'active', triggerType: 'schedule', triggerOptions: { cron: '*/5 * * * *' }, graph: { entry: 'n1', nodes: [{ id: 'n1', key: 'log' }] } }, patch: { name: 'after' } },
  { name: 'extension', table: 'lumibase_extensions', router: extensionsRouter,
    stored: { name: 'example', type: 'interface', version: '1.0.0', enabled: true, manifest: { config: 'keep' }, capabilities: ['items:read'] }, patch: { version: '1.0.1' } },
];

function fixture(test: typeof cases[number]) {
  const rows: Record<string, unknown>[] = ['site-a', 'site-b'].map((siteId) => ({ id: 'same-id', siteId, ...test.stored }));
  const writes: Record<string, unknown>[] = [];
  function matching(table: Table, where: SQL) {
    const params = dialect.sqlToQuery(where).params;
    return getTableName(table) === test.table ? rows.filter((r) => params.includes(r.siteId) && params.includes(r.id)) : [];
  }
  const db = {
    select: () => ({ from: (table: Table) => ({ where: (where: SQL) => {
      const selected = matching(table, where);
      return Object.assign(Promise.resolve(selected), { limit: async () => selected });
    } }) }),
    update: (table: Table) => ({ set: (patch: Record<string, unknown>) => ({ where: (where: SQL) => {
      const selected = matching(table, where);
      for (const row of selected) Object.assign(row, patch);
      writes.push(patch);
      return { returning: async () => selected };
    } }) }),
  } as unknown as Database;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', 'site-a'); c.set('db', db);
    c.set('auth', { roles: ['admin'], raw: { dev: true } });
    c.set('runtime', {} as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/', test.router);
  const patch = (body: unknown) => app.request('/same-id', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { LUMIBASE_ENV: 'development' });
  return { patch, rows, writes };
}

afterEach(() => vi.restoreAllMocks());
describe('PATCH keeps omitted state and tenant boundaries (B85/B86)', () => {
  it.each(cases)('$name: changing one field preserves all other configured values', async (test) => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue({ collection: '*', action: 'update', rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] });
    const { patch, rows } = fixture(test);
    const other = structuredClone(rows[1]);
    const res = await patch(test.patch);
    expect(res.status, await res.text()).toBe(200);
    expect(rows[0]).toMatchObject({ ...test.stored, ...test.patch });
    if (test.name === 'flow') expect(rows[0]?.nextRunAt).toBeInstanceOf(Date);
    expect(rows[1]).toEqual(other);
  });
  it.each(cases.filter((test) => ['webhook', 'extension'].includes(test.name)))('$name: an empty patch is a no-op', async (test) => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue({ collection: '*', action: 'update', rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] });
    const { patch, rows, writes } = fixture(test);
    const before = structuredClone(rows);
    expect((await patch({})).status).toBe(200);
    expect(rows).toEqual(before); expect(writes).toEqual([]);
  });
  it('intent: explicit governance changes still work through both validation layers', async () => {
    const { patch, rows } = fixture(cases[0]!);
    expect((await patch({ autonomyCap: 1, budget: { maxGoalsPerCycle: 2, maxWritesPerMinute: 3, maxCostUsd: 0.2 } })).status).toBe(200);
    expect(rows[0]).toMatchObject({ autonomyCap: 1, budget: { maxGoalsPerCycle: 2, maxWritesPerMinute: 3, maxCostUsd: 0.2 } });
  });
  it('invalid intent patch is rejected before writing', async () => {
    const { patch, writes } = fixture(cases[0]!);
    expect((await patch({ autonomyCap: 9 })).status).toBe(400);
    expect(writes).toEqual([]);
  });
});
