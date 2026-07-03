import { describe, it, expect, vi } from 'vitest';
import { CloudflareRealtimeProvider } from '../adapters/cloudflare/realtime';
import {
  DockerRealtimeProvider,
  InProcessRealtimeHub,
} from '../adapters/docker/realtime';
import type { RealtimeEventLike } from '../interfaces/realtime';

const studioEvent: RealtimeEventLike = {
  type: 'event',
  plane: 'studio',
  collection: 'posts',
  action: 'update',
  itemId: '1',
  payload: {},
};

const audienceEvent: RealtimeEventLike = {
  type: 'notification',
  plane: 'public',
  target: { subjectId: 'citizen-42' },
  payload: { subject: 'hi' },
};

describe('CloudflareRealtimeProvider', () => {
  function makeNamespace() {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn((name: string) => ({ name }));
    return { namespace: { idFromName, get }, fetch, get, idFromName };
  }

  it('reports unavailable without a namespace binding', () => {
    expect(new CloudflareRealtimeProvider(undefined).isAvailable()).toBe(false);
  });

  it('publishes studio events to the site room', async () => {
    const { namespace, fetch, idFromName } = makeNamespace();
    await new CloudflareRealtimeProvider(namespace).publish('site-1', studioEvent);
    expect(idFromName).toHaveBeenCalledWith('site-1');
    const call = fetch.mock.calls[0];
    expect(call).toBeDefined();
    const init = call![1];
    expect(JSON.parse(init.body)).toMatchObject({ plane: 'studio', collection: 'posts' });
  });

  it('routes public events to the audience room name', async () => {
    const { namespace, idFromName } = makeNamespace();
    await new CloudflareRealtimeProvider(namespace).publish('site-1', audienceEvent);
    expect(idFromName).toHaveBeenCalledWith('site-1:aud');
  });

  it('never throws when the DO fetch fails', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('boom'));
    const namespace = { idFromName: () => ({}), get: () => ({ fetch }) };
    await expect(
      new CloudflareRealtimeProvider(namespace).publish('site-1', studioEvent),
    ).resolves.toBeUndefined();
  });
});

describe('Docker in-process hub', () => {
  it('delivers published events to subscribers of the same site only', async () => {
    const hub = new InProcessRealtimeHub();
    const provider = new DockerRealtimeProvider(hub);
    const site1 = vi.fn();
    const site2 = vi.fn();
    hub.subscribe('site-1', site1);
    hub.subscribe('site-2', site2);

    await provider.publish('site-1', studioEvent);
    expect(site1).toHaveBeenCalledWith(studioEvent);
    expect(site2).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery', async () => {
    const hub = new InProcessRealtimeHub();
    const provider = new DockerRealtimeProvider(hub);
    const handler = vi.fn();
    const off = hub.subscribe('site-1', handler);
    off();
    await provider.publish('site-1', studioEvent);
    expect(handler).not.toHaveBeenCalled();
  });

  it('is always available', () => {
    expect(new DockerRealtimeProvider(new InProcessRealtimeHub()).isAvailable()).toBe(true);
  });
});
