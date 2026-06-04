import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { extensionsRouter } from '../extensions';
import { marketplaceRouter } from '../marketplace';

const SITE_ID = 'site_1';
const USER_ID = 'user_1';

vi.stubGlobal('fetch', vi.fn());

type DbState = {
  inserts: unknown[];
  updates: unknown[];
  deletes: number;
};

function permissionRows(actions: string[]) {
  return [
    [{ id: USER_ID, email: 'admin@example.com', status: 'active' }],
    [{ id: 'role_extension_manager', name: 'Extension Manager', adminAccess: false, appAccess: true }],
    [],
    [{ policyId: 'policy_extension_manager', priority: 100 }],
    [],
    [{
      id: 'policy_extension_manager',
      siteId: SITE_ID,
      key: 'policy_extension_manager',
      name: 'Extension Manager',
      appAccess: true,
      adminAccess: false,
      enforceTfa: false,
      rules: {},
      ipAllow: [],
      ipDeny: [],
      validFrom: null,
      validUntil: null,
    }],
    actions.map((action) => ({
      id: `perm_extensions_${action}`,
      siteId: SITE_ID,
      policyId: 'policy_extension_manager',
      collection: 'extensions',
      action,
      permissions: {},
      fields: ['*'],
      presets: {},
      validation: {},
    })),
  ];
}

function makeDb(results: unknown[][]): { db: Database; state: DbState } {
  const queue = [...results];
  const state: DbState = { inserts: [], updates: [], deletes: 0 };
  const take = () => Promise.resolve(queue.shift() ?? []);

  const selectFluent = {
    from: () => selectFluent,
    innerJoin: () => selectFluent,
    where: () => selectFluent,
    limit: take,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      take().then(resolve, reject),
  };
  const insertFluent = {
    values: (value: unknown) => {
      state.inserts.push(value);
      return insertFluent;
    },
    returning: take,
  };
  const updateFluent = {
    set: (value: unknown) => {
      state.updates.push(value);
      return updateFluent;
    },
    where: () => updateFluent,
    returning: take,
  };
  const deleteFluent = {
    where: () => deleteFluent,
    returning: () => {
      state.deletes += 1;
      return take();
    },
  };

  return {
    state,
    db: {
      select: () => selectFluent,
      insert: () => insertFluent,
      update: () => updateFluent,
      delete: () => deleteFluent,
    } as unknown as Database,
  };
}

function buildApp(db: Database) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', SITE_ID);
    c.set('db', db);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as never);
    c.set('auth', {
      userId: USER_ID,
      email: 'admin@example.com',
      roles: [],
      raw: {},
    });
    await next();
  });
  app.route('/api/v1/extensions', extensionsRouter);
  app.route('/api/v1/marketplace', marketplaceRouter);
  return app;
}

describe('extension management access', () => {
  it('returns 403 when listing extensions without extensions:read', async () => {
    const { db } = makeDb([...permissionRows([])]);
    const res = await buildApp(db).request('/api/v1/extensions');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Action "extensions:read" is not allowed.' }],
    });
  });

  it('allows listing extensions with extensions:read', async () => {
    const extensionRow = { id: 'ext_1', siteId: SITE_ID, name: 'Search', enabled: true };
    const { db } = makeDb([...permissionRows(['read']), [extensionRow]]);
    const res = await buildApp(db).request('/api/v1/extensions');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [extensionRow] });
  });

  it('requires extensions:install before creating or marketplace-installing extensions', async () => {
    const createPayload = {
      name: 'Search',
      version: '1.0.0',
      type: 'module',
      enabled: false,
      bundleUrl: 'https://cdn.example/search.js',
    };
    const createdRow = { id: 'ext_1', siteId: SITE_ID, key: 'search', ...createPayload };
    const sourceRow = {
      id: 'global_ext_1',
      siteId: null,
      key: 'search',
      name: 'Search',
      version: '1.0.0',
      type: 'module',
      enabled: false,
      bundleUrl: 'https://cdn.example/search.js',
      manifest: {},
      capabilities: [],
      bundleSha256: null,
      signature: null,
      signatureAlg: null,
      publisherKeyId: null,
      publisher: 'Acme',
      marketplaceSlug: 'search',
    };
    const { db, state } = makeDb([
      ...permissionRows(['install']),
      [createdRow],
      ...permissionRows(['install']),
      [sourceRow],
      [{ ...createdRow, id: 'ext_2' }],
    ]);
    const app = buildApp(db);

    const createRes = await app.request('/api/v1/extensions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createPayload),
    });
    const installRes = await app.request('/api/v1/marketplace/extensions/search/install', { method: 'POST' });

    expect(createRes.status).toBe(200);
    expect(installRes.status).toBe(201);
    expect(state.inserts).toHaveLength(2);
  });

  it('maps patch payloads to configure, enable, and grant_capability permissions', async () => {
    const updateRow = { id: 'ext_1', siteId: SITE_ID, name: 'Search', enabled: true };
    const { db, state } = makeDb([
      ...permissionRows(['enable']),
      [updateRow],
      ...permissionRows(['grant_capability']),
      [updateRow],
      ...permissionRows(['configure']),
      [updateRow],
    ]);
    const app = buildApp(db);

    const enableRes = await app.request('/api/v1/extensions/ext_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const capabilityRes = await app.request('/api/v1/extensions/ext_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: ['storage:read'] }),
    });
    const configureRes = await app.request('/api/v1/extensions/ext_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.0.1' }),
    });

    expect(enableRes.status).toBe(200);
    expect(capabilityRes.status).toBe(200);
    expect(configureRes.status).toBe(200);
    expect(state.updates).toEqual([{ enabled: true }, { capabilities: ['storage:read'] }, { version: '1.0.1' }]);
  });

  it('requires extensions:delete before deleting extensions', async () => {
    const { db, state } = makeDb([...permissionRows(['delete']), [{ id: 'ext_1' }]]);
    const res = await buildApp(db).request('/api/v1/extensions/ext_1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
    expect(state.deletes).toBe(1);
  });
});
