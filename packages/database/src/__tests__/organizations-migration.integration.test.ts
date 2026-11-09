/** Isolated legacy schemas: never truncate or migrate the caller's public DB. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { nanoid } from 'nanoid';

const migration = readFileSync(new URL('../../drizzle/0024_organizations.sql', import.meta.url), 'utf8');
const url = process.env.DATABASE_URL;
describe.skipIf(!url)('organizations migration on legacy installs (real PostgreSQL)', () => {
  for (const count of [0, 1, 3]) for (const bootstrap of [false, true]) {
    it(`backfills ${count} sites, bootstrap=${bootstrap}, and can run twice`, async () => {
      const db = postgres(url!, { max: 1 });
      const namespace = `org_migration_${nanoid(12).replace(/-/g, '_')}`;
      try {
        await db.unsafe(`CREATE SCHEMA "${namespace}"`);
        await db.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL search_path TO "${namespace}", public`);
          await tx.unsafe(`CREATE TABLE lumibase_users (id text PRIMARY KEY, is_bootstrap boolean NOT NULL DEFAULT false);
            CREATE TABLE lumibase_sites (id text PRIMARY KEY, name text NOT NULL, display_title text);
            CREATE TABLE lumibase_api_keys (id text PRIMARY KEY, site_id text NOT NULL REFERENCES lumibase_sites(id));`);
          await tx`INSERT INTO lumibase_users VALUES ('ordinary', false)`;
          if (bootstrap) await tx`INSERT INTO lumibase_users VALUES ('bootstrap', true)`;
          for (let i = 0; i < count; i++) {
            const id = i === 0 ? '__default__' : `site_${i}`;
            await tx`INSERT INTO lumibase_sites VALUES (${id}, 'Old name', ${i === 0 ? 'My project' : null})`;
            await tx`INSERT INTO lumibase_api_keys VALUES (${`key_${i}`}, ${id})`;
          }
          await tx.unsafe(migration);
          await tx.unsafe(migration);
          const orgs = await tx`SELECT * FROM lumibase_organizations`;
          expect(orgs).toHaveLength(1);
          expect(orgs[0]!.slug).toBe('default');
          expect(orgs[0]!.id).toHaveLength(21);
          expect(orgs[0]!.name).toBe(count ? 'My project' : 'Default');
          const sites = await tx`SELECT * FROM lumibase_sites`;
          expect(sites).toHaveLength(count);
          expect(sites.every((s) => s.organization_id === orgs[0]!.id)).toBe(true);
          const members = await tx`SELECT * FROM lumibase_organization_members`;
          expect(members.map((m) => [m.user_id, m.role])).toEqual(bootstrap ? [['bootstrap', 'owner']] : []);
          const keys = await tx`SELECT * FROM lumibase_api_keys`;
          expect(keys).toHaveLength(count);
          expect(keys.every((k) => k.scope === 'site' && k.organization_id === null && k.site_id)).toBe(true);
          await tx`INSERT INTO lumibase_api_keys (id, scope, organization_id) VALUES ('org_key', 'organization', ${orgs[0]!.id})`;
          // Each invalid write gets a savepoint so the main transaction survives.
          await expect(tx.savepoint((sp) => sp`INSERT INTO lumibase_sites (id, name) VALUES ('missing', 'Missing parent')`)).rejects.toMatchObject({ code: '23502' });
          await expect(tx.savepoint((sp) => sp`INSERT INTO lumibase_api_keys (id, scope) VALUES ('bad', 'site')`)).rejects.toMatchObject({ code: '23514' });
          await expect(tx.savepoint((sp) => sp`INSERT INTO lumibase_api_keys (id, scope, organization_id, site_id) VALUES ('both', 'organization', ${orgs[0]!.id}, '__default__')`)).rejects.toBeDefined();
          await expect(tx.savepoint((sp) => sp`INSERT INTO lumibase_organization_members VALUES ('ordinary', ${orgs[0]!.id}, 'superadmin', now())`)).rejects.toMatchObject({ code: '23514' });
          if (count) await expect(tx.savepoint((sp) => sp`DELETE FROM lumibase_organizations WHERE id=${orgs[0]!.id}`)).rejects.toMatchObject({ code: '23503' });
        });
      } finally {
        await db.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        await db.end();
      }
    });
  }
});

describe.skipIf(!url)('organization RLS (non-superuser)', () => {
  it('isolates both tables and fails closed without an organization scope', async () => {
    const db = postgres(url!, { max: 1 });
    const namespace = `org_rls_${nanoid(12).replace(/-/g, '_')}`;
    const role = `${namespace}_app`;
    const policies = readFileSync(new URL('../../migrations/rls-policies.sql', import.meta.url), 'utf8')
      .split('-- Organization plane:')[1]!.split('-- Approval scope is exactly')[0]!;
    try {
      await db.unsafe(`CREATE SCHEMA "${namespace}"`);
      await db.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await db.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO "${namespace}", public`);
        await tx.unsafe(`CREATE TABLE lumibase_users (id text PRIMARY KEY, is_bootstrap boolean DEFAULT false);
          CREATE TABLE lumibase_sites (id text PRIMARY KEY, name text NOT NULL, display_title text);
          CREATE TABLE lumibase_api_keys (id text PRIMARY KEY, site_id text NOT NULL REFERENCES lumibase_sites(id));`);
        await tx.unsafe(migration);
        await tx`DELETE FROM lumibase_organizations`;
        await tx`INSERT INTO lumibase_organizations (id, slug, name) VALUES ('a','a','A'),('b','b','B')`;
        await tx`INSERT INTO lumibase_users VALUES ('alice',false),('bob',false)`;
        await tx`INSERT INTO lumibase_organization_members (user_id, organization_id, role)
          VALUES ('alice','a','owner'),('bob','b','owner')`;
        await tx.unsafe('-- Organization plane:' + policies);
        await tx.unsafe(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
        await tx.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON lumibase_organizations, lumibase_organization_members TO "${role}"`);
        await tx.unsafe(`SET LOCAL ROLE "${role}"`);
        expect(await tx`SELECT id FROM lumibase_organizations`).toHaveLength(0);
        expect(await tx`SELECT user_id FROM lumibase_organization_members`).toHaveLength(0);
        await tx`SELECT set_config('app.site_id', 'a', true)`;
        expect(await tx`SELECT id FROM lumibase_organizations`).toHaveLength(0);
        await tx`SELECT set_config('lumibase.organization_id', 'a', true)`;
        expect((await tx`SELECT id FROM lumibase_organizations`).map((r) => r.id)).toEqual(['a']);
        expect((await tx`SELECT user_id FROM lumibase_organization_members`).map((r) => r.user_id)).toEqual(['alice']);
        await expect(tx.savepoint((sp) => sp`INSERT INTO lumibase_organizations (id, slug, name) VALUES ('c','c','C')`)).rejects.toMatchObject({ code: '42501' });
        expect(await tx`UPDATE lumibase_organizations SET name='stolen' WHERE id='b' RETURNING id`).toHaveLength(0);
        await tx`SELECT set_config('lumibase.organization_id', 'b', true)`;
        expect((await tx`SELECT id FROM lumibase_organizations`).map((r) => r.id)).toEqual(['b']);
        await tx.unsafe('RESET ROLE');
      });
      expect((await db`SELECT current_setting('lumibase.organization_id', true) AS scope`)[0]!.scope ?? '').toBe('');
    } finally {
      await db.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await db.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      await db.end();
    }
  });
});
