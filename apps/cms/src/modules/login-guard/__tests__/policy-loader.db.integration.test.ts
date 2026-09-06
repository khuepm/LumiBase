import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { settings, sites, type Database } from '@lumibase/database';
import { loadLockoutPolicyFromSettings } from '../middleware';
import { STANDARD_LOCKOUT_POLICY } from '../../setup/policy-codec';
import { DEFAULT_SITE_ID } from '../../setup/site-constants';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';

/**
 * Which Lockout_Policy governs a login attempt (Req 6.6).
 *
 * The policy is instance-wide and lives under the `__default__` site
 * (`SetupService` §10). The loader used to fetch it with `LIMIT 1` and no
 * `ORDER BY`, so the moment a second `login_security_policy` row existed —
 * any per-site row an operator or a test wrote — the thresholds actually
 * enforced depended on Postgres's row order. These cases pin the ordering
 * so that cannot regress silently: a wrong answer here weakens IP blocking
 * and account lockout without failing anything else.
 *
 * Skips without DATABASE_URL, per the convention of the other
 * `.db.integration` suites.
 */

const OTHER_SITE = 'site_policy_loader_other';

describe.skipIf(!hasDbIntegrationUrl)('loadLockoutPolicyFromSettings — row selection', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('policy-loader');
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .execute(sql`TRUNCATE TABLE lumibase_settings, lumibase_sites RESTART IDENTITY CASCADE`)
      .catch(() => undefined);
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE lumibase_settings, lumibase_sites RESTART IDENTITY CASCADE`,
    );
  });

  /** Write a policy row for `siteId` whose only distinguishing mark is the IP threshold. */
  async function writePolicy(siteId: string, ipMaxFailedAttempts: number): Promise<void> {
    await db.insert(sites).values({ id: siteId, name: siteId }).onConflictDoNothing();
    await db.insert(settings).values({
      siteId,
      key: 'login_security_policy',
      value: { ...STANDARD_LOCKOUT_POLICY, ipMaxFailedAttempts },
    });
  }

  it('prefers the instance-wide __default__ row when several sites carry a policy', async () => {
    // Written non-default-first so a loader that simply takes the oldest
    // row — or whatever Postgres returns first — picks the wrong one.
    await writePolicy(OTHER_SITE, 3);
    await writePolicy(DEFAULT_SITE_ID, 11);

    const policy = await loadLockoutPolicyFromSettings(db);

    expect(policy.ipMaxFailedAttempts).toBe(11);
  });

  it('still finds a policy when the only row lives under another site', async () => {
    // Deployments that wrote the policy somewhere else before the
    // ordering existed keep working — the fallback is a stable
    // `site_id ASC`, not "no policy".
    await writePolicy(OTHER_SITE, 7);

    const policy = await loadLockoutPolicyFromSettings(db);

    expect(policy.ipMaxFailedAttempts).toBe(7);
  });

  it('is stable across repeated reads with several rows present', async () => {
    await writePolicy(OTHER_SITE, 3);
    await writePolicy(DEFAULT_SITE_ID, 11);
    await writePolicy('site_policy_loader_third', 19);

    const reads = await Promise.all([
      loadLockoutPolicyFromSettings(db),
      loadLockoutPolicyFromSettings(db),
      loadLockoutPolicyFromSettings(db),
    ]);

    expect(reads.map((p) => p.ipMaxFailedAttempts)).toEqual([11, 11, 11]);
  });

  it('falls back to the Standard preset when no policy row exists', async () => {

    const policy = await loadLockoutPolicyFromSettings(db);

    expect(policy.ipMaxFailedAttempts).toBe(STANDARD_LOCKOUT_POLICY.ipMaxFailedAttempts);
  });
});
