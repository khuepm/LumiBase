import type { EdgeCacheProvider } from '../../interfaces/edge-cache';

/** Docker/Node has no HTTP edge cache — always miss, never store, nothing to purge. */
export class NoOpEdgeCacheProvider implements EdgeCacheProvider {
  async match(_request: Request): Promise<null> {
    return null;
  }

  async put(_request: Request, _response: Response): Promise<void> {
    // no-op
  }

  /**
   * Always 0 — there is no edge in front of a Docker deployment by default.
   * A self-hoster who puts Varnish or a CDN there implements this interface
   * instead of patching the call sites (`BAN` / that CDN's purge API).
   */
  async purge(_target: { urls: string[]; tags?: string[] }): Promise<number> {
    return 0;
  }
}
