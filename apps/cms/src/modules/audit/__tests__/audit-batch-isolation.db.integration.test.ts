import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, sites, type Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { AuditLogBatcher } from '../worker';

/**
 * #469, remaining half — one poisoned row must not erase everyone else's audit
 * trail.
 *
 * ## What was already fixed, and what was not
 *
 * The crash is gone: `fe2f3c75` made the fire-and-forget flush swallow its
 * rejection, and `85ed2925` stopped the cross-tenant key denial from writing
 * audit under an attacker-supplied site id. A forged `X-Lumi-Site` no longer
 * takes the process down.
 *
 * What survived is quieter and, for a security log, worse. `withTenant` still
 * only shape-checks the header, so a well-formed id for a site that does not
 * exist still becomes `c.get('siteId')`, and two audit paths still write under
 * it (`external_auth_denied` in `middleware/auth.ts`, and the security-guard
 * denials in `middleware/security-audit.ts`). `audit_log.site_id` has an FK to
 * `sites.id`, so that row is rejected — and because the batcher flushes the
 * whole buffer in ONE multi-row INSERT, the rejection takes every other row in
 * that batch with it. Those rows belong to real tenants and are exactly the
 * events worth keeping: denied control-plane access, rejected uploads, failed
 * auth.
 *
 * So an unauthenticated request can still delete up to 99 other tenants' audit
 * records per batch, just by naming a site that does not exist. It fails
 * silently, because the flush logs and moves on.
 *
 * **Validates: #469 — a forged site id must not crash the process (already
 * true) and must not destroy other tenants' audit rows (this suite)**
 */

const REAL_SITE = 'site_audit_iso_real';
const OTHER_SITE = 'site_audit_iso_other';
/** Well-formed (passes `isValidSiteId`) but absent from `sites`. */
const FORGED_SITE = 'site_audit_iso_forged';

describe.skipIf(!hasDbIntegrationUrl)('#469 audit batch isolation — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('audit-batch-isolation');
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .delete(sites)
      .where(sql`${sites.id} IN (${REAL_SITE}, ${OTHER_SITE})`)
      .catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${REAL_SITE}, ${OTHER_SITE})`);
    await db.insert(sites).values([
      { id: REAL_SITE, name: 'Audit isolation real' },
      { id: OTHER_SITE, name: 'Audit isolation other' },
    ]);
  });

  function auditJob(siteId: string, event: string) {
    return {
      kind: 'audit' as const,
      siteId,
      entry: {
        event,
        actorEmail: null,
        ip: '203.0.113.9',
        userAgent: 'vitest',
        requestId: `req_${event}`,
        metadata: {},
      },
    };
  }

  /**
   * The Postgres error code behind a rejected flush.
   *
   * Drizzle wraps driver errors in `DrizzleQueryError`, so the SQLSTATE lives on
   * `cause`. Asserting the code rather than the message keeps the test tied to
   * "this was a foreign-key violation" instead of to a SQL string.
   */
  async function fkCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err, 'flush() should reject so an awaiting caller can observe it').toBeDefined();
    const direct = (err as { code?: unknown }).code;
    if (typeof direct === 'string') return direct;
    const cause = (err as { cause?: { code?: unknown } }).cause;
    return typeof cause?.code === 'string' ? cause.code : undefined;
  }

  async function eventsFor(siteId: string): Promise<string[]> {
    const rows = await db
      .select({ event: auditLog.event })
      .from(auditLog)
      .where(eq(auditLog.siteId, siteId));
    return rows.map((r) => r.event).sort();
  }

  it('keeps every real tenant row when one row names a site that does not exist', async () => {
    const batcher = new AuditLogBatcher(db);

    // Interleaved on purpose: the forged row sits between real ones, so a fix
    // that only salvages rows before the failure would still be caught.
    batcher.push(auditJob(REAL_SITE, 'control_plane_access_denied'));
    batcher.push(auditJob(FORGED_SITE, 'external_auth_denied'));
    batcher.push(auditJob(OTHER_SITE, 'file_upload_policy_denied'));
    batcher.push(auditJob(REAL_SITE, 'api_key_use_denied'));

    // The rejection is kept on purpose: a caller that awaits `flush()` asked to
    // know, and `worker-fk-crash.test.ts` pins that contract. What must change
    // is that the other tenants' rows survive it.
    expect(await fkCodeOf(batcher.flush())).toBe('23503');

    expect(await eventsFor(REAL_SITE)).toEqual([
      'api_key_use_denied',
      'control_plane_access_denied',
    ]);
    expect(await eventsFor(OTHER_SITE)).toEqual(['file_upload_policy_denied']);

    // The forged row is dropped, not smuggled in under some other site.
    const forged = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.siteId, FORGED_SITE));
    expect(forged).toHaveLength(0);
  });

  it('a batch of only forged rows writes nothing and surfaces the error', async () => {
    const batcher = new AuditLogBatcher(db);
    batcher.push(auditJob(FORGED_SITE, 'external_auth_denied'));
    batcher.push(auditJob(FORGED_SITE, 'control_plane_access_denied'));

    expect(await fkCodeOf(batcher.flush())).toBe('23503');

    const forged = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.siteId, FORGED_SITE));
    expect(forged).toHaveLength(0);
  });

  it('a clean batch still uses one multi-row insert path and writes everything', async () => {
    // Guards the fix from becoming "always insert row by row", which would turn
    // the batching this worker exists for into 100 round trips.
    const batcher = new AuditLogBatcher(db);
    for (let i = 0; i < 5; i++) {
      batcher.push(auditJob(REAL_SITE, `clean_event_${i}`));
    }
    await batcher.flush();

    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.siteId, REAL_SITE)));
    expect(rows).toHaveLength(5);
  });
});
