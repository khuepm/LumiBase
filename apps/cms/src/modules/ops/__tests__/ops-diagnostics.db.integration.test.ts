/**
 * Ops diagnostics against a real Postgres (`.kiro/specs/ops-diagnostics`).
 *
 * Reproduces the failure modes the plane exists to explain, on a database
 * migrated + RLS-installed exactly like production (`createRlsTestDatabase`):
 * a NOBYPASSRLS app role, a BYPASSRLS system role.
 *
 * - flag `off` + policies installed → RLS_POLICIES_WITHOUT_FLAG, and the site
 *   probe says SITE_ROW_HIDDEN_BY_RLS (the GET /site 404).
 * - flag `enforce` → the request path sees the row, no RLS findings.
 * - a column the code selects is missing → SCHEMA_DRIFT + SITE_QUERY_FAILS 42703.
 * - a 500 is captured to lumibase_ops_errors and readable by requestId.
 */
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { AppEnv } from '../../../env';
import { createRlsTestDatabase, type RlsTestDatabase } from '../../../test-utils/rls-roles';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { captureOpsError, resetCaptureRateLimit } from '../capture';
import { opsRouter } from '../routes';

const TOKEN = 'ops-integration-token-0123456789abcdef';
const SITE = 'ops_site_a';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

// Loosely typed JSON body: these assertions walk the response shape directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

type Sql = postgres.Sql;

describe.skipIf(!hasDbIntegrationUrl)('ops diagnostics — real Postgres', () => {
  let fx: RlsTestDatabase;
  let harness: Awaited<ReturnType<typeof connectDbIntegration>>;
  let owner: Sql;
  let appSql: Sql;
  let sysSql: Sql;

  function build() {
    const runtime = {
      runtime: 'docker',
      database: {
        getConnection: () => appSql,
        getSystemConnection: () => sysSql,
        hasSystemConnection: () => true,
        close: async () => {},
      },
      cache: new MemoryCacheProvider(),
      search: { getIndex: async () => ({}) },
      storage: { list: async () => [] },
      queue: { enqueue: async () => 'job' },
    };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('runtime', runtime as unknown as AppEnv['Variables']['runtime']);
      c.set('requestId', c.req.header('x-request-id') ?? 'ops-it');
      await next();
    });
    app.route('/api/v1/ops', opsRouter);
    app.get('/boom', (c) => {
      c.set('siteId', SITE);
      throw new Error('kaboom');
    });
    app.onError((err, c) => {
      captureOpsError(c, { err, status: 500, errorCode: 'INTERNAL' });
      return c.json({ errors: [{ code: 'INTERNAL' }] }, 500);
    });
    return app;
  }

  const env = (rls: 'off' | 'enforce') => ({
    LUMIBASE_ENV: 'test',
    LUMIBASE_DB_RLS: rls,
    LUMIBASE_OPS_TOKEN: TOKEN,
    LUMIBASE_VERSION: '2.0.1',
    LUMIBASE_GIT_SHA: 'deadbeef',
  });

  const codes = (findings: Array<{ code: string }>) => findings.map((f) => f.code);

  beforeAll(async () => {
    // Fails loudly (instead of skipping) when DATABASE_URL is set but unreachable (#427).
    harness = await connectDbIntegration('ops-diagnostics');
    vi.stubEnv('LUMIBASE_ENV', 'test');
    fx = await createRlsTestDatabase(dbIntegrationUrl!);
    owner = postgres(fx.ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
    // Production roles can read the drizzle journal table; mirror that.
    const sysRole = new URL(fx.sysUrl).username;
    await owner.unsafe(`GRANT USAGE ON SCHEMA drizzle TO ${sysRole}`);
    await owner.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${sysRole}`);
    appSql = postgres(fx.appUrl, { max: 3, prepare: false });
    sysSql = postgres(fx.sysUrl, { max: 3, prepare: false });
    await sysSql`INSERT INTO lumibase_sites (organization_id, id, name)
      VALUES ((SELECT id FROM lumibase_organizations WHERE slug='default'), ${SITE}, ${SITE})`;
  }, 180_000);

  afterAll(async () => {
    await appSql?.end({ timeout: 5 });
    await sysSql?.end({ timeout: 5 });
    await owner?.end({ timeout: 5 });
    await fx?.drop();
    await (harness as unknown as { $client?: Sql } | undefined)?.$client?.end({ timeout: 5 });
    vi.unstubAllEnvs();
  }, 60_000);

  it('flag off + policies installed: diagnoses the hidden site row', async () => {
    const app = build();
    const diag = await json(app.request('/api/v1/ops/diagnostics', auth, env('off')));
    expect(diag.data.migrations.pending).toEqual([]);
    expect(diag.data.schemaDrift).toEqual({ missingTables: [], missingColumns: [] });
    expect(diag.data.rls.appRole.bypassRls).toBe(false);
    expect(diag.data.rls.systemRole.bypassRls).toBe(true);
    expect(diag.data.rls.tables.lumibase_ops_errors).toEqual({ enabled: true, forced: true });
    expect(codes(diag.data.findings)).toContain('RLS_POLICIES_WITHOUT_FLAG');
    expect(diag.data.release.label).toBe('2.0.1+deadbeef');

    const probe = await json(app.request(`/api/v1/ops/sites/${SITE}/probe`, auth, env('off')));
    expect(probe.data.exists).toEqual({ ok: true, value: true });
    expect(probe.data.requestPath).toMatchObject({ ok: true, value: { found: false }, connection: 'app (unscoped)' });
    expect(probe.data.underRlsScope).toEqual({ ok: true, value: { found: true } });
    expect(codes(probe.data.findings)).toEqual(['SITE_ROW_HIDDEN_BY_RLS']);
  });

  it('flag enforce: the request path sees the row and RLS is coherent', async () => {
    const app = build();
    const diag = await json(app.request('/api/v1/ops/diagnostics', auth, env('enforce')));
    const rlsCodes = codes(diag.data.findings).filter((c: string) => /RLS|BYPASS|SYSTEM|ENFORCE/.test(c));
    expect(rlsCodes).toEqual([]);
    const probe = await json(app.request(`/api/v1/ops/sites/${SITE}/probe`, auth, env('enforce')));
    expect(probe.data.requestPath).toMatchObject({ ok: true, value: { found: true }, connection: 'app (site-scoped)' });
    expect(probe.data.findings).toEqual([]);
    // No row values leak: only booleans/counts.
    expect(JSON.stringify(probe.data)).not.toContain('"name"');
  });

  it('a missing column surfaces as SCHEMA_DRIFT and SITE_QUERY_FAILS 42703', async () => {
    await owner.unsafe('ALTER TABLE lumibase_sites RENAME COLUMN custom_css TO custom_css_gone');
    try {
      const app = build();
      const diag = await json(app.request('/api/v1/ops/diagnostics', auth, env('enforce')));
      const drift = diag.data.findings.find((f: { code: string }) => f.code === 'SCHEMA_DRIFT');
      expect(drift.data.missingColumns).toEqual([{ table: 'lumibase_sites', columns: ['custom_css'] }]);

      const probe = await json(app.request(`/api/v1/ops/sites/${SITE}/probe`, auth, env('enforce')));
      const fail = probe.data.findings.find((f: { code: string }) => f.code === 'SITE_QUERY_FAILS');
      expect(fail.message).toContain('42703');
      expect(JSON.stringify(fail.data.error)).toContain('custom_css');
    } finally {
      await owner.unsafe('ALTER TABLE lumibase_sites RENAME COLUMN custom_css_gone TO custom_css');
    }
  });

  it('captures a 500 and serves it by requestId; the app role cannot read it', async () => {
    resetCaptureRateLimit();
    const app = build();
    const res = await app.request('/boom', { headers: { 'x-request-id': 'req-it-1' } }, env('enforce'));
    expect(res.status).toBe(500);
    await vi.waitFor(async () => {
      const r = await app.request('/api/v1/ops/errors/req-it-1', auth, env('enforce'));
      expect(r.status).toBe(200);
    });
    const body = await json(app.request('/api/v1/ops/errors/req-it-1', auth, env('enforce')));
    expect(body.data[0]).toMatchObject({
      requestId: 'req-it-1',
      path: '/boom',
      status: 500,
      siteId: SITE,
      errorCode: 'INTERNAL',
      release: '2.0.1+deadbeef',
    });
    expect(body.data[0].error.message).toBe('kaboom');

    const list = await json(app.request(`/api/v1/ops/errors?siteId=${SITE}&status=500`, auth, env('enforce')));
    expect(list.data.length).toBeGreaterThan(0);

    // RLS forced, no policy: the NOBYPASSRLS app role sees nothing.
    expect(await appSql`SELECT * FROM lumibase_ops_errors`).toHaveLength(0);
  });
});
