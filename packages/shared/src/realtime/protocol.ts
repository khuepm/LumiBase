/**
 * Realtime protocol — shared contract between the realtime hub (SiteRoom DO on
 * Cloudflare, in-process hub on Docker) and every client (Studio, SDK, FE apps).
 *
 * Two planes share the same wire protocol but are strictly isolated at fan-out:
 *   - `studio`  — admin users (rows in the `users` table). Subscribe by collection.
 *   - `public`  — end-user / audience (app-owned table, keyed by e.g. citizenID,
 *                 mapped to a `subjectId`). Addressed by subject or channel.
 *
 * Backward compatibility: the `studio` messages (`subscribe`/`unsubscribe`/
 * `presence`/`pong`) match the original `lumibase-sync-v1` protocol byte-for-byte,
 * so existing Studio clients keep working. Audience messages (`join`/`leave`) and
 * the `plane` field on `welcome` are additive.
 */

import { z } from 'zod';

export const PROTOCOL = 'lumibase-sync-v1';

/** Realtime plane — see module docs. */
export const planeSchema = z.enum(['studio', 'public']);
export type Plane = z.infer<typeof planeSchema>;

/** Item mutation action. */
export const realtimeActionSchema = z.enum(['create', 'update', 'delete']);
export type RealtimeAction = z.infer<typeof realtimeActionSchema>;

// ─── Client → Server ────────────────────────────────────────────────────────

export const clientMessageSchema = z.discriminatedUnion('type', [
  // studio plane (unchanged)
  z.object({ type: z.literal('subscribe'), collection: z.string().min(1) }),
  z.object({ type: z.literal('unsubscribe'), collection: z.string().min(1) }),
  z.object({
    type: z.literal('presence'),
    collection: z.string().optional(),
    itemId: z.string().optional(),
    meta: z.record(z.unknown()).optional(),
  }),
  // audience plane (new)
  z.object({ type: z.literal('join'), channel: z.string().min(1) }),
  z.object({ type: z.literal('leave'), channel: z.string().min(1) }),
  // shared
  z.object({ type: z.literal('pong') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ─── Server → Client ──────────────────────────────────────────────────────────

export const presenceEntrySchema = z.object({
  sessionId: z.string(),
  userId: z.string().optional(),
  subjectId: z.string().optional(),
  collection: z.string().optional(),
  itemId: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
  lastSeen: z.string(),
});
export type PresenceEntry = z.infer<typeof presenceEntrySchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), sessionId: z.string(), plane: planeSchema }),
  z.object({ type: z.literal('joined'), channel: z.string() }),
  z.object({ type: z.literal('left'), channel: z.string() }),
  z.object({
    type: z.literal('event'),
    collection: z.string().optional(),
    action: realtimeActionSchema.optional(),
    itemId: z.string().optional(),
    channel: z.string().optional(),
    payload: z.unknown(),
  }),
  z.object({ type: z.literal('notification'), payload: z.record(z.unknown()) }),
  z.object({ type: z.literal('presence'), users: z.array(presenceEntrySchema) }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('pong') }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ─── Publish envelope (server-internal: worker/service → hub) ───────────────────

/**
 * Recipient selector for a published event.
 *
 * - `userId`    — a specific admin (studio plane).
 * - `subjectId` — a specific end-user (public plane); app maps citizenID→subjectId.
 * - `channel`   — every session in the plane that has joined this channel.
 *
 * An empty target means "broadcast by collection subscription" (legacy studio
 * behaviour). Fields are OR-combined: a session matches if ANY set field matches.
 */
export const realtimeTargetSchema = z.object({
  userId: z.string().optional(),
  subjectId: z.string().optional(),
  channel: z.string().optional(),
});
export type RealtimeTarget = z.infer<typeof realtimeTargetSchema>;

export const realtimeEventSchema = z.object({
  type: z.enum(['event', 'notification']),
  /** Plane isolation — an event is only ever delivered to sessions on this plane. */
  plane: planeSchema.default('studio'),
  /** Recipient selector. Omit for a collection broadcast (studio). */
  target: realtimeTargetSchema.optional(),
  collection: z.string().optional(),
  action: realtimeActionSchema.optional(),
  itemId: z.string().optional(),
  payload: z.unknown(),
  /** Actor that triggered the mutation. Skip-echo applies to studio only. */
  actorUserId: z.string().optional(),
});
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parse an inbound client frame; returns null on malformed/unknown shape. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  const result = clientMessageSchema.safeParse(raw);
  return result.success ? result.data : null;
}
