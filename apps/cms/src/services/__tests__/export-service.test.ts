import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  EXPORT_PAGE_SIZE,
  ExportError,
  csvHeader,
  decodeCell,
  encodeCell,
  iterateExport,
  parseCsv,
  parseExport,
  planExport,
  streamExport,
  toCsvRow,
  type ExportOptions,
  type ExportRecord,
} from '../export-service';
import type { ItemRow, ListItemsParams } from '../item-service';

/** Unit tests for collection export (#727). */

const FIELDS = [
  { name: 'title', type: 'json', interface: 'translatable-text', hidden: false },
  { name: 'price', type: 'decimal', interface: 'input', hidden: false },
  { name: 'in_stock', type: 'boolean', interface: 'boolean', hidden: false },
  { name: 'meta', type: 'json', interface: 'input', hidden: false },
  { name: 'note', type: 'text', interface: 'textarea', hidden: false },
  { name: 'author_id', type: 'string', interface: 'select', hidden: false },
  { name: 'divider', type: 'alias', interface: 'presentation-divider', hidden: false },
];
const RELATIONS = [{ type: 'm2o' as const, field: 'author_id', alias: 'author', related: 'authors' }];

const plan = (options: Partial<ExportOptions> = {}) =>
  planExport({
    collection: 'products',
    schemaFields: FIELDS,
    relations: RELATIONS,
    siteLocales: ['en', 'vi'],
    options: { format: 'csv', ...options },
  });

const row = (id: string, data: Record<string, unknown>): ItemRow => ({
  id,
  siteId: 's',
  collectionId: 'c',
  status: 'published',
  data,
  sort: 0,
  userCreated: null,
  userUpdated: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  deletedAt: null,
});

describe('planExport', () => {
  it('skips alias fields and splits translatable fields into locale columns', () => {
    const p = plan();
    expect(p.fields).toEqual(['title', 'price', 'in_stock', 'meta', 'note', 'author_id']);
    expect(p.columns.map((c) => c.header)).toEqual([
      'title.en',
      'title.vi',
      'price',
      'in_stock',
      'meta',
      'note',
      'author_id',
    ]);
    expect(csvHeader(p)).toBe('id,status,sort,created_at,updated_at,title.en,title.vi,price,in_stock,meta,note,author_id\r\n');
  });

  it('honours field selection and explicit locales', () => {
    const p = plan({ fields: ['price', 'title', 'id'], locales: ['vi'] });
    expect(p.fields).toEqual(['price', 'title']);
    expect(p.columns.map((c) => c.header)).toEqual(['price', 'title.vi']);
  });

  it('JSON keeps every locale unless locales are given', () => {
    expect(plan({ format: 'json' }).locales).toBeNull();
    expect(plan({ format: 'json', locales: ['vi'] }).locales).toEqual(['vi']);
  });

  it('rejects unknown fields and malformed locales', () => {
    expect(() => plan({ fields: ['nope'] })).toThrow(ExportError);
    expect(() => plan({ fields: ['divider'] })).toThrow(ExportError);
    expect(() => plan({ locales: ['vi;drop'] })).toThrow(ExportError);
  });

  it('plans relation expansion per mode', () => {
    expect(plan({ relations: 'id' }).deep).toBeUndefined();
    expect(plan({ relations: 'slug' }).deep).toEqual({ author: { fields: ['id', 'slug'] } });
    const embed = plan({ relations: 'embed' });
    expect(embed.deep).toEqual({ author: { fields: ['*'] } });
    expect(embed.columns.at(-1)?.header).toBe('author');
  });
});

describe('CSV encoding', () => {
  it('quotes per RFC 4180', () => {
    const p = plan({ fields: ['note'] });
    const rec: ExportRecord = { id: 'a', status: 'draft', sort: 1, created_at: null, updated_at: null, data: { note: 'a, "b"\nc' } };
    expect(toCsvRow(rec, p)).toBe('a,draft,1,,,"a, ""b""\nc"\r\n');
  });

  it('neutralises spreadsheet formulas reversibly (CSV injection)', () => {
    for (const s of ['=HYPERLINK("x")', '+1', '-2', '@SUM(A1)', "'quoted", '\tx']) {
      const cell = encodeCell(s);
      expect(cell.startsWith("'")).toBe(true);
      expect(decodeCell(cell, 'string')).toBe(s);
    }
    // Numbers are not strings: a negative price stays numeric.
    expect(encodeCell(-2)).toBe('-2');
  });

  it('keeps empty string distinct from null', () => {
    const p = plan({ fields: ['note'] });
    const base = { id: 'a', status: 'draft', sort: 0, created_at: null, updated_at: null };
    const csv = csvHeader(p) + toCsvRow({ ...base, data: { note: '' } }, p) + toCsvRow({ ...base, id: 'b', data: { note: null } }, p);
    const parsed = parseExport(csv, 'csv', FIELDS);
    expect(parsed[0]!.data.note).toBe('');
    expect(parsed[1]!.data.note).toBeNull();
  });

  it('parseCsv handles BOM, CRLF and embedded newlines', () => {
    expect(parseCsv('﻿a,b\r\n"x\r\ny",""\r\n')).toEqual([
      ['a', 'b'],
      ['x\r\ny', ''],
    ]);
    expect(() => parseCsv('"open')).toThrow(ExportError);
  });

  it('round-trips arbitrary strings through encode → quote → parse → decode', () => {
    const p = plan({ fields: ['note'] });
    fc.assert(
      fc.property(fc.string(), (note) => {
        const rec: ExportRecord = { id: 'a', status: 'draft', sort: 0, created_at: null, updated_at: null, data: { note } };
        const [back] = parseExport(csvHeader(p) + toCsvRow(rec, p), 'csv', FIELDS);
        return back!.data.note === note;
      }),
    );
  });
});

describe('parseExport', () => {
  const p = plan();
  const record: ExportRecord = {
    id: 'i1',
    status: 'published',
    sort: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    data: {
      title: { en: 'Coffee', vi: 'Cà phê' },
      price: 10.5,
      in_stock: false,
      meta: { tags: ['a'], dims: { w: 1 } },
      note: '=1+1',
      author_id: 'au1',
    },
  };

  it('restores typed values and locale maps from CSV', () => {
    const [back] = parseExport(csvHeader(p) + toCsvRow(record, p), 'csv', FIELDS);
    expect(back).toEqual({ id: 'i1', status: 'published', sort: 3, data: record.data });
  });

  it('a translatable field with no values comes back as null, not {}', () => {
    const [back] = parseExport(csvHeader(p) + toCsvRow({ ...record, data: { ...record.data, title: null } }, p), 'csv', FIELDS);
    expect(back!.data.title).toBeNull();
  });

  it('reads the JSON envelope or a bare array', () => {
    const env = JSON.stringify({ collection: 'products', items: [record] });
    expect(parseExport(env, 'json', FIELDS)[0]!.data).toEqual(record.data);
    expect(parseExport(JSON.stringify([record]), 'json', FIELDS)).toHaveLength(1);
    expect(() => parseExport('{"items":[{"id":"x"}]}', 'json', FIELDS)).toThrow(ExportError);
  });

  it('rejects CSV columns that are not fields of the collection', () => {
    expect(() => parseExport('id,secret\r\na,b\r\n', 'csv', FIELDS)).toThrow(/secret/);
  });
});

describe('iterateExport / streamExport', () => {
  function source(total: number) {
    const all = Array.from({ length: total }, (_, i) => row(`id${String(i).padStart(5, '0')}`, { price: i }));
    const calls: ListItemsParams[] = [];
    return {
      calls,
      list: async (params: ListItemsParams) => {
        calls.push(params);
        const gt = ((params.filter as { _and?: Array<{ id?: { _gt?: string } }> })?._and ?? [])
          .map((f) => f.id?._gt)
          .find(Boolean);
        return all.filter((r) => !gt || r.id > gt).slice(0, params.limit);
      },
    };
  }

  it('pages by keyset on id until a short page', async () => {
    const src = source(EXPORT_PAGE_SIZE * 2 + 5);
    const out: string[] = [];
    for await (const r of iterateExport(plan({ fields: ['price'] }), { format: 'csv' }, src)) out.push(r.id);
    expect(out).toHaveLength(EXPORT_PAGE_SIZE * 2 + 5);
    expect(new Set(out).size).toBe(out.length);
    expect(src.calls).toHaveLength(3);
    expect(src.calls[0]!.sort).toEqual(['id']);
    expect(src.calls[0]!.withTotal).toBe(false);
  });

  it('keeps the caller filter when paging', async () => {
    const src = source(EXPORT_PAGE_SIZE + 1);
    const filter = { price: { _gte: 0 } };
    for await (const _ of iterateExport(plan({ fields: ['price'] }), { format: 'csv', filter }, src)) void _;
    expect(src.calls[1]!.filter).toEqual({ _and: [filter, { id: { _gt: `id${String(EXPORT_PAGE_SIZE - 1).padStart(5, '0')}` } }] });
  });

  it('applies the per-row transform', async () => {
    const src = { ...source(2), transform: async (r: ExportRecord) => ({ ...r, data: { ...r.data, price: 99 } }) };
    const prices: unknown[] = [];
    for await (const r of iterateExport(plan({ fields: ['price'] }), { format: 'csv' }, src)) prices.push(r.data.price);
    expect(prices).toEqual([99, 99]);
  });

  it('streams a valid JSON document', async () => {
    const p = plan({ format: 'json', fields: ['price'] });
    const text = await new Response(
      streamExport(p, { format: 'json' }, source(3), () => new Date('2026-11-12T00:00:00Z')),
    ).text();
    const doc = JSON.parse(text) as { collection: string; format: string; items: ExportRecord[] };
    expect(doc.collection).toBe('products');
    expect(doc.format).toBe('lumibase-export@1');
    expect(doc.items.map((i) => i.data.price)).toEqual([0, 1, 2]);
  });

  it('streams CSV with a BOM and one line per row', async () => {
    const bytes = new Uint8Array(await new Response(streamExport(plan({ fields: ['price'] }), { format: 'csv' }, source(2))).arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.trim().split('\r\n')).toHaveLength(3);
  });
});
