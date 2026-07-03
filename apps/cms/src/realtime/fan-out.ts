/**
 * Pure fan-out matching for the realtime hub.
 *
 * Extracted from `site-room.ts` so it can be unit-tested without importing
 * `cloudflare:workers` (which is unavailable under Node/vitest). `SiteRoom`
 * delegates its delivery decision to `shouldDeliver` and its wire framing to
 * `toWireMessage`.
 */

import type { RealtimeEvent } from '@lumibase/shared';

export interface FanoutSession {
  plane: 'studio' | 'public';
  userId?: string;
  subjectId?: string;
  /** Collections this session subscribed to (studio). */
  subscriptions: ReadonlySet<string>;
  /** Channels this session has joined (audience). */
  channels: ReadonlySet<string>;
}

/**
 * Decide whether an event should be delivered to a session. Matching order:
 *   1. plane must match (strict isolation between studio and public);
 *   2. targeted events match userId OR subjectId OR a joined channel;
 *   3. untargeted events match a collection subscription (legacy studio);
 *   4. studio skip-echo — an actor never receives its own mutation back.
 */
export function shouldDeliver(event: RealtimeEvent, session: FanoutSession): boolean {
  const plane = event.plane ?? 'studio';
  if (session.plane !== plane) return false;

  const target = event.target;
  if (target && (target.userId || target.subjectId || target.channel)) {
    const matchUser = !!target.userId && target.userId === session.userId;
    const matchSubject = !!target.subjectId && target.subjectId === session.subjectId;
    const matchChannel = !!target.channel && session.channels.has(target.channel);
    if (!matchUser && !matchSubject && !matchChannel) return false;
  } else if (event.collection) {
    if (!session.subscriptions.has(event.collection)) return false;
  } else {
    return false; // no target and no collection → nobody to deliver to
  }

  if (plane === 'studio' && event.actorUserId && session.userId === event.actorUserId) {
    return false;
  }

  return true;
}

/** Map an internal publish envelope to the client-facing wire message. */
export function toWireMessage(event: RealtimeEvent): Record<string, unknown> {
  if (event.type === 'notification') {
    return { type: 'notification', payload: event.payload };
  }
  return {
    type: 'event',
    collection: event.collection,
    action: event.action,
    itemId: event.itemId,
    channel: event.target?.channel,
    payload: event.payload,
  };
}
