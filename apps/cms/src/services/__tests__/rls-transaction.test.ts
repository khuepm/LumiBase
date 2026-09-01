import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { runSiteTransaction } from '../rls-transaction';

/**
 * P16 / high-load §12: explicit transactions must set `app.site_id` inside the
 * same transaction — not rely on `withRls` middleware alone.
 */
describe('runSiteTransaction — RLS set_config ordering', () => {
  it('calls set_config before the callback on the same tx handle', async () => {
    const calls: string[] = [];
    const tx = {
      execute: vi.fn(async () => {
        calls.push('set_config');
      }),
      insert: vi.fn(),
    };
    const db = {
      transaction: vi.fn(async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as Database;

    const prev = process.env.LUMIBASE_ENV;
    process.env.LUMIBASE_ENV = 'production';
    try {
      await runSiteTransaction(db, 'site-a', async (inner) => {
        calls.push('callback');
        expect(inner).toBe(tx);
        return 'ok';
      });
    } finally {
      process.env.LUMIBASE_ENV = prev;
    }

    expect(calls).toEqual(['set_config', 'callback']);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('skips set_config in development', async () => {
    const tx = { execute: vi.fn() };
    const db = {
      transaction: vi.fn(async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as Database;

    const prev = process.env.LUMIBASE_ENV;
    process.env.LUMIBASE_ENV = 'development';
    try {
      await runSiteTransaction(db, 'site-a', async () => 'ok');
    } finally {
      process.env.LUMIBASE_ENV = prev;
    }
    expect(tx.execute).not.toHaveBeenCalled();
  });
});
