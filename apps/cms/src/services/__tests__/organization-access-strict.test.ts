import { describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import { organizationRoleForSite } from '../organization-access';

/**
 * #861 sub-bug 3 (wiring): on a strict site, an organization owner/admin role
 * is not inherited when another alias of the same mailbox holds the site's
 * seat. The SQL of the seat check runs against Postgres in
 * `organization-access-strict.db.integration.test.ts`.
 */

function fakeDb(opts: { strict: boolean; role: string | null; seatHeldByAlias: boolean }) {
  const selects = [
    [{ organizationId: 'org_1', strict: opts.strict }],
    opts.role ? [{ role: opts.role }] : [],
  ];
  let i = 0;
  let executed = 0;
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => selects[i++] ?? [] }) }) }),
    execute: async () => {
      executed += 1;
      return opts.seatHeldByAlias ? [{ '?column?': 1 }] : [];
    },
  };
  return { db: db as unknown as Database, executed: () => executed };
}

describe('organizationRoleForSite — strict sites (#861)', () => {
  it('strict site, another alias holds the seat → no inherited role', async () => {
    const { db } = fakeDb({ strict: true, role: 'owner', seatHeldByAlias: true });
    expect(await organizationRoleForSite(db, 'u_alias', 'site_1')).toBeNull();
  });

  it('strict site, no alias holds the seat → role inherited', async () => {
    const { db } = fakeDb({ strict: true, role: 'admin', seatHeldByAlias: false });
    expect(await organizationRoleForSite(db, 'u_1', 'site_1')).toBe('admin');
  });

  it('non-strict site → role inherited without the seat check', async () => {
    const { db, executed } = fakeDb({ strict: false, role: 'owner', seatHeldByAlias: true });
    expect(await organizationRoleForSite(db, 'u_alias', 'site_1')).toBe('owner');
    expect(executed()).toBe(0);
  });

  it('no organization role → null without the seat check', async () => {
    const { db, executed } = fakeDb({ strict: true, role: null, seatHeldByAlias: true });
    expect(await organizationRoleForSite(db, 'u_1', 'site_1')).toBeNull();
    expect(executed()).toBe(0);
  });
});
