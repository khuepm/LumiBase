import type { UniqueCounterProvider } from '../../interfaces';
import type { DurableObjectNamespaceLike } from './realtime';

/**
 * Forwards atomic-counter operations to the per-site `PageviewCounter` Durable
 * Object (defined in `apps/cms/src/pageviews/counter-do.ts`). The DO is the only
 * Cloudflare primitive that can increment atomically; KV cannot.
 *
 * A DO instance is addressed per site via `idFromName(siteId)`, matching the
 * realtime provider. The `key` passed to increment/addUnique already carries the
 * siteId prefix (the pageview service builds `pv:{siteId}:...`), but the DO is
 * still keyed by siteId so each tenant's counters live in a separate, isolated
 * actor. Callers therefore pass the siteId explicitly via {@link forSite}.
 *
 * The structural `DurableObjectNamespaceLike` type (reused from realtime) keeps
 * `@cloudflare/workers-types` out of the runtime package.
 */
export class CloudflarePageviewCounter implements UniqueCounterProvider {
  constructor(
    private readonly namespace: DurableObjectNamespaceLike,
    private readonly siteId: string,
  ) {}

  private stub() {
    const id = this.namespace.idFromName(this.siteId);
    return this.namespace.get(id);
  }

  async increment(key: string, by = 1, _opts?: { ttl?: number }): Promise<number> {
    const res = await this.stub().fetch('https://internal/incr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, by }),
    });
    const { value } = (await res.json()) as { value: number };
    return value;
  }

  async addUnique(key: string, member: string, _opts?: { ttl?: number }): Promise<void> {
    await this.stub().fetch('https://internal/pfadd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, member }),
    });
  }

  async countUnique(key: string): Promise<number> {
    const res = await this.stub().fetch(
      `https://internal/count?key=${encodeURIComponent(key)}`,
    );
    const { value } = (await res.json()) as { value: number };
    return value;
  }

  /** Drain-and-reset all counters/uniques for this site (used by the flush job). */
  async drain(prefix = ''): Promise<{
    counters: Array<{ key: string; value: number }>;
    uniques: Array<{ key: string; value: number }>;
  }> {
    const res = await this.stub().fetch(
      `https://internal/drain?prefix=${encodeURIComponent(prefix)}`,
    );
    return (await res.json()) as {
      counters: Array<{ key: string; value: number }>;
      uniques: Array<{ key: string; value: number }>;
    };
  }
}
