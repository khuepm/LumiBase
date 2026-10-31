import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@lumibase/database';
import { createCloudflareSystemDb, resolveCloudflareSystemConnectionString } from '../cloudflare-system-db';

vi.mock('@lumibase/database', () => ({ createDb: vi.fn((cs: string) => ({ cs })) }));

const hd = (connectionString: string) => ({ connectionString }) as Hyperdrive;
const APP = hd('postgres://app@hd/db');
const SYS = hd('postgres://sys@hd/db');

describe('createCloudflareSystemDb (B130)', () => {
  beforeEach(() => vi.mocked(createDb).mockClear());

  it('prefers HYPERDRIVE_SYSTEM', () => {
    const r = createCloudflareSystemDb({ LUMIBASE_ENV: 'production', HYPERDRIVE: APP, HYPERDRIVE_SYSTEM: SYS });
    expect(r.error).toBeUndefined();
    expect(createDb).toHaveBeenCalledWith(SYS.connectionString);
  });

  it('flag off without HYPERDRIVE_SYSTEM: falls back to HYPERDRIVE (unchanged behaviour)', () => {
    expect(resolveCloudflareSystemConnectionString({ LUMIBASE_ENV: 'production', HYPERDRIVE: APP })).toEqual({
      connectionString: APP.connectionString,
    });
  });

  it('enforce without HYPERDRIVE_SYSTEM: error, no client built', () => {
    const r = createCloudflareSystemDb({ LUMIBASE_ENV: 'production', LUMIBASE_DB_RLS: 'enforce', HYPERDRIVE: APP });
    expect(r.error).toMatch(/HYPERDRIVE_SYSTEM/);
    expect(createDb).not.toHaveBeenCalled();
  });

  it('enforce with HYPERDRIVE_SYSTEM: uses it', () => {
    expect(
      resolveCloudflareSystemConnectionString({
        LUMIBASE_ENV: 'production',
        LUMIBASE_DB_RLS: 'enforce',
        HYPERDRIVE: APP,
        HYPERDRIVE_SYSTEM: SYS,
      }),
    ).toEqual({ connectionString: SYS.connectionString });
  });

  it('invalid flag: error', () => {
    expect(
      resolveCloudflareSystemConnectionString({ LUMIBASE_ENV: 'production', LUMIBASE_DB_RLS: 'yes', HYPERDRIVE: APP }).error,
    ).toMatch(/LUMIBASE_DB_RLS/);
  });

  it('development: DATABASE_SYSTEM_URL, then DATABASE_URL', () => {
    expect(
      resolveCloudflareSystemConnectionString({
        LUMIBASE_ENV: 'development',
        LUMIBASE_DB_RLS: 'enforce',
        DATABASE_SYSTEM_URL: 'postgres://sys@local/db',
        DATABASE_URL: 'postgres://app@local/db',
      }),
    ).toEqual({ connectionString: 'postgres://sys@local/db' });
    expect(
      resolveCloudflareSystemConnectionString({ LUMIBASE_ENV: 'development', DATABASE_URL: 'postgres://app@local/db' }),
    ).toEqual({ connectionString: 'postgres://app@local/db' });
  });

  it('production ignores DATABASE_URL', () => {
    expect(
      resolveCloudflareSystemConnectionString({ LUMIBASE_ENV: 'production', DATABASE_URL: 'postgres://app@local/db' }).error,
    ).toMatch(/HYPERDRIVE/);
  });
});
