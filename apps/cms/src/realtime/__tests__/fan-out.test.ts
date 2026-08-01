import { describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@lumibase/contracts';
import { canSubscribe, projectPayload, shouldDeliver, toWireMessage, type FanoutSession } from '../fan-out';

function session(partial: Partial<FanoutSession>): FanoutSession {
  return {
    plane: 'studio',
    subscriptions: new Set(),
    channels: new Set(),
    ...partial,
  };
}

describe('shouldDeliver — plane isolation', () => {
  const studioEvent: RealtimeEvent = { type: 'event', plane: 'studio', collection: 'posts', payload: {} };
  const publicEvent: RealtimeEvent = { type: 'notification', plane: 'public', target: { subjectId: 's' }, payload: {} };

  it('never delivers a studio event to a public session', () => {
    expect(shouldDeliver(studioEvent, session({ plane: 'public', subjectId: 's' }))).toBe(false);
  });

  it('never delivers a public event to a studio session', () => {
    expect(shouldDeliver(publicEvent, session({ plane: 'studio', subscriptions: new Set(['posts']) }))).toBe(false);
  });
});

describe('shouldDeliver — subject targeting', () => {
  const ev: RealtimeEvent = { type: 'notification', plane: 'public', target: { subjectId: 'citizen-42' }, payload: {} };

  it('delivers only to the matching subject', () => {
    expect(shouldDeliver(ev, session({ plane: 'public', subjectId: 'citizen-42' }))).toBe(true);
    expect(shouldDeliver(ev, session({ plane: 'public', subjectId: 'citizen-99' }))).toBe(false);
  });

  it('delivers to every session of the same subject (multi-device)', () => {
    const a = session({ plane: 'public', subjectId: 'citizen-42' });
    const b = session({ plane: 'public', subjectId: 'citizen-42' });
    expect(shouldDeliver(ev, a)).toBe(true);
    expect(shouldDeliver(ev, b)).toBe(true);
  });

  it('does not match a session that never presented a subject', () => {
    expect(shouldDeliver(ev, session({ plane: 'public' }))).toBe(false);
  });
});

describe('shouldDeliver — channel targeting', () => {
  const ev: RealtimeEvent = { type: 'event', plane: 'public', target: { channel: 'order:123' }, payload: {} };

  it('delivers only to sessions that joined the channel', () => {
    expect(shouldDeliver(ev, session({ plane: 'public', channels: new Set(['order:123']) }))).toBe(true);
    expect(shouldDeliver(ev, session({ plane: 'public', channels: new Set(['order:999']) }))).toBe(false);
    expect(shouldDeliver(ev, session({ plane: 'public' }))).toBe(false);
  });
});

describe('shouldDeliver — collection broadcast (legacy studio)', () => {
  const ev: RealtimeEvent = { type: 'event', plane: 'studio', collection: 'posts', action: 'update', itemId: '1', payload: {} };

  it('delivers to sessions subscribed to the collection', () => {
    expect(shouldDeliver(ev, session({ subscriptions: new Set(['posts']) }))).toBe(true);
    expect(shouldDeliver(ev, session({ subscriptions: new Set(['pages']) }))).toBe(false);
  });

  it('skip-echo: does not deliver back to the acting user', () => {
    const withActor: RealtimeEvent = { ...ev, actorUserId: 'u1' };
    expect(shouldDeliver(withActor, session({ userId: 'u1', subscriptions: new Set(['posts']) }))).toBe(false);
    expect(shouldDeliver(withActor, session({ userId: 'u2', subscriptions: new Set(['posts']) }))).toBe(true);
  });
});

describe('shouldDeliver — skip-echo is studio-only', () => {
  it('public sessions receive events they triggered', () => {
    const ev: RealtimeEvent = {
      type: 'event',
      plane: 'public',
      target: { channel: 'order:1' },
      actorUserId: 'u1',
      payload: {},
    };
    expect(shouldDeliver(ev, session({ plane: 'public', userId: 'u1', channels: new Set(['order:1']) }))).toBe(true);
  });
});

describe('shouldDeliver — per-subscription filter (Req 2.3, 3.2)', () => {
  const ev: RealtimeEvent = { type: 'event', plane: 'studio', collection: 'posts', action: 'update', itemId: 'item-7', payload: null };

  it('delivers when the filter matches the event envelope', () => {
    const s = session({
      subscriptions: new Set(['posts']),
      filters: new Map([['posts', { action: { _eq: 'update' } }]]),
    });
    expect(shouldDeliver(ev, s)).toBe(true);
  });

  it('blocks when the filter does not match', () => {
    const s = session({
      subscriptions: new Set(['posts']),
      filters: new Map([['posts', { action: { _eq: 'delete' } }]]),
    });
    expect(shouldDeliver(ev, s)).toBe(false);
  });

  it('supports itemId filters (watch a single item)', () => {
    const only7 = session({
      subscriptions: new Set(['posts']),
      filters: new Map([['posts', { itemId: { _eq: 'item-7' } }]]),
    });
    const only9 = session({
      subscriptions: new Set(['posts']),
      filters: new Map([['posts', { itemId: { _eq: 'item-9' } }]]),
    });
    expect(shouldDeliver(ev, only7)).toBe(true);
    expect(shouldDeliver(ev, only9)).toBe(false);
  });

  it('a filter on another collection does not affect this one', () => {
    const s = session({
      subscriptions: new Set(['posts']),
      filters: new Map([['pages', { action: { _eq: 'delete' } }]]),
    });
    expect(shouldDeliver(ev, s)).toBe(true);
  });
});

describe('canSubscribe — ticket read-gate', () => {
  it('allows only allowlisted collections and denies on an empty allowlist (fail-closed)', () => {
    expect(canSubscribe(new Set(['posts']), 'posts')).toBe(true);
    expect(canSubscribe(new Set(['posts']), 'salaries')).toBe(false);
    expect(canSubscribe(new Set(), 'posts')).toBe(false);
  });

  it('the * wildcard (admin bypass) allows everything', () => {
    expect(canSubscribe(new Set(['*']), 'anything')).toBe(true);
  });
});

describe('toWireMessage', () => {
  it('frames a notification without leaking envelope fields', () => {
    const ev: RealtimeEvent = { type: 'notification', plane: 'public', target: { subjectId: 's' }, payload: { subject: 'hi' } };
    expect(toWireMessage(ev)).toEqual({ type: 'notification', payload: { subject: 'hi' } });
  });

  it('frames an event with channel from the target', () => {
    const ev: RealtimeEvent = { type: 'event', plane: 'public', target: { channel: 'order:1' }, action: 'update', itemId: '9', payload: { x: 1 } };
    expect(toWireMessage(ev)).toEqual({
      type: 'event',
      collection: undefined,
      action: 'update',
      itemId: '9',
      channel: 'order:1',
      payload: { x: 1 },
    });
  });

  it('projects the payload to the field allowlist (Req 3.5)', () => {
    const ev: RealtimeEvent = {
      type: 'event',
      plane: 'public',
      target: { channel: 'order:1' },
      action: 'update',
      itemId: '9',
      payload: { public: 'ok', secret: 'nope' },
      fields: ['public'],
    };
    expect((toWireMessage(ev) as { payload: unknown }).payload).toEqual({ public: 'ok' });
  });
});

describe('projectPayload', () => {
  it('passes through when no fields set', () => {
    expect(projectPayload({ type: 'event', plane: 'studio', payload: { a: 1 } } as RealtimeEvent)).toEqual({ a: 1 });
  });
  it('keeps only allowlisted keys', () => {
    const ev = { type: 'event', plane: 'studio', payload: { a: 1, b: 2 }, fields: ['a'] } as RealtimeEvent;
    expect(projectPayload(ev)).toEqual({ a: 1 });
  });
  it('leaves non-object payloads unchanged', () => {
    const ev = { type: 'event', plane: 'studio', payload: 'scalar', fields: ['a'] } as RealtimeEvent;
    expect(projectPayload(ev)).toBe('scalar');
  });
});
