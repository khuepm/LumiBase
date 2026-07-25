import { describe, expect, it } from 'vitest';
import { detectHistoryMismatch, formatHistoryMismatchError } from '../migration-guard';

const LOCAL = [{ tag: '0000_lumibase_init', hash: 'hash_init' }];

describe('detectHistoryMismatch', () => {
  it('returns null for a fresh database (no applied migrations)', () => {
    expect(detectHistoryMismatch(LOCAL, [])).toBeNull();
  });

  it('returns null when every applied hash maps to a bundled migration', () => {
    expect(detectHistoryMismatch(LOCAL, [{ hash: 'hash_init' }])).toBeNull();
  });

  it('flags a database migrated with a history the checkout no longer bundles', () => {
    const applied = [{ hash: 'legacy_0000' }, { hash: 'legacy_0001' }, { hash: 'hash_init' }];
    const mismatch = detectHistoryMismatch(LOCAL, applied);
    expect(mismatch).toEqual({
      appliedCount: 3,
      unknownHashes: ['legacy_0000', 'legacy_0001'],
    });
  });

  it('flags a pre-squash database where nothing matches the local journal', () => {
    const applied = [{ hash: 'legacy_0000' }];
    expect(detectHistoryMismatch(LOCAL, applied)).toEqual({
      appliedCount: 1,
      unknownHashes: ['legacy_0000'],
    });
  });
});

describe('formatHistoryMismatchError', () => {
  it('names the counts, the reset commands, and the bypass', () => {
    const message = formatHistoryMismatchError({
      appliedCount: 39,
      unknownHashes: Array.from({ length: 39 }, (_, i) => `legacy_${i}`),
    });
    expect(message).toContain('39 of 39');
    expect(message).toContain('docker compose -f docker/docker-compose.yml down -v');
    expect(message).toContain('DROP DATABASE');
    expect(message).toContain('FORCE_MIGRATE=true');
    expect(message).toContain('ADR-010');
  });
});
