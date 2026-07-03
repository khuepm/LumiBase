import type { RealtimeEventLike, RealtimeProvider } from '../../interfaces/realtime';

/**
 * Minimal structural view of a Durable Object namespace — avoids importing
 * `@cloudflare/workers-types` into the runtime package.
 */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/**
 * Resolve the DO room name for an event's plane. MUST stay in sync with the
 * connect-path resolver in `apps/cms/src/realtime/shard-config.ts`
 * (`resolveRoomName`). v1 does not bucket the audience plane, so a single
 * `{siteId}:aud` room per site is used; multi-region studio sharding is applied
 * by the connect route, and publish targets the base site room name.
 */
function roomNameFor(siteId: string, event: RealtimeEventLike): string {
  return event.plane === 'public' ? `${siteId}:aud` : siteId;
}

/**
 * Cloudflare realtime provider — forwards published events to the SiteRoom
 * Durable Object's internal `/publish` endpoint.
 */
export class CloudflareRealtimeProvider implements RealtimeProvider {
  constructor(private readonly namespace: DurableObjectNamespaceLike | undefined) {}

  isAvailable(): boolean {
    return this.namespace !== undefined;
  }

  async publish(siteId: string, event: RealtimeEventLike): Promise<void> {
    if (!this.namespace) return;
    try {
      const id = this.namespace.idFromName(roomNameFor(siteId, event));
      const stub = this.namespace.get(id);
      await stub.fetch('https://internal/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
    } catch (err) {
      // Realtime fan-out is non-critical — never fail the caller's mutation.
      console.error('[realtime/cloudflare] publish failed', err);
    }
  }
}
