import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORT_CONFIG, errorReportCsv, resolveImportConfig } from '../import-service';
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
