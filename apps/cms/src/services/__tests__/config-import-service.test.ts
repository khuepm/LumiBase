import { describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import { CONFIG_MANIFEST_VERSION, type ConfigManifest } from '@lumibase/contracts/schemas';
import { ConfigImportService } from '../config-import-service';

/**
 * Fast (DB-free) tests for ConfigImportService's pre-transaction orchestration:
 * Zod parse, version check, integrity validation, diff, and the destructive
 * guard — everything that runs before the apply transaction opens. Full apply
 * correctness is covered by the DB-integration test (skipped without
 * DATABASE_URL).
 *
 * The fake DB returns an empty current state for loadState() (5 sequential
 * reads → all empty), so the "current" manifest is empty and the diff reflects
 * pure creates.
 *
 * **Validates: Requirements 2.2, 2.3, 4.7, 6.1 (clean round-trip)**
 */

function emptyDb(): Database {
  const empty = {
    from: () => empty,
    where: () => empty,
    orderBy: () => Promise.resolve([]),
    then: (resolve: (v: unknown) => void, reject: (r?: unknown) => void) =>
      Promise.resolve([]).then(resolve, reject),
  };
  return { select: () => empty } as unknown as Database;
}

function svc(): ConfigImportService {
  return new ConfigImportService({ db: emptyDb(), siteId: 'site_1' });
}

function manifest(overrides: Partial<ConfigManifest> = {}): ConfigManifest {
  return {
    version: CONFIG_MANIFEST_VERSION,
    collections: [],
    fields: [],
    relations: [],
    webhooks: [],
    settings: [],
    ...overrides,
  };
}

describe('ConfigImportService.dryRun', () => {
  it('rejects a non-object body via Zod (Req 2.1)', async () => {
    const r = await svc().dryRun('not a manifest');
    expect(r.valid).toBe(false);
    expect(r.diff).toBeNull();
  });

  it('rejects an unsupported version (Req 2.2)', async () => {
    const r = await svc().dryRun({ ...manifest(), version: 'lumibase.config@v999' });
    expect(r.valid).toBe(false);
    // Zod's literal() rejects the wrong version before our explicit check.
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects a dangling field reference (Req 2.3)', async () => {
    const r = await svc().dryRun(
      manifest({ fields: [{ collection: 'ghost', field: 'x', type: 'string', interface: 'input' }] }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'DANGLING_REFERENCE')).toBe(true);
  });

  it('diffs a valid manifest against empty state as all-creates', async () => {
    const r = await svc().dryRun(manifest({ collections: [{ name: 'articles' }] }), 'merge');
    expect(r.valid).toBe(true);
    expect(r.diff?.collections.create).toBe(1);
    expect(r.diff?.clean).toBe(false);
  });
});

describe('ConfigImportService.apply', () => {
  it('is a no-op for an empty manifest against empty state (clean round-trip, Req 6.1)', async () => {
    const r = await svc().apply(manifest(), 'replace-all');
    expect(r.valid).toBe(true);
    expect(r.diff?.clean).toBe(true);
    expect(r.applied).toEqual({ created: 0, updated: 0, deleted: 0 });
  });

  // The destructive guard's risk classification (field type change → high,
  // widening onDelete → high) is unit-tested in config-diff.test.ts; the apply
  // wiring through to a transaction is covered by the DB-integration test
  // (config-import.db.integration.test.ts, skipped without DATABASE_URL).
});
