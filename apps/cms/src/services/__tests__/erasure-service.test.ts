import { describe, it, expect } from 'vitest';
import { ErasureService, ErasureError } from '../erasure-service';
import { erasureRequests, settings } from '@lumibase/database';
import type { Database } from '@lumibase/database';

/** Minimal table-keyed mock; tracks update sets, returns canned select rows. */
function makeDb(rowsByTable: Map<unknown, Record<string, unknown>[]>) {
  const updates: { table: unknown; set: Record<string, unknown> }[] = [];
  const db = {
    select() {
      let table: unknown;
      const b: Record<string, unknown> = {
        from(t: unknown) { table = t; return b; },
        where() { return b; },
        limit() { return Promise.resolve(rowsByTable.get(table) ?? []); },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          return Promise.resolve(rowsByTable.get(table) ?? []).then(res, rej);
        },
      };
      return b;
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          return { returning: () => Promise.resolve([{ id: 'er-1', ...values }]) };
        },
        _t: table,
      };
    },
    update(table: unknown) {
      return {
        set(set: Record<string, unknown>) {
          updates.push({ table, set });
          return {
            where: () => ({ returning: () => Promise.resolve([{ id: 'er-1', ...set }]), then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r) }),
          };
        },
      };
    },
  };
  return { db: db as unknown as Database, updates };
}

describe('ErasureService', () => {
  it('rejects an empty scope filter', async () => {
    const { db } = makeDb(new Map());
    const svc = new ErasureService({ db, siteId: 's1', userId: 'a1' });
    await expect(svc.create({ collection: 'patients', filter: {} })).rejects.toMatchObject({
      code: 'INVALID_SCOPE',
      status: 422,
    });
  });

  it('creates a pending request with a subject hash (no plaintext)', async () => {
    const { db } = makeDb(new Map());
    const svc = new ErasureService({ db, siteId: 's1', userId: 'a1' });
    const row = (await svc.create({ collection: 'patients', filter: { patientId: 'p-123' } }, 'gdpr')) as Record<string, unknown>;
    expect(row.status).toBe('pending');
    // subjectHash is a sha256 hex digest, never the raw identifier.
    expect(typeof row.subjectHash).toBe('string');
    expect((row.subjectHash as string)).toMatch(/^[0-9a-f]{64}$/);
    expect(row.subjectHash).not.toContain('p-123');
  });

  it('blocks self-confirm under dual control (Req 11.4)', async () => {
    const { db } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [erasureRequests, [{ id: 'er-1', siteId: 's1', status: 'pending', requestedBy: 'a1' }]],
        [settings, [{ key: 'erasureDualControl', value: true }]],
      ]),
    );
    const svc = new ErasureService({ db, siteId: 's1', userId: 'a1' });
    await expect(svc.confirm('er-1')).rejects.toMatchObject({
      code: 'DUAL_CONTROL_REQUIRED',
      status: 409,
    });
  });

  it('allows confirm by a second admin under dual control', async () => {
    const { db, updates } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [erasureRequests, [{ id: 'er-1', siteId: 's1', status: 'pending', requestedBy: 'a1' }]],
        [settings, [{ key: 'erasureDualControl', value: true }]],
      ]),
    );
    const svc = new ErasureService({ db, siteId: 's1', userId: 'a2' });
    await svc.confirm('er-1');
    expect(updates.some((u) => u.set.status === 'confirmed' && u.set.confirmedBy === 'a2')).toBe(true);
  });

  it('refuses to execute a request that is not confirmed', async () => {
    const { db } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [erasureRequests, [{ id: 'er-1', siteId: 's1', status: 'pending', scope: { collection: 'x', filter: {} } }]],
      ]),
    );
    const svc = new ErasureService({ db, siteId: 's1', userId: 'a1' });
    await expect(svc.execute('er-1')).rejects.toBeInstanceOf(ErasureError);
  });
});
