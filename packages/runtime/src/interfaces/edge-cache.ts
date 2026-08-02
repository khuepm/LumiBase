/** Thin HTTP edge-cache abstraction (CF `caches.default`; Docker no-op). */
export interface EdgeCacheProvider {
  match(request: Request): Promise<Response | null>;
  put(request: Request, response: Response): Promise<void>;
}
