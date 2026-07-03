import type { Database } from '@lumibase/database';
import type { PanelQuery } from '@lumibase/shared';
import { describe, expect, it } from 'vitest';
import { InsightsService, InsightsServiceError } from '../insights-service';
import type { SchemaService } from '../schema-service';

/** Build a fake DB whose item SELECT resolves to the given JSONB data rows. */
function fakeDb(dataRows: Record<string, unknown>[]): Database {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(dataRows.map((data) => ({ data }))),
  };
  return { select: () => chain } as unknown as Database;
}

/** Fake SchemaService exposing a collection + a fixed field whitelist. */
function fakeSchema(opts: { collection?: { id: string } | null; fields?: string[] }): SchemaService {
  return {
    getCollection: async () => opts.collection === undefined ? { id: 'coll_1' } : opts.collection,
    listFields: async () => (opts.fields ?? ['amount', 'category']).map((name) => ({ name })),
  } as unknown as SchemaService;
}

function svc(dataRows: Record<string, unknown>[], schemaOpts: Parameters<typeof fakeSchema>[0] = {}) {
  return new InsightsService({ db: fakeDb(dataRows), siteId: 'site_1', schema: fakeSchema(schemaOpts) });
}

describe('InsightsService.runPanel — aggregates', () => {
  it('count returns the row count', async () => {
    const res = await svc([{ amount: 1 }, { amount: 2 }, { amount: 3 }]).runPanel({
      collection: 'orders',
      aggregate: 'count',
    } as PanelQuery);
    expect(res.data.value).toBe(3);
    expect(res.meta.rowCount).toBe(3);
  });

  it('sum adds a numeric field', async () => {
    const res = await svc([{ amount: 10 }, { amount: 5 }, { amount: 'x' }]).runPanel({
      collection: 'orders',
      aggregate: 'sum',
      field: 'amount',
    } as PanelQuery);
    expect(res.data.value).toBe(15); // non-numeric ignored
  });

  it('groupBy returns a sorted series', async () => {
    const res = await svc([
      { amount: 10, category: 'a' },
      { amount: 5, category: 'b' },
      { amount: 20, category: 'a' },
    ]).runPanel({ collection: 'orders', aggregate: 'sum', field: 'amount', groupBy: 'category' } as PanelQuery);
    expect(res.data.series).toEqual([
      { label: 'a', value: 30 },
      { label: 'b', value: 5 },
    ]);
  });

  it('applies a condition-rule filter via evaluateRule', async () => {
    const res = await svc([
      { amount: 10, category: 'a' },
      { amount: 5, category: 'b' },
    ]).runPanel({
      collection: 'orders',
      aggregate: 'count',
      filter: { category: { _eq: 'a' } },
    } as PanelQuery);
    expect(res.data.value).toBe(1);
  });
});

describe('InsightsService.runPanel — security', () => {
  it('rejects a field outside the whitelist (injection attempt)', async () => {
    await expect(
      svc([{ amount: 1 }], { fields: ['amount'] }).runPanel({
        collection: 'orders',
        aggregate: 'sum',
        field: 'id); DROP TABLE items;--',
      } as PanelQuery),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD' });
  });

  it('rejects a groupBy outside the whitelist', async () => {
    await expect(
      svc([{ amount: 1 }], { fields: ['amount'] }).runPanel({
        collection: 'orders',
        aggregate: 'count',
        groupBy: 'secret_column',
      } as PanelQuery),
    ).rejects.toBeInstanceOf(InsightsServiceError);
  });

  it('rejects a filter key outside the whitelist', async () => {
    await expect(
      svc([{ amount: 1 }], { fields: ['amount'] }).runPanel({
        collection: 'orders',
        aggregate: 'count',
        filter: { _and: [{ injected_field: { _eq: 1 } }] },
      } as PanelQuery),
    ).rejects.toMatchObject({ code: 'INVALID_FIELD' });
  });

  it('404s when the collection does not exist in this site', async () => {
    await expect(
      svc([], { collection: null }).runPanel({ collection: 'ghost', aggregate: 'count' } as PanelQuery),
    ).rejects.toMatchObject({ code: 'INVALID_COLLECTION', status: 404 });
  });

  it('allows system fields (status) in filters', async () => {
    const res = await svc([
      { amount: 1, status: 'published' },
      { amount: 1, status: 'draft' },
    ]).runPanel({
      collection: 'orders',
      aggregate: 'count',
      filter: { status: { _eq: 'published' } },
    } as PanelQuery);
    expect(res.data.value).toBe(1);
  });
});
