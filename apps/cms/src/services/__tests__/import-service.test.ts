import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORT_CONFIG, chunkRecords, errorReportCsv, importJobColumns, resolveImportConfig } from '../import-service';
import { parseCsv } from '../export-service';

/** Unit tests for the import helpers that need no database (#726). */

describe('resolveImportConfig', () => {
  it('uses defaults when nothing is set', () => {
    expect(resolveImportConfig({})).toEqual(DEFAULT_IMPORT_CONFIG);
  });

  it('reads IMPORT_TIMEOUT in seconds and the other knobs as integers', () => {
    const cfg = resolveImportConfig({
      IMPORT_TIMEOUT: '120',
      IMPORT_MAX_CONCURRENCY: '3',
      IMPORT_MAX_BYTES: '1048576',
      IMPORT_CHUNK_SIZE: '100',
    });
    expect(cfg).toMatchObject({ timeoutMs: 120_000, maxConcurrency: 3, maxBytes: 1_048_576, chunkSize: 100 });
  });

  it('ignores invalid values and clamps the chunk size', () => {
    const cfg = resolveImportConfig({ IMPORT_TIMEOUT: '-5', IMPORT_MAX_CONCURRENCY: 'many', IMPORT_CHUNK_SIZE: '999999' });
    expect(cfg.timeoutMs).toBe(DEFAULT_IMPORT_CONFIG.timeoutMs);
    expect(cfg.maxConcurrency).toBe(DEFAULT_IMPORT_CONFIG.maxConcurrency);
    expect(cfg.chunkSize).toBe(5000);
  });
});

describe('per-site pending limits (#859)', () => {
  it('reads IMPORT_MAX_PENDING_BYTES / IMPORT_MAX_PENDING_JOBS', () => {
    const cfg = resolveImportConfig({ IMPORT_MAX_PENDING_BYTES: '300000000', IMPORT_MAX_PENDING_JOBS: '5' });
    expect(cfg).toMatchObject({ maxPendingBytes: 300_000_000, maxPendingJobs: 5 });
  });

  it('never lets the pending byte budget fall below one upload', () => {
    const cfg = resolveImportConfig({ IMPORT_MAX_BYTES: '100000000', IMPORT_MAX_PENDING_BYTES: '1000' });
    expect(cfg.maxPendingBytes).toBe(100_000_000);
  });
});

describe('staging (#859)', () => {
  it('splits parsed rows into numbered chunks', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ data: { n: i } }));
    const chunks = chunkRecords(rows, 3);
    expect(chunks.map((c) => [c.startRow, c.records.length])).toEqual([
      [0, 3],
      [3, 3],
      [6, 1],
    ]);
    expect(chunks.flatMap((c) => c.records)).toEqual(rows);
    expect(chunkRecords(rows.slice(4), 2, 4).map((c) => c.startRow)).toEqual([4, 6]);
    expect(chunkRecords([], 3)).toEqual([]);
  });

  it('job reads never project the stored source', () => {
    expect(Object.keys(importJobColumns)).not.toContain('source');
    expect(Object.keys(importJobColumns)).toEqual(expect.arrayContaining(['id', 'siteId', 'cursor', 'totalRows', 'sourceBytes']));
  });
});

describe('errorReportCsv', () => {
  it('writes a parseable CSV with a BOM and a truncation note', () => {
    const text = errorReportCsv(
      [
        { row: 2, message: 'Field "price" is required.' },
        { row: 7, id: 'abc', message: 'bad, "quoted"\nvalue' },
      ],
      3,
    );
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(parseCsv(text)).toEqual([
      ['row', 'id', 'message'],
      ['2', null, 'Field "price" is required.'],
      ['7', 'abc', 'bad, "quoted"\nvalue'],
      [null, null, '3 more row errors were not kept.'],
    ]);
  });
});
