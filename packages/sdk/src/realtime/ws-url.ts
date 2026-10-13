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
  const trimmed = trimTrailingSlashes(baseUrl);
  let absolute = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
    if (origin && origin !== 'null') {
      absolute = trimTrailingSlashes(new URL(trimmed || '/', origin).toString());
    }
  }
  return absolute.replace(/^http/i, 'ws');
}

/**
 * Drop trailing `/` characters in linear time.
 *
 * `s.replace(/\/+$/, '')` looks equivalent but is quadratic: the engine retries
 * the `\/+` run from every slash, so a long run of slashes followed by any
 * other character backtracks O(n²) (CodeQL js/polynomial-redos). A base URL
 * is configuration rather than attacker input, but the scan is right that the
 * pattern is unsafe, and the loop costs nothing.
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}
