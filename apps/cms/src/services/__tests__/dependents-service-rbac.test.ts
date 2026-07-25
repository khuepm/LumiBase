import { describe, expect, it } from 'vitest';
import { collections, relations, type Database } from '@lumibase/database';
import { DependentsService } from '../dependents-service';
import type { PermissionService } from '../permission-service';

/**
 * Tripwire for the dependents-write RBAC bypass (P0, spec fk-dependent-records
 * Req 9).
 *
 * ## Background
 *
 * `DependentsService` mutates the *dependent* (many-side) collection via raw
 * batch SQL (`set_null` / `reassign`) and via delegated ItemService deletes.
 * Originally the resolve/preflight endpoints ran with no PermissionService and
 * built the delegated ItemService through `itemServiceForSystem` — so any
 * authenticated tenant member could clear, reassign, or delete records in a
 * collection they had no update/delete grant on. This is the same *class* as
 * the AI/MCP item-RBAC bypass: a request-path service that forgets to carry the
 * caller's permission context fails open.
 *
 * These tests lock the fix without a database: with a PermissionService that
 * denies, the gate must throw `FORBIDDEN` **before** any query or mutation runs
 * (proven by a db stub that throws if touched, so a thrown FORBIDDEN — not a
 * stub TypeError — is the only way the assertion passes).
 */

/** A db stub that fails loudly if any query is issued. */
const explodingDb = new Proxy(
  {},
  {
    get() {
      throw new Error('db must not be queried before the permission gate');
    },
  },
) as unknown as Database;

/** Minimal PermissionService double exposing only what DependentsService uses. */
function permissions(decision: 'deny' | 'allow'): PermissionService {
  return {
    canAccess: async () =>
      decision === 'allow'
        ? { collection: 'x', action: 'update', rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] }
        : null,
    whereFor: () => undefined,
  } as unknown as PermissionService;
}

/** db stub that returns one relation row (so applyResolution reaches the gate). */
function dbWithRelation(): Database {
  const rel = {
    id: 'rel-1',
    siteId: 'site-1',
    manyCollection: 'comments',
    manyField: 'article',
    oneCollection: 'articles',
    onDelete: 'restrict',
  };
  const builder = (rowsFor: (table: unknown) => unknown[]) => {
    let table: unknown;
    const b: Record<string, unknown> = {
      from(t: unknown) {
        table = t;
        return b;
      },
      where: () => b,
      limit: () => Promise.resolve(rowsFor(table)),
      then: (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(rowsFor(table)).then(res, rej),
    };
    return b;
  };
  return {
    select: () =>
      builder((table) =>
        table === relations ? [rel] : table === collections ? [{ id: 'coll-1' }] : [],
      ),
  } as unknown as Database;
}

describe('DependentsService RBAC gate', () => {
  it('report(requireTarget) throws FORBIDDEN before querying when denied', async () => {
    const svc = new DependentsService({ db: explodingDb, siteId: 'site-1', permissions: permissions('deny') });
    await expect(svc.report('articles', 'a1', { requireTarget: 'read' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(svc.report('articles', 'a1', { requireTarget: 'delete' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('applyResolution(set_null) throws FORBIDDEN without update grant — no mutation', async () => {
    const svc = new DependentsService({ db: dbWithRelation(), siteId: 'site-1', permissions: permissions('deny') });
    await expect(svc.applyResolution('articles', 'a1', 'set_null', 'rel-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('applyResolution(reassign) throws FORBIDDEN without update grant', async () => {
    const svc = new DependentsService({ db: dbWithRelation(), siteId: 'site-1', permissions: permissions('deny') });
    await expect(
      svc.applyResolution('articles', 'a1', 'reassign', 'rel-1', { newTargetId: 'b1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('applyResolution(delete) throws FORBIDDEN without delete grant', async () => {
    const svc = new DependentsService({ db: dbWithRelation(), siteId: 'site-1', permissions: permissions('deny') });
    await expect(svc.applyResolution('articles', 'a1', 'delete', 'rel-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('fails open only when no PermissionService is injected (system/background context)', async () => {
    // No `permissions` → report runs the query path (proven by hitting the db stub),
    // never a FORBIDDEN. This documents the single, explicit fail-open door.
    const svc = new DependentsService({ db: dbWithRelation(), siteId: 'site-1' });
    const report = await svc.report('articles', 'a1', { requireTarget: 'delete' });
    expect(report.dependents).toEqual([]);
  });
});
