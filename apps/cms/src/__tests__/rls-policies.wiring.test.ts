import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static tripwire for `packages/database/migrations/rls-policies.sql` (B125).
 *
 * The file used to create only RESTRICTIVE `site_isolation` policies. Postgres
 * shows a role without BYPASSRLS no rows unless a PERMISSIVE policy passes, so
 * the non-superuser app role the file requires saw and wrote nothing on every
 * listed table. The behaviour is proven against Postgres in
 * `rls-policies.db.integration.test.ts`; this scan runs in the plain
 * `pnpm test` (no database) so a PR that breaks the policy pair fails CI even
 * where the DB job is not looked at. The file name deliberately does not
 * contain "integration".
 */

const RLS_SQL = readFileSync(
  resolve(__dirname, '..', '..', '..', '..', 'packages/database/migrations/rls-policies.sql'),
  'utf8',
);

/** SQL with `--` comments removed, so prose cannot satisfy or trip a check. */
const CODE = RLS_SQL.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const occurrences = (needle: RegExp) => (CODE.match(needle) ?? []).length;

describe('rls-policies.sql keeps a permissive + restrictive pair per table (B125)', () => {
  it('creates each policy kind twice: once in the table loop, once for lumibase_extensions', () => {
    expect(occurrences(/\bAS RESTRICTIVE\b/g)).toBe(2);
    expect(occurrences(/\bAS PERMISSIVE\b/g)).toBe(2);
  });

  it('pairs every site_isolation policy with a site_isolation_permit policy', () => {
    const restrictive = occurrences(/CREATE POLICY site_isolation ON\b/g);
    const permissive = occurrences(/CREATE POLICY site_isolation_permit ON\b/g);
    expect(restrictive).toBe(2);
    expect(permissive).toBe(restrictive);
    // No other policy name: a stray policy would bypass the pair's reasoning.
    expect(occurrences(/CREATE POLICY\b/g)).toBe(restrictive + permissive);
  });

  it('drops both names before creating them, so re-applying converges', () => {
    expect(occurrences(/DROP POLICY IF EXISTS site_isolation ON\b/g)).toBe(2);
    expect(occurrences(/DROP POLICY IF EXISTS site_isolation_permit ON\b/g)).toBe(2);
  });

  it('never makes the permissive half unconditional', () => {
    expect(CODE).not.toMatch(/USING\s*\(\s*true\s*\)/i);
    expect(CODE).not.toMatch(/WITH CHECK\s*\(\s*true\s*\)/i);
  });

  it('keeps app_site_id() invoker-rights with a pinned search_path (B128)', () => {
    expect(CODE).not.toMatch(/SECURITY DEFINER/);
    expect(CODE).toMatch(/SECURITY INVOKER/);
    expect(CODE).toContain('SET search_path = pg_catalog, pg_temp');
  });

  it('does not hardcode the database name', () => {
    expect(CODE).not.toMatch(/ALTER DATABASE lumibase\b/);
  });

  it('lists no table twice', () => {
    const block = /tables text\[\] := ARRAY\[([\s\S]*?)\];/.exec(CODE)?.[1] ?? '';
    const tables = [...block.matchAll(/'(lumibase_[a-z_]+)'/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThanOrEqual(48);
    expect(new Set(tables).size).toBe(tables.length);
  });
});
