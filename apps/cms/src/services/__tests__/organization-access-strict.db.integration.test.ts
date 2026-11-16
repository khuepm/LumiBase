import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { organizationMembers, organizations, sites, userSites, users, type Database } from '@lumibase/database';

import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { organizationRoleForSite } from '../organization-access';

/**
 * #861 sub-bug 3 against real Postgres: a strict site admits one account per
 * root mailbox, including access inherited from an organization owner/admin
 * role (which writes no `user_sites` row). Rows are tagged `oasit`.
 */

const ORG = 'org_oasit';
const SITE = 'site_oasit_strict';
const DOMAIN = 'oasit.test';

describe.skipIf(!hasDbIntegrationUrl)('organizationRoleForSite on a strict site — DB integration', () => {
  let db: Database;

  async function cleanup(): Promise<void> {
    await db.delete(userSites).where(eq(userSites.siteId, SITE));
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(organizations).where(eq(organizations.id, ORG));
    await db.execute(sql`DELETE FROM lumibase_users WHERE lower(email) LIKE ${`%@${DOMAIN}`}`);
  }

  async function addUser(local: string, createdAt: Date): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({ email: `${local}@${DOMAIN}`, status: 'active', createdAt })
      .returning({ id: users.id });
    return row!.id;
  }

  async function makeOrgAdmin(userId: string, role: 'owner' | 'admin' = 'admin'): Promise<void> {
    await db.insert(organizationMembers).values({ userId, organizationId: ORG, role });
  }

  beforeAll(async () => {
    db = await connectDbIntegration('organization-access-strict');
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    await db.insert(organizations).values({ id: ORG, slug: 'oasit', name: 'OASIT' });
    await db.insert(sites).values({ id: SITE, organizationId: ORG, name: 'OASIT strict', emailIdentityStrict: true });
  });

  it('an org admin is refused when another alias of the mailbox is a site member', async () => {
    const member = await addUser('alice', new Date('2026-01-02T00:00:00Z'));
    const admin = await addUser('alice+org', new Date('2026-01-01T00:00:00Z'));
    await db.insert(userSites).values({ userId: member, siteId: SITE });
    await makeOrgAdmin(admin);
    expect(await organizationRoleForSite(db, admin, SITE)).toBeNull();
  });

  it('of two aliases that are both org admins, only the earliest-created inherits access', async () => {
    const first = await addUser('bob', new Date('2026-01-01T00:00:00Z'));
    const second = await addUser('bob+two', new Date('2026-01-02T00:00:00Z'));
    await makeOrgAdmin(first, 'owner');
    await makeOrgAdmin(second);
    expect(await organizationRoleForSite(db, first, SITE)).toBe('owner');
    expect(await organizationRoleForSite(db, second, SITE)).toBeNull();
  });

  it('the alias that is the site member keeps its org role even if an older alias is an org admin', async () => {
    const older = await addUser('carol+old', new Date('2026-01-01T00:00:00Z'));
    const member = await addUser('carol', new Date('2026-01-02T00:00:00Z'));
    await makeOrgAdmin(older);
    await makeOrgAdmin(member);
    await db.insert(userSites).values({ userId: member, siteId: SITE });
    expect(await organizationRoleForSite(db, member, SITE)).toBe('admin');
    expect(await organizationRoleForSite(db, older, SITE)).toBeNull();
  });

  it('distinct mailboxes are unaffected', async () => {
    const a = await addUser('dave', new Date('2026-01-01T00:00:00Z'));
    const b = await addUser('erin', new Date('2026-01-02T00:00:00Z'));
    await db.insert(userSites).values({ userId: a, siteId: SITE });
    await makeOrgAdmin(b);
    expect(await organizationRoleForSite(db, b, SITE)).toBe('admin');
  });

  it('a non-strict site keeps the pre-#861 behaviour', async () => {
    await db.update(sites).set({ emailIdentityStrict: false }).where(inArray(sites.id, [SITE]));
    const member = await addUser('frank', new Date('2026-01-02T00:00:00Z'));
    const admin = await addUser('frank+org', new Date('2026-01-01T00:00:00Z'));
    await db.insert(userSites).values({ userId: member, siteId: SITE });
    await makeOrgAdmin(admin);
    expect(await organizationRoleForSite(db, admin, SITE)).toBe('admin');
  });
});
