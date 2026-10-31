import { describe, expect, it, vi } from 'vitest';
import { assertDbRlsStartup } from '../db-rls-startup';

type Role = { rolname: string; rolsuper: boolean; rolbypassrls: boolean };

/** Fake tagged-template client: answers the pg_roles and pg_policies probes. */
function fakeSql(role: Role, opts: { permitPolicy?: boolean } = {}) {
  return (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('pg_roles')) return Promise.resolve([role]);
    if (text.includes('pg_policies')) return Promise.resolve(opts.permitPolicy ? [{ '?column?': 1 }] : []);
    return Promise.reject(new Error(`unexpected query: ${text}`));
  };
}

function provider(app: unknown, system: unknown, has: boolean) {
  return { getConnection: () => app, getSystemConnection: () => system, hasSystemConnection: () => has };
}

const APP: Role = { rolname: 'app', rolsuper: false, rolbypassrls: false };
const SYS: Role = { rolname: 'sys', rolsuper: false, rolbypassrls: true };
const SUPER: Role = { rolname: 'postgres', rolsuper: true, rolbypassrls: true };

describe('assertDbRlsStartup (B130)', () => {
  it('invalid flag value: throws', async () => {
    await expect(
      assertDbRlsStartup({ rawMode: 'on', database: provider(fakeSql(APP), fakeSql(SYS), true) }),
    ).rejects.toThrow(/LUMIBASE_DB_RLS/);
  });

  it('enforce without DATABASE_SYSTEM_URL: throws', async () => {
    await expect(
      assertDbRlsStartup({ rawMode: 'enforce', database: provider(fakeSql(APP), fakeSql(APP), false) }),
    ).rejects.toThrow(/DATABASE_SYSTEM_URL/);
  });

  it('enforce with a system role that does not bypass RLS: throws', async () => {
    await expect(
      assertDbRlsStartup({ rawMode: 'enforce', database: provider(fakeSql(APP), fakeSql(APP), true) }),
    ).rejects.toThrow(/BYPASSRLS/);
  });

  it('enforce with app NOBYPASSRLS + sys BYPASSRLS: passes silently', async () => {
    const warn = vi.fn();
    const mode = await assertDbRlsStartup({
      rawMode: 'enforce',
      database: provider(fakeSql(APP), fakeSql(SYS), true),
      warn,
      log: () => {},
    });
    expect(mode).toBe('enforce');
    expect(warn).not.toHaveBeenCalled();
  });

  it('enforce with an app role that bypasses RLS: warns that the backstop is inert', async () => {
    const warn = vi.fn();
    await assertDbRlsStartup({
      rawMode: 'enforce',
      database: provider(fakeSql(SUPER), fakeSql(SYS), true),
      warn,
      log: () => {},
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/enforces nothing/));
  });

  it('off + NOBYPASSRLS app role + policy pair installed: warns', async () => {
    const warn = vi.fn();
    const mode = await assertDbRlsStartup({
      rawMode: undefined,
      database: provider(fakeSql(APP, { permitPolicy: true }), fakeSql(APP), false),
      warn,
    });
    expect(mode).toBe('off');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no rows/));
  });

  it('off + NOBYPASSRLS app role without the policy pair: silent', async () => {
    const warn = vi.fn();
    await assertDbRlsStartup({ rawMode: 'off', database: provider(fakeSql(APP), fakeSql(APP), false), warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('off + database not reachable at boot: does not stop the process', async () => {
    const down = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(
      assertDbRlsStartup({ rawMode: undefined, database: provider(down, down, false) }),
    ).resolves.toBe('off');
  });

  it('off + superuser (today): silent', async () => {
    const warn = vi.fn();
    await assertDbRlsStartup({ rawMode: '', database: provider(fakeSql(SUPER, { permitPolicy: true }), fakeSql(SUPER), false), warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
