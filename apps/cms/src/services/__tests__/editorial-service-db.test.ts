import { describe, it, expect } from 'vitest';
import { EditorialService, EditorialError } from '../editorial-service';
import { collections, items, revisions, contentReviews } from '@lumibase/database';
import type { Database } from '@lumibase/database';

/**
 * Table-keyed mock of the minimal drizzle surface EditorialService uses. Select
 * chains resolve to canned rows by table; insert/update record calls. The
 * AuditLogger's own insert resolves harmlessly (it is never-throw).
 */
function makeDb(rowsByTable: Map<unknown, Record<string, unknown>[]>) {
  const updates: { table: unknown; set: Record<string, unknown> }[] = [];
  const inserts: { table: unknown; values: Record<string, unknown> }[] = [];

  const db = {
    select() {
      let table: unknown;
      const builder: Record<string, unknown> = {
        from(t: unknown) {
          table = t;
          return builder;
        },
        where() {
          return builder;
        },
        orderBy() {
          return builder;
        },
        limit() {
          return Promise.resolve(rowsByTable.get(table) ?? []);
        },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          return Promise.resolve(rowsByTable.get(table) ?? []).then(res, rej);
        },
      };
      return builder;
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          inserts.push({ table, values });
          return {
            returning: () => Promise.resolve([{ id: 'review-1', ...values }]),
            then: (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res),
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(set: Record<string, unknown>) {
          updates.push({ table, set });
          return { where: () => Promise.resolve(undefined) };
        },
      };
    },
  };
  return { db: db as unknown as Database, updates, inserts };
}

const coll = { id: 'coll-1', siteId: 'site1', name: 'patients', meta: {} as Record<string, unknown> };
const item = { id: 'item-1', siteId: 'site1', collectionId: 'coll-1', status: 'draft', editorialState: null };

describe('EditorialService (DB orchestration)', () => {
  it('submitReview transitions to in_review and creates a pending review', async () => {
    const { db, updates, inserts } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [collections, [coll]],
        [items, [item]],
        [revisions, [{ id: 'rev-9' }]],
      ]),
    );
    const svc = new EditorialService({ db, siteId: 'site1', userId: 'author-1' });
    const result = await svc.submitReview('patients', 'item-1', { assignedTo: 'reviewer-1' });

    expect(result.editorialState).toBe('in_review');
    // items.editorial_state persisted to in_review (status stays draft).
    const itemUpdate = updates.find((u) => u.table === items);
    expect(itemUpdate?.set).toMatchObject({ editorialState: 'in_review', status: 'draft' });
    const reviewInsert = inserts.find((i) => i.table === contentReviews);
    expect(reviewInsert?.values).toMatchObject({
      itemId: 'item-1',
      revisionId: 'rev-9',
      requestedBy: 'author-1',
      assignedTo: 'reviewer-1',
      status: 'pending',
    });
  });

  it('approve moves in_review -> approved and resolves the review', async () => {
    const reviewing = { ...item, editorialState: 'in_review' };
    const pending = { id: 'rev-pending', itemId: 'item-1', requestedBy: 'author-1', status: 'pending' };
    const { db, updates } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [collections, [coll]],
        [items, [reviewing]],
        [contentReviews, [pending]],
      ]),
    );
    const svc = new EditorialService({ db, siteId: 'site1', userId: 'reviewer-2' });
    const result = await svc.approve('patients', 'item-1', { reason: 'lgtm' });

    expect(result.editorialState).toBe('approved');
    const reviewUpdate = updates.find((u) => u.table === contentReviews);
    expect(reviewUpdate?.set).toMatchObject({ status: 'approved', decidedBy: 'reviewer-2' });
  });

  it('enforces requireSeparateReviewer (Req 9.3)', async () => {
    const reviewing = { ...item, editorialState: 'in_review' };
    const pending = { id: 'r1', itemId: 'item-1', requestedBy: 'author-1', status: 'pending' };
    const { db } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [collections, [{ ...coll, meta: { requireSeparateReviewer: true } }]],
        [items, [reviewing]],
        [contentReviews, [pending]],
      ]),
    );
    // Same user as author tries to approve.
    const svc = new EditorialService({ db, siteId: 'site1', userId: 'author-1' });
    await expect(svc.approve('patients', 'item-1')).rejects.toMatchObject({
      code: 'SEPARATE_REVIEWER_REQUIRED',
      status: 409,
    });
  });

  it('rejects when there is no pending review', async () => {
    const reviewing = { ...item, editorialState: 'in_review' };
    const { db } = makeDb(
      new Map<unknown, Record<string, unknown>[]>([
        [collections, [coll]],
        [items, [reviewing]],
        [contentReviews, []],
      ]),
    );
    const svc = new EditorialService({ db, siteId: 'site1', userId: 'reviewer-2' });
    await expect(svc.approve('patients', 'item-1')).rejects.toBeInstanceOf(EditorialError);
  });
});
