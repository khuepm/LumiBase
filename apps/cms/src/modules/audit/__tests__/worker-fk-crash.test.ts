import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogBatcher, AUDIT_BATCH_MAX, pushAuditJobForTest } from '../worker';

/** Captured at module load, before any `vi.useFakeTimers()` patches it. */
const realSetImmediate = globalThis.setImmediate;

/**
 * Regression: an audit write for a site id that does not exist must not be
 * able to kill the process.
 *
 * `withTenant` accepts any well-shaped `X-Lumi-Site` header without checking
 * that the site exists, so an unverified id could reach `audit_log.site_id`
 * and violate its FK to `sites.id`. The batcher flushed fire-and-forget
 * (`void this.scheduleFlush()`) and `runFlush` rethrew, so that FK error
 * became an unhandled rejection and took down the API — remotely triggerable
 * by any client with one bad header.
 */

/** The postgres error a bad `site_id` actually produces. */
function fkViolation(): Error {
  return Object.assign(new Error('insert or update on table "lumibase_audit_log" violates foreign key constraint'), {
    code: '23503',
    detail: 'Key (site_id)=(some-other-site) is not present in table "lumibase_sites".',
    table_name: 'lumibase_audit_log',
    constraint_name: 'lumibase_audit_log_site_id_lumibase_sites_id_fk',
  });
}

function makeFailingDb(err: () => Error) {
  return {
    insert() {
      return { values: () => Promise.reject(err()) };
    },
  } as never;
}

function auditJob(siteId: string) {
  return { kind: 'audit', siteId, entry: { event: 'api_key_use_denied' } } as const;
}

describe('AuditLogBatcher — a failing flush must never crash the process', () => {
  let unhandled: unknown[];
  let onUnhandled: (reason: unknown) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    unhandled = [];
    onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Drain the microtask queue so any unhandled rejection is reported.
   *
   * Node reports an unhandled rejection on the macrotask tick after the
   * microtask queue empties, so we need one real macrotask hop. Fake timers
   * are patching `setTimeout`/`setImmediate`, so we reach for the unpatched
   * originals captured before `vi.useFakeTimers()` ran.
   */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => realSetImmediate(r));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  it('does not emit an unhandled rejection when the timer flush hits an FK violation', async () => {
    const batcher = new AuditLogBatcher(makeFailingDb(fkViolation));

    pushAuditJobForTest(batcher, auditJob('some-other-site'));
    await vi.advanceTimersByTimeAsync(1500);
    await settle();

    expect(unhandled).toEqual([]);
  });

  it('does not emit an unhandled rejection when the size-triggered flush fails', async () => {
    const batcher = new AuditLogBatcher(makeFailingDb(fkViolation));

    for (let i = 0; i < AUDIT_BATCH_MAX; i++) {
      pushAuditJobForTest(batcher, auditJob('some-other-site'));
    }
    await settle();

    expect(unhandled).toEqual([]);
  });

  it('keeps accepting and flushing work after a failed flush', async () => {
    // The failure must not poison the internal `flushing` chain: a rejected
    // tail would make every subsequent flush reject too, permanently
    // disabling audit logging after one bad row.
    let fail = true;
    const inserted: Record<string, unknown>[][] = [];
    const db = {
      insert() {
        return {
          values: (rows: Record<string, unknown>[]) => {
            if (fail) return Promise.reject(fkViolation());
            inserted.push(rows);
            return Promise.resolve();
          },
        };
      },
    } as never;

    const batcher = new AuditLogBatcher(db);

    pushAuditJobForTest(batcher, auditJob('some-other-site'));
    await vi.advanceTimersByTimeAsync(1500);
    await settle();

    fail = false;
    pushAuditJobForTest(batcher, auditJob('real-site'));
    await vi.advanceTimersByTimeAsync(1500);
    await settle();

    expect(unhandled).toEqual([]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.[0]).toMatchObject({ siteId: 'real-site' });
  });

  it('still surfaces the error to a caller that awaits flush()', async () => {
    // Containing the rejection must not silently hide it from code that asked.
    const batcher = new AuditLogBatcher(makeFailingDb(fkViolation));
    pushAuditJobForTest(batcher, auditJob('some-other-site'));

    await expect(batcher.flush()).rejects.toMatchObject({ code: '23503' });
    await settle();
    expect(unhandled).toEqual([]);
  });
});
