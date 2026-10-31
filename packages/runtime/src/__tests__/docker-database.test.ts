import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresDatabaseProvider } from '../adapters/docker/database';

const connect = vi.hoisted(() =>
  vi.fn((url: string) => ({ url, end: vi.fn(async () => undefined) })),
);
vi.mock('postgres', () => ({ default: connect }));

describe('PostgresDatabaseProvider system connection (B130)', () => {
  beforeEach(() => connect.mockClear());

  it('without DATABASE_SYSTEM_URL the system connection is the main pool', async () => {
    const provider = new PostgresDatabaseProvider('postgresql://app@h/db');
    expect(provider.hasSystemConnection()).toBe(false);
    expect(provider.getSystemConnection()).toBe(provider.getConnection());
    expect(connect).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  it('with DATABASE_SYSTEM_URL it builds a second, lazy pool and closes both', async () => {
    const provider = new PostgresDatabaseProvider('postgresql://app@h/db', 'postgresql://sys@h/db');
    expect(provider.hasSystemConnection()).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);

    const sys = provider.getSystemConnection() as unknown as { url: string; end: () => Promise<void> };
    expect(sys).toBe(provider.getSystemConnection());
    expect(sys).not.toBe(provider.getConnection());
    expect(sys.url).toBe('postgresql://sys@h/db');
    expect(connect).toHaveBeenCalledTimes(2);

    await provider.close();
    expect(sys.end).toHaveBeenCalledTimes(1);
    expect((provider.getConnection() as unknown as { end: () => void }).end).toHaveBeenCalledTimes(1);
  });
});
