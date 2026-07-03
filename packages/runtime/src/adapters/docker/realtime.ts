import { EventEmitter } from 'node:events';
import type { RealtimeEventLike, RealtimeProvider } from '../../interfaces/realtime';

/**
 * In-process realtime hub for the Docker/Node runtime.
 *
 * Single-node: `publish()` emits into a per-site EventEmitter that the Node
 * WebSocket server (see `apps/cms/src/realtime/node-hub.ts`) subscribes to.
 *
 * Multi-node (future): back this emitter with Postgres `LISTEN/NOTIFY` or Redis
 * pub/sub so a `publish()` on one node reaches sessions held by another. The
 * `RealtimeProvider` surface stays identical — only the transport changes.
 */
export class InProcessRealtimeHub {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A busy site can have many WS sessions; lift the default 10-listener cap.
    this.emitter.setMaxListeners(0);
  }

  private channel(siteId: string): string {
    return `site:${siteId}`;
  }

  /** Emit an event to every subscriber of a site. */
  publish(siteId: string, event: RealtimeEventLike): void {
    this.emitter.emit(this.channel(siteId), event);
  }

  /** Subscribe a WS session to a site's events. Returns an unsubscribe fn. */
  subscribe(siteId: string, handler: (event: RealtimeEventLike) => void): () => void {
    const ch = this.channel(siteId);
    this.emitter.on(ch, handler);
    return () => this.emitter.off(ch, handler);
  }
}

/**
 * Docker realtime provider — publishes into a shared in-process hub. The hub
 * instance is shared with the Node WebSocket server so events reach live
 * sessions on the same process.
 */
export class DockerRealtimeProvider implements RealtimeProvider {
  constructor(private readonly hub: InProcessRealtimeHub) {}

  isAvailable(): boolean {
    return true;
  }

  async publish(siteId: string, event: RealtimeEventLike): Promise<void> {
    try {
      this.hub.publish(siteId, event);
    } catch (err) {
      console.error('[realtime/docker] publish failed', err);
    }
  }
}

/**
 * Process-wide singleton hub. The WS server and the runtime provider must share
 * one instance for in-process delivery to work.
 */
let sharedHub: InProcessRealtimeHub | undefined;
export function getSharedRealtimeHub(): InProcessRealtimeHub {
  if (!sharedHub) sharedHub = new InProcessRealtimeHub();
  return sharedHub;
}
