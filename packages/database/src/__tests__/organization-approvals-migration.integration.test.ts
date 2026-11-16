/** Migration and policies run in an isolated schema, never on shared fixtures. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { nanoid } from 'nanoid';

const migration = readFileSync(new URL('../../drizzle/0025_organization_approvals.sql', import.meta.url), 'utf8');
const policies = readFileSync(new URL('../../migrations/rls-policies.sql', import.meta.url), 'utf8')
  .split('-- Approval scope is exactly')[1]!;
const url = process.env.DATABASE_URL;
describe.skipIf(!url)('organization approval migration and non-superuser RLS', () => {
  it('preserves legacy rows, enforces one parent, and isolates receipts even with a permissive policy', async () => {
    const db = postgres(url!, { max: 1 });
    const namespace = `approval_rls_${nanoid(12).replace(/-/g, '_')}`, role = `${namespace}_app`;
    try {
      await db.unsafe(`CREATE SCHEMA "${namespace}"`);
      await db.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await db.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO "${namespace}", public`);
        await tx.unsafe(`CREATE TABLE lumibase_organizations (id text PRIMARY KEY);
          CREATE TABLE lumibase_ai_approvals (id text PRIMARY KEY, site_id text NOT NULL, status text);
          INSERT INTO lumibase_organizations VALUES ('a'),('b');
          INSERT INTO lumibase_ai_approvals VALUES ('legacy','site_a','pending');
          CREATE FUNCTION app_site_id() RETURNS text LANGUAGE sql STABLE AS
            'SELECT NULLIF(current_setting(''app.site_id'', true), '''')';`);
        await tx.unsafe(migration); await tx.unsafe(migration);
        expect((await tx`SELECT site_id, organization_id FROM lumibase_ai_approvals WHERE id='legacy'`)[0])
          .toMatchObject({ site_id: 'site_a', organization_id: null });
        await tx`INSERT INTO lumibase_ai_approvals (id,organization_id,organization_requester,status,result)
          VALUES ('org_a','a','{"type":"user","userId":"owner"}','approved','{"token":"secret_a"}'),
          ('org_b','b','{"type":"user","userId":"other"}','approved','{"token":"secret_b"}')`;
        for (const insert of [
          "INSERT INTO lumibase_ai_approvals (id) VALUES ('neither')",
          "INSERT INTO lumibase_ai_approvals (id,site_id,organization_id) VALUES ('both','site_a','a')",
          "INSERT INTO lumibase_ai_approvals (id,organization_id) VALUES ('no_requester','a')",
        ]) await expect(tx.savepoint((sp) => sp.unsafe(insert))).rejects.toMatchObject({ code: '23514' });
        await tx.unsafe('-- Approval scope is exactly' + policies);
        await tx.unsafe('-- Approval scope is exactly' + policies);
        await tx.unsafe(`CREATE POLICY wider ON lumibase_ai_approvals AS PERMISSIVE USING (true) WITH CHECK (true);
          GRANT USAGE ON SCHEMA "${namespace}" TO "${role}";
          GRANT SELECT,INSERT,UPDATE,DELETE ON lumibase_ai_approvals TO "${role}";
          SET LOCAL ROLE "${role}"`);
        expect(await tx`SELECT * FROM lumibase_ai_approvals`).toHaveLength(0);
        await tx`SELECT set_config('app.site_id','site_a',true)`;
        expect((await tx`SELECT id FROM lumibase_ai_approvals`).map((r) => r.id)).toEqual(['legacy']);
        await tx`SELECT set_config('app.site_id','',true), set_config('lumibase.organization_id','a',true)`;
        expect((await tx`SELECT id FROM lumibase_ai_approvals`).map((r) => r.id)).toEqual(['org_a']);
        expect(await tx`UPDATE lumibase_ai_approvals SET status='rejected' WHERE id='org_b' RETURNING id`).toHaveLength(0);
        expect(await tx`DELETE FROM lumibase_ai_approvals WHERE id='legacy' RETURNING id`).toHaveLength(0);
        await expect(tx.savepoint((sp) => sp`INSERT INTO lumibase_ai_approvals (id,site_id) VALUES ('foreign','site_b')`))
          .rejects.toMatchObject({ code: '42501' });
        await tx.unsafe('RESET ROLE');
      });
      expect((await db`SELECT current_setting('lumibase.organization_id',true) AS scope`)[0]!.scope ?? '').toBe('');
    } finally {
      await db.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await db.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      await db.end();
    }
  });
});
