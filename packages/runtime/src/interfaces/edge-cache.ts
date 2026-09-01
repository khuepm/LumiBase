/** Thin HTTP edge-cache abstraction (CF `caches.default`; Docker no-op). */
export interface EdgeCacheProvider {
  match(request: Request): Promise<Response | null>;
  put(request: Request, response: Response): Promise<void>;
  /**
   * Drop cached copies from the edge (#392).
   *
   * Takes both addressing modes because they are not equally available and
   * not equally precise:
   *
   *  - `tags` is one call regardless of how many URLs are affected, and it
   *    reaches copies this process never recorded.
   *  - `urls` needs no tag support at the CDN, but only reaches what the
   *    caller's tag→URL index knows about.
   *
   * An implementation SHOULD try tags first and fall back to URLs when the
   * CDN rejects tag purge, so the caller does not have to know which
   * mechanism the account supports. Callers must supply both.
   *
   * Returns how many entries the provider believes it removed — an
   * observability signal only, never a correctness guarantee, because no edge
   * purge is synchronous in every PoP.
   *
   * Implementations MUST fail soft: a purge that cannot run returns 0 rather
   * than throwing, because the write path that triggered it must not fail.
   */
  purge(target: { urls: string[]; tags?: string[] }): Promise<number>;
}
