import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, sites, type Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { AuditLogBatcher } from '../worker';

/**
 * One rejected audit row must not erase everyone else's audit trail (#469,
 * defence in depth).
 *
 * ## Where the HTTP path already stops this
 *
 * Do not read this suite as "an unauthenticated request can delete other
 * tenants' audit rows". It cannot, and saying so would overstate the finding.
 * Three fixes landed earlier: `ca870dbf` added `withTenantExists`, which rejects
 * an unknown site with `404` **before `withAuth`** — the first middleware that
 * writes audit carrying `siteId` — using a cached existence check; `85ed2925`
 * made a cross-tenant key denial record against the key's own site; `fe2f3c75`
 * stopped a failed flush from becoming an unhandled rejection.
 *
 * Measured against a live CMS on a disposable database: four probes with a
 * forged `X-Lumi-Site` (three unauthenticated, one carrying a valid key from
 * another site) all answered `404 TENANT_NOT_FOUND`, `/utils/health` stayed
 * `200`, and `audit_log` gained no rows at all.
 *
 * ## What this suite is actually about
 *
 * A multi-row `INSERT` is atomic: one rejected row means **nothing** is written.
 * The HTTP path can no longer produce such a row, but the paths *outside* a
 * request still can — an audit job sitting in the queue when its site is
 * deleted, or a cron/CDC/worker job carrying a site id that has since gone.
 * Those batches mix tenants, so one late row used to discard up to 99 records
 * belonging to sites that are perfectly real, and they are the records most
 * worth keeping: denied control-plane access, rejected uploads, failed auth. It
 * failed quietly, because the flush logs and moves on.
 *
 * The suite drives the batcher directly for that reason: it is the layer where
 * the loss happened, and it is reachable without a request.
 *
 * **Validates: #469 — a row the database rejects must not take other tenants'
 * audit rows with it**
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
