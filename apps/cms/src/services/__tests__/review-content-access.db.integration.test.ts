import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  apiKeyPolicies,
  apiKeys,
  collections,
  fields,
  items,
  permissions,
  policies,
  sites,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { EffectiveCapabilityService } from '../effective-capability-service';
import { reviewContentAccessForPrincipal } from '../review-content-access';

/**
 * `reviewContentAccessForPrincipal` decides which fields a Flows worker sends
 * to the decision provider (J10 `ai:decision`, J11 automation). It had no
 * behavioural test (J10 review follow-up). REAL Postgres and a REAL
 * ItemService/PermissionService, with principals re-resolved through
 * `EffectiveCapabilityService` exactly as the worker does:
 *
 * - a field mask is reported in `omittedFields` and never returned;
 * - a row rule that excludes the item reads as REVIEW_ITEM_NOT_FOUND;
 * - no read permission on the collection is FORBIDDEN;
 * - the site comes from the principal, so another site's item is not found.
 *
 * Skips when DATABASE_URL is unset/unreachable.
 */

const SITE = 'site_rca_it';
const OTHER = 'site_rca_it_other';
const MASKED_POLICY = 'pol_rca_masked';
const NONE_POLICY = 'pol_rca_none';
const MASKED_KEY = 'key_rca_masked';
const NONE_KEY = 'key_rca_none';

describe.skipIf(!hasDbIntegrationUrl)('review content access for a worker principal — DB integration', () => {
  let db: Database;
  let draftId: string;
  let publishedId: string;
  let otherSiteItemId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('review-content-access');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER})`).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER})`);
    await db.insert(sites).values([
      { id: SITE, name: 'RCA' },
      { id: OTHER, name: 'RCA other' },
    ]);
    await db.insert(policies).values([
      { id: MASKED_POLICY, siteId: SITE, name: 'masked reader', key: 'rca-masked', adminAccess: false, appAccess: true },
      { id: NONE_POLICY, siteId: SITE, name: 'pages only', key: 'rca-none', adminAccess: false, appAccess: true },
    ]);
    await db.insert(permissions).values([
      // Reads posts, but never `secret`, and only draft rows.
      {
        siteId: SITE,
        policyId: MASKED_POLICY,
        collection: 'posts',
        action: 'read',
        fields: ['title', 'body'],
        permissions: { status: { _eq: 'draft' } },
      },
      { siteId: SITE, policyId: NONE_POLICY, collection: 'pages', action: 'read', fields: ['*'] },
    ]);
    await db.insert(apiKeys).values([
      { id: MASKED_KEY, siteId: SITE, name: 'masked', prefix: 'lbk_rcam', tokenHash: 'fixture-not-a-credential-1' },
      { id: NONE_KEY, siteId: SITE, name: 'none', prefix: 'lbk_rcan', tokenHash: 'fixture-not-a-credential-2' },
    ]);
    await db.insert(apiKeyPolicies).values([
      { siteId: SITE, apiKeyId: MASKED_KEY, policyId: MASKED_POLICY, priority: 0 },
      { siteId: SITE, apiKeyId: NONE_KEY, policyId: NONE_POLICY, priority: 0 },
    ]);
    for (const siteId of [SITE, OTHER]) {
      const [collection] = await db.insert(collections).values({ siteId, name: 'posts', label: 'Posts' }).returning();
      await db.insert(fields).values(
        ['title', 'body', 'secret'].map((name) => ({ siteId, collectionId: collection!.id, name, type: 'string', interface: 'input' })),
      );
      const rows = await db
        .insert(items)
        .values([
          { siteId, collectionId: collection!.id, status: 'draft', data: { title: 'Draft', body: 'Body', secret: 'internal margin' } },
          { siteId, collectionId: collection!.id, status: 'published', data: { title: 'Live', body: 'Body', secret: 'x' } },
        ])
        .returning();
      if (siteId === SITE) {
        draftId = rows[0]!.id;
        publishedId = rows[1]!.id;
      } else {
        otherSiteItemId = rows[0]!.id;
      }
    }
  });

  async function accessFor(apiKeyId: string) {
    const grant = await new EffectiveCapabilityService({ db, siteId: SITE }).resolve({ type: 'api_key', siteId: SITE, apiKeyId });
    expect(grant.allowed, 'fixture principal must resolve').toBe(true);
    const allowed = grant as Extract<typeof grant, { allowed: true }>;
    return reviewContentAccessForPrincipal({ db, permissionContext: allowed.permissionContext! });
  }

  it('reports a masked field as omitted and never returns its value', async () => {
    const access = await accessFor(MASKED_KEY);
    const read = await access.readItem('posts', draftId, ['title', 'body', 'secret']);
    expect(read).toEqual({ values: { title: 'Draft', body: 'Body' }, omittedFields: ['secret'] });
    expect(JSON.stringify(read)).not.toContain('internal margin');
    // The snapshot path refuses the masked field for the same principal.
    expect(await access.deniedSnapshotFields('posts', ['title', 'secret'], 'update')).toEqual(['title', 'secret']);
  });

  it('a row rule that excludes the item reads as not found', async () => {
    const access = await accessFor(MASKED_KEY);
    await expect(access.readItem('posts', publishedId, ['title'])).rejects.toMatchObject({ code: 'REVIEW_ITEM_NOT_FOUND' });
  });

  it('without read permission on the collection the read is forbidden', async () => {
    const access = await accessFor(NONE_KEY);
    await expect(access.readItem('posts', draftId, ['title'])).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("the principal's site scopes the read: another site's item is not found", async () => {
    const access = await accessFor(MASKED_KEY);
    await expect(access.readItem('posts', otherSiteItemId, ['title'])).rejects.toMatchObject({ code: 'REVIEW_ITEM_NOT_FOUND' });
  });
});
