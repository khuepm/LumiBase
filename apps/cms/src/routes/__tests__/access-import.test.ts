import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { ACCESS_EXPORT_SCHEMA } from '../../services/access-export';
import { accessRouter } from '../access';

function emptyDb(state = { auditWrites: 0 }): Database {
  const rows: unknown[][] = [[], [], [], [], [], [], [], [], [], []];
  let index = 0;
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows[index++] ?? []).then(resolve, reject),
  };
  const insertFluent = {
    values: () => {
      state.auditWrites += 1;
      return Promise.resolve([]);
    },
  };
  return {
    select: () => fluent,
    insert: () => insertFluent,
    transaction: async (cb: (tx: Database) => Promise<unknown>) => cb(emptyDb(state)),
  } as unknown as Database;
}

function buildApp(state = { auditWrites: 0 }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', emptyDb(state));
    c.set('siteId', 'site_1');
    await next();
  });
  app.route('/api/v1/access', accessRouter);
  return app;
}

function manifest() {
  return {
    schema: ACCESS_EXPORT_SCHEMA,
    exportedAt: '2026-06-04T00:00:00.000Z',
    roles: [],
    policies: [],
    bindings: {
      rolePolicies: [],
      userRoles: [],
      userPolicies: [],
      apiKeyRoles: [],
      apiKeyPolicies: [],
    },
    apiKeys: [],
  };
}

describe('POST /api/v1/access/import', () => {
  it('applies merge mode and writes an audit summary when dryRun is omitted', async () => {
    const state = { auditWrites: 0 };
    const res = await buildApp(state).request('/api/v1/access/import', {
      method: 'POST',
      body: JSON.stringify(manifest()),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { dryRun: boolean; mode: string; applied: boolean } };
    expect(body.data).toMatchObject({ dryRun: false, mode: 'merge', applied: true });
    expect(state.auditWrites).toBe(1);
  });

  it('returns dry-run validation and diff result without applying writes', async () => {
    const res = await buildApp().request('/api/v1/access/import?dryRun=true', {
      method: 'POST',
      body: JSON.stringify(manifest()),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { dryRun: boolean; valid: boolean } };
    expect(body.data).toMatchObject({ dryRun: true, valid: true });
  });
});
