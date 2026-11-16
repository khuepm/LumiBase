import { describe, expect, it } from 'vitest';
import type { QueueProvider } from '@lumibase/runtime';
import { queueAccepts } from '../queue-routing';

const base = { enqueue: async () => 'id', process: () => {}, getStatus: async () => null } as QueueProvider;

describe('queueAccepts (B118)', () => {
  it('rejects a missing queue provider', () => {
    expect(queueAccepts(undefined, 'flow-runs')).toBe(false);
    expect(queueAccepts(null, 'flow-runs')).toBe(false);
  });

  it('accepts any name on providers that create queues on demand (Docker/BullMQ)', () => {
    expect(queueAccepts(base, 'flow-runs')).toBe(true);
  });

  it('follows supportsQueue on providers with provisioned queues (Workers)', () => {
    const provisioned = { ...base, supportsQueue: (name: string) => name === 'agent-runs' };
    expect(queueAccepts(provisioned, 'agent-runs')).toBe(true);
    expect(queueAccepts(provisioned, 'flow-runs')).toBe(false);
  });
});
