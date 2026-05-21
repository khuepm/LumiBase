/**
 * Shared realtime type definitions — shared between hooks and components.
 */

export interface PresenceEntry {
  sessionId: string;
  userId: string;
  collection?: string;
  itemId?: string;
  meta?: Record<string, unknown>;
  lastSeen: string;
}

export interface RealtimeEvent {
  type: 'event';
  collection: string;
  action: 'create' | 'update' | 'delete';
  itemId: string;
  payload: unknown;
}
