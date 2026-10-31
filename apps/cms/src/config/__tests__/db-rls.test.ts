import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbRlsConfigError, parseDbRlsMode, resolveDbRlsMode } from '../db-rls';

describe('parseDbRlsMode', () => {
  it('defaults to off', () => {
    expect(parseDbRlsMode(undefined)).toBe('off');
    expect(parseDbRlsMode(null)).toBe('off');
    expect(parseDbRlsMode('')).toBe('off');
    expect(parseDbRlsMode('off')).toBe('off');
  });

  it('accepts enforce, case- and whitespace-insensitive', () => {
    expect(parseDbRlsMode('enforce')).toBe('enforce');
    expect(parseDbRlsMode(' ENFORCE ')).toBe('enforce');
    expect(parseDbRlsMode('Off')).toBe('off');
  });

  it('throws on anything else instead of meaning off', () => {
    for (const bad of ['on', 'true', 'enforced', '1', 'enable']) {
      expect(() => parseDbRlsMode(bad), bad).toThrow(DbRlsConfigError);
    }
  });
});

describe('resolveDbRlsMode', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('prefers the binding over process.env', () => {
    vi.stubEnv('LUMIBASE_DB_RLS', 'off');
    expect(resolveDbRlsMode({ LUMIBASE_DB_RLS: 'enforce' })).toBe('enforce');
  });

  it('falls back to process.env', () => {
    vi.stubEnv('LUMIBASE_DB_RLS', 'enforce');
    expect(resolveDbRlsMode({})).toBe('enforce');
    expect(resolveDbRlsMode(undefined)).toBe('enforce');
  });

  it('is off when neither is set', () => {
    vi.stubEnv('LUMIBASE_DB_RLS', '');
    expect(resolveDbRlsMode({})).toBe('off');
  });
});
