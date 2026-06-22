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

/**
 * Operational notification pushed by the CMS broadcaster (push-noti feature).
 * Delivered both over the realtime WebSocket (`{ type: 'notification' }` frame)
 * and as the Web Push payload — same shape on both transports for client dedupe.
 */
export interface AgentNotification {
  id: string;
  kind: 'approval' | 'veto' | 'incident' | 'goal' | 'run';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  deepLink?: string;
  entityId: string;
  ts: string;
}

export interface RealtimeNotificationFrame {
  type: 'notification';
  notification: AgentNotification;
}
