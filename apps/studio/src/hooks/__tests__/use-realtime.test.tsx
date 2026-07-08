// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { RealtimeEvent } from '@lumibase/sdk';

/**
 * Realtime hook tests (realtime-subscriptions task 5.3): useRealtimeItem fires
 * only for the open item's update/delete events; useConnectionStatus reflects
 * the singleton's status broadcast.
 */

let capturedCb: ((e: RealtimeEvent) => void) | null = null;
let statusCb: ((s: string) => void) | null = null;

vi.mock('@/lib/realtime', () => ({
  subscribeCollection: (_collection: string, cb: (e: RealtimeEvent) => void) => {
    capturedCb = cb;
    return () => {
      capturedCb = null;
    };
  },
  onConnectionStatus: (cb: (s: string) => void) => {
    statusCb = cb;
    cb('connecting');
    return () => {
      statusCb = null;
    };
  },
}));

import { useConnectionStatus, useRealtimeItem } from '../use-realtime';

afterEach(() => {
  cleanup();
  capturedCb = null;
  statusCb = null;
});

function ItemProbe({ id }: { id: string }) {
  const [hit, setHit] = useState(false);
  useRealtimeItem('posts', id, () => setHit(true));
  return <span>{hit ? 'updated' : 'idle'}</span>;
}

describe('useRealtimeItem', () => {
  it('fires only for the open item on update/delete, not create or other items', async () => {
    render(<ItemProbe id="item_1" />);
    expect(screen.getByText('idle')).toBeTruthy();

    // Event for a different item → ignored.
    capturedCb?.({ type: 'event', collection: 'posts', action: 'update', itemId: 'other', payload: {} });
    expect(screen.getByText('idle')).toBeTruthy();

    // create for the same item → ignored (banner is for edits made elsewhere).
    capturedCb?.({ type: 'event', collection: 'posts', action: 'create', itemId: 'item_1', payload: {} });
    expect(screen.getByText('idle')).toBeTruthy();

    // update for the open item → fires.
    capturedCb?.({ type: 'event', collection: 'posts', action: 'update', itemId: 'item_1', payload: {} });
    await waitFor(() => expect(screen.getByText('updated')).toBeTruthy());
  });
});

describe('useConnectionStatus', () => {
  it('reflects the current status and updates on broadcast', async () => {
    const { result } = renderHook(() => useConnectionStatus());
    await waitFor(() => expect(result.current).toBe('connecting'));
    statusCb?.('connected');
    await waitFor(() => expect(result.current).toBe('connected'));
  });
});
