import type { EdgeCacheProvider } from '../../interfaces/edge-cache';

/** Docker/Node has no HTTP edge cache — always miss, never store. */
export class NoOpEdgeCacheProvider implements EdgeCacheProvider {
  async match(_request: Request): Promise<null> {
    return null;
  }

  async put(_request: Request, _response: Response): Promise<void> {
    // no-op
  }
}
