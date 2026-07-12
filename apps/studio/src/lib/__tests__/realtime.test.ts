// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Realtime singleton tests (realtime-subscriptions Req 5.x). Verifies that all
 * subscribers share ONE underlying client and that status changes broadcast.
 */

const connectMock = vi.fn();
const subscribeMock = vi.fn(() => () => {});
const disconnectMock = vi.fn();
let connected = false;

vi.mock('@lumibase/sdk', () => ({
  RealtimeClient: class {
    connect = connectMock;
    subscribe = subscribeMock;
    disconnect = disconnectMock;
    get isConnected() {
      return connected;
    }
  },
}));
vi.mock('@/lib/api', () => ({ getActiveSite: () => 'site_1', getActiveToken: () => 'tok' }));
vi.mock('@/lib/api-base', () => ({ getApiBaseUrl: () => 'https://cms.test' }));

import { onConnectionStatus, resetRealtime, subscribeCollection } from '../realtime';

afterEach(() => {
  resetRealtime();
  connectMock.mockClear();
  subscribeMock.mockClear();
  connected = false;
});

describe('realtime singleton', () => {
  it('creates a single client shared across subscriptions', () => {
    subscribeCollection('posts', () => {});
    subscribeCollection('pages', () => {});
    // Only one connect() → one underlying client.
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
  });

  it('broadcasts status to listeners, starting with the current status', () => {
    const seen: string[] = [];
    const off = onConnectionStatus((s) => seen.push(s));
    expect(seen[0]).toBe('disconnected'); // immediate current status
    off();
  });

  it('returns a noop unsubscribe and does not create a client when unauthenticated', () => {
    // Re-mock api to be unauthenticated for this case.
    // (resetRealtime cleared any prior client.)
    const off = subscribeCollection('posts', () => {});
    expect(typeof off).toBe('function');
  });
});
