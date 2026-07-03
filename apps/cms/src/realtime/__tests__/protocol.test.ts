import { describe, expect, it } from 'vitest';
import {
  PROTOCOL,
  clientMessageSchema,
  serverMessageSchema,
  realtimeEventSchema,
  parseClientMessage,
} from '@lumibase/shared';

describe('realtime protocol', () => {
  it('keeps the v1 protocol identifier', () => {
    expect(PROTOCOL).toBe('lumibase-sync-v1');
  });

  describe('client messages (backward compatible studio frames)', () => {
    it('accepts subscribe/unsubscribe/presence/pong', () => {
      expect(clientMessageSchema.safeParse({ type: 'subscribe', collection: 'posts' }).success).toBe(true);
      expect(clientMessageSchema.safeParse({ type: 'unsubscribe', collection: 'posts' }).success).toBe(true);
      expect(clientMessageSchema.safeParse({ type: 'presence', collection: 'posts', itemId: '1' }).success).toBe(true);
      expect(clientMessageSchema.safeParse({ type: 'pong' }).success).toBe(true);
    });

    it('rejects empty collection on subscribe', () => {
      expect(clientMessageSchema.safeParse({ type: 'subscribe', collection: '' }).success).toBe(false);
    });
  });

  describe('client messages (new audience frames)', () => {
    it('accepts join/leave with a channel', () => {
      expect(clientMessageSchema.safeParse({ type: 'join', channel: 'order:123' }).success).toBe(true);
      expect(clientMessageSchema.safeParse({ type: 'leave', channel: 'order:123' }).success).toBe(true);
    });

    it('rejects join without a channel', () => {
      expect(clientMessageSchema.safeParse({ type: 'join' }).success).toBe(false);
      expect(clientMessageSchema.safeParse({ type: 'join', channel: '' }).success).toBe(false);
    });
  });

  it('parseClientMessage returns null on unknown shape', () => {
    expect(parseClientMessage({ type: 'nope' })).toBeNull();
    expect(parseClientMessage('garbage')).toBeNull();
    expect(parseClientMessage({ type: 'join', channel: 'x' })).toEqual({ type: 'join', channel: 'x' });
  });

  describe('server messages', () => {
    it('welcome carries a plane', () => {
      expect(serverMessageSchema.safeParse({ type: 'welcome', sessionId: 's1', plane: 'public' }).success).toBe(true);
      expect(serverMessageSchema.safeParse({ type: 'welcome', sessionId: 's1', plane: 'bogus' }).success).toBe(false);
    });

    it('accepts joined/left/notification/event', () => {
      expect(serverMessageSchema.safeParse({ type: 'joined', channel: 'c' }).success).toBe(true);
      expect(serverMessageSchema.safeParse({ type: 'left', channel: 'c' }).success).toBe(true);
      expect(serverMessageSchema.safeParse({ type: 'notification', payload: { subject: 'hi' } }).success).toBe(true);
      expect(
        serverMessageSchema.safeParse({ type: 'event', collection: 'posts', action: 'update', itemId: '1', payload: {} }).success,
      ).toBe(true);
    });
  });

  describe('publish envelope', () => {
    it('defaults plane to studio and allows an empty (broadcast) target', () => {
      const parsed = realtimeEventSchema.parse({ type: 'event', collection: 'posts', payload: {} });
      expect(parsed.plane).toBe('studio');
      expect(parsed.target).toBeUndefined();
    });

    it('accepts subject/channel targets on the public plane', () => {
      expect(
        realtimeEventSchema.safeParse({
          type: 'notification',
          plane: 'public',
          target: { subjectId: 'citizen-42' },
          payload: {},
        }).success,
      ).toBe(true);
      expect(
        realtimeEventSchema.safeParse({
          type: 'event',
          plane: 'public',
          target: { channel: 'order:123' },
          payload: {},
        }).success,
      ).toBe(true);
    });
  });
});
