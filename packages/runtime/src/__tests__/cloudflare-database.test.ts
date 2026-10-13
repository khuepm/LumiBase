import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareDatabaseProvider } from '../adapters/cloudflare/database';

const connect = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('postgres', () => ({ default: connect }));

describe('Cloudflare database initialization', () => {
  beforeEach(() => connect.mockClear());

  it('allows runtime construction without Hyperdrive but refuses database access', async () => {
    const provider = new CloudflareDatabaseProvider(undefined);
    expect(connect).not.toHaveBeenCalled();
    expect(() => provider.getConnection()).toThrow('HYPERDRIVE binding is not configured');
    await expect(provider.close()).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });

  it('creates one client on first access and keeps clients isolated between requests', () => {
    const binding = { connectionString: 'postgresql://localhost/test' };
    const first = new CloudflareDatabaseProvider(binding);
    const second = new CloudflareDatabaseProvider(binding);
    expect(connect).not.toHaveBeenCalled();
    expect(first.getConnection()).toBe(first.getConnection());
    expect(connect).toHaveBeenCalledTimes(1);
    expect(second.getConnection()).not.toBe(first.getConnection());
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledWith(binding.connectionString, { max: 5, prepare: false });
  });
});
