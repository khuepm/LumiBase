/**
 * Turn the client's HTTP `baseUrl` into the WebSocket origin for
 * `/api/v1/realtime`.
 *
 * `baseUrl` may legitimately be `''` or a path such as `/cms`: a browser app
 * served from the same origin as the CMS (Studio inside the Docker image)
 * talks to the API with relative URLs. `new URL('/api/v1/realtime')` throws
 * for those, so relative bases are resolved against `location` when one
 * exists. Outside a browser there is nothing to resolve against, and the
 * original error surfaces to the caller.
 */
export function toWebSocketBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  let absolute = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
    if (origin && origin !== 'null') {
      absolute = new URL(trimmed || '/', origin).toString().replace(/\/+$/, '');
    }
  }
  return absolute.replace(/^http/i, 'ws');
}
