/**
 * Realtime provider — runtime-agnostic fan-out for WebSocket events.
 *
 * ADR-002: business logic (ItemService, notification services) must publish
 * through this interface and never touch a `DurableObjectNamespace` directly.
 *
 * - Cloudflare adapter → forwards to the `SiteRoom` Durable Object stub.
 * - Docker adapter     → in-process pub/sub hub backing a Node WebSocket server
 *                        (single-node v1; multi-node via Postgres LISTEN/NOTIFY
 *                        or Redis pub/sub is future work).
 *
 * The event shape is kept structural here (`RealtimeEventLike`) so the runtime
 * package does not need to depend on `@lumibase/contracts`. The canonical schema
 * lives in `@lumibase/contracts` (`realtimeEventSchema`) and is structurally
 * compatible with this type.
 */

/** Which realtime plane an event belongs to (see @lumibase/contracts protocol). */
export type RealtimePlane = 'studio' | 'public';

/** Recipient selector — OR-combined; empty means broadcast-by-collection. */
export interface RealtimeTargetLike {
  userId?: string;
  subjectId?: string;
  channel?: string;
}

/** Structural mirror of `@lumibase/contracts` `RealtimeEvent`. */
export interface RealtimeEventLike {
  type: 'event' | 'notification';
  plane: RealtimePlane;
  target?: RealtimeTargetLike;
  collection?: string;
  action?: 'create' | 'update' | 'delete';
  itemId?: string;
  payload: unknown;
  actorUserId?: string;
}

export interface RealtimeProvider {
  /**
   * Fan-out an event to the realtime hub for a site. Non-critical: callers rely
   * on this never throwing into the mutation path — adapters log and swallow
   * transport errors.
   */
  publish(siteId: string, event: RealtimeEventLike): Promise<void>;

  /**
   * Whether realtime fan-out is actually wired for this runtime. `false` means
   * publish() is a no-op (e.g. Cloudflare without the SITE_ROOM binding).
   */
  isAvailable(): boolean;
}
